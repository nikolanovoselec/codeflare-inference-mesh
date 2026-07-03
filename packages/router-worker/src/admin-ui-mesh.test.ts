import { describe, expect, it } from 'vitest'
import {
  ADMIN_UI_ACTIONS,
  ADMIN_UI_AGENT_VERSION,
  ADMIN_UI_COMMAND_CENTER,
  ADMIN_UI_MESH_HEALTH,
  ADMIN_UI_OPERATOR_FLOW,
  ADMIN_UI_PROFILE_ACTIVATION,
  adminUiHtml,
  createMeshUiRenderers
} from './admin-ui'
import type { ActivationProfileView, AgentVersionsView, MeshHealthEntry, MeshUiStatusNode } from './admin-ui'
import { DEFAULT_MODEL_PROFILES } from './profiles'

interface AdminUiConfigShape {
  readonly actions: typeof ADMIN_UI_ACTIONS
  readonly operatorFlow: typeof ADMIN_UI_OPERATOR_FLOW
  readonly commandCenter: typeof ADMIN_UI_COMMAND_CENTER
  readonly meshHealth: typeof ADMIN_UI_MESH_HEALTH
  readonly agentVersion: typeof ADMIN_UI_AGENT_VERSION
  readonly profileActivation: typeof ADMIN_UI_PROFILE_ACTIVATION
  readonly workerOrigin: string
}

function adminUiConfig(html: string): AdminUiConfigShape {
  const match = html.match(/<script type="application\/json" id="admin-ui-config">([^<]+)<\/script>/)
  expect(match).not.toBeNull()
  return JSON.parse(match![1]!) as AdminUiConfigShape
}

interface StubElement {
  readonly id: string
  value: string
  textContent: string
  innerHTML: string
  disabled: boolean
  hidden: boolean
  checked: boolean
  dataset: Record<string, string>
  attributes: Record<string, string>
  classList: {
    add: (...names: string[]) => void
    remove: (...names: string[]) => void
    toggle: (name: string, force?: boolean) => boolean
    contains: (name: string) => boolean
  }
  setAttribute: (name: string, value: string) => void
  addEventListener: (name: string, listener: unknown) => void
  querySelector: (selector: string) => StubElement | undefined
  closest: (selector: string) => StubElement | null
  focus: () => void
  scrollIntoView: () => void
}

function stubElement(id: string): StubElement {
  const classes = new Set<string>()
  const element: StubElement = {
    id,
    value: '',
    textContent: '',
    innerHTML: '',
    disabled: false,
    hidden: false,
    checked: false,
    dataset: {},
    attributes: {},
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      toggle: (name, force) => {
        const enabled = force ?? !classes.has(name)
        if (enabled) classes.add(name)
        else classes.delete(name)
        return enabled
      },
      contains: (name) => classes.has(name)
    },
    setAttribute: (name, value) => {
      element.attributes[name] = value
    },
    addEventListener: () => undefined,
    querySelector: () => undefined,
    closest: () => null,
    focus: () => undefined,
    scrollIntoView: () => undefined
  }
  return element
}

interface CapturedCall {
  readonly path: string
  readonly init?: RequestInit
}

function runAdminUi(fetchImpl: (path: string, init?: RequestInit) => Promise<Response>) {
  const html = adminUiHtml('https://router.test')
  const script = html.match(/<script>([\s\S]+)<\/script>\s*<\/body>/)![1]!
  const configText = html.match(/<script type="application\/json" id="admin-ui-config">([^<]+)<\/script>/)![1]!
  const elements = new Map<string, StubElement>()
  const byId = (id: string): StubElement => {
    let element = elements.get(id)
    if (!element) {
      element = stubElement(id)
      elements.set(id, element)
    }
    return element
  }
  byId('admin-ui-config').textContent = configText
  const listeners = new Map<string, (event: { target: StubElement }) => Promise<void>>()
  const documentStub = {
    getElementById: (id: string) => byId(id),
    querySelector: () => undefined,
    createElement: () => stubElement('created'),
    addEventListener: (name: string, listener: (event: { target: StubElement }) => Promise<void>) => listeners.set(name, listener)
  }
  const storage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined }
  const calls: CapturedCall[] = []
  const fetchStub = async (path: string, init?: RequestInit) => {
    calls.push({ path, ...(init === undefined ? {} : { init }) })
    return fetchImpl(path, init)
  }
  new Function('document', 'sessionStorage', 'localStorage', 'navigator', 'fetch', 'setTimeout', script)(
    documentStub,
    storage,
    storage,
    { clipboard: { writeText: async () => undefined } },
    fetchStub,
    () => 0
  )
  const click = async (action: string) => {
    const button = stubElement(`button-${action}`)
    button.dataset.action = action
    const scope = stubElement(`scope-${action}`)
    button.closest = (selector) => (selector === '[data-action]' ? button : selector === '[data-action-scope]' ? scope : null)
    await listeners.get('click')!({ target: button })
    return { button, scope }
  }
  return { byId, click, calls, html }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

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

