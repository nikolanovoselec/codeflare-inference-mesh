/**
 * Split-run readiness and stage ownership: what blocks a mesh, and how a stage reads.
 *
 * A fragment of the console script, not a standalone module: it is concatenated
 * verbatim into one IIFE by `../admin-ui-client`. Zero interpolation, by rule.
 */
export const CLIENT_SPLIT_READINESS = `\
  function splitReadinessIssue(report) {
    if (!report) return false;
    if (Array.isArray(report.blockers) && report.blockers.length > 0) return true;
    return Boolean(report.verdict && report.verdict !== 'ready');
  }
  function splitReadinessReason(report) {
    if (!report) return '';
    const blockers = Array.isArray(report.blockers) ? report.blockers : [];
    if (blockers.length && blockers[0].reason) return blockers[0].reason;
    return (report.capacityAdvice && report.capacityAdvice.reason) || report.verdict || '';
  }
  function splitReadinessModelSizeUnknown(report) {
    const reason = splitReadinessReason(report);
    return reason === 'model_size_unknown' || reason === 'model size unknown';
  }
  function splitReadinessBlocksRuntime(report, metrics) {
    if (!splitReadinessIssue(report)) return false;
    if (splitReadinessModelSizeUnknown(report)) return false;
    return true;
  }
  function splitReadinessBlocksMesh(entry) {
    if (!splitReadinessIssue(entry && entry.splitReadiness)) return false;
    if (splitReadinessModelSizeUnknown(entry.splitReadiness)) return false;
    return true;
  }
  function splitCapacity(report) {
    return report && report.capacityAdvice ? report.capacityAdvice : {};
  }
  function annotateSplitReadiness(element, report) {
    if (!element || !report) return;
    const reason = splitReadinessReason(report);
    const capacity = splitCapacity(report);
    if (reason) element.setAttribute('data-split-reason', reason);
    if (report.verdict) element.setAttribute('data-split-verdict', report.verdict);
    if (capacity.requiredBytes != null) element.setAttribute('data-required-bytes', String(capacity.requiredBytes));
    if (capacity.aggregateCapacityBytes != null) element.setAttribute('data-aggregate-bytes', String(capacity.aggregateCapacityBytes));
    if (capacity.shortfallBytes != null) element.setAttribute('data-shortfall-bytes', String(capacity.shortfallBytes));
  }
  function humanizeKey(value) {
    return String(value || '').replace(/^participant_/, '').replace(/_/g, ' ').replace(/\\b\\w/g, (char) => char.toUpperCase());
  }
  function splitReadinessLabel(report) {
    if (!report) return '';
    const reason = splitReadinessReason(report);
    const capacity = splitCapacity(report);
    const verdict = report.verdict || '';
    if (reason === 'split_capacity_shortfall' || capacity.state === 'insufficient_capacity' || verdict === 'insufficient_capacity') return 'Split capacity shortfall';
    if (verdict === 'ready') return 'Split ready';
    if (verdict === 'waiting_for_peers' || reason === 'waiting_for_peers') return 'Waiting for peers';
    return humanizeKey(reason || verdict || 'split not ready');
  }
  function splitReadinessText(report) {
    return splitReadinessLabel(report);
  }
  function splitCapacityText(report) {
    const capacity = splitCapacity(report);
    const shortfall = bytesToGb(capacity.shortfallBytes);
    if (shortfall != null && shortfall > 0) return 'Capacity shortfall';
    return '';
  }
  function allStatusNodes() {
    return lastStatus && Array.isArray(lastStatus.nodes) ? lastStatus.nodes : [];
  }
  function nodeDisplayName(node) {
    return (node && (node.displayName || node.name || node.id)) || 'unknown node';
  }
  function modelLabelForRef(ref) {
    const raw = String(ref || '');
    const profiles = lastStatus && Array.isArray(lastStatus.profiles) ? lastStatus.profiles : [];
    const profile = profiles.find((item) => item && (item.upstreamModel === raw || item.id === raw || (Array.isArray(item.publicAliases) && item.publicAliases.indexOf(raw) >= 0)));
    return profile && profile.displayName ? String(profile.displayName) : raw;
  }
  function nodeLabelForId(value, candidates) {
    const raw = String(value || '').trim();
    if (!raw) return 'unknown node';
    const nodes = (Array.isArray(candidates) && candidates.length ? candidates : allStatusNodes());
    const exact = nodes.find((node) => node && (node.id === raw || node.displayName === raw || node.name === raw || (node.metrics && node.metrics.meshNodeId === raw)));
    if (exact) return nodeDisplayName(exact);
    const prefix = nodes.find((node) => {
      const meshNodeId = node && node.metrics ? node.metrics.meshNodeId : '';
      return node && ((node.id && (node.id.indexOf(raw) === 0 || raw.indexOf(node.id) === 0)) || (meshNodeId && (meshNodeId.indexOf(raw) === 0 || raw.indexOf(meshNodeId) === 0)));
    });
    if (prefix) return nodeDisplayName(prefix);
    const loose = nodes.find((node) => node && raw.length >= 6 && ((node.id && node.id.indexOf(raw) >= 0) || (node.metrics && node.metrics.meshNodeId && node.metrics.meshNodeId.indexOf(raw) >= 0)));
    if (loose) return nodeDisplayName(loose);
    return raw.length > 12 ? raw.slice(0, 10) + '…' : raw;
  }
  function splitParticipants(report, candidates) {
    return Array.isArray(report && report.participants) ? report.participants.map((item) => {
      const raw = item.routerNodeId || item.nodeId || item.shortNodeId || '';
      return { label: item.displayName || nodeLabelForId(raw, candidates), raw: raw, capacity: bytesToGb(item.vramBytes) };
    }) : [];
  }
  function idMatchesNode(value, node) {
    const raw = String(value || '').trim();
    if (!raw || !node) return false;
    const names = [node.id, node.displayName, node.name, node.metrics && node.metrics.meshNodeId].filter(Boolean).map(String);
    return names.some((name) => name === raw || name.indexOf(raw) === 0 || raw.indexOf(name) === 0);
  }
  function nodeForStage(stage, candidates) {
    if (!stage) return undefined;
    const nodes = Array.isArray(candidates) && candidates.length ? candidates : allStatusNodes();
    const owner = nodes.find((node) => idMatchesNode(stage.nodeId, node));
    if (owner) return owner;
    return nodes.find((node) => idMatchesNode(stage.reportedByNodeId, node));
  }
  function stageOwnedByNode(stage, node) {
    const owner = nodeForStage(stage, allStatusNodes());
    return owner ? owner.id === node.id : idMatchesNode(stage && stage.nodeId, node);
  }
  function stageKey(stage) {
    return [stage.stageId || '', stage.stageIndex == null ? '' : stage.stageIndex, stage.nodeId || '', stage.layerStart == null ? '' : stage.layerStart, stage.layerEnd == null ? '' : stage.layerEnd].join(':');
  }
  function stageStateRank(stage) {
    const state = String(stage && stage.state || '').toLowerCase();
    if (state === 'ready' || state === 'serving') return 4;
    if (state === 'loading' || state === 'running') return 3;
    if (state === 'pending' || state === 'standby') return 2;
    if (state === 'failed' || state === 'error') return 0;
    return 1;
  }
  function preferStage(current, candidate) {
    if (!current) return candidate;
    const currentPriority = current.__sourcePriority || 0;
    const candidatePriority = candidate.__sourcePriority || 0;
    if (candidatePriority !== currentPriority) return candidatePriority > currentPriority ? candidate : current;
    return stageStateRank(candidate) > stageStateRank(current) ? candidate : current;
  }
  function cleanStage(stage) {
    if (!stage) return stage;
    const { __sourcePriority, ...cleaned } = stage;
    void __sourcePriority;
    return cleaned;
  }
  function nodeStageAssignments(node) {
    const byKey = new Map();
    const add = (stage, sourcePriority) => {
      if (!stage || !stageOwnedByNode(stage, node)) return;
      const candidate = { ...stage, __sourcePriority: sourcePriority };
      byKey.set(stageKey(candidate), preferStage(byKey.get(stageKey(candidate)), candidate));
    };
    if (node && node.metrics && Array.isArray(node.metrics.stageAssignments)) node.metrics.stageAssignments.forEach((stage) => add(stage, 2));
    if (lastStatus && Array.isArray(lastStatus.meshHealth)) lastStatus.meshHealth.forEach((entry) => (Array.isArray(entry.stageAssignments) ? entry.stageAssignments : []).forEach((stage) => add(stage, 1)));
    return [...byKey.values()].map(cleanStage).sort((left, right) => (left.stageIndex || 0) - (right.stageIndex || 0));
  }
  function stageDisplayState(stage, candidates) {
    if (stage && stage.state) return stage.state;
    const ownerNode = nodeForStage(stage, candidates);
    const metrics = ownerNode && ownerNode.metrics ? ownerNode.metrics : {};
    if (metrics.runtimeState === 'ready' && (metrics.nodeState === 'serving' || (Array.isArray(metrics.readyModels) && metrics.readyModels.length > 0) || ((metrics.stageCount || 0) > 0 && metrics.apiReady === true && metrics.consoleReady === true))) return 'ready';
    return '';
  }
  function stageDetailText(stage, candidates, includeOwner) {
    const layers = stage.layerStart != null && stage.layerEnd != null ? ('L' + stage.layerStart + '-' + stage.layerEnd) : ('stage ' + stage.stageIndex);
    const ownerNode = nodeForStage(stage, candidates);
    const owner = includeOwner ? (' → ' + (ownerNode ? nodeDisplayName(ownerNode) : nodeLabelForId(stage.nodeId || stage.reportedByNodeId || '', candidates))) : '';
    const displayState = stageDisplayState(stage, candidates);
    const state = displayState ? ' · ' + humanizeKey(displayState) : '';
    return layers + owner + state;
  }
  function stageDataValue(stage, candidates) {
    const displayState = stageDisplayState(stage, candidates);
    return [stage.nodeId || stage.reportedByNodeId || '', stage.layerStart == null ? '' : stage.layerStart, stage.layerEnd == null ? '' : stage.layerEnd, displayState].join(':');
  }
`
