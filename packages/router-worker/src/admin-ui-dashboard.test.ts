import { describe, expect, it } from 'vitest'
import { ADMIN_UI_DRAWER, ADMIN_UI_MESH_HEALTH, ADMIN_UI_NODES_TABLE, ADMIN_UI_PLAYGROUND, ADMIN_UI_POLLING, ADMIN_UI_TOKS_TRACE, ADMIN_UI_TOPOLOGY, adminUiHtml } from './admin-ui'
import { adminUiHarness, descendants, type AdminUiHarness, type StubElement } from './admin-ui-harness'

// DashboardUiTestAnchor

const dashboardNodes = [
  {
    id: 'node-big',
    status: 'online',
    agentVersion: 'v1.3.0',
    metrics: { runtimeState: 'running', readyModels: ['codeflare-mesh', 'qwen3.6:35b-a3b'], gpuMemoryTotalMiB: 24_576, gpuMemoryUsedMiB: 20_000, tokensPerSecond: 42.5, activeRequests: 1 }
  },
  {
    id: 'node-small',
    status: 'online',
    agentVersion: 'v1.2.0',
    metrics: { runtimeState: 'ready', readyModels: ['codeflare-mesh'], gpuMemoryTotalMiB: 8_192, gpuMemoryUsedMiB: 4_000, tokensPerSecond: 61.25, activeRequests: 0 }
  },
  {
    id: 'node-down',
    status: 'offline',
    metrics: { runtimeState: 'failed', activeRequests: 0 }
  }
]

const dashboardProfiles = [
  { id: 'mesh-default-qwen36-35b', displayName: 'Qwen3.6 35B', publicAliases: ['codeflare-mesh', 'qwen3.6:35b-a3b'], active: true, rolloutPercent: 100, meshllm: { split: false } },
  { id: 'mesh-split-qwen36-35b', displayName: 'Qwen3.6 35B (multi-machine)', publicAliases: ['mesh-split'], active: false, rolloutPercent: 100, meshllm: { split: true } }
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
    expect(stat('models')).toBe('1')
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
    expect(models.map((node) => node.dataset.drawerModel)).toEqual(['codeflare-mesh'])
    const revoke = fields.find((node) => node.dataset.action === 'node-revoke')
    expect(revoke).toBeDefined()
    expect(revoke!.dataset.nodeId).toBe('node-small')
    expect(revoke!.dataset.confirm, 'revoke must arm before submitting').toBeTruthy()

    await harness.clickAction(ADMIN_UI_DRAWER.closeAction)
    expect(drawer.hidden).toBe(true)
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
    expect(fields.find((node) => node.dataset.drawerField === 'aliases')!.dataset.value).toBe('codeflare-mesh, qwen3.6:35b-a3b')
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

  it('REQ-ADM-016 lists one playground option per model on, labeled by name and valued by callable name', async () => {
    const harness = await dashboardHarness()
    const select = harness.byId(ADMIN_UI_PLAYGROUND.selectId)
    // One option per model that is on; the option value is the callable name the
    // gateway resolves, while the visible label is the canonical model name.
    expect(select.children.map((option) => option.value)).toEqual(['codeflare-mesh'])
    expect(select.children.map((option) => option.dataset.playgroundModelOption)).toEqual(['codeflare-mesh'])
    expect(select.children.map((option) => option.textContent)).toEqual(['Qwen3.6 35B'])
  })

  it('REQ-ADM-016 streams the playground response incrementally as chunks arrive', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c } })
    const harness = await dashboardHarness({
      respond: (path) => path === '/admin/playground/chat' ? new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }) : undefined
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
    const call = harness.fetchCalls.find((entry) => entry.path === '/admin/playground/chat')
    expect(call?.init?.method).toBe('POST')
    expect(JSON.parse(String(call?.init?.body))).toEqual({ model: 'codeflare-mesh', messages: [{ role: 'user', content: 'hello mesh' }] })
  })

  it('REQ-ADM-016 appends a status-specific actionable hint when a playground request fails', async () => {
    const bareLen = (status: number) => ('Playground request failed (' + status + ').').length
    const outputFor = async (status: number): Promise<string> => {
      const harness = await dashboardHarness({ respond: (path) => path === '/admin/playground/chat' ? new Response('{"error":"x"}', { status }) : undefined })
      harness.byId(ADMIN_UI_PLAYGROUND.promptId).value = 'hi'
      const send = harness.clickAction(ADMIN_UI_PLAYGROUND.sendAction, { out: ADMIN_UI_PLAYGROUND.outputId })
      await harness.flush(10)
      await send
      return harness.byId(ADMIN_UI_PLAYGROUND.outputId).textContent
    }
    const out400 = await outputFor(400)
    const out401 = await outputFor(401)
    const out409 = await outputFor(409)
    // Behavioral contract (survives without pinning copy): each failure carries the status code plus a
    // hint beyond the bare line, and distinct statuses map to distinct hints. Gut playgroundHint -> all
    // collapse to the bare line and the length + inequality assertions fail.
    expect(out401).toContain('(401)')
    expect(out400.length).toBeGreaterThan(bareLen(400))
    expect(out401.length).toBeGreaterThan(bareLen(401))
    expect(out409.length).toBeGreaterThan(bareLen(409))
    expect(out400).not.toBe(out401)
    expect(out401).not.toBe(out409)
  })

  it('REQ-ADM-005 surfaces the currently provisioned custom domain in Routing', async () => {
    const harness = await dashboardHarness()
    const text = harness.byId('custom-domain-current').textContent
    // Contract values, not copy: the live readout renders the provisioned host then its status.
    // Gutting the readout falls back to a no-domain note that matches neither the host nor this ordering.
    expect(text).toContain('router.test')
    expect(text).toMatch(/router\.test.*provisioned/)
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
    // The toggle reflects state: the model that is on offers "Turn off", the one that is off offers "Turn on".
    const toggle = (id: string) => descendants(rows.find((row) => row.dataset.profileRow === id)!).find((node) => node.dataset.action === 'model-toggle')!
    expect(toggle('mesh-default-qwen36-35b').dataset.on).toBe('true')
    expect(toggle('mesh-default-qwen36-35b').textContent).toBe('Turn off')
    expect(toggle('mesh-split-qwen36-35b').dataset.on).toBe('false')
    expect(toggle('mesh-split-qwen36-35b').textContent).toBe('Turn on')
  })

  it('REQ-ADM-018 labels the shared-model select by model name, never the internal id', async () => {
    const harness = await dashboardHarness()
    const select = harness.byId(ADMIN_UI_MESH_HEALTH.rotateSelectId)
    // The reset-sharing-key dropdown shows the human model name; the wiring id never leaks to the label.
    const option = select.children.find((opt) => opt.textContent === 'Qwen3.6 35B')
    expect(option, 'shared-model option should be labeled by display name').toBeDefined()
    expect(select.children.some((opt) => (opt.textContent || '').includes('mesh-default-qwen36-35b'))).toBe(false)
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
    for (const section of ['nodes', 'models', 'routing', 'mesh', 'settings']) {
      expect(harness.byId(section).hidden).toBe(true)
    }
  })

  it('REQ-ADM-017 leaves every section visible for the admin role', async () => {
    const harness = await dashboardHarness({ status: statusFixture({ viewerRole: 'admin' }) })
    for (const section of ['overview', 'nodes', 'models', 'routing', 'mesh', 'playground', 'settings']) {
      expect(harness.byId(section).hidden).toBe(false)
    }
  })
})
