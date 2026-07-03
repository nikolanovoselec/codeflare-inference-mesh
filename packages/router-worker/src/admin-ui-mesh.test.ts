import { describe, expect, it } from 'vitest'
import { ADMIN_UI_AGENT_VERSION, ADMIN_UI_MESH_HEALTH, ADMIN_UI_NODES_TABLE, ADMIN_UI_PROFILE_ACTIVATION, adminUiHtml } from './admin-ui'
import type { MeshHealthEntry, MeshUiStatusNode } from './admin-ui'
import { adminUiHarness, descendants, elementStub, type AdminUiHarness, type StubElement } from './admin-ui-harness'

const meshNodes: readonly MeshUiStatusNode[] = [
  { id: 'node-coord', status: 'online', agentVersion: 'v1.3.0', metrics: { runtimeState: 'running', readyModels: ['qwen3.6:35b-a3b', 'mesh-default'] } },
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
    readyModels: ['qwen3.6:35b-a3b', 'mesh-default'],
    failedNodeIds: ['node-peer-b'],
    tokenCount: 2,
    secretAgeMs: 300_000,
    lastError: 'node-peer-b: mesh runner exited'
  },
  { profileId: 'mesh-split-qwen36-35b', rotation: 0, peerNodeIds: [], readyModels: [], failedNodeIds: [], tokenCount: 0 }
]

