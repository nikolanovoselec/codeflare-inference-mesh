import { afterEach, describe, expect, it, vi } from 'vitest'
import { ADMIN_UI_DRAWER, ADMIN_UI_MESHES, ADMIN_UI_NODES_TABLE, ADMIN_UI_PLAYGROUND, ADMIN_UI_POLLING, ADMIN_UI_RUNTIME_VERSION, ADMIN_UI_TOKS_TRACE, ADMIN_UI_TOPOLOGY, adminUiHtml } from './admin-ui'
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
    lastSpeedTest: { at: 1_700_000_100_000, requestId: 'speed-a', model: 'codeflare-mesh', nodeId: 'node-big', requestedPromptTokens: 2048, requestedMaxTokens: 160, promptTokens: 2048, completionTokens: 80, promptTokensEstimated: false, completionTokensEstimated: false, promptTokensPerSecond: 1800.5, generationTokensPerSecond: 67.2, timeToFirstTokenMs: 900, generationMs: 1200, totalMs: 2100, cacheTokens: 0 },
    gateway: { gatewayId: 'inference-mesh', routeName: 'codeflare-mesh', publicModel: 'codeflare-mesh' },
    customDomain: { hostname: 'router.test', status: 'provisioned' },
    desiredAgentVersion: 'v1.3.0',
    desiredRuntimeVersions: { meshllm: 'v0.72.2', llamacpp: 'b9912' },
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
    if (path === '/admin/runtime-versions') return Response.json({ meshllm: { tags: [], desired: 'v0.72.2', stale: false }, llamacpp: { tags: [], desired: 'b9912', stale: false } })
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
  afterEach(() => {
    try { vi.clearAllTimers() } catch (_error) { /* fake timers were not enabled */ }
    vi.useRealTimers()
    vi.restoreAllMocks()
    delete (globalThis as { matchMedia?: unknown }).matchMedia
  })

  it('REQ-ADM-036 uses the official Codeflare shell tokens', () => {
    const css = adminUiCss()

    expect(css).toContain("--font-sans:'Inter'")
    expect(css).toContain('--accent:#ff5c3c')
    expect(css).toContain('--accent-hover:#ff734f')
    expect(css).toContain('--accent-ink:#160a06')
    expect(css).toContain('--flare-gradient:linear-gradient(96deg,#ff8a3d 0%,#ff5c3c 52%,#ff3f7c 100%)')
    expect(css).toContain('body{')
    expect(css).toContain('font:var(--fs-md)/1.55 var(--font-sans)')
    expect(css).toContain('code,pre,.metric-value,.endpoint-chip{font-family:var(--font-mono)')
    expect(css).toContain('.hero-accent{display:inline-block;background:var(--flare-gradient)')
    expect(css).toContain('.scramble-word{display:inline-block;white-space:nowrap;text-align:left;vertical-align:baseline;overflow:visible;color:inherit}')
    expect(css).not.toContain('.scramble-word+.scramble-word')
  })

  it('REQ-ADM-007 renders a Codeflare operator-console hero and nav rail contracts', () => {
    const html = adminUiHtml('https://router.test', { view: 'dashboard', phase: 'complete', customDomain: 'router.test', recovery: false })
    const heroAt = html.indexOf('id="dashboard-hero"')
    const navAt = html.indexOf('class="side-nav"')

    expect(heroAt).toBeGreaterThan(-1)
    expect(navAt).toBeGreaterThan(heroAt)
    expect(html).toContain('data-dashboard-hero="true"')
    expect(html).toContain('<span data-scramble>Codeflare</span> <span class="hero-accent">Inference Mesh</span>')
    expect(html).toContain('id="overview-tiles"')
    expect(html).toContain('data-nav-item="overview"')
    expect(html).toContain('data-nav-hint="Live mesh health"')
    expect(html).toContain('data-nav-hint="Runtime roles"')
    expect(html).toContain('data-nav-hint="Meshes and models"')
  })

  it('REQ-ADM-034 renders endpoint chips inside command rows for action-heavy controls', () => {
    const html = adminUiHtml('https://router.test', { view: 'dashboard', phase: 'complete', customDomain: 'router.test', recovery: false })
    const rowAt = html.indexOf('data-command-row="playground-speed"')
    const endpointAt = html.indexOf('data-endpoint-chip="POST /admin/playground/speed-test"')
    const authAt = html.indexOf('data-scope-chip="admin"', rowAt)

    expect(rowAt).toBeGreaterThan(-1)
    expect(endpointAt).toBeGreaterThan(rowAt)
    expect(authAt).toBeGreaterThan(rowAt)
  })

  it('REQ-ADM-036 leaves the scramble phrase static under reduced motion', () => {
    ;(globalThis as { matchMedia?: unknown }).matchMedia = () => ({ matches: true })
    const html = adminUiHtml('https://router.test', { view: 'dashboard', phase: 'complete', customDomain: 'router.test', recovery: false })
    const harness = adminUiHarness(html, () => Response.json(statusFixture()), { sessionToken: 'admin-secret' })
    const target = harness.query('[data-scramble]')
    target.textContent = 'Codeflare'

    harness.run()

    expect(target.textContent).toBe('Codeflare')
    expect(target.children.filter((child) => child.className === 'scramble-word')).toHaveLength(0)
  })

  it('REQ-ADM-036 scrambles the hero phrase and converges back to the target', () => {
    vi.useFakeTimers()
    ;(globalThis as { matchMedia?: unknown }).matchMedia = () => ({ matches: false })
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const html = adminUiHtml('https://router.test', { view: 'dashboard', phase: 'complete', customDomain: 'router.test', recovery: false })
    const harness = adminUiHarness(html, () => Response.json(statusFixture()), { sessionToken: 'admin-secret' })
    const target = harness.query('[data-scramble]')
    target.textContent = 'Codeflare'

    harness.run()
    const words = target.children.filter((child) => child.className === 'scramble-word')
    expect(words.map((word) => word.textContent)).toEqual(['Codeflare'])
    expect(target.children.some((child) => child.nodeType === 3 && child.textContent === ' ')).toBe(false)

    vi.advanceTimersByTime(3_400)
    expect(words.some((word) => word.textContent !== 'Codeflare')).toBe(true)
    vi.advanceTimersByTime(3_600)
    expect(words.map((word) => word.textContent)).toEqual(['Codeflare'])
  })

  it('REQ-OBS-010 computes the stats strip aggregates from admin status', async () => {
    const harness = await dashboardHarness()
    const tiles = harness.byId('overview-tiles').children
    const stat = (key: string) => {
      const tile = tiles.find((candidate) => candidate.dataset.stat === key)
      expect(tile, `no stat tile ${key}`).toBeDefined()
      return descendants(tile!).find((node) => node.dataset.value !== undefined)!.dataset.value
    }
    expect(stat('nodes')).toBe('2/3')
    expect(stat('vram')).toBe('32 GiB')
    expect(stat('speed')).toBeTruthy()
    const speedTile = tiles.find((candidate) => candidate.dataset.stat === 'speed')!
    expect(speedTile.dataset.promptTps).toBe('1800.5')
    expect(speedTile.dataset.generationTps).toBe('67.2')
    expect(speedTile.dataset.nodeId).toBe('node-big')
  })

  it('REQ-OBS-010 does not fabricate a last Speed Test before one is reported', async () => {
    const harness = await dashboardHarness({ status: statusFixture({ lastSpeedTest: undefined }) })
    const speedTile = descendants(harness.byId('overview-tiles')).find((node) => node.dataset.stat === 'speed')!

    expect(speedTile.dataset.promptTps).toBeUndefined()
    expect(speedTile.dataset.generationTps).toBeUndefined()
  })

  it('REQ-ADM-007 toggles mobile navigation from the top-bar menu and closes it after section changes', async () => {
    const harness = await dashboardHarness()
    const menu = harness.byId('mobile-menu')
    const toggle = harness.byId('mobile-menu-toggle')
    expect(menu.hidden).toBe(true)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    await harness.clickAction('mobile-menu-toggle')
    expect(menu.hidden).toBe(false)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')

    await harness.click(harness.query('[data-nav="nodes"]'))
    expect(harness.byId('nodes').dataset.active).toBe('true')
    expect(harness.byId('overview').dataset.active).toBe('false')
    expect(menu.hidden).toBe(true)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
  })

  it('REQ-OBS-010 counts split participants as available capacity', async () => {
    const nodes = [
      { id: 'battlestation', status: 'online', metrics: { runtimeState: 'starting', nodeState: 'standby', meshRole: 'api-client', apiReady: true, consoleReady: true, readyModels: ['unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ3_S'], runtimeDetail: 'old Metal assert', activeRequests: 0 } },
      { id: 'linux-peer', status: 'online', metrics: { runtimeState: 'ready', nodeState: 'serving', meshRole: 'serving-peer', apiReady: true, consoleReady: true, readyModels: ['unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ3_S'], stageCount: 1, activeRequests: 0 } }
    ]
    const harness = await dashboardHarness({ status: statusFixture({ nodes }) })
    const nodeTile = descendants(harness.byId('overview-tiles')).find((node) => node.dataset.stat === 'nodes')!
    const value = descendants(nodeTile).find((node) => node.dataset.value !== undefined)!
    expect(value.dataset.value).toBe('2/2')
    expect(harness.byId(ADMIN_UI_TOPOLOGY.captionId).dataset.serving).toBe('2')
    const battlestation = tableRows(harness).find((row) => row.dataset.nodeRow === 'battlestation')!
    const statusCell = descendants(battlestation).find((node) => node.dataset.cell === 'status')!
    expect(statusCell.dataset.meshRole).toBe('No stage assigned')
    expect(statusCell.dataset.statusDetail).toBe('standby')
    const chip = descendants(statusCell).find((node) => node.className === 'chip')!
    expect(chip.dataset.tone).toBe('ok')
    // Ready models make the node a Serving participant in the fixed status vocabulary.
    expect(descendants(chip).map((node) => node.textContent).join('')).toBe('Serving')
    await harness.clickAction('node-detail', { nodeId: 'battlestation' })
    const drawerFields = descendants(harness.byId(ADMIN_UI_DRAWER.bodyId))
    expect(drawerFields.some((node) => node.dataset.drawerField === 'runtime-detail')).toBe(false)
    const drawerText = (name: string) => descendants(drawerFields.find((node) => node.dataset.drawerField === name)!).map((node) => node.textContent).join(' ')
    expect(drawerText('work-state')).toContain('Serving model')
  })

  it('REQ-OBS-007 surfaces split capacity shortfall instead of marking raw standby green', async () => {
    const profile = { id: 'custom-ernie-split', displayName: 'ERNIE split', publicAliases: ['codeflare-mesh'], upstreamModel: 'meshllm/ERNIE-layers', active: true, rolloutPercent: 100, runtime: 'meshllm', meshllm: { split: true, modelRef: 'meshllm/ERNIE-layers', bindPort: 4420, maxVramGb: 16 } }
    const splitReadiness = {
      modelRef: 'meshllm/ERNIE-layers', verdict: 'insufficient_capacity', participantCount: 2,
      capacityAdvice: { state: 'insufficient_capacity', reason: 'participant_split_capacity_insufficient', requiredBytes: 18_000_000_000, aggregateCapacityBytes: 16_000_000_000, shortfallBytes: 2_000_000_000, eligibleNodeCount: 2, splitCapable: true },
      participants: [{ shortNodeId: 'Mac', vramBytes: 4_000_000_000 }, { shortNodeId: 'battle', vramBytes: 12_000_000_000 }],
      blockers: [{ reason: 'split_capacity_shortfall', recommendation: 'Increase available VRAM.' }]
    }
    const nodes = [{ id: 'battlestation', status: 'online', maxVramGbOverride: 16, activeProfileIds: ['custom-ernie-split'], metrics: { runtimeKind: 'meshllm', runtimeState: 'starting', nodeState: 'standby', meshRole: 'api-client', apiReady: true, consoleReady: true, peerCount: 1, splitEnabled: true, stageCount: 0, meshllmVersion: '0.72.2', meshMaxVramGb: 12, splitReadiness } }]
    const harness = await dashboardHarness({ status: statusFixture({ profiles: [profile], nodes }) })
    const row = tableRows(harness).find((candidate) => candidate.dataset.nodeRow === 'battlestation')!
    const statusCell = descendants(row).find((candidate) => candidate.dataset.cell === 'status')!
    const chip = descendants(statusCell).find((node) => node.className === 'chip')!
    expect(chip.dataset.tone).toBe('warn')
    expect(statusCell.dataset.statusDetail).toBe('split_capacity_shortfall')
    expect(statusCell.dataset.splitReason).toBe('split_capacity_shortfall')
    expect(statusCell.dataset.requiredBytes).toBe('18000000000')
    expect(statusCell.dataset.aggregateBytes).toBe('16000000000')
    expect(statusCell.dataset.shortfallBytes).toBe('2000000000')

    await harness.clickAction('node-detail', { nodeId: 'battlestation' })
    const fields = descendants(harness.byId(ADMIN_UI_DRAWER.bodyId))
    const field = (name: string) => fields.find((node) => node.dataset.drawerField === name)!
    expect(field('split-readiness').dataset.splitReason).toBe('split_capacity_shortfall')
    expect(field('split-readiness').dataset.shortfallBytes).toBe('2000000000')
    expect(descendants(field('split-readiness')).some((node) => node.dataset.splitField === 'participants')).toBe(true)
    expect(field('mesh-vram-budget').dataset.profileBudget).toBe('16')
    expect(field('mesh-vram-budget').dataset.nodeOverride).toBe('16')
    expect(field('mesh-vram-budget').dataset.runningBudget).toBe('12')
    expect(field('mesh-vram-budget').dataset.budgetStale).toBe('true')
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
    const labels = descendants(harness.byId('overview-tiles')).filter((node) => node.tagName === 'strong').map((node) => node.textContent)
    expect(labels).toContain('Available machines')
    expect(labels).toContain('Known VRAM')
    expect(harness.byId(ADMIN_UI_TOPOLOGY.captionId).textContent).toContain('available')
  })

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
    expect(cells.find((cell) => cell.dataset.cell === 'models')!.dataset.value).toBe('2')
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
    expect(descendants(field('vram')!).map((node) => node.textContent).join(' ')).toContain('3.9 GiB / 8 GiB')
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
    const textOf = (item: StubElement) => descendants(item).map((node) => node.textContent).join(' ')
    const runtimeInstall = fields.find((node) => node.dataset.drawerField === 'runtime-install')!
    expect(textOf(runtimeInstall)).toContain('meshllm 0.72.2')
    expect(textOf(runtimeInstall)).not.toContain('deactivated')
    expect(textOf(runtimeInstall)).not.toContain('install failed')
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
    expect(statusCell.dataset.meshRole).toBe('Stage owner')
    // A stage owner reads as Serving (active work), never standby/API client; the role
    // detail rides the data attribute and the drawer, not the visible label.
    const statusChip = descendants(statusCell).find((node) => node.className === 'chip')!
    expect(descendants(statusChip).map((node) => node.textContent).join(' ')).toContain('Serving')

    await harness.clickAction('node-detail', { nodeId: 'mac-100-96-0-14' })
    let fields = descendants(harness.byId(ADMIN_UI_DRAWER.bodyId))
    const textOf = (name: string) => descendants(fields.find((node) => node.dataset.drawerField === name)!).map((node) => node.textContent).join(' ')
    expect(textOf('work-state')).toContain('Serving split stage')
    expect(textOf('mesh-role')).toContain('Stage owner')
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
    expect(descendants(battleVram).map((node) => node.textContent).join(' ')).toContain('18.4 GiB / 24 GiB')
    const battleSplitReadiness = fields.find((node) => node.dataset.drawerField === 'split-readiness')!
    const battleCapacity = descendants(battleSplitReadiness).find((node) => node.dataset.participantLabel === 'battlestation')!
    expect(battleCapacity.dataset.participantCapacityGb).toBe('63.2')
    expect(descendants(battleSplitReadiness).map((node) => node.textContent).join(' ')).not.toContain('63.2 GB')
    const battleStage = fields.find((node) => node.dataset.drawerField === 'stage-ownership')!
    expect(battleStage.dataset.value).toBe('mesh-host:0:26:ready')

    await harness.clickAction('model-detail', { profileId: 'mesh-default-qwen36-35b' })
    fields = descendants(harness.byId(ADMIN_UI_DRAWER.bodyId))
    const modelStage = fields.find((node) => node.dataset.drawerField === 'stage-ownership')!
    expect(descendants(modelStage).map((node) => node.textContent).join(' ')).toContain('L0-26 → battlestation · Ready; L27-28 → Mac · Ready')
  })

  it('REQ-OBS-011 hides model_size_unknown during reload and update transitions', async () => {
    const splitReadiness = { verdict: 'model_size_unknown', blockers: [{ reason: 'model_size_unknown' }] }
    const nodes = [{ id: 'linux-node', displayName: 'Arch Linux', status: 'online', activeProfileIds: ['mesh-default-qwen36-35b'], metrics: { runtimeKind: 'meshllm', runtimeState: 'starting', nodeState: 'loading model meshllm/ERNIE', meshRole: 'api-client', apiReady: true, consoleReady: true, peerCount: 1, stageCount: 0, splitEnabled: true, activeRequests: 0, splitReadiness } }]
    const meshHealth = [{ profileId: 'mesh-default-qwen36-35b', rotation: 0, peerNodeIds: ['linux-node'], readyModels: [], failedNodeIds: [], tokenCount: 1, splitReadiness }]
    const harness = await dashboardHarness({ status: statusFixture({ nodes, meshHealth }) })
    const row = tableRows(harness).find((candidate) => candidate.dataset.nodeRow === 'linux-node')!
    const statusCell = descendants(row).find((candidate) => candidate.dataset.cell === 'status')!
    expect(descendants(statusCell).map((node) => node.textContent).join(' ')).not.toContain('Model Size Unknown')

    await harness.clickAction('node-detail', { nodeId: 'linux-node' })
    let fields = descendants(harness.byId(ADMIN_UI_DRAWER.bodyId))
    expect(fields.some((node) => node.dataset.drawerField === 'split-readiness')).toBe(false)
    expect(descendants(harness.byId(ADMIN_UI_DRAWER.bodyId)).map((node) => node.textContent).join(' ')).not.toContain('Model Size Unknown')

    await harness.clickAction('model-detail', { profileId: 'mesh-default-qwen36-35b' })
    fields = descendants(harness.byId(ADMIN_UI_DRAWER.bodyId))
    expect(fields.some((node) => node.className === 'split-readiness-block')).toBe(false)
    expect(descendants(harness.byId(ADMIN_UI_DRAWER.bodyId)).map((node) => node.textContent).join(' ')).not.toContain('Model Size Unknown')
  })

  it('REQ-OBS-011 keeps stale model_size_unknown from overriding serving split status', async () => {
    const splitReadiness = { verdict: 'model_size_unknown', blockers: [{ reason: 'model_size_unknown' }], participants: [{ routerNodeId: 'linux-node', displayName: 'Arch Linux', vramBytes: 63_200_000_000 }] }
    const nodes = [{ id: 'linux-node', displayName: 'Arch Linux', status: 'online', activeProfileIds: ['mesh-default-qwen36-35b'], metrics: { runtimeKind: 'meshllm', runtimeState: 'ready', nodeState: 'serving', meshRole: 'coordinator', apiReady: true, consoleReady: true, peerCount: 1, stageCount: 1, meshNodeId: 'mesh-linux', readyModels: ['codeflare-mesh'], splitReadiness, stageAssignments: [{ stageIndex: 0, nodeId: 'mesh-linux', layerStart: 0, layerEnd: 26, state: 'ready' }] } }]
    const meshHealth = [{ profileId: 'mesh-default-qwen36-35b', rotation: 0, coordinatorNodeId: 'linux-node', peerNodeIds: ['linux-node'], readyModels: ['codeflare-mesh'], failedNodeIds: [], tokenCount: 1, splitReadiness, stageAssignments: [{ stageIndex: 0, nodeId: 'mesh-linux', layerStart: 0, layerEnd: 26, state: 'ready' }] }]
    const harness = await dashboardHarness({ status: statusFixture({ nodes, meshHealth }) })
    const row = tableRows(harness).find((candidate) => candidate.dataset.nodeRow === 'linux-node')!
    const statusCell = descendants(row).find((candidate) => candidate.dataset.cell === 'status')!
    expect(descendants(statusCell).map((node) => node.textContent).join(' ')).not.toContain('Model Size Unknown')
    const servingChip = descendants(statusCell).find((node) => node.className === 'chip')!
    expect(servingChip.dataset.tone).toBe('ok')
    expect(descendants(servingChip).map((node) => node.textContent).join('')).toBe('Serving')

    await harness.clickAction('node-detail', { nodeId: 'linux-node' })
    let fields = descendants(harness.byId(ADMIN_UI_DRAWER.bodyId))
    expect(fields.some((node) => node.dataset.drawerField === 'split-readiness')).toBe(false)
    expect(fields.find((node) => node.dataset.drawerField === 'stage-ownership')!.dataset.value).toBe('mesh-linux:0:26:ready')

    await harness.clickAction('model-detail', { profileId: 'mesh-default-qwen36-35b' })
    fields = descendants(harness.byId(ADMIN_UI_DRAWER.bodyId))
    expect(descendants(harness.byId(ADMIN_UI_DRAWER.bodyId)).map((node) => node.textContent).join(' ')).not.toContain('Model Size Unknown')
    expect(fields.find((node) => node.dataset.drawerField === 'stage-ownership')!.dataset.value).toBe('L0-26 → Arch Linux · Ready')
  })

  it('REQ-ADM-019 REQ-ADM-030 renders concise completion messages for routine mutating actions', async () => {
    const harness = await dashboardHarness()
    // Clicking Deactivate on an active node must POST to the deactivate endpoint (not silently no-op).
    await harness.clickAction('node-deactivate', { nodeId: 'node-small', out: 'node-output' })
    const deactivate = harness.fetchCalls.find((entry) => entry.path === '/admin/nodes/node-small/deactivate')
    expect(deactivate?.init?.method).toBe('POST')
    expect(harness.byId('node-output').textContent.length).toBeGreaterThan(0)
    expect(harness.byId('node-output').textContent).not.toMatch(/^\s*\{/)

    // Clicking Activate on a deactivated node must POST to the activate endpoint.
    await harness.clickAction('node-activate', { nodeId: 'node-small', out: 'node-output' })
    const activate = harness.fetchCalls.find((entry) => entry.path === '/admin/nodes/node-small/activate')
    expect(activate?.init?.method).toBe('POST')
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
    expect(textOf(field('work-state')!)).toContain('Starting model')
    expect(textOf(field('mesh-role')!)).toContain('Stage owner')
    expect(field('peers')!.dataset.value).toBe('2')
    expect(field('stages')!.dataset.value).toBe('2')
    expect(field('reachability')!.dataset.value).toBe('api:down;console:ready')
    expect(textOf(field('reachability')!)).toContain('down / ready')
    expect(textOf(field('runtime-install')!)).toContain('meshllm 0.72.2')
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

  it('REQ-OBS-011 direct node drawer does not turn unreported heartbeat fields into failures', async () => {
    const nodes = [
      { id: 'direct-node', status: 'online', runtime: 'llamacpp', metrics: {
        runtimeKind: 'llamacpp', runtimeState: 'ready', apiReady: true, consoleReady: null,
        parallel: 4, ctxSize: 262144, cacheReuse: 256, gpuMemoryUsedMiB: 3907, gpuMemoryTotalMiB: 24576,
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
    expect(textOf(field('vram')!)).toContain('3.8 GiB / 24 GiB')
    expect(textOf(field('direct-parallel')!)).toContain('parallel 4')
    expect(textOf(field('direct-cached-tokens')!)).toContain('not reported')
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

  it('REQ-RUN-013 loads and saves direct llama.cpp runtime tunables from the model drawer', async () => {
    const profiles = [
      { id: 'custom-direct', displayName: 'Direct Qwen', publicAliases: ['codeflare-mesh', 'direct-qwen'], active: true, rolloutPercent: 100, contextWindow: 262144, runtime: 'llamacpp', llamacpp: { modelRef: 'unsloth/Qwen3-14B-GGUF:Q4_K_M', hfRepo: 'unsloth/Qwen3-14B-GGUF', quant: 'Q4_K_M', bindPort: 4330, contextWindow: 262144, parallel: 4, kvUnified: false, cachePrompt: true, cacheReuse: 256, gpuLayers: '99', cacheTypeK: 'q4_0', cacheTypeV: 'q4_0', batch: 8192, ubatch: 2048, flashAttn: true, maxOutputTokens: 16384, alias: 'unsloth/Qwen3-14B-GGUF:Q4_K_M', reasoning: { enabled: true, format: 'deepseek', budget: 8192 } } }
    ]
    const harness = await dashboardHarness({ status: statusFixture({ profiles }) })
    await harness.clickAction('model-detail', { profileId: 'custom-direct' })

    expect(harness.byId('model-edit-llama-parallel').value).toBe('4')
    expect(harness.byId('model-edit-llama-kv-unified').value).toBe('off')
    expect(harness.byId('model-edit-llama-gpu-layers').value).toBe('99')
    expect(harness.byId('model-edit-llama-cache-k').value).toBe('q4_0')
    expect(harness.byId('model-edit-llama-batch').value).toBe('8192')
    expect(harness.byId('model-edit-llama-ubatch').value).toBe('2048')
    expect(harness.byId('model-edit-llama-maxout').value).toBe('16384')
    expect(harness.byId('model-edit-llama-reasoning').value).toBe('on')
    expect(harness.byId('model-edit-llama-reasoning-budget').value).toBe('8192')

    harness.byId('model-edit-llama-parallel').value = ''
    harness.byId('model-edit-llama-kv-unified').value = 'on'
    harness.byId('model-edit-llama-gpu-layers').value = '99'
    harness.byId('model-edit-llama-cache-k').value = 'q4_0'
    harness.byId('model-edit-llama-cache-v').value = 'q4_0'
    harness.byId('model-edit-llama-batch').value = '8192'
    harness.byId('model-edit-llama-ubatch').value = '2048'
    harness.byId('model-edit-llama-flash').value = 'on'
    harness.byId('model-edit-llama-maxout').value = '16384'
    harness.byId('model-edit-llama-reasoning').value = 'on'
    harness.byId('model-edit-llama-reasoning-format').value = 'deepseek'
    harness.byId('model-edit-llama-reasoning-budget').value = '8192'
    await harness.clickAction('model-save', { profileId: 'custom-direct', runtime: 'llamacpp', out: 'model-output' })
    const call = harness.fetchCalls.find((entry) => entry.path === '/admin/profiles/config')
    const body = JSON.parse(String(call?.init?.body))
    expect(body.llamacpp).toMatchObject({ parallel: -1, kvUnified: true, gpuLayers: '99', cacheTypeK: 'q4_0', cacheTypeV: 'q4_0', batch: 8192, ubatch: 2048, flashAttn: true, maxOutputTokens: 16384, reasoning: { enabled: true, format: 'deepseek', budget: 8192 } })
  })

  it('REQ-ADM-026 shows a Delete control for any switched-off model', async () => {
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

    // Seed-once: a switched-off default-named model no longer re-seeds, so it is deletable too.
    await harness.clickAction('model-detail', { profileId: 'mesh-default-qwen36-35b' })
    const builtinDel = deleteButton()
    expect(builtinDel, 'a switched-off default-named model exposes Delete').toBeDefined()
    expect(builtinDel!.dataset.profileId).toBe('mesh-default-qwen36-35b')
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

  it('REQ-ADM-033 renders and saves MeshLLM and llama.cpp runtime version controls from Settings', async () => {
    const harness = await dashboardHarness({ respond: (path, init) => {
      const method = (init && init.method) || 'GET'
      if (path === '/admin/runtime-versions' && method === 'GET') return Response.json({
        meshllm: { tags: ['v0.73.0', 'v0.72.2'], desired: 'v0.73.0', stale: false },
        llamacpp: { tags: ['b9912', 'b9900'], desired: 'b9900', stale: false }
      })
      if (path === '/admin/runtime-versions' && method === 'POST') return Response.json({ ok: true, desired: { meshllm: 'v0.72.2', llamacpp: 'b9912' } })
      return undefined
    } })

    expect(harness.byId(ADMIN_UI_RUNTIME_VERSION.meshllmSelectId).value).toBe('v0.73.0')
    expect(harness.byId(ADMIN_UI_RUNTIME_VERSION.llamacppSelectId).value).toBe('b9900')
    harness.byId(ADMIN_UI_RUNTIME_VERSION.meshllmSelectId).value = 'v0.72.2'
    harness.byId(ADMIN_UI_RUNTIME_VERSION.llamacppSelectId).value = 'b9912'
    await harness.clickAction('runtime-versions-set', { out: 'runtime-version-output' })
    await harness.flush(3)

    const call = harness.fetchCalls.find((entry) => entry.path === '/admin/runtime-versions' && entry.init?.method === 'POST')
    expect(call, 'saving runtime versions posts to the admin parity endpoint').toBeDefined()
    expect(JSON.parse(String(call?.init?.body))).toEqual({ meshllm: 'v0.72.2', llamacpp: 'b9912' })
  })

  it('REQ-ADM-023 loads and saves node name and VRAM settings from the node drawer', async () => {
    const nodes = [{ id: 'node-weak', displayName: 'Old weak node', status: 'online', agentVersion: 'v1.3.0', maxVramGbOverride: 4, metrics: { runtimeState: 'ready', readyModels: ['codeflare-mesh'], gpuMemoryTotalMiB: 8192, gpuMemoryUsedMiB: 4000, tokensPerSecond: 20, activeRequests: 0 } }]
    const harness = await dashboardHarness({ status: statusFixture({ nodes }) })
    await harness.clickAction('node-detail', { nodeId: 'node-weak' })
    // The drawer loads the persisted operator name and current override.
    expect(harness.byId('node-edit-name').value).toBe('Old weak node')
    expect(harness.byId('node-edit-vram').value).toBe('4')
    // Saving posts both operator-owned settings to the node config endpoint.
    harness.byId('node-edit-name').value = 'Mac mini'
    harness.byId('node-edit-vram').value = '2'
    await harness.clickAction('node-config-save', { nodeId: 'node-weak', out: 'node-output' })
    const call = harness.fetchCalls.find((entry) => entry.path === '/admin/nodes/node-weak/config')
    expect(JSON.parse(String(call?.init?.body))).toMatchObject({ displayName: 'Mac mini', maxVramGbOverride: 2 })
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
    const payload = JSON.parse(String(call?.init?.body)) as { model: string; messages: Array<{ role: string; content: string }>; user: string }
    expect(payload.model).toBe('qwen3.6:35b-a3b')
    expect(payload.messages).toEqual([{ role: 'user', content: 'hello mesh' }])
    expect(payload.user).toMatch(/^user:admin-playground\|session:/)
  })

  it('REQ-ADM-016 renders the tools input, max-token cap, and a stop control in the playground', () => {
    const html = adminUiHtml('https://router.test', { view: 'dashboard', phase: 'complete', customDomain: 'router.test', recovery: false })
    expect(html).toContain('id="' + ADMIN_UI_PLAYGROUND.toolsId + '"')
    expect(html).toContain('id="' + ADMIN_UI_PLAYGROUND.maxTokensId + '"')
    expect(html).toContain('data-action="' + ADMIN_UI_PLAYGROUND.stopAction + '"')
  })

  it('REQ-ADM-034 runs a direct router speed test from the playground', async () => {
    const result = {
      model: 'qwen3.6:35b-a3b',
      requestedPromptTokens: 2048,
      requestedMaxTokens: 160,
      tokens: { prompt: 2048, completion: 80, promptEstimated: false, completionEstimated: false },
      throughput: { promptTokensPerSecond: 1800.5, generationTokensPerSecond: 67.2 }
    }
    let lastSpeedTest: Record<string, unknown> | undefined
    const harness = await dashboardHarness({
      respond: (path) => {
        if (path === ADMIN_UI_PLAYGROUND.speedPath) {
          lastSpeedTest = { at: 1_700_000_300_000, requestId: 'speed-b', model: result.model, promptTokensPerSecond: 1800.5, generationTokensPerSecond: 67.2, requestedPromptTokens: 2048, requestedMaxTokens: 160, promptTokens: 2048, completionTokens: 80, promptTokensEstimated: false, completionTokensEstimated: false, timeToFirstTokenMs: 900, generationMs: 1200, totalMs: 2100 }
          return Response.json(result)
        }
        if (path === '/admin/status') return Response.json(statusFixture(lastSpeedTest ? { lastSpeedTest } : { lastSpeedTest: undefined }))
        return undefined
      }
    })
    harness.byId(ADMIN_UI_PLAYGROUND.selectId).value = 'qwen3.6:35b-a3b'

    await harness.clickAction(ADMIN_UI_PLAYGROUND.speedAction, { out: ADMIN_UI_PLAYGROUND.speedOutputId })
    const call = harness.fetchCalls.find((entry) => entry.path === ADMIN_UI_PLAYGROUND.speedPath)
    const payload = JSON.parse(String(call?.init?.body)) as { model: string }
    const rendered = JSON.parse(harness.byId(ADMIN_UI_PLAYGROUND.speedOutputId).textContent) as typeof result

    expect(payload.model).toBe('qwen3.6:35b-a3b')
    expect(rendered.tokens).toEqual(result.tokens)
    expect(rendered.throughput).toEqual(result.throughput)
    const speedTile = descendants(harness.byId('overview-tiles')).find((node) => node.dataset.stat === 'speed')!
    expect(speedTile.dataset.promptTps).toBe('1800.5')
    expect(speedTile.dataset.generationTps).toBe('67.2')
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
    const body = JSON.parse(String(call?.init?.body)) as { gatewayId: string; route: string; messages: Array<{ role: string; content: string }>; user: string }
    expect(body.gatewayId).toBe('gw-a')
    expect(body.route).toBe('custom-route')
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }])
    expect(body.user).toMatch(/^user:admin-playground\|session:/)
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
    expect(card.classList.contains('is-ok')).toBe(true)
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
    // Serving mode is carried by a pill attribute with the fixed tone vocabulary: singular = blue, sharded = orange.
    expect(badge('single-a').dataset.servingMode).toBe('single')
    expect(badge('split-b').dataset.servingMode).toBe('split')
    expect(badge('split-b').dataset.tone).toBe('orange')
    expect(badge('single-a').dataset.tone).toBe('blue')
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
    expect(row!.children.map((cell) => cell.dataset.label)).toEqual(['Machine', 'Status', 'Mesh', 'VRAM', 'Models', 'Version'])
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

  it('REQ-ADM-024 shows the selected gateway route inside the AI Gateway card', async () => {
    // Provisioned per the live check but zero nodes online: the card is driven by provisioning
    // state (route + provider), not node or serving health, so it still reads connected.
    const harness = await dashboardHarness({ status: statusFixture({ nodes: [] }), respond: routingRespond(true) })
    await harness.click(harness.query('[data-nav="routing"]'))
    await harness.flush(20)
    const card = harness.byId('gateway-current')
    expect(descendants(card).find((node) => node.className === 'state-value')?.textContent).toBe('inference-mesh')
    expect(descendants(card).find((node) => node.className === 'state-sub')?.textContent).toBe('route codeflare-mesh')
    expect(descendants(card).find((node) => node.className === 'chip')?.textContent).toContain('connected')
  })

  it('REQ-ADM-024 marks the AI Gateway card as needing provisioning when the selected route is missing', async () => {
    const harness = await dashboardHarness({ respond: routingRespond(false) })
    await harness.click(harness.query('[data-nav="routing"]'))
    await harness.flush(20)
    const card = harness.byId('gateway-current')
    expect(descendants(card).find((node) => node.className === 'state-sub')?.textContent).toBe('route not provisioned')
    expect(descendants(card).find((node) => node.className === 'chip')?.textContent).toContain('needs provisioning')
  })

  it('REQ-ADM-024 preserves the selected gateway across dashboard refreshes', async () => {
    const provisionChecks: string[] = []
    const harness = await dashboardHarness({
      respond: (path) => {
        if (path.startsWith('/admin/cloudflare/gateway/options')) return Response.json({ gateways: [{ id: 'codeflare-enterprise' }, { id: 'lab-gateway' }], routes: [], defaults: { gatewayId: 'codeflare-enterprise', providerName: 'Codeflare Inference Mesh' } })
        if (path.startsWith('/admin/cloudflare/gateway/provision-status')) {
          provisionChecks.push(new URL('https://router.test' + path).searchParams.get('gateway') || '')
          return Response.json({ gatewayId: provisionChecks.at(-1), provisioned: true, routeEnabled: true, routeName: 'codeflare-mesh', routeId: 'r', providerId: 'p' })
        }
        return undefined
      }
    })
    await harness.click(harness.query('[data-nav="routing"]'))
    await harness.flush(20)
    harness.byId('rt-gateway-select').value = 'lab-gateway'
    await harness.change(harness.byId('rt-gateway-select'))
    await harness.flush(20)
    await harness.clickAction('status-refresh')
    await harness.flush(20)

    expect(harness.byId('rt-gateway-select').value).toBe('lab-gateway')
    expect(descendants(harness.byId('gateway-current')).find((node) => node.className === 'state-value')?.textContent).toBe('lab-gateway')
    expect(provisionChecks).toContain('lab-gateway')
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

  it('REQ-ADM-024 keeps route status inside the Gateway card and labels the action clearly', () => {
    const html = adminUiHtml('https://router.test', { view: 'dashboard', phase: 'complete', customDomain: 'router.test', recovery: false })
    expect(html).not.toContain('id="rt-route-chip"')
    expect(html).toContain('data-action="gateway-sync"')
    expect(html).toContain('Provision Gateway')
  })

  it('REQ-ADM-024 reads the connected gateway as a state card', async () => {
    // The connected gateway renders as an ok-toned status card carrying the gateway id as its value.
    const harness = await dashboardHarness()
    const card = harness.byId('gateway-current')
    const value = descendants(card).find((node) => node.className === 'state-value')
    expect(value!.textContent).toBe('inference-mesh')
    expect(card.classList.contains('is-empty')).toBe(false)
    expect(card.classList.contains('is-ok')).toBe(true)
    expect(descendants(card).find((node) => node.className === 'chip')?.dataset.tone).toBe('ok')
    expect(descendants(card).find((node) => node.className === 'state-sub')?.textContent).toBe('route codeflare-mesh')
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
    expect(JSON.parse(String(addCall?.init?.body))).toEqual({ modelRef: 'unsloth/Qwen3-14B-GGUF:Q4_K_M', mode: 'split', runtime: 'meshllm' })
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

describe('mesh console contracts', () => {
  const consoleMeshes = [
    { id: 'default', name: 'Default', alias: 'codeflare-mesh', machineCount: 1, modelCount: 1 },
    { id: 'development', name: 'Development', alias: 'codeflare-mesh-development', machineCount: 0, modelCount: 0 },
    { id: 'ops', name: 'Ops', alias: 'codeflare-mesh-ops', machineCount: 2, modelCount: 1 }
  ]

  it('REQ-ADM-037 nodes table renders a mesh column resolved to group names', async () => {
    expect(ADMIN_UI_NODES_TABLE.columns).toContain('mesh')
    const nodes = [
      { id: 'node-big', status: 'online', meshId: 'development', metrics: { runtimeState: 'ready', activeRequests: 0 } },
      { id: 'node-small', status: 'online', metrics: { runtimeState: 'ready', activeRequests: 0 } }
    ]
    const harness = await dashboardHarness({ status: statusFixture({ nodes, meshes: consoleMeshes }) })
    const meshCell = (nodeId: string) => tableRows(harness).find((row) => row.dataset.nodeRow === nodeId)!.children.find((td) => td.getAttribute('data-cell') === 'mesh')!
    expect(meshCell('node-big').getAttribute('data-value')).toBe('development')
    expect(meshCell('node-big').textContent).toBe('Development')
    // Legacy rows without a stored meshId render as members of the default group.
    expect(meshCell('node-small').getAttribute('data-value')).toBe('default')
    expect(meshCell('node-small').textContent).toBe('Default')
  })

  it('REQ-ADM-037 meshes card lists groups, gates Delete to empty non-default meshes, and posts create/delete', async () => {
    const harness = await dashboardHarness({ status: statusFixture({ meshes: consoleMeshes }), respond: (path, init) => {
      const method = (init && init.method) || 'GET'
      if (path === '/admin/meshes' && method === 'POST') return Response.json({ ok: true, mesh: { id: 'noobs', name: 'Noobs' } }, { status: 201 })
      if (path === '/admin/meshes/development' && method === 'DELETE') return Response.json({ ok: true })
      return undefined
    } })
    const rows = harness.byId(ADMIN_UI_MESHES.listId).children.filter((row) => row.dataset.meshRow)
    expect(rows.map((row) => row.dataset.meshRow)).toEqual(['default', 'development', 'ops'])
    const aliasOf = (row: StubElement) => descendants(row).find((el) => el.getAttribute('data-mesh-alias') !== null)?.getAttribute('data-mesh-alias')
    expect(aliasOf(rows[1]!)).toBe('codeflare-mesh-development')
    // Counts are structured per row (machines and models separately), not one prose blob.
    const countsOf = (row: StubElement) => descendants(row).find((el) => el.getAttribute('data-mesh-machines') !== null)
    expect(countsOf(rows[2]!)?.getAttribute('data-mesh-machines')).toBe('2')
    expect(countsOf(rows[2]!)?.getAttribute('data-mesh-models')).toBe('1')
    // Served hints render entities exactly once — a double-escaped &amp;lt; would show raw markup.
    expect(harness.html).not.toContain('&amp;lt;')
    const deleteOf = (row: StubElement) => descendants(row).find((el) => el.dataset.action === 'mesh-delete')
    expect(deleteOf(rows[0]!), 'the default mesh never offers Delete').toBeUndefined()
    expect(deleteOf(rows[2]!), 'an occupied mesh offers no Delete').toBeUndefined()
    const del = deleteOf(rows[1]!)
    expect(del).toBeDefined()
    expect(del!.dataset.meshId).toBe('development')
    expect(del!.dataset.confirm, 'mesh delete arms before submitting').toBeTruthy()

    harness.byId(ADMIN_UI_MESHES.nameInputId).value = ' Noobs '
    ;(harness.byId('mesh-add-details') as StubElement & { open?: boolean }).open = true
    await harness.clickAction('mesh-create', { out: ADMIN_UI_MESHES.outputId })
    await harness.flush(5)
    const createCall = harness.fetchCalls.find((call) => call.path === '/admin/meshes' && call.init?.method === 'POST')
    expect(JSON.parse(String(createCall?.init?.body))).toEqual({ name: 'Noobs' })
    expect(harness.byId(ADMIN_UI_MESHES.nameInputId).value, 'a successful create clears the input').toBe('')
    expect((harness.byId('mesh-add-details') as StubElement & { open?: boolean }).open, 'a successful create collapses the disclosure').toBe(false)

    await harness.clickAction('mesh-delete', { meshId: 'development', out: ADMIN_UI_MESHES.outputId })
    await harness.flush(5)
    expect(harness.fetchCalls.some((call) => call.path === '/admin/meshes/development' && call.init?.method === 'DELETE')).toBe(true)
  })

  it('REQ-ADM-023 node drawer saves the mesh selection only when changed', async () => {
    const nodes = [{ id: 'node-weak', displayName: 'Weak', status: 'online', metrics: { runtimeState: 'ready', activeRequests: 0 } }]
    const harness = await dashboardHarness({ status: statusFixture({ nodes, meshes: consoleMeshes }) })
    await harness.clickAction('node-detail', { nodeId: 'node-weak' })
    const select = harness.byId('node-edit-mesh')
    expect(select.children.map((option) => option.value)).toEqual(['default', 'development', 'ops'])
    expect(select.value).toBe('default')
    expect(select.dataset.original).toBe('default')

    await harness.clickAction('node-config-save', { nodeId: 'node-weak', out: 'node-output' })
    const unchanged = harness.fetchCalls.find((call) => call.path === '/admin/nodes/node-weak/config')
    expect(JSON.parse(String(unchanged?.init?.body))).not.toHaveProperty('meshId')

    select.value = 'development'
    await harness.clickAction('node-config-save', { nodeId: 'node-weak', out: 'node-output' })
    const calls = harness.fetchCalls.filter((call) => call.path === '/admin/nodes/node-weak/config')
    expect(JSON.parse(String(calls[calls.length - 1]?.init?.body)).meshId).toBe('development')
  })

  it('REQ-RUN-016 model drawer saves the mesh selection only when changed', async () => {
    const profiles = [{ id: 'custom-tune', displayName: 'Tune', publicAliases: ['codeflare-mesh-development', 'tune'], meshId: 'development', active: false, rolloutPercent: 0, contextWindow: 32768, meshllm: { split: false, modelRef: 'unsloth/x' } }]
    const harness = await dashboardHarness({ status: statusFixture({ profiles, meshes: consoleMeshes }) })
    await harness.clickAction('model-detail', { profileId: 'custom-tune' })
    const select = harness.byId('model-edit-mesh')
    expect(select.value).toBe('development')
    expect(select.dataset.original).toBe('development')
    // The alias field carries the model's OWN alias, never its mesh's stable route name.
    expect(harness.byId('model-edit-callname').value).toBe('tune')

    await harness.clickAction('model-save', { profileId: 'custom-tune', runtime: 'meshllm', out: 'model-edit-output' })
    const unchanged = harness.fetchCalls.find((call) => call.path === '/admin/profiles/config')
    expect(JSON.parse(String(unchanged?.init?.body))).not.toHaveProperty('meshId')

    select.value = 'ops'
    await harness.clickAction('model-save', { profileId: 'custom-tune', runtime: 'meshllm', out: 'model-edit-output' })
    const calls = harness.fetchCalls.filter((call) => call.path === '/admin/profiles/config')
    expect(JSON.parse(String(calls[calls.length - 1]?.init?.body)).meshId).toBe('ops')
  })

  it('REQ-RUN-017 model drawer duplicates a model through the duplicate endpoint', async () => {
    const profiles = [{ id: 'custom-live', displayName: 'Live', publicAliases: ['codeflare-mesh', 'live'], active: true, rolloutPercent: 100, contextWindow: 32768, meshllm: { split: false, modelRef: 'unsloth/x' } }]
    const harness = await dashboardHarness({ status: statusFixture({ profiles }), respond: (path, init) => {
      if (path === '/admin/profiles/duplicate' && (init?.method || 'GET') === 'POST') return Response.json({ ok: true, profileId: 'custom-live-copy' }, { status: 201 })
      return undefined
    } })
    await harness.clickAction('model-detail', { profileId: 'custom-live' })
    // Duplicate applies to any model — including the active one Delete hides for.
    const dup = descendants(harness.byId(ADMIN_UI_DRAWER.bodyId)).find((el) => el.dataset.action === 'model-duplicate')
    expect(dup).toBeDefined()
    expect(dup!.dataset.profileId).toBe('custom-live')
    await harness.clickAction('model-duplicate', { profileId: 'custom-live', out: 'model-edit-output' })
    await harness.flush(5)
    const call = harness.fetchCalls.find((entry) => entry.path === '/admin/profiles/duplicate')
    expect(call?.init?.method).toBe('POST')
    expect(JSON.parse(String(call?.init?.body))).toEqual({ profileId: 'custom-live' })
    expect(harness.byId(ADMIN_UI_DRAWER.containerId).hidden, 'drawer closes so the refreshed list shows the copy').toBe(true)
  })

  it('REQ-ADM-025 REQ-ADM-037 the add-model form and add-mesh input sit behind native disclosure buttons', async () => {
    const harness = await dashboardHarness()
    const html = harness.html
    // Both affordances are <details>/<summary> — present in markup, revealed by a click,
    // never gated on a script state. The mesh disclosure sits in the Meshes header row.
    for (const id of ['model-add-details', 'mesh-add-details']) {
      const at = html.indexOf(`<details class="disclosure" id="${id}">`)
      expect(at, `${id} must be a native disclosure`).toBeGreaterThan(-1)
      expect(html.indexOf('<summary', at)).toBeGreaterThan(at)
    }
    const meshHeadAt = html.indexOf('class="mesh-head"')
    expect(meshHeadAt).toBeGreaterThan(-1)
    expect(html.indexOf('id="mesh-add-details"', meshHeadAt)).toBeGreaterThan(meshHeadAt)
    // The add-model form fields live inside the disclosure body.
    const modelDetailsAt = html.indexOf('id="model-add-details"')
    expect(html.indexOf('id="model-add-ref"', modelDetailsAt)).toBeGreaterThan(modelDetailsAt)
    // Mesh rows right-align the route chip; a successful create collapses the mesh disclosure.
    expect(adminUiCss()).toContain('.mesh-row-head .endpoint-chip{margin-left:auto}')
  })

  it('REQ-ADM-025 renders the model sources panel with CSS-keyed contextual switching', async () => {
    const harness = await dashboardHarness()
    const html = harness.html
    const panelAt = html.indexOf('id="model-add-sources"')
    expect(panelAt).toBeGreaterThan(-1)
    expect(html).toContain('data-model-sources="single"')
    // A copyable reference-format example is structural: a code element inside the panel.
    expect(html.slice(panelAt)).toMatch(/<code>[^<]+<\/code>/)
    expect(html).toContain('data-command-row="model-source-gguf"')
    expect(html).toContain('data-command-row="model-source-layers"')
    expect(html).toContain('data-command-row="model-source-split-guide"')
    // Context switching is CSS keyed off the dataset — content is never gated on a JS reveal.
    const css = adminUiCss()
    expect(css).toContain('.model-sources[data-model-sources="single"] .command-row[data-command-row="model-source-layers"]')
    expect(css).toContain('.model-sources[data-model-sources="split"] .command-row[data-command-row="model-source-gguf"]')

    const mode = harness.byId('model-add-mode')
    const sources = harness.byId('model-add-sources')
    mode.dataset.modelAddMode = 'true'
    mode.value = 'split'
    await harness.change(mode)
    expect(sources.dataset.modelSources).toBe('split')
    mode.value = 'single'
    await harness.change(mode)
    expect(sources.dataset.modelSources).toBe('single')
  })

  it('REQ-RUN-016 the models list shows each profile mesh without opening the drawer', async () => {
    const profiles = [
      { id: 'model-default', displayName: 'Default Model', publicAliases: ['codeflare-mesh', 'main'], active: true, rolloutPercent: 100, meshllm: { split: false } },
      { id: 'model-dev', displayName: 'Dev Model', publicAliases: ['codeflare-mesh-development', 'dev-coder'], meshId: 'development', active: false, rolloutPercent: 0, meshllm: { split: false } }
    ]
    const harness = await dashboardHarness({ status: statusFixture({ profiles, meshes: consoleMeshes }) })
    const rowBadge = (id: string) => {
      const row = harness.byId('profile-list').children.find((candidate) => candidate.dataset.profileRow === id)
      return descendants(row!).find((el) => el.getAttribute('data-profile-mesh') !== null)
    }
    expect(rowBadge('model-dev')?.getAttribute('data-profile-mesh')).toBe('development')
    expect(rowBadge('model-dev')?.textContent).toBe('Development')
    // A legacy row without a stored mesh reads as a Default member.
    expect(rowBadge('model-default')?.getAttribute('data-profile-mesh')).toBe('default')
  })

  it('REQ-ADM-018 REQ-RUN-016 model rows and the drawer lead with the runtime, serving-mode, and mesh pills', async () => {
    const profiles = [
      { id: 'direct-a', displayName: 'Direct A', publicAliases: ['codeflare-mesh', 'direct-a'], active: true, rolloutPercent: 100, runtime: 'llamacpp', llamacpp: { modelRef: 'unsloth/Qwen3-14B-GGUF:Q4_K_M', bindPort: 4500 } },
      { id: 'shard-b', displayName: 'Shard B', publicAliases: ['codeflare-mesh-development', 'shard-b'], meshId: 'development', active: false, rolloutPercent: 0, runtime: 'meshllm', meshllm: { split: true } }
    ]
    const harness = await dashboardHarness({ status: statusFixture({ profiles, meshes: consoleMeshes }) })
    const pill = (id: string, attr: string) => {
      const row = harness.byId('profile-list').children.find((candidate) => candidate.dataset.profileRow === id)
      return descendants(row!).find((el) => el.getAttribute(attr) !== null)!
    }
    // Provider pill: llama.cpp = red, meshllm = green.
    expect(pill('direct-a', 'data-runtime').getAttribute('data-runtime')).toBe('llamacpp')
    expect(pill('direct-a', 'data-runtime').dataset.tone).toBe('red')
    expect(pill('shard-b', 'data-runtime').getAttribute('data-runtime')).toBe('meshllm')
    expect(pill('shard-b', 'data-runtime').dataset.tone).toBe('green')
    // Serving-mode pill combines with the provider pill: a sharded meshllm model reads green + orange.
    expect(pill('shard-b', 'data-serving-mode').dataset.tone).toBe('orange')
    expect(pill('direct-a', 'data-serving-mode').dataset.tone).toBe('blue')
    // Mesh pill is always purple.
    expect(pill('shard-b', 'data-profile-mesh').dataset.tone).toBe('purple')
    expect(pill('direct-a', 'data-profile-mesh').getAttribute('data-profile-mesh')).toBe('default')

    // The Manage overlay leads with the same pill row, so provider, mode, and mesh are visible there too.
    await harness.clickAction('model-detail', { profileId: 'shard-b' })
    const drawerPills = descendants(harness.byId(ADMIN_UI_DRAWER.bodyId)).find((node) => node.getAttribute('data-drawer-pills') === 'shard-b')!
    const drawerPill = (attr: string) => descendants(drawerPills).find((el) => el.getAttribute(attr) !== null)!
    expect(drawerPill('data-runtime').getAttribute('data-runtime')).toBe('meshllm')
    expect(drawerPill('data-serving-mode').getAttribute('data-serving-mode')).toBe('split')
    expect(drawerPill('data-profile-mesh').getAttribute('data-profile-mesh')).toBe('development')
  })

  it('REQ-ADM-015 overview topology filters machines to the selected mesh and survives the poll', async () => {
    const nodes = [
      { id: 'node-default', status: 'online', metrics: { runtimeState: 'ready', activeRequests: 0 } },
      { id: 'node-dev', status: 'online', meshId: 'development', metrics: { runtimeState: 'ready', activeRequests: 0 } }
    ]
    const harness = await dashboardHarness({ status: statusFixture({ nodes, meshes: consoleMeshes }) })
    const select = harness.byId(ADMIN_UI_TOPOLOGY.meshSelectId)
    expect(select.children.map((option) => option.value)).toEqual(['all', 'default', 'development', 'ops'])
    const topoIds = () => harness.byId(ADMIN_UI_TOPOLOGY.listId).children.map((el) => el.dataset.nodeId)
    expect(topoIds()).toEqual(['node-default', 'node-dev'])

    select.dataset.topoMeshSelect = 'true'
    select.value = 'development'
    await harness.change(select)
    expect(topoIds()).toEqual(['node-dev'])
    expect(harness.byId(ADMIN_UI_TOPOLOGY.captionId).dataset.nodes).toBe('1')

    // The selection survives the periodic status rebuild instead of snapping back to all.
    harness.runTimers()
    await harness.flush(10)
    expect(select.value).toBe('development')
    expect(topoIds()).toEqual(['node-dev'])
  })

  it("REQ-ADM-031 direct playground lists every mesh's active model by its own alias", async () => {
    const profiles = [
      { id: 'model-default', displayName: 'Default Model', publicAliases: ['codeflare-mesh', 'main'], active: true, rolloutPercent: 100, meshllm: { split: false } },
      { id: 'model-dev', displayName: 'Dev Model', publicAliases: ['codeflare-mesh-development', 'dev-coder'], meshId: 'development', active: true, rolloutPercent: 100, meshllm: { split: false } },
      { id: 'model-off', displayName: 'Off Model', publicAliases: ['codeflare-mesh-ops', 'off-model'], meshId: 'ops', active: false, rolloutPercent: 0, meshllm: { split: false } }
    ]
    const harness = await dashboardHarness({ status: statusFixture({ profiles, meshes: consoleMeshes }) })
    const select = harness.byId(ADMIN_UI_PLAYGROUND.selectId)
    expect(select.children.map((option) => option.value)).toEqual(['main', 'dev-coder'])
  })
})
