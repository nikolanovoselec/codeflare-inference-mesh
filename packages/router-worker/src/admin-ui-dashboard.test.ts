import { describe, expect, it } from 'vitest'
import { ADMIN_UI_DRAWER, ADMIN_UI_NODES_TABLE, ADMIN_UI_PLAYGROUND, ADMIN_UI_POLLING, ADMIN_UI_TOKS_TRACE, ADMIN_UI_TOPOLOGY, adminUiHtml } from './admin-ui'
import { adminUiCss } from './admin-ui-css'
import { adminUiHarness, descendants, type AdminUiHarness, type StubElement } from './admin-ui-harness'

// DashboardUiTestAnchor

const dashboardNodes = [
  {
    id: 'node-big',
    status: 'online',
    agentVersion: 'v1.3.0',
    // readyModels carries upstream model refs (what the runtime loaded), exactly as the scheduler
    // and the serving-count match on, never the public aliases.
    metrics: { runtimeState: 'running', readyModels: ['unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ3_S', 'unsloth/Qwen2.5-Coder-1.5B-Instruct-GGUF:Q4_K_M'], gpuMemoryTotalMiB: 24_576, gpuMemoryUsedMiB: 20_000, tokensPerSecond: 42.5, activeRequests: 1 }
  },
  {
    id: 'node-small',
    status: 'online',
    agentVersion: 'v1.2.0',
    metrics: { runtimeState: 'ready', readyModels: ['unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ3_S'], gpuMemoryTotalMiB: 8_192, gpuMemoryUsedMiB: 4_000, tokensPerSecond: 61.25, activeRequests: 0 }
  },
  {
    id: 'node-down',
    status: 'offline',
    metrics: { runtimeState: 'failed', activeRequests: 0 }
  }
]

const dashboardProfiles = [
  { id: 'mesh-default-qwen36-35b', displayName: 'Qwen3.6 35B', publicAliases: ['codeflare-mesh', 'qwen3.6:35b-a3b'], upstreamModel: 'unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ3_S', active: true, rolloutPercent: 100, meshllm: { split: false } },
  { id: 'mesh-split-qwen36-35b', displayName: 'Qwen3.6 35B (multi-machine)', publicAliases: ['mesh-split'], upstreamModel: 'unsloth/Qwen3.6-35B-A3B-UD-Q4_K_XL-layers', active: false, rolloutPercent: 100, meshllm: { split: true } }
]

function statusFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    nodes: dashboardNodes,
    profiles: dashboardProfiles,
    profileReadiness: [],
    audit: [],
    generatedAt: 1_700_000_200_000,
    gateway: { gatewayId: 'inference-mesh', routeName: 'codeflare-mesh', publicModel: 'codeflare-mesh' },
    customDomain: { hostname: 'router.test', status: 'provisioned' },
    desiredAgentVersion: 'v1.3.0',
    meshHealth: [],
    ...overrides
  }
}

interface DashboardOptions {
  readonly status?: Record<string, unknown>
  readonly failStatusAfterBoot?: boolean
  readonly respond?: (path: string, init?: RequestInit) => Response | undefined
}

async function dashboardHarness(options: DashboardOptions = {}): Promise<AdminUiHarness> {
  const status = options.status ?? statusFixture()
  let statusCalls = 0
  const html = adminUiHtml('https://router.test', { view: 'dashboard', phase: 'complete', customDomain: 'router.test', recovery: false })
  const harness = adminUiHarness(html, async (path, init) => {
    if (options.respond) { const custom = options.respond(path, init); if (custom) return custom }
    if (path === '/admin/status') {
      statusCalls += 1
      if (options.failStatusAfterBoot && statusCalls > 1) return new Response('down', { status: 503 })
      return Response.json(status)
    }
    if (path === '/admin/agent-versions') return Response.json({ tags: [], stale: false })
    return new Response('command', { status: 200, headers: { 'content-type': 'text/plain' } })
  }, { sessionToken: 'admin-secret' })
  harness.run()
  await harness.flush(10)
  expect(harness.body.dataset.view).toBe('dashboard')
  return harness
}

function statusFetches(harness: AdminUiHarness): number {
  return harness.fetchCalls.filter((call) => call.path === '/admin/status').length
}

function tableRows(harness: AdminUiHarness): StubElement[] {
  return harness.byId(ADMIN_UI_NODES_TABLE.bodyId).children.filter((row) => row.dataset.nodeRow)
}

function rowOrder(harness: AdminUiHarness): string[] {
  return tableRows(harness).map((row) => row.dataset.nodeRow!)
}