describe('admin UI mesh operations contracts', () => {
  it('REQ-ADM-009 exposes mesh health, rotation, and activation controls', () => {
    // AdminMeshControlsSurfaceTestAnchor
    const html = adminUiHtml('https://router.test')
    const config = adminUiConfig(html)

    expect(config.actions).toEqual([...ADMIN_UI_ACTIONS])
    for (const id of ['profile-activate', 'agent-versions-refresh', 'agent-version-set', 'mesh-rotate']) {
      expect(config.actions.some((action) => action.id === id)).toBe(true)
    }
    expect(config.meshHealth).toEqual(ADMIN_UI_MESH_HEALTH)
    expect(config.agentVersion).toEqual(ADMIN_UI_AGENT_VERSION)
    expect(config.profileActivation).toEqual(ADMIN_UI_PROFILE_ACTIVATION)

    expect(ADMIN_UI_COMMAND_CENTER.rowOrder).toEqual(expect.arrayContaining(['profile-activate', 'agent-version', 'mesh-health', 'mesh-rotate']))
    const commandRows = [...html.matchAll(/data-row="([^"]+)"/g)].map((match) => match[1])
    expect(commandRows).toEqual([...ADMIN_UI_COMMAND_CENTER.rowOrder])
    expect(html).toMatch(/<section class="work-section" id="mesh" data-flow-stage="operate">/)
    expect(html.match(/data-panel-order="([^"]+)"/)?.[1]).toBe(ADMIN_UI_OPERATOR_FLOW.panelOrder.join(' '))

    for (const action of ['mesh-rotate', 'profile-activate', 'agent-versions-refresh', 'agent-version-set']) {
      expect(html).toContain(`data-action="${action}"`)
    }
    for (const kind of ['mesh-health', 'mesh-rotate', 'profile-activate', 'agent-version']) {
      expect(html).toContain(`data-output="${kind}"`)
    }

    expect(html).not.toContain('qwen36-35b-a3b-262k-text-3090')
    expect(html).toContain('placeholder="mesh-split-qwen36-35b"')
  })

  it('REQ-ADM-006 shows mesh invite tokens as presence, status, and age only', () => {
    // AdminMeshTokenRedactionTestAnchor
    const meshUi = createMeshUiRenderers()
    const poisoned = [
      {
        profileId: 'mesh-default-qwen36-35b',
        rotation: 5,
        coordinatorNodeId: 'node-coord',
        peerNodeIds: ['node-peer-a'],
        tokenCount: 2,
        secretAgeMs: 90_000,
        joinTokens: ['meshtok-SUPERSECRET-INVITE-42'],
        meshSecret: 'raw-SUPERSECRET-SEED-99'
      } as unknown as MeshHealthEntry,
      { profileId: 'mesh-split-qwen36-35b', rotation: 0, peerNodeIds: [], tokenCount: 0 } as MeshHealthEntry
    ]

    const panel = meshUi.renderMeshHealthPanel(poisoned, ADMIN_UI_MESH_HEALTH.fields)

    expect(panel).toMatch(/data-mesh-entry="mesh-default-qwen36-35b"[^>]*data-secret-present="true"/)
    expect(panel).toMatch(/data-mesh-entry="mesh-split-qwen36-35b"[^>]*data-secret-present="false"/)
    expect(panel).toMatch(/data-mesh-field="secret">[^<]*1m/)
    expect([...panel.matchAll(/data-mesh-field="secret">[^<]*\d+[smh]/g)]).toHaveLength(1)
    expect(panel).not.toContain('SUPERSECRET')
    expect(panel).not.toContain('meshtok-')
    expect(panel).not.toMatch(/data-mesh-field="secret">[^<]*\b2\b/)
  })

  it('REQ-ADM-009 wires the one-click rotate action to the mesh rotate endpoint', async () => {
    // AdminMeshRotateWiringTestAnchor
    expect(ADMIN_UI_ACTIONS.find((action) => action.id === 'mesh-rotate')).toEqual({
      id: 'mesh-rotate',
      method: 'POST',
      path: '/admin/mesh/rotate',
      auth: 'admin'
    })

    const html = adminUiHtml('https://router.test')
    expect(html).toMatch(/data-row="mesh-rotate"/)
    const rotateSelect = html.match(new RegExp(`<select[^>]*id="${ADMIN_UI_MESH_HEALTH.rotateSelectId}"[^>]*>[\\s\\S]*?</select>`))![0]!
    const rotateChoices = [...rotateSelect.matchAll(/data-profile-option="([^"]+)"/g)].map((match) => match[1])
    expect(rotateChoices).toEqual(DEFAULT_MODEL_PROFILES.map((profile) => profile.id))

    const harness = runAdminUi(async () => jsonResponse({ ok: true, rotation: 4 }))
    harness.byId(ADMIN_UI_MESH_HEALTH.rotateSelectId).value = 'mesh-default-qwen36-35b'
    const { scope } = await harness.click('mesh-rotate')

    expect(harness.calls).toHaveLength(1)
    const call = harness.calls[0]!
    expect(call.path).toBe('/admin/mesh/rotate')
    expect(call.init?.method).toBe('POST')
    expect(JSON.parse(String(call.init?.body))).toEqual({ profileId: 'mesh-default-qwen36-35b' })
    const headers = new Headers(call.init?.headers)
    expect(headers.get('content-type')).toBe('application/json')
    expect(headers.has('authorization')).toBe(true)
    expect(scope.dataset['state']).toBe('ready')
  })

  it('REQ-ADM-009 renders the profile activation selection control', async () => {
    // AdminProfileActivationControlTestAnchor
    expect(ADMIN_UI_ACTIONS.find((action) => action.id === 'profile-activate')).toEqual({
      id: 'profile-activate',
      method: 'POST',
      path: '/admin/profiles/activate',
      auth: 'admin'
    })

    const meshUi = createMeshUiRenderers()
    const fixture: readonly ActivationProfileView[] = [
      { id: 'pair-single', publicAliases: ['shared-alias', 'coder'], active: true, meshllm: { split: false } },
      { id: 'pair-split', publicAliases: ['shared-alias', 'coder'], active: false, meshllm: { split: true } },
      { id: 'solo-profile', publicAliases: ['solo-alias'], active: true, meshllm: { split: false } }
    ]
    const control = meshUi.renderProfileActivationControl(fixture, ADMIN_UI_PROFILE_ACTIVATION.selectId)
    const choices = [...control.matchAll(/data-profile-option="([^"]+)"/g)].map((match) => match[1])

    expect(control).toContain(`id="${ADMIN_UI_PROFILE_ACTIVATION.selectId}"`)
    expect(choices).toEqual(['pair-single', 'pair-split'])
    expect(control).toMatch(/data-profile-option="pair-single"[^>]*data-split="false"[^>]*selected/)
    expect(control).toMatch(/data-profile-option="pair-split"[^>]*data-split="true"/)
    expect(control).not.toMatch(/data-profile-option="pair-split"[^>]*selected/)

    const html = adminUiHtml('https://router.test')
    const servedControl = html.match(new RegExp(`<select[^>]*id="${ADMIN_UI_PROFILE_ACTIVATION.selectId}"[^>]*>[\\s\\S]*?</select>`))![0]!
    const servedChoices = [...servedControl.matchAll(/data-profile-option="([^"]+)"/g)].map((match) => match[1])
    expect(servedChoices).toEqual(['mesh-default-qwen36-35b', 'mesh-split-qwen36-35b'])
    expect(servedControl).not.toContain('mesh-smoke-qwen25-1.5b')
    expect(servedControl).toMatch(/data-profile-option="mesh-default-qwen36-35b"[^>]*selected/)

    const harness = runAdminUi(async () => jsonResponse({ ok: true }))
    harness.byId(ADMIN_UI_PROFILE_ACTIVATION.selectId).value = 'mesh-split-qwen36-35b'
    await harness.click('profile-activate')
    const call = harness.calls[0]!
    expect(call.path).toBe('/admin/profiles/activate')
    expect(call.init?.method).toBe('POST')
    expect(JSON.parse(String(call.init?.body))).toEqual({ profileId: 'mesh-split-qwen36-35b' })
  })

  it('REQ-ADM-008 renders the agent-version dropdown and per-node reported-versus-desired view', async () => {
    // AdminAgentVersionDropdownTestAnchor
    expect(ADMIN_UI_ACTIONS.find((action) => action.id === 'agent-versions-refresh')).toEqual({
      id: 'agent-versions-refresh',
      method: 'GET',
      path: '/admin/agent-versions',
      auth: 'admin'
    })
    expect(ADMIN_UI_ACTIONS.find((action) => action.id === 'agent-version-set')).toEqual({
      id: 'agent-version-set',
      method: 'POST',
      path: '/admin/agent-version',
      auth: 'admin'
    })

    const meshUi = createMeshUiRenderers()
    const view: AgentVersionsView = { tags: ['v1.4.0', 'v1.3.0', 'v1.2.0'], fetchedAt: 1_700_000_000_000, stale: true, desired: 'v1.3.0' }
    const select = meshUi.renderAgentVersionSelect(view, ADMIN_UI_AGENT_VERSION.selectId)
    const options = [...select.matchAll(/data-agent-version-option="([^"]+)"/g)].map((match) => match[1])

    expect(options).toEqual(['v1.4.0', 'v1.3.0', 'v1.2.0'])
    expect(select).toMatch(new RegExp(`<select[^>]*id="${ADMIN_UI_AGENT_VERSION.selectId}"[^>]*${ADMIN_UI_AGENT_VERSION.staleAttribute}="true"`))
    expect(select).toMatch(/data-agent-version-option="v1\.3\.0"[^>]*data-desired="true"[^>]*selected/)
    expect([...select.matchAll(/ selected/g)]).toHaveLength(1)

    const fresh = meshUi.renderAgentVersionSelect({ tags: ['v1.4.0'], stale: false }, ADMIN_UI_AGENT_VERSION.selectId)
    expect(fresh).toContain(`${ADMIN_UI_AGENT_VERSION.staleAttribute}="false"`)
    expect(fresh).not.toMatch(/ selected/)

    const empty = meshUi.renderAgentVersionSelect({ tags: [], stale: false }, ADMIN_UI_AGENT_VERSION.selectId)
    expect(empty).toMatch(/<select[^>]* disabled>/)
    expect(empty).not.toContain('data-agent-version-option')

    const nodeRows = meshUi.renderNodeAgentVersions(
      [{ id: 'node-current', agentVersion: 'v1.3.0' }, { id: 'node-behind', agentVersion: 'v1.2.0' }, { id: 'node-silent' }],
      'v1.3.0'
    )
    expect(nodeRows).toContain('data-desired-version="v1.3.0"')
    expect([...nodeRows.matchAll(/data-node-version="/g)]).toHaveLength(3)
    expect(nodeRows).toMatch(/data-node-version="node-current"[^>]*data-reported="v1\.3\.0"[^>]*data-desired-match="true"/)
    expect(nodeRows).toMatch(/data-node-version="node-behind"[^>]*data-reported="v1\.2\.0"[^>]*data-desired-match="false"/)
    expect(nodeRows).toMatch(/data-node-version="node-silent"[^>]*data-reported="unreported"[^>]*data-desired-match="false"/)

    const html = adminUiHtml('https://router.test')
    expect(html).toMatch(new RegExp(`<select[^>]*id="${ADMIN_UI_AGENT_VERSION.selectId}"[^>]*disabled>`))

    const harness = runAdminUi(async (path) =>
      path === '/admin/agent-versions'
        ? jsonResponse({ tags: ['v1.4.0', 'v1.3.0'], fetchedAt: 1, stale: true, desired: 'v1.3.0' })
        : jsonResponse({ ok: true })
    )
    await harness.click('agent-versions-refresh')
    expect(harness.calls[0]!.path).toBe('/admin/agent-versions')
    expect(harness.calls[0]!.init?.method).toBeUndefined()
    const slotHtml = harness.byId(ADMIN_UI_AGENT_VERSION.slotId).innerHTML
    expect([...slotHtml.matchAll(/data-agent-version-option="/g)]).toHaveLength(2)
    expect(slotHtml).toContain(`${ADMIN_UI_AGENT_VERSION.staleAttribute}="true"`)

    harness.byId(ADMIN_UI_AGENT_VERSION.selectId).value = 'v1.4.0'
    await harness.click('agent-version-set')
    const setCall = harness.calls[1]!
    expect(setCall.path).toBe('/admin/agent-version')
    expect(setCall.init?.method).toBe('POST')
    expect(JSON.parse(String(setCall.init?.body))).toEqual({ version: 'v1.4.0' })
  })

  it('REQ-SEC-006 surfaces mesh_state_key_missing as an admin status banner', async () => {
    // AdminMeshKeyMissingBannerTestAnchor
    const html = adminUiHtml('https://router.test')
    expect(html).toMatch(new RegExp(`<div class="setup-banner" id="${ADMIN_UI_MESH_HEALTH.bannerId}"[^>]*hidden>`))

    const healthyEntry: MeshHealthEntry = { profileId: 'mesh-default-qwen36-35b', rotation: 0, peerNodeIds: [], readyModels: [], failedNodeIds: [], tokenCount: 0 }
    const statusBody = { nodes: [], profiles: DEFAULT_MODEL_PROFILES, profileReadiness: [], audit: [], generatedAt: 1 }
    let meshHealth: readonly MeshHealthEntry[] = [healthyEntry]
    const harness = runAdminUi(async () => jsonResponse({ ...statusBody, meshHealth }))

    await harness.click('status-refresh')
    expect(harness.byId(ADMIN_UI_MESH_HEALTH.bannerId).hidden).toBe(true)

    meshHealth = [{ ...healthyEntry, lastError: ADMIN_UI_MESH_HEALTH.keyMissingError }]
    await harness.click('status-refresh')
    expect(harness.byId(ADMIN_UI_MESH_HEALTH.bannerId).hidden).toBe(false)

    meshHealth = [healthyEntry]
    await harness.click('status-refresh')
    expect(harness.byId(ADMIN_UI_MESH_HEALTH.bannerId).hidden).toBe(true)
  })

  it('REQ-OBS-007 renders the mesh health panel from admin status data', async () => {
    // AdminMeshHealthPanelTestAnchor
    const meshUi = createMeshUiRenderers()
    const panel = meshUi.renderMeshHealthPanel(meshEntries, ADMIN_UI_MESH_HEALTH.fields)

    const entryIds = [...panel.matchAll(/data-mesh-entry="([^"]+)"/g)].map((match) => match[1])
    expect(entryIds).toEqual(['mesh-default-qwen36-35b', 'mesh-split-qwen36-35b'])
    const fieldSequence = [...panel.matchAll(/data-mesh-field="([^"]+)"/g)].map((match) => match[1])
    expect(fieldSequence).toEqual([...ADMIN_UI_MESH_HEALTH.fields, ...ADMIN_UI_MESH_HEALTH.fields])

    expect(panel).toMatch(/data-mesh-entry="mesh-default-qwen36-35b"[^>]*data-mesh-rotation="3"/)
    expect(panel).toMatch(/data-mesh-field="coordinator">[^<]*node-coord/)
    expect(panel).toMatch(/data-mesh-field="peers">[^<]*\b2\b/)
    expect(panel).toMatch(/data-mesh-field="ready-models">[^<]*qwen3\.6:35b-a3b/)
    expect(panel).not.toContain('outside-model')
    expect(panel).toMatch(/data-mesh-field="failed-nodes">[^<]*node-peer-b/)
    expect(panel).toMatch(/data-mesh-field="last-error">[^<]*node-peer-b: mesh runner exited/)
    expect(panel).toMatch(/data-mesh-field="rotation">[^<]*r3\b/)
    expect(panel).toMatch(/data-mesh-entry="mesh-split-qwen36-35b"[^>]*data-mesh-rotation="0"/)
    expect(meshUi.renderMeshHealthPanel([], ADMIN_UI_MESH_HEALTH.fields)).toBe('')

    const statusBody = {
      nodes: meshNodes,
      profiles: DEFAULT_MODEL_PROFILES,
      profileReadiness: [],
      audit: [],
      meshHealth: meshEntries,
      desiredAgentVersion: 'v1.3.0',
      generatedAt: 1
    }
    const harness = runAdminUi(async () => jsonResponse(statusBody))
    const { scope } = await harness.click('status-refresh')

    expect(scope.dataset['state']).toBe('ready')
    const panelHtml = harness.byId(ADMIN_UI_MESH_HEALTH.panelId).innerHTML
    expect([...panelHtml.matchAll(/data-mesh-entry="/g)]).toHaveLength(2)
    const statusHtml = harness.byId('status-output').innerHTML
    expect(statusHtml).toContain('data-node-versions="true"')
    expect(statusHtml).toContain('data-desired-version="v1.3.0"')
    const activationHtml = harness.byId(ADMIN_UI_PROFILE_ACTIVATION.slotId).innerHTML
    expect([...activationHtml.matchAll(/data-profile-option="/g)]).toHaveLength(2)
  })
})
