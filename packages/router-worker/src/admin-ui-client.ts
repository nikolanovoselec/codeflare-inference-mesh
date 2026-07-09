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
  const callName = (profile) => { const aliases = (profile && profile.publicAliases) || []; return aliases.find((alias) => alias !== STABLE_PUBLIC_MODEL) || aliases[0] || ''; };
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
  const scrambleChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#@$%&*';
  function randomScrambleChar() { return scrambleChars[Math.floor(Math.random() * scrambleChars.length)] || 'A'; }
  function reduceMotion() {
    try { return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_error) { return false; }
  }
  function scrambleValue(target, phase) {
    if (phase < 60 || phase >= 132) return target;
    if (phase < 88) return target.replace(/\S/g, randomScrambleChar);
    const revealed = Math.min(target.length, Math.max(0, phase - 88));
    return target.split('').map((char, index) => {
      if (char === ' ') return ' ';
      return index < revealed ? char : randomScrambleChar();
    }).join('');
  }
  function initScramble() {
    if (reduceMotion()) return;
    Array.prototype.slice.call(document.querySelectorAll('[data-scramble]')).forEach((target) => {
      const source = (target.textContent || '').trim();
      if (!source) return;
      target.textContent = '';
      const words = source.split(/\s+/).map((word) => {
        const span = document.createElement('span');
        span.className = 'scramble-word';
        span.dataset.target = word;
        span.textContent = word;
        target.appendChild(span);
        if (span.style && typeof span.getBoundingClientRect === 'function') {
          const width = span.getBoundingClientRect().width;
          if (width) span.style.width = width + 'px';
        }
        return span;
      });
      let frame = 0;
      setInterval(() => {
        words.forEach((span) => { span.textContent = scrambleValue(span.dataset.target || '', frame % 140); });
        frame += 1;
      }, 50);
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
    else setOutput(out, body);
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
  const lastSpeedTest = (status) => status && status.lastSpeedTest && typeof status.lastSpeedTest === 'object' ? status.lastSpeedTest : null;
  const lastSpeedLabel = (summary) => {
    const prompt = speedNumber(summary && summary.promptTokensPerSecond);
    const generation = speedNumber(summary && summary.generationTokensPerSecond);
    return prompt == null || generation == null ? 'not run' : 'prompt ' + round1(prompt) + ' / gen ' + round1(generation) + ' tok/s';
  };
  const nodeVramTotal = (node) => (node.metrics && node.metrics.gpuMemoryTotalMiB) || 0;
  const nodeModelCount = (node) => (node.metrics && Array.isArray(node.metrics.readyModels) ? node.metrics.readyModels.length : 0);
  const reportedText = (value) => value == null ? 'not reported' : String(value);
  const readinessText = (value) => value === true ? 'ready' : value === false ? 'down' : 'not reported';
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
  const nodeTone = (node) => {
    const runtime = node.metrics && node.metrics.runtimeState ? node.metrics.runtimeState : 'unknown';
    if (runtime === 'failed' || node.status === 'offline') return 'danger';
    if (node.deactivated) return 'warn';
    if (node.status === 'online' && (runtime === 'running' || runtime === 'ready')) return 'ok';
    return 'warn';
  };
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
  function runtimeInstallInfo(node) {
    if (node.runtimeInstall) return node.runtimeInstall;
    const metrics = node.metrics || {};
    const runtime = metrics.runtimeKind === 'llamacpp' || node.runtime === 'llamacpp' ? 'llamacpp' : 'meshllm';
    const desired = lastStatus && lastStatus.desiredRuntimeVersions ? lastStatus.desiredRuntimeVersions[runtime] : '';
    const installed = runtime === 'llamacpp' ? metrics.llamacppVersion : metrics.meshllmVersion;
    const error = metrics.lastError || metrics.runtimeDetail || '';
    const state = metrics.runtimeState === 'downloading' ? 'installing' : ((metrics.runtimeState === 'dependency-missing' || (error && !installed)) ? 'failed' : (installed ? 'installed' : 'pending'));
    return { runtime: runtime, desiredVersion: desired || '', installedVersion: installed || null, state: state, error: error || null };
  }
  const runtimeInstallLabel = (info) => info.runtime === 'llamacpp' ? 'llama.cpp' : 'MeshLLM';
  const runtimeInstallTone = (info) => info.state === 'failed' ? 'danger' : (info.state === 'installed' ? 'ok' : 'warn');
  const runtimeInstallText = (node) => {
    const info = runtimeInstallInfo(node);
    const desired = info.desiredVersion || 'selected';
    if (info.state === 'installing') return 'Installing ' + runtimeInstallLabel(info) + ' ' + desired;
    if (info.state === 'failed') return runtimeInstallLabel(info) + ' install failed';
    if (info.installedVersion) return runtimeInstallLabel(info) + ' ' + info.installedVersion + (info.installedVersion === desired || !desired ? '' : ' → ' + desired);
    return runtimeInstallLabel(info) + ' pending ' + desired;
  };
  function nodeStatusText(node) {
    if (node.status === 'offline') { const age = nodeRelAge(node); return 'Offline' + (age ? ' · last seen ' + age : ''); }
    if (node.status === 'revoked') return 'Removed';
    if (node.status === 'draining') return 'Draining';
    if (node.deactivated) return 'Deactivated';
    const metrics = node.metrics || {};
    const rt = metrics.runtimeState || '';
    const stateDetail = metrics.nodeState || '';
    if (rt === 'failed' || rt === 'dependency-missing') return 'Failed' + (stateDetail ? ' · ' + stateDetail : '');
    if (nodeReady(node)) return 'Ready';
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
  // Row action: a right-aligned Manage button that opens the node drawer (Revoke + Deactivate/Activate),
  // mirroring the model rows. Replaces the inline Revoke button that used to sit mid-row.
  const manageButton = (nodeId) => {
    const manage = document.createElement('button');
    manage.type = 'button';
    manage.className = 'btn btn-ghost';
    manage.textContent = 'Manage';
    manage.dataset.action = 'node-detail';
    manage.dataset.nodeId = nodeId;
    return manage;
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
    if (key === 'toks') return !nodeReady(node) || nodeToks(node) == null ? -1 : nodeToks(node);
    if (key === 'vram') return nodeVramTotal(node);
    if (key === 'models') return nodeModelCount(node);
    if (key === 'version') return node.agentVersion || '';
    return node.id;
  };
  const nodeCellLabel = { id: 'Machine', status: 'Status', toks: 'tok/s', vram: 'VRAM', models: 'Models', version: 'Version' };
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
      idButton.textContent = node.id;
      idCell.appendChild(idButton);
      const statusCell = cell('status', nodeCategory(node), undefined);
      if (node.metrics && node.metrics.nodeState) statusCell.setAttribute('data-status-detail', node.metrics.nodeState);
      statusCell.appendChild(statusDot(nodeTone(node), nodeStatusText(node)));
      const install = runtimeInstallInfo(node);
      const installChip = chipEl(runtimeInstallTone(install), runtimeInstallText(node));
      installChip.setAttribute('data-runtime-install-chip', node.id);
      installChip.setAttribute('data-runtime-install-state', install.state);
      statusCell.appendChild(installChip);
      const toks = nodeToks(node);
      const toksReady = nodeReady(node) && toks != null;
      cell('toks', toksReady ? String(toks) : '', nodeReady(node) ? (toks == null ? 'not reported' : round1(toks)) : '\u2014');
      cell('vram', String(nodeVramTotal(node)), nodeReady(node) && nodeVramTotal(node) ? Math.round(nodeVramTotal(node) / 1024) + ' GB' : '\u2014');
      cell('models', String(nodeModelCount(node)), String(nodeModelCount(node)));
      const versionCell = cell('version', undefined, undefined);
      versionCell.appendChild(versionCode(node, desiredVersion));
      versionCell.appendChild(manageButton(node.id));
      bodyEl.appendChild(row);
    });
  }
  const topoNodeButton = (node) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'topo-node tone-' + nodeTone(node);
    button.dataset.action = 'node-detail';
    button.dataset.nodeId = node.id;
    button.textContent = node.id;
    return button;
  };
  function renderTopology(nodes) {
    const canvas = byId(config.topology.canvasId);
    const list = byId(config.topology.listId);
    const caption = byId(config.topology.captionId);
    const serving = nodes.filter((node) => nodeTone(node) === 'ok').length;
    if (caption) {
      caption.dataset.nodes = String(nodes.length);
      caption.dataset.serving = String(serving);
      caption.textContent = nodes.length + ' nodes \u00b7 ' + serving + ' serving';
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
    const bodyEl = openDrawer(node.id);
    if (!bodyEl) return;
    const metrics = node.metrics || {};
    const isDirectRuntime = node.runtime === 'llamacpp' || metrics.runtimeKind === 'llamacpp';
    const toks = nodeToks(node);
    const vramUsed = metrics.gpuMemoryUsedMiB;
    const vramTotal = metrics.gpuMemoryTotalMiB;
    bodyEl.appendChild(drawerField('status', 'Status', nodeStatusText(node)));
    bodyEl.appendChild(drawerField('toks', 'Tokens/s', toks == null ? 'not reported' : round1(toks), toks == null ? '' : String(toks)));
    bodyEl.appendChild(drawerField('vram', 'VRAM MiB', vramUsed == null || vramTotal == null ? 'not reported' : (vramUsed + ' / ' + vramTotal), vramUsed == null || vramTotal == null ? '' : vramUsed + '/' + vramTotal));
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
    if (metrics.runtimeDetail) {
      const errRow = drawerField('runtime-detail', 'Runtime error', metrics.runtimeDetail);
      errRow.setAttribute('data-tone', 'danger');
      bodyEl.appendChild(errRow);
    }
    const install = runtimeInstallInfo(node);
    const installRow = drawerField('runtime-install', runtimeInstallLabel(install), runtimeInstallText(node));
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
    if (metrics.nodeState) bodyEl.appendChild(drawerField('node-state', 'Node state', metrics.nodeState));
    if (!isDirectRuntime || metrics.meshRole) bodyEl.appendChild(drawerField('mesh-role', 'Mesh role', metrics.meshRole || 'not reported'));
    if (!isDirectRuntime || metrics.peerCount != null) bodyEl.appendChild(drawerField('peers', 'Peers', reportedText(metrics.peerCount), metrics.peerCount == null ? '' : String(metrics.peerCount)));
    if (metrics.splitEnabled || metrics.stageCount) bodyEl.appendChild(drawerField('stages', 'Stages', reportedText(metrics.stageCount), metrics.stageCount == null ? '' : String(metrics.stageCount)));
    const apiState = readinessText(metrics.apiReady);
    if (isDirectRuntime && typeof metrics.consoleReady !== 'boolean') {
      bodyEl.appendChild(drawerField('reachability', 'Runtime API', apiState, 'api:' + apiState));
    } else {
      const consoleState = readinessText(metrics.consoleReady);
      bodyEl.appendChild(drawerField('reachability', 'API / console', apiState + ' / ' + consoleState, 'api:' + apiState + ';console:' + consoleState));
    }
    if (metrics.meshllmVersion) bodyEl.appendChild(drawerField('meshllm', 'mesh-llm', metrics.meshllmVersion));
    if (metrics.llamacppVersion) bodyEl.appendChild(drawerField('llamacpp', 'llama.cpp', metrics.llamacppVersion));
    if (isDirectRuntime) {
      bodyEl.appendChild(drawerField('direct-context', 'Direct context tokens', reportedText(metrics.ctxSize), metrics.ctxSize != null ? String(metrics.ctxSize) : ''));
      const slotsCapacity = metrics.slotCount != null ? metrics.slotCount : metrics.parallel;
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
      item.textContent = model;
      bodyEl.appendChild(item);
    });
    const vramRow = document.createElement('label');
    vramRow.className = 'drawer-row';
    vramRow.textContent = 'Max VRAM override (GB, blank = use model default)';
    const vramInput = document.createElement('input');
    vramInput.id = 'node-edit-vram';
    vramInput.type = 'number';
    vramInput.min = '0';
    vramInput.step = '0.5';
    // Blank = follow the model's global budget; a number caps just this node (0 = uncapped here).
    vramInput.value = node.maxVramGbOverride != null ? String(node.maxVramGbOverride) : '';
    vramRow.appendChild(vramInput);
    bodyEl.appendChild(vramRow);
    const saveVram = document.createElement('button');
    saveVram.type = 'button';
    saveVram.className = 'btn';
    saveVram.textContent = 'Save VRAM override';
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
    bodyEl.appendChild(drawerField('active', 'Status', profile.active ? 'On' : 'Off'));
    bodyEl.appendChild(drawerField('runtime', 'Runtime', profile.runtime === 'llamacpp' ? 'llama.cpp' : 'mesh-llm', profile.runtime || 'meshllm'));
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
    ctxRow.appendChild(drawerHint(isDirect ? 'Max tokens kept in llama.cpp context. Direct profiles require a pinned value (4096 or higher).' : 'Max tokens kept in context. Blank = Auto (mesh-llm sizes it to the GPU). Pin a number (e.g. 262144) to fix it; larger uses more GPU memory and may leave room for fewer lanes.'));
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
    }
    if (isDirect) {
      const reasoning = llamacpp.reasoning || {};
      const flashValue = llamacpp.flashAttn === true ? 'on' : llamacpp.flashAttn === false ? 'off' : '';
      const reasoningValue = reasoning.enabled === true ? 'on' : reasoning.enabled === false ? 'off' : '';
      bodyEl.appendChild(meshTunableNumberRow({ id: 'model-edit-llama-parallel', label: 'llama.cpp parallel slots', value: llamacpp.parallel, placeholder: '4', hint: 'Concurrent direct slots for this node-local llama-server. More slots can serve more overlapping requests but reserve more KV memory.' }));
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
    // A custom, switched-off model can be permanently removed here; built-in models
    // re-seed on boot and the active model owns the route, so neither shows Delete.
    if (String(profile.id).indexOf('custom-') === 0 && !profile.active) {
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
    const servingNodes = nodesServingProfile(profile);
    bodyEl.appendChild(drawerField('serving', 'Machines serving it', String(servingNodes.length), String(servingNodes.length)));
    servingNodes.forEach((node) => {
      const item = document.createElement('div');
      item.className = 'drawer-row';
      item.setAttribute('data-drawer-serving-node', node.id);
      item.textContent = node.id;
      bodyEl.appendChild(item);
    });
    // Mesh detail lives with the model it belongs to: both a single-machine model
    // (every machine runs the whole model) and a split model (machines share the
    // model's layers) form a mesh, so this shows whenever this model has one.
    const meshEntries = lastStatus && Array.isArray(lastStatus.meshHealth) ? lastStatus.meshHealth : [];
    const meshEntry = meshEntries.find((entry) => entry.profileId === profile.id);
    if (meshEntry) {
      const heading = document.createElement('h3');
      heading.className = 'drawer-subhead';
      heading.textContent = 'Mesh';
      bodyEl.appendChild(heading);
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
  // Prominent current-value display: an accented card that surfaces a configured
  // value (custom domain, connected gateway) instead of burying it in helper text.
  function renderStateCard(el, parts) {
    if (!el) return;
    el.textContent = '';
    const present = Boolean(parts.value);
    el.classList.toggle('is-empty', !present);
    const label = document.createElement('span');
    label.className = 'state-label';
    label.textContent = parts.label;
    const value = document.createElement('span');
    value.className = 'state-value';
    value.textContent = present ? parts.value : (parts.placeholder || '—');
    el.append(label, value);
    if (present && parts.sub) { const sub = document.createElement('span'); sub.className = 'state-sub'; sub.textContent = parts.sub; el.appendChild(sub); }
    if (present && parts.chip) el.appendChild(chipEl(parts.chipTone || 'ok', parts.chip));
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
  // A node serves a model when its runtime reports the model's upstream ref ready. readyModels
  // carries upstream refs (what mesh-llm loaded) exactly as the scheduler/router match on, never
  // the public aliases, so serving is keyed on profile.upstreamModel.
  function nodesServingProfile(profile) {
    const nodes = lastStatus && Array.isArray(lastStatus.nodes) ? lastStatus.nodes : [];
    return nodes.filter((node) => node.metrics && Array.isArray(node.metrics.readyModels) && node.metrics.readyModels.indexOf(profile.upstreamModel) >= 0);
  }
  function servingCount(profile) {
    return nodesServingProfile(profile).length;
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
      // Serving mode and runtime are badges, not part of the name: split stands out in accent,
      // and llama.cpp direct profiles surface their cache-local routing contract.
      const direct = profile.runtime === 'llamacpp';
      const split = Boolean(profile.meshllm && profile.meshllm.split);
      const badge = chipEl(split ? 'accent' : null, split ? 'Split across machines' : 'Full model per machine');
      badge.setAttribute('data-serving-mode', split ? 'split' : 'single');
      const runtimeBadge = chipEl(direct ? 'accent' : null, direct ? 'llama.cpp direct' : 'mesh-llm');
      runtimeBadge.setAttribute('data-runtime', direct ? 'llamacpp' : 'meshllm');
      nameRow.append(name, badge, runtimeBadge);
      const detail = document.createElement('small');
      const ready = readiness.find((item) => item.profileId === profile.id);
      const serving = servingCount(profile);
      detail.textContent = 'Alias: ' + (callName(profile) || '—') + ' · ' + serving + ' machine' + (serving === 1 ? '' : 's') + ' serving' + (direct ? ' · requires body.user' : '') + (ready && ready.failed ? ' · ' + ready.failed + ' failed' : '');
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
    if (entry.lastError || (entry.failedNodeIds && entry.failedNodeIds.length > 0)) return ' · needs attention';
    return entry.tokenCount > 0 ? ' · ready' : ' · forming';
  }
  // meshStatusTone maps the same entry to a status-dot tone: grey for a switched-off
  // model, danger for a failure, ok only when it is active and holds a mesh secret.
  function meshStatusTone(entry) {
    if (entry.active === false) return 'idle';
    if (entry.lastError || (entry.failedNodeIds && entry.failedNodeIds.length > 0)) return 'danger';
    return entry.tokenCount > 0 ? 'ok' : 'idle';
  }

  // buildMeshCard renders one model's mesh detail (a plain summary plus the raw
  // fields behind a disclosure). It lives in that model's Manage drawer, since both
  // single-machine and split models form a mesh.
  function buildMeshCard(entry) {
    const profilesById = lastStatus && Array.isArray(lastStatus.profiles) ? lastStatus.profiles : [];
    const card = document.createElement('div');
    card.className = 'tile';
    card.setAttribute('data-mesh-entry', entry.profileId);
    card.setAttribute('data-mesh-rotation', String(entry.rotation));
    card.setAttribute('data-secret-present', entry.tokenCount > 0 ? 'true' : 'false');
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
    const details = document.createElement('details');
    const detailsSummary = document.createElement('summary');
    detailsSummary.textContent = 'Technical details';
    details.appendChild(detailsSummary);
    config.meshHealth.fields.forEach((fieldName) => {
      const line = document.createElement('code');
      line.setAttribute('data-mesh-field', fieldName);
      let value = 'none';
      if (fieldName === 'coordinator') value = entry.coordinatorNodeId || 'none';
      else if (fieldName === 'peers') value = String((entry.peerNodeIds || []).length);
      else if (fieldName === 'ready-models') value = (entry.readyModels || []).join(', ') || 'none';
      else if (fieldName === 'failed-nodes') value = (entry.failedNodeIds || []).join(', ') || 'none';
      else if (fieldName === 'last-error') value = entry.lastError || 'none';
      else if (fieldName === 'rotation') value = 'r' + entry.rotation;
      else if (fieldName === 'secret') value = entry.tokenCount > 0 ? 'present' + (entry.secretAgeMs != null ? ' · ' + fmtAge(entry.secretAgeMs) : '') : 'absent';
      line.textContent = fieldName.replace(/-/g, ' ') + ': ' + value;
      details.appendChild(line);
    });
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
    const feeds = [byId('overview-audit'), byId('audit-log')];
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
    const tiles = byId('overview-tiles');
    if (tiles) {
      tiles.textContent = '';
      const domain = status.customDomain || {};
      const serving = nodes.filter((node) => nodeTone(node) === 'ok').length;
      const vramMiB = nodes.reduce((total, node) => total + nodeVramTotal(node), 0);
      const speed = lastSpeedTest(status);
      tiles.appendChild(tile('Nodes serving', serving + '/' + nodes.length, 'nodes'));
      tiles.appendChild(tile('Mesh VRAM GB', String(Math.round(vramMiB / 1024)), 'vram'));
      const speedTile = tile('Last speed test', speed ? lastSpeedLabel(speed) : 'not run', 'speed');
      if (speed) {
        if (speed.promptTokensPerSecond != null) speedTile.dataset.promptTps = String(speed.promptTokensPerSecond);
        if (speed.generationTokensPerSecond != null) speedTile.dataset.generationTps = String(speed.generationTokensPerSecond);
        if (speed.cacheTokens != null) speedTile.dataset.cacheTokens = String(speed.cacheTokens);
        if (speed.nodeId) speedTile.dataset.nodeId = speed.nodeId;
        if (speed.at != null) speedTile.dataset.at = String(speed.at);
      }
      tiles.appendChild(speedTile);
      tiles.appendChild(tile('Custom domain', domain.hostname ? domain.hostname + ' · ' + (domain.status || 'unprovisioned') : 'not configured', 'domain'));
      tiles.appendChild(tile('Agent version', status.desiredAgentVersion || 'not set', 'version'));
    }
    const pruneInput = byId('prune-seconds');
    if (pruneInput && status.offlinePruneSeconds != null && pruneInput.value === '') pruneInput.value = String(status.offlinePruneSeconds);
    renderTopology(nodes);
    pushToksSample(nodes.reduce((total, node) => total + (nodeToks(node) || 0), 0));
    renderToksTrace();
    const rollup = byId('overview-mesh');
    if (rollup) {
      rollup.textContent = '';
      meshEntries.forEach((entry) => {
        const profile = profiles.find((candidate) => candidate.id === entry.profileId);
        const name = profile ? modelName(profile) : entry.profileId;
        const peers = (entry.peerNodeIds || []).length;
        const shared = peers > 0;
        // Plain summary, same vocabulary as the Model-sharing section; a single-node
        // model reads "not shared yet" in neutral grey, never an alarming "forming".
        const label = shared
          ? name + ' · ' + peers + ' machine' + (peers === 1 ? '' : 's') + ' sharing' + meshStatusSuffix(entry)
          : name + ' · not shared yet';
        const tone = shared ? meshStatusTone(entry) : 'idle';
        rollup.appendChild(statusDot(tone, label));
      });
    }
    const gatewayCurrent = byId('gateway-current');
    if (gatewayCurrent) {
      const gateway = status.gateway || {};
      renderStateCard(gatewayCurrent, {
        label: 'Connected gateway',
        value: gateway.gatewayId || '',
        placeholder: 'Not connected yet',
        sub: gateway.gatewayId ? ('route ' + (gateway.routeName || STABLE_PUBLIC_MODEL)) : ''
      });
    }
    const domainCurrent = byId('custom-domain-current');
    if (domainCurrent) {
      const domain = status.customDomain || {};
      renderStateCard(domainCurrent, {
        label: 'Custom domain',
        value: domain.hostname || '',
        placeholder: 'Not set yet',
        chip: domain.hostname ? (domain.status || 'unprovisioned') : '',
        chipTone: domain.status === 'provisioned' ? 'ok' : 'warn'
      });
    }
    lastStatus = status;
    renderNodesTable(nodes, status.desiredAgentVersion);
    renderProfiles(profiles, readiness);
    renderPlaygroundSelect();
    // Mesh detail now lives per-model in the Manage drawer; here we only keep the
    // global mesh-secret-missing banner (shown on the Models section) in sync.
    const meshBanner = byId(config.meshHealth.bannerId);
    if (meshBanner) meshBanner.hidden = !meshEntries.some((entry) => entry.lastError === config.meshHealth.keyMissingError);
    renderAudit(audit);
    setHealth('ok', 'live');
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
  async function loadGatewayOptions(gatewayId, scope) {
    const ids = gatewayScopeIds(scope);
    const emptyPanel = byId(ids.empty);
    const selects = byId(ids.selects);
    if (!emptyPanel || !selects) return;
    const body = await request('/admin/cloudflare/gateway/options' + (gatewayId ? '?gateway=' + encodeURIComponent(gatewayId) : ''), { headers: headers(false) });
    const gateways = (body.gateways || []).map((gateway) => gateway.id);
    const defaults = body.defaults || {};
    emptyPanel.hidden = gateways.length > 0;
    selects.hidden = gateways.length === 0;
    if (!gateways.length) { if (scope === 'routing') refreshProvisionChip('').catch(() => undefined); return; }
    const wantedGateway = gatewayId || defaults.gatewayId;
    const gatewayValue = gateways.indexOf(wantedGateway) >= 0 ? wantedGateway : '__new__';
    fillChoiceSelect(ids.gwSlot, ids.gwSelect, 'gatewayId', 'data-gateway-select', gateways, gatewayValue, 'Create new gateway\u2026');
    toggleNewField(ids.gwNew, gatewayValue === '__new__');
    if (scope === 'routing') refreshProvisionChip(gatewayValue).catch(() => undefined);
  }
  // The Routing chip reflects the *selected* gateway's live provisioning (mesh route +
  // canonical provider), verified server-side. It stays hidden unless that gateway is
  // actually provisioned, so it can never imply a connection that is not there.
  async function refreshProvisionChip(gatewayId) {
    const chip = byId('rt-route-chip');
    if (!chip) return;
    const state = byId('rt-route-state');
    const target = gatewayId && gatewayId !== '__new__' ? gatewayId : '';
    if (!target) { chip.hidden = true; return; }
    try {
      const status = await request('/admin/cloudflare/gateway/provision-status?gateway=' + encodeURIComponent(target), { headers: headers(false) });
      chip.hidden = !status.provisioned;
      chip.classList.toggle('operational', Boolean(status.provisioned));
      if (state) state.textContent = status.provisioned ? 'provisioned' : 'not connected';
    } catch (error) {
      chip.hidden = true;
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
    'model-delete': 'model-edit-output',
    'model-add': 'model-add-output',
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
      await loadGatewayOptions('').catch(() => undefined);
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
      // Refresh the chip for the currently selected gateway only; a brand-new gateway
      // (select still on create-new) makes no extra call and updates on the next routing view.
      const rtSelect = byId('rt-gateway-select');
      await refreshProvisionChip(rtSelect ? rtSelect.value : '').catch(() => undefined);
    } else if (action === 'custom-domain-validate') {
      // Hostname only; the owning zone is matched server-side from the runtime token.
      setOutput(out, await request('/admin/custom-domain/validate', { method: 'POST', headers: headers(true), body: JSON.stringify({ hostname: readInput('custom-domain') }) }));
    } else if (action === 'node-revoke') {
      const nodeId = encodeURIComponent(button.dataset.nodeId || '');
      setOutput(out, await request('/admin/nodes/' + nodeId + '/revoke', { method: 'POST', headers: headers(false) }));
      await refreshStatus().catch(() => undefined);
    } else if (action === 'node-reload') {
      const nodeId = encodeURIComponent(button.dataset.nodeId || '');
      setOutput(out, await request('/admin/nodes/' + nodeId + '/reload', { method: 'POST', headers: headers(false) }));
      await refreshStatus().catch(() => undefined);
    } else if (action === 'node-deactivate' || action === 'node-activate') {
      const nodeId = encodeURIComponent(button.dataset.nodeId || '');
      const verb = action === 'node-deactivate' ? 'deactivate' : 'activate';
      setOutput(out, await request('/admin/nodes/' + nodeId + '/' + verb, { method: 'POST', headers: headers(false) }));
      await refreshStatus().catch(() => undefined);
    } else if (action === 'node-config-save') {
      const nodeId = encodeURIComponent(button.dataset.nodeId || '');
      const raw = readInput('node-edit-vram');
      // Blank clears the override (revert to the model default); a number caps just this node.
      const payload = { maxVramGbOverride: raw === '' ? null : Number(raw) };
      setOutput(out, await request('/admin/nodes/' + nodeId + '/config', { method: 'POST', headers: headers(true), body: JSON.stringify(payload) }));
      toast('Node VRAM override saved');
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
      payload.contextWindow = ctxRaw === '' ? (runtime === 'llamacpp' ? 262144 : 0) : Number(ctxRaw);
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
          parallel: llamaParallelRaw === '' ? 1 : Number(llamaParallelRaw),
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
      }
      setOutput(out, await request('/admin/profiles/config', { method: 'POST', headers: headers(true), body: JSON.stringify(payload) }));
      toast('Model settings saved');
      await refreshStatus().catch(() => undefined);
    } else if (action === 'model-delete') {
      const id = button.dataset.profileId || '';
      setOutput(out, await request('/admin/profiles/delete', { method: 'POST', headers: headers(true), body: JSON.stringify({ profileId: id }) }));
      closeDrawer();
      await refreshStatus().catch(() => undefined);
      toast('Model deleted');
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
      setOutput(out, await request('/admin/agent-version', { method: 'POST', headers: headers(true), body: JSON.stringify({ version: select ? select.value : '' }) }));
    } else if (action === 'runtime-versions-refresh') {
      await loadRuntimeVersions();
    } else if (action === 'runtime-versions-set') {
      const meshllm = byId(config.runtimeVersion.meshllmSelectId);
      const llamacpp = byId(config.runtimeVersion.llamacppSelectId);
      setOutput(out, await request('/admin/runtime-versions', { method: 'POST', headers: headers(true), body: JSON.stringify({ meshllm: meshllm ? meshllm.value : '', llamacpp: llamacpp ? llamacpp.value : '' }) }));
    } else if (action === 'settings-save') {
      setOutput(out, await request('/admin/settings', { method: 'POST', headers: headers(true), body: JSON.stringify({ offlinePruneSeconds: Number(readInput('prune-seconds')) }) }));
      toast('Settings saved');
    } else if (action === 'mesh-rotate') {
      // The reset control lives in a model's Manage drawer and carries its profile id.
      const profileId = button.dataset.profileId || '';
      setOutput(out, await request('/admin/mesh/rotate', { method: 'POST', headers: headers(true), body: JSON.stringify({ profileId }) }));
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
      setOutput(out, await request('/admin/profiles/add', { method: 'POST', headers: headers(true), body: JSON.stringify(payload) }));
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
      if (addRuntime) {
        const split = runtimeSelect.value === 'split';
        addRuntime.disabled = split;
        if (split) addRuntime.value = 'meshllm';
      }
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
