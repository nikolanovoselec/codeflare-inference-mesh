import { describe, expect, it } from 'vitest'
import { ADMIN_UI_AGENT_VERSION, ADMIN_UI_DRAWER, ADMIN_UI_MESH_HEALTH, ADMIN_UI_NODES_TABLE, adminUiHtml } from './admin-ui'
import type { MeshHealthEntry, MeshUiStatusNode } from './admin-ui'
import { adminUiHarness, descendants, elementStub, type AdminUiHarness, type StubElement } from './admin-ui-harness'
import { adminUiCss } from './admin-ui-css'
import { SETUP_TOKEN_PLACEHOLDER } from './installers'

const meshNodes: readonly MeshUiStatusNode[] = [
  { id: 'node-coord', status: 'online', agentVersion: 'v1.3.0', metrics: { runtimeState: 'running', readyModels: ['qwen3.6:35b-a3b', 'codeflare-mesh'] } },
  { id: 'node-peer-a', status: 'online', agentVersion: 'v1.2.0', metrics: { runtimeState: 'running', readyModels: ['qwen3.6:35b-a3b'] } },
  { id: 'node-peer-b', status: 'online', metrics: { runtimeState: 'failed' } },
  { id: 'node-outside', status: 'online', metrics: { runtimeState: 'running', readyModels: ['outside-model'] } }
]

const meshEntries: readonly MeshHealthEntry[] = [
  {
    profileId: 'mesh-default-qwen36-35b',
    meshId: 'mesh-abc',
    rotation: 3,
    seedNodeId: 'node-coord',
    coordinatorNodeId: 'node-coord',
    peerNodeIds: ['node-peer-a', 'node-peer-b'],
    readyModels: ['qwen3.6:35b-a3b', 'codeflare-mesh'],
    stageAssignments: [{ stageId: 'stage-0', stageIndex: 0, nodeId: 'node-coord', layerStart: 0, layerEnd: 15, state: 'ready', reportedByNodeId: 'node-coord' }],
    failedNodeIds: ['node-peer-b'],
    tokenCount: 2,
    secretAgeMs: 300_000,
    lastError: 'node-peer-b: mesh runner exited'
  },
  { profileId: 'mesh-split-qwen36-35b', rotation: 0, peerNodeIds: [], readyModels: [], failedNodeIds: [], tokenCount: 0 }
]

const statusProfiles = [
  { id: 'mesh-default-qwen36-35b', publicAliases: ['codeflare-mesh', 'qwen3.6:35b-a3b'], active: true, rolloutPercent: 100, meshllm: { split: false } },
  { id: 'mesh-split-qwen36-35b', publicAliases: ['codeflare-mesh', 'qwen3.6:35b-a3b'], active: false, rolloutPercent: 100, meshllm: { split: true } },
  { id: 'mesh-smoke-qwen25-1.5b', publicAliases: ['mesh-smoke'], active: true, rolloutPercent: 100, meshllm: { split: false } }
]

function statusFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    nodes: meshNodes,
    profiles: statusProfiles,
    profileReadiness: [{ profileId: 'mesh-default-qwen36-35b', ready: 2, downloading: 0, failed: 1 }],
    audit: [
      { id: 'audit-1', type: 'first_setup', at: 1_700_000_000_000, actor: 'setup' },
      { id: 'audit-2', type: 'node_claimed', at: 1_700_000_100_000, actor: 'setup', target: 'node-coord' }
    ],
    generatedAt: 1_700_000_200_000,
    gateway: { gatewayId: 'inference-mesh', routeName: 'codeflare-mesh', publicModel: 'codeflare-mesh' },
    customDomain: { hostname: 'ai.example.com', status: 'provisioned' },
    desiredAgentVersion: 'v1.3.0',
    meshHealth: meshEntries,
    ...overrides
  }
}

