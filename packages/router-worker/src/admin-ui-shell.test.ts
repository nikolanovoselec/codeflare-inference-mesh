/**
 * console shell, hero, topology and overview contracts.
 *
 * One slice of the console dashboard suite; shared fixtures live in
 * `./admin-ui-test-support`.
 */
import { ADMIN_UI_DRAWER, ADMIN_UI_MESH_ROLE, ADMIN_UI_TOPOLOGY, ADMIN_UI_WORK_STATE, adminUiHtml } from './admin-ui'
import { adminUiCss } from './admin-ui-css'
import { adminUiHarness, descendants, type StubElement } from './admin-ui-harness'
import { dashboardHarness, resetDashboardEnvironment, statusFixture, tableRows } from './admin-ui-test-support'
import { afterEach, describe, expect, it, vi } from 'vitest'

describe('console shell, hero, topology and overview contracts', () => {
  afterEach(resetDashboardEnvironment)


  it('REQ-OBS-011 REQ-ADM-015 renders every mesh-role token onto the node status cell', async () => {
    // Rendered, not matched against the script's own text: the console can contain a token
    // literal and still never apply it to a node. Covers the roles the other drawer tests
    // do not reach.
    const roleNodes = [
      { id: 'role-coordinator', status: 'online', activeProfileIds: [], metrics: { runtimeState: 'ready', meshRole: 'coordinator', activeRequests: 0 } },
      { id: 'role-serving-peer', status: 'online', activeProfileIds: [], metrics: { runtimeState: 'ready', meshRole: 'serving-peer', activeRequests: 0 } },
      { id: 'role-api-client', status: 'online', activeProfileIds: [], metrics: { runtimeState: 'ready', meshRole: 'api-client', activeRequests: 0 } },
      { id: 'role-stage-owner', status: 'online', activeProfileIds: [], metrics: { runtimeState: 'ready', meshRole: 'serving-peer', stageCount: 1, apiReady: true, consoleReady: true, activeRequests: 0 } }
    ]
    const harness = await dashboardHarness({ status: statusFixture({ nodes: roleNodes }) })
    const roleOf = (nodeId: string) => {
      const row = tableRows(harness).find((candidate) => candidate.dataset.nodeRow === nodeId)!
      return descendants(row).find((candidate) => candidate.dataset.cell === 'status')!.dataset.meshRole
    }

    expect(roleOf('role-coordinator')).toBe(ADMIN_UI_MESH_ROLE.coordinator)
    expect(roleOf('role-serving-peer')).toBe(ADMIN_UI_MESH_ROLE.servingPeer)
    expect(roleOf('role-api-client')).toBe(ADMIN_UI_MESH_ROLE.noStageAssigned)
    // A node holding a stage reads as the stage owner even though it reports serving-peer.
    expect(roleOf('role-stage-owner')).toBe(ADMIN_UI_MESH_ROLE.stageOwner)
  })


  it('REQ-OBS-011 REQ-ADM-015 renders every work-state token onto the node drawer', async () => {
    const stateNodes = [
      { id: 'ws-installing', status: 'online', activeProfileIds: [], metrics: { runtimeState: 'downloading', activeRequests: 0 } },
      { id: 'ws-attention', status: 'online', activeProfileIds: [], metrics: { runtimeState: 'failed', activeRequests: 0 } },
      { id: 'ws-online', status: 'online', activeProfileIds: [], metrics: { runtimeState: 'ready', apiReady: true, activeRequests: 0 } }
    ]
    const harness = await dashboardHarness({ status: statusFixture({ nodes: stateNodes }) })
    const workStateOf = async (nodeId: string) => {
      await harness.clickAction('node-detail', { nodeId })
      const fields = descendants(harness.byId(ADMIN_UI_DRAWER.bodyId))
      return fields.find((node) => node.dataset.drawerField === 'work-state')?.dataset.value
    }

    expect(await workStateOf('ws-installing')).toBe(ADMIN_UI_WORK_STATE.installingRuntime)
    expect(await workStateOf('ws-attention')).toBe(ADMIN_UI_WORK_STATE.needsAttention)
    expect(await workStateOf('ws-online')).toBe(ADMIN_UI_WORK_STATE.runtimeOnline)
  })


  it('REQ-OBS-011 REQ-ADM-015 pins the work-state and mesh-role token vocabulary', () => {
    // The rendering tests above and the drawer tests below prove the console emits these.
    // This pins the values themselves, so a rename is a visible contract change.
    expect(ADMIN_UI_WORK_STATE).toEqual({
      servingSplitStage: 'serving-split-stage',
      servingModel: 'serving-model',
      installingRuntime: 'installing-runtime',
      startingModel: 'starting-model',
      needsAttention: 'needs-attention',
      runtimeOnline: 'runtime-online'
    })
    expect(ADMIN_UI_MESH_ROLE).toEqual({
      attribute: 'data-mesh-role',
      stageOwner: 'stage-owner',
      noStageAssigned: 'no-stage-assigned',
      servingPeer: 'serving-peer',
      coordinator: 'coordinator'
    })
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
    // Every section's nav item carries a hint; the copy itself is not contract.
    for (const section of ['overview', 'nodes', 'models']) {
      expect(html).toMatch(new RegExp('data-nav-item="' + section + '" data-nav-hint="[^"]+"'))
    }
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
    // Six tiles, in order — the last speed test moved into the per-mesh cards.
    expect(tiles.filter((candidate) => candidate.dataset.stat).map((candidate) => candidate.dataset.stat)).toEqual(['nodes', 'vram', 'throughput', 'meshes', 'domain', 'version'])
    expect(stat('nodes')).toBe('2/3')
    // Consumed / total: online machines report 20000 + 4000 MiB used of 32768 known.
    expect(stat('vram')).toBe('23.4 / 32 GB')
    // Live fleet throughput sums per-machine tok/s from heartbeat metrics (42.5 + 61.25).
    expect(stat('throughput')).toBe('104 tok/s')
    // One mesh known, its active model served by adopted machines.
    expect(stat('meshes')).toBe('1 · 1 serving')
  })


  it('REQ-ADM-039 does not fabricate a mesh-card speed test before one is reported', async () => {
    const harness = await dashboardHarness({ status: statusFixture({ lastSpeedTests: undefined }) })
    const card = descendants(harness.byId('overview-mesh')).find((el) => el.getAttribute('data-mesh-status') === 'default')!

    expect(card.getAttribute('data-speed-prompt')).toBeNull()
    expect(card.getAttribute('data-speed-gen')).toBeNull()
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
    expect(statusCell.dataset.meshRole).toBe(ADMIN_UI_MESH_ROLE.noStageAssigned)
    expect(statusCell.dataset.statusDetail).toBe('standby')
    const chip = descendants(statusCell).find((node) => node.className === 'chip')!
    // An api-client advertising ready models without a ready runtime or a stage is
    // still preparing — catalog claims alone never read as Serving.
    expect(chip.dataset.tone).toBe('warn')
    expect(descendants(chip).map((node) => node.textContent).join('')).toBe('Preparing')
    await harness.clickAction('node-detail', { nodeId: 'battlestation' })
    const drawerFields = descendants(harness.byId(ADMIN_UI_DRAWER.bodyId))
    // The captured error line rides the drawer as a warn-toned recent-error row even
    // while the node participates (REQ-OBS-011 AC7).
    const recentErr = drawerFields.find((node) => node.dataset.drawerField === 'runtime-detail')!
    expect(recentErr.dataset.tone).toBe('warn')
    const workState = drawerFields.find((node) => node.dataset.drawerField === 'work-state')!
    expect(workState.dataset.value).toBe(ADMIN_UI_WORK_STATE.servingModel)
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
    // Tile identity is the data-stat key, not the label copy.
    expect(stats).toContain('vram')
    expect(stats).toContain('throughput')
    expect(stats).toContain('meshes')
    expect(harness.byId(ADMIN_UI_TOPOLOGY.captionId).textContent).toContain('available')
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

})
