/**
 * The admin console behavior script, served verbatim inside a <script> tag.
 *
 * This MUST stay a single template literal with zero interpolation: the
 * previous implementation serialized a bundled function via .toString(),
 * which let esbuild's keepNames helper calls (__name) leak into the page
 * and crash the whole script in production. Nothing here is derived from
 * bundled code; configuration crosses via the #admin-ui-config JSON blob.
 */
export const ADMIN_UI_CLIENT_SCRIPT: string = `(() => {
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

  // --- view + section state -------------------------------------------------
  const setMobileMenu = (open) => {
    const sheet = byId('mobile-menu');
    if (sheet) sheet.hidden = !open;
    const button = byId('mobile-menu-toggle');
    if (button) button.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  const setView = (mode) => {
    document.body.dataset.view = mode;
    ['setup', 'dashboard'].forEach((view) => { const el = byId('view-' + view); if (el) el.hidden = view !== mode; });
    const signOut = byId('sign-out-btn');
    if (signOut) signOut.hidden = mode !== 'dashboard' || !liveToken;
    const menuToggle = byId('mobile-menu-toggle');
    if (menuToggle) menuToggle.hidden = mode !== 'dashboard';
    if (mode !== 'dashboard') setMobileMenu(false);
  };
  const setSection = (name) => {
    config.nav.sections.forEach((section) => {
      const panel = byId(section);
      if (panel) panel.dataset.active = String(section === name);
      document.querySelectorAll('[data-nav="' + section + '"]').forEach((item) => {
        if (section === name) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current');
      });
    });
    setMobileMenu(false);
    // Opening Routing discovers the operator's gateways from the runtime token.
    if (name === 'routing') loadGatewayOptions('', 'routing').catch(() => undefined);
    // Opening the Playground lists inference targets (the direct router plus any gateways).
    if (name === 'playground') loadPlaygroundTargets().catch(() => undefined);
  };
  let appliedRole;
  const userAllowedSections = ['overview', 'playground'];
  function applyRole(role) {
    if (role === appliedRole) return;
    appliedRole = role;
    const restricted = role === 'user';
    config.nav.sections.forEach((section) => {
      const restrict = restricted && userAllowedSections.indexOf(section) < 0;
      const panel = byId(section);
      if (panel) panel.hidden = restrict;
      document.querySelectorAll('[data-nav="' + section + '"]').forEach((navItem) => { navItem.hidden = restrict; });
    });
    if (restricted) setSection('overview');
  }
  const schedulePoll = () => {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(() => {
      pollTimer = undefined;
      if (document.hidden || document.body.dataset.view !== 'dashboard') return;
      // A refresh rebuilds the cards and would drop a pending confirm; hold it while a
      // destructive action is armed, and resume on the next tick after the arm clears.
      if (armedButton && armedButton.dataset.armed === 'true') { schedulePoll(); return; }
      refreshStatus().catch(() => undefined);
      schedulePoll();
    }, config.polling.intervalMs);
  };
  document.addEventListener('visibilitychange', () => {
    if (document.body.dataset.view !== 'dashboard') return;
    if (document.hidden) {
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = undefined;
      return;
    }
    refreshStatus().catch(() => undefined);
    schedulePoll();
  });
  const showDashboard = () => {
    setView('dashboard');
    setSection(config.nav.sections[0]);
    refreshStatus().catch(() => undefined);
    loadVersions().catch(() => undefined);
    loadRuntimeVersions().catch(() => undefined);
    loadInstaller('').catch(() => undefined);
    loadApiKeys().catch(() => undefined);
    closeDrawer();
    schedulePoll();
  };

  // --- wizard ---------------------------------------------------------------
  const wizardSteps = config.wizard.steps;
  const phaseStep = () => {
    if (state.recovery) return 'domain';
    return config.wizard.phaseSteps[state.phase] || 'connect';
  };
  const setWizardStep = (step) => {
    wizardSteps.forEach((name, index) => {
      const panel = byId('step-' + name);
      if (panel) panel.hidden = name !== step;
      const marker = document.querySelector('[data-step="' + name + '"]');
      if (marker) {
        if (name === step) marker.setAttribute('aria-current', 'step'); else marker.removeAttribute('aria-current');
        marker.dataset.done = String(index < wizardSteps.indexOf(step));
      }
    });
    if (step === 'domain') loadZones().catch(() => undefined);
    if (step === 'gateway') loadGatewayOptions('').catch(() => undefined);
    if (step === 'review') renderReview().catch(() => undefined);
  };
  const wizardMove = (delta) => {
    const current = wizardSteps.find((name) => { const panel = byId('step-' + name); return panel && !panel.hidden; }) || wizardSteps[0];
    const next = wizardSteps[Math.min(wizardSteps.length - 1, Math.max(0, wizardSteps.indexOf(current) + delta))];
    setWizardStep(next);
  };
  async function renderReview() {
    const summary = byId('review-summary');
    if (!summary || (!liveToken && !onCustomDomain)) return;
    const status = await request('/admin/status', { headers: headers(false) });
    summary.textContent = '';
    const nodes = Array.isArray(status.nodes) ? status.nodes : [];
    const gateway = status.gateway || {};
    const domain = status.customDomain || {};
    const lines = [
      ['Custom domain', domain.hostname ? String(domain.hostname) : 'not configured'],
      ['Access', state.phase === 'access_ready' || state.phase === 'complete' ? 'enabled' : 'not enabled'],
      ['AI Gateway', gateway.gatewayId ? String(gateway.gatewayId) : 'not connected (available under Routing)'],
      ['Nodes enrolled', String(nodes.length)]
    ];
    lines.forEach((pair) => {
      const tile = document.createElement('div');
      tile.className = 'tile';
      const label = document.createElement('strong');
      label.textContent = pair[0];
      const value = document.createElement('code');
      value.textContent = pair[1];
      tile.append(label, value);
      summary.appendChild(tile);
    });
  }

  // --- one-time token reveal ------------------------------------------------
  function renderTokens(targetId, values) {
    const el = byId(targetId);
    if (!el) return;
    el.classList.remove('is-error');
    el.textContent = '';
    const entries = Object.entries(values).filter((pair) => typeof pair[1] === 'string' && pair[0] !== 'byokInstruction' && pair[0] !== 'adminToken');
    const warning = document.createElement('p');
    warning.className = 'token-warning';
    warning.setAttribute('data-token-warning', 'true');
    warning.textContent = 'Save these now. They are shown only once and are stored hashed.';
    el.appendChild(warning);
    entries.forEach((pair) => {
      const card = document.createElement('div');
      card.className = 'token-card';
      card.setAttribute('data-token-card', pair[0]);
      const label = document.createElement('strong');
      label.textContent = pair[0];
      const code = document.createElement('code');
      code.textContent = pair[1];
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'btn';
      copy.textContent = 'Copy';
      copy.dataset.copy = pair[1];
      card.append(label, code, copy);
      el.appendChild(card);
    });
    if (entries.length > 1) {
      const copyAll = document.createElement('button');
      copyAll.type = 'button';
      copyAll.className = 'btn';
      copyAll.textContent = 'Copy all';
      copyAll.setAttribute('data-copy-all', 'true');
      copyAll.dataset.copy = entries.map((pair) => pair[0] + ': ' + pair[1]).join('\\n');
      el.appendChild(copyAll);
    }
  }
  function revealKey(targetId, label, token, note) {
    const el = byId(targetId);
    if (!el) return;
    el.classList.remove('is-error');
    el.textContent = '';
    if (note) {
      const warning = document.createElement('p');
      warning.className = 'token-warning';
      warning.setAttribute('data-token-warning', 'true');
      warning.textContent = note;
      el.appendChild(warning);
    }
    const card = document.createElement('div');
    card.className = 'token-card';
    card.setAttribute('data-token-card', label);
    const labelEl = document.createElement('strong');
    labelEl.textContent = label;
    const code = document.createElement('code');
    code.textContent = token;
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'btn';
    copy.textContent = 'Copy';
    copy.dataset.copy = token;
    card.append(labelEl, code, copy);
    el.appendChild(card);
  }
  const revealGatewayKey = (out, body) => {
    if (body && body.providerToken) revealKey(out, 'AI Gateway provider key', body.providerToken, body.byokInstruction || 'Paste this key into your AI Gateway custom provider.');
    else setOutput(out, 'Gateway provisioned.');
  };

  // --- renderers fed by /admin/status ----------------------------------------
  const fmtAge = (ms) => {
    if (ms < 60000) return Math.max(1, Math.floor(ms / 1000)) + 's';
    if (ms < 3600000) return Math.floor(ms / 60000) + 'm';
    return Math.floor(ms / 3600000) + 'h';
  };
  const tile = (label, value, stat) => {
    const el = document.createElement('div');
    el.className = 'tile';
    if (stat) el.setAttribute('data-stat', stat);
    const strong = document.createElement('strong');
    strong.textContent = label;
    const code = document.createElement('code');
    code.textContent = value;
    code.setAttribute('data-value', value);
    el.append(strong, code);
    return el;
  };
  const nodeToks = (node) => (node.metrics && typeof node.metrics.tokensPerSecond === 'number') ? node.metrics.tokensPerSecond : null;
  const speedNumber = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;
  const round1 = (value) => String(Math.round(value * 10) / 10);
  const profileModelRef = (profile) => (profile.llamacpp && profile.llamacpp.modelRef) || (profile.meshllm && profile.meshllm.modelRef) || profile.upstreamModel || '';
  // Speed tests are stored per resolved profile id; each mesh card reads its own profile's entry.
  const speedTestFor = (status, model) => {
    const map = status && status.lastSpeedTests && typeof status.lastSpeedTests === 'object' ? status.lastSpeedTests : null;
    const entry = map && model ? map[model.id] : null;
    return entry && typeof entry === 'object' ? entry : null;
  };
  function nodeVramInfo(node) {
    const metrics = (node && node.metrics) || {};
    const reportedTotal = Number(metrics.gpuMemoryTotalMiB || 0);
    const reportedUsed = metrics.gpuMemoryUsedMiB == null ? null : Number(metrics.gpuMemoryUsedMiB);
    return {
      totalMiB: reportedTotal > 0 ? reportedTotal : 0,
      usedMiB: reportedUsed != null && Number.isFinite(reportedUsed) ? reportedUsed : null,
      source: reportedTotal > 0 ? 'reported' : 'none'
    };
  }
  const nodeVramTotal = (node) => nodeVramInfo(node).totalMiB || 0;
  const reportedText = (value) => value == null ? 'not reported' : String(value);
  const readinessText = (value) => value === true ? 'ready' : value === false ? 'down' : 'not reported';
  const fmtGb = (value) => value == null ? 'not reported' : (Math.round(Number(value) * 10) / 10) + ' GB';
  const fmtVramLimit = (value) => value == null || Number(value) === 0 ? 'no limit' : fmtGb(value);
  const fmtGibFromMiB = (value) => value == null || !Number.isFinite(Number(value)) || Number(value) <= 0 ? 'not reported' : (Math.round(Number(value) / 102.4) / 10) + ' GiB';
  // Hero VRAM tile: consumed / total with a single trailing unit; consumption is omitted
  // (never shown as 0) while no machine reports a live used figure.
  const fmtVramPair = (usedMiB, totalMiB) => {
    if (totalMiB == null || !Number.isFinite(Number(totalMiB)) || Number(totalMiB) <= 0) return 'not reported';
    const gib = (value) => String(Math.round(Number(value) / 102.4) / 10);
    return (usedMiB > 0 ? gib(usedMiB) + ' / ' : '') + gib(totalMiB) + ' GB';
  };
  const fmtVramTelemetry = (node) => {
    const vram = nodeVramInfo(node);
    if (vram.totalMiB <= 0) return '—';
    return vram.usedMiB == null ? fmtGibFromMiB(vram.totalMiB) : fmtGibFromMiB(vram.usedMiB) + ' / ' + fmtGibFromMiB(vram.totalMiB);
  };
  const bytesToGb = (bytes) => bytes == null ? null : Number(bytes) / 1000000000;
  function splitReadinessIssue(report) {
    if (!report) return false;
    if (Array.isArray(report.blockers) && report.blockers.length > 0) return true;
    return Boolean(report.verdict && report.verdict !== 'ready');
  }
  function splitReadinessReason(report) {
    if (!report) return '';
    const blockers = Array.isArray(report.blockers) ? report.blockers : [];
    if (blockers.length && blockers[0].reason) return blockers[0].reason;
    return (report.capacityAdvice && report.capacityAdvice.reason) || report.verdict || '';
  }
  function splitReadinessModelSizeUnknown(report) {
    const reason = splitReadinessReason(report);
    return reason === 'model_size_unknown' || reason === 'model size unknown';
  }
  function splitReadinessBlocksRuntime(report, metrics) {
    if (!splitReadinessIssue(report)) return false;
    if (splitReadinessModelSizeUnknown(report)) return false;
    return true;
  }
  function splitReadinessBlocksMesh(entry) {
    if (!splitReadinessIssue(entry && entry.splitReadiness)) return false;
    if (splitReadinessModelSizeUnknown(entry.splitReadiness)) return false;
    return true;
  }
  function splitCapacity(report) {
    return report && report.capacityAdvice ? report.capacityAdvice : {};
  }
  function annotateSplitReadiness(element, report) {
    if (!element || !report) return;
    const reason = splitReadinessReason(report);
    const capacity = splitCapacity(report);
    if (reason) element.setAttribute('data-split-reason', reason);
    if (report.verdict) element.setAttribute('data-split-verdict', report.verdict);
    if (capacity.requiredBytes != null) element.setAttribute('data-required-bytes', String(capacity.requiredBytes));
    if (capacity.aggregateCapacityBytes != null) element.setAttribute('data-aggregate-bytes', String(capacity.aggregateCapacityBytes));
    if (capacity.shortfallBytes != null) element.setAttribute('data-shortfall-bytes', String(capacity.shortfallBytes));
  }
  function humanizeKey(value) {
    return String(value || '').replace(/^participant_/, '').replace(/_/g, ' ').replace(/\\b\\w/g, (char) => char.toUpperCase());
  }
  function splitReadinessLabel(report) {
    if (!report) return '';
    const reason = splitReadinessReason(report);
    const capacity = splitCapacity(report);
    const verdict = report.verdict || '';
    if (reason === 'split_capacity_shortfall' || capacity.state === 'insufficient_capacity' || verdict === 'insufficient_capacity') return 'Split capacity shortfall';
    if (verdict === 'ready') return 'Split ready';
    if (verdict === 'waiting_for_peers' || reason === 'waiting_for_peers') return 'Waiting for peers';
    return humanizeKey(reason || verdict || 'split not ready');
  }
  function splitReadinessText(report) {
    return splitReadinessLabel(report);
  }
  function splitCapacityText(report) {
    const capacity = splitCapacity(report);
    const shortfall = bytesToGb(capacity.shortfallBytes);
    if (shortfall != null && shortfall > 0) return 'Capacity shortfall';
    return '';
  }
  function allStatusNodes() {
    return lastStatus && Array.isArray(lastStatus.nodes) ? lastStatus.nodes : [];
  }
  function nodeDisplayName(node) {
    return (node && (node.displayName || node.name || node.id)) || 'unknown node';
  }
  function modelLabelForRef(ref) {
    const raw = String(ref || '');
    const profiles = lastStatus && Array.isArray(lastStatus.profiles) ? lastStatus.profiles : [];
    const profile = profiles.find((item) => item && (item.upstreamModel === raw || item.id === raw || (Array.isArray(item.publicAliases) && item.publicAliases.indexOf(raw) >= 0)));
    return profile && profile.displayName ? String(profile.displayName) : raw;
  }
  function nodeLabelForId(value, candidates) {
    const raw = String(value || '').trim();
    if (!raw) return 'unknown node';
    const nodes = (Array.isArray(candidates) && candidates.length ? candidates : allStatusNodes());
    const exact = nodes.find((node) => node && (node.id === raw || node.displayName === raw || node.name === raw || (node.metrics && node.metrics.meshNodeId === raw)));
    if (exact) return nodeDisplayName(exact);
    const prefix = nodes.find((node) => {
      const meshNodeId = node && node.metrics ? node.metrics.meshNodeId : '';
      return node && ((node.id && (node.id.indexOf(raw) === 0 || raw.indexOf(node.id) === 0)) || (meshNodeId && (meshNodeId.indexOf(raw) === 0 || raw.indexOf(meshNodeId) === 0)));
    });
    if (prefix) return nodeDisplayName(prefix);
    const loose = nodes.find((node) => node && raw.length >= 6 && ((node.id && node.id.indexOf(raw) >= 0) || (node.metrics && node.metrics.meshNodeId && node.metrics.meshNodeId.indexOf(raw) >= 0)));
    if (loose) return nodeDisplayName(loose);
    return raw.length > 12 ? raw.slice(0, 10) + '…' : raw;
  }
  function splitParticipants(report, candidates) {
    return Array.isArray(report && report.participants) ? report.participants.map((item) => {
      const raw = item.routerNodeId || item.nodeId || item.shortNodeId || '';
      return { label: item.displayName || nodeLabelForId(raw, candidates), raw: raw, capacity: bytesToGb(item.vramBytes) };
    }) : [];
  }
  function idMatchesNode(value, node) {
    const raw = String(value || '').trim();
    if (!raw || !node) return false;
    const names = [node.id, node.displayName, node.name, node.metrics && node.metrics.meshNodeId].filter(Boolean).map(String);
    return names.some((name) => name === raw || name.indexOf(raw) === 0 || raw.indexOf(name) === 0);
  }
  function nodeForStage(stage, candidates) {
    if (!stage) return undefined;
    const nodes = Array.isArray(candidates) && candidates.length ? candidates : allStatusNodes();
    const owner = nodes.find((node) => idMatchesNode(stage.nodeId, node));
    if (owner) return owner;
    return nodes.find((node) => idMatchesNode(stage.reportedByNodeId, node));
  }
  function stageOwnedByNode(stage, node) {
    const owner = nodeForStage(stage, allStatusNodes());
    return owner ? owner.id === node.id : idMatchesNode(stage && stage.nodeId, node);
  }
  function stageKey(stage) {
    return [stage.stageId || '', stage.stageIndex == null ? '' : stage.stageIndex, stage.nodeId || '', stage.layerStart == null ? '' : stage.layerStart, stage.layerEnd == null ? '' : stage.layerEnd].join(':');
  }
  function stageStateRank(stage) {
    const state = String(stage && stage.state || '').toLowerCase();
    if (state === 'ready' || state === 'serving') return 4;
    if (state === 'loading' || state === 'running') return 3;
    if (state === 'pending' || state === 'standby') return 2;
    if (state === 'failed' || state === 'error') return 0;
    return 1;
  }
  function preferStage(current, candidate) {
    if (!current) return candidate;
    const currentPriority = current.__sourcePriority || 0;
    const candidatePriority = candidate.__sourcePriority || 0;
    if (candidatePriority !== currentPriority) return candidatePriority > currentPriority ? candidate : current;
    return stageStateRank(candidate) > stageStateRank(current) ? candidate : current;
  }
  function cleanStage(stage) {
    if (!stage) return stage;
    const { __sourcePriority, ...cleaned } = stage;
    void __sourcePriority;
    return cleaned;
  }
  function nodeStageAssignments(node) {
    const byKey = new Map();
    const add = (stage, sourcePriority) => {
      if (!stage || !stageOwnedByNode(stage, node)) return;
      const candidate = { ...stage, __sourcePriority: sourcePriority };
      byKey.set(stageKey(candidate), preferStage(byKey.get(stageKey(candidate)), candidate));
    };
    if (node && node.metrics && Array.isArray(node.metrics.stageAssignments)) node.metrics.stageAssignments.forEach((stage) => add(stage, 2));
    if (lastStatus && Array.isArray(lastStatus.meshHealth)) lastStatus.meshHealth.forEach((entry) => (Array.isArray(entry.stageAssignments) ? entry.stageAssignments : []).forEach((stage) => add(stage, 1)));
    return [...byKey.values()].map(cleanStage).sort((left, right) => (left.stageIndex || 0) - (right.stageIndex || 0));
  }
  function stageDisplayState(stage, candidates) {
    if (stage && stage.state) return stage.state;
    const ownerNode = nodeForStage(stage, candidates);
    const metrics = ownerNode && ownerNode.metrics ? ownerNode.metrics : {};
    if (metrics.runtimeState === 'ready' && (metrics.nodeState === 'serving' || (Array.isArray(metrics.readyModels) && metrics.readyModels.length > 0) || ((metrics.stageCount || 0) > 0 && metrics.apiReady === true && metrics.consoleReady === true))) return 'ready';
    return '';
  }
  function stageDetailText(stage, candidates, includeOwner) {
    const layers = stage.layerStart != null && stage.layerEnd != null ? ('L' + stage.layerStart + '-' + stage.layerEnd) : ('stage ' + stage.stageIndex);
    const ownerNode = nodeForStage(stage, candidates);
    const owner = includeOwner ? (' → ' + (ownerNode ? nodeDisplayName(ownerNode) : nodeLabelForId(stage.nodeId || stage.reportedByNodeId || '', candidates))) : '';
    const displayState = stageDisplayState(stage, candidates);
    const state = displayState ? ' · ' + humanizeKey(displayState) : '';
    return layers + owner + state;
  }
  function stageDataValue(stage, candidates) {
    const displayState = stageDisplayState(stage, candidates);
    return [stage.nodeId || stage.reportedByNodeId || '', stage.layerStart == null ? '' : stage.layerStart, stage.layerEnd == null ? '' : stage.layerEnd, displayState].join(':');
  }
  function splitReadinessBlock(report, candidates) {
    const wrap = document.createElement('div');
    wrap.className = 'split-readiness-block';
    annotateSplitReadiness(wrap, report);
    const status = document.createElement('div');
    status.className = 'split-readiness-row';
    status.setAttribute('data-split-field', 'status');
    status.appendChild(statusDot(splitReadinessIssue(report) ? 'warn' : 'ok', splitReadinessLabel(report)));
    wrap.appendChild(status);
    const capacity = splitCapacityText(report);
    if (capacity) {
      const row = document.createElement('div');
      row.className = 'split-readiness-row';
      row.setAttribute('data-split-field', 'capacity');
      annotateSplitReadiness(row, report);
      const label = document.createElement('strong');
      label.textContent = 'Capacity';
      const value = document.createElement('span');
      value.textContent = capacity;
      row.append(label, value);
      wrap.appendChild(row);
    }
    const participants = splitParticipants(report, candidates);
    if (participants.length) {
      const row = document.createElement('div');
      row.className = 'split-readiness-row split-participants';
      row.setAttribute('data-split-field', 'participants');
      const label = document.createElement('strong');
      label.textContent = 'Participants';
      const chips = document.createElement('span');
      chips.className = 'split-participant-list';
      participants.forEach((participant) => {
        const chip = document.createElement('span');
        chip.className = 'mini-chip';
        chip.setAttribute('data-participant-label', participant.label);
        if (participant.raw) chip.setAttribute('data-participant-id', participant.raw);
        if (participant.capacity != null) chip.setAttribute('data-participant-capacity-gb', String(participant.capacity));
        chip.textContent = participant.label;
        chips.appendChild(chip);
      });
      row.append(label, chips);
      wrap.appendChild(row);
    }
    return wrap;
  }
  const statusDot = (tone, label) => {
    const wrap = document.createElement('span');
    wrap.className = 'chip';
    wrap.dataset.tone = tone;
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.dataset.tone = tone;
    dot.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.textContent = label;
    wrap.append(dot, text);
    return wrap;
  };
  // The router derives the operator status vocabulary once (displayStatus) so the
  // console and the automation API never disagree; the tone follows the word. The
  // local derivation is a mirror-image fallback for status payloads predating the field.
  const nodeDisplayStatus = (node) => {
    if (node.displayStatus) return node.displayStatus;
    if (node.status === 'offline') return 'Offline';
    if (node.status === 'revoked') return 'Removed';
    if (node.status === 'draining') return 'Draining';
    if (node.deactivated) return 'Deactivated';
    const m = node.metrics || {};
    const rt = m.runtimeState || '';
    if (rt === 'failed' || rt === 'dependency-missing') return 'Error';
    // Mirrors the router derivation: catalog-advertised ready models need a
    // ready/running runtime or a stage assignment to corroborate them.
    const serving = (Array.isArray(m.readyModels) && m.readyModels.length > 0 && (rt === 'ready' || rt === 'running')) || ((m.stageCount || 0) > 0 && m.apiReady === true && m.consoleReady === true);
    if (serving) return 'Serving';
    if (rt === 'downloading' || rt === 'starting' || rt === 'loading' || m.apiReady === true || m.consoleReady === true) return 'Preparing';
    return 'Disconnected';
  };
  const DISPLAY_STATUS_TONES = { Serving: 'ok', Preparing: 'warn', Disconnected: 'warn', Draining: 'warn', Deactivated: 'warn', Offline: 'danger', Error: 'danger', Removed: 'danger' };
  const nodeTone = (node) => DISPLAY_STATUS_TONES[nodeDisplayStatus(node)] || 'warn';
  const nodeReady = (node) => Boolean(node.metrics && Array.isArray(node.metrics.readyModels) && node.metrics.readyModels.length > 0);
  function nodeRelAge(node) {
    if (!node.lastSeenAt) return '';
    const secs = Math.max(0, Math.round((Date.now() - node.lastSeenAt) / 1000));
    if (secs < 60) return secs + 's ago';
    if (secs < 3600) return Math.round(secs / 60) + 'm ago';
    if (secs < 86400) return Math.round(secs / 3600) + 'h ago';
    return Math.round(secs / 86400) + 'd ago';
  }
  // Plain lifecycle category: ready (serving a model), active (online but still
  // loading — includes failed, which is online-but-not-serving), offline (no heartbeat).
  function nodeCategory(node) {
    if (node.status === 'offline' || node.status === 'revoked') return 'offline';
    if (node.deactivated) return 'active';
    if (nodeReady(node)) return 'ready';
    return 'active';
  }
  function activeProfileForNode(node) {
    const profiles = lastStatus && Array.isArray(lastStatus.profiles) ? lastStatus.profiles : [];
    const active = Array.isArray(node.activeProfileIds) ? node.activeProfileIds : [];
    const loadedProfileId = node.metrics && node.metrics.loadedProfileId;
    return profiles.find((profile) => active.indexOf(profile.id) >= 0) || profiles.find((profile) => loadedProfileId && profile.id === loadedProfileId) || profiles.find((profile) => profile.upstreamModel && profile.upstreamModel === node.runtimeModel);
  }
  function splitMeshBlocker(node) {
    const metrics = node.metrics || {};
    const profile = activeProfileForNode(node);
    const splitProfile = Boolean(metrics.splitEnabled || (profile && profile.meshllm && profile.meshllm.split));
    const meshRuntime = metrics.runtimeKind === 'meshllm' || node.runtime === 'meshllm' || (profile && profile.runtime === 'meshllm');
    if (!meshRuntime || !splitProfile || node.status !== 'online' || nodeReady(node)) return undefined;
    if (splitReadinessBlocksRuntime(metrics.splitReadiness, metrics)) return { profile: profile, splitReadiness: metrics.splitReadiness, peerCount: metrics.peerCount, stageCount: metrics.stageCount, port: profile && profile.meshllm && profile.meshllm.bindPort ? String(profile.meshllm.bindPort) : '' };
    const noPeers = metrics.peerCount === 0;
    const noStages = metrics.stageCount === 0;
    const standby = metrics.nodeState === 'standby' || metrics.runtimeState === 'starting';
    if (!standby || (!noPeers && !noStages)) return undefined;
    const port = profile && profile.meshllm && profile.meshllm.bindPort ? String(profile.meshllm.bindPort) : '';
    return { profile: profile, peerCount: metrics.peerCount, stageCount: metrics.stageCount, port: port };
  }
  function meshBlockerText(node) {
    const blocker = splitMeshBlocker(node);
    if (!blocker) return '';
    if (blocker.splitReadiness) return splitReadinessText(blocker.splitReadiness);
    const portHint = blocker.port ? 'WARP UDP ' + blocker.port : 'the mesh UDP port';
    return 'No MeshLLM peers discovered for this split profile. Start another node with the same model/split profile, or check ' + portHint + ' and the join token.';
  }
  function versionKey(value) {
    return String(value || '').replace(/^v/i, '');
  }
  function versionsMatch(left, right) {
    return Boolean(left) && Boolean(right) && versionKey(left) === versionKey(right);
  }
  function currentRuntimeError(metrics) {
    if (!metrics) return '';
    const state = metrics.runtimeState;
    if (splitReadinessBlocksRuntime(metrics.splitReadiness, metrics)) return splitReadinessText(metrics.splitReadiness);
    if (state === 'ready' || state === 'running' || (metrics.apiReady === true && metrics.consoleReady === true && metrics.meshRole)) return '';
    return metrics.lastError || metrics.runtimeDetail || '';
  }
  function runtimeInstallInfo(node) {
    if (node.runtimeInstall && !node.deactivated) return { ...node.runtimeInstall, error: node.runtimeInstall.state === 'failed' ? node.runtimeInstall.error : null };
    const metrics = node.metrics || {};
    const runtime = metrics.runtimeKind === 'llamacpp' || node.runtime === 'llamacpp' ? 'llamacpp' : 'meshllm';
    const desired = lastStatus && lastStatus.desiredRuntimeVersions ? lastStatus.desiredRuntimeVersions[runtime] : '';
    const installed = node.runtimeInstall && node.runtimeInstall.installedVersion ? node.runtimeInstall.installedVersion : (runtime === 'llamacpp' ? metrics.llamacppVersion : metrics.meshllmVersion);
    if (node.deactivated) return { runtime: runtime, desiredVersion: desired || '', installedVersion: installed || null, state: 'paused', error: null };
    const error = currentRuntimeError(metrics);
    // Install failure = the agent's dependency-missing state; startup stderr chatter on a
    // not-yet-versioned runtime must not read as a failed install (mirrors the router derivation).
    const state = metrics.runtimeState === 'downloading' ? 'installing' : (metrics.runtimeState === 'dependency-missing' ? 'failed' : (installed ? 'installed' : 'pending'));
    return { runtime: runtime, desiredVersion: desired || '', installedVersion: installed || null, state: state, error: state === 'failed' ? (error || null) : null };
  }
  const runtimeInstallLabel = (info) => info.runtime === 'llamacpp' ? 'llama.cpp' : 'meshllm';
  const runtimeInstallTone = (info) => info.state === 'failed' ? 'danger' : (info.state === 'installed' ? 'ok' : 'warn');
  // Chip text always leads with the runtime's name ("llama.cpp b9928", "meshllm 0.72.2"),
  // never a bare version an operator has to guess the runtime for.
  const runtimeInstallText = (node) => {
    const info = runtimeInstallInfo(node);
    const label = runtimeInstallLabel(info);
    const desired = info.desiredVersion || 'selected';
    if (info.state === 'paused') return info.installedVersion ? (label + ' ' + info.installedVersion + ' · paused') : (label + ' paused');
    if (info.state === 'installing') return label + ' installing ' + desired;
    if (info.state === 'failed') return label + ' install failed';
    if (info.installedVersion) return label + ' ' + info.installedVersion + (versionsMatch(info.installedVersion, desired) || !desired ? '' : ' → ' + desired);
    return label + ' pending ' + desired;
  };
  function nodeMeshRoleLabel(metrics) {
    if (!metrics) return '';
    if ((metrics.stageCount || 0) > 0 && metrics.meshRole !== 'coordinator') return 'Stage owner';
    if (!metrics.meshRole) return '';
    if (metrics.meshRole === 'api-client') return 'No stage assigned';
    if (metrics.meshRole === 'serving-peer') return 'Serving peer';
    if (metrics.meshRole === 'coordinator') return 'Coordinator';
    return humanizeKey(metrics.meshRole);
  }
  function nodeWorkState(metrics) {
    if (!metrics) return '';
    if ((metrics.stageCount || 0) > 0 && metrics.apiReady === true && metrics.consoleReady === true) return 'Serving split stage';
    if (Array.isArray(metrics.readyModels) && metrics.readyModels.length > 0) return 'Serving model';
    if (metrics.runtimeState === 'downloading') return 'Installing runtime';
    if (metrics.runtimeState === 'starting' || metrics.runtimeState === 'loading') return 'Starting model';
    if (metrics.runtimeState === 'failed' || metrics.runtimeState === 'dependency-missing') return 'Needs attention';
    if (metrics.apiReady === true || metrics.consoleReady === true) return 'Runtime online';
    return metrics.runtimeState ? humanizeKey(metrics.runtimeState) : '';
  }
  function nodeServingCapacity(node) {
    if (node.status !== 'online' || node.deactivated) return false;
    const metrics = node.metrics || {};
    if (splitReadinessBlocksRuntime(metrics.splitReadiness, metrics)) return false;
    if (nodeReady(node) || ((metrics.stageCount || 0) > 0 && metrics.apiReady === true && metrics.consoleReady === true)) return true;
    if (metrics.runtimeState === 'failed' || metrics.runtimeState === 'dependency-missing' || metrics.runtimeState === 'stopped') return false;
    return metrics.apiReady === true || metrics.consoleReady === true;
  }
  function nodeStatusText(node) {
    if (node.status === 'offline') { const age = nodeRelAge(node); return 'Offline' + (age ? ' · last seen ' + age : ''); }
    if (node.status === 'revoked') return 'Removed';
    if (node.status === 'draining') return 'Draining';
    if (node.deactivated) return 'Deactivated';
    const metrics = node.metrics || {};
    const rt = metrics.runtimeState || '';
    const stateDetail = metrics.nodeState || '';
    if (rt === 'failed' || rt === 'dependency-missing') return 'Failed' + (stateDetail ? ' · ' + stateDetail : '');
    if (splitReadinessBlocksRuntime(metrics.splitReadiness, metrics)) return splitReadinessText(metrics.splitReadiness);
    const role = nodeMeshRoleLabel(metrics);
    if (nodeServingCapacity(node)) return role && role !== 'No stage assigned' ? role : (nodeWorkState(metrics) || 'Runtime online');
    if (splitMeshBlocker(node)) return 'Mesh waiting for peers · no peers discovered';
    if (rt === 'downloading') return 'Starting · downloading runtime';
    if (rt === 'loading' || rt === 'starting') return stateDetail ? 'Starting · ' + stateDetail : 'Starting · loading model';
    return 'Starting';
  }
  const revokeButton = (nodeId) => {
    const revoke = document.createElement('button');
    revoke.type = 'button';
    revoke.className = 'btn btn-danger';
    revoke.textContent = 'Revoke';
    revoke.dataset.action = 'node-revoke';
    revoke.dataset.nodeId = nodeId;
    revoke.dataset.confirm = 'Confirm revoke?';
    revoke.dataset.out = 'node-output';
    return revoke;
  };
  const versionCode = (node, desiredVersion) => {
    const reported = node.agentVersion || 'unreported';
    const match = Boolean(desiredVersion) && node.agentVersion === desiredVersion;
    const version = document.createElement('code');
    version.setAttribute('data-node-version', node.id);
    version.setAttribute('data-reported', reported);
    version.setAttribute('data-desired-match', match ? 'true' : 'false');
    version.textContent = reported + (match || !desiredVersion ? '' : ' \u2192 ' + desiredVersion);
    return version;
  };
  const nodeSortValue = (node, key) => {
    if (key === 'status') { const tone = nodeTone(node); return tone === 'ok' ? 2 : tone === 'warn' ? 1 : 0; }
    if (key === 'mesh') return nodeMeshId(node);
    if (key === 'vram') return nodeVramTotal(node);
    if (key === 'version') return node.agentVersion || '';
    return node.id;
  };
  const nodeCellLabel = { id: 'Machine', status: 'Status', mesh: 'Mesh', vram: 'VRAM', version: 'Version' };
  const nodeMeshId = (node) => node.meshId || 'default';
  // Display name for a machine group, resolved from the status mesh list.
  const meshDisplayName = (meshId) => {
    const meshes = lastStatus && Array.isArray(lastStatus.meshes) ? lastStatus.meshes : [];
    const found = meshes.find((mesh) => mesh.id === meshId);
    return found ? found.name : meshId;
  };
  function renderNodesTable(nodes, desiredVersion) {
    const bodyEl = byId(config.nodesTable.bodyId);
    if (!bodyEl) return;
    bodyEl.textContent = '';
    if (!nodes.length) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.className = 'empty-note';
      cell.setAttribute('colspan', String(config.nodesTable.columns.length));
      cell.textContent = 'No nodes enrolled yet. Create a setup token below and run the install command on a machine.';
      row.appendChild(cell);
      bodyEl.appendChild(row);
      return;
    }
    let visible = nodes.slice();
    if (nodeFilter !== 'all') visible = visible.filter((node) => nodeCategory(node) === nodeFilter);
    if (nodeSearch.length >= 3) {
      const query = nodeSearch.toLowerCase();
      visible = visible.filter((node) => (node.id || '').toLowerCase().indexOf(query) >= 0 || (node.displayName || '').toLowerCase().indexOf(query) >= 0);
    }
    if (!visible.length) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.className = 'empty-note';
      cell.setAttribute('colspan', String(config.nodesTable.columns.length));
      cell.textContent = 'No machines match this filter.';
      row.appendChild(cell);
      bodyEl.appendChild(row);
      return;
    }
    const ordered = visible;
    if (nodeSort.key) {
      ordered.sort((left, right) => {
        const a = nodeSortValue(left, nodeSort.key);
        const b = nodeSortValue(right, nodeSort.key);
        return (a < b ? -1 : a > b ? 1 : 0) * nodeSort.dir;
      });
    }
    ordered.forEach((node) => {
      const row = document.createElement('tr');
      row.setAttribute('data-node-row', node.id);
      const cell = (name, value, text) => {
        const td = document.createElement('td');
        td.setAttribute('data-cell', name);
        // Column label per cell so the stacked mobile layout prints "Label: value" (no side-scroll).
        td.setAttribute('data-label', nodeCellLabel[name] || name);
        if (value !== undefined) td.setAttribute('data-value', value);
        if (text !== undefined) td.textContent = text;
        row.appendChild(td);
        return td;
      };
      const idCell = cell('id', undefined, undefined);
      const idButton = document.createElement('button');
      idButton.type = 'button';
      idButton.className = 'link-btn';
      idButton.dataset.action = 'node-detail';
      idButton.dataset.nodeId = node.id;
      idButton.textContent = nodeDisplayName(node);
      idCell.appendChild(idButton);
      const statusCell = cell('status', nodeCategory(node), undefined);
      const blocker = splitMeshBlocker(node);
      if (blocker && blocker.splitReadiness) statusCell.setAttribute('data-status-detail', splitReadinessReason(blocker.splitReadiness));
      else if (blocker) statusCell.setAttribute('data-status-detail', 'split-mesh-peer-discovery');
      else if (node.metrics && node.metrics.nodeState) statusCell.setAttribute('data-status-detail', node.metrics.nodeState);
      if (node.metrics && node.metrics.meshRole) statusCell.setAttribute('data-mesh-role', nodeMeshRoleLabel(node.metrics));
      if (node.metrics && node.metrics.splitReadiness) annotateSplitReadiness(statusCell, node.metrics.splitReadiness);
      // The visible label is the fixed status vocabulary; role/work detail lives in the
      // drawer diagnostics and the cell's data attributes, never in the label.
      const statusWord = nodeDisplayStatus(node);
      const statusLabel = statusWord === 'Offline' ? statusWord + (nodeRelAge(node) ? ' · last seen ' + nodeRelAge(node) : '') : statusWord;
      statusCell.appendChild(statusDot(nodeTone(node), statusLabel));
      const install = runtimeInstallInfo(node);
      const installChip = chipEl(runtimeInstallTone(install), runtimeInstallText(node));
      installChip.setAttribute('data-runtime-install-chip', node.id);
      installChip.setAttribute('data-runtime-install-state', install.state);
      statusCell.appendChild(installChip);
      cell('mesh', nodeMeshId(node), meshDisplayName(nodeMeshId(node)));
      cell('vram', String(nodeVramTotal(node)), fmtVramTelemetry(node));
      const versionCell = cell('version', undefined, undefined);
      versionCell.appendChild(versionCode(node, desiredVersion));
      bodyEl.appendChild(row);
    });
  }
  const topoNodeButton = (node) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'topo-node tone-' + nodeTone(node);
    button.dataset.action = 'node-detail';
    button.dataset.nodeId = node.id;
    button.textContent = nodeDisplayName(node);
    return button;
  };
  // The overview topology can focus on one machine group; 'all' shows every mesh.
  const topologyNodes = (nodes) => topologyMeshFilter === 'all' ? nodes : nodes.filter((node) => nodeMeshId(node) === topologyMeshFilter);
  // Rebuilt on every status render, preserving the operator's selection; a filter
  // whose mesh was deleted falls back to all so the canvas never sticks empty.
  function syncTopoMeshSelect(meshes) {
    const select = byId(config.topology.meshSelectId);
    if (!select) return;
    select.textContent = '';
    const all = document.createElement('option');
    all.value = 'all';
    all.textContent = 'All';
    select.appendChild(all);
    meshes.forEach((mesh) => {
      const option = document.createElement('option');
      option.value = mesh.id;
      option.textContent = mesh.name;
      select.appendChild(option);
    });
    if (topologyMeshFilter !== 'all' && !meshes.some((mesh) => mesh.id === topologyMeshFilter)) topologyMeshFilter = 'all';
    select.value = topologyMeshFilter;
  }
  function renderTopology(nodes) {
    const canvas = byId(config.topology.canvasId);
    const list = byId(config.topology.listId);
    const caption = byId(config.topology.captionId);
    const serving = nodes.filter(nodeServingCapacity).length;
    if (caption) {
      caption.dataset.nodes = String(nodes.length);
      caption.dataset.serving = String(serving);
      caption.textContent = nodes.length + ' machines \u00b7 ' + serving + ' available';
    }
    if (canvas) {
      canvas.textContent = '';
      const hub = document.createElement('div');
      hub.className = 'topo-hub';
      hub.setAttribute('data-topo-hub', 'true');
      hub.textContent = 'router';
      canvas.appendChild(hub);
      canvas.classList.toggle('is-empty', nodes.length === 0);
      if (!nodes.length) {
        const empty = document.createElement('p');
        empty.className = 'topo-empty';
        empty.textContent = 'No nodes enrolled yet. Add one from Nodes.';
        canvas.appendChild(empty);
      }
      nodes.forEach((node, index) => {
        const angle = (index / Math.max(1, nodes.length)) * 2 * Math.PI - Math.PI / 2;
        // The canvas is 2:1, so a percent of height is only half a percent of width in
        // pixels. Size the spoke to reach the node on that aspect-corrected ellipse (rather
        // than a fixed width-% line at the raw angle) so a near-vertical connector can never
        // overshoot the shorter vertical axis and poke outside the canvas.
        const rx = 38;
        const ry = 38;
        const dxWidth = rx * Math.cos(angle);
        const dyWidth = (ry / 2) * Math.sin(angle);
        const spokeLength = Math.hypot(dxWidth, dyWidth);
        const spokeAngle = Math.atan2(dyWidth, dxWidth) * 180 / Math.PI;
        const spoke = document.createElement('span');
        spoke.className = 'topo-spoke';
        spoke.setAttribute('aria-hidden', 'true');
        spoke.setAttribute('style', 'width:' + spokeLength.toFixed(2) + '%;transform:rotate(' + spokeAngle.toFixed(1) + 'deg)');
        canvas.appendChild(spoke);
        const button = topoNodeButton(node);
        const x = 50 + rx * Math.cos(angle);
        const y = 50 + ry * Math.sin(angle);
        button.setAttribute('style', 'left:' + x.toFixed(1) + '%;top:' + y.toFixed(1) + '%');
        canvas.appendChild(button);
      });
    }
    if (list) {
      list.textContent = '';
      nodes.forEach((node) => list.appendChild(topoNodeButton(node)));
    }
  }
  const pushToksSample = (value) => {
    toksSamples.push(value);
    const cap = config.toksTrace.window;
    if (toksSamples.length > cap) toksSamples = toksSamples.slice(toksSamples.length - cap);
  };
  function renderToksTrace() {
    const trace = byId(config.toksTrace.containerId);
    if (!trace) return;
    trace.textContent = '';
    // Leave the trace empty (and hidden by .toks-trace:empty) when there is no real
    // throughput, so baseline bars do not read as an alarming coral line at zero.
    if (!toksSamples.length || toksSamples.every((value) => value <= 0)) return;
    const span = config.toksTrace.smoothing;
    const smoothed = toksSamples.map((value, index) => {
      const window = toksSamples.slice(Math.max(0, index - span + 1), index + 1);
      return window.reduce((sum, item) => sum + item, 0) / window.length;
    });
    const peak = smoothed.reduce((max, value) => Math.max(max, value), 0) || 1;
    toksSamples.forEach((raw, index) => {
      const bar = document.createElement('span');
      bar.className = 'trace-bar';
      bar.setAttribute('data-sample', String(raw));
      bar.setAttribute('data-smoothed', round1(smoothed[index]));
      bar.setAttribute('style', 'height:' + (smoothed[index] / peak * 100).toFixed(1) + '%');
      trace.appendChild(bar);
    });
  }
  const openDrawer = (title) => {
    const drawer = byId(config.drawer.containerId);
    const titleEl = byId(config.drawer.titleId);
    const bodyEl = byId(config.drawer.bodyId);
    if (!drawer || !titleEl || !bodyEl) return undefined;
    titleEl.textContent = title;
    bodyEl.textContent = '';
    drawer.hidden = false;
    return bodyEl;
  };
  const closeDrawer = () => {
    const drawer = byId(config.drawer.containerId);
    if (drawer) drawer.hidden = true;
  };
  const drawerField = (name, label, value, datasetValue) => {
    const row = document.createElement('div');
    row.className = 'drawer-row';
    row.setAttribute('data-drawer-field', name);
    if (datasetValue !== undefined) row.setAttribute('data-value', datasetValue);
    const labelEl = document.createElement('strong');
    labelEl.textContent = label;
    const valueEl = document.createElement('code');
    valueEl.textContent = value;
    row.append(labelEl, valueEl);
    return row;
  };
  function openNodeDrawer(nodeId) {
    const nodes = lastStatus && Array.isArray(lastStatus.nodes) ? lastStatus.nodes : [];
    const node = nodes.find((candidate) => candidate.id === nodeId);
    if (!node) return;
    const bodyEl = openDrawer(nodeDisplayName(node));
    if (!bodyEl) return;
    const metrics = node.metrics || {};
    const isDirectRuntime = node.runtime === 'llamacpp' || metrics.runtimeKind === 'llamacpp';
    const vram = nodeVramInfo(node);
    const vramValue = vram.totalMiB <= 0 ? 'not reported' : fmtVramTelemetry(node);
    bodyEl.appendChild(drawerField('status', 'Status', nodeStatusText(node)));
    const vramRow = drawerField('vram', 'VRAM', vramValue, vram.totalMiB > 0 ? (vram.usedMiB == null ? String(Math.round(vram.totalMiB)) : vram.usedMiB + '/' + Math.round(vram.totalMiB)) : '');
    vramRow.setAttribute('data-vram-source', vram.source);
    bodyEl.appendChild(vramRow);
    const activeProfile = activeProfileForNode(node);
    const profileBudget = activeProfile && activeProfile.meshllm ? activeProfile.meshllm.maxVramGb : undefined;
    const desiredBudget = node.maxVramGbOverride != null ? node.maxVramGbOverride : profileBudget;
    const runningBudget = metrics.meshMaxVramGb;
    const runningDiffers = runningBudget != null && Number(runningBudget) !== Number(desiredBudget || 0);
    if (desiredBudget != null || runningDiffers) {
      const desiredLabel = node.maxVramGbOverride != null ? 'desired node override ' : 'desired profile ';
      const budgetText = desiredLabel + fmtVramLimit(desiredBudget) + (runningDiffers ? ' / running ' + fmtVramLimit(runningBudget) + ' until restart' : '');
      const budget = drawerField('mesh-vram-budget', 'Mesh VRAM limit', budgetText, runningBudget == null ? '' : String(runningBudget));
      if (profileBudget != null) budget.setAttribute('data-profile-budget', String(profileBudget));
      if (node.maxVramGbOverride != null) budget.setAttribute('data-node-override', String(node.maxVramGbOverride));
      if (runningBudget != null) budget.setAttribute('data-running-budget', String(runningBudget));
      if (runningDiffers) budget.setAttribute('data-budget-stale', 'true');
      bodyEl.appendChild(budget);
    }
    if (metrics.gpuName) bodyEl.appendChild(drawerField('gpu', 'GPU', metrics.gpuName));
    const desired = lastStatus ? lastStatus.desiredAgentVersion : undefined;
    const reported = node.agentVersion || 'unreported';
    const match = Boolean(desired) && node.agentVersion === desired;
    const versionRow = drawerField('version', 'Agent version', reported + (match || !desired ? '' : ' \u2192 ' + desired));
    versionRow.setAttribute('data-reported', reported);
    versionRow.setAttribute('data-desired-match', match ? 'true' : 'false');
    bodyEl.appendChild(versionRow);
    // Diagnostics: surface why a node is in its current state without SSH. The runtime error line is
    // captured from mesh-llm's own stderr and rides the heartbeat as runtimeDetail; node_state, mesh
    // role, peers, stages, and reachability come from the same metrics. REQ-OBS-011.
    const runtimeError = currentRuntimeError(metrics);
    if (metrics.splitReadiness && (splitReadinessBlocksRuntime(metrics.splitReadiness, metrics) || !splitReadinessModelSizeUnknown(metrics.splitReadiness))) {
      const splitBlock = splitReadinessBlock(metrics.splitReadiness, allStatusNodes());
      splitBlock.setAttribute('data-drawer-field', 'split-readiness');
      bodyEl.appendChild(splitBlock);
    } else if (runtimeError) {
      const errRow = drawerField('runtime-detail', 'Runtime error', runtimeError);
      errRow.setAttribute('data-tone', 'danger');
      bodyEl.appendChild(errRow);
    }
    const install = runtimeInstallInfo(node);
    const installRow = drawerField('runtime-install', 'Runtime', runtimeInstallText(node));
    installRow.setAttribute('data-runtime', install.runtime);
    installRow.setAttribute('data-runtime-install-state', install.state);
    if (install.desiredVersion) installRow.setAttribute('data-desired-version', install.desiredVersion);
    if (install.installedVersion) installRow.setAttribute('data-installed-version', install.installedVersion);
    installRow.setAttribute('data-tone', runtimeInstallTone(install));
    bodyEl.appendChild(installRow);
    if (install.error) {
      const installError = drawerField('runtime-install-error', 'Runtime install error', install.error);
      installError.setAttribute('data-tone', 'danger');
      bodyEl.appendChild(installError);
    }
    const blockerText = meshBlockerText(node);
    if (blockerText) {
      const blocker = splitMeshBlocker(node);
      if (!blocker || !blocker.splitReadiness) {
        const row = drawerField('mesh-discovery-blocker', 'Mesh blocker', blockerText);
        row.setAttribute('data-tone', 'danger');
        if (blocker && blocker.peerCount != null) row.setAttribute('data-peer-count', String(blocker.peerCount));
        if (blocker && blocker.stageCount != null) row.setAttribute('data-stage-count', String(blocker.stageCount));
        bodyEl.appendChild(row);
      }
    }
    const workState = nodeWorkState(metrics);
    if (workState) bodyEl.appendChild(drawerField('work-state', 'Work state', workState, workState));
    if (!isDirectRuntime || metrics.meshRole || (metrics.stageCount || 0) > 0) bodyEl.appendChild(drawerField('mesh-role', 'Mesh role', nodeMeshRoleLabel(metrics) || 'not reported'));
    if (!isDirectRuntime || metrics.peerCount != null) bodyEl.appendChild(drawerField('peers', 'Peers', reportedText(metrics.peerCount), metrics.peerCount == null ? '' : String(metrics.peerCount)));
    const nodeStages = nodeStageAssignments(node);
    if (nodeStages.length) bodyEl.appendChild(drawerField('stage-ownership', 'Stage ownership', nodeStages.map((stage) => stageDetailText(stage, allStatusNodes(), true)).join('; '), nodeStages.map((stage) => stageDataValue(stage, allStatusNodes())).join('|')));
    else if (metrics.splitEnabled || metrics.stageCount) bodyEl.appendChild(drawerField('stages', 'Stages', reportedText(metrics.stageCount), metrics.stageCount == null ? '' : String(metrics.stageCount)));
    const apiState = readinessText(metrics.apiReady);
    if (isDirectRuntime && typeof metrics.consoleReady !== 'boolean') {
      bodyEl.appendChild(drawerField('reachability', 'Runtime API', apiState, 'api:' + apiState));
    } else {
      const consoleState = readinessText(metrics.consoleReady);
      bodyEl.appendChild(drawerField('reachability', 'API / console', apiState + ' / ' + consoleState, 'api:' + apiState + ';console:' + consoleState));
    }
    if (metrics.meshllmVersion && !(install.runtime === 'meshllm' && install.installedVersion)) bodyEl.appendChild(drawerField('meshllm', 'mesh-llm', metrics.meshllmVersion));
    if (metrics.llamacppVersion && !(install.runtime === 'llamacpp' && install.installedVersion)) bodyEl.appendChild(drawerField('llamacpp', 'llama.cpp', metrics.llamacppVersion));
    if (isDirectRuntime) {
      bodyEl.appendChild(drawerField('direct-context', 'Direct context tokens', reportedText(metrics.ctxSize), metrics.ctxSize != null ? String(metrics.ctxSize) : ''));
      // parallel -1 = Auto: the configured value is not a slot count, so only the
      // live slotCount reported by llama-server is meaningful until it arrives.
      const slotsCapacity = metrics.slotCount != null ? metrics.slotCount : (metrics.parallel !== -1 ? metrics.parallel : null);
      const slotsText = metrics.activeSlots != null && slotsCapacity != null ? (metrics.activeSlots + ' / ' + slotsCapacity) : (slotsCapacity != null ? 'parallel ' + slotsCapacity : 'not reported');
      const slotsRow = drawerField('direct-parallel', 'Direct slots', slotsText, slotsCapacity != null ? String(slotsCapacity) : '');
      if (metrics.activeSlots != null) slotsRow.setAttribute('data-active-slots', String(metrics.activeSlots));
      if (metrics.slotCount != null) slotsRow.setAttribute('data-slot-count', String(metrics.slotCount));
      if (metrics.parallel != null) slotsRow.setAttribute('data-parallel', String(metrics.parallel));
      bodyEl.appendChild(slotsRow);
      const cacheState = metrics.cachePrompt === true ? 'on' : metrics.cachePrompt === false ? 'off' : 'not reported';
      bodyEl.appendChild(drawerField('direct-cache', 'Prompt cache', cacheState + (metrics.cacheReuse != null ? ' · reuse ' + metrics.cacheReuse : '')));
      bodyEl.appendChild(drawerField('direct-cached-tokens', 'Last cached tokens', reportedText(metrics.cachedTokensLast), metrics.cachedTokensLast != null ? String(metrics.cachedTokensLast) : ''));
      if (metrics.lastError) {
        const llamaErr = drawerField('llamacpp-last-error', 'llama.cpp error', metrics.lastError);
        llamaErr.setAttribute('data-tone', 'danger');
        bodyEl.appendChild(llamaErr);
      }
    }
    const models = Array.isArray(metrics.readyModels) ? metrics.readyModels : [];
    models.forEach((model) => {
      const item = document.createElement('div');
      item.className = 'drawer-row';
      item.setAttribute('data-drawer-model', model);
      item.textContent = modelLabelForRef(model);
      bodyEl.appendChild(item);
    });
    const nameRow = document.createElement('label');
    nameRow.className = 'drawer-row';
    nameRow.textContent = 'Machine name';
    const nameInput = document.createElement('input');
    nameInput.id = 'node-edit-name';
    nameInput.type = 'text';
    nameInput.value = nodeDisplayName(node);
    nameInput.dataset.original = nodeDisplayName(node);
    nameRow.appendChild(nameInput);
    bodyEl.appendChild(nameRow);
    const vramOverrideRow = document.createElement('label');
    vramOverrideRow.className = 'drawer-row';
    vramOverrideRow.textContent = 'Max VRAM override (GB, blank = use model default)';
    const vramInput = document.createElement('input');
    vramInput.id = 'node-edit-vram';
    vramInput.type = 'number';
    vramInput.min = '0';
    vramInput.step = '0.5';
    // Blank = follow the model's global budget; a number caps just this node (0 = uncapped here).
    vramInput.value = node.maxVramGbOverride != null ? String(node.maxVramGbOverride) : '';
    vramOverrideRow.appendChild(vramInput);
    bodyEl.appendChild(vramOverrideRow);
    // Mesh assignment: which machine group this node serves (REQ-ADM-023 / REQ-SCH-006).
    const meshRow = document.createElement('label');
    meshRow.className = 'drawer-row';
    meshRow.textContent = 'Mesh';
    const meshSelect = document.createElement('select');
    meshSelect.id = 'node-edit-mesh';
    const meshes = lastStatus && Array.isArray(lastStatus.meshes) ? lastStatus.meshes : [{ id: 'default', name: 'Default' }];
    meshes.forEach((mesh) => {
      const option = document.createElement('option');
      option.value = mesh.id;
      option.textContent = mesh.name;
      meshSelect.appendChild(option);
    });
    meshSelect.value = nodeMeshId(node);
    meshSelect.dataset.original = nodeMeshId(node);
    meshRow.appendChild(meshSelect);
    meshRow.appendChild(drawerHint('Moving a machine hands it the new mesh’s model on its next check-in; its old model stops once the new one deploys.'));
    bodyEl.appendChild(meshRow);
    const saveVram = document.createElement('button');
    saveVram.type = 'button';
    saveVram.className = 'btn';
    saveVram.textContent = 'Save machine settings';
    saveVram.dataset.action = 'node-config-save';
    saveVram.dataset.nodeId = node.id;
    saveVram.dataset.out = 'node-output';
    bodyEl.appendChild(saveVram);
    // Deactivate/Activate is the reversible taint (keeps the node in the mesh, runs no model);
    // Revoke stays the one-way decommission. REQ-ADM-030.
    const taint = document.createElement('button');
    taint.type = 'button';
    taint.className = 'btn';
    taint.textContent = node.deactivated ? 'Activate' : 'Deactivate';
    taint.dataset.action = node.deactivated ? 'node-activate' : 'node-deactivate';
    taint.dataset.nodeId = node.id;
    taint.dataset.out = 'node-output';
    bodyEl.appendChild(taint);
    // Force Reload restarts mesh-llm on this node on demand (drains first); reversible, not a decommission. REQ-ADM-032.
    const reload = document.createElement('button');
    reload.type = 'button';
    reload.className = 'btn';
    reload.textContent = 'Force Reload';
    reload.dataset.action = 'node-reload';
    reload.dataset.nodeId = node.id;
    reload.dataset.out = 'node-output';
    bodyEl.appendChild(reload);
    bodyEl.appendChild(revokeButton(node.id));
  }
  // meshTunableNumberRow / meshTunableSelectRow build one Advanced-runtime row in
  // the model drawer: the existing drawer-row shape plus a .drawer-hint line that
  // explains the setting. A blank number or the Auto option means "unset" for
  // runtime-specific optional fields; the placeholder shows the sensible default.
  function drawerHint(text) {
    const hint = document.createElement('span');
    hint.className = 'drawer-hint';
    hint.textContent = text;
    return hint;
  }
  function meshTunableNumberRow(opts) {
    const row = document.createElement('label');
    row.className = 'drawer-row';
    row.textContent = opts.label;
    const input = document.createElement('input');
    input.id = opts.id;
    input.type = 'number';
    input.min = opts.min != null ? String(opts.min) : '1';
    if (opts.value != null && opts.value !== '') input.value = String(opts.value);
    if (opts.placeholder) input.placeholder = opts.placeholder;
    row.appendChild(input);
    if (opts.hint) row.appendChild(drawerHint(opts.hint));
    return row;
  }
  function meshTunableRowText(opts) {
    const row = document.createElement('label');
    row.className = 'drawer-row';
    row.textContent = opts.label;
    const input = document.createElement('input');
    input.id = opts.id;
    input.type = 'text';
    if (opts.value != null && opts.value !== '') input.value = String(opts.value);
    if (opts.placeholder) input.placeholder = opts.placeholder;
    row.appendChild(input);
    if (opts.hint) row.appendChild(drawerHint(opts.hint));
    return row;
  }
  function meshTunableSelectRow(opts) {
    const row = document.createElement('label');
    row.className = 'drawer-row';
    row.textContent = opts.label;
    const select = document.createElement('select');
    select.id = opts.id;
    opts.options.forEach((choice) => {
      const option = document.createElement('option');
      option.value = choice.value;
      option.textContent = choice.label;
      if (choice.value === opts.value) option.selected = true;
      select.appendChild(option);
    });
    select.value = opts.value || '';
    row.appendChild(select);
    if (opts.hint) row.appendChild(drawerHint(opts.hint));
    return row;
  }
  function openModelDrawer(profileId) {
    const profiles = lastStatus && Array.isArray(lastStatus.profiles) ? lastStatus.profiles : [];
    const profile = profiles.find((candidate) => candidate.id === profileId);
    if (!profile) return;
    const bodyEl = openDrawer(modelName(profile));
    if (!bodyEl) return;
    // The drawer leads with the same identity pills as the list row, so every profile
    // shows its provider, serving mode, and mesh assignment at a glance.
    const pillRow = document.createElement('div');
    pillRow.className = 'model-name-row';
    pillRow.setAttribute('data-drawer-pills', profile.id);
    pillRow.append(...profilePills(profile, profile.runtime === 'llamacpp', Boolean(profile.meshllm && profile.meshllm.split)));
    bodyEl.appendChild(pillRow);
    bodyEl.appendChild(drawerField('active', 'Status', profile.active ? 'On' : 'Off'));
    bodyEl.appendChild(drawerField('runtime', 'Runtime', profile.runtime === 'llamacpp' ? 'llama.cpp' : 'meshllm', profile.runtime || 'meshllm'));
    // Editable settings, saved through the validated profile-config endpoint. Name is
    // the human label; call name is this model's own public alias. Apps can always
    // also reach whichever model is on through the shared codeflare-mesh name. Only a
    // changed value is sent, so a default model keeps its extra canonical aliases.
    const nameRow = document.createElement('label');
    nameRow.className = 'drawer-row';
    nameRow.textContent = 'Name';
    const nameInput = document.createElement('input');
    nameInput.id = 'model-edit-name';
    nameInput.type = 'text';
    nameInput.value = modelName(profile);
    nameInput.dataset.original = modelName(profile);
    nameRow.appendChild(nameInput);
    bodyEl.appendChild(nameRow);
    const callRow = document.createElement('label');
    callRow.className = 'drawer-row';
    callRow.textContent = 'Alias';
    const callInput = document.createElement('input');
    callInput.id = 'model-edit-callname';
    callInput.type = 'text';
    const currentCall = callName(profile);
    callInput.value = currentCall;
    callInput.dataset.original = currentCall;
    callRow.appendChild(callInput);
    callRow.appendChild(drawerHint('The stable name callers ask for, auto-derived from the model. Apps can always also use the shared codeflare-mesh name; you rarely need to change this.'));
    bodyEl.appendChild(callRow);
    const meshllm = profile.meshllm || {};
    const llamacpp = profile.llamacpp || {};
    const isDirect = profile.runtime === 'llamacpp';
    const ctxRow = document.createElement('label');
    ctxRow.className = 'drawer-row';
    ctxRow.textContent = 'Context window (tokens)';
    const ctxInput = document.createElement('input');
    ctxInput.id = 'model-edit-context';
    ctxInput.type = 'number';
    ctxInput.min = isDirect ? '4096' : '0';
    ctxInput.placeholder = 'Auto';
    // 0 = Auto, shown as a blank field: mesh-llm sizes the context to the GPU.
    ctxInput.value = (isDirect ? (llamacpp.contextWindow || profile.contextWindow) : profile.contextWindow) ? String(isDirect ? (llamacpp.contextWindow || profile.contextWindow) : profile.contextWindow) : '';
    ctxRow.appendChild(ctxInput);
    ctxRow.appendChild(drawerHint(isDirect ? 'Max tokens kept in llama.cpp context. Blank = Auto (llama.cpp loads the native model context). Pin a number (4096 or higher) to cap it; larger uses more GPU memory.' : 'Max tokens kept in context. Blank = Auto (mesh-llm sizes it to the GPU). Pin a number (e.g. 262144) to fix it; larger uses more GPU memory and may leave room for fewer lanes.'));
    bodyEl.appendChild(ctxRow);
    const modelRow = document.createElement('label');
    modelRow.className = 'drawer-row';
    modelRow.textContent = 'Model file';
    const modelInput = document.createElement('input');
    modelInput.id = 'model-edit-model';
    modelInput.type = 'text';
    modelInput.value = (profile.llamacpp && profile.llamacpp.modelRef) || (profile.meshllm && profile.meshllm.modelRef) || '';
    modelRow.appendChild(modelInput);
    bodyEl.appendChild(modelRow);
    const vramRow = document.createElement('label');
    vramRow.className = 'drawer-row';
    vramRow.textContent = 'Max VRAM for this model (GB, 0 = no limit)';
    const vramInput = document.createElement('input');
    vramInput.id = 'model-edit-vram';
    vramInput.type = 'number';
    vramInput.min = '0';
    vramInput.step = '0.5';
    // Empty when there is no cap (unset or zero); a positive value is the GB ceiling.
    vramInput.value = profile.meshllm && profile.meshllm.maxVramGb ? String(profile.meshllm.maxVramGb) : '';
    vramRow.appendChild(vramInput);
    if (!isDirect) bodyEl.appendChild(vramRow);
    // Mesh assignment: which machine group serves this model (REQ-RUN-016). Moving it
    // swaps its stable alias and deploys it switched off in the new mesh.
    const modelMeshRow = document.createElement('label');
    modelMeshRow.className = 'drawer-row';
    modelMeshRow.textContent = 'Mesh';
    const modelMeshSelect = document.createElement('select');
    modelMeshSelect.id = 'model-edit-mesh';
    const meshOptions = lastStatus && Array.isArray(lastStatus.meshes) ? lastStatus.meshes : [{ id: 'default', name: 'Default' }];
    meshOptions.forEach((mesh) => {
      const option = document.createElement('option');
      option.value = mesh.id;
      option.textContent = mesh.name;
      modelMeshSelect.appendChild(option);
    });
    modelMeshSelect.value = profile.meshId || 'default';
    modelMeshSelect.dataset.original = profile.meshId || 'default';
    modelMeshRow.appendChild(modelMeshSelect);
    modelMeshRow.appendChild(drawerHint('Moving a model re-routes it to the new mesh’s callable name and switches it off until you deploy it there.'));
    bodyEl.appendChild(modelMeshRow);
    // Advanced runtime settings are runtime-specific: MeshLLM gets Auto-clearable
    // tunables, while direct llama.cpp gets cache-local server flags.
    const advancedHead = document.createElement('div');
    advancedHead.className = 'drawer-subhead';
    advancedHead.textContent = 'Advanced runtime';
    bodyEl.appendChild(advancedHead);
    const kvOptions = [{ value: '', label: 'Auto' }, { value: 'f16', label: 'f16 (full precision)' }, { value: 'q8_0', label: 'q8_0 (balanced)' }, { value: 'q4_0', label: 'q4_0 (smallest)' }];
    const onOffOptions = [{ value: '', label: 'Auto' }, { value: 'on', label: 'On' }, { value: 'off', label: 'Off' }];
    if (!isDirect) {
      const reasoning = meshllm.reasoning || {};
      const flashValue = meshllm.flashAttn === true ? 'on' : meshllm.flashAttn === false ? 'off' : '';
      const reasoningValue = reasoning.enabled === true ? 'on' : reasoning.enabled === false ? 'off' : '';
      bodyEl.appendChild(meshTunableNumberRow({ id: 'model-edit-parallel', label: 'Parallel lanes', value: meshllm.parallel, placeholder: 'Auto', hint: 'Concurrent request slots. 2 or more enables input caching (fast prompt reuse); 1 disables it. Blank = Auto (mesh-llm plans up to 4).' }));
      bodyEl.appendChild(meshTunableSelectRow({ id: 'model-edit-cache-k', label: 'KV cache type (keys)', value: meshllm.cacheTypeK || '', options: kvOptions, hint: 'Precision of the cached keys. q8_0 halves memory vs f16 with negligible quality loss; q4_0 quarters it to fit very large contexts.' }));
      bodyEl.appendChild(meshTunableSelectRow({ id: 'model-edit-cache-v', label: 'KV cache type (values)', value: meshllm.cacheTypeV || '', options: kvOptions, hint: 'Precision of the cached values. Match the key type unless you have a reason not to.' }));
      bodyEl.appendChild(meshTunableNumberRow({ id: 'model-edit-batch', label: 'Prefill batch', value: meshllm.batch, placeholder: '2048', hint: 'Tokens processed per prefill step. Higher (e.g. 8192) speeds long-prompt ingestion but uses more memory. Blank = default.' }));
      bodyEl.appendChild(meshTunableNumberRow({ id: 'model-edit-ubatch', label: 'Micro-batch', value: meshllm.ubatch, placeholder: '512', hint: 'Physical sub-batch of the prefill batch. Higher (e.g. 4096) speeds ingestion at higher memory. Blank = default.' }));
      bodyEl.appendChild(meshTunableSelectRow({ id: 'model-edit-flash', label: 'Flash attention', value: flashValue, options: onOffOptions, hint: 'Memory-efficient attention; also required for quantized KV. Leave On unless the model is incompatible.' }));
      bodyEl.appendChild(meshTunableNumberRow({ id: 'model-edit-maxout', label: 'Max output tokens', value: meshllm.maxOutputTokens, placeholder: '8192', hint: 'Cap on tokens generated per response, including reasoning tokens. Bounds runaway answers. Keep it above the reasoning budget so the model has room to answer. Blank = default.' }));
      bodyEl.appendChild(meshTunableSelectRow({ id: 'model-edit-reasoning', label: 'Reasoning', value: reasoningValue, options: onOffOptions, hint: 'Enables the model thinking phase (reasoning-capable models only).' }));
      bodyEl.appendChild(meshTunableRowText({ id: 'model-edit-reasoning-format', label: 'Reasoning format', value: reasoning.format || '', placeholder: 'deepseek', hint: 'Reasoning output format tag. Usually deepseek.' }));
      bodyEl.appendChild(meshTunableNumberRow({ id: 'model-edit-reasoning-budget', label: 'Reasoning budget', value: reasoning.budget, placeholder: '4096', hint: 'Max tokens the model spends thinking before it answers. Part of the output budget, so keep it below Max output tokens (a 2:1 split, e.g. 8192 / 4096, leaves room to answer).' }));
      bodyEl.appendChild(meshTunableSelectRow({ id: 'model-edit-tool-emulation', label: 'Tool calling', value: meshllm.toolEmulation === true ? 'emulated' : '', options: [{ value: '', label: 'Native (template grammar)' }, { value: 'emulated', label: 'Forced emulation' }], hint: 'Native parses tool calls with the model template grammar. Forced emulation uses the text-convention protocol instead - pick it when agent tool calls fail to parse (e.g. ERNIE Thinking).' }));
    }
    if (isDirect) {
      const reasoning = llamacpp.reasoning || {};
      const flashValue = llamacpp.flashAttn === true ? 'on' : llamacpp.flashAttn === false ? 'off' : '';
      const reasoningValue = reasoning.enabled === true ? 'on' : reasoning.enabled === false ? 'off' : '';
      bodyEl.appendChild(meshTunableNumberRow({ id: 'model-edit-llama-parallel', label: 'llama.cpp parallel slots', value: llamacpp.parallel === -1 ? '' : llamacpp.parallel, placeholder: 'Auto', hint: 'Concurrent direct slots for this node-local llama-server. Blank = Auto (llama.cpp plans 4 slots with unified KV). With Unified KV on, more slots serve more overlapping requests without shrinking the per-request context.' }));
      bodyEl.appendChild(meshTunableSelectRow({ id: 'model-edit-llama-kv-unified', label: 'Unified KV cache', value: llamacpp.kvUnified === false ? 'off' : 'on', options: [{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }], hint: 'llama.cpp --kv-unified. On shares one KV buffer so a single request can use the whole context window; Off splits the context evenly across parallel slots (context ÷ slots per request).' }));
      bodyEl.appendChild(meshTunableRowText({ id: 'model-edit-llama-gpu-layers', label: 'GPU layers (-ngl / --gpu-layers)', value: llamacpp.gpuLayers || '', placeholder: '99', hint: 'Max model layers stored in VRAM. Higher values usually improve generation speed; 0 means CPU-only; blank uses llama.cpp default auto.' }));
      bodyEl.appendChild(meshTunableSelectRow({ id: 'model-edit-llama-cache-k', label: 'KV cache type (keys)', value: llamacpp.cacheTypeK || '', options: kvOptions, hint: 'llama.cpp --cache-type-k. Lower precision uses less KV memory and can fit larger contexts; higher precision uses more memory.' }));
      bodyEl.appendChild(meshTunableSelectRow({ id: 'model-edit-llama-cache-v', label: 'KV cache type (values)', value: llamacpp.cacheTypeV || '', options: kvOptions, hint: 'llama.cpp --cache-type-v. Match the key type unless you are testing a specific memory/quality tradeoff.' }));
      bodyEl.appendChild(meshTunableNumberRow({ id: 'model-edit-llama-batch', label: 'Prefill batch', value: llamacpp.batch, placeholder: '8192', hint: 'llama.cpp --batch-size. Higher values can speed prompt ingestion but use more memory during prefill.' }));
      bodyEl.appendChild(meshTunableNumberRow({ id: 'model-edit-llama-ubatch', label: 'Micro-batch', value: llamacpp.ubatch, placeholder: '2048', hint: 'llama.cpp --ubatch-size. Higher values can improve prompt-loading speed but increase peak memory; lower it if requests fail under load.' }));
      bodyEl.appendChild(meshTunableSelectRow({ id: 'model-edit-llama-flash', label: 'Flash attention', value: flashValue, options: onOffOptions, hint: 'llama.cpp --flash-attn. Usually On for fast large-context serving.' }));
      bodyEl.appendChild(meshTunableNumberRow({ id: 'model-edit-llama-maxout', label: 'Generation cap (-n / --predict)', value: llamacpp.maxOutputTokens, placeholder: '16384', hint: 'llama.cpp server-side default/max tokens to predict. Requests may still pass max_tokens; keep this above the reasoning budget so answers are not cut off.' }));
      bodyEl.appendChild(meshTunableSelectRow({ id: 'model-edit-llama-cache-prompt', label: 'Prompt cache', value: llamacpp.cachePrompt === false ? 'off' : 'on', options: [{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }], hint: 'Keep on for coding-session KV reuse.' }));
      bodyEl.appendChild(meshTunableNumberRow({ id: 'model-edit-llama-cache-reuse', label: 'Cache reuse', value: llamacpp.cacheReuse, placeholder: '256', min: 0, hint: 'llama.cpp --cache-reuse value for prompt/KV reuse.' }));
      bodyEl.appendChild(meshTunableSelectRow({ id: 'model-edit-llama-reasoning', label: 'Reasoning', value: reasoningValue, options: onOffOptions, hint: 'llama.cpp --reasoning for thinking-capable chat templates. Turn it off for lower latency when a thinking trace is not needed.' }));
      bodyEl.appendChild(meshTunableRowText({ id: 'model-edit-llama-reasoning-format', label: 'Reasoning format', value: reasoning.format || '', placeholder: 'deepseek', hint: 'llama.cpp --reasoning-format. Use the format expected by the model template.' }));
      bodyEl.appendChild(meshTunableNumberRow({ id: 'model-edit-llama-reasoning-budget', label: 'Reasoning budget', value: reasoning.budget, placeholder: '8192', hint: 'llama.cpp --reasoning-budget. Part of the output budget; higher values allow longer thinking and can delay the final answer.' }));
    }
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'btn btn-primary';
    save.textContent = 'Save settings';
    save.dataset.action = 'model-save';
    save.dataset.profileId = profile.id;
    save.dataset.runtime = profile.runtime || 'meshllm';
    save.dataset.out = 'model-edit-output';
    bodyEl.appendChild(save);
    // Duplicate clones this model as an inactive copy the operator edits
    // independently (REQ-RUN-017); it applies to any model, active or not.
    const duplicate = document.createElement('button');
    duplicate.type = 'button';
    duplicate.className = 'btn';
    duplicate.textContent = 'Duplicate model';
    duplicate.dataset.action = 'model-duplicate';
    duplicate.dataset.profileId = profile.id;
    duplicate.dataset.out = 'model-edit-output';
    bodyEl.appendChild(duplicate);
    // Any switched-off model can be permanently removed, including the seed-once
    // starter (REQ-RUN-012); only the active model (it owns its mesh's route) hides Delete.
    if (!profile.active) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn btn-danger';
      del.textContent = 'Delete model';
      del.dataset.action = 'model-delete';
      del.dataset.profileId = profile.id;
      del.dataset.confirm = 'Delete this model permanently?';
      del.dataset.out = 'model-edit-output';
      bodyEl.appendChild(del);
    }
    bodyEl.appendChild(output2('model-edit-output'));
    // Mesh detail lives with the model it belongs to, and the mesh card alone carries
    // it: participants, stage owners, and the machine group all live in its summary
    // and Technical details, so the drawer repeats none of them as separate fields.
    const meshEntries = lastStatus && Array.isArray(lastStatus.meshHealth) ? lastStatus.meshHealth : [];
    const meshEntry = meshEntries.find((entry) => entry.profileId === profile.id);
    if (meshEntry) {
      bodyEl.appendChild(buildMeshCard(meshEntry));
      const reset = document.createElement('button');
      reset.type = 'button';
      reset.className = 'btn btn-danger';
      reset.textContent = 'Reset sharing key';
      reset.dataset.action = 'mesh-rotate';
      reset.dataset.profileId = profile.id;
      reset.dataset.confirm = 'Reset the sharing key?';
      reset.dataset.out = 'mesh-rotate-output';
      bodyEl.appendChild(reset);
      bodyEl.appendChild(output2('mesh-rotate-output'));
    }
  }
  function output2(id) {
    const el = document.createElement('div');
    el.id = id;
    el.className = 'result';
    el.setAttribute('role', 'log');
    el.setAttribute('aria-live', 'polite');
    return el;
  }
  // Compact current-value display: neutral by default, ok only for confirmed
  // connected/provisioned state so it never looks like a warning banner.
  // Gateway cards list every ensured dynamic route (one per mesh, REQ-GWY-009); a
  // pre-mesh stored sync result without a routes array falls back to its single route.
  function gatewayRouteNames(gateway) {
    const routes = gateway && Array.isArray(gateway.routes) ? gateway.routes.map((route) => route.routeName).filter(Boolean) : [];
    return routes.length ? routes : [(gateway && gateway.routeName) || STABLE_PUBLIC_MODEL];
  }
  function routeSubLabel(names) {
    return (names.length === 1 ? 'route ' : 'routes ') + names.join(' · ');
  }
  function renderStateCard(el, parts) {
    if (!el) return;
    el.textContent = '';
    const present = Boolean(parts.value);
    const ok = parts.state === 'ok' || parts.chipTone === 'ok';
    el.classList.toggle('is-empty', !present);
    el.classList.toggle('is-ok', Boolean(present && ok));
    const label = document.createElement('span');
    label.className = 'state-label';
    label.textContent = parts.label;
    const value = document.createElement('span');
    value.className = 'state-value';
    value.textContent = present ? parts.value : (parts.placeholder || '—');
    el.append(label, value);
    if (present && parts.chip) el.appendChild(chipEl(parts.chipTone || 'ok', parts.chip));
    if (present && parts.sub) { const sub = document.createElement('span'); sub.className = 'state-sub'; sub.textContent = parts.sub; el.appendChild(sub); }
  }
  // Dropdown B options for the direct router: one option per switched-on model, sending and
  // showing the model's own callable name with the human model name in brackets — e.g.
  // mesh-smoke (Qwen2.5 Coder 1.5B).
  function playgroundModelOptions() {
    const profiles = lastStatus && Array.isArray(lastStatus.profiles) ? lastStatus.profiles : [];
    const options = [];
    profiles.filter((profile) => profile.active).forEach((profile) => {
      const callable = callName(profile);
      if (callable && !options.some((opt) => opt.value === callable)) options.push({ value: callable, label: callable + ' (' + modelName(profile) + ')' });
    });
    return options;
  }
  function setPlaygroundModelSelect(options) {
    const slot = byId(config.playground.slotId);
    if (!slot) return;
    // Preserve the operator's current choice across the periodic rebuild instead of
    // snapping back to the first option every poll (#19).
    const previous = byId(config.playground.selectId);
    const previousValue = previous ? previous.value : '';
    slot.textContent = '';
    const select = document.createElement('select');
    select.id = config.playground.selectId;
    select.name = 'playgroundModel';
    select.setAttribute('data-playground-model-select', 'true');
    options.forEach((opt) => {
      const option = document.createElement('option');
      option.value = opt.value;
      option.setAttribute('data-playground-model-option', opt.value);
      option.textContent = opt.label;
      select.appendChild(option);
    });
    select.disabled = options.length === 0;
    if (options.length) select.value = options.some((opt) => opt.value === previousValue) ? previousValue : options[0].value;
    slot.appendChild(select);
  }
  // Dropdown B is owned by the gateway target when one is selected; the periodic status poll
  // only refreshes it while the direct router is the target, so it can't clobber a route list.
  function renderPlaygroundSelect() {
    const target = byId(config.playground.targetSelectId);
    if (target && target.value && target.value !== config.playground.directValue) return;
    setPlaygroundModelSelect(playgroundModelOptions());
  }
  // Dropdown A: the direct router plus every accessible AI Gateway. Falls back to direct-only
  // when gateways cannot be listed (e.g. the read-only user role cannot call gateway options).
  async function loadPlaygroundTargets() {
    const slot = byId(config.playground.targetSlotId);
    if (!slot) return;
    let gateways = [];
    try {
      const body = await request('/admin/cloudflare/gateway/options', { headers: headers(false) });
      gateways = (body.gateways || []).map((gateway) => gateway.id);
    } catch (error) { gateways = []; }
    slot.textContent = '';
    const select = document.createElement('select');
    select.id = config.playground.targetSelectId;
    select.name = 'playgroundTarget';
    select.setAttribute('data-playground-target-select', 'true');
    const direct = document.createElement('option');
    direct.value = config.playground.directValue;
    direct.textContent = 'Codeflare Inference Router (direct)';
    select.appendChild(direct);
    gateways.forEach((id) => {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = id;
      select.appendChild(option);
    });
    select.value = config.playground.directValue;
    slot.appendChild(select);
    await updatePlaygroundModels();
  }
  // Repopulate Dropdown B when the target changes: switched-on models for the direct router,
  // or the selected gateway's dynamic routes.
  async function updatePlaygroundModels() {
    const target = byId(config.playground.targetSelectId);
    const value = target && target.value ? target.value : config.playground.directValue;
    if (value === config.playground.directValue) { setPlaygroundModelSelect(playgroundModelOptions()); return; }
    let routes = [];
    try {
      const body = await request('/admin/cloudflare/gateway/options?gateway=' + encodeURIComponent(value), { headers: headers(false) });
      routes = (body.routes || []).map((route) => route.name).filter(Boolean);
    } catch (error) { routes = []; }
    setPlaygroundModelSelect(routes.map((name) => ({ value: name, label: name })));
  }
  function modelName(profile) { return (profile.displayName && String(profile.displayName)) || profile.id; }
  // A machine serves a profile, not a model string: it must be online and activated
  // (a deactivated or offline node keeps its last adopted/ready state in its record,
  // exactly like the scheduler's eligibility gate excludes it), must have adopted the
  // profile (activeProfileIds), AND report its upstream ref ready (readyModels carries
  // upstream refs exactly as the scheduler matches on, never public aliases). Twin
  // profiles sharing one modelRef must never inherit each other's serving count.
  function nodeServesProfile(node, profile) {
    // Ready models alone are not serving: an api-client mesh-llm still advertises the
    // mesh's models while holding no stage, so a ready/running runtime or an actual
    // split-stage assignment must corroborate the claim.
    const metrics = node.metrics || {};
    const corroborated = metrics.runtimeState === 'ready' || metrics.runtimeState === 'running' || (metrics.stageCount || 0) > 0;
    return node.status === 'online' && !node.deactivated
      && Array.isArray(node.activeProfileIds) && node.activeProfileIds.indexOf(profile.id) >= 0
      && Array.isArray(metrics.readyModels) && metrics.readyModels.indexOf(profile.upstreamModel) >= 0
      && corroborated;
  }
  function nodesServingProfile(profile) {
    const nodes = lastStatus && Array.isArray(lastStatus.nodes) ? lastStatus.nodes : [];
    return nodes.filter((node) => nodeServesProfile(node, profile));
  }
  function servingCount(profile) {
    return nodesServingProfile(profile).length;
  }
  // Pill vocabulary: tone + label per variant live in this one map (content), pillEl builds
  // the DOM (structure), and the CSS tone tokens colour it (style). Both the models list and
  // the Manage drawer compose the same pills, so a vocabulary change is a single edit here.
  const PROFILE_PILLS = {
    runtime: { llamacpp: { tone: 'red', label: 'llama.cpp' }, meshllm: { tone: 'green', label: 'meshllm' } },
    mode: { split: { tone: 'orange', label: 'sharded model' }, single: { tone: 'blue', label: 'singular model' } },
    mesh: { tone: 'purple' }
  };
  function pillEl(spec, attr, value, label) {
    const pill = chipEl(spec.tone, label === undefined ? spec.label : label);
    pill.setAttribute(attr, value);
    return pill;
  }
  function profilePills(profile, direct, split) {
    const runtime = direct ? 'llamacpp' : 'meshllm';
    const mode = split ? 'split' : 'single';
    const profileMesh = profile.meshId || 'default';
    return [
      pillEl(PROFILE_PILLS.runtime[runtime], 'data-runtime', runtime),
      pillEl(PROFILE_PILLS.mode[mode], 'data-serving-mode', mode),
      pillEl(PROFILE_PILLS.mesh, 'data-profile-mesh', profileMesh, meshDisplayName(profileMesh))
    ];
  }
  function renderProfiles(profiles, readiness) {
    const list = byId('profile-list');
    if (!list) return;
    list.textContent = '';
    // Active-first (stable): models that are on surface above the ones that are off.
    const ordered = [...profiles].sort((a, b) => Number(Boolean(b.active)) - Number(Boolean(a.active)));
    ordered.forEach((profile) => {
      const row = document.createElement('div');
      row.className = 'row-item';
      row.setAttribute('data-profile-row', profile.id);
      row.appendChild(statusDot(profile.active ? 'ok' : 'warn', profile.active ? 'On' : 'Off'));
      const body = document.createElement('div');
      body.className = 'grow';
      const nameRow = document.createElement('div');
      nameRow.className = 'model-name-row';
      const name = document.createElement('strong');
      name.setAttribute('data-model-name', profile.id);
      name.textContent = modelName(profile);
      // Fixed pill vocabulary: provider (llama.cpp = red, meshllm = green), serving mode
      // (singular = blue, sharded = orange), and mesh assignment (purple). Combinations
      // read side by side — e.g. a singular model on meshllm is green + blue.
      const direct = profile.runtime === 'llamacpp';
      const split = Boolean(profile.meshllm && profile.meshllm.split);
      nameRow.append(name, ...profilePills(profile, direct, split));
      const detail = document.createElement('small');
      const ready = readiness.find((item) => item.profileId === profile.id);
      const serving = servingCount(profile);
      row.setAttribute('data-serving', String(serving));
      detail.textContent = 'Alias: ' + (callName(profile) || '—') + ' · ' + serving + ' machine' + (serving === 1 ? '' : 's') + ' serving' + (ready && ready.failed ? ' · ' + ready.failed + ' failed' : '');
      body.append(nameRow, detail);
      row.appendChild(body);
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'btn ' + (profile.active ? 'btn-ghost' : 'btn-primary');
      toggle.textContent = profile.active ? 'Turn off' : 'Deploy';
      toggle.dataset.action = 'model-toggle';
      toggle.dataset.profileId = profile.id;
      toggle.dataset.on = profile.active ? 'true' : 'false';
      row.appendChild(toggle);
      const manage = document.createElement('button');
      manage.type = 'button';
      manage.className = 'btn btn-ghost';
      manage.textContent = 'Manage';
      manage.dataset.action = 'model-detail';
      manage.dataset.profileId = profile.id;
      row.appendChild(manage);
      list.appendChild(row);
    });
  }
  // meshStatusSuffix reduces a mesh-health entry to a plain-language status suffix
  // shared by the Mesh-status rollup and the per-model mesh card. A deactivated
  // (switched-off) model is never "ready" however much stale mesh state it still
  // carries; a runtime failure or mesh error reads "needs attention".
  function meshStatusSuffix(entry) {
    if (entry.active === false) return ' · deactivated';
    if (splitReadinessBlocksMesh(entry) || entry.lastError || (entry.failedNodeIds && entry.failedNodeIds.length > 0)) return ' · needs attention';
    return entry.tokenCount > 0 ? ' · ready' : ' · forming';
  }
  // meshStatusTone maps the same entry to a status-dot tone: grey for a switched-off
  // model, danger for a failure, ok only when it is active and holds a mesh secret.
  function meshStatusTone(entry) {
    if (entry.active === false) return 'idle';
    if (splitReadinessBlocksMesh(entry) || entry.lastError || (entry.failedNodeIds && entry.failedNodeIds.length > 0)) return 'danger';
    return entry.tokenCount > 0 ? 'ok' : 'idle';
  }

  // buildMeshCard renders one model's mesh detail (a plain summary plus the raw
  // fields behind a disclosure). It lives in that model's Manage drawer, since both
  // single-machine and split models form a mesh.
  function nodeParticipatesInProfile(node, profile) {
    if (!node || !profile) return false;
    const metrics = node.metrics || {};
    if (Array.isArray(node.activeProfileIds) && node.activeProfileIds.indexOf(profile.id) >= 0) return true;
    if (metrics.loadedProfileId === profile.id) return true;
    if (node.runtimeModel && node.runtimeModel === profile.upstreamModel) return true;
    if (Array.isArray(metrics.readyModels) && metrics.readyModels.indexOf(profile.upstreamModel) >= 0) return true;
    return false;
  }
  function meshNodesForEntry(entry) {
    const nodes = lastStatus && Array.isArray(lastStatus.nodes) ? lastStatus.nodes : [];
    const profiles = lastStatus && Array.isArray(lastStatus.profiles) ? lastStatus.profiles : [];
    const profile = profiles.find((item) => item.id === entry.profileId);
    return profile ? nodes.filter((node) => nodeParticipatesInProfile(node, profile)) : nodes.filter((node) => Array.isArray(node.activeProfileIds) && node.activeProfileIds.indexOf(entry.profileId) >= 0);
  }
  function stageMapPartial(entry) {
    const stages = Array.isArray(entry.stageAssignments) ? entry.stageAssignments : [];
    if (!stages.length) return false;
    return !stages.some((stage) => Number(stage.layerStart) === 0);
  }
  function stageOwnersText(entry, candidates) {
    const stages = Array.isArray(entry.stageAssignments) ? entry.stageAssignments : [];
    if (!stages.length) return '';
    const text = stages.map((stage) => {
      const ownerNode = nodeForStage(stage, candidates);
      const owner = ownerNode ? nodeDisplayName(ownerNode) : nodeLabelForId(stage.nodeId || stage.reportedByNodeId || '', candidates);
      const layers = stage.layerStart != null && stage.layerEnd != null ? ('L' + stage.layerStart + '-' + stage.layerEnd) : ('stage ' + stage.stageIndex);
      const displayState = stageDisplayState(stage, candidates);
      const state = displayState ? ' · ' + humanizeKey(displayState) : '';
      return layers + ' → ' + owner + state;
    }).join('; ');
    return stageMapPartial(entry) ? 'Partial stage map: ' + text : text;
  }
  function stageUnavailableVersions(entry) {
    return [...new Set(meshNodesForEntry(entry).map((node) => node.agentVersion).filter(Boolean))];
  }
  function annotateStageUnavailable(element, entry) {
    const versions = stageUnavailableVersions(entry);
    element.setAttribute('data-stage-map', 'unavailable');
    if (versions.length) element.setAttribute('data-agent-versions', versions.join(','));
  }
  function stageUnavailableText(entry) {
    const versions = stageUnavailableVersions(entry);
    return 'Waiting for stage map' + (versions.length ? ' · agent ' + versions.join(', ') : '');
  }
  function buildMeshCard(entry) {
    const profilesById = lastStatus && Array.isArray(lastStatus.profiles) ? lastStatus.profiles : [];
    const card = document.createElement('div');
    card.className = 'tile';
    card.setAttribute('data-mesh-entry', entry.profileId);
    card.setAttribute('data-mesh-rotation', String(entry.rotation));
    card.setAttribute('data-secret-present', entry.tokenCount > 0 ? 'true' : 'false');
    if (entry.splitReadiness) annotateSplitReadiness(card, entry.splitReadiness);
    const profile = profilesById.find((candidate) => candidate.id === entry.profileId);
    const title = document.createElement('strong');
    title.textContent = profile ? modelName(profile) : entry.profileId;
    card.appendChild(title);
    // Plain-language summary first; the raw internals go behind a Technical details disclosure.
    const peers = (entry.peerNodeIds || []).length;
    const summary = document.createElement('span');
    summary.className = 'mesh-summary';
    summary.textContent = peers > 0
      ? (peers + ' machine' + (peers === 1 ? '' : 's') + ' in this mesh' + meshStatusSuffix(entry))
      : 'One machine in this mesh';
    card.appendChild(summary);
    if (entry.splitReadiness && (splitReadinessBlocksMesh(entry) || !splitReadinessModelSizeUnknown(entry.splitReadiness))) card.appendChild(splitReadinessBlock(entry.splitReadiness, meshNodesForEntry(entry)));
    const details = document.createElement('details');
    const detailsSummary = document.createElement('summary');
    detailsSummary.textContent = 'Technical details';
    details.appendChild(detailsSummary);
    const addField = (fieldName, label, value, annotate) => {
      if (!value) return;
      const line = document.createElement('code');
      line.setAttribute('data-mesh-field', fieldName);
      line.textContent = label + ': ' + value;
      if (annotate) annotate(line);
      details.appendChild(line);
    };
    const ownerNodes = meshNodesForEntry(entry);
    const stageText = stageOwnersText(entry, ownerNodes);
    addField('coordinator', 'Coordinator', entry.coordinatorNodeId ? nodeLabelForId(entry.coordinatorNodeId, ownerNodes) : (stageText ? 'not elected yet' : 'waiting for stage map'), !entry.coordinatorNodeId && !stageText ? (line) => annotateStageUnavailable(line, entry) : undefined);
    const meshList = lastStatus && Array.isArray(lastStatus.meshes) ? lastStatus.meshes : [];
    const meshGroup = profile ? meshList.find((mesh) => mesh.id === (profile.meshId || 'default')) : null;
    addField('mesh-group', 'Mesh', meshGroup ? (meshGroup.name || meshGroup.id) : (profile ? (profile.meshId || 'default') : ''));
    addField('peers', 'Machines', String(peers > 0 ? peers : 1));
    addField('stage-owners', 'Stage owners', stageText || stageUnavailableText(entry), stageText ? (stageMapPartial(entry) ? (line) => line.setAttribute('data-stage-map', 'partial') : undefined) : (line) => annotateStageUnavailable(line, entry));
    addField('ready-models', 'Ready model', (entry.readyModels || []).map(modelLabelForRef).join(', '));
    addField('failed-nodes', 'Needs attention', (entry.failedNodeIds || []).map((id) => nodeLabelForId(id, ownerNodes)).join(', '));
    addField('last-error', 'Last error', entry.lastError || '');
    card.appendChild(details);
    return card;
  }
  // Internal per-heartbeat bookkeeping never belongs in a human activity log.
  const AUDIT_HIDDEN = { mesh_state_stored: 1, mesh_state_cleared: 1, mesh_token_rotated: 1, mesh_token_removed: 1 };
  function auditSentence(event) {
    const target = event.target || '';
    switch (event.type) {
      case 'node_claimed': return 'Machine ' + target + ' joined';
      case 'node_unregistered': return 'Machine ' + target + ' left';
      case 'node_revoked': return 'Machine ' + target + ' removed';
      case 'node_pruned': return 'Machine ' + target + ' removed after staying offline';
      case 'node_reconfigured': return 'Machine ' + target + ' settings changed';
      case 'setup_token_created': return 'Enrollment token created';
      case 'profile_activated': return 'Model turned on';
      case 'profile_rollout': return 'Model traffic changed';
      case 'profile_configured': return 'Model settings changed';
      case 'settings_updated': return 'Settings changed';
      case 'agent_version_selected': return 'Machine software version updated';
      case 'automation_key_created': return 'API key created';
      case 'automation_key_rotated': return 'API key rotated';
      case 'automation_key_revoked': return 'API key removed';
      case 'gateway_sync': return 'AI Gateway connected';
      case 'gateway_sync_failed': return 'AI Gateway connection failed';
      case 'custom_domain_provisioned': return 'Custom domain set up' + (target ? ': ' + target : '');
      case 'access_provisioned': return 'Sign-in access enabled';
      case 'first_setup': return 'Deployment claimed';
      case 'setup_completed': return 'Setup finished';
      case 'admin_recovery_reset': return 'Admin access recovered';
      case 'break_glass_entered': return 'Break-glass access opened';
      case 'break_glass_completed': return 'Break-glass setup finished';
      default: return (event.type || 'event').replace(/_/g, ' ');
    }
  }
  function renderAudit(events) {
    const visible = (events || []).filter((event) => !AUDIT_HIDDEN[event.type]);
    // Collapse a run of the same event into one line with a count so the feed reads like a log, not a firehose.
    const collapsed = [];
    visible.forEach((event) => {
      const last = collapsed[collapsed.length - 1];
      if (last && last.event.type === event.type && last.event.target === event.target) last.count += 1;
      else collapsed.push({ event: event, count: 1 });
    });
    // The activity log lives in Settings only; the Overview stays a status surface.
    const feeds = [byId('audit-log')];
    feeds.forEach((feed, index) => {
      if (!feed) return;
      feed.textContent = '';
      const slice = index === 0 ? collapsed.slice(0, 8) : collapsed;
      if (!slice.length) {
        const empty = document.createElement('p');
        empty.className = 'empty-note';
        empty.textContent = 'Nothing has happened yet.';
        feed.appendChild(empty);
        return;
      }
      slice.forEach((row) => {
        const item = document.createElement('div');
        item.className = 'feed-item';
        item.setAttribute('data-audit-event', row.event.type || 'unknown');
        const sentence = document.createElement('span');
        sentence.textContent = auditSentence(row.event) + (row.count > 1 ? ' (\\u00d7' + row.count + ')' : '');
        const when = document.createElement('time');
        when.textContent = row.event.at ? new Date(row.event.at).toISOString().slice(0, 16).replace('T', ' ') : '';
        item.append(sentence, when);
        feed.appendChild(item);
      });
    });
  }
  function renderStatus(status) {
    applyRole(status.viewerRole || 'admin');
    const nodes = Array.isArray(status.nodes) ? status.nodes : [];
    const profiles = Array.isArray(status.profiles) ? status.profiles : [];
    const readiness = Array.isArray(status.profileReadiness) ? status.profileReadiness : [];
    const audit = Array.isArray(status.audit) ? status.audit : [];
    const meshEntries = Array.isArray(status.meshHealth) ? status.meshHealth : [];
    const meshList = Array.isArray(status.meshes) ? status.meshes : [];
    const liveToks = nodes.reduce((total, node) => total + (nodeToks(node) || 0), 0);
    const tiles = byId('overview-tiles');
    if (tiles) {
      tiles.textContent = '';
      const domain = status.customDomain || {};
      const serving = nodes.filter(nodeServingCapacity).length;
      const vramMiB = nodes.reduce((total, node) => total + nodeVramTotal(node), 0);
      // Consumption sums only live reports: an offline machine's stored record carries
      // stale used figures; its hardware still counts toward the known total.
      const vramUsedMiB = nodes.reduce((total, node) => {
        const used = node.status === 'online' ? nodeVramInfo(node).usedMiB : null;
        return total + (used == null ? 0 : used);
      }, 0);
      // How many machine groups exist, and how many have their model actually served.
      const servingMeshes = meshList.filter((mesh) => {
        const model = profiles.find((profile) => profile.active && (profile.meshId || 'default') === mesh.id);
        return Boolean(model) && nodes.some((node) => (node.meshId || 'default') === mesh.id && nodeServesProfile(node, model));
      }).length;
      tiles.appendChild(tile('Available nodes', serving + '/' + nodes.length, 'nodes'));
      tiles.appendChild(tile('VRAM', fmtVramPair(vramUsedMiB, vramMiB), 'vram'));
      // Speed tests live on the per-mesh cards; the hero carries the live fleet number.
      tiles.appendChild(tile('Live throughput', Math.round(liveToks) + ' tok/s', 'throughput'));
      tiles.appendChild(tile('Meshes', meshList.length + ' · ' + servingMeshes + ' serving', 'meshes'));
      tiles.appendChild(tile('Custom domain', domain.hostname ? domain.hostname + ' · ' + (domain.status || 'unprovisioned') : 'not configured', 'domain'));
      tiles.appendChild(tile('Agent version', status.desiredAgentVersion || 'not set', 'version'));
    }
    const pruneInput = byId('prune-seconds');
    if (pruneInput && status.offlinePruneSeconds != null && pruneInput.value === '') pruneInput.value = String(status.offlinePruneSeconds);
    syncTopoMeshSelect(meshList);
    renderTopology(topologyNodes(nodes));
    pushToksSample(liveToks);
    renderToksTrace();
    renderMeshStatus(status);
    const gatewayCurrent = byId('gateway-current');
    if (gatewayCurrent) {
      const selectedGateway = selectedGatewayValue('routing');
      if (selectedGateway) {
        refreshProvisionChip(selectedGateway).catch(() => undefined);
      } else {
        const gateway = status.gateway || {};
        renderStateCard(gatewayCurrent, {
          label: 'AI Gateway',
          value: gateway.gatewayId || '',
          placeholder: 'Not connected yet',
          sub: gateway.gatewayId ? routeSubLabel(gatewayRouteNames(gateway)) : '',
          chip: gateway.gatewayId ? 'connected' : '',
          chipTone: 'ok',
          state: gateway.gatewayId ? 'ok' : ''
        });
      }
    }
    const domainCurrent = byId('custom-domain-current');
    if (domainCurrent) {
      const domain = status.customDomain || {};
      renderStateCard(domainCurrent, {
        label: 'Custom domain',
        value: domain.hostname || '',
        placeholder: 'Not set yet',
        chip: domain.hostname ? (domain.status || 'unprovisioned') : '',
        chipTone: domain.status === 'provisioned' ? 'ok' : 'warn',
        state: domain.status === 'provisioned' ? 'ok' : ''
      });
    }
    lastStatus = status;
    renderNodesTable(nodes, status.desiredAgentVersion);
    renderProfiles(profiles, readiness);
    renderMeshList(Array.isArray(status.meshes) ? status.meshes : []);
    renderPlaygroundSelect();
    // Mesh detail now lives per-model in the Manage drawer; here we only keep the
    // global mesh-secret-missing banner (shown on the Models section) in sync.
    const meshBanner = byId(config.meshHealth.bannerId);
    if (meshBanner) meshBanner.hidden = !meshEntries.some((entry) => entry.lastError === config.meshHealth.keyMissingError);
    renderAudit(audit);
    setHealth('ok', 'live');
  }
  // Meshes card: one row per machine group with its callable route and counts;
  // only an empty non-default mesh offers Delete (REQ-ADM-037).
  // routeChipEl renders a mesh's callable route as the right-aligned endpoint chip —
  // shared by the Meshes management card and the Overview mesh status cards.
  function routeChipEl(alias) {
    const route = document.createElement('span');
    route.className = 'endpoint-chip';
    route.setAttribute('data-mesh-alias', alias || '');
    route.textContent = alias || '';
    return route;
  }
  // meshRowHead is the mesh identity header for the management card: bold group name
  // with its callable route right-aligned.
  function meshRowHead(name, alias) {
    const head = document.createElement('div');
    head.className = 'mesh-row-head';
    const title = document.createElement('strong');
    title.textContent = name || '';
    head.appendChild(title);
    head.appendChild(routeChipEl(alias));
    return head;
  }
  // Overview "Mesh status": a grid of tone-edged cards, one per machine group. Each
  // card is a mini dashboard — mesh name (purple, the mesh vocabulary color) paired
  // with its callable route (the tone edge alone carries state), the deployed model
  // over its mono file reference and provider/mode pills, a machines/serving/speed-test
  // metric strip, and a serving-capacity track. What is running, structured, at a glance.
  function renderMeshStatus(status) {
    const rollup = byId('overview-mesh');
    if (!rollup) return;
    rollup.textContent = '';
    const nodes = Array.isArray(status.nodes) ? status.nodes : [];
    const profiles = Array.isArray(status.profiles) ? status.profiles : [];
    const stat = (value, label, cls) => {
      const cell = document.createElement('div');
      cell.className = cls ? 'mesh-stat ' + cls : 'mesh-stat';
      const number = document.createElement('span');
      number.className = 'metric-value';
      number.textContent = value;
      const caption = document.createElement('span');
      caption.className = 'mesh-stat-label';
      caption.textContent = label;
      cell.append(number, caption);
      return cell;
    };
    (Array.isArray(status.meshes) ? status.meshes : []).forEach((mesh) => {
      const meshNodes = nodes.filter((node) => (node.meshId || 'default') === mesh.id);
      const model = profiles.find((profile) => profile.active && (profile.meshId || 'default') === mesh.id);
      const serving = model ? meshNodes.filter((node) => nodeServesProfile(node, model)) : [];
      const speed = speedTestFor(status, model);
      const speedPrompt = speed ? speedNumber(speed.promptTokensPerSecond) : null;
      const speedGen = speed ? speedNumber(speed.generationTokensPerSecond) : null;
      // Split-intended models get their split state read from mesh health: a formed
      // topology (2+ stages) is split serving; serving machines without one means
      // mesh-llm recovered the model on one node — degraded, surfaced, never silent.
      const health = model && Array.isArray(status.meshHealth) ? status.meshHealth.find((entry) => entry.profileId === model.id) : null;
      const stageCount = health && Array.isArray(health.stageAssignments) ? health.stageAssignments.length : 0;
      const splitIntended = Boolean(model && model.runtime !== 'llamacpp' && model.meshllm && model.meshllm.split);
      const splitState = splitIntended && serving.length > 0 ? (stageCount >= 2 ? 'split' : 'fallback') : '';
      // A mesh with no model stays neutral grey — an empty group is a choice, not an alarm.
      const word = model ? (serving.length > 0 ? 'Serving' : (meshNodes.length > 0 ? 'Preparing' : 'No machines')) : 'No model';
      const tone = model ? (serving.length > 0 ? (splitState === 'fallback' ? 'warn' : 'ok') : 'warn') : 'idle';
      // The most actionable line wins: a runtime/planner error, else the fallback
      // notice, else the split verdict while nothing serves.
      const nodeError = meshNodes.map((node) => (node.metrics && node.metrics.runtimeDetail) || '').find((detail) => detail !== '') || '';
      const verdict = health && health.splitReadiness && typeof health.splitReadiness.verdict === 'string' ? health.splitReadiness.verdict : '';
      let note = null;
      if (tone !== 'ok' && (nodeError || (health && health.lastError))) note = { kind: 'error', text: nodeError || health.lastError };
      else if (splitState === 'fallback') note = { kind: 'fallback', text: 'single-node fallback: split not formed' };
      else if (splitIntended && serving.length === 0 && verdict && verdict !== 'ready') note = { kind: 'verdict', text: verdict.replace(/_/g, ' ') };
      const card = document.createElement('article');
      card.className = 'mesh-card';
      card.setAttribute('data-mesh-status', mesh.id);
      card.setAttribute('data-machines', String(meshNodes.length));
      card.setAttribute('data-serving', String(serving.length));
      card.setAttribute('data-state', word);
      card.setAttribute('data-state-tone', tone);
      if (splitState) card.setAttribute('data-split-state', splitState);
      if (speedPrompt != null && speedGen != null) {
        card.setAttribute('data-speed-prompt', String(Math.round(speedPrompt)));
        card.setAttribute('data-speed-gen', String(Math.round(speedGen)));
      }
      const head = document.createElement('header');
      head.className = 'mesh-card-head';
      const title = document.createElement('strong');
      title.className = 'mesh-card-name';
      title.setAttribute('data-profile-mesh', mesh.id);
      title.textContent = mesh.name || mesh.id;
      head.append(title, routeChipEl(mesh.alias));
      card.appendChild(head);
      const modelRow = document.createElement('div');
      modelRow.className = 'mesh-card-model';
      if (model) {
        const name = document.createElement('strong');
        name.textContent = modelName(model);
        modelRow.appendChild(name);
        // The mesh identity is the card itself, so the model block reads name, then the
        // mono model file reference, then provider + mode as its own pill row.
        const file = document.createElement('code');
        file.className = 'mesh-card-file';
        file.textContent = profileModelRef(model);
        modelRow.appendChild(file);
        const pillRow = document.createElement('div');
        pillRow.className = 'mesh-card-pills';
        const pills = profilePills(model, model.runtime === 'llamacpp', Boolean(model.meshllm && model.meshllm.split));
        pillRow.append(pills[0], pills[1]);
        modelRow.appendChild(pillRow);
      } else {
        const none = document.createElement('small');
        none.textContent = 'no model deployed';
        modelRow.appendChild(none);
      }
      card.appendChild(modelRow);
      const stats = document.createElement('div');
      stats.className = 'mesh-card-stats';
      stats.append(
        stat(String(meshNodes.length), meshNodes.length === 1 ? 'machine' : 'machines'),
        stat(model ? String(serving.length) : '—', 'serving'),
        stat(speedPrompt != null && speedGen != null ? Math.round(speedPrompt) + ' / ' + Math.round(speedGen) : '—', 'p/g tok/s', 'mesh-stat-speed')
      );
      card.appendChild(stats);
      if (note) {
        const noteEl = document.createElement('div');
        noteEl.className = 'mesh-card-note';
        noteEl.setAttribute('data-mesh-note', note.kind);
        noteEl.textContent = note.text;
        card.appendChild(noteEl);
      }
      const track = document.createElement('div');
      track.className = 'mesh-track';
      const fill = document.createElement('div');
      fill.className = 'mesh-track-fill';
      const pct = meshNodes.length > 0 ? Math.round((serving.length / meshNodes.length) * 100) : 0;
      // Width rides the style attribute (data-fill is the tested contract): the render
      // must stay attribute-only so it cannot depend on a live CSSOM.
      fill.setAttribute('style', 'width:' + pct + '%');
      track.setAttribute('data-fill', String(pct));
      track.appendChild(fill);
      card.appendChild(track);
      rollup.appendChild(card);
    });
  }
  function renderMeshList(meshes) {
    const listEl = byId('mesh-list');
    if (!listEl) return;
    listEl.textContent = '';
    meshes.forEach((mesh) => {
      const row = document.createElement('div');
      row.className = 'command-row';
      row.setAttribute('data-mesh-row', mesh.id);
      const copy = document.createElement('div');
      copy.className = 'command-copy';
      copy.appendChild(meshRowHead(mesh.name, mesh.alias));
      const machines = mesh.machineCount || 0;
      const models = mesh.modelCount || 0;
      const counts = document.createElement('span');
      counts.className = 'mesh-counts';
      counts.setAttribute('data-mesh-machines', String(machines));
      counts.setAttribute('data-mesh-models', String(models));
      counts.textContent = machines + (machines === 1 ? ' machine' : ' machines') + ' · ' + models + (models === 1 ? ' model' : ' models');
      copy.appendChild(counts);
      row.appendChild(copy);
      const actions = document.createElement('div');
      actions.className = 'command-actions';
      if (mesh.id !== 'default' && !mesh.machineCount && !mesh.modelCount) {
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'btn btn-danger';
        del.textContent = 'Delete';
        del.dataset.action = 'mesh-delete';
        del.dataset.meshId = mesh.id;
        del.dataset.confirm = 'Delete this mesh?';
        del.dataset.out = 'mesh-output';
        actions.appendChild(del);
      }
      row.appendChild(actions);
      listEl.appendChild(row);
    });
  }
  async function refreshStatus() {
    try {
      renderStatus(await request('/admin/status', { headers: headers(false) }));
    } catch (error) {
      setHealth('error', 'unreachable');
      throw error;
    }
  }
  function renderVersions(view) {
    const slot = byId(config.agentVersion.slotId);
    if (!slot) return;
    slot.textContent = '';
    const select = document.createElement('select');
    select.id = config.agentVersion.selectId;
    select.name = 'agentVersion';
    select.setAttribute('data-agent-version-select', 'true');
    select.setAttribute('data-stale', view && view.stale ? 'true' : 'false');
    const tags = (view && view.tags) || [];
    tags.forEach((tag) => {
      const option = document.createElement('option');
      option.value = tag;
      option.setAttribute('data-agent-version-option', tag);
      if (view.desired === tag) { option.selected = true; option.setAttribute('data-desired', 'true'); }
      option.textContent = tag;
      select.appendChild(option);
    });
    select.disabled = tags.length === 0;
    select.value = view && view.desired ? view.desired : (tags[0] || '');
    slot.appendChild(select);
  }
  function renderRuntimeVersions(view) {
    const populate = (kind, selectId) => {
      const select = byId(selectId);
      if (!select) return false;
      const info = view && view[kind] ? view[kind] : { tags: [], desired: '', stale: true };
      select.textContent = '';
      select.setAttribute('data-runtime-version-select', kind);
      select.setAttribute(config.runtimeVersion.staleAttribute, info.stale ? 'true' : 'false');
      const tags = info.tags || [];
      tags.forEach((tag) => {
        const option = document.createElement('option');
        option.value = tag;
        option.setAttribute('data-runtime-version-option', kind + ':' + tag);
        if (info.desired === tag) { option.selected = true; option.setAttribute('data-desired', 'true'); }
        option.textContent = tag;
        select.appendChild(option);
      });
      if (!tags.length && info.desired) {
        const option = document.createElement('option');
        option.value = info.desired;
        option.selected = true;
        option.textContent = info.desired;
        select.appendChild(option);
      }
      select.disabled = select.children.length === 0;
      select.value = info.desired || (tags[0] || '');
      return true;
    };
    const meshReady = populate('meshllm', config.runtimeVersion.meshllmSelectId);
    const llamaReady = populate('llamacpp', config.runtimeVersion.llamacppSelectId);
    if (meshReady && llamaReady) return;
    const slot = byId(config.runtimeVersion.slotId);
    if (!slot) return;
    slot.textContent = '';
    const grid = document.createElement('div');
    grid.className = 'form-grid';
    const makeSelect = (kind, label, selectId) => {
      const wrap = document.createElement('label');
      wrap.className = 'field';
      const text = document.createElement('span');
      text.textContent = label;
      const select = document.createElement('select');
      select.id = selectId;
      select.name = kind + 'Version';
      wrap.append(text, select);
      return wrap;
    };
    grid.append(
      makeSelect('meshllm', 'MeshLLM version', config.runtimeVersion.meshllmSelectId),
      makeSelect('llamacpp', 'llama.cpp version', config.runtimeVersion.llamacppSelectId)
    );
    slot.appendChild(grid);
    populate('meshllm', config.runtimeVersion.meshllmSelectId);
    populate('llamacpp', config.runtimeVersion.llamacppSelectId);
  }
  function renderApiKeys(keys) {
    const listEl = byId('api-key-list');
    if (!listEl) return;
    listEl.textContent = '';
    if (!keys.length) {
      const empty = document.createElement('p');
      empty.className = 'empty-note';
      empty.textContent = 'No API keys yet. Create one to operate the mesh over the API.';
      listEl.appendChild(empty);
      return;
    }
    keys.forEach((key) => {
      const row = document.createElement('div');
      row.className = 'row-item';
      row.setAttribute('data-api-key-row', key.id);
      const grow = document.createElement('div');
      grow.className = 'grow';
      const id = document.createElement('code');
      id.textContent = key.id;
      const when = document.createElement('time');
      when.textContent = key.createdAt ? new Date(key.createdAt).toISOString().slice(0, 16).replace('T', ' ') : '';
      grow.append(id, when);
      const rotate = document.createElement('button');
      rotate.type = 'button';
      rotate.className = 'btn btn-ghost';
      rotate.textContent = 'Rotate';
      rotate.dataset.action = 'api-key-rotate';
      rotate.dataset.keyId = key.id;
      rotate.dataset.out = 'api-key-output';
      const revoke = document.createElement('button');
      revoke.type = 'button';
      revoke.className = 'btn btn-danger';
      revoke.textContent = 'Revoke';
      revoke.dataset.action = 'api-key-revoke';
      revoke.dataset.keyId = key.id;
      revoke.dataset.out = 'api-key-output';
      revoke.dataset.confirm = 'Revoke this API key? It stops working immediately.';
      row.append(grow, rotate, revoke);
      listEl.appendChild(row);
    });
  }
  async function loadApiKeys() {
    if (!byId('api-key-list')) return;
    const view = await request('/api/v1/keys', { headers: headers(false) });
    renderApiKeys(Array.isArray(view.keys) ? view.keys : []);
  }
  // Reveal a freshly minted or rotated secret exactly once — it can never be read back.
  function revealApiKey(body) {
    setOutput('api-key-output', (body && body.token) || '');
    toast('API key ready. Copy it now, it is shown only once');
  }
  async function loadVersions() {
    const view = await request('/admin/agent-versions', { headers: headers(false) });
    renderVersions(view);
    setOutput('agent-version-output', 'Loaded ' + ((view.tags || []).length) + ' versions' + (view.stale ? ' (list may be out of date)' : ''));
    return view;
  }
  async function loadRuntimeVersions() {
    const view = await request('/admin/runtime-versions', { headers: headers(false) });
    renderRuntimeVersions(view);
    const meshCount = view && view.meshllm && view.meshllm.tags ? view.meshllm.tags.length : 0;
    const llamaCount = view && view.llamacpp && view.llamacpp.tags ? view.llamacpp.tags.length : 0;
    const stale = (view && view.meshllm && view.meshllm.stale) || (view && view.llamacpp && view.llamacpp.stale);
    setOutput('runtime-version-output', 'Loaded ' + meshCount + ' MeshLLM and ' + llamaCount + ' llama.cpp versions' + (stale ? ' (list may be out of date)' : ''));
    return view;
  }
  async function loadInstaller(prefix) {
    const select = byId(prefix + 'installer-platform');
    if (!select) return;
    const platform = select.value;
    const raw = await request('/admin/installers/' + platform, { headers: headers(false) });
    // Fill the operator's minted token over the placeholder; unminted, the command shows the placeholder.
    const command = mintedSetupToken ? raw.split(config.installer.tokenPlaceholder).join(mintedSetupToken) : raw;
    if (select.value === platform) setOutput(prefix + 'installer-output', command);
  }
  const gatewayPayload = (prefix) => {
    if (prefix === 'wiz-') return discoveryGatewayPayload(gatewayScopeIds('wizard'));
    return discoveryGatewayPayload(gatewayScopeIds('routing'));
  };

  // --- wizard data loaders ----------------------------------------------------
  let accessIdents = { admin: [], user: [] };
  const isGroupIdent = (value) => value.indexOf('@') < 0;
  const looksLikeEmail = (value) => {
    const at = value.indexOf('@');
    if (at <= 0 || at !== value.lastIndexOf('@')) return false;
    const dot = value.indexOf('.', at + 1);
    return dot > at + 1 && dot < value.length - 1;
  };
  function renderIdentChips(kind) {
    const list = byId('wizard-' + kind + '-idents');
    if (!list) return;
    list.textContent = '';
    accessIdents[kind].forEach((ident) => {
      const item = document.createElement('li');
      item.className = 'email-chip';
      item.setAttribute('data-ident-chip', ident);
      item.setAttribute('data-ident-kind', kind);
      const text = document.createElement('span');
      text.textContent = ident + (isGroupIdent(ident) ? ' (group)' : '');
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn btn-ghost';
      remove.textContent = 'Remove';
      remove.setAttribute('data-remove-ident', ident);
      remove.setAttribute('data-remove-kind', kind);
      item.append(text, remove);
      list.appendChild(item);
    });
  }
  async function loadZones() {
    const slot = byId('wizard-zone-slot');
    if (!slot) return;
    let zones = [];
    try {
      const body = await request('/admin/cloudflare/zones', { headers: headers(false) });
      zones = Array.isArray(body.zones) ? body.zones : [];
    } catch (error) { zones = []; }
    slot.textContent = '';
    const select = document.createElement('select');
    select.id = 'wizard-domain-zone';
    select.name = 'zoneId';
    select.setAttribute('data-zone-select', 'true');
    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = 'Auto-detect from hostname';
    select.appendChild(auto);
    zones.forEach((zone) => {
      const option = document.createElement('option');
      option.value = zone.id;
      option.setAttribute('data-zone-option', zone.id);
      option.textContent = zone.name;
      select.appendChild(option);
    });
    slot.appendChild(select);
  }
  function fillChoiceSelect(slotId, selectId, name, marker, values, selectedValue, createLabel) {
    const slot = byId(slotId);
    if (!slot) return;
    slot.textContent = '';
    const select = document.createElement('select');
    select.id = selectId;
    select.name = name;
    select.setAttribute(marker, 'true');
    values.forEach((value) => {
      const option = document.createElement('option');
      option.value = value;
      option.setAttribute('data-choice-option', value);
      if (value === selectedValue) option.selected = true;
      option.textContent = value;
      select.appendChild(option);
    });
    const createNew = document.createElement('option');
    createNew.value = '__new__';
    createNew.setAttribute('data-choice-option', '__new__');
    createNew.textContent = createLabel;
    if (selectedValue === '__new__') createNew.selected = true;
    select.appendChild(createNew);
    select.value = selectedValue;
    slot.appendChild(select);
  }
  const toggleNewField = (wrapId, show) => { const wrap = byId(wrapId); if (wrap) wrap.hidden = !show; };
  // The wizard and the Routing section share one gateway-discovery flow; the scope
  // selects which set of element ids to populate so the two never collide.
  function gatewayScopeIds(scope) {
    if (scope === 'routing') return { empty: 'rt-gateway-empty', selects: 'rt-gateway-selects', gwSlot: 'rt-gateway-slot', gwSelect: 'rt-gateway-select', gwNew: 'rt-gateway-new-wrap', providerName: 'rt-gateway-provider-name' };
    return { empty: 'wizard-gateway-empty', selects: 'wizard-gateway-selects', gwSlot: 'wiz-gateway-slot', gwSelect: 'wiz-gateway-select', gwNew: 'wiz-gateway-new-wrap', providerName: 'wiz-gateway-provider-name' };
  }
  function selectedGatewayValue(scope) {
    const select = byId(gatewayScopeIds(scope).gwSelect);
    return select && select.value ? select.value : '';
  }
  async function loadGatewayOptions(gatewayId, scope) {
    const ids = gatewayScopeIds(scope);
    const emptyPanel = byId(ids.empty);
    const selects = byId(ids.selects);
    if (!emptyPanel || !selects) return;
    const currentGateway = selectedGatewayValue(scope);
    const body = await request('/admin/cloudflare/gateway/options' + (gatewayId ? '?gateway=' + encodeURIComponent(gatewayId) : ''), { headers: headers(false) });
    const gateways = (body.gateways || []).map((gateway) => gateway.id);
    const defaults = body.defaults || {};
    emptyPanel.hidden = gateways.length > 0;
    selects.hidden = gateways.length === 0;
    if (!gateways.length) { if (scope === 'routing') refreshProvisionChip('').catch(() => undefined); return; }
    const wantedGateway = gatewayId || currentGateway || defaults.gatewayId;
    const gatewayValue = gateways.indexOf(wantedGateway) >= 0 ? wantedGateway : '__new__';
    fillChoiceSelect(ids.gwSlot, ids.gwSelect, 'gatewayId', 'data-gateway-select', gateways, gatewayValue, 'Create new gateway\u2026');
    toggleNewField(ids.gwNew, gatewayValue === '__new__');
    if (scope === 'routing') refreshProvisionChip(gatewayValue).catch(() => undefined);
  }
  // The Routing card reflects the *selected* gateway's live provisioning (mesh route +
  // canonical provider), verified server-side. Route status belongs in that card, not
  // as a dangling chip above the action button.
  async function refreshProvisionChip(gatewayId) {
    const card = byId('gateway-current');
    const target = gatewayId && gatewayId !== '__new__' ? gatewayId : '';
    if (!card) return;
    if (!target) {
      renderStateCard(card, { label: 'AI Gateway', value: '', placeholder: 'Not connected yet', state: 'empty' });
      return;
    }
    try {
      const status = await request('/admin/cloudflare/gateway/provision-status?gateway=' + encodeURIComponent(target), { headers: headers(false) });
      renderStateCard(card, {
        label: 'AI Gateway',
        value: target,
        placeholder: 'Not connected yet',
        sub: status.provisioned ? routeSubLabel(gatewayRouteNames({ routes: lastStatus && lastStatus.gateway && lastStatus.gateway.routes, routeName: status.routeName })) : 'route not provisioned',
        chip: status.provisioned ? 'connected' : 'needs provisioning',
        chipTone: status.provisioned ? 'ok' : 'warn',
        state: status.provisioned ? 'ok' : 'empty'
      });
    } catch (error) {
      renderStateCard(card, { label: 'AI Gateway', value: target, placeholder: 'Not connected yet', sub: 'route status unavailable', chip: 'check failed', chipTone: 'warn', state: 'empty' });
    }
  }
  // Read the chosen (or newly named) gateway and the provider name from a
  // discovery scope's ids. The account id, worker url, route, and public model
  // are resolved server-side from the runtime token and Worker env.
  const discoveryGatewayPayload = (ids) => {
    const gatewaySelect = byId(ids.gwSelect);
    const gatewayId = gatewaySelect && gatewaySelect.value && gatewaySelect.value !== '__new__' ? gatewaySelect.value : readInput(ids.gwNew.replace('-new-wrap', '-new'));
    const providerName = ids.providerName ? readInput(ids.providerName) : '';
    const raw = { gatewayId, providerName };
    return Object.fromEntries(Object.entries(raw).filter((pair) => pair[1]));
  };

  // --- login ----------------------------------------------------------------
  async function signIn(rawToken, remember) {
    const candidate = rawToken.trim();
    liveToken = candidate;
    try {
      await request('/admin/login', { method: 'POST', headers: headers(false) });
    } catch (error) {
      liveToken = savedToken();
      throw error;
    }
    storeToken(candidate, remember);
    setOutput('login-output', 'Signed in');
    if (state.phase === 'complete') showDashboard(); else { setView('setup'); setWizardStep(phaseStep()); }
  }
  const signOut = () => {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = undefined; }
    storeToken('', false);
    liveToken = '';
    setView('setup');
    setWizardStep('connect');
    setOutput('login-output', 'Signed out. The token was removed from this browser.');
    toast('Signed out');
  };

  // --- destructive-action arming ---------------------------------------------
  const disarm = (button) => {
    if (!button || button.dataset.armed !== 'true') return;
    delete button.dataset.armed;
    button.classList.remove('is-armed');
    if (button.dataset.label) button.textContent = button.dataset.label;
    if (armedButton === button) armedButton = undefined;
  };
  const armOrProceed = (button) => {
    if (!button.dataset.confirm) return true;
    if (button.dataset.armed === 'true') { disarm(button); return true; }
    if (armedButton && armedButton !== button) disarm(armedButton);
    button.dataset.label = button.textContent;
    button.dataset.armed = 'true';
    button.classList.add('is-armed');
    button.textContent = button.dataset.confirm;
    armedButton = button;
    if (disarmTimer) clearTimeout(disarmTimer);
    disarmTimer = setTimeout(() => disarm(button), config.confirm.disarmMs);
    return false;
  };

  // --- actions ----------------------------------------------------------------
  const defaultOut = {
    'first-run-setup': 'setup-output',
    'setup-domain': 'wizard-domain-output',
    'setup-access': 'wizard-access-output',
    'setup-complete': 'wizard-complete-output',
    'access-ident-add': 'wizard-access-output',
    'gateway-provision-default': 'wiz-gateway-output',
    'status-refresh': 'overview-tiles',
    'setup-token-create': 'setup-token-output',
    'gateway-sync': 'gateway-output',
    'custom-domain-validate': 'domain-output',
    'node-revoke': 'node-output',
    'node-reload': 'node-output',
    'node-deactivate': 'node-output',
    'node-activate': 'node-output',
    'model-toggle': 'models-output',
    'model-save': 'model-edit-output',
    'model-duplicate': 'model-edit-output',
    'model-delete': 'model-edit-output',
    'model-add': 'model-add-output',
    'mesh-create': 'mesh-output',
    'mesh-delete': 'mesh-output',
    'agent-versions-refresh': 'agent-version-output',
    'agent-version-set': 'agent-version-output',
    'runtime-versions-refresh': 'runtime-version-output',
    'runtime-versions-set': 'runtime-version-output',
    'settings-save': 'settings-output',
    'mesh-rotate': 'mesh-rotate-output',
    'playground-send': 'playground-output',
    'playground-speed-test': 'playground-speed-output'
  };
  async function runAction(action, button) {
    const prefix = button.dataset.prefix || '';
    const out = button.dataset.out || defaultOut[action] || '';
    if (action === 'first-run-setup') {
      const body = await request('/admin/setup', { method: 'POST' });
      liveToken = body.adminToken || '';
      storeToken(liveToken, false);
      revealKey(out, 'Setup access token', liveToken, 'Save this. It is how you sign back into setup on this page until Access is live. Stored hashed and shown only once.');
      const next = byId('wizard-continue-connect');
      if (next) next.hidden = false;
      toast('Deployment claimed');
    } else if (action === 'access-ident-add') {
      const kind = button.dataset.identList === 'user' ? 'user' : 'admin';
      const input = byId(button.dataset.identInput || '');
      const raw = input && input.value ? input.value.trim() : '';
      const ident = isGroupIdent(raw) ? raw : raw.toLowerCase();
      if (!ident || (!isGroupIdent(ident) && !looksLikeEmail(ident))) { setOutput('wizard-access-output', 'Enter an email address or an Access group name.', true); return; }
      if (accessIdents[kind].indexOf(ident) < 0) accessIdents[kind].push(ident);
      if (input) input.value = '';
      setOutput('wizard-access-output', '');
      renderIdentChips(kind);
    } else if (action === 'setup-domain') {
      const zoneSelect = byId('wizard-domain-zone');
      const body = await request('/admin/setup/domain', { method: 'POST', headers: headers(true), body: JSON.stringify({ hostname: readInput('wizard-domain-hostname'), zoneId: zoneSelect && zoneSelect.value ? zoneSelect.value : '' }) });
      setOutput(out, body);
      toast('Custom domain provisioned');
      setWizardStep('access');
    } else if (action === 'setup-access') {
      const split = (list) => ({ emails: list.filter((value) => !isGroupIdent(value)), groups: list.filter(isGroupIdent) });
      const admins = split(accessIdents.admin);
      const users = split(accessIdents.user);
      const body = await request('/admin/setup/access', { method: 'POST', headers: headers(true), body: JSON.stringify({ adminEmails: admins.emails, adminGroups: admins.groups, userEmails: users.emails, userGroups: users.groups }) });
      // Show a clean confirmation card (the handoff panel), never the raw JSON response.
      setOutput(out, '');
      const link = byId('wizard-handoff-link');
      if (link && body.consoleUrl) {
        link.setAttribute('href', body.consoleUrl);
        // Name the destination so it reads as a login button, not a generic link.
        try { link.textContent = 'Open the console on ' + new URL(body.consoleUrl).host; } catch (error) { void error; }
      }
      const handoff = byId('wizard-handoff');
      if (handoff) handoff.hidden = false;
      if (onCustomDomain) setWizardStep('gateway');
      toast('Access enabled');
    } else if (action === 'setup-complete') {
      const body = await request('/admin/setup/complete', { method: 'POST', headers: headers(false) });
      if (onCustomDomain || !body.customDomain) {
        setOutput(out, body);
        showDashboard();
        toast('Setup complete');
      } else {
        setOutput(out, 'Setup complete. This bootstrap origin is now locked; continue at https://' + body.customDomain + '/admin');
      }
    } else if (action === 'gateway-provision-default') {
      revealGatewayKey(out, await request('/admin/cloudflare/gateway/sync', { method: 'POST', headers: headers(true), body: JSON.stringify({}) }));
      await loadGatewayOptions('', out === 'gateway-output' ? 'routing' : 'wizard').catch(() => undefined);
    } else if (action === 'nodes-sort') {
      const key = button.dataset.sort || 'id';
      nodeSort = { key: key, dir: nodeSort.key === key ? -nodeSort.dir : -1 };
      if (lastStatus) renderNodesTable(Array.isArray(lastStatus.nodes) ? lastStatus.nodes : [], lastStatus.desiredAgentVersion);
    } else if (action === 'nodes-filter') {
      nodeFilter = button.dataset.filter || 'all';
      ['all', 'ready', 'active', 'offline'].forEach((name) => {
        const chip = byId('node-filter-' + name);
        if (!chip) return;
        if (name === nodeFilter) chip.setAttribute('aria-current', 'page'); else chip.removeAttribute('aria-current');
      });
      if (lastStatus) renderNodesTable(Array.isArray(lastStatus.nodes) ? lastStatus.nodes : [], lastStatus.desiredAgentVersion);
    } else if (action === 'node-detail') {
      openNodeDrawer(button.dataset.nodeId || '');
    } else if (action === 'model-detail') {
      openModelDrawer(button.dataset.profileId || '');
    } else if (action === config.drawer.closeAction) {
      closeDrawer();
    } else if (action === 'sign-out') {
      signOut();
    } else if (action === 'status-refresh') {
      await refreshStatus();
      toast('Status refreshed');
    } else if (action === 'setup-token-create') {
      const minted = await request('/admin/setup-tokens', { method: 'POST', headers: headers(false) });
      mintedSetupToken = minted.setupToken;
      renderTokens(out, minted);
      // One token per enrollment: fill the just-minted token into the displayed install command.
      await loadInstaller(prefix);
    } else if (action === 'gateway-sync') {
      revealGatewayKey(out, await request('/admin/cloudflare/gateway/sync', { method: 'POST', headers: headers(true), body: JSON.stringify(gatewayPayload(prefix)) }));
      // Refresh the selected gateway card only; a brand-new gateway (select still on
      // create-new) makes no extra call and updates on the next routing view.
      const rtSelect = byId('rt-gateway-select');
      await refreshProvisionChip(rtSelect ? rtSelect.value : '').catch(() => undefined);
    } else if (action === 'custom-domain-validate') {
      // Hostname only; the owning zone is matched server-side from the runtime token.
      await request('/admin/custom-domain/validate', { method: 'POST', headers: headers(true), body: JSON.stringify({ hostname: readInput('custom-domain') }) });
      setOutput(out, 'Domain provisioning requested.');
    } else if (action === 'node-revoke') {
      const nodeId = encodeURIComponent(button.dataset.nodeId || '');
      await request('/admin/nodes/' + nodeId + '/revoke', { method: 'POST', headers: headers(false) });
      setOutput(out, 'Machine revoked.');
      await refreshStatus().catch(() => undefined);
    } else if (action === 'node-reload') {
      const nodeId = encodeURIComponent(button.dataset.nodeId || '');
      await request('/admin/nodes/' + nodeId + '/reload', { method: 'POST', headers: headers(false) });
      setOutput(out, 'Force reload requested.');
      await refreshStatus().catch(() => undefined);
    } else if (action === 'node-deactivate' || action === 'node-activate') {
      const nodeId = encodeURIComponent(button.dataset.nodeId || '');
      const verb = action === 'node-deactivate' ? 'deactivate' : 'activate';
      await request('/admin/nodes/' + nodeId + '/' + verb, { method: 'POST', headers: headers(false) });
      setOutput(out, action === 'node-activate' ? 'Machine activated.' : 'Machine deactivated.');
      await refreshStatus().catch(() => undefined);
    } else if (action === 'node-config-save') {
      const nodeId = encodeURIComponent(button.dataset.nodeId || '');
      const raw = readInput('node-edit-vram');
      // Blank clears the override (revert to the model default); a number caps just this node.
      const payload = { displayName: readInput('node-edit-name'), maxVramGbOverride: raw === '' ? null : Number(raw) };
      // Send the mesh only when the operator actually changed it, so saving an
      // unrelated setting never re-triggers a mesh reassignment.
      const meshEl = byId('node-edit-mesh');
      if (meshEl && meshEl.value && meshEl.value !== meshEl.dataset.original) payload.meshId = meshEl.value;
      await request('/admin/nodes/' + nodeId + '/config', { method: 'POST', headers: headers(true), body: JSON.stringify(payload) });
      setOutput(out, 'Machine settings saved.');
      toast('Machine settings saved');
      await refreshStatus().catch(() => undefined);
    } else if (action === 'model-toggle') {
      const id = button.dataset.profileId || '';
      const isOn = button.dataset.on === 'true';
      // Turning a model on = activate it (the router switches off any other model that
      // answers to the same name); turning it off = drop its traffic to zero.
      const result = isOn
        ? await request('/admin/profiles/rollout', { method: 'POST', headers: headers(true), body: JSON.stringify({ profileId: id, rolloutPercent: 0 }) })
        : await request('/admin/profiles/activate', { method: 'POST', headers: headers(true), body: JSON.stringify({ profileId: id }) });
      setOutput(out, result);
      toast(isOn ? 'Model turned off' : 'Model turned on');
      await refreshStatus().catch(() => undefined);
    } else if (action === 'model-save') {
      const id = button.dataset.profileId || '';
      const ctxRaw = readInput('model-edit-context');
      const modelRaw = readInput('model-edit-model');
      const vramRaw = readInput('model-edit-vram');
      const nameEl = byId('model-edit-name');
      const callEl = byId('model-edit-callname');
      const runtime = button.dataset.runtime || 'meshllm';
      const payload = { profileId: id, runtime: runtime };
      // Mesh reassignment rides the same save, sent only when actually changed.
      const modelMeshEl = byId('model-edit-mesh');
      if (modelMeshEl && modelMeshEl.value && modelMeshEl.value !== modelMeshEl.dataset.original) payload.meshId = modelMeshEl.value;
      // Blank = Auto for both runtimes: 0 lets mesh-llm auto-plan and renders
      // --ctx-size 0 for llama.cpp (the model's native context).
      payload.contextWindow = ctxRaw === '' ? 0 : Number(ctxRaw);
      if (modelRaw !== '') payload.modelRef = modelRaw;
      // Empty means "leave as-is"; 0 explicitly clears the mesh-llm cap. Direct llama.cpp
      // does not use this mesh-only VRAM budget.
      if (runtime !== 'llamacpp' && vramRaw !== '') payload.maxVramGb = Number(vramRaw);
      // Only send name / call name when the operator actually changed them, so saving
      // an unrelated setting never rewrites a default model's extra canonical aliases.
      if (nameEl && nameEl.value.trim() && nameEl.value !== nameEl.dataset.original) payload.name = nameEl.value.trim();
      if (callEl && callEl.value.trim() && callEl.value !== callEl.dataset.original) payload.callName = callEl.value.trim();
      if (runtime === 'llamacpp') {
        const llamaParallelRaw = readInput('model-edit-llama-parallel');
        const llamaCacheReuseRaw = readInput('model-edit-llama-cache-reuse');
        const llamaCachePromptRaw = readInput('model-edit-llama-cache-prompt');
        const llamaBatchRaw = readInput('model-edit-llama-batch');
        const llamaUbatchRaw = readInput('model-edit-llama-ubatch');
        const llamaMaxOutRaw = readInput('model-edit-llama-maxout');
        const llamaGpuLayersRaw = readInput('model-edit-llama-gpu-layers');
        const llamaFlashRaw = readInput('model-edit-llama-flash');
        const llamaReasoningRaw = readInput('model-edit-llama-reasoning');
        payload.llamacpp = {
          parallel: llamaParallelRaw === '' ? -1 : Number(llamaParallelRaw),
          kvUnified: readInput('model-edit-llama-kv-unified') !== 'off',
          cacheReuse: llamaCacheReuseRaw === '' ? 256 : Number(llamaCacheReuseRaw),
          cachePrompt: llamaCachePromptRaw !== 'off',
          cacheTypeK: readInput('model-edit-llama-cache-k'),
          cacheTypeV: readInput('model-edit-llama-cache-v'),
          batch: llamaBatchRaw === '' ? null : Number(llamaBatchRaw),
          ubatch: llamaUbatchRaw === '' ? null : Number(llamaUbatchRaw),
          flashAttn: llamaFlashRaw === '' ? null : llamaFlashRaw === 'on',
          maxOutputTokens: llamaMaxOutRaw === '' ? null : Number(llamaMaxOutRaw),
          gpuLayers: llamaGpuLayersRaw === '' ? null : llamaGpuLayersRaw
        };
        if (llamaReasoningRaw === '') {
          payload.llamacpp.reasoning = null;
        } else {
          const formatRaw = readInput('model-edit-llama-reasoning-format');
          const budgetRaw = readInput('model-edit-llama-reasoning-budget');
          payload.llamacpp.reasoning = { enabled: llamaReasoningRaw === 'on', format: formatRaw === '' ? null : formatRaw, budget: budgetRaw === '' ? null : Number(budgetRaw) };
        }
      } else {
        // Runtime tunables are sent from the current field state (the server merge is
        // idempotent). A blank number or the Auto option clears the field back to Auto
        // (null / '') so mesh-llm auto-plans it, rather than pinning a stale value.
        const parRaw = readInput('model-edit-parallel');
        payload.parallel = parRaw === '' ? null : Number(parRaw);
        payload.cacheTypeK = readInput('model-edit-cache-k');
        payload.cacheTypeV = readInput('model-edit-cache-v');
        const batchRaw = readInput('model-edit-batch');
        payload.batch = batchRaw === '' ? null : Number(batchRaw);
        const ubatchRaw = readInput('model-edit-ubatch');
        payload.ubatch = ubatchRaw === '' ? null : Number(ubatchRaw);
        const flashRaw = readInput('model-edit-flash');
        payload.flashAttn = flashRaw === '' ? null : flashRaw === 'on';
        const maxOutRaw = readInput('model-edit-maxout');
        payload.maxOutputTokens = maxOutRaw === '' ? null : Number(maxOutRaw);
        const reasoningRaw = readInput('model-edit-reasoning');
        if (reasoningRaw === '') {
          payload.reasoning = null;
        } else {
          const fmtRaw = readInput('model-edit-reasoning-format');
          const budgetRaw = readInput('model-edit-reasoning-budget');
          // Blank sub-fields send null (clear to Auto), matching the blank = Auto affordance
          // the other tunables use; a set value is sent verbatim.
          payload.reasoning = { enabled: reasoningRaw === 'on', format: fmtRaw === '' ? null : fmtRaw, budget: budgetRaw === '' ? null : Number(budgetRaw) };
        }
        payload.toolEmulation = readInput('model-edit-tool-emulation') === 'emulated' ? true : null;
      }
      await request('/admin/profiles/config', { method: 'POST', headers: headers(true), body: JSON.stringify(payload) });
      setOutput(out, 'Model settings saved.');
      toast('Model settings saved');
      await refreshStatus().catch(() => undefined);
    } else if (action === 'model-duplicate') {
      const id = button.dataset.profileId || '';
      await request('/admin/profiles/duplicate', { method: 'POST', headers: headers(true), body: JSON.stringify({ profileId: id }) });
      setOutput(out, 'Model duplicated.');
      closeDrawer();
      await refreshStatus().catch(() => undefined);
      toast('Model duplicated');
    } else if (action === 'model-delete') {
      const id = button.dataset.profileId || '';
      await request('/admin/profiles/delete', { method: 'POST', headers: headers(true), body: JSON.stringify({ profileId: id }) });
      setOutput(out, 'Model deleted.');
      closeDrawer();
      await refreshStatus().catch(() => undefined);
      toast('Model deleted');
    } else if (action === 'mesh-create') {
      const nameEl = byId('mesh-create-name');
      const name = nameEl ? nameEl.value.trim() : '';
      await request('/admin/meshes', { method: 'POST', headers: headers(true), body: JSON.stringify({ name: name }) });
      if (nameEl) nameEl.value = '';
      const meshDisclosure = byId('mesh-add-details');
      if (meshDisclosure) meshDisclosure.open = false;
      setOutput(out, 'Mesh created.');
      toast('Mesh created');
      await refreshStatus().catch(() => undefined);
    } else if (action === 'mesh-delete') {
      const meshId = encodeURIComponent(button.dataset.meshId || '');
      await request('/admin/meshes/' + meshId, { method: 'DELETE', headers: headers(false) });
      setOutput(out, 'Mesh deleted.');
      toast('Mesh deleted');
      await refreshStatus().catch(() => undefined);
    } else if (action === 'api-key-create') {
      revealApiKey(await request('/api/v1/keys', { method: 'POST', headers: headers(true), body: JSON.stringify({}) }));
      await loadApiKeys().catch(() => undefined);
    } else if (action === 'api-key-rotate') {
      const keyId = encodeURIComponent(button.dataset.keyId || '');
      revealApiKey(await request('/api/v1/keys/' + keyId + '/rotate', { method: 'POST', headers: headers(true), body: JSON.stringify({}) }));
      await loadApiKeys().catch(() => undefined);
    } else if (action === 'api-key-revoke') {
      const keyId = encodeURIComponent(button.dataset.keyId || '');
      await request('/api/v1/keys/' + keyId, { method: 'DELETE', headers: headers(false) });
      toast('API key revoked');
      await loadApiKeys().catch(() => undefined);
    } else if (action === 'agent-versions-refresh') {
      await loadVersions();
    } else if (action === 'agent-version-set') {
      const select = byId(config.agentVersion.selectId);
      await request('/admin/agent-version', { method: 'POST', headers: headers(true), body: JSON.stringify({ version: select ? select.value : '' }) });
      setOutput(out, 'Agent version saved.');
    } else if (action === 'runtime-versions-refresh') {
      await loadRuntimeVersions();
    } else if (action === 'runtime-versions-set') {
      const meshllm = byId(config.runtimeVersion.meshllmSelectId);
      const llamacpp = byId(config.runtimeVersion.llamacppSelectId);
      await request('/admin/runtime-versions', { method: 'POST', headers: headers(true), body: JSON.stringify({ meshllm: meshllm ? meshllm.value : '', llamacpp: llamacpp ? llamacpp.value : '' }) });
      setOutput(out, 'Runtime versions saved.');
    } else if (action === 'settings-save') {
      await request('/admin/settings', { method: 'POST', headers: headers(true), body: JSON.stringify({ offlinePruneSeconds: Number(readInput('prune-seconds')) }) });
      setOutput(out, 'Settings saved.');
      toast('Settings saved');
    } else if (action === 'mesh-rotate') {
      // The reset control lives in a model's Manage drawer and carries its profile id.
      const profileId = button.dataset.profileId || '';
      await request('/admin/mesh/rotate', { method: 'POST', headers: headers(true), body: JSON.stringify({ profileId }) });
      setOutput(out, 'Sharing key reset.');
      await refreshStatus().catch(() => undefined);
    } else if (action === 'model-add') {
      const ref = readInput('model-add-ref');
      if (!ref) { setOutput(out, 'Enter a model reference to add.', true); return; }
      const modeSelect = byId('model-add-mode');
      const runtimeSelect = byId('model-add-runtime');
      const name = readInput('model-add-name');
      const mode = modeSelect ? modeSelect.value : 'single';
      const runtime = mode === 'split' ? 'meshllm' : (runtimeSelect && runtimeSelect.value ? runtimeSelect.value : 'meshllm');
      const payload = { modelRef: ref, mode: mode, runtime: runtime };
      if (name) payload.name = name;
      await request('/admin/profiles/add', { method: 'POST', headers: headers(true), body: JSON.stringify(payload) });
      setOutput(out, 'Model added.');
      await refreshStatus().catch(() => undefined);
      toast('Model added');
    } else if (action === config.playground.speedAction) {
      const target = byId(config.playground.targetSelectId);
      const targetValue = target && target.value ? target.value : config.playground.directValue;
      const select = byId(config.playground.selectId);
      const model = targetValue === config.playground.directValue && select && select.value ? select.value : STABLE_PUBLIC_MODEL;
      setOutput(out, 'Running speed test...');
      setOutput(out, await request(config.playground.speedPath, { method: 'POST', headers: headers(true), body: JSON.stringify({ model }) }));
      await refreshStatus().catch(() => undefined);
    } else if (action === config.playground.sendAction) {
      const target = byId(config.playground.targetSelectId);
      const targetValue = target && target.value ? target.value : config.playground.directValue;
      const select = byId(config.playground.selectId);
      const choice = select ? select.value : '';
      const prompt = readInput(config.playground.promptId);
      if (!prompt) { setOutput(out, 'Enter a prompt to send.', true); return; }
      // Optional tools JSON reproduces an agentic (tool-calling) request on the real route.
      let tools;
      const toolsRaw = readInput(config.playground.toolsId);
      if (toolsRaw) {
        try {
          const parsedTools = JSON.parse(toolsRaw);
          if (Array.isArray(parsedTools) && parsedTools.length) tools = parsedTools;
          else { setOutput(out, 'Tools must be a non-empty JSON array.', true); return; }
        } catch (toolsError) { setOutput(out, 'Tools is not valid JSON.', true); return; }
      }
      const maxRaw = readInput(config.playground.maxTokensId);
      const maxTokens = maxRaw === '' ? undefined : Number(maxRaw);
      const messages = [{ role: 'user', content: prompt }];
      // Direct target -> router scheduler with an internal model; gateway target -> that gateway's
      // compat endpoint with the selected dynamic route.
      const direct = targetValue === config.playground.directValue;
      const path = direct ? config.playground.directPath : config.playground.gatewayPath;
      const payload = direct ? { model: choice, messages: messages, user: playgroundSessionUser() } : { gatewayId: targetValue, route: choice, messages: messages, user: playgroundSessionUser() };
      if (tools) payload.tools = tools;
      if (maxTokens) payload.maxTokens = maxTokens;
      // The Stop button aborts this controller; a new send supersedes any running stream.
      if (playgroundController) playgroundController.abort();
      playgroundController = new AbortController();
      const controller = playgroundController;
      let response;
      try {
        response = await fetch(path, { method: 'POST', headers: headers(true), body: JSON.stringify(payload), signal: controller.signal });
      } catch (fetchError) {
        if (playgroundController === controller) playgroundController = null;
        if (controller.signal.aborted) { toast('Playground stopped'); return; }
        setOutput(out, 'Playground request failed.', true);
        return;
      }
      if (!response.ok || !response.body) {
        if (playgroundController === controller) playgroundController = null;
        setOutput(out, 'Playground request failed (' + response.status + ').' + playgroundHint(response.status), true);
        return;
      }
      setOutput(out, '');
      const outputEl = byId(out);
      // Append each streamed delta to one text node so a selection the operator makes
      // mid-stream survives; reassigning textContent per delta would wipe it (#19).
      let textNode = null;
      const appendChunk = (str) => {
        if (!outputEl || !str) return;
        if (!textNode) { outputEl.textContent = ''; textNode = document.createTextNode(''); outputEl.appendChild(textNode); }
        textNode.appendData(str);
      };
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffered = '';
      const toolAcc = {};
      let finishReason = '';
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffered += decoder.decode(chunk.value, { stream: true });
          const lines = buffered.split('\\n');
          buffered = lines.pop() || '';
          for (const raw of lines) {
            const line = raw.trim();
            if (!line || line.indexOf('data:') !== 0) continue;
            const data = line.slice(5).trim();
            if (data === '[DONE]') continue;
            try {
              const parsed = JSON.parse(data);
              const choice0 = parsed.choices && parsed.choices[0];
              if (!choice0) continue;
              const delta = choice0.delta && choice0.delta.content;
              if (delta) appendChunk(delta);
              const calls = choice0.delta && choice0.delta.tool_calls;
              if (Array.isArray(calls)) calls.forEach((call) => {
                const idx = call.index != null ? call.index : 0;
                if (!toolAcc[idx]) toolAcc[idx] = { name: '', args: '' };
                if (call.function && call.function.name) toolAcc[idx].name = call.function.name;
                if (call.function && call.function.arguments) toolAcc[idx].args += call.function.arguments;
              });
              if (choice0.finish_reason) finishReason = choice0.finish_reason;
            } catch (parseError) { /* ignore keep-alive and non-JSON lines */ }
          }
        }
      } catch (streamError) {
        if (!controller.signal.aborted) appendChunk('\\n\\n[stream error]');
      }
      // Surface tool calls and a non-stop finish so the operator can confirm the model
      // actually invoked tools on the dynamic route (#17).
      const toolKeys = Object.keys(toolAcc);
      if (toolKeys.length) appendChunk('\\n\\n[tool calls] ' + toolKeys.map((key) => toolAcc[key].name + '(' + toolAcc[key].args + ')').join(', '));
      if (finishReason && finishReason !== 'stop') appendChunk('\\n\\n[finish_reason: ' + finishReason + ']');
      if (playgroundController === controller) playgroundController = null;
    } else if (action === config.playground.stopAction) {
      if (playgroundController) { playgroundController.abort(); toast('Playground stopped'); }
      else { toast('Nothing is running'); }
    }
  }

  document.addEventListener('click', async (event) => {
    const copy = event.target.closest('[data-copy]');
    if (copy) { await navigator.clipboard.writeText(copy.dataset.copy || ''); toast('Copied'); return; }
    const copyCommand = event.target.closest('[data-output="installer-command"]');
    if (copyCommand && copyCommand.textContent) { await navigator.clipboard.writeText(copyCommand.textContent); toast('Command copied'); return; }
    const copyKey = event.target.closest('[data-output="api-key"]');
    if (copyKey && copyKey.textContent) { await navigator.clipboard.writeText(copyKey.textContent); toast('Key copied'); return; }
    const removeIdent = event.target.closest('[data-remove-ident]');
    if (removeIdent) { const kind = removeIdent.dataset.removeKind === 'user' ? 'user' : 'admin'; accessIdents[kind] = accessIdents[kind].filter((value) => value !== removeIdent.dataset.removeIdent); renderIdentChips(kind); return; }
    const wizardNext = event.target.closest('[data-wizard-next]');
    if (wizardNext) { wizardMove(1); return; }
    const wizardBack = event.target.closest('[data-wizard-back]');
    if (wizardBack) { wizardMove(-1); return; }
    const navLink = event.target.closest('[data-nav]');
    if (navLink) { event.preventDefault(); setSection(navLink.dataset.nav); return; }
    const button = event.target.closest('[data-action]');
    if (button && button.dataset.action === 'mobile-menu-toggle') {
      const sheet = byId('mobile-menu');
      setMobileMenu(!(sheet && !sheet.hidden));
      return;
    }
    if (!button) return;
    const action = button.dataset.action;
    if (button.dataset.confirm && !armOrProceed(button)) return;
    const out = button.dataset.out || defaultOut[action] || '';
    try {
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      await runAction(action, button);
    } catch (error) {
      const message = friendlyError(action, error);
      if (action === 'first-run-setup' && error.status === config.setupLockedFeedback.status) {
        const outputEl = byId(out);
        if (outputEl) outputEl.dataset.feedback = config.setupLockedFeedback.variant;
      }
      setOutput(out, message, true);
      toast(message, true);
    } finally {
      button.disabled = false;
      button.setAttribute('aria-busy', 'false');
      disarm(button);
    }
  });
  document.addEventListener('submit', async (event) => {
    const form = event.target.closest('[data-login-form]');
    if (!form) return;
    event.preventDefault();
    const remember = byId('remember-token');
    try {
      await signIn(readInput('admin-token'), Boolean(remember && remember.checked));
      toast('Signed in');
    } catch (error) {
      setOutput('login-output', friendlyError('admin-login', error), true);
    }
  });
  const applyNodeSearch = (value) => {
    nodeSearch = value || '';
    if (lastStatus) renderNodesTable(Array.isArray(lastStatus.nodes) ? lastStatus.nodes : [], lastStatus.desiredAgentVersion);
  };
  document.addEventListener('input', (event) => {
    const search = event.target.closest('[data-node-search]');
    if (search) applyNodeSearch(search.value);
  });
  document.addEventListener('change', (event) => {
    const search = event.target.closest('[data-node-search]');
    if (search) { applyNodeSearch(search.value); return; }
    const installer = event.target.closest('[data-installer-platform]');
    if (installer) {
      const prefix = installer.dataset.prefix || '';
      if (liveToken || onCustomDomain) loadInstaller(prefix).catch((error) => setOutput(prefix + 'installer-output', friendlyError('installer-generate', error), true));
      return;
    }
    const runtimeSelect = event.target.closest('[data-model-add-mode]');
    if (runtimeSelect) {
      const addRuntime = byId('model-add-runtime');
      const split = runtimeSelect.value === 'split';
      if (addRuntime) {
        addRuntime.disabled = split;
        if (split) addRuntime.value = 'meshllm';
      }
      // Contextual model sources: single serving shows GGUF files, split shows
      // layer packages + the prepare guide (CSS keys off this dataset). REQ-ADM-025.
      const sources = byId('model-add-sources');
      if (sources) sources.dataset.modelSources = split ? 'split' : 'single';
      return;
    }
    const topoSelect = event.target.closest('[data-topo-mesh-select]');
    if (topoSelect) {
      topologyMeshFilter = topoSelect.value || 'all';
      const statusNodes = lastStatus && Array.isArray(lastStatus.nodes) ? lastStatus.nodes : [];
      renderTopology(topologyNodes(statusNodes));
      return;
    }
    const targetSelect = event.target.closest('[data-playground-target-select]');
    if (targetSelect) { updatePlaygroundModels().catch(() => undefined); return; }
    const gatewaySelect = event.target.closest('[data-gateway-select]');
    if (gatewaySelect) {
      const scope = gatewaySelect.id === 'rt-gateway-select' ? 'routing' : 'wizard';
      const ids = gatewayScopeIds(scope);
      toggleNewField(ids.gwNew, gatewaySelect.value === '__new__');
      if (gatewaySelect.value !== '__new__') loadGatewayOptions(gatewaySelect.value, scope).catch(() => undefined);
      else if (scope === 'routing') refreshProvisionChip('').catch(() => undefined);
      return;
    }
  });

  // --- boot -------------------------------------------------------------------
  const bootView = state.view || document.body.dataset.view;
  setView(bootView);
  if (bootView === 'setup') {
    const target = state.recovery || liveToken || onCustomDomain || state.phase === 'unclaimed' ? phaseStep() : 'connect';
    setWizardStep(target);
  }
  if (bootView === 'dashboard') showDashboard();
})();`