describe('dashboard overview contracts', () => {
  it('REQ-OBS-010 computes the stats strip aggregates from admin status', async () => {
    const harness = await dashboardHarness()
    const tiles = harness.byId('overview-tiles').children
    const stat = (key: string) => {
      const tile = tiles.find((candidate) => candidate.dataset.stat === key)
      expect(tile, `no stat tile ${key}`).toBeDefined()
      return descendants(tile!).find((node) => node.dataset.value !== undefined)!.dataset.value
    }
    expect(stat('nodes')).toBe('2/3')
    expect(stat('vram')).toBe('32')
    expect(stat('toks')).toBe('103.8')
  })

  it('REQ-ADM-015 renders a hub-and-spoke topology with one selectable element per node', async () => {
    const harness = await dashboardHarness()
    const canvas = harness.byId(ADMIN_UI_TOPOLOGY.canvasId)
    const parts = descendants(canvas)
    expect(parts.filter((node) => node.dataset.topoHub === 'true')).toHaveLength(1)
    const nodeButtons = parts.filter((node) => node.dataset.action === 'node-detail')
    expect(nodeButtons.map((button) => button.dataset.nodeId).sort()).toEqual(['node-big', 'node-down', 'node-small'])
    const toneOf = (id: string) => nodeButtons.find((button) => button.dataset.nodeId === id)!.className
    expect(toneOf('node-big')).toContain('tone-ok')
    expect(toneOf('node-down')).toContain('tone-danger')
    nodeButtons.forEach((button) => expect(button.getAttribute('style')).toMatch(/left:\d+(\.\d+)?%;top:\d+(\.\d+)?%/))

    const caption = harness.byId(ADMIN_UI_TOPOLOGY.captionId)
    expect(caption.dataset.nodes).toBe('3')
    expect(caption.dataset.serving).toBe('2')

    const listButtons = descendants(harness.byId(ADMIN_UI_TOPOLOGY.listId)).filter((node) => node.dataset.action === 'node-detail')
    expect(listButtons.map((button) => button.dataset.nodeId).sort()).toEqual(['node-big', 'node-down', 'node-small'])
  })

  it('REQ-ADM-015 renders an empty-state topology when no nodes are enrolled', async () => {
    const harness = await dashboardHarness({ status: statusFixture({ nodes: [] }) })
    const canvas = harness.byId(ADMIN_UI_TOPOLOGY.canvasId)
    expect(canvas.classList.contains('is-empty')).toBe(true)
    expect(canvas.children.filter((child) => child.className === 'topo-empty')).toHaveLength(1)
    expect(descendants(canvas).filter((node) => node.dataset.topoHub === 'true')).toHaveLength(1)
    expect(descendants(canvas).filter((node) => node.dataset.action === 'node-detail')).toHaveLength(0)
  })

  it('REQ-ADM-028 sizes each topology spoke to stay within the 2:1 canvas (no vertical overflow)', async () => {
    const harness = await dashboardHarness()
    const canvas = harness.byId(ADMIN_UI_TOPOLOGY.canvasId)
    const spokes = descendants(canvas).filter((node) => node.className === 'topo-spoke')
    expect(spokes.length).toBeGreaterThan(0)
    for (const spoke of spokes) {
      const style = spoke.getAttribute('style') || ''
      const width = Number(/width:([\d.]+)%/.exec(style)?.[1])
      const deg = Number(/rotate\((-?[\d.]+)deg\)/.exec(style)?.[1])
      expect(Number.isFinite(width)).toBe(true)
      expect(Number.isFinite(deg)).toBe(true)
      // Vertical reach (%-of-width) must not exceed the canvas half-height, which is 25% of width
      // for an aspect-ratio:2/1 box. The pre-fix fixed-width spoke overshot at near-vertical angles.
      expect(Math.abs(width * Math.sin(deg * Math.PI / 180))).toBeLessThanOrEqual(25.01)
    }
  })

  it('REQ-ADM-007 overview tiles omit the redundant Active-models and Gateway stats and keep the version tile', async () => {
    const harness = await dashboardHarness()
    const stats = descendants(harness.byId('overview-tiles')).map((node) => node.dataset.stat).filter(Boolean)
    expect(stats).toContain('nodes')
    expect(stats).toContain('version')
    expect(stats).not.toContain('models')
    expect(stats).not.toContain('gateway')
  })

  it('REQ-ADM-015 sorts the nodes table by the clicked column and flips direction on repeat', async () => {
    const harness = await dashboardHarness()
    expect(rowOrder(harness)).toEqual(['node-big', 'node-small', 'node-down'])

    const sortButton = (key: string) => harness.clickAction('nodes-sort', { sort: key })
    await sortButton('toks')
    expect(rowOrder(harness)).toEqual(['node-small', 'node-big', 'node-down'])
    await sortButton('toks')
    expect(rowOrder(harness)).toEqual(['node-down', 'node-big', 'node-small'])
    await sortButton('vram')
    expect(rowOrder(harness)).toEqual(['node-big', 'node-small', 'node-down'])

    const cells = descendants(tableRows(harness)[0]!)
    expect(cells.find((cell) => cell.dataset.cell === 'toks')!.dataset.value).toBe('42.5')
    expect(cells.find((cell) => cell.dataset.cell === 'vram')!.dataset.value).toBe('24576')
    expect(cells.find((cell) => cell.dataset.cell === 'models')!.dataset.value).toBe('2')
  })

  it('REQ-ADM-015 shows a plain node status and never the stale runtime substate when offline', async () => {
    const nodes = [
      { id: 'ready-node', status: 'online', metrics: { runtimeState: 'ready', readyModels: ['m'], tokensPerSecond: 10, gpuMemoryTotalMiB: 8192, gpuMemoryUsedMiB: 4096 } },
      { id: 'loading-node', status: 'online', metrics: { runtimeState: 'downloading', readyModels: [], tokensPerSecond: 0, gpuMemoryTotalMiB: 0 } },
      { id: 'gone-node', status: 'offline', metrics: { runtimeState: 'starting', readyModels: [] } }
    ]
    const harness = await dashboardHarness({ status: statusFixture({ nodes }) })
    const statusOf = (id: string) => {
      const row = tableRows(harness).find((candidate) => candidate.dataset.nodeRow === id)!
      const cell = descendants(row).find((candidate) => candidate.dataset.cell === 'status')!
      return { category: cell.dataset.value, text: descendants(cell).map((node) => node.textContent).filter(Boolean).join(' ') }
    }
    expect(statusOf('ready-node').category).toBe('ready')
    expect(statusOf('ready-node').text).toContain('Ready')
    expect(statusOf('loading-node').category).toBe('active')
    expect(statusOf('loading-node').text).toContain('downloading')
    // A metric that is not yet real reads as an em dash, never a misleading 0.
    const loadingToks = descendants(tableRows(harness).find((row) => row.dataset.nodeRow === 'loading-node')!).find((cell) => cell.dataset.cell === 'toks')!
    expect(loadingToks.textContent).toBe('—')
    // The offline node drops the frozen "starting" substate entirely.
    const gone = statusOf('gone-node')
    expect(gone.category).toBe('offline')
    expect(gone.text).toContain('Offline')
    expect(gone.text).not.toContain('starting')
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

  it('REQ-ADM-020 saves the offline-machine prune window from Settings', async () => {
    const harness = await dashboardHarness()
    const input = harness.byId('prune-seconds')
    input.value = '3600'
    await harness.clickAction('settings-save', { out: 'settings-output' })
    const call = harness.fetchCalls.find((entry) => entry.path === '/admin/settings')
    expect(call).toBeDefined()
    expect(call!.init?.method).toBe('POST')
    expect(JSON.parse(String(call!.init?.body))).toEqual({ offlinePruneSeconds: 3600 })
  })

  it('REQ-ADM-004 copies the install command when the command block is clicked', async () => {
    const harness = await dashboardHarness()
    const block = harness.byId('installer-output')
    block.dataset.output = 'installer-command'
    block.textContent = 'curl -fsSL https://mesh.example.com/install.sh | sh'
    await harness.click(block)
    expect(harness.copied).toContain('curl -fsSL https://mesh.example.com/install.sh | sh')
  })

  it('REQ-OBS-006 renders the activity feed in plain language, hides internal churn, and collapses repeats', async () => {
    const audit = [
      { type: 'mesh_state_stored', at: 6, actor: 'system', target: 'x' },
      { type: 'node_claimed', at: 5, actor: 'setup', target: 'battlestation' },
      { type: 'mesh_state_cleared', at: 4, actor: 'system', target: 'x' },
      { type: 'setup_token_created', at: 3, actor: 'admin' },
      { type: 'setup_token_created', at: 2, actor: 'admin' }
    ]
    const harness = await dashboardHarness({ status: statusFixture({ audit }) })
    const items = descendants(harness.byId('audit-log')).filter((node) => node.className === 'feed-item')
    const typeOf = (item: StubElement) => item.dataset.auditEvent
    const textOf = (item: StubElement) => descendants(item).map((node) => node.textContent).join(' ')
    // Internal per-heartbeat bookkeeping never surfaces as its own feed line.
    expect(items.some((item) => typeOf(item) === 'mesh_state_stored' || typeOf(item) === 'mesh_state_cleared')).toBe(false)
    // A node_claimed event renders as a plain line that names the machine and drops the raw snake_case type.
    const joined = items.find((item) => typeOf(item) === 'node_claimed')
    expect(joined).toBeDefined()
    expect(textOf(joined!)).toContain('battlestation')
    expect(textOf(joined!)).not.toContain('node_claimed')
    // Two identical events collapse into one line carrying a repeat count.
    const tokenItems = items.filter((item) => typeOf(item) === 'setup_token_created')
    expect(tokenItems.length).toBe(1)
    expect(textOf(tokenItems[0]!)).toContain('2')
  })

  it('REQ-ADM-015 opens a node drawer with metrics, version drift, and an armed revoke control', async () => {
    const harness = await dashboardHarness()
    const drawer = harness.byId(ADMIN_UI_DRAWER.containerId)
    expect(drawer.hidden).toBe(true)

    await harness.clickAction('node-detail', { nodeId: 'node-small' })
    expect(drawer.hidden).toBe(false)
    expect(harness.byId(ADMIN_UI_DRAWER.titleId).textContent).toBe('node-small')
    const fields = descendants(harness.byId(ADMIN_UI_DRAWER.bodyId))
    const field = (name: string) => fields.find((node) => node.dataset.drawerField === name)
    expect(field('status')).toBeDefined()
    expect(field('toks')!.dataset.value).toBe('61.25')
    expect(field('vram')!.dataset.value).toBe('4000/8192')
    expect(field('version')!.dataset.reported).toBe('v1.2.0')
    expect(field('version')!.dataset.desiredMatch).toBe('false')
    const models = fields.filter((node) => node.dataset.drawerModel)
    // The node drawer lists the node's own ready-model refs verbatim (the upstream refs the runtime
    // loaded, mirroring production /v1/models), not the public alias.
    expect(models.map((node) => node.dataset.drawerModel)).toEqual(['unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ3_S'])
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
    const status = statusFixture({ nodes: [{ id: 'node-off', status: 'online', deactivated: true, metrics: { runtimeState: 'ready', readyModels: [], activeRequests: 0, tokensPerSecond: 0, gpuMemoryTotalMiB: 8192 } }] })
    const harness = await dashboardHarness({ status })
    const row = harness.byId(ADMIN_UI_NODES_TABLE.bodyId).children.find((node) => node.dataset.nodeRow === 'node-off')!
    const chip = descendants(row).find((node) => node.className === 'chip')!
    expect(chip.dataset.tone).toBe('warn')
    expect(descendants(row).some((node) => node.textContent === 'Deactivated · no model')).toBe(true)
    // Row action is Manage (opens the drawer), never an inline revoke.
    expect(descendants(row).some((node) => node.dataset.action === 'node-detail' && node.textContent === 'Manage')).toBe(true)
    expect(descendants(row).some((node) => node.dataset.action === 'node-revoke')).toBe(false)

    await harness.clickAction('node-detail', { nodeId: 'node-off' })
    const fields = descendants(harness.byId(ADMIN_UI_DRAWER.bodyId))
    const activate = fields.find((node) => node.dataset.action === 'node-activate')
    expect(activate).toBeDefined()
    expect(activate!.textContent).toBe('Activate')
    // A deactivated node shows Activate, not Deactivate.
    expect(fields.some((node) => node.dataset.action === 'node-deactivate')).toBe(false)
  })

  it('REQ-ADM-015 opens a model drawer listing the nodes serving each alias', async () => {
    const harness = await dashboardHarness()
    await harness.clickAction('model-detail', { profileId: 'mesh-default-qwen36-35b' })
    const drawer = harness.byId(ADMIN_UI_DRAWER.containerId)
    expect(drawer.hidden).toBe(false)
    expect(harness.byId(ADMIN_UI_DRAWER.titleId).textContent).toBe('Qwen3.6 35B')
    const fields = descendants(harness.byId(ADMIN_UI_DRAWER.bodyId))
    const servingNodes = fields.filter((node) => node.dataset.drawerServingNode)
    expect(servingNodes.map((node) => node.dataset.drawerServingNode).sort()).toEqual(['node-big', 'node-small'])
    // The drawer prefills the editable name and the model's own call name (its non-shared
    // alias) — not the shared codeflare-mesh alias, which apps use to reach the active model.
    expect(harness.byId('model-edit-name').value).toBe('Qwen3.6 35B')
    expect(harness.byId('model-edit-callname').value).toBe('qwen3.6:35b-a3b')
  })

  it('REQ-ADM-021 loads and saves a per-model VRAM budget from the model drawer', async () => {
    const profiles = [
      { id: 'mesh-default-qwen36-35b', displayName: 'Qwen3.6 35B', publicAliases: ['codeflare-mesh'], active: true, rolloutPercent: 100, contextWindow: 262144, meshllm: { split: false, modelRef: 'ref-a', maxVramGb: 18 } }
    ]
    const harness = await dashboardHarness({ status: statusFixture({ profiles }) })
    await harness.clickAction('model-detail', { profileId: 'mesh-default-qwen36-35b' })
    // The drawer loads the model's current VRAM budget.
    expect(harness.byId('model-edit-vram').value).toBe('18')
    // Saving a new budget posts it to the validated profile-config endpoint.
    harness.byId('model-edit-vram').value = '12.5'
    await harness.clickAction('model-save', { profileId: 'mesh-default-qwen36-35b', out: 'model-output' })
    const call = harness.fetchCalls.find((entry) => entry.path === '/admin/profiles/config')
    expect(JSON.parse(String(call?.init?.body)).maxVramGb).toBe(12.5)
  })

  it('REQ-RUN-002 loads and saves per-model runtime tunables from the model drawer', async () => {
    const profiles = [
      { id: 'mesh-default-qwen36-35b', displayName: 'Qwen3.6 35B', publicAliases: ['codeflare-mesh'], active: true, rolloutPercent: 100, contextWindow: 0, meshllm: { split: false, modelRef: 'ref-a', parallel: 4, cacheTypeK: 'q8_0' } }
    ]
    const harness = await dashboardHarness({ status: statusFixture({ profiles }) })
    await harness.clickAction('model-detail', { profileId: 'mesh-default-qwen36-35b' })
    // An Auto (0) context window loads blank; stored tunables prefill their controls.
    expect(harness.byId('model-edit-context').value).toBe('')
    expect(harness.byId('model-edit-parallel').value).toBe('4')
    expect(harness.byId('model-edit-cache-k').value).toBe('q8_0')
    // Each field carries plain-language help; assert the hint affordance renders (structure, not copy).
    expect(descendants(harness.byId(ADMIN_UI_DRAWER.bodyId)).some((node) => node.className === 'drawer-hint')).toBe(true)
    // Editing lanes / KV / max-output and saving posts the tunables to the validated endpoint;
    // a blank context window is sent as 0 (Auto).
    harness.byId('model-edit-parallel').value = '2'
    harness.byId('model-edit-cache-v').value = 'q4_0'
    harness.byId('model-edit-maxout').value = '8192'
    await harness.clickAction('model-save', { profileId: 'mesh-default-qwen36-35b', out: 'model-output' })
    const call = harness.fetchCalls.find((entry) => entry.path === '/admin/profiles/config')
    const body = JSON.parse(String(call?.init?.body))
    expect(body.parallel).toBe(2)
    expect(body.cacheTypeV).toBe('q4_0')
    expect(body.maxOutputTokens).toBe(8192)
    expect(body.contextWindow).toBe(0)
  })

  it('REQ-ADM-026 shows a Delete control only for a custom, switched-off model', async () => {
    const profiles = [
      { id: 'custom-qwen3-14b-gguf-q4-k-m', displayName: 'Qwen3-14B', publicAliases: ['codeflare-mesh', 'q'], active: false, rolloutPercent: 0, contextWindow: 32768, meshllm: { split: false, modelRef: 'unsloth/x' } },
      { id: 'custom-live', displayName: 'Live custom', publicAliases: ['codeflare-mesh'], active: true, rolloutPercent: 100, contextWindow: 32768, meshllm: { split: false, modelRef: 'y' } },
      { id: 'mesh-default-qwen36-35b', displayName: 'Qwen3.6 35B', publicAliases: ['codeflare-mesh'], active: false, rolloutPercent: 0, contextWindow: 262144, meshllm: { split: false, modelRef: 'z' } }
    ]
    const harness = await dashboardHarness({ status: statusFixture({ profiles }) })
    const deleteButton = () => descendants(harness.byId(ADMIN_UI_DRAWER.bodyId)).find((node) => node.dataset.action === 'model-delete')

    await harness.clickAction('model-detail', { profileId: 'custom-qwen3-14b-gguf-q4-k-m' })
    const del = deleteButton()
    expect(del, 'a custom, off model exposes Delete').toBeDefined()
    expect(del!.dataset.profileId).toBe('custom-qwen3-14b-gguf-q4-k-m')
    expect(del!.dataset.confirm, 'delete must arm before submitting').toBeTruthy()
    await harness.clickAction(ADMIN_UI_DRAWER.closeAction)

    await harness.clickAction('model-detail', { profileId: 'custom-live' })
    expect(deleteButton(), 'an active model hides Delete (turn it off first)').toBeUndefined()
    await harness.clickAction(ADMIN_UI_DRAWER.closeAction)

    await harness.clickAction('model-detail', { profileId: 'mesh-default-qwen36-35b' })
    expect(deleteButton(), 'a built-in model hides Delete (it re-seeds)').toBeUndefined()
  })

  it('REQ-ADM-026 deletes a model from the drawer through the profiles delete endpoint and closes the drawer', async () => {
    const profiles = [
      { id: 'custom-gone', displayName: 'Gone', publicAliases: ['codeflare-mesh', 'g'], active: false, rolloutPercent: 0, contextWindow: 32768, meshllm: { split: false, modelRef: 'r' } }
    ]
    const harness = await dashboardHarness({ status: statusFixture({ profiles }), respond: (path, init) => {
      if (path === '/admin/profiles/delete' && (init?.method || 'GET') === 'POST') return Response.json({ ok: true, profileId: 'custom-gone' })
      return undefined
    } })
    await harness.clickAction('model-detail', { profileId: 'custom-gone' })
    expect(harness.byId(ADMIN_UI_DRAWER.containerId).hidden).toBe(false)
    await harness.clickAction('model-delete', { profileId: 'custom-gone', out: 'model-edit-output' })
    await harness.flush(5)
    const call = harness.fetchCalls.find((entry) => entry.path === '/admin/profiles/delete')
    expect(call, 'delete posts to /admin/profiles/delete').toBeDefined()
    expect(JSON.parse(String(call?.init?.body)).profileId).toBe('custom-gone')
    expect(harness.byId(ADMIN_UI_DRAWER.containerId).hidden, 'drawer closes after delete').toBe(true)
  })

  it('REQ-ADM-026 holds the status poll while a destructive confirm is armed so it is not clobbered', async () => {
    const profiles = [
      { id: 'custom-keep', displayName: 'Keep', publicAliases: ['codeflare-mesh', 'k'], active: false, rolloutPercent: 0, contextWindow: 32768, meshllm: { split: false, modelRef: 'r' } }
    ]
    const harness = await dashboardHarness({ status: statusFixture({ profiles }) })
    await harness.clickAction('model-detail', { profileId: 'custom-keep' })
    const del = descendants(harness.byId(ADMIN_UI_DRAWER.bodyId)).find((node) => node.dataset.action === 'model-delete')
    expect(del, 'drawer exposes the delete control').toBeDefined()
    // The first click arms the confirm and must not submit or clear.
    await harness.click(del!)
    expect(del!.dataset.armed).toBe('true')
    const baseline = statusFetches(harness)
    // Firing the poll while armed must skip the refresh that would rebuild the cards and drop the arm.
    harness.runTimers()
    await harness.flush(10)
    expect(statusFetches(harness), 'poll is held while a confirm is armed').toBe(baseline)
    expect(harness.timers.some((timer) => timer.delay === ADMIN_UI_POLLING.intervalMs && !timer.cancelled), 'poll keeps rescheduling').toBe(true)
  })

  it('REQ-ADM-022 manages API keys from Settings: list renders, create reveals the secret once, rotate and revoke call the API', async () => {
    const harness = await dashboardHarness({ respond: (path, init) => {
      const method = (init && init.method) || 'GET'
      if (path === '/api/v1/keys' && method === 'GET') return Response.json({ keys: [{ id: 'automation_a', createdAt: 1_700_000_000_000 }] })
      if (path === '/api/v1/keys' && method === 'POST') return Response.json({ id: 'automation_new', token: 'automation_secret_xyz', createdAt: 1_700_000_100_000 }, { status: 201 })
      if (path === '/api/v1/keys/automation_a/rotate' && method === 'POST') return Response.json({ id: 'automation_rot', token: 'automation_secret_rot', rotatedFrom: 'automation_a', createdAt: 1_700_000_200_000 }, { status: 201 })
      if (path === '/api/v1/keys/automation_a' && method === 'DELETE') return Response.json({ ok: true, id: 'automation_a' })
      return undefined
    } })
    // Active keys render from GET /api/v1/keys.
    expect(harness.byId('api-key-list').children.find((row) => row.dataset.apiKeyRow === 'automation_a')).toBeDefined()
    // Creating a key reveals the secret exactly once in the output.
    await harness.clickAction('api-key-create', { out: 'api-key-output' })
    await harness.flush(3)
    expect(harness.byId('api-key-output').textContent).toBe('automation_secret_xyz')
    // Rotate posts to the key's rotate endpoint; revoke deletes the key.
    await harness.clickAction('api-key-rotate', { keyId: 'automation_a', out: 'api-key-output' })
    await harness.flush(3)
    expect(harness.fetchCalls.find((entry) => entry.path === '/api/v1/keys/automation_a/rotate')?.init?.method).toBe('POST')
    await harness.clickAction('api-key-revoke', { keyId: 'automation_a', out: 'api-key-output' })
    await harness.flush(3)
    expect(harness.fetchCalls.find((entry) => entry.path === '/api/v1/keys/automation_a' && entry.init?.method === 'DELETE')).toBeDefined()
  })

  it('REQ-ADM-023 loads and saves a per-node VRAM override from the node drawer', async () => {
    const nodes = [{ id: 'node-weak', status: 'online', agentVersion: 'v1.3.0', maxVramGbOverride: 4, metrics: { runtimeState: 'ready', readyModels: ['codeflare-mesh'], gpuMemoryTotalMiB: 8192, gpuMemoryUsedMiB: 4000, tokensPerSecond: 20, activeRequests: 0 } }]
    const harness = await dashboardHarness({ status: statusFixture({ nodes }) })
    await harness.clickAction('node-detail', { nodeId: 'node-weak' })
    // The drawer loads the node's current override.
    expect(harness.byId('node-edit-vram').value).toBe('4')
    // Saving posts the new override to the node config endpoint.
    harness.byId('node-edit-vram').value = '2'
    await harness.clickAction('node-config-save', { nodeId: 'node-weak', out: 'node-output' })
    const call = harness.fetchCalls.find((entry) => entry.path === '/admin/nodes/node-weak/config')
    expect(JSON.parse(String(call?.init?.body)).maxVramGbOverride).toBe(2)
  })
})

describe('dashboard polling contracts', () => {
  it('REQ-OBS-010 refreshes admin status on the poll interval', async () => {
    const harness = await dashboardHarness()
    const baseline = statusFetches(harness)
    const poll = harness.timers.find((timer) => timer.delay === ADMIN_UI_POLLING.intervalMs && !timer.cancelled)
    expect(poll, 'dashboard boot must schedule the status poll').toBeDefined()

    harness.runTimers()
    await harness.flush(10)
    expect(statusFetches(harness)).toBe(baseline + 1)
    expect(harness.timers.some((timer) => timer.delay === ADMIN_UI_POLLING.intervalMs && !timer.cancelled), 'poll must reschedule itself').toBe(true)
  })

  it('REQ-OBS-010 pauses polling while the tab is hidden and resumes with a fresh read', async () => {
    const harness = await dashboardHarness()
    const baseline = statusFetches(harness)

    await harness.setHidden(true)
    harness.runTimers()
    await harness.flush(10)
    expect(statusFetches(harness)).toBe(baseline)

    await harness.setHidden(false)
    await harness.flush(10)
    expect(statusFetches(harness)).toBe(baseline + 1)
    expect(harness.timers.some((timer) => timer.delay === ADMIN_UI_POLLING.intervalMs && !timer.cancelled), 'resume must restart the poll loop').toBe(true)
  })

  it('REQ-OBS-010 stops polling after sign-out leaves the dashboard view', async () => {
    const harness = await dashboardHarness()
    const baseline = statusFetches(harness)
    await harness.clickAction('sign-out')
    expect(harness.body.dataset.view).toBe('setup')
    expect(harness.timers.some((timer) => timer.delay === ADMIN_UI_POLLING.intervalMs && !timer.cancelled), 'sign-out must cancel the pending poll').toBe(false)
    harness.runTimers()
    await harness.flush(10)
    expect(statusFetches(harness)).toBe(baseline)
  })

  it('REQ-OBS-010 flips the live badge when a poll fails and recovers on the next success', async () => {
    const harness = await dashboardHarness({ failStatusAfterBoot: true })
    expect(harness.byId('health-pill').dataset.health).toBe('ok')

    harness.runTimers()
    await harness.flush(10)
    expect(harness.byId('health-pill').dataset.health).toBe('error')
    expect(harness.timers.some((timer) => timer.delay === ADMIN_UI_POLLING.intervalMs && !timer.cancelled), 'failed poll must keep polling').toBe(true)
  })
})

describe('dashboard throughput trace and playground contracts', () => {
  function toksStatus(total: number): Record<string, unknown> {
    return statusFixture({ nodes: [{ id: 'node-x', status: 'online', metrics: { runtimeState: 'running', tokensPerSecond: total, readyModels: [] } }] })
  }

  it('REQ-OBS-010 renders a smoothed rolling throughput trace from successive polls', async () => {
    let servedToks = 103.75
    const harness = await dashboardHarness({ respond: (path) => path === '/admin/status' ? Response.json(toksStatus(servedToks)) : undefined })
    const trace = harness.byId(ADMIN_UI_TOKS_TRACE.containerId)
    const bars = () => trace.children.filter((bar) => bar.dataset.sample !== undefined)

    expect(bars().map((bar) => bar.dataset.sample)).toEqual(['103.75'])
    expect(bars().map((bar) => bar.dataset.smoothed)).toEqual(['103.8'])
    bars().forEach((bar) => expect(bar.getAttribute('style')).toMatch(/height:\d+(\.\d+)?%/))

    servedToks = 42.5
    harness.runTimers()
    await harness.flush(10)
    expect(bars().map((bar) => bar.dataset.sample)).toEqual(['103.75', '42.5'])
    expect(bars().at(-1)!.dataset.smoothed).toBe('73.1')

    servedToks = 0
    harness.runTimers()
    await harness.flush(10)
    expect(bars().map((bar) => bar.dataset.sample)).toEqual(['103.75', '42.5', '0'])
    expect(bars().at(-1)!.dataset.smoothed).toBe('48.8')
  })

  it('REQ-OBS-010 renders no throughput bars while there is no real throughput', async () => {
    const harness = await dashboardHarness({ respond: (path) => path === '/admin/status' ? Response.json(toksStatus(0)) : undefined })
    const trace = harness.byId(ADMIN_UI_TOKS_TRACE.containerId)
    const bars = () => trace.children.filter((bar) => bar.dataset.sample !== undefined)
    expect(bars().length).toBe(0)
    harness.runTimers()
    await harness.flush(10)
    harness.runTimers()
    await harness.flush(10)
    expect(bars().length).toBe(0)
  })

  it('REQ-OBS-010 caps the throughput trace at the configured rolling window', async () => {
    const harness = await dashboardHarness()
    const trace = harness.byId(ADMIN_UI_TOKS_TRACE.containerId)
    for (let poll = 0; poll < 45; poll += 1) {
      harness.runTimers()
      await harness.flush(6)
    }
    const bars = trace.children.filter((bar) => bar.dataset.sample !== undefined)
    expect(bars.length).toBe(ADMIN_UI_TOKS_TRACE.window)
  })

  it('REQ-ADM-031 lists one playground option per model on, valued by callable name and labeled with the model name', async () => {
    const harness = await dashboardHarness()
    const select = harness.byId(ADMIN_UI_PLAYGROUND.selectId)
    // One option per model that is on. The value (and the option's data attribute) is the model's
    // own callable name — the alias the gateway resolves — not the shared codeflare-mesh alias.
    expect(select.children.map((option) => option.value)).toEqual(['qwen3.6:35b-a3b'])
    expect(select.children.map((option) => option.dataset.playgroundModelOption)).toEqual(['qwen3.6:35b-a3b'])
    // The label pairs both contract values (callable name and model name); format is not pinned.
    const label = select.children[0]!.textContent || ''
    expect(label).toContain('qwen3.6:35b-a3b')
    expect(label).toContain('Qwen3.6 35B')
  })

  it('REQ-ADM-016 streams the direct-target playground response incrementally as chunks arrive', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c } })
    // Default target is the direct router, so the send hits the direct-chat endpoint with an internal model.
    const harness = await dashboardHarness({
      respond: (path) => path === '/admin/playground/direct-chat' ? new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }) : undefined
    })
    harness.byId(ADMIN_UI_PLAYGROUND.promptId).value = 'hello mesh'
    const send = harness.clickAction(ADMIN_UI_PLAYGROUND.sendAction, { out: ADMIN_UI_PLAYGROUND.outputId })
    await harness.flush(10)

    controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'))
    await harness.flush(10)
    expect(harness.byId(ADMIN_UI_PLAYGROUND.outputId).textContent).toBe('Hello')

    controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":" mesh"}}]}\n\ndata: [DONE]\n\n'))
    controller.close()
    await harness.flush(10)
    await send

    expect(harness.byId(ADMIN_UI_PLAYGROUND.outputId).textContent).toBe('Hello mesh')
    const call = harness.fetchCalls.find((entry) => entry.path === '/admin/playground/direct-chat')
    expect(call?.init?.method).toBe('POST')
    expect(JSON.parse(String(call?.init?.body))).toEqual({ model: 'qwen3.6:35b-a3b', messages: [{ role: 'user', content: 'hello mesh' }] })
  })

  it('REQ-ADM-016 renders the tools input, max-token cap, and a stop control in the playground', () => {
    const html = adminUiHtml('https://router.test', { view: 'dashboard', phase: 'complete', customDomain: 'router.test', recovery: false })
    expect(html).toContain('id="' + ADMIN_UI_PLAYGROUND.toolsId + '"')
    expect(html).toContain('id="' + ADMIN_UI_PLAYGROUND.maxTokensId + '"')
    expect(html).toContain('data-action="' + ADMIN_UI_PLAYGROUND.stopAction + '"')
  })

  it('REQ-ADM-029 forwards tools and a max-token cap and surfaces tool calls on the dynamic route', async () => {
    const harness = await dashboardHarness({
      respond: (path) => path === '/admin/playground/direct-chat'
        ? new Response('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"get_weather","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })
        : undefined
    })
    harness.byId(ADMIN_UI_PLAYGROUND.promptId).value = 'call a tool'
    harness.byId(ADMIN_UI_PLAYGROUND.toolsId).value = '[{"type":"function","function":{"name":"get_weather","parameters":{}}}]'
    harness.byId(ADMIN_UI_PLAYGROUND.maxTokensId).value = '256'
    const send = harness.clickAction(ADMIN_UI_PLAYGROUND.sendAction, { out: ADMIN_UI_PLAYGROUND.outputId })
    await harness.flush(10)
    await send

    const call = harness.fetchCalls.find((entry) => entry.path === '/admin/playground/direct-chat')
    const body = JSON.parse(String(call?.init?.body))
    expect(body.tools).toEqual([{ type: 'function', function: { name: 'get_weather', parameters: {} } }])
    expect(body.maxTokens).toBe(256)
    expect(harness.byId(ADMIN_UI_PLAYGROUND.outputId).textContent).toContain('[tool calls] get_weather')
  })

  it('REQ-ADM-016 appends stream chunks to one text node so a mid-stream selection survives', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c } })
    const harness = await dashboardHarness({
      respond: (path) => path === '/admin/playground/direct-chat' ? new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }) : undefined
    })
    harness.byId(ADMIN_UI_PLAYGROUND.promptId).value = 'hi'
    const send = harness.clickAction(ADMIN_UI_PLAYGROUND.sendAction, { out: ADMIN_UI_PLAYGROUND.outputId })
    await harness.flush(10)

    controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n'))
    await harness.flush(10)
    const outputEl = harness.byId(ADMIN_UI_PLAYGROUND.outputId)
    const firstNode = outputEl.children.find((child) => child.nodeType === 3)
    expect(firstNode, 'the first chunk creates a text node').toBeDefined()

    controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n\n'))
    controller.close()
    await harness.flush(10)
    await send

    // The same text node grew in place instead of being replaced, so a selection inside
    // it would survive; assert one text-node child, still the original reference.
    const textNodes = outputEl.children.filter((child) => child.nodeType === 3)
    expect(textNodes).toHaveLength(1)
    expect(textNodes[0]).toBe(firstNode)
    expect(outputEl.textContent).toBe('Hello')
  })

  it('REQ-ADM-016 the stop control aborts an in-flight playground stream', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c } })
    let aborted = false
    const harness = await dashboardHarness({
      respond: (path, init) => {
        if (path !== '/admin/playground/direct-chat') return undefined
        // Faithfully model the browser: aborting the fetch signal errors the response
        // body, so the in-flight read rejects and the stream ends.
        init?.signal?.addEventListener('abort', () => {
          aborted = true
          try { controller.error(new DOMException('aborted', 'AbortError')) } catch { /* already closed */ }
        })
        return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }
    })
    harness.byId(ADMIN_UI_PLAYGROUND.promptId).value = 'hello mesh'
    const send = harness.clickAction(ADMIN_UI_PLAYGROUND.sendAction, { out: ADMIN_UI_PLAYGROUND.outputId })
    await harness.flush(10)

    controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n'))
    await harness.flush(10)
    expect(harness.byId(ADMIN_UI_PLAYGROUND.outputId).textContent).toBe('Hel')

    // Pressing Stop aborts the fetch signal, which ends the stream.
    await harness.clickAction(ADMIN_UI_PLAYGROUND.stopAction)
    await harness.flush(10)
    expect(aborted, 'stop aborts the in-flight fetch signal').toBe(true)

    // A chunk produced after Stop must not reach the output; the read loop has ended.
    try { controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n')) } catch { /* stream aborted */ }
    await harness.flush(10)
    await send
    expect(harness.byId(ADMIN_UI_PLAYGROUND.outputId).textContent).toBe('Hel')
  })

  it('REQ-ADM-016 the status poll preserves the chosen playground model', async () => {
    const profiles = [
      { id: 'model-a', displayName: 'Model A', publicAliases: ['codeflare-mesh', 'model-a'], active: true, rolloutPercent: 100, meshllm: { split: false } },
      { id: 'model-b', displayName: 'Model B', publicAliases: ['codeflare-mesh', 'model-b'], active: true, rolloutPercent: 100, meshllm: { split: false } }
    ]
    const harness = await dashboardHarness({ status: statusFixture({ profiles }) })
    expect(harness.byId(ADMIN_UI_PLAYGROUND.selectId).children.map((option) => option.value)).toEqual(['model-a', 'model-b'])
    // Operator picks the second model, then a periodic status poll re-renders the select.
    harness.byId(ADMIN_UI_PLAYGROUND.selectId).value = 'model-b'
    await harness.clickAction('status-refresh')
    expect(harness.byId(ADMIN_UI_PLAYGROUND.selectId).value).toBe('model-b')
  })

  it('REQ-ADM-031 a gateway target lists that gateway routes and sends the selected route to the gateway endpoint', async () => {
    const harness = await dashboardHarness({
      respond: (path) => {
        if (path.startsWith('/admin/cloudflare/gateway/options')) return Response.json({ gateways: [{ id: 'gw-a' }], routes: [{ id: 'r1', name: 'codeflare-mesh' }, { id: 'r2', name: 'custom-route' }], defaults: { gatewayId: 'gw-a', providerName: 'Codeflare Inference Mesh' } })
        if (path === '/admin/playground/chat') return new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })
        return undefined
      }
    })
    // Opening the Playground lists the direct router plus the discovered gateway as targets.
    await harness.click(harness.query('[data-nav="playground"]'))
    await harness.flush(10)
    const target = harness.byId(ADMIN_UI_PLAYGROUND.targetSelectId)
    expect(target.children.map((option) => option.value)).toEqual(['direct', 'gw-a'])

    // Switching to the gateway target fills the model/route select from that gateway's routes.
    target.value = 'gw-a'
    await harness.change(target)
    await harness.flush(10)
    expect(harness.byId(ADMIN_UI_PLAYGROUND.selectId).children.map((option) => option.value)).toEqual(['codeflare-mesh', 'custom-route'])

    harness.byId(ADMIN_UI_PLAYGROUND.selectId).value = 'custom-route'
    harness.byId(ADMIN_UI_PLAYGROUND.promptId).value = 'hi'
    const send = harness.clickAction(ADMIN_UI_PLAYGROUND.sendAction, { out: ADMIN_UI_PLAYGROUND.outputId })
    await harness.flush(10)
    await send
    const call = harness.fetchCalls.find((entry) => entry.path === '/admin/playground/chat')
    expect(call?.init?.method).toBe('POST')
    expect(JSON.parse(String(call?.init?.body))).toEqual({ gatewayId: 'gw-a', route: 'custom-route', messages: [{ role: 'user', content: 'hi' }] })
  })

  it('REQ-ADM-016 appends a status-specific actionable hint when a playground request fails', async () => {
    const bareLen = (status: number) => ('Playground request failed (' + status + ').').length
    const outputFor = async (status: number): Promise<string> => {
      const harness = await dashboardHarness({ respond: (path) => path === '/admin/playground/direct-chat' ? new Response('{"error":"x"}', { status }) : undefined })
      harness.byId(ADMIN_UI_PLAYGROUND.promptId).value = 'hi'
      const send = harness.clickAction(ADMIN_UI_PLAYGROUND.sendAction, { out: ADMIN_UI_PLAYGROUND.outputId })
      await harness.flush(10)
      await send
      return harness.byId(ADMIN_UI_PLAYGROUND.outputId).textContent
    }
    const out400 = await outputFor(400)
    const out401 = await outputFor(401)
    const out409 = await outputFor(409)
    const out404 = await outputFor(404)
    const out502 = await outputFor(502)
    const out503 = await outputFor(503)
    // Behavioral contract (survives without pinning copy): each failure carries the status code plus a
    // hint beyond the bare line, and distinct statuses map to distinct hints. Gut playgroundHint -> all
    // collapse to the bare line and the length + inequality assertions fail.
    expect(out401).toContain('(401)')
    expect(out400.length).toBeGreaterThan(bareLen(400))
    expect(out401.length).toBeGreaterThan(bareLen(401))
    expect(out409.length).toBeGreaterThan(bareLen(409))
    expect(out400).not.toBe(out401)
    expect(out401).not.toBe(out409)
    // The thin-forwarder scheduler-miss statuses each carry their own actionable hint: 404 no-profile,
    // 502 node_unreachable, 503 no ready node. A scheduler miss no longer returns 429, so 429 maps to no
    // hint here (a rate-limit 429 from the top-level limiter is a separate path).
    expect(out404.length).toBeGreaterThan(bareLen(404))
    expect(out502.length).toBeGreaterThan(bareLen(502))
    expect(out503.length).toBeGreaterThan(bareLen(503))
    expect(out404).not.toBe(out502)
    expect(out502).not.toBe(out503)
  })

  it('REQ-ADM-005 surfaces the currently provisioned custom domain in Routing', async () => {
    const harness = await dashboardHarness()
    const card = harness.byId('custom-domain-current')
    const value = descendants(card).find((node) => node.className === 'state-value')
    const chip = descendants(card).find((node) => node.className === 'chip')
    // Contract values, not copy: the prominent readout carries the provisioned host as its value
    // and its status as a chip. Gutting the readout leaves the empty-state card (placeholder value,
    // no chip), so the host and the ok-toned status chip both disappear.
    expect(value!.textContent).toBe('router.test')
    expect(card.classList.contains('is-empty')).toBe(false)
    expect(chip, 'a provisioned domain shows a status chip').toBeDefined()
    expect(chip!.dataset.tone).toBe('ok')
  })

  it('REQ-ADM-005 renders an empty-state card when no custom domain is recorded', async () => {
    const harness = await dashboardHarness({ status: statusFixture({ customDomain: undefined }) })
    const card = harness.byId('custom-domain-current')
    // No domain: the card is the empty state (placeholder value, no status chip).
    expect(card.classList.contains('is-empty')).toBe(true)
    const value = descendants(card).find((node) => node.className === 'state-value')
    expect(value!.textContent).toBe('Not set yet')
    expect(descendants(card).some((node) => node.className === 'chip')).toBe(false)
  })

  it('REQ-ADM-018 orders profile rows active-first regardless of source order', async () => {
    const profiles = [
      { id: 'standby-a', publicAliases: ['standby-a'], active: false, rolloutPercent: 100, meshllm: { split: false } },
      { id: 'serving-b', publicAliases: ['serving-b'], active: true, rolloutPercent: 100, meshllm: { split: false } },
      { id: 'standby-c', publicAliases: ['standby-c'], active: false, rolloutPercent: 100, meshllm: { split: false } }
    ]
    const harness = await dashboardHarness({ status: statusFixture({ profiles }) })
    const rows = harness.byId('profile-list').children.filter((row) => row.dataset.profileRow)
    // Active surfaces first; stable sort preserves source order within each group.
    expect(rows.map((row) => row.dataset.profileRow)).toEqual(['serving-b', 'standby-a', 'standby-c'])
  })

  it('REQ-ADM-018 shows each model as one card with its canonical name and an on/off toggle', async () => {
    const harness = await dashboardHarness()
    const rows = harness.byId('profile-list').children.filter((row) => row.dataset.profileRow)
    // Every model is visible, named by its display name (not its wiring id).
    const names = descendants(harness.byId('profile-list')).filter((node) => node.dataset.modelName).map((node) => node.textContent)
    expect(names).toContain('Qwen3.6 35B')
    expect(names).toContain('Qwen3.6 35B (multi-machine)')
    // The toggle reflects state via its data-on contract (not its copy): the active model is on, the other off.
    const toggle = (id: string) => descendants(rows.find((row) => row.dataset.profileRow === id)!).find((node) => node.dataset.action === 'model-toggle')!
    expect(toggle('mesh-default-qwen36-35b').dataset.on).toBe('true')
    expect(toggle('mesh-split-qwen36-35b').dataset.on).toBe('false')
  })

  it('REQ-ADM-018 badges each model with its serving mode instead of baking it into the name', async () => {
    const profiles = [
      { id: 'single-a', displayName: 'Single A', publicAliases: ['codeflare-mesh', 'single-a'], active: true, rolloutPercent: 100, meshllm: { split: false } },
      { id: 'split-b', displayName: 'Split B', publicAliases: ['codeflare-mesh', 'split-b'], active: false, rolloutPercent: 0, meshllm: { split: true } }
    ]
    const harness = await dashboardHarness({ status: statusFixture({ profiles }) })
    const rows = harness.byId('profile-list').children.filter((row) => row.dataset.profileRow)
    const badge = (id: string) => descendants(rows.find((row) => row.dataset.profileRow === id)!).find((node) => node.dataset.servingMode)!
    // Serving mode is carried by a badge attribute; a split model's badge stands out in accent.
    expect(badge('single-a').dataset.servingMode).toBe('single')
    expect(badge('split-b').dataset.servingMode).toBe('split')
    expect(badge('split-b').dataset.tone).toBe('accent')
    expect(badge('single-a').dataset.tone).toBeUndefined()
  })

  it('REQ-OBS-007 labels overview mesh chips by model name and stays neutral when a model is not shared', async () => {
    const harness = await dashboardHarness({
      status: statusFixture({
        meshHealth: [{ profileId: 'mesh-default-qwen36-35b', rotation: 0, peerNodeIds: [], readyModels: [], failedNodeIds: [], tokenCount: 0 }]
      })
    })
    const chip = harness.byId('overview-mesh').children[0]
    expect(chip, 'overview should render a mesh chip').toBeDefined()
    // The stub does not aggregate textContent from children; the label lives on a child span.
    const label = descendants(chip!).map((node) => node.textContent).join('')
    // Named by the model, not the wiring id or a raw rotation counter.
    expect(label).toContain('Qwen3.6 35B')
    expect(label).not.toContain('mesh-default-qwen36-35b')
    // A single-node model reads "not shared yet" in a neutral tone, never an alarming amber "forming".
    expect(label).not.toContain('forming')
    expect(chip!.dataset.tone).not.toBe('warn')
    expect(chip!.dataset.tone).not.toBe('danger')
  })

  it('REQ-ADM-015 tags each node cell with its column label for the stacked mobile layout', async () => {
    const harness = await dashboardHarness()
    const row = harness.byId(ADMIN_UI_NODES_TABLE.bodyId).children.find((child) => child.dataset.nodeRow)
    expect(row, 'a node row should render').toBeDefined()
    // Every cell carries a data-label so the mobile card layout prints "Label: value" without side-scroll.
    expect(row!.children.map((cell) => cell.dataset.label)).toEqual(['Machine', 'Status', 'tok/s', 'VRAM', 'Models', 'Version'])
  })
})

