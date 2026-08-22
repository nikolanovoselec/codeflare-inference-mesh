/**
 * The gateway state card, the playground target selector, and the model list.
 *
 * A fragment of the console script, not a standalone module: it is concatenated
 * verbatim into one IIFE by `../admin-ui-client`. Zero interpolation, by rule.
 */
export const CLIENT_PLAYGROUND = `\
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
    runtime: { llamacpp: { tone: 'red', label: 'llama.cpp' }, meshllm: { tone: 'green', label: 'meshllm' }, vllm: { tone: 'teal', label: 'vLLM' } },
    mode: { split: { tone: 'orange', label: 'sharded model' }, single: { tone: 'blue', label: 'singular model' } },
    mesh: { tone: 'purple' }
  };
  function pillEl(spec, attr, value, label) {
    const pill = chipEl(spec.tone, label === undefined ? spec.label : label);
    pill.setAttribute(attr, value);
    return pill;
  }
  function profilePills(profile, direct, split) {
    const runtime = PROFILE_PILLS.runtime[profile.runtime] ? profile.runtime : (direct ? 'llamacpp' : 'meshllm');
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
      // Fixed pill vocabulary: provider (llama.cpp = red, meshllm = green, vLLM = teal),
      // serving mode (singular = blue, sharded = orange), and mesh assignment (purple).
      // Combinations read side by side — e.g. a singular model on meshllm is green + blue.
      const direct = profile.runtime === 'llamacpp' || profile.runtime === 'vllm';
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
`
