/**
 * nodes table and node drawer contracts.
 *
 * One slice of the console dashboard suite; shared fixtures live in
 * `./admin-ui-test-support`.
 */
import { ADMIN_UI_DRAWER, ADMIN_UI_MESH_ROLE, ADMIN_UI_NODES_TABLE, ADMIN_UI_WORK_STATE } from './admin-ui'
import { dashboardHarness, dashboardProfiles, fieldValue, resetDashboardEnvironment, rowOrder, statusFixture, tableRows } from './admin-ui-test-support'
import { descendants, type StubElement } from './admin-ui-harness'
import { afterEach, describe, expect, it } from 'vitest'

describe('nodes table and node drawer contracts', () => {
  afterEach(resetDashboardEnvironment)


  it('REQ-ADM-015 sorts the nodes table by the clicked column and flips direction on repeat', async () => {
    const harness = await dashboardHarness()
    expect(rowOrder(harness)).toEqual(['node-big', 'node-small', 'node-down'])

    const sortButton = (key: string) => harness.clickAction('nodes-sort', { sort: key })
    await sortButton('vram')
    expect(rowOrder(harness)).toEqual(['node-big', 'node-small', 'node-down'])
    await sortButton('vram')
    expect(rowOrder(harness)).toEqual(['node-down', 'node-small', 'node-big'])

    const cells = descendants(tableRows(harness).find((row) => row.dataset.nodeRow === 'node-big')!)
    expect(cells.some((cell) => cell.dataset.cell === 'toks')).toBe(false)
    const bigVram = cells.find((cell) => cell.dataset.cell === 'vram')!
    expect(bigVram.dataset.value).toBe('24576')
    expect(bigVram.textContent).toBe('19.5 GiB / 24 GiB')
    // The table carries no per-model cell: model detail lives in the drawer.
    expect(cells.some((cell) => cell.dataset.cell === 'model' || cell.dataset.cell === 'models')).toBe(false)
  })


  it('REQ-ADM-015 shows a plain node status and never the stale runtime substate when offline', async () => {
    const nodes = [
      { id: 'ready-node', status: 'online', metrics: { runtimeState: 'ready', readyModels: ['m'], tokensPerSecond: 10, gpuMemoryTotalMiB: 8192, gpuMemoryUsedMiB: 4096 } },
      { id: 'loading-node', status: 'online', metrics: { runtimeState: 'starting', nodeState: 'loading model next-upstream', readyModels: [], tokensPerSecond: 0, gpuMemoryTotalMiB: 0 } },
      { id: 'failed-node', status: 'online', metrics: { runtimeState: 'failed', nodeState: 'loading model next-upstream', readyModels: [] } },
      { id: 'gone-node', status: 'offline', metrics: { runtimeState: 'starting', readyModels: [] } }
    ]
    const harness = await dashboardHarness({ status: statusFixture({ nodes }) })
    const statusOf = (id: string) => {
      const row = tableRows(harness).find((candidate) => candidate.dataset.nodeRow === id)!
      const cell = descendants(row).find((candidate) => candidate.dataset.cell === 'status')!
      return { category: cell.dataset.value, detail: cell.dataset.statusDetail, text: descendants(cell).map((node) => node.textContent).filter(Boolean).join(' ') }
    }
    // The visible label is the fixed operator vocabulary; detail stays in data attributes.
    expect(statusOf('ready-node').category).toBe('ready')
    expect(statusOf('ready-node').text).toContain('Serving')
    expect(statusOf('loading-node').category).toBe('active')
    expect(statusOf('loading-node').text).toContain('Preparing')
    expect(statusOf('loading-node').detail).toBe('loading model next-upstream')
    expect(statusOf('failed-node').category).toBe('active')
    expect(statusOf('failed-node').text).toContain('Error')
    expect(statusOf('failed-node').detail).toBe('loading model next-upstream')
    // Live per-node throughput is not a reliable MeshLLM table field; the Nodes table omits it entirely.
    expect(descendants(tableRows(harness).find((row) => row.dataset.nodeRow === 'loading-node')!).some((cell) => cell.dataset.cell === 'toks')).toBe(false)
    // The offline node drops the frozen "starting" substate entirely.
    const gone = statusOf('gone-node')
    expect(gone.category).toBe('offline')
    expect(gone.text).toContain('Offline')
    expect(gone.text).not.toContain('starting')
  })


  it('REQ-OBS-011 surfaces split mesh peer discovery blockers without SSH', async () => {
    const splitProfile = { ...dashboardProfiles[1]!, active: true }
    const nodes = [{
      id: 'mac-worker',
      status: 'online',
      activeProfileIds: [splitProfile.id],
      runtime: 'meshllm',
      metrics: {
        runtimeKind: 'meshllm',
        runtimeState: 'starting',
        nodeState: 'standby',
        splitEnabled: true,
        peerCount: 0,
        stageCount: 0,
        apiReady: false,
        consoleReady: true,
        meshllmVersion: '0.72.2',
        readyModels: [],
        activeRequests: 0
      }
    }]
    const harness = await dashboardHarness({ status: statusFixture({ profiles: [splitProfile], nodes }) })
    const row = tableRows(harness).find((candidate) => candidate.dataset.nodeRow === 'mac-worker')!
    const statusCell = descendants(row).find((candidate) => candidate.dataset.cell === 'status')!

    expect(statusCell.dataset.statusDetail).toBe('split-mesh-peer-discovery')
    // A starting split runtime is Preparing (yellow) in the table; the drawer blocker below carries the alarm.
    expect(descendants(statusCell).find((node) => node.className === 'chip')!.dataset.tone).toBe('warn')

    await harness.clickAction('node-detail', { nodeId: 'mac-worker' })
    const blocker = descendants(harness.byId(ADMIN_UI_DRAWER.bodyId)).find((node) => node.dataset.drawerField === 'mesh-discovery-blocker')!
    expect(blocker.getAttribute('data-tone')).toBe('danger')
    expect(blocker.getAttribute('data-peer-count')).toBe('0')
    expect(blocker.getAttribute('data-stage-count')).toBe('0')
  })


  it('REQ-ADM-015 filters the nodes table by status chip and by search', async () => {
    const harness = await dashboardHarness()
    // Default fixture: node-big + node-small are serving (ready), node-down is offline.
    await harness.clickAction('nodes-filter', { filter: 'offline' })
    expect(rowOrder(harness)).toEqual(['node-down'])
    await harness.clickAction('nodes-filter', { filter: 'ready' })
    expect(rowOrder(harness).slice().sort()).toEqual(['node-big', 'node-small'])
    await harness.clickAction('nodes-filter', { filter: 'all' })
    expect(rowOrder(harness).length).toBe(3)
    // Search filters only once at least three characters are typed.
    const search = harness.byId('node-search')
    search.dataset.nodeSearch = 'true'
    search.value = 'sm'
    await harness.change(search)
    expect(rowOrder(harness).length).toBe(3)
    search.value = 'small'
    await harness.change(search)
    expect(rowOrder(harness)).toEqual(['node-small'])
  })


  it('REQ-ADM-015 REQ-ADM-032 the drawer offers Force Reload wired to the reload action', async () => {
    const harness = await dashboardHarness()
    const drawer = harness.byId(ADMIN_UI_DRAWER.containerId)
    expect(drawer.hidden).toBe(true)

    await harness.clickAction('node-detail', { nodeId: 'node-small' })
    expect(drawer.hidden).toBe(false)
    expect(harness.byId(ADMIN_UI_DRAWER.titleId).textContent).toBe('node-small')
    const fields = descendants(harness.byId(ADMIN_UI_DRAWER.bodyId))
    const field = (name: string) => fields.find((node) => node.dataset.drawerField === name)
    expect(field('status')).toBeDefined()
    expect(field('toks')).toBeUndefined()
    expect(field('vram')!.dataset.value).toBe('4000/8192')
    expect(fieldValue(field('vram')!)).toBe('3.9 GiB / 8 GiB')
    expect(field('version')!.dataset.reported).toBe('v1.2.0')
    expect(field('version')!.dataset.desiredMatch).toBe('false')
    const models = fields.filter((node) => node.dataset.drawerModel)
    // The raw upstream ref stays as a contract value, but the primary drawer label is the model display name.
    expect(models.map((node) => node.dataset.drawerModel)).toEqual(['unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ3_S'])
    expect(models.map((node) => node.textContent)).toEqual(['Qwen3.6 35B'])
    const revoke = fields.find((node) => node.dataset.action === 'node-revoke')
    expect(revoke).toBeDefined()
    expect(revoke!.dataset.nodeId).toBe('node-small')
    expect(revoke!.dataset.confirm, 'revoke must arm before submitting').toBeTruthy()
    // An active node's drawer offers Deactivate (the reversible taint) alongside Revoke.
    const deactivate = fields.find((node) => node.dataset.action === 'node-deactivate')
    expect(deactivate).toBeDefined()
    expect(deactivate!.dataset.nodeId).toBe('node-small')
    expect(deactivate!.textContent).toBe('Deactivate')
    // The drawer also offers Force Reload (restart mesh-llm on demand) wired to the reload action. REQ-ADM-032.
    const reload = fields.find((node) => node.dataset.action === 'node-reload')
    expect(reload).toBeDefined()
    expect(reload!.dataset.nodeId).toBe('node-small')
    expect(reload!.textContent).toBe('Force Reload')

    await harness.clickAction(ADMIN_UI_DRAWER.closeAction)
    expect(drawer.hidden).toBe(true)
  })


  it('REQ-ADM-030 a deactivated node reads as tainted (warn tone) and its drawer offers Activate', async () => {
    const status = statusFixture({ nodes: [{ id: 'node-off', status: 'online', deactivated: true, metrics: { runtimeState: 'failed', runtimeDetail: 'readiness deadline exceeded', readyModels: [], activeRequests: 0, tokensPerSecond: 0, gpuMemoryTotalMiB: 8192, meshllmVersion: '0.72.2' } }] })
    const harness = await dashboardHarness({ status })
    const row = harness.byId(ADMIN_UI_NODES_TABLE.bodyId).children.find((node) => node.dataset.nodeRow === 'node-off')!
    const chip = descendants(row).find((node) => node.className === 'chip')!
    expect(chip.dataset.tone).toBe('warn')
    expect(descendants(row).some((node) => node.textContent === 'Deactivated')).toBe(true)
    // The node name itself opens the drawer; there is no separate Manage button and never an inline revoke.
    expect(descendants(row).some((node) => node.dataset.action === 'node-detail')).toBe(true)
    expect(descendants(row).some((node) => node.textContent === 'Manage')).toBe(false)
    expect(descendants(row).some((node) => node.dataset.action === 'node-revoke')).toBe(false)

    await harness.clickAction('node-detail', { nodeId: 'node-off' })
    const fields = descendants(harness.byId(ADMIN_UI_DRAWER.bodyId))
    const runtimeInstall = fields.find((node) => node.dataset.drawerField === 'runtime-install')!
    // A paused node reports its installed runtime and the pause and nothing else. Pinning the
    // whole value is what rules out an "install failed" or "deactivated" leaking in beside it.
    expect(fieldValue(runtimeInstall)).toBe('meshllm 0.72.2 · paused')
    expect(runtimeInstall.dataset.runtimeInstallState).toBe('paused')
    const activate = fields.find((node) => node.dataset.action === 'node-activate')
    expect(activate).toBeDefined()
    expect(activate!.textContent).toBe('Activate')
    // A deactivated node shows Activate, not Deactivate.
    expect(fields.some((node) => node.dataset.action === 'node-deactivate')).toBe(false)
  })


  it('REQ-OBS-011 renders a split stage owner as active work, not standby/API client', async () => {
    const nodes = [
      {
        id: 'battlestation', displayName: 'battlestation', status: 'online', agentVersion: 'v0.1.0-dev.98', activeProfileIds: [], maxVramGbOverride: 16,
        metrics: { runtimeKind: 'meshllm', runtimeState: 'ready', nodeState: 'serving', meshRole: 'coordinator', apiReady: true, consoleReady: true, peerCount: 1, stageCount: 1, meshNodeId: 'mesh-host', meshMaxVramGb: 16, gpuName: 'NVIDIA GeForce RTX 3090', gpuMemoryUsedMiB: 18_799, gpuMemoryTotalMiB: 24_576, activeRequests: 0, loadedProfileId: 'mesh-default-qwen36-35b', splitReadiness: { verdict: 'ready', participants: [{ routerNodeId: 'battlestation', displayName: 'battlestation', vramBytes: 63_200_000_000 }, { routerNodeId: 'mac-100-96-0-14', displayName: 'Mac', vramBytes: 5_700_000_000 }] } }
      },
      {
        id: 'mac-100-96-0-14', displayName: 'Mac', status: 'online', agentVersion: 'v0.1.0-dev.98', activeProfileIds: ['mesh-default-qwen36-35b'],
        metrics: { runtimeKind: 'meshllm', runtimeState: 'starting', nodeState: 'standby', meshRole: 'api-client', apiReady: true, consoleReady: true, peerCount: 1, stageCount: 1, meshNodeId: 'mesh-mac', meshllmVersion: '0.72.2', meshMaxVramGb: 6, gpuName: 'Apple M2', activeRequests: 0, splitReadiness: { verdict: 'ready', participants: [{ routerNodeId: 'battlestation', displayName: 'battlestation', vramBytes: 63_200_000_000 }, { routerNodeId: 'mac-100-96-0-14', displayName: 'Mac', vramBytes: 5_700_000_000 }] }, stageAssignments: [{ stageIndex: 1, nodeId: 'mesh-mac', layerStart: 27, layerEnd: 28, state: 'failed' }, { stageIndex: 1, nodeId: 'mesh-mac', layerStart: 27, layerEnd: 28, state: 'ready' }] }
      }
    ]
    const meshHealth = [{ profileId: 'mesh-default-qwen36-35b', rotation: 0, coordinatorNodeId: 'mesh-host', peerNodeIds: ['mesh-host', 'mesh-mac'], readyModels: ['codeflare-mesh'], failedNodeIds: [], tokenCount: 2, stageAssignments: [{ stageIndex: 0, nodeId: 'mesh-host', layerStart: 0, layerEnd: 26 }, { stageIndex: 1, nodeId: 'mesh-mac', layerStart: 27, layerEnd: 28, state: 'ready' }] }]
    const harness = await dashboardHarness({ status: statusFixture({ nodes, meshHealth }) })
    const row = tableRows(harness).find((candidate) => candidate.dataset.nodeRow === 'mac-100-96-0-14')!
    const statusCell = descendants(row).find((candidate) => candidate.dataset.cell === 'status')!
    expect(statusCell.dataset.meshRole).toBe(ADMIN_UI_MESH_ROLE.stageOwner)
    // A stage owner reads as Serving (active work), never standby/API client; the role
    // detail rides the data attribute and the drawer, not the visible label.
    const statusChip = descendants(statusCell).find((node) => node.className === 'chip')!
    expect(descendants(statusChip).map((node) => node.textContent).join(' ')).toContain('Serving')

    await harness.clickAction('node-detail', { nodeId: 'mac-100-96-0-14' })
    let fields = descendants(harness.byId(ADMIN_UI_DRAWER.bodyId))
    const fieldOf = (name: string) => fields.find((node) => node.dataset.drawerField === name)!
    expect(fieldOf('work-state').dataset.value).toBe(ADMIN_UI_WORK_STATE.servingSplitStage)
    expect(fieldOf('mesh-role').dataset.value).toBe(ADMIN_UI_MESH_ROLE.stageOwner)
    const macVram = fields.find((node) => node.dataset.drawerField === 'vram')!
    expect(macVram.dataset.vramSource).toBe('none')
    expect(macVram.dataset.value).toBe('')
    const macBudget = fields.find((node) => node.dataset.drawerField === 'mesh-vram-budget')!
    expect(macBudget.dataset.budgetStale).toBe('true')
    expect(macBudget.dataset.runningBudget).toBe('6')
    expect(macBudget.dataset.nodeOverride).toBeUndefined()
    const macSplitReadiness = fields.find((node) => node.dataset.drawerField === 'split-readiness')!
    const macCapacity = descendants(macSplitReadiness).find((node) => node.dataset.participantLabel === 'Mac')!
    expect(macCapacity.dataset.participantCapacityGb).toBe('5.7')
    expect(descendants(macSplitReadiness).map((node) => node.textContent).join(' ')).not.toContain('5.7 GB')
    const macStage = fields.find((node) => node.dataset.drawerField === 'stage-ownership')!
    expect(macStage.dataset.value).toBe('mesh-mac:27:28:ready')
    expect(fields.some((node) => node.dataset.drawerField === 'stages')).toBe(false)
    expect(fields.some((node) => node.dataset.drawerField === 'node-state')).toBe(false)

    await harness.clickAction('node-detail', { nodeId: 'battlestation' })
    fields = descendants(harness.byId(ADMIN_UI_DRAWER.bodyId))
    const battleVram = fields.find((node) => node.dataset.drawerField === 'vram')!
    expect(battleVram.dataset.vramSource).toBe('reported')
    expect(battleVram.dataset.value).toBe('18799/24576')
    expect(fieldValue(battleVram)).toBe('18.4 GiB / 24 GiB')
    const battleSplitReadiness = fields.find((node) => node.dataset.drawerField === 'split-readiness')!
    const battleCapacity = descendants(battleSplitReadiness).find((node) => node.dataset.participantLabel === 'battlestation')!
    expect(battleCapacity.dataset.participantCapacityGb).toBe('63.2')
    expect(descendants(battleSplitReadiness).map((node) => node.textContent).join(' ')).not.toContain('63.2 GB')
    const battleStage = fields.find((node) => node.dataset.drawerField === 'stage-ownership')!
    expect(battleStage.dataset.value).toBe('mesh-host:0:26:ready')

    await harness.clickAction('model-detail', { profileId: 'mesh-default-qwen36-35b' })
    fields = descendants(harness.byId(ADMIN_UI_DRAWER.bodyId))
    // Stage ownership lives once, in the mesh card's Technical details.
    expect(fields.some((node) => node.dataset.drawerField === 'stage-ownership')).toBe(false)
    const modelStage = fields.find((node) => node.dataset.meshField === 'stage-owners')!
    expect(modelStage.textContent).toBe('Stage owners: L0-26 → battlestation · Ready; L27-28 → Mac · Ready')
  })


  it('REQ-OBS-011 hides model_size_unknown during reload and update transitions', async () => {
    const splitReadiness = { verdict: 'model_size_unknown', blockers: [{ reason: 'model_size_unknown' }] }
    const nodes = [{ id: 'linux-node', displayName: 'Arch Linux', status: 'online', activeProfileIds: ['mesh-default-qwen36-35b'], metrics: { runtimeKind: 'meshllm', runtimeState: 'starting', nodeState: 'loading model meshllm/ERNIE', meshRole: 'api-client', apiReady: true, consoleReady: true, peerCount: 1, stageCount: 0, splitEnabled: true, activeRequests: 0, splitReadiness } }]
    const meshHealth = [{ profileId: 'mesh-default-qwen36-35b', rotation: 0, peerNodeIds: ['linux-node'], readyModels: [], failedNodeIds: [], tokenCount: 1, splitReadiness }]
    const harness = await dashboardHarness({ status: statusFixture({ nodes, meshHealth }) })
    const row = tableRows(harness).find((candidate) => candidate.dataset.nodeRow === 'linux-node')!
    const statusCell = descendants(row).find((candidate) => candidate.dataset.cell === 'status')!
    // The cell reports the peer-discovery blocker, not the readiness reason. Were
    // model_size_unknown no longer suppressed, the blocker would carry its splitReadiness and
    // this would read 'model_size_unknown' instead.
    expect(statusCell.dataset.statusDetail).toBe('split-mesh-peer-discovery')

    await harness.clickAction('node-detail', { nodeId: 'linux-node' })
    let fields = descendants(harness.byId(ADMIN_UI_DRAWER.bodyId))
    expect(fields.some((node) => node.dataset.drawerField === 'split-readiness')).toBe(false)
    // Nor is it promoted to a runtime error, which is the other surface the label reaches.
    expect(fields.some((node) => node.dataset.drawerField === 'runtime-detail')).toBe(false)

    await harness.clickAction('model-detail', { profileId: 'mesh-default-qwen36-35b' })
    fields = descendants(harness.byId(ADMIN_UI_DRAWER.bodyId))
    expect(fields.some((node) => node.className === 'split-readiness-block')).toBe(false)
  })


  it('REQ-OBS-011 keeps stale model_size_unknown from overriding serving split status', async () => {
    const splitReadiness = { verdict: 'model_size_unknown', blockers: [{ reason: 'model_size_unknown' }], participants: [{ routerNodeId: 'linux-node', displayName: 'Arch Linux', vramBytes: 63_200_000_000 }] }
    const nodes = [{ id: 'linux-node', displayName: 'Arch Linux', status: 'online', activeProfileIds: ['mesh-default-qwen36-35b'], metrics: { runtimeKind: 'meshllm', runtimeState: 'ready', nodeState: 'serving', meshRole: 'coordinator', apiReady: true, consoleReady: true, peerCount: 1, stageCount: 1, meshNodeId: 'mesh-linux', readyModels: ['codeflare-mesh'], splitReadiness, stageAssignments: [{ stageIndex: 0, nodeId: 'mesh-linux', layerStart: 0, layerEnd: 26, state: 'ready' }] } }]
    const meshHealth = [{ profileId: 'mesh-default-qwen36-35b', rotation: 0, coordinatorNodeId: 'linux-node', peerNodeIds: ['linux-node'], readyModels: ['codeflare-mesh'], failedNodeIds: [], tokenCount: 1, splitReadiness, stageAssignments: [{ stageIndex: 0, nodeId: 'mesh-linux', layerStart: 0, layerEnd: 26, state: 'ready' }] }]
    const harness = await dashboardHarness({ status: statusFixture({ nodes, meshHealth }) })
    const row = tableRows(harness).find((candidate) => candidate.dataset.nodeRow === 'linux-node')!
    const statusCell = descendants(row).find((candidate) => candidate.dataset.cell === 'status')!
    expect(statusCell.dataset.statusDetail).toBe('serving')
    const servingChip = descendants(statusCell).find((node) => node.className === 'chip')!
    expect(servingChip.dataset.tone).toBe('ok')
    expect(descendants(servingChip).map((node) => node.textContent).join('')).toBe('Serving')

    await harness.clickAction('node-detail', { nodeId: 'linux-node' })
    let fields = descendants(harness.byId(ADMIN_UI_DRAWER.bodyId))
    expect(fields.some((node) => node.dataset.drawerField === 'split-readiness')).toBe(false)
    expect(fields.find((node) => node.dataset.drawerField === 'stage-ownership')!.dataset.value).toBe('mesh-linux:0:26:ready')

    await harness.clickAction('model-detail', { profileId: 'mesh-default-qwen36-35b' })
    fields = descendants(harness.byId(ADMIN_UI_DRAWER.bodyId))
    expect(fields.some((node) => node.className === 'split-readiness-block')).toBe(false)
    // The mesh card alone carries the mesh detail: no duplicated stage/serving drawer
    // fields, stage owners and the machine group live in Technical details.
    expect(fields.some((node) => node.dataset.drawerField === 'stage-ownership')).toBe(false)
    expect(fields.some((node) => node.dataset.drawerField === 'serving')).toBe(false)
    expect(fields.find((node) => node.dataset.meshField === 'stage-owners')!.textContent).toBe('Stage owners: L0-26 → Arch Linux · Ready')
    expect(fields.find((node) => node.dataset.meshField === 'mesh-group')!.textContent).toBe('Mesh: Default')
  })


  it('REQ-OBS-014 surfaces current runtime errors after readiness and filters chatter', async () => {
    const nodes = [
      // A not-yet-ready runtime with a captured error is degraded, not healthy.
      { id: 'node-degraded', status: 'online', metrics: { runtimeState: 'starting', nodeState: 'loading model', readyModels: [], activeRequests: 0, runtimeDetail: 'direct prediction return upstream-opened sink unavailable' } },
      { id: 'node-llama-error', status: 'online', metrics: { runtimeState: 'starting', nodeState: 'loading model', readyModels: [], activeRequests: 0, runtimeDetail: 'stage lane I/O failed while opening the socket' } },
      // A hard token overrides the level gate even when inflected, matching the agent.
      { id: 'node-panicked', status: 'online', metrics: { runtimeState: 'starting', nodeState: 'loading model', readyModels: [], activeRequests: 0, runtimeDetail: "W srv thread 'stage-0' panicked at src/lane.rs:118" } },
      // Current agents clear startup errors at readiness, so an error reported while
      // ready occurred after that transition and remains a live degradation.
      { id: 'node-ready-error', status: 'online', metrics: { runtimeState: 'ready', nodeState: 'serving', readyModels: ['m'], activeRequests: 0, runtimeDetail: '8.13.986.469 E ggml_gallocr_reserve_n_impl: failed to allocate' } },
      { id: 'node-clean', status: 'online', metrics: { runtimeState: 'ready', nodeState: 'serving', readyModels: ['m'], activeRequests: 0 } },
      // Leveled chatter from a pre-gate agent is not a live degradation signal.
      { id: 'node-chatter', status: 'online', metrics: { runtimeState: 'ready', nodeState: 'serving', readyModels: ['m'], activeRequests: 0, runtimeDetail: 'WARN failed closing path' } },
      // llama.cpp spells its level as a bare leading letter, so a cache-eviction warning
      // from it is chatter too; a capital inside message text stays a real error.
      { id: 'node-llama-chatter', status: 'online', metrics: { runtimeState: 'ready', nodeState: 'serving', readyModels: ['m'], activeRequests: 0, runtimeDetail: '355.41.434.230 W srv alloc: - making room for prompt cache entry, removing oldest entry (size = 583.167 MiB)' } }
    ]
    const harness = await dashboardHarness({ status: statusFixture({ nodes }) })
    const statusCell = (id: string) => descendants(tableRows(harness).find((row) => row.dataset.nodeRow === id)!).find((node) => node.dataset.cell === 'status')!
    const chipOf = (id: string) => descendants(statusCell(id)).find((node) => node.className === 'chip')!
    expect(statusCell('node-degraded').dataset.runtimeError).toBe('direct prediction return upstream-opened sink unavailable')
    expect(chipOf('node-degraded').dataset.tone).toBe('warn')
    expect(statusCell('node-llama-error').dataset.runtimeError).toBe('stage lane I/O failed while opening the socket')
    expect(chipOf('node-llama-error').dataset.tone).toBe('warn')
    expect(statusCell('node-panicked').dataset.runtimeError).toBe("W srv thread 'stage-0' panicked at src/lane.rs:118")
    expect(chipOf('node-panicked').dataset.tone).toBe('warn')
    expect(statusCell('node-ready-error').dataset.runtimeError).toContain('failed to allocate')
    expect(chipOf('node-ready-error').dataset.tone).toBe('warn')
    expect(statusCell('node-clean').dataset.runtimeError).toBeUndefined()
    expect(chipOf('node-clean').dataset.tone).toBe('ok')
    expect(statusCell('node-chatter').dataset.runtimeError).toBeUndefined()
    expect(chipOf('node-chatter').dataset.tone).toBe('ok')
    expect(statusCell('node-llama-chatter').dataset.runtimeError).toBeUndefined()
    expect(chipOf('node-llama-chatter').dataset.tone).toBe('ok')

    // The drawer carries the exact line for a not-yet-ready runtime…
    await harness.clickAction('node-detail', { nodeId: 'node-degraded' })
    let fields = descendants(harness.byId(ADMIN_UI_DRAWER.bodyId))
    let err = fields.find((node) => node.dataset.drawerField === 'runtime-detail')!
    expect(err.dataset.tone).toBe('danger')
    expect(descendants(err).map((node) => node.textContent).join(' ')).toContain('sink unavailable')
    // A post-readiness error remains visible in the drawer.
    await harness.clickAction(ADMIN_UI_DRAWER.closeAction)
    await harness.clickAction('node-detail', { nodeId: 'node-ready-error' })
    fields = descendants(harness.byId(ADMIN_UI_DRAWER.bodyId))
    expect(fields.find((node) => node.dataset.drawerField === 'runtime-detail')?.dataset.tone).toBe('warn')
  })


  it('REQ-OBS-011 the node drawer surfaces runtime errors, work state, and mesh diagnostics', async () => {
    const nodes = [
      { id: 'node-wedged', status: 'online', agentVersion: 'v1.3.0', metrics: {
        runtimeState: 'starting', nodeState: 'loading model', runtimeDetail: 'cuda out of memory',
        meshRole: 'serving-peer', peerCount: 2, stageCount: 2, splitEnabled: true,
        apiReady: false, consoleReady: true, meshllmVersion: '0.72.2', activeRequests: 0, readyModels: [] } },
      { id: 'node-healthy', status: 'online', runtimeInstall: { runtime: 'meshllm', desiredVersion: 'v0.72.2', installedVersion: '0.72.2', state: 'installed', error: null }, metrics: {
        runtimeState: 'ready', nodeState: 'serving', runtimeDetail: '\u001b[33m WARN\u001b[0m failed closing path', meshRole: 'coordinator', peerCount: 1,
        apiReady: true, consoleReady: true, meshllmVersion: '0.72.2', activeRequests: 0, readyModels: ['m'] } }
    ]
    const harness = await dashboardHarness({ status: statusFixture({ nodes }) })
    const textOf = (item: StubElement) => descendants(item).map((node) => node.textContent).join(' ')

    await harness.clickAction('node-detail', { nodeId: 'node-wedged' })
    let fields = descendants(harness.byId(ADMIN_UI_DRAWER.bodyId))
    const field = (name: string) => fields.find((node) => node.dataset.drawerField === name)
    // The captured mesh-llm error line is surfaced as a danger-toned row carrying the exact detail.
    const err = field('runtime-detail')
    expect(err).toBeDefined()
    expect(err!.dataset.tone).toBe('danger')
    expect(textOf(err!)).toContain('cuda out of memory')
    expect(field('work-state')!.dataset.value).toBe(ADMIN_UI_WORK_STATE.startingModel)
    expect(field('mesh-role')!.dataset.value).toBe(ADMIN_UI_MESH_ROLE.stageOwner)
    expect(field('peers')!.dataset.value).toBe('2')
    expect(field('stages')!.dataset.value).toBe('2')
    expect(field('reachability')!.dataset.value).toBe('api:down;console:ready')
    expect(fieldValue(field('runtime-install')!)).toContain('meshllm 0.72.2')
    expect(fields.some((node) => node.dataset.drawerField === 'meshllm')).toBe(false)

    // A healthy node shows derived work state but stale stderr warnings are not rendered as current
    // runtime/install errors, and semantically matching v-prefixed MeshLLM versions show no drift arrow.
    await harness.clickAction(ADMIN_UI_DRAWER.closeAction)
    await harness.clickAction('node-detail', { nodeId: 'node-healthy' })
    fields = descendants(harness.byId(ADMIN_UI_DRAWER.bodyId))
    expect(field('work-state')).toBeDefined()
    expect(fields.some((node) => node.dataset.drawerField === 'runtime-detail')).toBe(false)
    expect(fields.some((node) => node.dataset.drawerField === 'runtime-install-error')).toBe(false)
    expect(textOf(field('runtime-install')!)).not.toContain('→')
    expect(fields.some((node) => node.dataset.drawerField === 'stages')).toBe(false)
  })


  it('REQ-OBS-014 direct node drawer reports only observed fields and effective cache behavior', async () => {
    const nodes = [
      { id: 'direct-node', status: 'online', runtime: 'llamacpp', metrics: {
        runtimeKind: 'llamacpp', runtimeState: 'ready', apiReady: true, consoleReady: null,
        parallel: 4, ctxSize: 262144, cacheReuse: 256, multimodal: true, gpuMemoryUsedMiB: 3907, gpuMemoryTotalMiB: 24576,
        llamacppVersion: 'b10452', llamacppBackend: 'vulkan',
        readyModels: ['unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-IQ3_S'] } }
    ]
    const harness = await dashboardHarness({ status: statusFixture({ nodes }) })
    const textOf = (item: StubElement) => descendants(item).map((node) => node.textContent).join(' ')

    await harness.clickAction('node-detail', { nodeId: 'direct-node' })
    const fields = descendants(harness.byId(ADMIN_UI_DRAWER.bodyId))
    const field = (name: string) => fields.find((node) => node.dataset.drawerField === name)

    expect(descendants(tableRows(harness).find((row) => row.dataset.nodeRow === 'direct-node')!).some((cell) => cell.dataset.cell === 'toks')).toBe(false)
    expect(field('toks')).toBeUndefined()
    expect(field('reachability')!.dataset.value).toBe('api:ready')
    expect(textOf(field('reachability')!)).not.toContain('down')
    expect(fields.some((node) => node.dataset.drawerField === 'mesh-role')).toBe(false)
    expect(fields.some((node) => node.dataset.drawerField === 'peers')).toBe(false)
    expect(field('direct-parallel')!.dataset.value).toBe('4')
    expect(field('direct-parallel')!.dataset.activeSlots).toBeUndefined()
    expect(fieldValue(field('vram')!)).toBe('3.8 GiB / 24 GiB')
    expect(fieldValue(field('direct-parallel')!)).toBe('parallel 4')
    expect(fieldValue(field('direct-cached-tokens')!)).toBe('not reported')
    // The resolved backend reads next to the version: an NVIDIA Linux box runs the
    // Vulkan build, and the drawer says so instead of implying CUDA (REQ-NODE-013).
    expect(field('llamacpp')!.dataset.value).toBe('b10452 · vulkan')
    // The unavailable cross-divergence optimization must not be confused with
    // ordinary text prefix caching, which remains independently configurable (REQ-OBS-014).
    // Pinning the whole value is what proves "reuse 256" is not also reported: the node does
    // report a cacheReuse of 256, and it must not surface while multimodal has disabled reuse.
    expect(fieldValue(field('direct-cache')!)).toBe('not reported · cross-divergence reuse unavailable for multimodal')
  })


  it('REQ-OBS-012 renders runtime install status in the node table and drawer', async () => {
    const nodes = [{
      id: 'direct-node',
      status: 'online',
      runtime: 'llamacpp',
      activeProfileIds: ['direct-profile'],
      publicModels: ['codeflare-mesh'],
      capacity: 1,
      inFlight: 0,
      lastSeenAt: 1_700_000_100_000,
      runtimeInstall: { runtime: 'llamacpp', desiredVersion: 'b9912', installedVersion: null, state: 'failed', error: 'checksum mismatch' },
      metrics: { runtimeKind: 'llamacpp', runtimeState: 'dependency-missing', activeRequests: 0, lastError: 'checksum mismatch' }
    }]
    const harness = await dashboardHarness({ status: statusFixture({ nodes }) })

    const chip = descendants(harness.byId('nodes-table-body')).find((node) => node.dataset.runtimeInstallChip === 'direct-node')
    expect(chip?.dataset.runtimeInstallState).toBe('failed')
    await harness.clickAction('node-detail', { nodeId: 'direct-node' })
    const installRow = descendants(harness.byId(ADMIN_UI_DRAWER.bodyId)).find((node) => node.dataset.drawerField === 'runtime-install')
    const errorRow = descendants(harness.byId(ADMIN_UI_DRAWER.bodyId)).find((node) => node.dataset.drawerField === 'runtime-install-error')
    expect(installRow?.dataset.runtime).toBe('llamacpp')
    expect(installRow?.dataset.runtimeInstallState).toBe('failed')
    expect(installRow?.dataset.desiredVersion).toBe('b9912')
    expect(errorRow?.dataset.tone).toBe('danger')
  })


  it('REQ-ADM-007 revoking and reloading a machine reach that machine\'s endpoints', async () => {
    // Both carry the node id on the button, so a handler bound to the wrong id would
    // still answer but call the wrong machine.
    const harness = await dashboardHarness()
    await harness.clickAction('node-revoke', { nodeId: 'node-small', out: 'node-output' })
    await harness.clickAction('node-reload', { nodeId: 'node-big', out: 'node-output' })
    const paths = harness.fetchCalls.map((entry) => entry.path)
    expect(paths).toContain('/admin/nodes/node-small/revoke')
    expect(paths).toContain('/admin/nodes/node-big/reload')
    for (const path of ['/admin/nodes/node-small/revoke', '/admin/nodes/node-big/reload']) {
      expect(harness.fetchCalls.find((entry) => entry.path === path)!.init?.method).toBe('POST')
    }
  })

})