describe('read-only user console contracts', () => {
  it('REQ-ADM-017 hides every configuration section and keeps only overview and playground for the user role', async () => {
    const harness = await dashboardHarness({ status: statusFixture({ viewerRole: 'user' }) })
    expect(harness.byId('overview').hidden).toBe(false)
    expect(harness.byId('playground').hidden).toBe(false)
    for (const section of ['nodes', 'models', 'routing', 'settings']) {
      expect(harness.byId(section).hidden).toBe(true)
    }
  })

  it('REQ-ADM-017 leaves every section visible for the admin role', async () => {
    const harness = await dashboardHarness({ status: statusFixture({ viewerRole: 'admin' }) })
    for (const section of ['overview', 'nodes', 'models', 'routing', 'playground', 'settings']) {
      expect(harness.byId(section).hidden).toBe(false)
    }
  })
})

describe('dashboard routing contracts', () => {
  const routingRespond = (provisioned: boolean) => (path: string) => {
    if (path.startsWith('/admin/cloudflare/gateway/options')) return Response.json({ gateways: [{ id: 'inference-mesh' }], routes: [], defaults: { gatewayId: 'inference-mesh', providerName: 'Codeflare Inference Mesh' } })
    if (path.startsWith('/admin/cloudflare/gateway/provision-status')) return Response.json({ gatewayId: 'inference-mesh', provisioned, routeEnabled: provisioned, ...(provisioned ? { routeId: 'r', providerId: 'p' } : {}) })
    return undefined
  }

  it('REQ-ADM-024 the route chip is operational only when the selected gateway is live-provisioned', async () => {
    // Provisioned per the live check but zero nodes online: the chip is driven by provisioning
    // state (route + provider), not node or serving health, so it still reads operational.
    const harness = await dashboardHarness({ status: statusFixture({ nodes: [] }), respond: routingRespond(true) })
    await harness.click(harness.query('[data-nav="routing"]'))
    await harness.flush(20)
    expect(harness.byId('rt-route-chip').hidden).toBe(false)
    expect(harness.byId('rt-route-chip').classList.contains('operational')).toBe(true)
    expect(harness.byId('rt-route-state').textContent).not.toBe('not connected')
  })

  it('REQ-ADM-024 hides the route chip when the selected gateway is not provisioned', async () => {
    // Default fixture nodes are online and serving, but the live check reports the selected
    // gateway is not provisioned: the chip is hidden, never shown as a stale "not connected".
    const harness = await dashboardHarness({ respond: routingRespond(false) })
    await harness.click(harness.query('[data-nav="routing"]'))
    await harness.flush(20)
    expect(harness.byId('rt-route-chip').hidden).toBe(true)
    expect(harness.byId('rt-route-chip').classList.contains('operational')).toBe(false)
  })

  it('REQ-ADM-024 the Routing screen exposes a copy control for the minted provider key', async () => {
    const harness = await dashboardHarness({
      respond: (path, init) => path === '/admin/cloudflare/gateway/sync' && (init?.method || 'GET') === 'POST'
        ? Response.json({ providerToken: 'provider_minted_key', byokInstruction: 'paste it into the AI Gateway provider key field' })
        : undefined
    })
    await harness.clickAction('gateway-sync', { out: 'gateway-output', prefix: 'rt-' })
    await harness.flush(3)
    // The minted provider key surfaces as a token card with a copy control carrying the key value.
    const cards = harness.byId('gateway-output').children.filter((child) => child.dataset.tokenCard)
    expect(cards).toHaveLength(1)
    expect(cards[0]!.dataset.tokenCard).toBe('AI Gateway provider key')
    expect(cards[0]!.children.find((child) => child.dataset.copy)!.dataset.copy).toBe('provider_minted_key')
  })

  it('REQ-ADM-024 renders the AI Gateway paste instruction with the minted key', async () => {
    const harness = await dashboardHarness({
      respond: (path, init) => path === '/admin/cloudflare/gateway/sync' && (init?.method || 'GET') === 'POST'
        ? Response.json({ providerToken: 'provider_minted_key', byokInstruction: 'server-provided paste instruction' })
        : undefined
    })
    await harness.clickAction('gateway-sync', { out: 'gateway-output', prefix: 'rt-' })
    await harness.flush(3)
    // The server-provided BYOK instruction is rendered to the operator, not just carried in the response body.
    const warning = harness.byId('gateway-output').children.find((child) => child.dataset.tokenWarning)
    expect(warning).toBeDefined()
    expect(warning!.textContent).toBe('server-provided paste instruction')
  })

  it('REQ-ADM-024 defines the pulsing operational route-chip indicator centrally in the stylesheet', () => {
    const css = adminUiCss()
    expect(css).toContain('.route-chip.operational')
    expect(css).toContain('animation:route-pulse')
    expect(css).toContain('@keyframes route-pulse')
  })

  it('REQ-ADM-024 places the route chip with the Gateway selector', () => {
    // The operational chip must sit with the gateway it describes: after the gateway select
    // and before the Connect button, not stranded below it.
    const html = adminUiHtml('https://router.test', { view: 'dashboard', phase: 'complete', customDomain: 'router.test', recovery: false })
    const selectAt = html.indexOf('id="rt-gateway-select"')
    const chipAt = html.indexOf('id="rt-route-chip"')
    const connectAt = html.lastIndexOf('data-action="gateway-sync"')
    expect(selectAt).toBeGreaterThan(-1)
    expect(chipAt).toBeGreaterThan(selectAt)
    expect(connectAt).toBeGreaterThan(chipAt)
  })

  it('REQ-ADM-024 reads the connected gateway as a state card', async () => {
    // The connected gateway renders as a prominent state card carrying the gateway id as its value.
    const harness = await dashboardHarness()
    const card = harness.byId('gateway-current')
    const value = descendants(card).find((node) => node.className === 'state-value')
    expect(value!.textContent).toBe('inference-mesh')
    expect(card.classList.contains('is-empty')).toBe(false)
  })

  it('REQ-GWY-005 the gateway step renders a provider-name field and no route select', async () => {
    const harness = await dashboardHarness()
    expect(harness.html).toContain('id="rt-gateway-provider-name"')
    expect(harness.html).not.toContain('id="rt-route-select"')
  })

  it('REQ-ADM-025 renders an add-model form with a mode selector defaulting to single machine', async () => {
    const harness = await dashboardHarness()
    const html = harness.html
    expect(html).toContain('id="model-add-mode"')
    expect(html).toContain('id="model-add-ref"')
    // Single machine is the first (default-selected) option in the mode selector.
    const singleIndex = html.indexOf('value="single"')
    const splitIndex = html.indexOf('value="split"')
    expect(singleIndex).toBeGreaterThan(-1)
    expect(splitIndex).toBeGreaterThan(singleIndex)
  })

  it('REQ-ADM-025 links to the Unsloth GGUF catalog, the meshllm layer-package org, and the split-your-own guide', async () => {
    const harness = await dashboardHarness()
    const html = harness.html
    expect(html).toContain('href="https://huggingface.co/unsloth?search_models=GGUF"')
    expect(html).toContain('href="https://huggingface.co/meshllm"')
    expect(html).toContain('href="https://github.com/Mesh-LLM/hf-mesh-skippy-splitter"')
  })

  it('REQ-ADM-025 posts the model ref and mode and refreshes the model list', async () => {
    const harness = await dashboardHarness()
    harness.byId('model-add-ref').value = 'unsloth/Qwen3-14B-GGUF:Q4_K_M'
    harness.byId('model-add-mode').value = 'split'
    const statusBefore = statusFetches(harness)
    await harness.clickAction('model-add')
    await harness.flush(10)
    const addCall = harness.fetchCalls.find((call) => call.path === '/admin/profiles/add')
    expect(addCall).toBeDefined()
    expect(addCall?.init?.method).toBe('POST')
    expect(JSON.parse(String(addCall?.init?.body))).toEqual({ modelRef: 'unsloth/Qwen3-14B-GGUF:Q4_K_M', mode: 'split' })
    // A successful add refreshes status so the new model appears in the list.
    expect(statusFetches(harness)).toBeGreaterThan(statusBefore)
  })

  it('REQ-ADM-025 does not submit an empty model ref', async () => {
    const harness = await dashboardHarness()
    harness.byId('model-add-ref').value = '   '
    await harness.clickAction('model-add')
    await harness.flush(10)
    expect(harness.fetchCalls.some((call) => call.path === '/admin/profiles/add')).toBe(false)
  })
})