const statusProfiles = [
  { id: 'mesh-default-qwen36-35b', publicAliases: ['mesh-default', 'qwen3.6:35b-a3b'], active: true, rolloutPercent: 100, meshllm: { split: false } },
  { id: 'mesh-split-qwen36-35b', publicAliases: ['mesh-default', 'qwen3.6:35b-a3b'], active: false, rolloutPercent: 100, meshllm: { split: true } },
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
    gateway: { gatewayId: 'inference-mesh', routeName: 'mesh-default', publicModel: 'mesh-default' },
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

function meshCard(harness: AdminUiHarness, profileId: string): StubElement {
  const panel = harness.byId(ADMIN_UI_MESH_HEALTH.panelId)
  const card = panel.children.find((child) => child.dataset.meshEntry === profileId)
  expect(card, `no mesh card for ${profileId}`).toBeDefined()
  return card!
}

function meshField(card: StubElement, field: string): StubElement {
  const line = descendants(card).find((node) => node.dataset.meshField === field)
  expect(line, `no mesh field ${field}`).toBeDefined()
  return line!
}

describe('admin UI mesh operations contracts', () => {
  it('REQ-ADM-009 exposes mesh health, rotation, and activation controls', () => {
    const html = adminUiHtml('https://router.test', { view: 'dashboard', phase: 'complete', recovery: false })
    expect(html).toContain(`id="${ADMIN_UI_MESH_HEALTH.panelId}"`)
    expect(html).toContain('data-mesh-key-banner="true"')
    expect(html).toContain(`id="${ADMIN_UI_MESH_HEALTH.rotateSelectId}"`)
    expect(html).toContain('data-mesh-profile-select="true"')
    expect(html).toContain(`id="${ADMIN_UI_PROFILE_ACTIVATION.selectId}"`)
    expect(html).toContain('data-profile-activate-select="true"')
    expect(html).toContain(`id="${ADMIN_UI_AGENT_VERSION.selectId}"`)
    expect(html).toMatch(/data-action="mesh-rotate" [^>]*data-confirm="[^"]+"/)
    expect(html).toContain('data-action="profile-activate"')
    expect(html).toContain('data-action="profile-rollout"')
    expect(html).toContain('data-action="agent-versions-refresh"')
    expect(html).toContain('data-action="agent-version-set"')
    expect([...html.matchAll(/data-action="status-refresh"/g)].length).toBeGreaterThanOrEqual(3)
  })

  it('REQ-ADM-006 shows mesh invite tokens as presence, status, and age only', async () => {
    const harness = await dashboardHarness()
    await harness.clickAction('status-refresh')

    const present = meshCard(harness, 'mesh-default-qwen36-35b')
    const absent = meshCard(harness, 'mesh-split-qwen36-35b')
    expect(present.dataset.secretPresent).toBe('true')
    expect(meshField(present, 'secret').textContent).toBe('secret: present · 5m')
    expect(absent.dataset.secretPresent).toBe('false')
    expect(meshField(absent, 'secret').textContent).toBe('secret: absent')
    const renderedFields = descendants(present).map((node) => node.dataset.meshField).filter(Boolean)
    expect(renderedFields).toEqual([...ADMIN_UI_MESH_HEALTH.fields])
  })

  it('REQ-ADM-009 wires the one-click rotate action to the mesh rotate endpoint', async () => {
    const harness = await dashboardHarness()
    await harness.clickAction('status-refresh')
    const rotateSelect = harness.byId(ADMIN_UI_MESH_HEALTH.rotateSelectId)
    expect(rotateSelect.value).toBe('mesh-default-qwen36-35b')

    const rotate = elementStub({ tagName: 'button', textContent: 'Rotate mesh secret' })
    rotate.dataset.action = 'mesh-rotate'
    rotate.dataset.confirm = 'Confirm rotation?'
    rotate.dataset.out = 'mesh-rotate-output'
    await harness.click(rotate)
    expect(harness.fetchCalls.filter((call) => call.path === '/admin/mesh/rotate')).toHaveLength(0)
    await harness.click(rotate)

    const call = harness.fetchCalls.find((item) => item.path === '/admin/mesh/rotate')
    expect(call).toBeDefined()
    expect(call!.init?.method).toBe('POST')
    expect(call!.init?.headers).toMatchObject({ authorization: 'Bearer admin-secret', 'content-type': 'application/json' })
    expect(JSON.parse(String(call!.init?.body))).toEqual({ profileId: 'mesh-default-qwen36-35b' })
    expect(JSON.parse(harness.byId('mesh-rotate-output').textContent) as { rotation: number }).toMatchObject({ rotation: 4 })
  })

  it('REQ-ADM-009 renders the profile activation selection control', async () => {
    const harness = await dashboardHarness()
    await harness.clickAction('status-refresh')

    const slot = harness.byId(ADMIN_UI_PROFILE_ACTIVATION.slotId)
    const select = slot.children[0]!
    expect(select.dataset.profileActivateSelect).toBe('true')
    expect(select.disabled).toBe(false)
    const options = select.children.map((option) => option.dataset.profileOption)
    expect(options).toEqual(['mesh-default-qwen36-35b', 'mesh-split-qwen36-35b'])
    expect(select.children.map((option) => option.dataset.split)).toEqual(['false', 'true'])
    expect(select.value).toBe('mesh-default-qwen36-35b')

    expect(harness.byId(ADMIN_UI_PROFILE_ACTIVATION.selectId)).toBe(select)
    select.value = 'mesh-split-qwen36-35b'
    await harness.clickAction('profile-activate', { out: 'profile-activate-output' })
    const call = harness.fetchCalls.find((item) => item.path === '/admin/profiles/activate')
    expect(call).toBeDefined()
    expect(JSON.parse(String(call!.init?.body))).toEqual({ profileId: 'mesh-split-qwen36-35b' })
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
    const revokeButtons = rowNodes.filter((node) => node.dataset.action === 'node-revoke')
    expect(revokeButtons).toHaveLength(meshNodes.length)
    revokeButtons.forEach((button) => expect(button.dataset.confirm, 'revoke must arm before submitting').toBeTruthy())
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

  it('REQ-OBS-007 renders the mesh health panel from admin status data', async () => {
    const harness = await dashboardHarness()
    await harness.clickAction('status-refresh')

    const card = meshCard(harness, 'mesh-default-qwen36-35b')
    expect(card.dataset.meshRotation).toBe('3')
    expect(meshField(card, 'coordinator').textContent).toBe('coordinator: node-coord')
    expect(meshField(card, 'peers').textContent).toBe('peers: 2')
    expect(meshField(card, 'ready-models').textContent).toBe('ready models: qwen3.6:35b-a3b, mesh-default')
    expect(meshField(card, 'failed-nodes').textContent).toBe('failed nodes: node-peer-b')
    expect(meshField(card, 'last-error').textContent).toBe('last error: node-peer-b: mesh runner exited')
    expect(meshField(card, 'rotation').textContent).toBe('rotation: r3')
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
      if (path === '/admin/setup') return Response.json({ adminToken: 'admin-a', providerToken: 'provider-a', setupToken: 'setup-a', upstreamToken: 'upstream-a', byokInstruction: 'Paste providerToken as the AI Gateway custom provider API key.' }, { status: 201 })
      return Response.json({})
    })
    harness.run()
    expect(harness.body.dataset.view).toBe('setup')

    await harness.clickAction('first-run-setup', { out: 'setup-output' })
    const output = harness.byId('setup-output')
    expect(output.children[0]!.dataset.tokenWarning).toBe('true')
    const cards = output.children.filter((child) => child.dataset.tokenCard)
    expect(cards.map((card) => card.dataset.tokenCard)).toEqual(['providerToken', 'setupToken', 'upstreamToken'])
    cards.forEach((card) => {
      const copy = card.children.find((child) => child.dataset.copy)
      expect(copy, `token card ${card.dataset.tokenCard} has no copy control`).toBeDefined()
    })
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