async function dashboardHarness(status: Record<string, unknown> = statusFixture(), versions: Record<string, unknown> = { tags: [], stale: false }): Promise<AdminUiHarness> {
  const html = adminUiHtml('https://router.test', { view: 'dashboard', phase: 'complete', customDomain: 'router.test', recovery: false })
  const harness = adminUiHarness(html, async (path) => {
    if (path === '/admin/status') return Response.json(status)
    if (path === '/admin/agent-versions') return Response.json(versions)
    if (path === '/admin/runtime-versions') return Response.json({ meshllm: { tags: [], desired: 'v0.72.2', stale: false }, llamacpp: { tags: [], desired: 'b9912', stale: false } })
    if (path === '/admin/mesh/rotate') return Response.json({ ok: true, rotation: 4 })
    if (path === '/admin/profiles/activate') return Response.json({ ok: true })
    if (path === '/admin/login') return Response.json({ ok: true, session: 'bearer-token' })
    return new Response('command', { status: 200, headers: { 'content-type': 'text/plain' } })
  }, { sessionToken: 'admin-secret' })
  harness.run()
  // the dashboard boots directly under the session; settle its fetches first
  await harness.flush(10)
  expect(harness.body.dataset.view).toBe('dashboard')
  return harness
}

// Mesh detail now lives in a model's Manage drawer (a sharded model is just a model),
// so a card is reached by opening that model's drawer rather than a standalone panel.
async function meshCard(harness: AdminUiHarness, profileId: string): Promise<StubElement> {
  await harness.clickAction('model-detail', { profileId })
  const body = harness.byId(ADMIN_UI_DRAWER.bodyId)
  const card = descendants(body).find((node) => node.dataset.meshEntry === profileId)
  expect(card, `no mesh card in the drawer for ${profileId}`).toBeDefined()
  return card!
}

function meshField(card: StubElement, field: string): StubElement {
  const line = descendants(card).find((node) => node.dataset.meshField === field)
  expect(line, `no mesh field ${field}`).toBeDefined()
  return line!
}

