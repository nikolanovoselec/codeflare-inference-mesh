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
  const byId = (id) => document.getElementById(id);
  const tokenKey = 'codeflareInferenceMeshAdminToken';
  const savedToken = () => sessionStorage.getItem(tokenKey) || localStorage.getItem(tokenKey) || '';
  const storeToken = (value, remember) => {
    sessionStorage.removeItem(tokenKey); localStorage.removeItem(tokenKey);
    if (value) (remember ? localStorage : sessionStorage).setItem(tokenKey, value);
  };
  let liveToken = savedToken();
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
  const setHealth = (state, label) => { const pill = byId('health-pill'); if (!pill) return; pill.dataset.health = state; pill.textContent = label; };

  // --- view + section state -------------------------------------------------
  const setView = (mode) => {
    document.body.dataset.view = mode;
    ['setup', 'login', 'dashboard'].forEach((view) => { const el = byId('view-' + view); if (el) el.hidden = view !== mode; });
    const signOut = byId('sign-out-btn');
    if (signOut) signOut.hidden = mode !== 'dashboard';
  };
  const setSection = (name) => {
    config.nav.sections.forEach((section) => {
      const panel = byId(section);
      if (panel) panel.dataset.active = String(section === name);
      const item = document.querySelector('[data-nav="' + section + '"]');
      if (item) { if (section === name) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current'); }
    });
    const moreActive = config.nav.moreSections.indexOf(name) >= 0;
    config.nav.mobileTabs.forEach((tab) => {
      const item = document.querySelector('[data-tab="' + tab + '"]');
      if (!item) return;
      const active = tab === name || (tab === 'more' && moreActive);
      if (active) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current');
    });
    const sheet = byId('more-sheet');
    if (sheet) sheet.hidden = true;
  };
  const showDashboard = () => {
    setView('dashboard');
    setSection(config.nav.sections[0]);
    refreshStatus().catch(() => undefined);
    loadVersions().catch(() => undefined);
    loadInstaller('', false).catch(() => undefined);
  };

  // --- wizard ---------------------------------------------------------------
  const wizardSteps = config.wizard.steps;
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
  };
  const wizardMove = (delta) => {
    const current = wizardSteps.find((name) => { const panel = byId('step-' + name); return panel && !panel.hidden; }) || wizardSteps[0];
    const next = wizardSteps[Math.min(wizardSteps.length - 1, Math.max(0, wizardSteps.indexOf(current) + delta))];
    setWizardStep(next);
    if (next === 'review') renderReview().catch(() => undefined);
  };
  async function renderReview() {
    const summary = byId('review-summary');
    if (!summary || !liveToken) return;
    const status = await request('/admin/status', { headers: headers(false) });
    summary.textContent = '';
    const nodes = Array.isArray(status.nodes) ? status.nodes : [];
    const gateway = status.gateway || {};
    const lines = [
      ['Credentials', 'created'],
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
    const entries = Object.entries(values).filter((pair) => typeof pair[1] === 'string' && pair[0] !== 'byokInstruction');
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

  // --- renderers fed by /admin/status ----------------------------------------
  const fmtAge = (ms) => {
    if (ms < 60000) return Math.max(1, Math.floor(ms / 1000)) + 's';
    if (ms < 3600000) return Math.floor(ms / 60000) + 'm';
    return Math.floor(ms / 3600000) + 'h';
  };
  const tile = (label, value) => {
    const el = document.createElement('div');
    el.className = 'tile';
    const strong = document.createElement('strong');
    strong.textContent = label;
    const code = document.createElement('code');
    code.textContent = value;
    el.append(strong, code);
    return el;
  };
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
    if (node.status === 'online' && (runtime === 'running' || runtime === 'ready')) return 'ok';
    return 'warn';
  };
  function renderNodes(nodes, desiredVersion) {
    const list = byId('node-list');
    if (!list) return;
    list.textContent = '';
    if (!nodes.length) {
      const empty = document.createElement('p');
      empty.className = 'empty-note';
      empty.textContent = 'No nodes enrolled yet. Create a setup token below and run the install command on a machine.';
      list.appendChild(empty);
      return;
    }
    nodes.forEach((node) => {
      const row = document.createElement('div');
      row.className = 'row-item';
      row.setAttribute('data-node-row', node.id);
      const runtime = node.metrics && node.metrics.runtimeState ? node.metrics.runtimeState : 'unknown';
      row.appendChild(statusDot(nodeTone(node), (node.status || 'unknown') + ' · ' + runtime));
      const body = document.createElement('div');
      body.className = 'grow';
      const idCode = document.createElement('code');
      idCode.textContent = node.id;
      const detail = document.createElement('small');
      const ready = node.metrics && Array.isArray(node.metrics.readyModels) ? node.metrics.readyModels.length : 0;
      detail.textContent = ready + ' ready models';
      body.append(idCode, detail);
      row.appendChild(body);
      const reported = node.agentVersion || 'unreported';
      const match = Boolean(desiredVersion) && node.agentVersion === desiredVersion;
      const version = document.createElement('code');
      version.setAttribute('data-node-version', node.id);
      version.setAttribute('data-reported', reported);
      version.setAttribute('data-desired-match', match ? 'true' : 'false');
      version.textContent = reported + (match || !desiredVersion ? '' : ' \\u2192 ' + desiredVersion);
      row.appendChild(version);
      const revoke = document.createElement('button');
      revoke.type = 'button';
      revoke.className = 'btn btn-danger';
      revoke.textContent = 'Revoke';
      revoke.dataset.action = 'node-revoke';
      revoke.dataset.nodeId = node.id;
      revoke.dataset.confirm = 'Confirm revoke?';
      revoke.dataset.out = 'node-output';
      row.appendChild(revoke);
      list.appendChild(row);
    });
  }
  const profileOption = (profile, selectedId) => {
    const option = document.createElement('option');
    option.value = profile.id;
    option.setAttribute('data-profile-option', profile.id);
    option.setAttribute('data-split', profile.meshllm && profile.meshllm.split ? 'true' : 'false');
    if (profile.id === selectedId) option.selected = true;
    option.textContent = profile.id + (profile.meshllm && profile.meshllm.split ? ' \\u2014 split' : ' \\u2014 single-node');
    return option;
  };
  function fillProfileSelect(select, profiles, selectedId) {
    if (!select) return;
    select.textContent = '';
    profiles.forEach((profile) => select.appendChild(profileOption(profile, selectedId)));
    select.disabled = profiles.length === 0;
    select.value = selectedId || (profiles[0] ? profiles[0].id : '');
  }
  function renderActivationSelect(profiles) {
    const slot = byId(config.profileActivation.slotId);
    if (!slot) return;
    const shares = (a, b) => a.publicAliases.some((alias) => b.publicAliases.indexOf(alias) >= 0);
    const choices = profiles.filter((profile) => profiles.some((other) => other.id !== profile.id && shares(profile, other)));
    const active = choices.filter((profile) => profile.active)[0];
    slot.textContent = '';
    const select = document.createElement('select');
    select.id = config.profileActivation.selectId;
    select.name = 'activateProfileId';
    select.setAttribute('data-profile-activate-select', 'true');
    fillProfileSelect(select, choices, active ? active.id : undefined);
    slot.appendChild(select);
  }
  function renderProfiles(profiles, readiness) {
    const list = byId('profile-list');
    if (!list) return;
    list.textContent = '';
    profiles.forEach((profile) => {
      const row = document.createElement('div');
      row.className = 'row-item';
      row.setAttribute('data-profile-row', profile.id);
      row.appendChild(statusDot(profile.active ? 'ok' : 'warn', profile.active ? 'active' : 'standby'));
      const body = document.createElement('div');
      body.className = 'grow';
      const idCode = document.createElement('code');
      idCode.textContent = profile.id;
      const detail = document.createElement('small');
      const ready = readiness.find((item) => item.profileId === profile.id);
      detail.textContent = (profile.publicAliases || []).join(', ') + ' · rollout ' + profile.rolloutPercent + '%' + (ready ? ' · ready ' + ready.ready + ' · failed ' + ready.failed : '');
      body.append(idCode, detail);
      row.appendChild(body);
      list.appendChild(row);
    });
    renderActivationSelect(profiles);
    fillProfileSelect(byId('rollout-profile-select'), profiles, undefined);
    const rotateSlot = byId('mesh-rotate-slot');
    if (rotateSlot) {
      rotateSlot.textContent = '';
      const select = document.createElement('select');
      select.id = config.meshHealth.rotateSelectId;
      select.name = 'meshProfileId';
      select.setAttribute('data-mesh-profile-select', 'true');
      const active = profiles.filter((profile) => profile.active)[0];
      fillProfileSelect(select, profiles, active ? active.id : undefined);
      rotateSlot.appendChild(select);
    }
  }
  function renderMeshHealth(entries) {
    const panel = byId(config.meshHealth.panelId);
    if (!panel) return;
    panel.textContent = '';
    if (!entries.length) {
      const empty = document.createElement('p');
      empty.className = 'empty-note';
      empty.textContent = 'No mesh formation yet. Health appears once a mesh profile has enrolled nodes.';
      panel.appendChild(empty);
    }
    entries.forEach((entry) => {
      const card = document.createElement('div');
      card.className = 'tile';
      card.setAttribute('data-mesh-entry', entry.profileId);
      card.setAttribute('data-mesh-rotation', String(entry.rotation));
      card.setAttribute('data-secret-present', entry.tokenCount > 0 ? 'true' : 'false');
      const title = document.createElement('strong');
      title.textContent = entry.profileId;
      card.appendChild(title);
      config.meshHealth.fields.forEach((fieldName) => {
        const line = document.createElement('code');
        line.setAttribute('data-mesh-field', fieldName);
        let value = '\\u2014';
        if (fieldName === 'coordinator') value = entry.coordinatorNodeId || '\\u2014';
        else if (fieldName === 'peers') value = String((entry.peerNodeIds || []).length);
        else if (fieldName === 'ready-models') value = (entry.readyModels || []).join(', ') || '\\u2014';
        else if (fieldName === 'failed-nodes') value = (entry.failedNodeIds || []).join(', ') || '\\u2014';
        else if (fieldName === 'last-error') value = entry.lastError || '\\u2014';
        else if (fieldName === 'rotation') value = 'r' + entry.rotation;
        else if (fieldName === 'secret') value = entry.tokenCount > 0 ? 'present' + (entry.secretAgeMs != null ? ' · ' + fmtAge(entry.secretAgeMs) : '') : 'absent';
        line.textContent = fieldName.replace(/-/g, ' ') + ': ' + value;
        card.appendChild(line);
      });
      panel.appendChild(card);
    });
    const banner = byId(config.meshHealth.bannerId);
    if (banner) banner.hidden = !entries.some((entry) => entry.lastError === config.meshHealth.keyMissingError);
  }
  function renderAudit(events) {
    const feeds = [byId('overview-audit'), byId('audit-log')];
    feeds.forEach((feed, index) => {
      if (!feed) return;
      feed.textContent = '';
      const slice = index === 0 ? events.slice(0, 8) : events;
      if (!slice.length) {
        const empty = document.createElement('p');
        empty.className = 'empty-note';
        empty.textContent = 'No audit events yet.';
        feed.appendChild(empty);
        return;
      }
      slice.forEach((event) => {
        const item = document.createElement('div');
        item.className = 'feed-item';
        item.setAttribute('data-audit-event', event.type || 'unknown');
        const type = document.createElement('code');
        type.textContent = event.type || 'unknown';
        const detail = document.createElement('span');
        detail.textContent = (event.actor || '') + (event.target ? ' \\u2192 ' + event.target : '');
        const when = document.createElement('time');
        when.textContent = event.at ? new Date(event.at).toISOString().slice(0, 16).replace('T', ' ') : '';
        item.append(type, detail, when);
        feed.appendChild(item);
      });
    });
  }
  function renderStatus(status) {
    const nodes = Array.isArray(status.nodes) ? status.nodes : [];
    const profiles = Array.isArray(status.profiles) ? status.profiles : [];
    const readiness = Array.isArray(status.profileReadiness) ? status.profileReadiness : [];
    const audit = Array.isArray(status.audit) ? status.audit : [];
    const meshEntries = Array.isArray(status.meshHealth) ? status.meshHealth : [];
    const tiles = byId('overview-tiles');
    if (tiles) {
      tiles.textContent = '';
      const gateway = status.gateway || {};
      const domain = status.customDomain || {};
      tiles.appendChild(tile('Nodes', String(nodes.length)));
      tiles.appendChild(tile('Profiles', String(profiles.length)));
      tiles.appendChild(tile('Audit events', String(audit.length)));
      tiles.appendChild(tile('Gateway', [gateway.gatewayId, gateway.routeName].filter(Boolean).join(' / ') || 'not connected'));
      tiles.appendChild(tile('Custom domain', domain.hostname ? domain.hostname + ' · ' + (domain.status || 'unprovisioned') : 'not configured'));
      tiles.appendChild(tile('Fleet version', status.desiredAgentVersion || 'not pinned'));
    }
    const rollup = byId('overview-mesh');
    if (rollup) {
      rollup.textContent = '';
      meshEntries.forEach((entry) => {
        const healthy = !entry.lastError && entry.tokenCount > 0;
        rollup.appendChild(statusDot(entry.lastError ? 'danger' : healthy ? 'ok' : 'warn', entry.profileId + ' · r' + entry.rotation + (entry.lastError ? ' · attention' : healthy ? ' · healthy' : ' · forming')));
      });
    }
    const gatewayCurrent = byId('gateway-current');
    if (gatewayCurrent) {
      const gateway = status.gateway || {};
      gatewayCurrent.textContent = gateway.gatewayId ? 'Current target: ' + [gateway.gatewayId, gateway.routeName, gateway.publicModel].filter(Boolean).join(' / ') : 'No Gateway connected yet.';
    }
    renderNodes(nodes, status.desiredAgentVersion);
    renderProfiles(profiles, readiness);
    renderMeshHealth(meshEntries);
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
  async function loadVersions() {
    const view = await request('/admin/agent-versions', { headers: headers(false) });
    renderVersions(view);
    setOutput('agent-version-output', 'Loaded ' + ((view.tags || []).length) + ' release tags' + (view.stale ? ' (stale cache)' : ''));
    return view;
  }
  async function loadInstaller(prefix, copyToClipboard) {
    const select = byId(prefix + 'installer-platform');
    if (!select) return;
    const platform = select.value;
    const command = await request('/admin/installers/' + platform, { headers: headers(false) });
    if (select.value === platform) setOutput(prefix + 'installer-output', command);
    if (copyToClipboard && select.value === platform) { await navigator.clipboard.writeText(command); toast('Install command copied'); }
  }
  const gatewayPayload = (prefix) => {
    const value = (suffix) => readInput(prefix + 'gateway-' + suffix);
    const raw = { accountId: value('account-id'), gatewayId: value('id'), routeName: value('route-name'), publicModel: value('public-model'), providerName: value('provider-name'), workerUrl: value('worker-url') };
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
    showDashboard();
  }
  const signOut = () => {
    storeToken('', false);
    liveToken = '';
    setView(document.body.dataset.setupOpen === 'true' ? 'setup' : 'login');
    setOutput('login-output', 'Signed out. The token was removed from this browser.');
    toast('Signed out');
  };

  // --- destructive-action arming ---------------------------------------------
  let disarmTimer;
  let armedButton;
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
    'status-refresh': 'overview-tiles',
    'setup-token-create': 'setup-token-output',
    'installer-generate': 'installer-output',
    'gateway-sync': 'gateway-output',
    'custom-domain-validate': 'domain-output',
    'node-revoke': 'node-output',
    'profile-rollout': 'profile-output',
    'profile-activate': 'profile-activate-output',
    'agent-versions-refresh': 'agent-version-output',
    'agent-version-set': 'agent-version-output',
    'mesh-rotate': 'mesh-rotate-output'
  };
  async function runAction(action, button) {
    const prefix = button.dataset.prefix || '';
    const out = button.dataset.out || defaultOut[action] || '';
    if (action === 'first-run-setup') {
      const body = await request('/admin/setup', { method: 'POST' });
      liveToken = body.adminToken || '';
      storeToken(liveToken, false);
      document.body.dataset.setupOpen = 'false';
      renderTokens(out, body);
      const next = byId('wizard-continue-credentials');
      if (next) next.hidden = false;
      toast('Credentials created');
    } else if (action === 'sign-out') {
      signOut();
    } else if (action === 'status-refresh') {
      await refreshStatus();
      toast('Status refreshed');
    } else if (action === 'setup-token-create') {
      renderTokens(out, await request('/admin/setup-tokens', { method: 'POST', headers: headers(false) }));
    } else if (action === 'installer-generate') {
      await loadInstaller(prefix, true);
    } else if (action === 'gateway-sync') {
      setOutput(out, await request('/admin/cloudflare/gateway/sync', { method: 'POST', headers: headers(true), body: JSON.stringify(gatewayPayload(prefix)) }));
    } else if (action === 'custom-domain-validate') {
      setOutput(out, await request('/admin/custom-domain/validate', { method: 'POST', headers: headers(true), body: JSON.stringify({ hostname: readInput('custom-domain'), zoneId: readInput('custom-domain-zone') }) }));
    } else if (action === 'node-revoke') {
      const nodeId = encodeURIComponent(button.dataset.nodeId || '');
      setOutput(out, await request('/admin/nodes/' + nodeId + '/revoke', { method: 'POST', headers: headers(false) }));
      await refreshStatus().catch(() => undefined);
    } else if (action === 'profile-rollout') {
      const select = byId('rollout-profile-select');
      setOutput(out, await request('/admin/profiles/rollout', { method: 'POST', headers: headers(true), body: JSON.stringify({ profileId: select ? select.value : '', rolloutPercent: Number(readInput('rollout-percent')) }) }));
    } else if (action === 'profile-activate') {
      const select = byId(config.profileActivation.selectId);
      setOutput(out, await request('/admin/profiles/activate', { method: 'POST', headers: headers(true), body: JSON.stringify({ profileId: select ? select.value : '' }) }));
      await refreshStatus().catch(() => undefined);
    } else if (action === 'agent-versions-refresh') {
      await loadVersions();
    } else if (action === 'agent-version-set') {
      const select = byId(config.agentVersion.selectId);
      setOutput(out, await request('/admin/agent-version', { method: 'POST', headers: headers(true), body: JSON.stringify({ version: select ? select.value : '' }) }));
    } else if (action === 'mesh-rotate') {
      const select = byId(config.meshHealth.rotateSelectId);
      setOutput(out, await request('/admin/mesh/rotate', { method: 'POST', headers: headers(true), body: JSON.stringify({ profileId: select ? select.value : '' }) }));
    } else if (action === 'wizard-finish') {
      showDashboard();
    }
  }

  document.addEventListener('click', async (event) => {
    const copy = event.target.closest('[data-copy]');
    if (copy) { await navigator.clipboard.writeText(copy.dataset.copy || ''); toast('Copied'); return; }
    const gotoLogin = event.target.closest('[data-goto-login]');
    if (gotoLogin) { event.preventDefault(); setView('login'); return; }
    const wizardNext = event.target.closest('[data-wizard-next]');
    if (wizardNext) { wizardMove(1); return; }
    const wizardBack = event.target.closest('[data-wizard-back]');
    if (wizardBack) { wizardMove(-1); return; }
    const navLink = event.target.closest('[data-nav]');
    if (navLink) { event.preventDefault(); setSection(navLink.dataset.nav); return; }
    const tab = event.target.closest('[data-tab]');
    if (tab) {
      if (tab.dataset.tab === 'more') { const sheet = byId('more-sheet'); if (sheet) sheet.hidden = !sheet.hidden; return; }
      setSection(tab.dataset.tab);
      return;
    }
    const button = event.target.closest('[data-action]');
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
  document.addEventListener('change', (event) => {
    const select = event.target.closest('[data-installer-platform]');
    if (!select) return;
    const prefix = select.dataset.prefix || '';
    if (liveToken) loadInstaller(prefix, false).catch((error) => setOutput(prefix + 'installer-output', friendlyError('installer-generate', error), true));
  });

  // --- boot -------------------------------------------------------------------
  const bootView = document.body.dataset.view;
  document.body.dataset.setupOpen = bootView === 'setup' ? 'true' : 'false';
  setView(bootView);
  if (bootView === 'setup') setWizardStep(config.wizard.steps[0]);
  if (bootView === 'login' && liveToken) {
    request('/admin/login', { method: 'POST', headers: headers(false) })
      .then(() => showDashboard())
      .catch(() => { storeToken('', false); liveToken = ''; });
  }
})();`
