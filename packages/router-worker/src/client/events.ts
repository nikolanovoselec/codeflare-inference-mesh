/**
 * The delegated listeners that turn a click, submit or change into an action.
 *
 * A fragment of the console script, not a standalone module: it is concatenated
 * verbatim into one IIFE by `../admin-ui-client`. Zero interpolation, by rule.
 */
export const CLIENT_EVENTS = `\

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
  // Contextual model guidance: single serving shows GGUF files, split shows layer
  // packages + the prepare guide, and the vLLM runtime shows plain-repository
  // guidance (CSS keys off the dataset). The reference example follows the same
  // context so the placeholder never demonstrates a format the server rejects.
  // REQ-ADM-025.
  function applyModelAddContext() {
    const mode = byId('model-add-mode');
    const runtime = byId('model-add-runtime');
    const split = !!mode && mode.value === 'split';
    const key = split ? 'split' : (runtime && runtime.value === 'vllm' ? 'vllm' : 'single');
    const sources = byId('model-add-sources');
    if (sources) sources.dataset.modelSources = key;
    const ref = byId('model-add-ref');
    if (ref) ref.placeholder = key === 'vllm' ? 'e.g. Qwen/Qwen3.8-27B-FP8' : 'e.g. unsloth/Qwen3-14B-GGUF:Q4_K_M';
  }

  document.addEventListener('change', (event) => {
    const search = event.target.closest('[data-node-search]');
    if (search) { applyNodeSearch(search.value); return; }
    const installer = event.target.closest('[data-installer-platform]');
    if (installer) {
      const prefix = installer.dataset.prefix || '';
      if (liveToken || onCustomDomain) loadInstaller(prefix).catch((error) => setOutput(prefix + 'installer-output', friendlyError('installer-generate', error), true));
      return;
    }
    const runtimeSource = event.target.closest('[data-runtime-source-select]');
    if (runtimeSource) {
      applyRuntimeSource(runtimeSource.value).catch((error) => setOutput('runtime-version-output', friendlyError('runtime-source-set', error), true));
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
      applyModelAddContext();
      return;
    }
    const addRuntimeSelect = event.target.closest('[data-model-add-runtime]');
    if (addRuntimeSelect) { applyModelAddContext(); return; }
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

`
