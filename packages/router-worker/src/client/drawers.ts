/**
 * The slide-over drawers for one node and one model.
 *
 * A fragment of the console script, not a standalone module: it is concatenated
 * verbatim into one IIFE by `../admin-ui-client`. Zero interpolation, by rule.
 */
export const CLIENT_DRAWERS = `\
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
    const isDirectRuntime = node.runtime === 'llamacpp' || metrics.runtimeKind === 'llamacpp' || node.runtime === 'vllm' || metrics.runtimeKind === 'vllm';
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
    } else {
      const degraded = degradedRuntimeError(node);
      if (degraded) {
        const errRow = drawerField('runtime-detail', 'Recent runtime error', degraded);
        errRow.setAttribute('data-tone', 'warn');
        bodyEl.appendChild(errRow);
      }
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
    if (workState) bodyEl.appendChild(drawerField('work-state', 'Work state', workState, nodeWorkStateToken(metrics)));
    if (!isDirectRuntime || metrics.meshRole || (metrics.stageCount || 0) > 0) bodyEl.appendChild(drawerField('mesh-role', 'Mesh role', nodeMeshRoleLabel(metrics) || 'not reported', nodeMeshRoleToken(metrics)));
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
    // The backend family (vulkan on a Linux NVIDIA box, not the requested
    // nvidia) is what the node actually runs, so it reads next to the version.
    if (metrics.llamacppVersion && (metrics.llamacppBackend || !(install.runtime === 'llamacpp' && install.installedVersion))) {
      const backend = metrics.llamacppBackend ? ' · ' + metrics.llamacppBackend : '';
      bodyEl.appendChild(drawerField('llamacpp', 'llama.cpp', metrics.llamacppVersion + backend, metrics.llamacppVersion + backend));
    }
    if (metrics.vllmVersion) bodyEl.appendChild(drawerField('vllm', 'vLLM', metrics.vllmVersion, metrics.vllmVersion));
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
      // Multimodal loading can disable llama.cpp's cross-divergence reuse
      // optimization without affecting ordinary text prefix caching.
      const reuseNote = metrics.multimodal === true ? ' · cross-divergence reuse unavailable for multimodal' : (metrics.cacheReuse != null ? ' · reuse ' + metrics.cacheReuse : '');
      bodyEl.appendChild(drawerField('direct-cache', 'Prompt cache', cacheState + reuseNote));
      bodyEl.appendChild(drawerField('direct-cached-tokens', 'Last cached tokens', reportedText(metrics.cachedTokensLast), metrics.cachedTokensLast != null ? String(metrics.cachedTokensLast) : ''));
      // Current agents clear startup failures at readiness, so a subsequently
      // reported error remains current even if the runtime still serves.
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
    pillRow.append(...profilePills(profile, profile.runtime === 'llamacpp' || profile.runtime === 'vllm', Boolean(profile.meshllm && profile.meshllm.split)));
    bodyEl.appendChild(pillRow);
    bodyEl.appendChild(drawerField('active', 'Status', profile.active ? 'On' : 'Off'));
    bodyEl.appendChild(drawerField('runtime', 'Runtime', profile.runtime === 'llamacpp' ? 'llama.cpp' : (profile.runtime === 'vllm' ? 'vLLM' : 'meshllm'), profile.runtime || 'meshllm'));
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
    const vllm = profile.vllm || {};
    const isDirect = profile.runtime === 'llamacpp';
    const isVllm = profile.runtime === 'vllm';
    const blockCtx = isDirect ? llamacpp.contextWindow : (isVllm ? vllm.contextWindow : 0);
    const effectiveCtx = blockCtx || profile.contextWindow;
    const ctxRow = document.createElement('label');
    ctxRow.className = 'drawer-row';
    ctxRow.textContent = 'Context window (tokens)';
    const ctxInput = document.createElement('input');
    ctxInput.id = 'model-edit-context';
    ctxInput.type = 'number';
    ctxInput.min = isDirect || isVllm ? '4096' : '0';
    ctxInput.placeholder = 'Auto';
    // 0 = Auto, shown as a blank field: the runtime sizes the context itself.
    ctxInput.value = effectiveCtx ? String(effectiveCtx) : '';
    ctxRow.appendChild(ctxInput);
    ctxRow.appendChild(drawerHint(isDirect ? 'Max tokens kept in llama.cpp context. Blank = Auto (llama.cpp loads the native model context). Pin a number (4096 or higher) to cap it; larger uses more GPU memory.' : (isVllm ? 'Max tokens kept in vLLM context (--max-model-len). Blank = Auto (vLLM derives it from the model). Pin a number (4096 or higher) to cap it; larger reserves more KV memory.' : 'Max tokens kept in context. Blank = Auto (mesh-llm sizes it to the GPU). Pin a number (e.g. 262144) to fix it; larger uses more GPU memory and may leave room for fewer lanes.')));
    bodyEl.appendChild(ctxRow);
    const modelRow = document.createElement('label');
    modelRow.className = 'drawer-row';
    modelRow.textContent = 'Model file';
    const modelInput = document.createElement('input');
    modelInput.id = 'model-edit-model';
    modelInput.type = 'text';
    modelInput.value = (profile.llamacpp && profile.llamacpp.modelRef) || (profile.vllm && profile.vllm.hfRepo) || (profile.meshllm && profile.meshllm.modelRef) || '';
    modelRow.appendChild(modelInput);
    bodyEl.appendChild(modelRow);
    // What the node actually launches, derived from the reference above: the agent
    // reads hfRepo/quant, never the reference itself, so this read-only row shows
    // the effective source before a save (REQ-RUN-013).
    if (isDirect) {
      const quantPart = llamacpp.quant ? ':' + llamacpp.quant : '';
      const source = (llamacpp.hfRepo || '') + quantPart + (llamacpp.hfFile ? ' · ' + llamacpp.hfFile : '');
      bodyEl.appendChild(drawerField('model-source', 'Launch source', source, source));
    }
    if (isVllm) bodyEl.appendChild(drawerField('model-source', 'Launch source', vllm.hfRepo || '', vllm.hfRepo || ''));
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
    if (!isDirect && !isVllm) bodyEl.appendChild(vramRow);
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
      bodyEl.appendChild(meshTunableSelectRow({ id: 'model-edit-wire-dtype', label: 'Stage wire precision', value: meshllm.wireDtype || '', options: [{ value: '', label: 'Auto' }, { value: 'q8', label: 'q8 (least traffic)' }, { value: 'f16', label: 'f16 (full precision)' }, { value: 'f32', label: 'f32 (heaviest)' }], hint: 'Numeric precision of activation data streamed between split stages over WARP. q8 halves traffic vs f16 with minimal quality impact, keeping the stage link responsive under load. Single-machine models ignore this.' }));
      bodyEl.appendChild(meshTunableSelectRow({ id: 'model-edit-prefill-chunking', label: 'Prefill pacing', value: meshllm.prefillChunking || '', options: [{ value: '', label: 'Auto' }, { value: 'adaptive-ramp', label: 'Adaptive ramp' }, { value: 'fixed', label: 'Fixed chunks' }], hint: 'How long-prompt ingestion is spread across the split. Adaptive ramp paces the bursts so the WARP stage link never queues up and drops a machine mid-request. Single-machine models ignore this.' }));
      bodyEl.appendChild(meshTunableNumberRow({ id: 'model-edit-prefill-chunk-size', label: 'Prefill chunk size', value: meshllm.prefillChunkSize, placeholder: 'Auto', hint: 'Tokens per prefill chunk under Fixed pacing. Lower keeps WARP traffic smoother at slower ingestion. Blank = runtime default.' }));
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
      bodyEl.appendChild(meshTunableSelectRow({ id: 'model-edit-llama-mmproj', label: 'Multimodal projector', value: llamacpp.mmproj === false ? 'off' : 'on', options: [{ value: 'on', label: 'On (auto)' }, { value: 'off', label: 'Off (--no-mmproj)' }], hint: 'llama.cpp --no-mmproj. On lets llama.cpp auto-load the multimodal projector when the model is one (a coding workload pays its VRAM for nothing); Off opts the model out of the projector.' }));
      bodyEl.appendChild(meshTunableNumberRow({ id: 'model-edit-llama-maxout', label: 'Generation cap (-n / --predict)', value: llamacpp.maxOutputTokens, placeholder: '16384', hint: 'llama.cpp server-side default/max tokens to predict. Requests may still pass max_tokens; keep this above the reasoning budget so answers are not cut off.' }));
      bodyEl.appendChild(meshTunableSelectRow({ id: 'model-edit-llama-cache-prompt', label: 'Prompt cache', value: llamacpp.cachePrompt === false ? 'off' : 'on', options: [{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }], hint: 'Keep on for coding-session KV reuse.' }));
      bodyEl.appendChild(meshTunableNumberRow({ id: 'model-edit-llama-cache-reuse', label: 'Cache reuse', value: llamacpp.cacheReuse, placeholder: '256', min: 0, hint: 'llama.cpp --cache-reuse value for prompt/KV reuse.' }));
      bodyEl.appendChild(meshTunableSelectRow({ id: 'model-edit-llama-reasoning', label: 'Reasoning', value: reasoningValue, options: onOffOptions, hint: 'llama.cpp --reasoning for thinking-capable chat templates. Turn it off for lower latency when a thinking trace is not needed.' }));
      bodyEl.appendChild(meshTunableRowText({ id: 'model-edit-llama-reasoning-format', label: 'Reasoning format', value: reasoning.format || '', placeholder: 'deepseek', hint: 'llama.cpp --reasoning-format. Use the format expected by the model template.' }));
      bodyEl.appendChild(meshTunableNumberRow({ id: 'model-edit-llama-reasoning-budget', label: 'Reasoning budget', value: reasoning.budget, placeholder: '8192', hint: 'llama.cpp --reasoning-budget. Part of the output budget; higher values allow longer thinking and can delay the final answer.' }));
    }
    if (isVllm) {
      // vLLM's model-derived defaults are good; every tunable is Auto-clearable
      // (blank saves null, which removes the flag so the engine decides). REQ-RUN-021.
      bodyEl.appendChild(meshTunableNumberRow({ id: 'model-edit-vllm-max-num-seqs', label: 'Max concurrent sequences', value: vllm.maxNumSeqs, placeholder: 'Auto', hint: 'vLLM --max-num-seqs. Caps how many requests the continuous batcher runs at once. Blank = Auto (vLLM plans it from KV memory).' }));
      bodyEl.appendChild(meshTunableRowText({ id: 'model-edit-vllm-gpu-mem', label: 'GPU memory utilization', value: vllm.gpuMemoryUtilization != null ? String(vllm.gpuMemoryUtilization) : '', placeholder: '0.92', hint: 'vLLM --gpu-memory-utilization, a fraction between 0 and 1 of VRAM the engine may claim. Blank = Auto (0.92). Lower it when the GPU is shared.' }));
      bodyEl.appendChild(meshTunableSelectRow({ id: 'model-edit-vllm-dtype', label: 'Compute dtype', value: vllm.dtype || '', options: [{ value: '', label: 'Auto' }, { value: 'auto', label: 'auto' }, { value: 'half', label: 'half' }, { value: 'float16', label: 'float16' }, { value: 'bfloat16', label: 'bfloat16' }, { value: 'float', label: 'float' }, { value: 'float32', label: 'float32' }], hint: 'vLLM --dtype. Auto follows the checkpoint; half is required on pre-Ampere GPUs (compute capability below 8.0) for bf16 checkpoints.' }));
      bodyEl.appendChild(meshTunableRowText({ id: 'model-edit-vllm-quant', label: 'Quantization method', value: vllm.quantization || '', placeholder: 'Auto-detect', hint: 'vLLM --quantization override (awq, gptq, fp8, …). Blank = Auto (vLLM detects the method from the checkpoint).' }));
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
`