describe('admin UI mesh operations contracts', () => {
  it('REQ-ADM-009 exposes the mesh-key banner, the model list, and the agent-version control', () => {
    const html = adminUiHtml('https://router.test', { view: 'dashboard', phase: 'complete', recovery: false })
    // The mesh-secret-missing banner lives on the Models section now that mesh has no own section.
    expect(html).toContain('data-mesh-key-banner="true"')
    expect(html).toContain(`id="${ADMIN_UI_MESH_HEALTH.bannerId}"`)
    // Models are one client-rendered list; activation and the sharing-key reset are per-model controls.
    expect(html).toContain('id="profile-list"')
    expect(html).toContain('data-output="profiles"')
    expect(html).toContain(`id="${ADMIN_UI_AGENT_VERSION.selectId}"`)
    expect(html).toContain('data-action="agent-versions-refresh"')
    expect(html).toContain('data-action="agent-version-set"')
    expect(html).toContain('data-runtime-version-select="meshllm"')
    expect(html).toContain('data-runtime-version-select="llamacpp"')
    expect(html).toContain('data-action="runtime-versions-refresh"')
    expect(html).toContain('data-action="runtime-versions-set"')
    expect([...html.matchAll(/data-action="status-refresh"/g)].length).toBeGreaterThanOrEqual(2)
  })

  it('REQ-ADM-006 keeps mesh invite token state out of visible operator rows', async () => {
    const harness = await dashboardHarness()
    await harness.clickAction('status-refresh')

    // Opening a model's drawer replaces the body, so assert the present card fully first.
    const present = await meshCard(harness, 'mesh-default-qwen36-35b')
    expect(present.dataset.secretPresent).toBe('true')
    const renderedFields = descendants(present).map((node) => node.dataset.meshField).filter(Boolean)
    expect(renderedFields).toEqual([...ADMIN_UI_MESH_HEALTH.fields])
    expect(renderedFields).not.toContain('secret')

    const absent = await meshCard(harness, 'mesh-split-qwen36-35b')
    expect(absent.dataset.secretPresent).toBe('false')
    expect(descendants(absent).some((node) => node.dataset.meshField === 'secret')).toBe(false)
  })

  it('REQ-ADM-009 wires the one-click rotate action to the mesh rotate endpoint', async () => {
    const harness = await dashboardHarness()
    await harness.clickAction('status-refresh')
    // The sharing-key reset lives in the model's Manage drawer and carries its profile id.
    await harness.clickAction('model-detail', { profileId: 'mesh-default-qwen36-35b' })
    const reset = descendants(harness.byId(ADMIN_UI_DRAWER.bodyId)).find((node) => node.dataset.action === 'mesh-rotate')
    expect(reset, 'the drawer exposes a sharing-key reset').toBeDefined()
    expect(reset!.dataset.profileId).toBe('mesh-default-qwen36-35b')
    expect(reset!.dataset.confirm, 'reset must arm before submitting').toBeTruthy()

    await harness.click(reset!)
    expect(harness.fetchCalls.filter((call) => call.path === '/admin/mesh/rotate')).toHaveLength(0)
    await harness.click(reset!)

    const call = harness.fetchCalls.find((item) => item.path === '/admin/mesh/rotate')
    expect(call).toBeDefined()
    expect(call!.init?.method).toBe('POST')
    expect(call!.init?.headers).toMatchObject({ authorization: 'Bearer admin-secret', 'content-type': 'application/json' })
    expect(JSON.parse(String(call!.init?.body))).toEqual({ profileId: 'mesh-default-qwen36-35b' })
    expect(harness.byId('mesh-rotate-output').textContent).toBe('Sharing key reset.')
  })

  it('REQ-ADM-009 turns a model on from the unified model list', async () => {
    const harness = await dashboardHarness()
    await harness.clickAction('status-refresh')

    // Every model shows as its own card — including ones with a unique callable name.
    const rows = harness.byId('profile-list').children.filter((row) => row.dataset.profileRow)
    expect(rows.map((row) => row.dataset.profileRow)).toContain('mesh-split-qwen36-35b')

    // Turning an off model on activates it through the validated endpoint.
    await harness.clickAction('model-toggle', { profileId: 'mesh-split-qwen36-35b', on: 'false' })
    const call = harness.fetchCalls.find((item) => item.path === '/admin/profiles/activate')
    expect(call).toBeDefined()
    expect(JSON.parse(String(call!.init?.body))).toEqual({ profileId: 'mesh-split-qwen36-35b' })

    // Turning an on model off drops its traffic to zero.
    await harness.clickAction('model-toggle', { profileId: 'mesh-default-qwen36-35b', on: 'true' })
    const off = harness.fetchCalls.find((item) => item.path === '/admin/profiles/rollout')
    expect(off).toBeDefined()
    expect(JSON.parse(String(off!.init?.body))).toEqual({ profileId: 'mesh-default-qwen36-35b', rolloutPercent: 0 })
  })

  it('REQ-ADM-008 renders the agent-version dropdown and per-node reported-versus-desired view', async () => {
    const harness = await dashboardHarness(statusFixture(), { tags: ['v1.3.0', 'v1.2.0'], stale: false, desired: 'v1.3.0' })
    await harness.clickAction('agent-versions-refresh')

    const slot = harness.byId(ADMIN_UI_AGENT_VERSION.slotId)
    const select = slot.children[0]!
    expect(select.dataset.agentVersionSelect).toBe('true')
    expect(select.dataset.stale).toBe('false')
    expect(select.children.map((option) => option.dataset.agentVersionOption)).toEqual(['v1.3.0', 'v1.2.0'])
    expect(select.children[0]!.dataset.desired).toBe('true')
    expect(select.children[0]!.selected).toBe(true)
    expect(select.value).toBe('v1.3.0')

    await harness.clickAction('status-refresh')
    const rowNodes = harness.byId(ADMIN_UI_NODES_TABLE.bodyId).children.flatMap((row) => [row, ...descendants(row)])
    const versionOf = (nodeId: string) => rowNodes.find((node) => node.dataset.nodeVersion === nodeId)!
    expect(versionOf('node-coord').dataset.reported).toBe('v1.3.0')
    expect(versionOf('node-coord').dataset.desiredMatch).toBe('true')
    expect(versionOf('node-peer-a').dataset.reported).toBe('v1.2.0')
    expect(versionOf('node-peer-a').dataset.desiredMatch).toBe('false')
    expect(versionOf('node-peer-a').textContent).toContain('v1.3.0')
    expect(versionOf('node-peer-b').dataset.reported).toBe('unreported')
    // Revoke moved into the node drawer (opened via Manage); each row now carries a right-aligned Manage button.
    const manageButtons = rowNodes.filter((node) => node.dataset.action === 'node-detail' && node.textContent === 'Manage')
    expect(manageButtons).toHaveLength(meshNodes.length)
  })

  it('REQ-SEC-006 surfaces mesh_state_key_missing as an admin status banner', async () => {
    const missing = statusFixture({
      meshHealth: [{ profileId: 'mesh-default-qwen36-35b', rotation: 0, peerNodeIds: [], tokenCount: 0, lastError: 'mesh_state_key_missing' }]
    })
    const harness = await dashboardHarness(missing)
    await harness.clickAction('status-refresh')
    expect(harness.byId(ADMIN_UI_MESH_HEALTH.bannerId).hidden).toBe(false)

    const healthy = await dashboardHarness()
    await healthy.clickAction('status-refresh')
    expect(healthy.byId(ADMIN_UI_MESH_HEALTH.bannerId).hidden).toBe(true)
  })

  it('REQ-OBS-007 explains missing stage ownership instead of rendering useless none values', async () => {
    const status = statusFixture({
      nodes: [
        { id: 'mac-100-96-0-14', status: 'online', agentVersion: 'v0.1.0-dev.94', activeProfileIds: ['mesh-default-qwen36-35b'], metrics: { runtimeState: 'starting', nodeState: 'standby', meshRole: 'api-client', apiReady: true, consoleReady: true, readyModels: ['qwen3.6:35b-a3b'] } }
      ],
      meshHealth: [{ profileId: 'mesh-default-qwen36-35b', rotation: 0, peerNodeIds: ['mac-100-96-0-14'], readyModels: ['qwen3.6:35b-a3b'], failedNodeIds: [], tokenCount: 1 }]
    })
    const harness = await dashboardHarness(status)
    const card = await meshCard(harness, 'mesh-default-qwen36-35b')
    expect(meshField(card, 'coordinator').dataset.stageMap).toBe('unavailable')
    expect(meshField(card, 'stage-owners').dataset.stageMap).toBe('unavailable')
    expect(meshField(card, 'stage-owners').dataset.agentVersions).toBe('v0.1.0-dev.94')
  })

  it('REQ-OBS-007 renders split capacity shortfall as structured mesh detail', async () => {
    const splitReadiness = {
      modelRef: 'meshllm/ERNIE-layers', verdict: 'insufficient_capacity',
      capacityAdvice: { state: 'insufficient_capacity', reason: 'participant_split_capacity_insufficient', requiredBytes: 18_000_000_000, aggregateCapacityBytes: 16_000_000_000, shortfallBytes: 2_000_000_000, eligibleNodeCount: 2, splitCapable: true },
      participants: [{ shortNodeId: 'mesh-mac-hash', routerNodeId: 'mac', displayName: 'Mac', vramBytes: 4_000_000_000 }, { shortNodeId: 'mesh-battle-hash', routerNodeId: 'battle', displayName: 'battlestation', vramBytes: 12_000_000_000 }],
      blockers: [{ reason: 'split_capacity_shortfall', recommendation: 'Increase available VRAM.' }]
    }
    const status = statusFixture({
      meshHealth: [{ profileId: 'mesh-default-qwen36-35b', rotation: 0, peerNodeIds: ['mac', 'battle'], readyModels: [], failedNodeIds: [], tokenCount: 2, splitReadiness }]
    })
    const harness = await dashboardHarness(status)
    const card = await meshCard(harness, 'mesh-default-qwen36-35b')
    expect(card.dataset.splitReason).toBe('split_capacity_shortfall')
    const splitBlock = descendants(card).find((node) => node.className === 'split-readiness-block')!
    expect(splitBlock.dataset.splitReason).toBe('split_capacity_shortfall')
    const capacity = descendants(splitBlock).find((node) => node.dataset.splitField === 'capacity')!
    expect(capacity.dataset.requiredBytes).toBe('18000000000')
    expect(capacity.dataset.aggregateBytes).toBe('16000000000')
    expect(capacity.dataset.shortfallBytes).toBe('2000000000')
    expect(descendants(capacity).map((node) => node.textContent).join(' ')).not.toContain('16 GB')
    const participantChips = descendants(splitBlock).filter((node) => node.dataset.participantLabel)
    const participantLabels = participantChips.map((node) => node.dataset.participantLabel)
    expect(participantLabels).toEqual(['Mac', 'battlestation'])
    expect(participantLabels).not.toContain('mesh-mac-hash')
    expect(participantChips.map((node) => node.textContent).join(' ')).not.toContain('GB capacity')
  })

  it('REQ-OBS-007 renders stage owners with machine names instead of MeshLLM hashes', async () => {
    const status = statusFixture({
      nodes: [
        { id: 'linux-node', displayName: 'battlestation', status: 'online', activeProfileIds: ['mesh-default-qwen36-35b'], metrics: { runtimeState: 'ready', meshNodeId: 'mesh-linux-abcdef', readyModels: ['codeflare-mesh'] } },
        { id: 'mac-100-96-0-14', displayName: 'Mac', status: 'online', activeProfileIds: ['mesh-default-qwen36-35b'], metrics: { runtimeState: 'ready', meshNodeId: 'mesh-mac-123456' } }
      ],
      meshHealth: [{ profileId: 'mesh-default-qwen36-35b', rotation: 0, coordinatorNodeId: 'linux-node', peerNodeIds: ['linux-node', 'mac-100-96-0-14'], readyModels: ['codeflare-mesh'], failedNodeIds: [], tokenCount: 2, stageAssignments: [{ stageIndex: 0, nodeId: 'mesh-linux-abcdef', layerStart: 0, layerEnd: 26, state: 'ready' }, { stageIndex: 1, nodeId: 'mesh-mac-123456', layerStart: 27, layerEnd: 28, state: 'ready' }] }]
    })
    const harness = await dashboardHarness(status)
    const card = await meshCard(harness, 'mesh-default-qwen36-35b')
    expect(meshField(card, 'stage-owners').textContent).toBe('Stage owners: L0-26 → battlestation · Ready; L27-28 → Mac · Ready')
  })

  it('REQ-OBS-007 renders the mesh health panel from admin status data', async () => {
    const harness = await dashboardHarness()
    await harness.clickAction('status-refresh')

    const card = await meshCard(harness, 'mesh-default-qwen36-35b')
    expect(card.dataset.meshRotation).toBe('3')
    expect(meshField(card, 'coordinator').textContent).toBe('Coordinator: node-coord')
    expect(meshField(card, 'peers').textContent).toBe('Machines: 2')
    expect(meshField(card, 'stage-owners').textContent).toBe('Stage owners: L0-15 → node-coord · Ready')
    expect(meshField(card, 'ready-models').textContent).toBe('Ready model: qwen3.6:35b-a3b, codeflare-mesh')
    expect(meshField(card, 'failed-nodes').textContent).toBe('Needs attention: node-peer-b')
    expect(meshField(card, 'last-error').textContent).toBe('Last error: node-peer-b: mesh runner exited')
    expect(descendants(card).some((node) => node.dataset.meshField === 'rotation')).toBe(false)
    expect(descendants(card).some((node) => node.dataset.meshField === 'secret')).toBe(false)
  })

  it('REQ-OBS-007 shows a switched-off model as deactivated, never green ready', async () => {
    // A deactivated model can still carry stale mesh tokens (peers + a secret). It must
    // not read the green "ready" it did before active-state was folded into the status.
    const offStatus = statusFixture({
      profiles: [{ id: 'mesh-default-qwen36-35b', publicAliases: ['codeflare-mesh'], active: false, rolloutPercent: 0, meshllm: { split: false } }],
      meshHealth: [{ profileId: 'mesh-default-qwen36-35b', rotation: 3, peerNodeIds: ['node-peer-a'], readyModels: ['codeflare-mesh'], failedNodeIds: [], deactivatedNodeIds: [], active: false, tokenCount: 2 }]
    })
    const harness = await dashboardHarness(offStatus)
    await harness.clickAction('status-refresh')
    const card = await meshCard(harness, 'mesh-default-qwen36-35b')
    const summary = descendants(card).find((node) => node.className === 'mesh-summary')
    expect(summary, 'a plain summary is shown').toBeDefined()
    expect(summary!.textContent).toContain('deactivated')
    expect(summary!.textContent).not.toContain('ready')
  })

  it('REQ-OBS-007 shows a plain sharing summary while keeping the technical fields behind a disclosure', async () => {
    const harness = await dashboardHarness()
    await harness.clickAction('status-refresh')
    const card = await meshCard(harness, 'mesh-default-qwen36-35b')
    const summary = descendants(card).find((node) => node.className === 'mesh-summary')
    expect(summary, 'a plain summary is shown').toBeDefined()
    // Behavioral: the peers field carries the real peer count (2), and the raw internals
    // remain available behind a Technical details disclosure — no prose is pinned.
    expect(meshField(card, 'peers').textContent).toBe('Machines: 2')
    expect(meshField(card, 'coordinator').textContent).toBe('Coordinator: node-coord')
    expect(descendants(card).some((node) => node.tagName === 'details')).toBe(true)
  })

  it('REQ-OBS-007 gives each technical-details field its own line so they never run together', () => {
    // The fields render as distinct inline <code data-mesh-field> nodes (asserted above); without a
    // block rule they collapse onto one line. This locks the stylesheet contract that separates them.
    expect(adminUiCss()).toMatch(/code\[data-mesh-field\]\s*\{[^}]*display:\s*block/)
  })

  it('REQ-ADM-006 verifies the admin token before storing it', async () => {
    const html = adminUiHtml('https://router.test', { view: 'setup', phase: 'claimed', recovery: false })
    const okHarness = adminUiHarness(html, async (path) => {
      if (path === '/admin/login') return Response.json({ ok: true, session: 'bearer-token' })
      if (path === '/admin/agent-versions') return Response.json({ tags: [], stale: false })
      if (path === '/admin/status') return Response.json({})
      return new Response('command', { status: 200, headers: { 'content-type': 'text/plain' } })
    })
    okHarness.run()
    okHarness.byId('admin-token').value = 'candidate-token'
    const form = elementStub({ tagName: 'form' })
    form.dataset.loginForm = 'true'
    await okHarness.submit(form)
    await okHarness.flush()

    const loginIndex = okHarness.events.findIndex((event) => event.kind === 'fetch' && event.detail === '/admin/login')
    const storeIndex = okHarness.events.findIndex((event) => event.kind === 'setItem' && event.detail.includes('candidate-token'))
    expect(loginIndex).toBeGreaterThanOrEqual(0)
    expect(storeIndex).toBeGreaterThan(loginIndex)
    expect(okHarness.body.dataset.view).toBe('setup')
    expect(okHarness.byId('step-domain').hidden).toBe(false)

    const failHarness = adminUiHarness(html, async () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } }))
    failHarness.run()
    failHarness.byId('admin-token').value = 'wrong-token'
    await failHarness.submit(form)
    await failHarness.flush()

    expect(failHarness.events.some((event) => event.kind === 'setItem' && event.detail.includes('wrong-token'))).toBe(false)
    expect(failHarness.body.dataset.view).toBe('setup')
    expect(failHarness.byId('login-output').classList.contains('is-error')).toBe(true)
  })

  it('REQ-ADM-019 renders a humane retry message for a 5xx failure without leaking the raw server error token', async () => {
    const html = adminUiHtml('https://router.test', { view: 'dashboard', phase: 'complete', customDomain: 'router.test', recovery: false })
    const harness = adminUiHarness(html, async (path) => {
      if (path === '/admin/status') return Response.json(statusFixture())
      if (path === '/admin/agent-versions') return Response.json({ tags: [], stale: false })
      if (path === '/admin/profiles/activate') {
        return new Response(JSON.stringify({ error: 'internal_error', requestId: 'req-xyz' }), { status: 503, headers: { 'content-type': 'application/json' } })
      }
      return new Response('command', { status: 200, headers: { 'content-type': 'text/plain' } })
    }, { sessionToken: 'admin-secret' })
    harness.run()
    await harness.flush(10)

    await harness.clickAction('model-toggle', { profileId: 'mesh-split-qwen36-35b', on: 'false', out: 'models-output' })
    await harness.flush()

    const output = harness.byId('models-output')
    expect(output.classList.contains('is-error')).toBe(true)
    expect(output.textContent).not.toContain('internal_error')
    expect(output.textContent).toContain('req-xyz')
  })

  it('REQ-ADM-003 fills the minted setup token into the install command', async () => {
    const html = adminUiHtml('https://router.test', { view: 'dashboard', phase: 'complete', customDomain: 'router.test', recovery: false })
    const command = "curl -fsSL https://router.test/install.sh?platform=linux | ROUTER_URL='https://router.test' SETUP_TOKEN='" + SETUP_TOKEN_PLACEHOLDER + "' sh"
    const harness = adminUiHarness(html, async (path) => {
      if (path === '/admin/status') return Response.json(statusFixture())
      if (path === '/admin/agent-versions') return Response.json({ tags: [], stale: false })
      if (path === '/admin/setup-tokens') return Response.json({ setupToken: 'setup_minted123', expiresAt: 1_700_000_100_000 })
      if (path.indexOf('/admin/installers/') === 0) return new Response(command, { status: 200, headers: { 'content-type': 'text/plain' } })
      return new Response('command', { status: 200, headers: { 'content-type': 'text/plain' } })
    }, { sessionToken: 'admin-secret' })
    harness.run()
    await harness.flush(10)

    // Before minting the command carries the placeholder, never a live token.
    expect(harness.byId('installer-output').textContent).toContain(SETUP_TOKEN_PLACEHOLDER)

    await harness.clickAction('setup-token-create', { out: 'setup-token-output' })
    await harness.flush(4)

    // The single minted token replaces the placeholder in the displayed command.
    const filled = harness.byId('installer-output').textContent
    expect(filled).toContain('setup_minted123')
    expect(filled).not.toContain(SETUP_TOKEN_PLACEHOLDER)
  })

  it('REQ-ADM-007 arms destructive controls and auto-disarms before submitting', async () => {
    const harness = await dashboardHarness()
    await harness.clickAction('status-refresh')
    const rotate = elementStub({ tagName: 'button', textContent: 'Rotate mesh secret' })
    rotate.dataset.action = 'mesh-rotate'
    rotate.dataset.confirm = 'Confirm rotation?'
    rotate.dataset.out = 'mesh-rotate-output'

    await harness.click(rotate)
    expect(rotate.dataset.armed).toBe('true')
    expect(rotate.textContent).toBe('Confirm rotation?')
    expect(harness.fetchCalls.filter((call) => call.path === '/admin/mesh/rotate')).toHaveLength(0)

    harness.runTimers()
    expect(rotate.dataset.armed).toBeUndefined()
    expect(rotate.textContent).toBe('Rotate mesh secret')
    expect(harness.fetchCalls.filter((call) => call.path === '/admin/mesh/rotate')).toHaveLength(0)

    await harness.click(rotate)
    expect(rotate.dataset.armed).toBe('true')
    await harness.click(rotate)
    expect(harness.fetchCalls.filter((call) => call.path === '/admin/mesh/rotate')).toHaveLength(1)
    expect(rotate.dataset.armed).toBeUndefined()
  })

  it('REQ-ADM-006 signs out and clears the stored admin token', async () => {
    const harness = await dashboardHarness()
    const eventsBefore = harness.events.length

    await harness.clickAction('sign-out')

    expect(harness.body.dataset.view).toBe('setup')
    const afterSignOut = harness.events.slice(eventsBefore)
    expect(afterSignOut.filter((event) => event.kind === 'removeItem').length).toBeGreaterThanOrEqual(2)

    const callsBefore = harness.fetchCalls.length
    await harness.clickAction('status-refresh')
    const call = harness.fetchCalls[callsBefore]!
    expect(call.path).toBe('/admin/status')
    expect(Object.keys((call.init?.headers ?? {}) as Record<string, string>)).not.toContain('authorization')
  })

  it('REQ-ADM-011 reveals created credentials once with copy affordances and advances the wizard', async () => {
    const html = adminUiHtml('https://router.test', { view: 'setup', phase: 'unclaimed', recovery: false })
    const harness = adminUiHarness(html, async (path) => {
      if (path === '/admin/setup') return Response.json({ adminToken: 'admin-a' }, { status: 201 })
      return Response.json({})
    })
    harness.run()
    expect(harness.body.dataset.view).toBe('setup')

    await harness.clickAction('first-run-setup', { out: 'setup-output' })
    const output = harness.byId('setup-output')
    expect(output.children[0]!.dataset.tokenWarning).toBe('true')
    const cards = output.children.filter((child) => child.dataset.tokenCard)
    expect(cards.map((card) => card.dataset.tokenCard)).toEqual(['Setup access token'])
    expect(cards[0]!.children.find((child) => child.dataset.copy)!.dataset.copy).toBe('admin-a')
    expect(harness.events.some((event) => event.kind === 'setItem' && event.detail === 'session:codeflareInferenceMeshAdminToken=admin-a')).toBe(true)
    expect(harness.byId('wizard-continue-connect').hidden).toBe(false)

    const next = elementStub({ tagName: 'button', textContent: 'Continue' })
    next.dataset.wizardNext = ''
    await harness.click(next)
    expect(harness.byId('step-domain').hidden).toBe(false)
    expect(harness.byId('step-connect').hidden).toBe(true)
    expect(harness.query('[data-step="connect"]').dataset.done).toBe('true')
  })
})
