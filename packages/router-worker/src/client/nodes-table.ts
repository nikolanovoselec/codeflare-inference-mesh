/**
 * The nodes table, the topology map, and the throughput trace.
 *
 * A fragment of the console script, not a standalone module: it is concatenated
 * verbatim into one IIFE by `../admin-ui-client`. Zero interpolation, by rule.
 */
export const CLIENT_NODES_TABLE = `\
  function renderNodesTable(nodes, desiredVersion) {
    const bodyEl = byId(config.nodesTable.bodyId);
    if (!bodyEl) return;
    bodyEl.textContent = '';
    if (!nodes.length) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.className = 'empty-note';
      cell.setAttribute('colspan', String(config.nodesTable.columns.length));
      cell.textContent = 'No nodes enrolled yet. Create a setup token below and run the install command on a machine.';
      row.appendChild(cell);
      bodyEl.appendChild(row);
      return;
    }
    let visible = nodes.slice();
    if (nodeFilter !== 'all') visible = visible.filter((node) => nodeCategory(node) === nodeFilter);
    if (nodeSearch.length >= 3) {
      const query = nodeSearch.toLowerCase();
      visible = visible.filter((node) => (node.id || '').toLowerCase().indexOf(query) >= 0 || (node.displayName || '').toLowerCase().indexOf(query) >= 0);
    }
    if (!visible.length) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.className = 'empty-note';
      cell.setAttribute('colspan', String(config.nodesTable.columns.length));
      cell.textContent = 'No machines match this filter.';
      row.appendChild(cell);
      bodyEl.appendChild(row);
      return;
    }
    const ordered = visible;
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
        // Column label per cell so the stacked mobile layout prints "Label: value" (no side-scroll).
        td.setAttribute('data-label', nodeCellLabel[name] || name);
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
      idButton.textContent = nodeDisplayName(node);
      idCell.appendChild(idButton);
      const statusCell = cell('status', nodeCategory(node), undefined);
      const blocker = splitMeshBlocker(node);
      if (blocker && blocker.splitReadiness) statusCell.setAttribute('data-status-detail', splitReadinessReason(blocker.splitReadiness));
      else if (blocker) statusCell.setAttribute('data-status-detail', 'split-mesh-peer-discovery');
      else if (node.metrics && node.metrics.nodeState) statusCell.setAttribute('data-status-detail', node.metrics.nodeState);
      if (node.metrics && node.metrics.meshRole) statusCell.setAttribute('data-mesh-role', nodeMeshRoleToken(node.metrics));
      if (node.metrics && node.metrics.splitReadiness) annotateSplitReadiness(statusCell, node.metrics.splitReadiness);
      // The visible label is the fixed status vocabulary; role/work detail lives in the
      // drawer diagnostics and the cell's data attributes, never in the label.
      const statusWord = nodeDisplayStatus(node);
      const statusLabel = statusWord === 'Offline' ? statusWord + (nodeRelAge(node) ? ' · last seen ' + nodeRelAge(node) : '') : statusWord;
      // A captured runtime error never hides behind a green chip: the cell carries the
      // exact line and an ok tone escalates to warn while the error stands.
      const degraded = degradedRuntimeError(node);
      if (degraded) statusCell.setAttribute('data-runtime-error', degraded);
      statusCell.appendChild(statusDot(degraded && nodeTone(node) === 'ok' ? 'warn' : nodeTone(node), statusLabel));
      const install = runtimeInstallInfo(node);
      const installChip = chipEl(runtimeInstallTone(install), runtimeInstallText(node));
      installChip.setAttribute('data-runtime-install-chip', node.id);
      installChip.setAttribute('data-runtime-install-state', install.state);
      statusCell.appendChild(installChip);
      cell('mesh', nodeMeshId(node), meshDisplayName(nodeMeshId(node)));
      cell('vram', String(nodeVramTotal(node)), fmtVramTelemetry(node));
      const versionCell = cell('version', undefined, undefined);
      versionCell.appendChild(versionCode(node, desiredVersion));
      bodyEl.appendChild(row);
    });
  }
  const topoNodeButton = (node) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'topo-node tone-' + nodeTone(node);
    button.dataset.action = 'node-detail';
    button.dataset.nodeId = node.id;
    button.textContent = nodeDisplayName(node);
    return button;
  };
  // The overview topology can focus on one machine group; 'all' shows every mesh.
  const topologyNodes = (nodes) => topologyMeshFilter === 'all' ? nodes : nodes.filter((node) => nodeMeshId(node) === topologyMeshFilter);
  // Rebuilt on every status render, preserving the operator's selection; a filter
  // whose mesh was deleted falls back to all so the canvas never sticks empty.
  function syncTopoMeshSelect(meshes) {
    const select = byId(config.topology.meshSelectId);
    if (!select) return;
    select.textContent = '';
    const all = document.createElement('option');
    all.value = 'all';
    all.textContent = 'All';
    select.appendChild(all);
    meshes.forEach((mesh) => {
      const option = document.createElement('option');
      option.value = mesh.id;
      option.textContent = mesh.name;
      select.appendChild(option);
    });
    if (topologyMeshFilter !== 'all' && !meshes.some((mesh) => mesh.id === topologyMeshFilter)) topologyMeshFilter = 'all';
    select.value = topologyMeshFilter;
  }
  function renderTopology(nodes) {
    const canvas = byId(config.topology.canvasId);
    const list = byId(config.topology.listId);
    const caption = byId(config.topology.captionId);
    const serving = nodes.filter(nodeServingCapacity).length;
    if (caption) {
      caption.dataset.nodes = String(nodes.length);
      caption.dataset.serving = String(serving);
      caption.textContent = nodes.length + ' machines \u00b7 ' + serving + ' available';
    }
    if (canvas) {
      canvas.textContent = '';
      const hub = document.createElement('div');
      hub.className = 'topo-hub';
      hub.setAttribute('data-topo-hub', 'true');
      hub.textContent = 'router';
      canvas.appendChild(hub);
      canvas.classList.toggle('is-empty', nodes.length === 0);
      if (!nodes.length) {
        const empty = document.createElement('p');
        empty.className = 'topo-empty';
        empty.textContent = 'No nodes enrolled yet. Add one from Nodes.';
        canvas.appendChild(empty);
      }
      nodes.forEach((node, index) => {
        const angle = (index / Math.max(1, nodes.length)) * 2 * Math.PI - Math.PI / 2;
        // The canvas is 2:1, so a percent of height is only half a percent of width in
        // pixels. Size the spoke to reach the node on that aspect-corrected ellipse (rather
        // than a fixed width-% line at the raw angle) so a near-vertical connector can never
        // overshoot the shorter vertical axis and poke outside the canvas.
        const rx = 38;
        const ry = 38;
        const dxWidth = rx * Math.cos(angle);
        const dyWidth = (ry / 2) * Math.sin(angle);
        const spokeLength = Math.hypot(dxWidth, dyWidth);
        const spokeAngle = Math.atan2(dyWidth, dxWidth) * 180 / Math.PI;
        const spoke = document.createElement('span');
        spoke.className = 'topo-spoke';
        spoke.setAttribute('aria-hidden', 'true');
        spoke.setAttribute('style', 'width:' + spokeLength.toFixed(2) + '%;transform:rotate(' + spokeAngle.toFixed(1) + 'deg)');
        canvas.appendChild(spoke);
        const button = topoNodeButton(node);
        const x = 50 + rx * Math.cos(angle);
        const y = 50 + ry * Math.sin(angle);
        button.setAttribute('style', 'left:' + x.toFixed(1) + '%;top:' + y.toFixed(1) + '%');
        canvas.appendChild(button);
      });
    }
    if (list) {
      list.textContent = '';
      nodes.forEach((node) => list.appendChild(topoNodeButton(node)));
    }
  }
  const pushToksSample = (value) => {
    toksSamples.push(value);
    const cap = config.toksTrace.window;
    if (toksSamples.length > cap) toksSamples = toksSamples.slice(toksSamples.length - cap);
  };
  function renderToksTrace() {
    const trace = byId(config.toksTrace.containerId);
    if (!trace) return;
    trace.textContent = '';
    // Leave the trace empty (and hidden by .toks-trace:empty) when there is no real
    // throughput, so baseline bars do not read as an alarming coral line at zero.
    if (!toksSamples.length || toksSamples.every((value) => value <= 0)) return;
    const span = config.toksTrace.smoothing;
    const smoothed = toksSamples.map((value, index) => {
      const window = toksSamples.slice(Math.max(0, index - span + 1), index + 1);
      return window.reduce((sum, item) => sum + item, 0) / window.length;
    });
    const peak = smoothed.reduce((max, value) => Math.max(max, value), 0) || 1;
    toksSamples.forEach((raw, index) => {
      const bar = document.createElement('span');
      bar.className = 'trace-bar';
      bar.setAttribute('data-sample', String(raw));
      bar.setAttribute('data-smoothed', round1(smoothed[index]));
      bar.setAttribute('style', 'height:' + (smoothed[index] / peak * 100).toFixed(1) + '%');
      trace.appendChild(bar);
    });
  }
`
