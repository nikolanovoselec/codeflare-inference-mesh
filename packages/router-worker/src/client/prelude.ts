/**
 * The IIFE opens here. Config, token storage, request plumbing, toasts and the hero.
 *
 * A fragment of the console script, not a standalone module: it is concatenated
 * verbatim into one IIFE by `../admin-ui-client`. Zero interpolation, by rule.
 */
export const CLIENT_PRELUDE = `\
(() => {
  'use strict';
  const config = JSON.parse(document.getElementById('admin-ui-config').textContent);
  const state = config.state || { view: 'setup', phase: 'unclaimed' };
  const onCustomDomain = Boolean(state.customDomain) && location.hostname === state.customDomain;
  let lastStatus;
  let nodeSort = { key: '', dir: 1 };
  let nodeFilter = 'all';
  let nodeSearch = '';
  let topologyMeshFilter = 'all';
  let pollTimer;
  // Confirm-arm state lives at this scope (not only inside the confirm closure) so the
  // status poll can see it and skip the re-render that would otherwise destroy an armed
  // button mid-confirm — the root of the earlier confirm flake.
  let armedButton;
  let disarmTimer;
  let toksSamples = [];
  const byId = (id) => document.getElementById(id);
  // The single stable public model id AI Gateway forwards (mirrors profiles.ts). A
  // model's own callable name is any public alias other than this shared one.
  const STABLE_PUBLIC_MODEL = 'codeflare-mesh';
  const chipEl = (tone, text) => { const c = document.createElement('span'); c.className = 'chip'; if (tone) c.setAttribute('data-tone', tone); c.textContent = text; return c; };
  // A model's own alias is the first entry that is not a mesh's stable route name
  // (codeflare-mesh or codeflare-mesh-<mesh>), mirroring the server's reserved-name rule.
  const callName = (profile) => { const aliases = (profile && profile.publicAliases) || []; return aliases.find((alias) => alias !== STABLE_PUBLIC_MODEL && alias.indexOf(STABLE_PUBLIC_MODEL + '-') !== 0) || aliases[0] || ''; };
  const tokenKey = 'codeflareInferenceMeshAdminToken';
  const savedToken = () => sessionStorage.getItem(tokenKey) || localStorage.getItem(tokenKey) || '';
  const storeToken = (value, remember) => {
    sessionStorage.removeItem(tokenKey); localStorage.removeItem(tokenKey);
    if (value) (remember ? localStorage : sessionStorage).setItem(tokenKey, value);
  };
  let liveToken = savedToken();
  // The setup token the operator minted this session; filled into every install command shown,
  // so one token backs each enrollment and viewing a command never mints its own.
  let mintedSetupToken;
  const headers = (json) => {
    const base = liveToken ? { authorization: 'Bearer ' + liveToken } : {};
    if (json) base['content-type'] = 'application/json';
    return base;
  };
  async function request(path, options) {
    const response = await fetch(path, options || {});
    const contentType = response.headers.get('content-type') || '';
    const body = contentType.includes('application/json') ? await response.json() : await response.text();
    if (!response.ok) throw Object.assign(new Error(typeof body === 'string' ? body : body.error || 'request failed'), { body, status: response.status });
    return body;
  }
  const friendlyError = (action, error) => {
    const requestId = error && error.body && error.body.requestId ? ' (request ' + error.body.requestId + ')' : '';
    if (action === 'first-run-setup' && error.status === config.setupLockedFeedback.status) return 'Setup is already complete for this router. Sign in with the existing admin token instead.';
    if (error.status === 401) return 'Admin token missing or invalid. Sign in again, then retry this action.' + requestId;
    if (error.status >= 500) return 'The router hit a temporary error. Give it a moment and try again.' + requestId;
    return ((error.body && error.body.error) || error.message || 'Request failed') + requestId;
  };
  let toastTimer;
  const toast = (message, isError) => {
    const el = byId('toast');
    if (!el) return;
    if (toastTimer) clearTimeout(toastTimer);
    el.textContent = '';
    el.classList.remove('show', 'is-error');
    if (isError) el.classList.add('is-error');
    const text = document.createElement('span');
    text.textContent = message;
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'btn btn-ghost';
    dismiss.textContent = 'Dismiss';
    dismiss.setAttribute('data-toast-dismiss', 'true');
    dismiss.addEventListener('click', () => { if (toastTimer) clearTimeout(toastTimer); toastTimer = undefined; el.classList.remove('show'); });
    el.append(text, dismiss);
    el.classList.add('show');
    toastTimer = setTimeout(() => { el.classList.remove('show'); toastTimer = undefined; }, isError ? 8000 : 3600);
  };
  const setOutput = (id, value, isError) => {
    const el = byId(id);
    if (!el) return;
    el.classList.remove('is-error');
    if (isError) el.classList.add('is-error');
    el.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  };
  const readInput = (id) => { const el = byId(id); return el && el.value ? el.value.trim() : ''; };
  // The in-flight playground stream's abort controller, so the Stop button can end a
  // runaway generation. Null when no stream is running.
  let playgroundController = null;
  const playgroundSessionKey = 'codeflareInferenceMeshPlaygroundSession';
  const playgroundSessionUser = () => {
    let value = localStorage.getItem(playgroundSessionKey);
    if (!value) {
      value = (globalThis.crypto && globalThis.crypto.randomUUID ? globalThis.crypto.randomUUID() : String(Date.now()) + '-' + Math.random().toString(16).slice(2));
      localStorage.setItem(playgroundSessionKey, value);
    }
    return 'user:admin-playground|session:' + value;
  };
  const setHealth = (state, label) => { const pill = byId('health-pill'); if (!pill) return; pill.dataset.health = state; pill.textContent = label; };
  // Map a failed playground status to an actionable next step. The raw status alone
  // ('failed (401)') tells an operator nothing about what to fix.
  const playgroundHint = (status) => {
    if (status === 400) return ' The Gateway rejected the request. Re-sync the Gateway so its route matches the current model alias.';
    if (status === 401 || status === 403) return ' Paste the router provider token into the AI Gateway custom provider key.';
    if (status === 404) return ' No serving profile for this model yet. Add and activate a model.';
    if (status === 409) return ' Connect an AI Gateway in Routing first.';
    if (status === 502) return ' The selected node was unreachable over the mesh. Confirm the node is connected on WARP.';
    if (status === 503) return ' No ready node, or the upstream/Gateway token is not configured. Enroll and activate a node, or re-sync the Gateway.';
    return '';
  };

  // --- hero progressive enhancement ----------------------------------------
  const scrambleChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*<>{}[]|/\\\\~';
  const scrambleTickMs = 50;
  function randomScrambleChar() { return scrambleChars[Math.floor(Math.random() * scrambleChars.length)] || 'A'; }
  function reduceMotion() {
    try { return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_error) { return false; }
  }
  function scheduleFrame(fn) {
    const targetWindow = typeof window === 'object' ? window : globalThis;
    if (targetWindow && typeof targetWindow.requestAnimationFrame === 'function') targetWindow.requestAnimationFrame(fn);
    else fn();
  }
  function animateScrambleWord(span, target) {
    const chars = target.split('');
    let phase = 'hold';
    let frame = -Math.floor(Math.random() * 50);
    let current = chars.slice();
    setInterval(() => {
      frame += 1;
      if (phase === 'hold') {
        if (frame > 60) { phase = 'scramble'; frame = 0; }
        return;
      }
      if (phase === 'scramble') {
        current = chars.map((char) => (Math.random() < 0.4 ? randomScrambleChar() : char));
        if (frame > 26) { phase = 'decrypt'; frame = 0; }
      } else if (phase === 'decrypt') {
        current = chars.map((char) => (Math.random() < frame / 22 ? char : randomScrambleChar()));
        if (frame > 22) { phase = 'swap'; frame = 0; current = chars.slice(); }
      } else if (phase === 'swap') {
        const a = Math.floor(Math.random() * current.length);
        const b = Math.floor(Math.random() * current.length);
        const next = current[a];
        current[a] = current[b];
        current[b] = next;
        if (frame > 12) { phase = 'hold'; frame = 0; current = chars.slice(); }
      }
      span.textContent = current.join('');
    }, scrambleTickMs);
  }
  function initScramble() {
    if (reduceMotion()) return;
    const targetWindow = typeof window === 'object' ? window : globalThis;
    Array.prototype.slice.call(document.querySelectorAll('[data-scramble]')).forEach((target) => {
      const source = target.textContent || '';
      if (!source.trim()) return;
      target.textContent = '';
      const words = [];
      source.split(/(\\s+)/).forEach((part) => {
        if (part === '') return;
        if (/^\\s+$/.test(part)) {
          target.appendChild(document.createTextNode(part));
          return;
        }
        const span = document.createElement('span');
        span.className = 'scramble-word';
        span.textContent = part;
        target.appendChild(span);
        words.push({ span: span, text: part });
      });
      const lockWidths = () => {
        words.forEach((word) => { if (word.span.style) word.span.style.width = ''; word.span.textContent = word.text; });
        words.forEach((word) => {
          if (word.span.style && typeof word.span.getBoundingClientRect === 'function') {
            const finalWidth = word.span.getBoundingClientRect().width;
            const probe = document.createElement('span');
            probe.className = 'scramble-word';
            probe.textContent = 'W'.repeat(word.text.length);
            probe.setAttribute('aria-hidden', 'true');
            if (probe.style) {
              probe.style.position = 'absolute';
              probe.style.visibility = 'hidden';
              probe.style.pointerEvents = 'none';
            }
            target.appendChild(probe);
            const wideWidth = typeof probe.getBoundingClientRect === 'function' ? probe.getBoundingClientRect().width : 0;
            if (probe.parentNode && typeof probe.parentNode.removeChild === 'function') probe.parentNode.removeChild(probe);
            else if (target.removeChild) target.removeChild(probe);
            const width = Math.max(finalWidth || 0, wideWidth || 0);
            if (width) word.span.style.width = width.toFixed(2) + 'px';
            word.span.setAttribute('data-width-lock', 'wide-probe');
          }
        });
      };
      const start = () => {
        lockWidths();
        words.forEach((word) => animateScrambleWord(word.span, word.text));
      };
      const fonts = document.fonts;
      if (fonts && fonts.ready && typeof fonts.ready.then === 'function') fonts.ready.then(() => scheduleFrame(start));
      else scheduleFrame(start);
      let resizeTimer = 0;
      if (targetWindow && typeof targetWindow.addEventListener === 'function') {
        targetWindow.addEventListener('resize', () => {
          clearTimeout(resizeTimer);
          resizeTimer = setTimeout(() => scheduleFrame(lockWidths), 150);
        });
      }
    });
  }
  initScramble();

`
