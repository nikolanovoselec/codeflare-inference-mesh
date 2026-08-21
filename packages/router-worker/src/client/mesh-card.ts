/**
 * One mesh card, and the plain-language activity feed.
 *
 * A fragment of the console script, not a standalone module: it is concatenated
 * verbatim into one IIFE by `../admin-ui-client`. Zero interpolation, by rule.
 */
export const CLIENT_MESH_CARD = `\
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
`
