/**
 * Every console action, dispatched by its id.
 *
 * A fragment of the console script, not a standalone module: it is concatenated
 * verbatim into one IIFE by `../admin-ui-client`. Zero interpolation, by rule.
 */
export const CLIENT_ACTIONS = `\
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
  // Every console action, keyed by the id its button carries. The dispatcher below
  // resolves one handler from this table, so adding an action is a new entry rather
  // than another branch, and an unknown id is simply not handled.
  const ACTIONS = Object.create(null);
  const bindAction = (id, handler) => { if (id) ACTIONS[id] = handler; };
  bindAction('first-run-setup', async ({ action, button, prefix, out }) => {
      const body = await request('/admin/setup', { method: 'POST' });
      liveToken = body.adminToken || '';
      storeToken(liveToken, false);
      revealKey(out, 'Setup access token', liveToken, 'Save this. It is how you sign back into setup on this page until Access is live. Stored hashed and shown only once.');
      const next = byId('wizard-continue-connect');
      if (next) next.hidden = false;
      toast('Deployment claimed');
  });
  bindAction('access-ident-add', async ({ action, button, prefix, out }) => {
      const kind = button.dataset.identList === 'user' ? 'user' : 'admin';
      const input = byId(button.dataset.identInput || '');
      const raw = input && input.value ? input.value.trim() : '';
      const ident = isGroupIdent(raw) ? raw : raw.toLowerCase();
      if (!ident || (!isGroupIdent(ident) && !looksLikeEmail(ident))) { setOutput('wizard-access-output', 'Enter an email address or an Access group name.', true); return; }
      if (accessIdents[kind].indexOf(ident) < 0) accessIdents[kind].push(ident);
      if (input) input.value = '';
      setOutput('wizard-access-output', '');
      renderIdentChips(kind);
  });
  bindAction('setup-domain', async ({ action, button, prefix, out }) => {
      const zoneSelect = byId('wizard-domain-zone');
      const body = await request('/admin/setup/domain', { method: 'POST', headers: headers(true), body: JSON.stringify({ hostname: readInput('wizard-domain-hostname'), zoneId: zoneSelect && zoneSelect.value ? zoneSelect.value : '' }) });
      setOutput(out, body);
      toast('Custom domain provisioned');
      setWizardStep('access');
  });
  bindAction('setup-access', async ({ action, button, prefix, out }) => {
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
  });
  bindAction('setup-complete', async ({ action, button, prefix, out }) => {
      const body = await request('/admin/setup/complete', { method: 'POST', headers: headers(false) });
      if (onCustomDomain || !body.customDomain) {
        setOutput(out, body);
        showDashboard();
        toast('Setup complete');
      } else {
        setOutput(out, 'Setup complete. This bootstrap origin is now locked; continue at https://' + body.customDomain + '/admin');
      }
  });
  bindAction('gateway-provision-default', async ({ action, button, prefix, out }) => {
      revealGatewayKey(out, await request('/admin/cloudflare/gateway/sync', { method: 'POST', headers: headers(true), body: JSON.stringify({}) }));
      await loadGatewayOptions('', out === 'gateway-output' ? 'routing' : 'wizard').catch(() => undefined);
  });
  bindAction('nodes-sort', async ({ action, button, prefix, out }) => {
      const key = button.dataset.sort || 'id';
      nodeSort = { key: key, dir: nodeSort.key === key ? -nodeSort.dir : -1 };
      if (lastStatus) renderNodesTable(Array.isArray(lastStatus.nodes) ? lastStatus.nodes : [], lastStatus.desiredAgentVersion);
  });
  bindAction('nodes-filter', async ({ action, button, prefix, out }) => {
      nodeFilter = button.dataset.filter || 'all';
      ['all', 'ready', 'active', 'offline'].forEach((name) => {
        const chip = byId('node-filter-' + name);
        if (!chip) return;
        if (name === nodeFilter) chip.setAttribute('aria-current', 'page'); else chip.removeAttribute('aria-current');
      });
      if (lastStatus) renderNodesTable(Array.isArray(lastStatus.nodes) ? lastStatus.nodes : [], lastStatus.desiredAgentVersion);
  });
  bindAction('node-detail', async ({ action, button, prefix, out }) => {
      openNodeDrawer(button.dataset.nodeId || '');
  });
  bindAction('model-detail', async ({ action, button, prefix, out }) => {
      openModelDrawer(button.dataset.profileId || '');
  });
  const closeOpenDrawer = async ({ action, button, prefix, out }) => {
      closeDrawer();
  };
  bindAction(config.drawer.closeAction, closeOpenDrawer);
  bindAction('sign-out', async ({ action, button, prefix, out }) => {
      signOut();
  });
  bindAction('status-refresh', async ({ action, button, prefix, out }) => {
      await refreshStatus();
      toast('Status refreshed');
  });
  bindAction('setup-token-create', async ({ action, button, prefix, out }) => {
      const minted = await request('/admin/setup-tokens', { method: 'POST', headers: headers(false) });
      mintedSetupToken = minted.setupToken;
      renderTokens(out, minted);
      // One token per enrollment: fill the just-minted token into the displayed install command.
      await loadInstaller(prefix);
  });
  bindAction('gateway-sync', async ({ action, button, prefix, out }) => {
      revealGatewayKey(out, await request('/admin/cloudflare/gateway/sync', { method: 'POST', headers: headers(true), body: JSON.stringify(gatewayPayload(prefix)) }));
      // Refresh the selected gateway card only; a brand-new gateway (select still on
      // create-new) makes no extra call and updates on the next routing view.
      const rtSelect = byId('rt-gateway-select');
      await refreshProvisionChip(rtSelect ? rtSelect.value : '').catch(() => undefined);
  });
  bindAction('custom-domain-validate', async ({ action, button, prefix, out }) => {
      // Hostname only; the owning zone is matched server-side from the runtime token.
      await request('/admin/custom-domain/validate', { method: 'POST', headers: headers(true), body: JSON.stringify({ hostname: readInput('custom-domain') }) });
      setOutput(out, 'Domain provisioning requested.');
  });
  bindAction('node-revoke', async ({ action, button, prefix, out }) => {
      const nodeId = encodeURIComponent(button.dataset.nodeId || '');
      await request('/admin/nodes/' + nodeId + '/revoke', { method: 'POST', headers: headers(false) });
      setOutput(out, 'Machine revoked.');
      await refreshStatus().catch(() => undefined);
  });
  bindAction('node-reload', async ({ action, button, prefix, out }) => {
      const nodeId = encodeURIComponent(button.dataset.nodeId || '');
      await request('/admin/nodes/' + nodeId + '/reload', { method: 'POST', headers: headers(false) });
      setOutput(out, 'Force reload requested.');
      await refreshStatus().catch(() => undefined);
  });
  const setNodeActivation = async ({ action, button, prefix, out }) => {
      const nodeId = encodeURIComponent(button.dataset.nodeId || '');
      const verb = action === 'node-deactivate' ? 'deactivate' : 'activate';
      await request('/admin/nodes/' + nodeId + '/' + verb, { method: 'POST', headers: headers(false) });
      setOutput(out, action === 'node-activate' ? 'Machine activated.' : 'Machine deactivated.');
      await refreshStatus().catch(() => undefined);
  };
  bindAction('node-deactivate', setNodeActivation);
  bindAction('node-activate', setNodeActivation);
  bindAction('node-config-save', async ({ action, button, prefix, out }) => {
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
  });
  bindAction('model-toggle', async ({ action, button, prefix, out }) => {
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
  });
  // Every tunable field reads the same way: blank means Auto, so it clears to null
  // rather than pinning a stale value, and the server merge is idempotent.
  const numberOrNull = (id) => { const raw = readInput(id); return raw === '' ? null : Number(raw); };
  // Both runtimes expose reasoning as the same three fields under their own prefix.
  const readReasoning = (base) => {
    const raw = readInput(base + '-reasoning');
    if (raw === '') return null;
    const format = readInput(base + '-reasoning-format');
    const budget = readInput(base + '-reasoning-budget');
    return { enabled: raw === 'on', format: format === '' ? null : format, budget: budget === '' ? null : Number(budget) };
  };
  const llamaCppTunables = () => {
    const parallelRaw = readInput('model-edit-llama-parallel');
    const cacheReuseRaw = readInput('model-edit-llama-cache-reuse');
    const flashRaw = readInput('model-edit-llama-flash');
    const mmprojRaw = readInput('model-edit-llama-mmproj');
    const gpuLayersRaw = readInput('model-edit-llama-gpu-layers');
    return {
      parallel: parallelRaw === '' ? -1 : Number(parallelRaw),
      kvUnified: readInput('model-edit-llama-kv-unified') !== 'off',
      cacheReuse: cacheReuseRaw === '' ? 256 : Number(cacheReuseRaw),
      cachePrompt: readInput('model-edit-llama-cache-prompt') !== 'off',
      cacheTypeK: readInput('model-edit-llama-cache-k'),
      cacheTypeV: readInput('model-edit-llama-cache-v'),
      batch: numberOrNull('model-edit-llama-batch'),
      ubatch: numberOrNull('model-edit-llama-ubatch'),
      flashAttn: flashRaw === '' ? null : flashRaw === 'on',
      mmproj: mmprojRaw === '' ? null : mmprojRaw === 'on',
      maxOutputTokens: numberOrNull('model-edit-llama-maxout'),
      gpuLayers: gpuLayersRaw === '' ? null : gpuLayersRaw,
      reasoning: readReasoning('model-edit-llama')
    };
  };
  const meshllmTunables = () => {
    const flashRaw = readInput('model-edit-flash');
    const wireRaw = readInput('model-edit-wire-dtype');
    const chunkingRaw = readInput('model-edit-prefill-chunking');
    return {
      parallel: numberOrNull('model-edit-parallel'),
      cacheTypeK: readInput('model-edit-cache-k'),
      cacheTypeV: readInput('model-edit-cache-v'),
      batch: numberOrNull('model-edit-batch'),
      ubatch: numberOrNull('model-edit-ubatch'),
      flashAttn: flashRaw === '' ? null : flashRaw === 'on',
      maxOutputTokens: numberOrNull('model-edit-maxout'),
      reasoning: readReasoning('model-edit'),
      toolEmulation: readInput('model-edit-tool-emulation') === 'emulated' ? true : null,
      wireDtype: wireRaw === '' ? null : wireRaw,
      prefillChunking: chunkingRaw === '' ? null : chunkingRaw,
      prefillChunkSize: numberOrNull('model-edit-prefill-chunk-size')
    };
  };
  const vllmTunables = () => {
    const gpuMemRaw = readInput('model-edit-vllm-gpu-mem');
    // A typo'd fraction must reach the router as-is and be rejected there: NaN
    // serialises to JSON null, which the router reads as "clear the setting".
    const gpuMem = Number(gpuMemRaw);
    const dtypeRaw = readInput('model-edit-vllm-dtype');
    const quantRaw = readInput('model-edit-vllm-quant');
    return {
      maxNumSeqs: numberOrNull('model-edit-vllm-max-num-seqs'),
      gpuMemoryUtilization: gpuMemRaw === '' ? null : (Number.isFinite(gpuMem) ? gpuMem : gpuMemRaw),
      dtype: dtypeRaw === '' ? null : dtypeRaw,
      quantization: quantRaw === '' ? null : quantRaw
    };
  };
  const modelSavePayload = (button) => {
    const runtime = button.dataset.runtime || 'meshllm';
    const payload = { profileId: button.dataset.profileId || '', runtime: runtime };
    // Mesh reassignment rides the same save, sent only when actually changed.
    const meshEl = byId('model-edit-mesh');
    if (meshEl && meshEl.value && meshEl.value !== meshEl.dataset.original) payload.meshId = meshEl.value;
    // Blank = Auto for both runtimes: 0 lets mesh-llm auto-plan and renders
    // --ctx-size 0 for llama.cpp (the model's native context).
    const ctxRaw = readInput('model-edit-context');
    payload.contextWindow = ctxRaw === '' ? 0 : Number(ctxRaw);
    const modelRaw = readInput('model-edit-model');
    if (modelRaw !== '') payload.modelRef = modelRaw;
    // Empty means "leave as-is"; 0 explicitly clears the mesh-llm cap. Direct runtimes
    // (llama.cpp, vLLM) do not use this mesh-only VRAM budget.
    const vramRaw = readInput('model-edit-vram');
    if (runtime !== 'llamacpp' && runtime !== 'vllm' && vramRaw !== '') payload.maxVramGb = Number(vramRaw);
    // Only send name / call name when the operator actually changed them, so saving
    // an unrelated setting never rewrites a default model's extra canonical aliases.
    const nameEl = byId('model-edit-name');
    const callEl = byId('model-edit-callname');
    if (nameEl && nameEl.value.trim() && nameEl.value !== nameEl.dataset.original) payload.name = nameEl.value.trim();
    if (callEl && callEl.value.trim() && callEl.value !== callEl.dataset.original) payload.callName = callEl.value.trim();
    if (runtime === 'llamacpp') payload.llamacpp = llamaCppTunables();
    else if (runtime === 'vllm') payload.vllm = vllmTunables();
    else Object.assign(payload, meshllmTunables());
    return payload;
  };
  const saveModelFromDrawer = async ({ button, out }) => {
    const payload = modelSavePayload(button);
    await request('/admin/profiles/config', { method: 'POST', headers: headers(true), body: JSON.stringify(payload) });
    setOutput(out, 'Model settings saved.');
    toast('Model settings saved');
    await refreshStatus().catch(() => undefined);
  };
  bindAction('model-save', saveModelFromDrawer);
  bindAction('model-duplicate', async ({ action, button, prefix, out }) => {
      const id = button.dataset.profileId || '';
      await request('/admin/profiles/duplicate', { method: 'POST', headers: headers(true), body: JSON.stringify({ profileId: id }) });
      setOutput(out, 'Model duplicated.');
      closeDrawer();
      await refreshStatus().catch(() => undefined);
      toast('Model duplicated');
  });
  bindAction('model-delete', async ({ action, button, prefix, out }) => {
      const id = button.dataset.profileId || '';
      await request('/admin/profiles/delete', { method: 'POST', headers: headers(true), body: JSON.stringify({ profileId: id }) });
      setOutput(out, 'Model deleted.');
      closeDrawer();
      await refreshStatus().catch(() => undefined);
      toast('Model deleted');
  });
  bindAction('mesh-create', async ({ action, button, prefix, out }) => {
      const nameEl = byId('mesh-create-name');
      const name = nameEl ? nameEl.value.trim() : '';
      await request('/admin/meshes', { method: 'POST', headers: headers(true), body: JSON.stringify({ name: name }) });
      if (nameEl) nameEl.value = '';
      const meshDisclosure = byId('mesh-add-details');
      if (meshDisclosure) meshDisclosure.open = false;
      setOutput(out, 'Mesh created.');
      toast('Mesh created');
      await refreshStatus().catch(() => undefined);
  });
  bindAction('mesh-delete', async ({ action, button, prefix, out }) => {
      const meshId = encodeURIComponent(button.dataset.meshId || '');
      await request('/admin/meshes/' + meshId, { method: 'DELETE', headers: headers(false) });
      setOutput(out, 'Mesh deleted.');
      toast('Mesh deleted');
      await refreshStatus().catch(() => undefined);
  });
  bindAction('api-key-create', async ({ action, button, prefix, out }) => {
      revealApiKey(await request('/api/v1/keys', { method: 'POST', headers: headers(true), body: JSON.stringify({}) }));
      await loadApiKeys().catch(() => undefined);
  });
  bindAction('api-key-rotate', async ({ action, button, prefix, out }) => {
      const keyId = encodeURIComponent(button.dataset.keyId || '');
      revealApiKey(await request('/api/v1/keys/' + keyId + '/rotate', { method: 'POST', headers: headers(true), body: JSON.stringify({}) }));
      await loadApiKeys().catch(() => undefined);
  });
  bindAction('api-key-revoke', async ({ action, button, prefix, out }) => {
      const keyId = encodeURIComponent(button.dataset.keyId || '');
      await request('/api/v1/keys/' + keyId, { method: 'DELETE', headers: headers(false) });
      toast('API key revoked');
      await loadApiKeys().catch(() => undefined);
  });
  bindAction('agent-versions-refresh', async ({ action, button, prefix, out }) => {
      await loadVersions();
  });
  bindAction('agent-version-set', async ({ action, button, prefix, out }) => {
      const select = byId(config.agentVersion.selectId);
      await request('/admin/agent-version', { method: 'POST', headers: headers(true), body: JSON.stringify({ version: select ? select.value : '' }) });
      setOutput(out, 'Agent version saved.');
  });
  bindAction('runtime-versions-refresh', async ({ action, button, prefix, out }) => {
      await loadRuntimeVersions();
  });
  bindAction('runtime-versions-set', async ({ action, button, prefix, out }) => {
      const meshllm = byId(config.runtimeVersion.meshllmSelectId);
      const llamacpp = byId(config.runtimeVersion.llamacppSelectId);
      const vllm = byId(config.runtimeVersion.vllmSelectId);
      // The vllm key rides only when a version is actually selected: an empty
      // select (list response without vllm) must mean "leave as-is", not a 400.
      const versionsBody = { meshllm: meshllm ? meshllm.value : '', llamacpp: llamacpp ? llamacpp.value : '' };
      if (vllm && vllm.value) versionsBody.vllm = vllm.value;
      await request('/admin/runtime-versions', { method: 'POST', headers: headers(true), body: JSON.stringify(versionsBody) });
      setOutput(out, 'Runtime versions saved.');
  });
  bindAction('settings-save', async ({ action, button, prefix, out }) => {
      await request('/admin/settings', { method: 'POST', headers: headers(true), body: JSON.stringify({ offlinePruneSeconds: Number(readInput('prune-seconds')) }) });
      setOutput(out, 'Settings saved.');
      toast('Settings saved');
  });
  bindAction('mesh-rotate', async ({ action, button, prefix, out }) => {
      // The reset control lives in a model's Manage drawer and carries its profile id.
      const profileId = button.dataset.profileId || '';
      await request('/admin/mesh/rotate', { method: 'POST', headers: headers(true), body: JSON.stringify({ profileId }) });
      setOutput(out, 'Sharing key reset.');
      await refreshStatus().catch(() => undefined);
  });
  bindAction('model-add', async ({ action, button, prefix, out }) => {
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
  });
  const runPlaygroundSpeedTest = async ({ action, button, prefix, out }) => {
      const target = byId(config.playground.targetSelectId);
      const targetValue = target && target.value ? target.value : config.playground.directValue;
      const select = byId(config.playground.selectId);
      const model = targetValue === config.playground.directValue && select && select.value ? select.value : STABLE_PUBLIC_MODEL;
      setOutput(out, 'Running speed test...');
      setOutput(out, await request(config.playground.speedPath, { method: 'POST', headers: headers(true), body: JSON.stringify({ model }) }));
      await refreshStatus().catch(() => undefined);
  };
  bindAction(config.playground.speedAction, runPlaygroundSpeedTest);
  // What the playground is about to send, or null once the reason it cannot has been shown.
  const playgroundRequest = (out) => {
      const target = byId(config.playground.targetSelectId);
      const targetValue = target && target.value ? target.value : config.playground.directValue;
      const select = byId(config.playground.selectId);
      const choice = select ? select.value : '';
      const prompt = readInput(config.playground.promptId);
      if (!prompt) { setOutput(out, 'Enter a prompt to send.', true); return null; }
      // Optional tools JSON reproduces an agentic (tool-calling) request on the real route.
      let tools;
      const toolsRaw = readInput(config.playground.toolsId);
      if (toolsRaw) {
        try {
          const parsedTools = JSON.parse(toolsRaw);
          if (Array.isArray(parsedTools) && parsedTools.length) tools = parsedTools;
          else { setOutput(out, 'Tools must be a non-empty JSON array.', true); return null; }
        } catch (toolsError) { setOutput(out, 'Tools is not valid JSON.', true); return null; }
      }
      const maxRaw = readInput(config.playground.maxTokensId);
      const maxTokens = maxRaw === '' ? undefined : Number(maxRaw);
      const messages = [{ role: 'user', content: prompt }];
      // Direct target -> router scheduler with an internal model; gateway target -> that gateway's
      // compat endpoint with the selected dynamic route.
      const direct = targetValue === config.playground.directValue;
      const payload = direct ? { model: choice, messages: messages, user: playgroundSessionUser() } : { gatewayId: targetValue, route: choice, messages: messages, user: playgroundSessionUser() };
      if (tools) payload.tools = tools;
      if (maxTokens) payload.maxTokens = maxTokens;
      return { path: direct ? config.playground.directPath : config.playground.gatewayPath, payload: payload };
  };
  const sendPlaygroundPrompt = async ({ out }) => {
      const request_ = playgroundRequest(out);
      if (!request_) return;
      // The Stop button aborts this controller; a new send supersedes any running stream.
      if (playgroundController) playgroundController.abort();
      playgroundController = new AbortController();
      const controller = playgroundController;
      let response;
      try {
        response = await fetch(request_.path, { method: 'POST', headers: headers(true), body: JSON.stringify(request_.payload), signal: controller.signal });
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
      const appendChunk = chunkAppender(out);
      const streamed = await readPlaygroundStream(response, appendChunk, controller);
      // Surface tool calls and a non-stop finish so the operator can confirm the model
      // actually invoked tools on the dynamic route (#17).
      const toolKeys = Object.keys(streamed.toolCalls);
      if (toolKeys.length) appendChunk('\\n\\n[tool calls] ' + toolKeys.map((key) => streamed.toolCalls[key].name + '(' + streamed.toolCalls[key].args + ')').join(', '));
      if (streamed.finishReason && streamed.finishReason !== 'stop') appendChunk('\\n\\n[finish_reason: ' + streamed.finishReason + ']');
      if (playgroundController === controller) playgroundController = null;
  };
  // One text node per run, so a selection the operator makes mid-stream survives;
  // reassigning textContent per delta would wipe it (#19).
  const chunkAppender = (out) => {
      const outputEl = byId(out);
      let textNode = null;
      return (str) => {
        if (!outputEl || !str) return;
        if (!textNode) { outputEl.textContent = ''; textNode = document.createTextNode(''); outputEl.appendChild(textNode); }
        textNode.appendData(str);
      };
  };
  // Read the event stream, appending content as it arrives, and collect what only makes
  // sense once it ends: the tool calls the model asked for and why it stopped.
  const readPlaygroundStream = async (response, appendChunk, controller) => {
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
      return { toolCalls: toolAcc, finishReason: finishReason };
  };
  bindAction(config.playground.sendAction, sendPlaygroundPrompt);
  const stopPlayground = async ({ action, button, prefix, out }) => {
      if (playgroundController) { playgroundController.abort(); toast('Playground stopped'); }
      else { toast('Nothing is running'); }
  };
  bindAction(config.playground.stopAction, stopPlayground);
  async function runAction(action, button) {
    const handler = ACTIONS[action];
    if (!handler) return;
    await handler({ action, button, prefix: button.dataset.prefix || '', out: button.dataset.out || defaultOut[action] || '' });
  }
`
