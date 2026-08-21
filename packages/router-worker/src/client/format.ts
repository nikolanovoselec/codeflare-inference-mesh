/**
 * Value formatters: ages, byte and VRAM units, and the reported/ready vocabulary.
 *
 * A fragment of the console script, not a standalone module: it is concatenated
 * verbatim into one IIFE by `../admin-ui-client`. Zero interpolation, by rule.
 */
export const CLIENT_FORMAT = `\
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
  const nodeToks = (node) => (node.metrics && typeof node.metrics.tokensPerSecond === 'number') ? node.metrics.tokensPerSecond : null;
  const speedNumber = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;
  const round1 = (value) => String(Math.round(value * 10) / 10);
  const profileModelRef = (profile) => (profile.llamacpp && profile.llamacpp.modelRef) || (profile.meshllm && profile.meshllm.modelRef) || profile.upstreamModel || '';
  // Speed tests are stored per resolved profile id; each mesh card reads its own profile's entry.
  const speedTestFor = (status, model) => {
    const map = status && status.lastSpeedTests && typeof status.lastSpeedTests === 'object' ? status.lastSpeedTests : null;
    const entry = map && model ? map[model.id] : null;
    return entry && typeof entry === 'object' ? entry : null;
  };
  function nodeVramInfo(node) {
    const metrics = (node && node.metrics) || {};
    const reportedTotal = Number(metrics.gpuMemoryTotalMiB || 0);
    const reportedUsed = metrics.gpuMemoryUsedMiB == null ? null : Number(metrics.gpuMemoryUsedMiB);
    return {
      totalMiB: reportedTotal > 0 ? reportedTotal : 0,
      usedMiB: reportedUsed != null && Number.isFinite(reportedUsed) ? reportedUsed : null,
      source: reportedTotal > 0 ? 'reported' : 'none'
    };
  }
  const nodeVramTotal = (node) => nodeVramInfo(node).totalMiB || 0;
  const reportedText = (value) => value == null ? 'not reported' : String(value);
  const readinessText = (value) => value === true ? 'ready' : value === false ? 'down' : 'not reported';
  const fmtGb = (value) => value == null ? 'not reported' : (Math.round(Number(value) * 10) / 10) + ' GB';
  const fmtVramLimit = (value) => value == null || Number(value) === 0 ? 'no limit' : fmtGb(value);
  const fmtGibFromMiB = (value) => value == null || !Number.isFinite(Number(value)) || Number(value) <= 0 ? 'not reported' : (Math.round(Number(value) / 102.4) / 10) + ' GiB';
  // Hero VRAM tile: consumed / total with a single trailing unit; consumption is omitted
  // (never shown as 0) while no machine reports a live used figure.
  const fmtVramPair = (usedMiB, totalMiB) => {
    if (totalMiB == null || !Number.isFinite(Number(totalMiB)) || Number(totalMiB) <= 0) return 'not reported';
    const gib = (value) => String(Math.round(Number(value) / 102.4) / 10);
    return (usedMiB > 0 ? gib(usedMiB) + ' / ' : '') + gib(totalMiB) + ' GB';
  };
  const fmtVramTelemetry = (node) => {
    const vram = nodeVramInfo(node);
    if (vram.totalMiB <= 0) return '—';
    return vram.usedMiB == null ? fmtGibFromMiB(vram.totalMiB) : fmtGibFromMiB(vram.usedMiB) + ' / ' + fmtGibFromMiB(vram.totalMiB);
  };
  const bytesToGb = (bytes) => bytes == null ? null : Number(bytes) / 1000000000;
`
