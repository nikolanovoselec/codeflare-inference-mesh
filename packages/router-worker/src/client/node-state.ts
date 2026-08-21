/**
 * What state a node is in: status vocabulary, tone, runtime errors and install status.
 *
 * A fragment of the console script, not a standalone module: it is concatenated
 * verbatim into one IIFE by `../admin-ui-client`. Zero interpolation, by rule.
 */
export const CLIENT_NODE_STATE = `\
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
  // A leveled chatter line (warn/info/debug/trace without a hard error token) is never a
  // live degradation signal; old agents forwarded such lines before the stderr gate
  // learned whole-word levels.
  // llama.cpp spells its level as a bare leading letter ("355.41.434.230 W srv alloc: ...")
  // where mesh-llm spells it out, and nodes keep forwarding those lines until their agent
  // updates. Only the leading fields carry the level, so a capital inside message text
  // ("I/O failed") stays a real error.
  // This gate filters by level alone. Whether a line is an error at all is the agent's
  // decision: it owns the marker list, and duplicating that list here would only let the
  // two copies drift. The strong-marker override is unanchored at its end to match the
  // agent, which treats an inflected marker ("panicked at") as the hard token it carries.
  const letterLevelChatter = (detail) => detail.trim().split(/\\s+/).slice(0, 2).some((field) => field === 'W' || field === 'I' || field === 'D');
  const chatterDetail = (detail) => (/\\b(warn|info|debug|trace)\\b/i.test(detail) || letterLevelChatter(detail)) && !/\\b(error|fatal|panic)/i.test(detail);
  // Current agents clear startup errors at readiness, so any later captured line is
  // a current degradation even when the runtime still serves. Chatter remains hidden.
  function degradedRuntimeError(node) {
    if (node.status !== 'online' || node.deactivated) return '';
    const metrics = node.metrics || {};
    const detail = metrics.runtimeDetail || '';
    if (!detail || chatterDetail(detail)) return '';
    return detail;
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
  // State first, copy second. The data attributes carry these tokens, so a test asserts
  // which state a node is in rather than how the state is worded, and rewording a label
  // never breaks a test. Unknown values fall through as their own token.
  const MESH_ROLE_LABELS = { 'stage-owner': 'Stage owner', 'no-stage-assigned': 'No stage assigned', 'serving-peer': 'Serving peer', 'coordinator': 'Coordinator' };
  const WORK_STATE_LABELS = { 'serving-split-stage': 'Serving split stage', 'serving-model': 'Serving model', 'installing-runtime': 'Installing runtime', 'starting-model': 'Starting model', 'needs-attention': 'Needs attention', 'runtime-online': 'Runtime online' };
  function nodeMeshRoleToken(metrics) {
    if (!metrics) return '';
    if ((metrics.stageCount || 0) > 0 && metrics.meshRole !== 'coordinator') return 'stage-owner';
    if (!metrics.meshRole) return '';
    if (metrics.meshRole === 'api-client') return 'no-stage-assigned';
    return metrics.meshRole;
  }
  function nodeMeshRoleLabel(metrics) {
    const token = nodeMeshRoleToken(metrics);
    return token ? (MESH_ROLE_LABELS[token] || humanizeKey(token)) : '';
  }
  function nodeWorkStateToken(metrics) {
    if (!metrics) return '';
    if ((metrics.stageCount || 0) > 0 && metrics.apiReady === true && metrics.consoleReady === true) return 'serving-split-stage';
    if (Array.isArray(metrics.readyModels) && metrics.readyModels.length > 0) return 'serving-model';
    if (metrics.runtimeState === 'downloading') return 'installing-runtime';
    if (metrics.runtimeState === 'starting' || metrics.runtimeState === 'loading') return 'starting-model';
    if (metrics.runtimeState === 'failed' || metrics.runtimeState === 'dependency-missing') return 'needs-attention';
    if (metrics.apiReady === true || metrics.consoleReady === true) return 'runtime-online';
    return metrics.runtimeState || '';
  }
  function nodeWorkState(metrics) {
    const token = nodeWorkStateToken(metrics);
    return token ? (WORK_STATE_LABELS[token] || humanizeKey(token)) : '';
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
`
