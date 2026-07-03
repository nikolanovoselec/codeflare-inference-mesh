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
  let pollTimer;
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
    ['setup', 'dashboard'].forEach((view) => { const el = byId('view-' + view); if (el) el.hidden = view !== mode; });
    const signOut = byId('sign-out-btn');
    if (signOut) signOut.hidden = mode !== 'dashboard' || !liveToken;
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
  const schedulePoll = () => {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(() => {
      pollTimer = undefined;
      if (document.hidden) return;
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
    loadInstaller('', false).catch(() => undefined);
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
  const nodeToks = (node) => (node.metrics && node.metrics.tokensPerSecond) || 0;
  const nodeVramTotal = (node) => (node.metrics && node.metrics.gpuMemoryTotalMiB) || 0;
  const nodeModelCount = (node) => (node.metrics && Array.isArray(node.metrics.readyModels) ? node.metrics.readyModels.length : 0);
  const round1 = (value) => String(Math.round(value * 10) / 10);
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
    if (key === 'toks') return nodeToks(node);
    if (key === 'vram') return nodeVramTotal(node);
    if (key === 'models') return nodeModelCount(node);
    if (key === 'version') return node.agentVersion || '';
    return node.id;
  };
  function renderNodesTable(nodes, desiredVersion) {
    const bodyEl = byId(config.nodesTable.bodyId);
    if (!bodyEl) return;
    bodyEl.textContent = '';
    if (!nodes.length) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.className = 'empty-note';
      cell.textContent = 'No nodes enrolled yet. Create a setup token below and run the install command on a machine.';
      row.appendChild(cell);
      bodyEl.appendChild(row);
      return;
    }
    const ordered = nodes.slice();
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
      const runtime = node.metrics && node.metrics.runtimeState ? node.metrics.runtimeState : 'unknown';
      cell('status', undefined, undefined).appendChild(statusDot(nodeTone(node), (node.status || 'unknown') + ' \u00b7 ' + runtime));
      cell('toks', String(nodeToks(node)), round1(nodeToks(node)));
      cell('vram', String(nodeVramTotal(node)), Math.round(nodeVramTotal(node) / 1024) + ' GB');
      cell('models', String(nodeModelCount(node)), String(nodeModelCount(node)));
      const versionCell = cell('version', undefined, undefined);
      versionCell.appendChild(versionCode(node, desiredVersion));
      versionCell.appendChild(revokeButton(node.id));
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
      nodes.forEach((node, index) => {
        const angle = (index / Math.max(1, nodes.length)) * 2 * Math.PI - Math.PI / 2;
        const spoke = document.createElement('span');
        spoke.className = 'topo-spoke';
        spoke.setAttribute('aria-hidden', 'true');
        spoke.setAttribute('style', 'transform:rotate(' + Math.round(angle * 180 / Math.PI) + 'deg)');
        canvas.appendChild(spoke);
        const button = topoNodeButton(node);
        const x = 50 + 38 * Math.cos(angle);
        const y = 50 + 38 * Math.sin(angle);
        button.setAttribute('style', 'left:' + x.toFixed(1) + '%;top:' + y.toFixed(1) + '%');
        canvas.appendChild(button);
      });
    }
    if (list) {
      list.textContent = '';
      nodes.forEach((node) => list.appendChild(topoNodeButton(node)));
    }
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
    const runtime = metrics.runtimeState || 'unknown';
    bodyEl.appendChild(drawerField('status', 'Status', (node.status || 'unknown') + ' \u00b7 ' + runtime));
    bodyEl.appendChild(drawerField('toks', 'Tokens/s', round1(nodeToks(node)), String(nodeToks(node))));
    bodyEl.appendChild(drawerField('vram', 'VRAM MiB', (metrics.gpuMemoryUsedMiB || 0) + ' / ' + (metrics.gpuMemoryTotalMiB || 0), (metrics.gpuMemoryUsedMiB || 0) + '/' + (metrics.gpuMemoryTotalMiB || 0)));
    if (metrics.gpuName) bodyEl.appendChild(drawerField('gpu', 'GPU', metrics.gpuName));
    const desired = lastStatus ? lastStatus.desiredAgentVersion : undefined;
    const reported = node.agentVersion || 'unreported';
    const match = Boolean(desired) && node.agentVersion === desired;
    const versionRow = drawerField('version', 'Agent version', reported + (match || !desired ? '' : ' \u2192 ' + desired));
    versionRow.setAttribute('data-reported', reported);
    versionRow.setAttribute('data-desired-match', match ? 'true' : 'false');
    bodyEl.appendChild(versionRow);
    const models = Array.isArray(metrics.readyModels) ? metrics.readyModels : [];
    models.forEach((model) => {
      const item = document.createElement('div');
      item.className = 'drawer-row';
      item.setAttribute('data-drawer-model', model);
      item.textContent = model;
      bodyEl.appendChild(item);
    });
    bodyEl.appendChild(revokeButton(node.id));
  }
  function openModelDrawer(profileId) {
    const profiles = lastStatus && Array.isArray(lastStatus.profiles) ? lastStatus.profiles : [];
    const profile = profiles.find((candidate) => candidate.id === profileId);
    if (!profile) return;
    const bodyEl = openDrawer(profile.id);
    if (!bodyEl) return;
    const aliases = profile.publicAliases || [];
    bodyEl.appendChild(drawerField('aliases', 'Aliases', aliases.join(', '), aliases.join(', ')));
    bodyEl.appendChild(drawerField('active', 'Active', profile.active ? 'yes' : 'standby'));
    const nodes = lastStatus && Array.isArray(lastStatus.nodes) ? lastStatus.nodes : [];
    const servingNodes = nodes.filter((node) => node.metrics && Array.isArray(node.metrics.readyModels) && node.metrics.readyModels.some((model) => aliases.indexOf(model) >= 0));
    bodyEl.appendChild(drawerField('serving', 'Serving nodes', String(servingNodes.length), String(servingNodes.length)));
    servingNodes.forEach((node) => {
      const item = document.createElement('div');
      item.className = 'drawer-row';
      item.setAttribute('data-drawer-serving-node', node.id);
      item.textContent = node.id;
      bodyEl.appendChild(item);
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
      const details = document.createElement('button');
      details.type = 'button';
      details.className = 'btn btn-ghost';
      details.textContent = 'Details';
      details.dataset.action = 'model-detail';
      details.dataset.profileId = profile.id;
      row.appendChild(details);
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
      const serving = nodes.filter((node) => nodeTone(node) === 'ok').length;
      const vramMiB = nodes.reduce((total, node) => total + nodeVramTotal(node), 0);
      const toks = nodes.reduce((total, node) => total + nodeToks(node), 0);
      tiles.appendChild(tile('Nodes serving', serving + '/' + nodes.length, 'nodes'));
      tiles.appendChild(tile('Active models', String(profiles.filter((profile) => profile.active).length), 'models'));
      tiles.appendChild(tile('Mesh VRAM GB', String(Math.round(vramMiB / 1024)), 'vram'));
      tiles.appendChild(tile('Tokens/s', round1(toks), 'toks'));
      tiles.appendChild(tile('Gateway', [gateway.gatewayId, gateway.routeName].filter(Boolean).join(' / ') || 'not connected', 'gateway'));
      tiles.appendChild(tile('Custom domain', domain.hostname ? domain.hostname + ' · ' + (domain.status || 'unprovisioned') : 'not configured'));
      tiles.appendChild(tile('Fleet version', status.desiredAgentVersion || 'not pinned', 'version'));
    }
    renderTopology(nodes);
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
    lastStatus = status;
    renderNodesTable(nodes, status.desiredAgentVersion);
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
    if (prefix === 'wiz-') return wizardGatewayPayload();
    const value = (suffix) => readInput(prefix + 'gateway-' + suffix);
    const raw = { accountId: value('account-id'), gatewayId: value('id'), routeName: value('route-name'), publicModel: value('public-model'), providerName: value('provider-name'), workerUrl: value('worker-url') };
    return Object.fromEntries(Object.entries(raw).filter((pair) => pair[1]));
  };

  // --- wizard data loaders ----------------------------------------------------
  let accessEmails = [];
  const emailPattern = /^[^ @]+@[^ @]+[.][^ @]+$/;
  function renderEmailChips() {
    const list = byId('wizard-access-emails');
    if (!list) return;
    list.textContent = '';
    accessEmails.forEach((email) => {
      const item = document.createElement('li');
      item.className = 'email-chip';
      item.setAttribute('data-email-chip', email);
      const text = document.createElement('span');
      text.textContent = email;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn btn-ghost';
      remove.textContent = 'Remove';
      remove.setAttribute('data-remove-email', email);
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
  async function loadGatewayOptions(gatewayId) {
    const emptyPanel = byId('wizard-gateway-empty');
    const selects = byId('wizard-gateway-selects');
    if (!emptyPanel || !selects) return;
    const body = await request('/admin/cloudflare/gateway/options' + (gatewayId ? '?gateway=' + encodeURIComponent(gatewayId) : ''), { headers: headers(false) });
    const gateways = (body.gateways || []).map((gateway) => gateway.id);
    const routes = (body.routes || []).map((route) => route.name).filter(Boolean);
    const defaults = body.defaults || {};
    emptyPanel.hidden = gateways.length > 0;
    selects.hidden = gateways.length === 0;
    if (!gateways.length) return;
    const wantedGateway = gatewayId || defaults.gatewayId;
    const gatewayValue = gateways.indexOf(wantedGateway) >= 0 ? wantedGateway : '__new__';
    fillChoiceSelect('wiz-gateway-slot', 'wiz-gateway-select', 'gatewayId', 'data-gateway-select', gateways, gatewayValue, 'Create new gateway\u2026');
    toggleNewField('wiz-gateway-new-wrap', gatewayValue === '__new__');
    const routeValue = routes.indexOf(defaults.routeName) >= 0 ? defaults.routeName : '__new__';
    fillChoiceSelect('wiz-route-slot', 'wiz-route-select', 'routeName', 'data-route-select', routes, routeValue, 'Create new route\u2026');
    toggleNewField('wiz-route-new-wrap', routeValue === '__new__');
  }
  const wizardGatewayPayload = () => {
    const gatewaySelect = byId('wiz-gateway-select');
    const routeSelect = byId('wiz-route-select');
    const gatewayId = gatewaySelect && gatewaySelect.value && gatewaySelect.value !== '__new__' ? gatewaySelect.value : readInput('wiz-gateway-new');
    const routeName = routeSelect && routeSelect.value && routeSelect.value !== '__new__' ? routeSelect.value : readInput('wiz-route-new');
    const raw = { gatewayId, routeName, providerName: readInput('wiz-gateway-provider-name'), publicModel: readInput('wiz-gateway-public-model'), workerUrl: readInput('wiz-gateway-worker-url') };
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
    storeToken('', false);
    liveToken = '';
    setView('setup');
    setWizardStep('connect');
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
    'setup-domain': 'wizard-domain-output',
    'setup-access': 'wizard-access-output',
    'setup-complete': 'wizard-complete-output',
    'access-email-add': 'wizard-access-output',
    'gateway-provision-default': 'wiz-gateway-output',
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
      renderTokens(out, body);
      const next = byId('wizard-continue-connect');
      if (next) next.hidden = false;
      toast('Deployment claimed');
    } else if (action === 'access-email-add') {
      const input = byId('wizard-access-email');
      const email = input && input.value ? input.value.trim().toLowerCase() : '';
      if (!email || !emailPattern.test(email)) { setOutput('wizard-access-output', 'Enter a valid email address.', true); return; }
      if (accessEmails.indexOf(email) < 0) accessEmails.push(email);
      if (input) input.value = '';
      setOutput('wizard-access-output', '');
      renderEmailChips();
    } else if (action === 'setup-domain') {
      const zoneSelect = byId('wizard-domain-zone');
      const body = await request('/admin/setup/domain', { method: 'POST', headers: headers(true), body: JSON.stringify({ hostname: readInput('wizard-domain-hostname'), zoneId: zoneSelect && zoneSelect.value ? zoneSelect.value : '' }) });
      setOutput(out, body);
      toast('Custom domain provisioned');
      setWizardStep('access');
    } else if (action === 'setup-access') {
      const body = await request('/admin/setup/access', { method: 'POST', headers: headers(true), body: JSON.stringify({ emails: accessEmails }) });
      setOutput(out, body);
      const link = byId('wizard-handoff-link');
      if (link && body.consoleUrl) link.setAttribute('href', body.consoleUrl);
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
      setOutput(out, await request('/admin/cloudflare/gateway/sync', { method: 'POST', headers: headers(true), body: JSON.stringify({}) }));
      await loadGatewayOptions('').catch(() => undefined);
    } else if (action === 'nodes-sort') {
      const key = button.dataset.sort || 'id';
      nodeSort = { key: key, dir: nodeSort.key === key ? -nodeSort.dir : -1 };
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
    }
  }

  document.addEventListener('click', async (event) => {
    const copy = event.target.closest('[data-copy]');
    if (copy) { await navigator.clipboard.writeText(copy.dataset.copy || ''); toast('Copied'); return; }
    const removeEmail = event.target.closest('[data-remove-email]');
    if (removeEmail) { accessEmails = accessEmails.filter((email) => email !== removeEmail.dataset.removeEmail); renderEmailChips(); return; }
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
    const installer = event.target.closest('[data-installer-platform]');
    if (installer) {
      const prefix = installer.dataset.prefix || '';
      if (liveToken || onCustomDomain) loadInstaller(prefix, false).catch((error) => setOutput(prefix + 'installer-output', friendlyError('installer-generate', error), true));
      return;
    }
    const gatewaySelect = event.target.closest('[data-gateway-select]');
    if (gatewaySelect) {
      toggleNewField('wiz-gateway-new-wrap', gatewaySelect.value === '__new__');
      if (gatewaySelect.value !== '__new__') loadGatewayOptions(gatewaySelect.value).catch(() => undefined);
      return;
    }
    const routeSelect = event.target.closest('[data-route-select]');
    if (routeSelect) { toggleNewField('wiz-route-new-wrap', routeSelect.value === '__new__'); }
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
