/**
 * The panels fed by /admin/status: overview, meshes, versions and API keys.
 *
 * A fragment of the console script, not a standalone module: it is concatenated
 * verbatim into one IIFE by `../admin-ui-client`. Zero interpolation, by rule.
 */
export const CLIENT_STATUS_PANELS = `\
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
        const pills = profilePills(model, model.runtime === 'llamacpp' || model.runtime === 'vllm', Boolean(model.meshllm && model.meshllm.split));
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
    // The mesh-llm source selector: two options (official upstream, configured fork)
    // when a fork is available, hidden entirely when none is configured.
    const populateSource = () => {
      const select = byId(config.runtimeVersion.meshllmSourceSelectId);
      if (!select) return;
      const info = view && view.meshllm ? view.meshllm : {};
      const fork = info.forkRepository || '';
      select.textContent = '';
      select.setAttribute('data-runtime-source-select', 'meshllm');
      select.setAttribute('data-source-available', fork ? 'true' : 'false');
      select.hidden = !fork;
      if (!fork) { select.disabled = true; return; }
      const addOption = (value, label) => {
        const option = document.createElement('option');
        option.value = value;
        option.setAttribute('data-runtime-source-option', value);
        option.textContent = label;
        if (info.source === value) option.selected = true;
        select.appendChild(option);
      };
      addOption('official', 'Official — ' + (info.officialRepository || 'Mesh-LLM/mesh-llm'));
      addOption('fork', 'Fork — ' + fork);
      select.disabled = false;
      select.value = info.source === 'fork' ? 'fork' : 'official';
    };
    const meshReady = populate('meshllm', config.runtimeVersion.meshllmSelectId);
    const llamaReady = populate('llamacpp', config.runtimeVersion.llamacppSelectId);
    const vllmReady = populate('vllm', config.runtimeVersion.vllmSelectId);
    populateSource();
    if (meshReady && llamaReady && vllmReady) return;
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
      makeSelect('llamacpp', 'llama.cpp version', config.runtimeVersion.llamacppSelectId),
      makeSelect('vllm', 'vLLM version', config.runtimeVersion.vllmSelectId)
    );
    slot.appendChild(grid);
    populate('meshllm', config.runtimeVersion.meshllmSelectId);
    populate('llamacpp', config.runtimeVersion.llamacppSelectId);
    populate('vllm', config.runtimeVersion.vllmSelectId);
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
  // Switching the binary source changes which version tags are valid, so persist the
  // source on its own and reload the version list from the newly active repository.
  async function applyRuntimeSource(source) {
    await request('/admin/runtime-versions', { method: 'POST', headers: headers(true), body: JSON.stringify({ meshllmSource: source }) });
    await loadRuntimeVersions();
    setOutput('runtime-version-output', 'MeshLLM binary source set to ' + source + '.');
  }
  async function loadRuntimeVersions() {
    const view = await request('/admin/runtime-versions', { headers: headers(false) });
    renderRuntimeVersions(view);
    const meshCount = view && view.meshllm && view.meshllm.tags ? view.meshllm.tags.length : 0;
    const llamaCount = view && view.llamacpp && view.llamacpp.tags ? view.llamacpp.tags.length : 0;
    const vllmCount = view && view.vllm && view.vllm.tags ? view.vllm.tags.length : 0;
    const stale = (view && view.meshllm && view.meshllm.stale) || (view && view.llamacpp && view.llamacpp.stale) || (view && view.vllm && view.vllm.stale);
    setOutput('runtime-version-output', 'Loaded ' + meshCount + ' MeshLLM, ' + llamaCount + ' llama.cpp, and ' + vllmCount + ' vLLM versions' + (stale ? ' (list may be out of date)' : ''));
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

`
