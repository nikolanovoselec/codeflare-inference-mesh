import { describe, expect, it } from 'vitest'
import { ADMIN_UI_ACTIONS, ADMIN_UI_CONFIRM, ADMIN_UI_NAV, ADMIN_UI_RESPONSIVE, ADMIN_UI_SETUP_LOCKED_FEEDBACK, ADMIN_UI_VIEWS, ADMIN_UI_WIZARD } from './admin-ui'
import { ADMIN_UI_CLIENT_SCRIPT } from './admin-ui-client'
import { adminUiHarness, elementStub } from './admin-ui-harness'
import { resetJwksCache } from './access'
import { createTokenRecord, hashToken, timingSafeEqualText } from './auth'
import { CloudflareGatewayClient } from './cloudflare-api'
import { installerPlan } from './installers'
import { DEFAULT_MODEL_PROFILES } from './profiles'
import { createRouter } from './router'
import { isSafeMeshTarget, StoreScheduler } from './scheduler'
import { accessJwksFetcher, accessTestKey, MemoryStore, nodeFixture, signAccessJwt } from './test-helpers'
import type { ModelProfile, NodeRecord } from './types'

function makeMesh(capture: { request?: Request } = {}): Fetcher {
  return {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      capture.request = new Request(input, init)
      return new Response(JSON.stringify({ id: 'chatcmpl-test', model: 'upstream' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
  } as Fetcher
}

function routerFixture(overrides: Partial<Parameters<typeof createRouter>[0]> = {}) {
  const store = overrides.store ?? new MemoryStore()
  const scheduler = overrides.scheduler ?? new StoreScheduler(store, () => 'reservation-a')
  const mesh = overrides.mesh ?? makeMesh()
  return {
    store: store as MemoryStore,
    router: createRouter({
      store,
      scheduler,
      mesh,
      now: overrides.now ?? (() => 1_700_000_000_000),
      requestId: overrides.requestId ?? (() => 'request-a'),
      env: {
        ROUTER_PROVIDER_TOKEN: 'provider-secret',
        ADMIN_TOKEN: 'admin-secret',
        NODE_UPSTREAM_TOKEN: 'upstream-secret',
        WORKER_BASE_URL: 'https://router.example.workers.dev',
        GITHUB_REPOSITORY: 'nikolanovoselec/codeflare-inference-mesh',
        MAX_REQUEST_BYTES: '4096',
        ...overrides.env
      },
      ...(overrides.cloudflareClient !== undefined ? { cloudflareClient: overrides.cloudflareClient } : {}),
      ...(overrides.releasesFetcher !== undefined ? { releasesFetcher: overrides.releasesFetcher } : {}),
      ...(overrides.accessClient !== undefined ? { accessClient: overrides.accessClient } : {}),
      ...(overrides.jwksFetcher !== undefined ? { jwksFetcher: overrides.jwksFetcher } : {})
    })
  }
}

function bearer(token: string): HeadersInit {
  return { authorization: `Bearer ${token}` }
}

const QWEN_UPSTREAM = 'unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ3_S'
const MESH_STATE_KEY_B64 = `${'A'.repeat(43)}=`

function legacyRuntimeProfile(input: { id: string; publicAliases: readonly string[]; version: number }): ModelProfile {
  return {
    id: input.id,
    publicAliases: input.publicAliases,
    upstreamModel: input.id,
    sourceMode: 'legacy-source',
    contextWindow: 262144,
    runtime: 'legacy-runtime',
    version: input.version,
    rolloutPercent: 100,
    active: true
  } as unknown as ModelProfile
}

function githubReleasesFetcher(tags: readonly string[]): typeof fetch {
  return (async () => Response.json(tags.map((tag) => ({ tag_name: tag })))) as typeof fetch
}

function heartbeatBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    nodeId: 'node-a',
    displayName: 'Node A',
    meshIp: '100.64.1.10',
    inferencePort: 8080,
    localDashboardPort: 17777,
    status: 'online',
    publicModels: ['mesh-default'],
    activeProfileIds: ['mesh-default-qwen36-35b'],
    capacity: 2,
    inFlight: 0,
    runtime: 'meshllm',
    metrics: { runtimeState: 'ready', activeRequests: 0, apiReady: true, readyModels: [QWEN_UPSTREAM] },
    ...overrides
  })
}

function valuesOf(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(valuesOf)
  if (value && typeof value === 'object') return Object.values(value).flatMap(valuesOf)
  return []
}

interface AdminUiTestConfig {
  readonly actions: typeof ADMIN_UI_ACTIONS
  readonly responsive: typeof ADMIN_UI_RESPONSIVE
  readonly views: typeof ADMIN_UI_VIEWS
  readonly nav: typeof ADMIN_UI_NAV
  readonly wizard: typeof ADMIN_UI_WIZARD
  readonly confirm: typeof ADMIN_UI_CONFIRM
  readonly setupLockedFeedback: typeof ADMIN_UI_SETUP_LOCKED_FEEDBACK
  readonly workerOrigin: string
}

function adminUiConfig(html: string): AdminUiTestConfig {
  const match = html.match(/<script type="application\/json" id="admin-ui-config">([^<]+)<\/script>/)
  expect(match).not.toBeNull()
  expect(match![1]).not.toContain('&quot;')
  return JSON.parse(match![1]!) as AdminUiTestConfig
}

function adminUiScript(html: string): string {
  const match = html.match(/<script>([\s\S]+)<\/script>\s*<\/body>/)
  expect(match).not.toBeNull()
  return match![1]!
}


describe('router worker behavioral contracts', () => {
  it('REQ-ADM-006 serves a responsive browser admin UI for every admin-facing function', async () => {
    // AdminConfigurationUiTestAnchor
    const { router } = routerFixture()
    const root = await router(new Request('https://router.test/'))
    const admin = await router(new Request('https://router.test/admin'))
    const head = await router(new Request('https://router.test/', { method: 'HEAD' }))
    const html = await admin.text()
    const config = adminUiConfig(html)
    const actionIds = config.actions.map((action) => action.id)

    expect(root.status).toBe(200)
    expect(admin.status).toBe(200)
    expect(head.status).toBe(200)
    expect(head.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(admin.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(admin.headers.get('content-security-policy')).toBe("frame-ancestors 'none'")
    expect(admin.headers.get('x-frame-options')).toBe('DENY')
    expect(config.workerOrigin).toBe('https://router.test')
    expect(actionIds).toEqual([
      'first-run-setup',
      'admin-login',
      'status-refresh',
      'setup-token-create',
      'installer-linux',
      'installer-macos',
      'installer-windows',
      'gateway-sync',
      'custom-domain-validate',
      'node-revoke',
      'profile-rollout',
      'profile-activate',
      'agent-versions-refresh',
      'agent-version-set',
      'mesh-rotate'
    ])
    expect(config.actions.filter((action) => action.auth === 'admin').map((action) => action.path)).toEqual([
      '/admin/login',
      '/admin/status',
      '/admin/setup-tokens',
      '/admin/installers/linux',
      '/admin/installers/macos',
      '/admin/installers/windows',
      '/admin/cloudflare/gateway/sync',
      '/admin/custom-domain/validate',
      '/admin/nodes/{nodeId}/revoke',
      '/admin/profiles/rollout',
      '/admin/profiles/activate',
      '/admin/agent-versions',
      '/admin/agent-version',
      '/admin/mesh/rotate'
    ])
    expect(config.responsive).toEqual({ mobileBreakpointPx: 760, desktopMinColumns: 1, minTouchTargetPx: 44 })
    expect(config.views).toEqual({ modes: ['setup', 'login', 'dashboard'], attribute: 'data-view' })
    expect(config.nav).toEqual({ sections: ['overview', 'nodes', 'models', 'routing', 'mesh', 'settings'], mobileTabs: ['overview', 'nodes', 'mesh', 'more'], moreSections: ['models', 'routing', 'settings'] })
    expect(config.wizard).toEqual({ steps: ['credentials', 'gateway', 'node', 'review'], skippable: ['gateway', 'node'] })
    expect(config.confirm).toEqual({ attribute: 'data-confirm', disarmMs: 5000 })
    expect(config.setupLockedFeedback).toEqual({ status: 401, variant: 'setup-locked' })
    const controls = new Set([...html.matchAll(/data-action="([^"]+)"/g)].map((match) => match[1]))
    const serverControls = ['first-run-setup', 'status-refresh', 'setup-token-create', 'installer-generate', 'gateway-sync', 'custom-domain-validate', 'profile-rollout', 'profile-activate', 'agent-versions-refresh', 'agent-version-set', 'mesh-rotate', 'sign-out', 'wizard-finish']
    serverControls.forEach((action) => expect(controls.has(action), `missing control ${action}`).toBe(true))
    expect(html).toContain('data-login-form="true"')
    expect(html).toContain('data-installer-platform="true"')
    expect([...html.matchAll(/name="zoneId"/g)]).toHaveLength(1)
    expect([...html.matchAll(/id="(?:wiz-)?gateway-(?:account-id|id|route-name|public-model|provider-name|worker-url)"/g)]).toHaveLength(12)
    const liveOutputSurfaces = [...html.matchAll(/data-output="[^"]+"[^>]*role="log"[^>]*aria-live="polite"/g)]
    expect(liveOutputSurfaces.length).toBeGreaterThanOrEqual(12)
    expect(html).toMatch(/<meta name="viewport" content="width=device-width, initial-scale=1">/)
    expect(html).toMatch(/<meta name="color-scheme" content="dark">/)
    expect(html).toMatch(/<link rel="icon" href="data:image\/svg\+xml/)
    expect(html).toContain('<noscript>')
    expect(html).toMatch(/@media \(max-width:760px\)/)
    expect(html).toContain('class="tab-bar"')
    // The served behavior script is the pure literal, byte for byte: nothing is
    // serialized from bundled code, so bundler helpers (__name) cannot leak in.
    expect(adminUiScript(html)).toBe(ADMIN_UI_CLIENT_SCRIPT)
    expect(html).not.toContain('__name')
    expect(() => new Function(adminUiScript(html))).not.toThrow()
  })

  it('REQ-ADM-007 pre-renders the entry view from stored setup state', async () => {
    // AdminEntryViewTestAnchor
    const { router } = routerFixture()
    const fresh = await (await router(new Request('https://router.test/'))).text()
    expect(fresh).toContain('<body data-view="setup">')
    expect(fresh).not.toMatch(/id="view-setup"[^>]*hidden/)
    expect(fresh).toMatch(/id="view-login"[^>]*hidden/)
    expect(fresh).toMatch(/id="view-dashboard" hidden/)

    const setup = await router(new Request('https://router.test/admin/setup', { method: 'POST' }))
    expect(setup.status).toBe(201)
    const locked = await (await router(new Request('https://router.test/'))).text()
    expect(locked).toContain('<body data-view="login">')
    expect(locked).toMatch(/id="view-setup"[^>]*hidden/)
    expect(locked).not.toMatch(/id="view-login"[^>]*hidden/)
    expect(locked).toMatch(/id="view-dashboard" hidden/)
  })

  it('REQ-ADM-007 serves a sectioned operator dashboard with persistent navigation', async () => {
    // AdminDashboardNavTestAnchor
    const { router } = routerFixture()
    const html = await (await router(new Request('https://router.test/admin'))).text()
    const config = adminUiConfig(html)
    const sections = [...html.matchAll(/data-section="([^"]+)"/g)].map((match) => match[1])
    const navTargets = [...html.matchAll(/class="nav-item" href="#([^"]+)"/g)].map((match) => match[1])
    const sectionIds = new Set([...html.matchAll(/<section class="panel section-panel" id="([^"]+)"/g)].map((match) => match[1]))

    expect(sections).toEqual(['overview', 'nodes', 'models', 'routing', 'mesh', 'settings'])
    expect([...config.nav.sections]).toEqual(sections)
    expect(navTargets.slice(0, 6)).toEqual(sections)
    expect(navTargets.slice(6)).toEqual(['models', 'routing', 'settings'])
    expect(navTargets.every((target) => sectionIds.has(target))).toBe(true)
    expect(html.match(/data-mobile-tabs="([^"]+)"/)?.[1]).toBe('overview nodes mesh more')
    expect([...html.matchAll(/<button class="tab-item"[^>]*data-tab="([^"]+)"/g)].map((match) => match[1])).toEqual(['overview', 'nodes', 'mesh', 'more'])
    expect([...html.matchAll(/data-active="true"/g)]).toHaveLength(1)
    expect(html).toMatch(/data-nav="overview" aria-current="page"/)
    expect(html.match(/data-more-sections="([^"]+)"/)?.[1]).toBe('models routing settings')
  })

  it('REQ-ADM-007 labels every dashboard control visibly', async () => {
    // AdminLabeledControlsTestAnchor
    const { router } = routerFixture()
    const html = await (await router(new Request('https://router.test/admin'))).text()
    const controlIds = [...html.matchAll(/<(?:input|select)[^>]*\bid="([^"]+)"/g)].map((match) => match[1]!)
    const labelled = new Set([...html.matchAll(/<label for="([^"]+)">/g)].map((match) => match[1]!))
    const wrappedInLabel = new Set(['remember-token'])

    expect(controlIds.length).toBeGreaterThan(15)
    controlIds
      .filter((id) => !wrappedInLabel.has(id))
      .forEach((id) => expect(labelled.has(id), `control #${id} has no visible label`).toBe(true))
  })

  it('REQ-ADM-011 renders the setup wizard with its step sequence while setup is open', async () => {
    // AdminSetupWizardTestAnchor
    const { router } = routerFixture()
    const html = await (await router(new Request('https://router.test/'))).text()

    expect(html.match(/data-wizard="([^"]+)"/)?.[1]).toBe('credentials gateway node review')
    expect([...html.matchAll(/<li data-step="([^"]+)"/g)].map((match) => match[1])).toEqual(['credentials', 'gateway', 'node', 'review'])
    expect(html).toMatch(/<li data-step="credentials" aria-current="step">/)
    expect([...html.matchAll(/data-step-panel="([^"]+)"/g)].map((match) => match[1])).toEqual(['credentials', 'gateway', 'node', 'review'])
    expect(html).not.toMatch(/data-step-panel="credentials"[^>]*hidden/)
    expect(html).toMatch(/data-step-panel="gateway"[^>]*hidden/)
    expect(html).toMatch(/data-step-panel="node"[^>]*hidden/)
    expect(html).toMatch(/data-step-panel="review"[^>]*hidden/)
    const gatewayStep = html.slice(html.indexOf('id="step-gateway"'), html.indexOf('id="step-node"'))
    const nodeStep = html.slice(html.indexOf('id="step-node"'), html.indexOf('id="step-review"'))
    const reviewStep = html.slice(html.indexOf('id="step-review"'))
    expect(gatewayStep).toContain('data-wizard-next')
    expect(nodeStep).toContain('data-wizard-next')
    expect(html).toMatch(/id="wizard-continue-credentials" hidden/)
    expect(html).toContain('data-goto-login')
    expect(reviewStep).toContain('data-action="wizard-finish"')
  })

  it('REQ-ADM-007 renders setup-locked recovery affordances instead of raw JSON', async () => {
    // AdminSetupLockedFeedbackTestAnchor
    const { router } = routerFixture()
    const html = await (await router(new Request('https://router.test/admin'))).text()
    const harness = adminUiHarness(html, async () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } }))
    harness.run()

    const button = await harness.clickAction('first-run-setup', { out: 'setup-output' })
    const output = harness.byId('setup-output')
    const toast = harness.byId('toast')
    const dismiss = toast.children.find((child) => child.dataset.toastDismiss === 'true')
    dismiss?.listeners.get('click')?.()

    expect(output.dataset.feedback).toBe('setup-locked')
    expect(output.classList.contains('is-error')).toBe(true)
    expect(output.textContent.length).toBeGreaterThan(0)
    expect(output.textContent).not.toMatch(/^\{/)
    expect(toast.classList.contains('is-error')).toBe(true)
    expect(toast.classList.contains('show')).toBe(false)
    expect(harness.timers.at(-1)?.delay).toBe(8000)
    expect(button.attributes['aria-busy']).toBe('false')
    expect(button.disabled).toBe(false)
  })

  it('REQ-GWY-003 sends selected Gateway account from the Admin UI', async () => {
    const { router } = routerFixture()
    const html = await (await router(new Request('https://router.test/admin'))).text()
    const harness = adminUiHarness(html, async () => Response.json({ deploymentId: 'deployment-a' }), { sessionToken: 'admin-secret' })
    harness.run()
    harness.byId('gateway-account-id').value = ' account-admin '
    harness.byId('gateway-id').value = 'gateway-admin'
    harness.byId('gateway-route-name').value = 'mesh-admin'
    harness.byId('gateway-public-model').value = 'mesh-smoke'
    harness.byId('gateway-provider-name').value = 'provider-admin'
    harness.byId('gateway-worker-url').value = 'https://router.example.workers.dev'

    await harness.clickAction('gateway-sync', { out: 'gateway-output' })

    expect(harness.fetchCalls).toHaveLength(1)
    expect(harness.fetchCalls[0]!.path).toBe('/admin/cloudflare/gateway/sync')
    expect(harness.fetchCalls[0]!.init?.method).toBe('POST')
    expect(harness.fetchCalls[0]!.init?.headers).toMatchObject({ authorization: 'Bearer admin-secret', 'content-type': 'application/json' })
    expect(JSON.parse(String(harness.fetchCalls[0]!.init?.body))).toEqual({ accountId: 'account-admin', gatewayId: 'gateway-admin', routeName: 'mesh-admin', publicModel: 'mesh-smoke', providerName: 'provider-admin', workerUrl: 'https://router.example.workers.dev' })
    expect(JSON.parse(harness.byId('gateway-output').textContent) as { deploymentId: string }).toEqual({ deploymentId: 'deployment-a' })
  })

  it('REQ-SEC-002 asks for confirmation before revoking a node from the Admin UI', async () => {
    const { router } = routerFixture()
    const html = await (await router(new Request('https://router.test/admin'))).text()
    const harness = adminUiHarness(html, async (path) => Response.json(path.includes('/revoke') ? { revoked: true } : {}), { sessionToken: 'admin-secret' })
    harness.run()
    const revoke = elementStub({ tagName: 'button', textContent: 'Revoke' })
    revoke.dataset.action = 'node-revoke'
    revoke.dataset.nodeId = 'node/a'
    revoke.dataset.confirm = 'Confirm revoke?'
    revoke.dataset.out = 'node-output'

    await harness.click(revoke)
    expect(harness.fetchCalls).toHaveLength(0)
    expect(revoke.dataset.armed).toBe('true')
    expect(revoke.textContent).toBe('Confirm revoke?')

    await harness.click(revoke)
    expect(harness.fetchCalls[0]!.path).toBe('/admin/nodes/node%2Fa/revoke')
    expect(revoke.dataset.armed).toBeUndefined()
    expect(revoke.textContent).toBe('Revoke')
    expect(JSON.parse(harness.byId('node-output').textContent) as { revoked: boolean }).toEqual({ revoked: true })
  })

  it('REQ-ADM-006 copies all generated setup tokens from rendered token controls', async () => {
    const { router } = routerFixture()
    const html = await (await router(new Request('https://router.test/'))).text()
    const setupTokens = { adminToken: 'admin-a', providerToken: 'provider-a', setupToken: 'setup-a', upstreamToken: 'upstream-a', byokInstruction: 'Paste providerToken as the AI Gateway custom provider API key.' }
    const harness = adminUiHarness(html, async () => Response.json(setupTokens, { status: 201 }))
    harness.run()

    await harness.clickAction('first-run-setup', { out: 'setup-output' })
    const output = harness.byId('setup-output')
    const cards = output.children.filter((child) => child.dataset.tokenCard)
    const copyAll = output.children.find((child) => child.dataset.copyAll === 'true')

    expect(output.children[0]!.dataset.tokenWarning).toBe('true')
    expect(cards.map((card) => card.dataset.tokenCard)).toEqual(['adminToken', 'providerToken', 'setupToken', 'upstreamToken'])
    expect(copyAll).toBeDefined()
    await harness.click(copyAll!)
    expect(harness.copied.at(-1)!.split('\n')).toEqual(['adminToken: admin-a', 'providerToken: provider-a', 'setupToken: setup-a', 'upstreamToken: upstream-a'])
    expect(harness.events.some((event) => event.kind === 'setItem' && event.detail === 'session:codeflareInferenceMeshAdminToken=admin-a')).toBe(true)
    expect(harness.byId('wizard-continue-credentials').hidden).toBe(false)
  })

  it('REQ-ADM-006 auto-loads installer command for saved tokens and platform changes', async () => {
    const { router } = routerFixture()
    await router(new Request('https://router.test/admin/setup', { method: 'POST' }))
    const html = await (await router(new Request('https://router.test/admin'))).text()
    expect(html).toContain('<body data-view="login">')
    let releaseLinux: (() => void) | undefined
    const linuxWait = new Promise<void>((resolve) => { releaseLinux = resolve })
    const harness = adminUiHarness(html, async (path) => {
      if (path === '/admin/login') return Response.json({ ok: true, session: 'bearer-token' })
      if (path === '/admin/status') return Response.json({})
      if (path === '/admin/agent-versions') return Response.json({ tags: [], stale: false })
      if (path.endsWith('/linux')) await linuxWait
      return new Response('install command for ' + path, { status: 200, headers: { 'content-type': 'text/plain' } })
    }, { localToken: 'admin-secret' })
    harness.byId('installer-platform').value = 'linux'
    harness.run()
    await harness.flush(10)

    expect(harness.body.dataset.view).toBe('dashboard')
    const platform = harness.byId('installer-platform')
    platform.dataset.installerPlatform = 'true'
    platform.dataset.prefix = ''
    platform.value = 'windows'
    await harness.change(platform)
    await harness.flush(4)
    releaseLinux?.()
    await harness.flush(6)

    const paths = harness.fetchCalls.map((call) => call.path)
    expect(paths).toContain('/admin/installers/linux')
    expect(paths).toContain('/admin/installers/windows')
    expect(harness.byId('installer-output').textContent).toBe('install command for /admin/installers/windows')
  })

  it('REQ-GWY-001 REQ-RTR-001 separates health, provider, node, and admin route families', async () => {
    // RouteFamilySeparationTestAnchor
    const { router } = routerFixture()

    expect((await router(new Request('https://router.test/health'))).status).toBe(200)
    expect((await router(new Request('https://router.test/v1/models'))).status).toBe(401)
    expect((await router(new Request('https://router.test/v1/models', { headers: bearer('provider-secret') }))).status).toBe(200)
    expect((await router(new Request('https://router.test/admin/status', { headers: bearer('provider-secret') }))).status).toBe(401)
    expect((await router(new Request('https://router.test/missing'))).status).toBe(404)
  })

  it('REQ-GWY-002 REQ-SEC-002 generates distinct bearer tokens, stores only verifiers, and stages setup rotation', async () => {
    // TokenVerifierStorageTestAnchor
    const { router, store } = routerFixture()
    const response = await router(new Request('https://router.test/admin/setup', { method: 'POST' }))
    const body = await response.json() as Record<string, string>

    expect(response.status).toBe(201)
    expect(new Set([body.adminToken, body.providerToken, body.setupToken, body.upstreamToken]).size).toBe(4)
    expect(store.tokens.every((token) => token.verifier.startsWith('sha256:'))).toBe(true)
    expect(timingSafeEqualText('sha256:same', 'sha256:same')).toBe(true)
    expect(timingSafeEqualText('sha256:same', 'sha256:different')).toBe(false)
    const returnedValues = new Set(Object.values(body))
    expect(store.tokens.some((token) => returnedValues.has(token.verifier))).toBe(false)

    const staged = await router(new Request('https://router.test/admin/setup-tokens', { method: 'POST', headers: bearer(String(body.adminToken)) }))
    const stagedBody = await staged.json() as { setupToken: string }
    const activeSetupTokens = store.tokens.filter((token) => token.kind === 'setup' && token.active)

    expect(staged.status).toBe(201)
    expect(stagedBody.setupToken).not.toBe(body.setupToken)
    expect(activeSetupTokens).toHaveLength(2)
    expect(new Set(activeSetupTokens.map((token) => token.verifier)).size).toBe(2)
    expect(store.audit.some((event) => event.type === 'setup_token_created' && event.actor === 'admin')).toBe(true)
  })

  it('REQ-ADM-003 creates setup tokens with a 24h expiration', async () => {
    const { router, store } = routerFixture()
    const setupResponse = await router(new Request('https://router.test/admin/setup', { method: 'POST' }))
    const setup = await setupResponse.json() as { adminToken: string }

    const response = await router(new Request('https://router.test/admin/setup-tokens', { method: 'POST', headers: bearer(setup.adminToken) }))
    const body = await response.json() as { setupToken: string; expiresAt: number }
    const activeSetupTokens = store.tokens.filter((token) => token.kind === 'setup' && token.active)

    expect(response.status).toBe(201)
    expect(body.setupToken).toMatch(/^setup_/)
    expect(body.expiresAt).toBe(1_700_086_400_000)
    expect(activeSetupTokens.map((token) => token.expiresAt)).toEqual([1_700_086_400_000, 1_700_086_400_000])
  })

  it('REQ-GWY-004 REQ-SEC-001 prevents credential classes from crossing route families', async () => {
    // CredentialBoundaryTestAnchor
    const { router } = routerFixture()
    const setupResponse = await router(new Request('https://router.test/admin/setup', { method: 'POST' }))
    const setup = await setupResponse.json() as { setupToken: string }

    expect((await router(new Request('https://router.test/node/heartbeat', { method: 'POST', headers: bearer('provider-secret'), body: JSON.stringify({ nodeId: 'node-a' }) }))).status).toBe(404)
    expect((await router(new Request('https://router.test/v1/models', { headers: bearer('admin-secret') }))).status).toBe(401)
    expect((await router(new Request('https://router.test/admin/status', { headers: bearer(setup.setupToken) }))).status).toBe(401)
    expect((await router(new Request('https://router.test/node/heartbeat', { method: 'POST', headers: bearer(setup.setupToken), body: JSON.stringify({ nodeId: 'node-a' }) }))).status).not.toBe(200)
  })

  it('REQ-RUN-001 REQ-RUN-002 exposes seeded public model aliases through the provider API', async () => {
    const { router } = routerFixture()
    const response = await router(new Request('https://router.test/v1/models', { headers: bearer('provider-secret') }))
    const body = await response.json() as { data: Array<{ id: string }> }

    expect(response.status).toBe(200)
    expect(body.data.map((model) => model.id)).toEqual(expect.arrayContaining(['mesh-default', 'qwen3.6-coder', 'mesh-smoke']))
  })

  it('REQ-RUN-009 migrates changed default profile rows without keeping retired alias owners active', async () => {
    const store = new MemoryStore()
    await store.setProfile(legacyRuntimeProfile({ id: 'legacy-default-mm', publicAliases: ['mesh-default', 'qwen3.6:35b-a3b', 'qwen3.6-coder'], version: 1 }))
    await store.setProfile(legacyRuntimeProfile({ id: 'legacy-default-text', publicAliases: ['mesh-default', 'legacy-text-alias'], version: 4 }))

    await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)
    const profiles = await store.listProfiles()
    const retired = profiles.find((profile) => profile.id === 'legacy-default-mm')!
    const retiredVersioned = profiles.find((profile) => profile.id === 'legacy-default-text')!
    const current = await store.getProfileByPublicModel('mesh-default')

    expect(retired).toMatchObject({ active: false, rolloutPercent: 0, version: 2 })
    expect(retiredVersioned).toMatchObject({ active: false, rolloutPercent: 0, version: 5 })
    expect(current).toMatchObject({ id: 'mesh-default-qwen36-35b', runtime: 'meshllm', sourceMode: 'meshllm-ref' })
  })

  it('REQ-RUN-009 deactivates non-meshllm profile rows regardless of version', async () => {
    const store = new MemoryStore()
    await store.setProfile(legacyRuntimeProfile({ id: 'legacy-standalone-row', publicAliases: ['legacy-only-alias'], version: 7 }))

    await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)
    await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)
    const swept = (await store.listProfiles()).find((profile) => profile.id === 'legacy-standalone-row')!

    expect(swept).toMatchObject({ active: false, rolloutPercent: 0, version: 8 })
    expect(await store.getProfileByPublicModel('legacy-only-alias')).toBeUndefined()
  })

  it('REQ-SCH-001 deactivates non-meshllm profile rows during seeding', async () => {
    const { router, store } = routerFixture()
    await store.setProfile(legacyRuntimeProfile({ id: 'legacy-runtime-row', publicAliases: ['legacy-router-alias'], version: 3 }))

    await router(new Request('https://router.test/health'))
    const swept = (await store.listProfiles()).find((profile) => profile.id === 'legacy-runtime-row')!

    expect(swept).toMatchObject({ active: false, rolloutPercent: 0, version: 4 })
  })

  it('REQ-SCH-005 lists only active profile aliases in the public model listing', async () => {
    const { router, store } = routerFixture()
    await store.setProfile({ ...DEFAULT_MODEL_PROFILES[2]!, id: 'ghost-profile', publicAliases: ['ghost-alias'], rolloutPercent: 0, active: false })

    const response = await router(new Request('https://router.test/v1/models', { headers: bearer('provider-secret') }))
    const body = await response.json() as { data: Array<{ id: string }> }
    const ids = body.data.map((model) => model.id)

    expect(response.status).toBe(200)
    expect(ids).toEqual(expect.arrayContaining(['mesh-default', 'qwen3.6:35b-a3b', 'qwen3.6-coder', 'mesh-smoke', 'smoke-test']))
    expect(ids).not.toContain('ghost-alias')
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('REQ-RUN-002 seeds the MeshLLM default profile set with contract values', () => {
    const single = DEFAULT_MODEL_PROFILES.find((profile) => profile.id === 'mesh-default-qwen36-35b')!
    const split = DEFAULT_MODEL_PROFILES.find((profile) => profile.id === 'mesh-split-qwen36-35b')!
    const smoke = DEFAULT_MODEL_PROFILES.find((profile) => profile.id === 'mesh-smoke-qwen25-1.5b')!

    expect(DEFAULT_MODEL_PROFILES.map((profile) => profile.id)).toEqual([
      'mesh-default-qwen36-35b',
      'mesh-split-qwen36-35b',
      'mesh-smoke-qwen25-1.5b'
    ])
    expect(single).toMatchObject({
      publicAliases: ['mesh-default', 'qwen3.6:35b-a3b', 'qwen3.6-coder'],
      meshllm: { modelRef: 'unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ3_S', split: false, bindPort: 4300 },
      contextWindow: 262144,
      rolloutPercent: 100,
      active: true
    })
    expect(split).toMatchObject({
      publicAliases: ['mesh-default', 'qwen3.6:35b-a3b', 'qwen3.6-coder'],
      meshllm: { modelRef: 'hf://meshllm/Qwen3.6-35B-A3B-UD-Q4_K_XL-layers@9b24bdc3dfb174ad6848f3f71c34f5302fa4dcfd', split: true, bindPort: 4310 },
      contextWindow: 262144,
      rolloutPercent: 0,
      active: false
    })
    expect(smoke).toMatchObject({
      publicAliases: ['mesh-smoke', 'smoke-test'],
      meshllm: { modelRef: 'unsloth/Qwen2.5-Coder-1.5B-Instruct-GGUF:Q4_K_M', split: false, bindPort: 4320 },
      contextWindow: 32768,
      rolloutPercent: 100,
      active: true
    })
  })

  it('REQ-RUN-002 exposes profile source modes and meshllm contract values', () => {
    for (const profile of DEFAULT_MODEL_PROFILES) {
      expect(profile.sourceMode).toBe('meshllm-ref')
      expect(profile.runtime).toBe('meshllm')
      expect(profile.upstreamModel).toBe(profile.meshllm.modelRef)
      expect(profile.version).toBe(1)
      expect(Number.isInteger(profile.meshllm.bindPort)).toBe(true)
      expect(profile.meshllm.bindPort).toBeGreaterThan(0)
    }
  })

  it('REQ-RTR-002 REQ-SCH-002 REQ-OBS-001 forwards rewritten chat requests through Mesh and releases reservations', async () => {
    const capture: { request?: Request } = {}
    const { router, store } = routerFixture({ mesh: makeMesh(capture) })
    await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)
    await store.upsertNode(nodeFixture())

    const response = await router(new Request('https://router.test/v1/chat/completions', {
      method: 'POST',
      headers: { ...bearer('provider-secret'), 'content-type': 'application/json', 'x-inference-mesh-session': 'session-a' },
      body: JSON.stringify({ model: 'mesh-default', messages: [{ role: 'user', content: 'hello' }] })
    }))
    await response.text()
    const forwarded = await capture.request!.json() as { model: string }
    const reservation = [...store.reservations.values()][0]!

    expect(response.status).toBe(200)
    expect(capture.request!.url).toBe('http://100.64.1.10:8080/v1/chat/completions')
    expect(forwarded.model).toBe(QWEN_UPSTREAM)
    expect(capture.request!.headers.get('authorization')).toBe('Bearer upstream-secret')
    expect(response.headers.get('x-inference-mesh-request-id')).toBe('request-a')
    expect(response.headers.get('x-inference-mesh-session')).toBe('session-a')
    expect(reservation.releasedAt).toBe(1_700_000_000_000)
  })

  it('REQ-RTR-002 REQ-SEC-001 reuses generated upstream token when no env secret exists', async () => {
    // UpstreamTokenReuseTestAnchor
    const capture: { request?: Request } = {}
    const store = new MemoryStore()
    const router = createRouter({
      store,
      scheduler: new StoreScheduler(store, () => 'reservation-generated'),
      mesh: makeMesh(capture),
      now: () => 1_700_000_000_000,
      requestId: () => 'request-generated',
      env: { ROUTER_PROVIDER_TOKEN: 'provider-secret', WORKER_BASE_URL: 'https://router.example.workers.dev', MAX_REQUEST_BYTES: '4096' }
    })
    const setupResponse = await router(new Request('https://router.test/admin/setup', { method: 'POST' }))
    const setup = await setupResponse.json() as { setupToken: string; upstreamToken: string }
    const claim = await router(new Request('https://router.test/node/claim', {
      method: 'POST',
      headers: { ...bearer(setup.setupToken), 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Node A', meshIp: '100.64.1.10', inferencePort: 8080, publicModels: ['mesh-default'], activeProfileIds: ['mesh-default-qwen36-35b'], capacity: 1 })
    }))
    const claimed = await claim.json() as { nodeId: string; nodeToken: string }
    await router(new Request('https://router.test/node/heartbeat', {
      method: 'POST',
      headers: { ...bearer(claimed.nodeToken), 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: claimed.nodeId, displayName: 'Node A', meshIp: '100.64.1.10', inferencePort: 8080, localDashboardPort: 17777, status: 'online', publicModels: ['mesh-default'], activeProfileIds: ['mesh-default-qwen36-35b'], capacity: 1, inFlight: 0, runtime: 'meshllm', runtimeModel: 'unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ3_S', metrics: { runtimeState: 'ready', loadedModel: 'unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ3_S', activeRequests: 0, apiReady: true, readyModels: ['unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ3_S'] } })
    }))

    const response = await router(new Request('https://router.test/v1/chat/completions', {
      method: 'POST',
      headers: { ...bearer('provider-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mesh-default', messages: [] })
    }))

    expect(response.status).toBe(200)
    expect(capture.request!.headers.get('authorization')).toBe(`Bearer ${setup.upstreamToken}`)
  })

  it('REQ-RTR-002 releases a reservation when Mesh fetch throws', async () => {
    const mesh = {
      fetch: async () => { throw new Error('mesh unavailable') },
      connect() { throw new Error('connect is not used by inference forwarding') }
    } as Fetcher
    const { router, store } = routerFixture({ mesh })
    await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)
    await store.upsertNode(nodeFixture({ capacity: 1 }))

    const response = await router(new Request('https://router.test/v1/chat/completions', {
      method: 'POST',
      headers: { ...bearer('provider-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mesh-default', messages: [] })
    }))

    const node = await store.getNode('node-a')

    expect(response.status).toBe(500)
    expect([...store.reservations.values()][0]?.releasedAt).toBe(1_700_000_000_000)
    expect(node?.inFlight).toBe(0)
    expect(node?.failurePenaltyUntil).toBeGreaterThan(1_700_000_000_000)
  })

  it('REQ-RTR-003 streams upstream bodies without buffering them first', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: one\n\n'))
        controller.enqueue(new TextEncoder().encode('data: two\n\n'))
        controller.close()
      }
    })
    const mesh = {
      fetch: async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
      connect() { throw new Error('connect is not used by inference forwarding') }
    } as Fetcher
    const { router, store } = routerFixture({ mesh })
    await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)
    await store.upsertNode(nodeFixture())

    const response = await router(new Request('https://router.test/v1/chat/completions', {
      method: 'POST',
      headers: { ...bearer('provider-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mesh-default', stream: true, messages: [] })
    }))

    expect(response.headers.get('content-type')?.split(';')[0]).toBe('text/event-stream')
    expect(await response.text()).toBe('data: one\n\ndata: two\n\n')
  })

  it('REQ-RTR-003 releases and penalizes stream failures', async () => {
    const times = [1_700_000_000_000, 1_700_000_120_000]
    let timeIndex = 0
    const nextNow = () => times[Math.min(timeIndex++, times.length - 1)]!
    const stream = new ReadableStream({
      pull() {
        throw new Error('stream failed')
      }
    })
    const mesh = {
      fetch: async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
      connect() { throw new Error('connect is not used by inference forwarding') }
    } as Fetcher
    const { router, store } = routerFixture({ mesh, now: nextNow })
    await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)
    await store.upsertNode(nodeFixture())

    const response = await router(new Request('https://router.test/v1/chat/completions', {
      method: 'POST',
      headers: { ...bearer('provider-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mesh-default', stream: true, messages: [] })
    }))

    await expect(response.text()).rejects.toThrow('stream failed')
    expect([...store.reservations.values()][0]?.releasedAt).toBe(1_700_000_120_000)
    expect((await store.getNode('node-a'))?.failurePenaltyUntil).toBeGreaterThan(1_700_000_120_000)
  })

  it('REQ-RTR-004 accepts only private Mesh IP destinations and rejects full upstream URLs', () => {
    expect(isSafeMeshTarget('100.64.1.10', 8080)).toBe(true)
    expect(isSafeMeshTarget('10.0.0.5', 8080)).toBe(true)
    expect(isSafeMeshTarget('https://evil.example', 443)).toBe(false)
    expect(isSafeMeshTarget('8.8.8.8', 8080)).toBe(false)
  })

  it('REQ-SCH-005 returns no-node when no eligible node has capacity', async () => {
    const { router, store } = routerFixture()
    await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)
    await store.upsertNode(nodeFixture({ capacity: 1, inFlight: 1 }))

    const response = await router(new Request('https://router.test/v1/chat/completions', {
      method: 'POST',
      headers: { ...bearer('provider-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mesh-default', messages: [] })
    }))

    expect(response.status).toBe(429)
    expect(await response.json()).toMatchObject({ error: 'no-node', requestId: 'request-a' })
  })

  it('REQ-SCH-005 returns no-profile when the public model has no configured profile', async () => {
    const { router, store } = routerFixture()
    await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)

    const response = await router(new Request('https://router.test/v1/chat/completions', {
      method: 'POST',
      headers: { ...bearer('provider-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'missing-public-alias', messages: [] })
    }))

    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ error: 'no-profile', requestId: 'request-a' })
  })

  it('REQ-SCH-003 REQ-OBS-004 excludes expired unhealthy and unsafe nodes from scheduling', async () => {
    const now = 1_700_000_000_000
    const ineligibleNodes = [
      nodeFixture({ id: 'expired', lastSeenAt: now - 45_001 }),
      nodeFixture({ id: 'offline', status: 'offline' }),
      nodeFixture({ id: 'unsupported-model', publicModels: ['other-alias'] }),
      nodeFixture({ id: 'unloaded-profile', activeProfileIds: [] }),
      nodeFixture({ id: 'penalized', failurePenaltyUntil: now + 1_000 }),
      nodeFixture({ id: 'over-capacity', capacity: 1, inFlight: 1 }),
      nodeFixture({ id: 'runtime-failed', metrics: { runtimeState: 'failed', activeRequests: 0, apiReady: true, readyModels: [QWEN_UPSTREAM] } }),
      nodeFixture({ id: 'stale-ready-models', metrics: { runtimeState: 'ready', activeRequests: 0, apiReady: true, readyModels: ['other-model'] } }),
      nodeFixture({ id: 'unsafe-mesh', meshIp: '8.8.8.8' })
    ] as const

    for (const node of ineligibleNodes) {
      const store = new MemoryStore()
      await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)
      await store.upsertNode(node)
      const result = await new StoreScheduler(store).reserve({ publicModel: 'mesh-default', sessionId: `session-${node.id}`, now })

      expect(result.reason).toBe('no-node')
      expect(result.reservation).toBeUndefined()
    }
  })

  it('REQ-SCH-003 excludes nodes whose runtime is not meshllm from scheduling', async () => {
    const store = new MemoryStore()
    await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)
    await store.upsertNode({ ...nodeFixture(), runtime: 'legacy-runtime' } as unknown as NodeRecord)

    const result = await new StoreScheduler(store).reserve({ publicModel: 'mesh-default', sessionId: 'session-runtime', now: 1_700_000_000_000 })

    expect(result.reason).toBe('no-node')
    expect(result.reservation).toBeUndefined()
  })

  it('REQ-SCH-003 excludes nodes whose MeshLLM API is not ready from scheduling', async () => {
    const store = new MemoryStore()
    await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)
    await store.upsertNode(nodeFixture({ metrics: { runtimeState: 'ready', activeRequests: 0, apiReady: false, readyModels: [QWEN_UPSTREAM] } }))

    const result = await new StoreScheduler(store).reserve({ publicModel: 'mesh-default', sessionId: 'session-api-ready', now: 1_700_000_000_000 })

    expect(result.reason).toBe('no-node')
    expect(result.reservation).toBeUndefined()
  })

  it('REQ-SCH-003 excludes nodes whose ready models omit the requested upstream model', async () => {
    const store = new MemoryStore()
    await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)
    await store.upsertNode(nodeFixture({ metrics: { runtimeState: 'ready', activeRequests: 0, apiReady: true, readyModels: ['unsloth/Qwen2.5-Coder-1.5B-Instruct-GGUF:Q4_K_M'] } }))

    const result = await new StoreScheduler(store).reserve({ publicModel: 'mesh-default', sessionId: 'session-ready-models', now: 1_700_000_000_000 })

    expect(result.reason).toBe('no-node')
    expect(result.reservation).toBeUndefined()
  })

  it('REQ-SCH-003 keeps standby nodes unschedulable even when ready models list the requested model', async () => {
    const store = new MemoryStore()
    await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)
    await store.upsertNode(nodeFixture({ metrics: { runtimeState: 'starting', activeRequests: 0, apiReady: true, readyModels: [QWEN_UPSTREAM] } }))
    const standby = await new StoreScheduler(store, () => 'reservation-standby').reserve({ publicModel: 'mesh-default', sessionId: 'session-standby', now: 1_700_000_000_000 })

    await store.upsertNode(nodeFixture({ metrics: { runtimeState: 'ready', activeRequests: 0, apiReady: true, readyModels: [QWEN_UPSTREAM] } }))
    const ready = await new StoreScheduler(store, () => 'reservation-ready').reserve({ publicModel: 'mesh-default', sessionId: 'session-standby-ready', now: 1_700_000_000_000 })

    expect(standby.reason).toBe('no-node')
    expect(standby.reservation).toBeUndefined()
    expect(ready.reservation?.nodeId).toBe('node-a')
  })

  it('REQ-SCH-004 uses another eligible node when the sticky node is ineligible', async () => {
    const store = new MemoryStore()
    await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)
    await store.upsertNode(nodeFixture({ id: 'node-a', inFlight: 1, capacity: 1 }))
    await store.upsertNode(nodeFixture({ id: 'node-b', displayName: 'Node B', meshIp: '100.64.1.11', inFlight: 0 }))
    await store.putSession({ sessionId: 'session-a', nodeId: 'node-a', publicModel: 'mesh-default', profileId: 'mesh-default-qwen36-35b', upstreamModel: QWEN_UPSTREAM, expiresAt: 1_700_000_100_000 })
    const scheduler = new StoreScheduler(store, () => 'reservation-c')

    const result = await scheduler.reserve({ publicModel: 'mesh-default', sessionId: 'session-a', now: 1_700_000_000_000 })

    expect(result.reservation?.nodeId).toBe('node-b')
  })

  it('REQ-SCH-004 preserves session affinity when the sticky node remains eligible', async () => {
    const store = new MemoryStore()
    await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)
    await store.upsertNode(nodeFixture({ id: 'node-a', inFlight: 0 }))
    await store.upsertNode(nodeFixture({ id: 'node-b', displayName: 'Node B', meshIp: '100.64.1.11', inFlight: 0 }))
    await store.putSession({ sessionId: 'session-a', nodeId: 'node-b', publicModel: 'mesh-default', profileId: 'mesh-default-qwen36-35b', upstreamModel: QWEN_UPSTREAM, expiresAt: 1_700_000_100_000 })
    const scheduler = new StoreScheduler(store, () => 'reservation-b')

    const result = await scheduler.reserve({ publicModel: 'mesh-default', sessionId: 'session-a', now: 1_700_000_000_000 })

    expect(result.reservation?.nodeId).toBe('node-b')
  })

  it('REQ-SCH-004 ignores expired session mappings when choosing an eligible node', async () => {
    const store = new MemoryStore()
    await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)
    await store.upsertNode(nodeFixture({ id: 'node-a', inFlight: 0, capacity: 2 }))
    await store.upsertNode(nodeFixture({ id: 'node-b', displayName: 'Node B', meshIp: '100.64.1.11', inFlight: 1, capacity: 2 }))
    await store.putSession({ sessionId: 'session-a', nodeId: 'node-b', publicModel: 'mesh-default', profileId: 'mesh-default-qwen36-35b', upstreamModel: QWEN_UPSTREAM, expiresAt: 1_699_999_999_999 })
    const scheduler = new StoreScheduler(store, () => 'reservation-expired')

    const result = await scheduler.reserve({ publicModel: 'mesh-default', sessionId: 'session-a', now: 1_700_000_000_000 })

    expect(result.reservation?.nodeId).toBe('node-a')
    expect(store.sessions.get('session-a')?.nodeId).toBe('node-a')
  })

  it('REQ-ADM-001 REQ-ADM-003 consumes setup tokens during node claim', async () => {
    // FirstRunSetupTokenTestAnchor
    const { router, store } = routerFixture()
    const expiredRecord = await createTokenRecord('setup', 'expired-setup', 1_699_913_599_999, undefined, 1_700_000_000_000)
    await store.putToken(expiredRecord)
    const expired = await router(new Request('https://router.test/node/claim', {
      method: 'POST',
      headers: { ...bearer('expired-setup'), 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Expired Node', meshIp: '100.64.1.9', inferencePort: 8080, publicModels: ['mesh-default'], activeProfileIds: ['mesh-default-qwen36-35b'], capacity: 1 })
    }))
    const setupResponse = await router(new Request('https://router.test/admin/setup', { method: 'POST' }))
    const setup = await setupResponse.json() as { setupToken: string }
    const claim = await router(new Request('https://router.test/node/claim', {
      method: 'POST',
      headers: { ...bearer(setup.setupToken), 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Node A', meshIp: '100.64.1.10', inferencePort: 8080, publicModels: ['mesh-default'], activeProfileIds: ['mesh-default-qwen36-35b'], capacity: 2 })
    }))
    const consumed = await router(new Request('https://router.test/node/claim', {
      method: 'POST',
      headers: { ...bearer(setup.setupToken), 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Node B', meshIp: '100.64.1.11', inferencePort: 8080, publicModels: ['mesh-default'], activeProfileIds: ['mesh-default-qwen36-35b'], capacity: 2 })
    }))

    expect(expired.status).toBe(401)
    expect(claim.status).toBe(201)
    expect(consumed.status).toBe(401)
    expect(store.tokens.find((token) => token.id === expiredRecord.id)?.active).toBe(true)
    expect(store.tokens.filter((token) => token.kind === 'setup' && token.id !== expiredRecord.id).every((token) => token.active === false)).toBe(true)
    expect(store.nodes.has('node-a-100-64-1-10')).toBe(true)
  })

  it('REQ-NODE-002 REQ-OBS-003 accepts authenticated heartbeats and stores node metrics', async () => {
    const { router, store } = routerFixture()
    await store.upsertNode({ ...nodeFixture(), nodeTokenVerifier: await hashToken('node-secret') })

    const response = await router(new Request('https://router.test/node/heartbeat', {
      method: 'POST',
      headers: { ...bearer('node-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: 'node-a', displayName: 'Node A', meshIp: '100.64.1.10', inferencePort: 8080, localDashboardPort: 17777, status: 'online', publicModels: ['mesh-default'], activeProfileIds: ['mesh-default-qwen36-35b'], capacity: 2, inFlight: 1, runtime: 'meshllm', runtimeModel: 'unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ3_S', metrics: { runtimeState: 'ready', loadedModel: 'unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ3_S', activeRequests: 1, gpuName: 'RTX 3090', apiReady: true, readyModels: ['unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ3_S'] } })
    }))

    const stored = await store.getNode('node-a')

    expect(response.status).toBe(200)
    expect(stored?.metrics?.gpuName).toBe('RTX 3090')
    expect(stored?.metrics?.readyModels).toEqual([QWEN_UPSTREAM])
  })

  it('REQ-OBS-005 lets an authenticated node remove itself from scheduling', async () => {
    // NodeUnregisterAuthorizationTestAnchor
    const { router, store } = routerFixture()
    await store.upsertNode({ ...nodeFixture({ status: 'online', inFlight: 1 }), nodeTokenVerifier: await hashToken('node-secret') })

    const response = await router(new Request('https://router.test/node/unregister', {
      method: 'POST',
      headers: { ...bearer('node-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: 'node-a' })
    }))
    const node = await store.getNode('node-a')

    expect(response.status).toBe(200)
    expect(node?.status).toBe('offline')
    expect(node?.inFlight).toBe(0)
  })

  it('REQ-SEC-002 lets an admin revoke a node token and audit the action', async () => {
    const { router, store } = routerFixture()
    await store.upsertNode({ ...nodeFixture({ status: 'online' }), nodeTokenVerifier: await hashToken('node-secret'), upstreamTokenVerifier: await hashToken('upstream-secret') })
    await store.putToken(await createTokenRecord('node', 'node-secret', 1_700_000_000_000, 'node-a'))

    const response = await router(new Request('https://router.test/admin/nodes/node-a/revoke', { method: 'POST', headers: bearer('admin-secret') }))
    const heartbeat = await router(new Request('https://router.test/node/heartbeat', {
      method: 'POST',
      headers: { ...bearer('node-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: 'node-a', displayName: 'Node A', meshIp: '100.64.1.10', inferencePort: 8080, localDashboardPort: 17777, status: 'online', publicModels: ['mesh-default'], activeProfileIds: ['mesh-default-qwen36-35b'], capacity: 2, inFlight: 0, runtime: 'meshllm', metrics: { runtimeState: 'ready', activeRequests: 0 } })
    }))
    const unregister = await router(new Request('https://router.test/node/unregister', {
      method: 'POST',
      headers: { ...bearer('node-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: 'node-a' })
    }))
    const node = await store.getNode('node-a')

    expect(response.status).toBe(200)
    expect(heartbeat.status).toBe(403)
    expect(unregister.status).toBe(403)
    expect(node?.status).toBe('revoked')
    expect(node?.nodeTokenVerifier).toBeUndefined()
    expect(node?.upstreamTokenVerifier).toBeUndefined()
    expect(store.tokens.filter((token) => token.kind === 'node' && token.nodeId === 'node-a').every((token) => token.active === false)).toBe(true)
    expect(node?.failurePenaltyUntil).toBeGreaterThan(1_700_000_000_000)
    expect(store.audit.some((event) => event.type === 'node_revoked' && event.target === 'node-a')).toBe(true)
  })

  it('REQ-OBS-006 records audit events for setup, claim, unregister, revoke, route provisioning, and profile switch actions', async () => {
    const { router, store } = routerFixture({
      env: { CLOUDFLARE_ACCOUNT_ID: 'account-a', CLOUDFLARE_API_TOKEN_RUNTIME: 'runtime-token', AI_GATEWAY_ID: 'gateway-a', WORKER_BASE_URL: 'https://router.example.workers.dev' },
      cloudflareClient: {
        async syncCustomProvider(input) {
          return { providerId: 'provider-a', providerSlug: 'provider-slug', routeId: 'route-a', routeVersionId: 'version-a', deploymentId: 'deployment-a', gatewayId: input.gatewayId, routeName: input.routeName, publicModel: input.publicModel, workerUrl: input.workerUrl, manualProviderKeyRequired: true, providerTokenInstructions: 'manual' }
        },
        async provisionCustomDomain() { throw new Error('custom domain is not used in this test') }
      }
    })

    const setupResponse = await router(new Request('https://router.test/admin/setup', { method: 'POST' }))
    const setup = await setupResponse.json() as { setupToken: string }
    const claim = await router(new Request('https://router.test/node/claim', {
      method: 'POST',
      headers: { ...bearer(setup.setupToken), 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Node A', meshIp: '100.64.1.10', inferencePort: 8080, publicModels: ['mesh-default'], activeProfileIds: ['mesh-default-qwen36-35b'], capacity: 2 })
    }))
    const claimed = await claim.json() as { nodeId: string; nodeToken: string }

    await router(new Request('https://router.test/node/unregister', { method: 'POST', headers: { ...bearer(claimed.nodeToken), 'content-type': 'application/json' }, body: JSON.stringify({ nodeId: claimed.nodeId }) }))
    await router(new Request(`https://router.test/admin/nodes/${claimed.nodeId}/revoke`, { method: 'POST', headers: bearer('admin-secret') }))
    await store.putConfig('custom_domain', { hostname: 'ai.example.com', zoneId: '0123456789abcdef0123456789abcdef', zoneName: 'example.com', dnsRecordId: 'dns-a', dnsRecordType: 'CNAME', routeId: 'route-a', routePattern: 'ai.example.com/*', workerName: 'router-worker', status: 'provisioned' })
    const gatewaySync = await router(new Request('https://router.test/admin/cloudflare/gateway/sync', { method: 'POST', headers: bearer('admin-secret') }))
    await router(new Request('https://router.test/admin/profiles/rollout', { method: 'POST', headers: { ...bearer('admin-secret'), 'content-type': 'application/json' }, body: JSON.stringify({ profileId: 'mesh-default-qwen36-35b', rolloutPercent: 50 }) }))

    expect(gatewaySync.status).toBe(200)
    expect(store.audit.map((event) => event.type)).toEqual(expect.arrayContaining(['first_setup', 'node_claimed', 'node_unregistered', 'node_revoked', 'gateway_sync', 'profile_rollout']))
  })

  it('REQ-SCH-002 REQ-NODE-002 keeps scheduler reservation counts authoritative over heartbeats', async () => {
    const { router, store } = routerFixture()
    await store.upsertNode({ ...nodeFixture({ capacity: 1, inFlight: 0 }), nodeTokenVerifier: await hashToken('node-secret') })

    const staleHigh = await router(new Request('https://router.test/node/heartbeat', {
      method: 'POST',
      headers: { ...bearer('node-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: 'node-a', displayName: 'Node A', meshIp: '100.64.1.10', inferencePort: 8080, localDashboardPort: 17777, status: 'online', publicModels: ['mesh-default'], activeProfileIds: ['mesh-default-qwen36-35b'], capacity: 1, inFlight: 1, runtime: 'meshllm', metrics: { runtimeState: 'ready', activeRequests: 1 } })
    }))
    const afterStaleHigh = await store.getNode('node-a')
    await store.upsertNode({ ...afterStaleHigh!, inFlight: 1 })

    const staleZero = await router(new Request('https://router.test/node/heartbeat', {
      method: 'POST',
      headers: { ...bearer('node-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: 'node-a', displayName: 'Node A', meshIp: '100.64.1.10', inferencePort: 8080, localDashboardPort: 17777, status: 'online', publicModels: ['mesh-default'], activeProfileIds: ['mesh-default-qwen36-35b'], capacity: 1, inFlight: 0, runtime: 'meshllm', metrics: { runtimeState: 'ready', activeRequests: 0 } })
    }))
    const afterStaleZero = await store.getNode('node-a')

    expect(staleHigh.status).toBe(200)
    expect(afterStaleHigh?.inFlight).toBe(0)
    expect(afterStaleHigh?.metrics?.activeRequests).toBe(1)
    expect(staleZero.status).toBe(200)
    expect(afterStaleZero?.inFlight).toBe(1)
    expect(afterStaleZero?.metrics?.activeRequests).toBe(0)
  })

  it('REQ-ADM-002 REQ-OBS-002 returns redacted machine-readable admin status and REQ-RUN-004 reports profile readiness in admin status', async () => {
    // AdminStatusRedactionTestAnchor
    const { router, store } = routerFixture()
    await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)
    await store.upsertNode({ ...nodeFixture(), upstreamTokenVerifier: 'sha256:hidden' })
    await store.upsertNode({ ...nodeFixture({ id: 'node-b', displayName: 'Node B', meshIp: '100.64.1.11', metrics: { runtimeState: 'dependency-missing', activeRequests: 0, lastError: 'missing runtime' } }) })
    await store.putConfig('setup_state', { completedAt: 1_700_000_000_000 })
    await store.appendAudit({ id: 'audit-a', type: 'profile_rollout', at: 1_700_000_000_000, actor: 'admin', target: 'mesh-default-qwen36-35b', detail: { rolloutPercent: 100 } })

    const response = await router(new Request('https://router.test/admin/status', { headers: bearer('admin-secret') }))
    const body = await response.json() as { generatedAt?: number; nodes?: Array<Record<string, unknown>>; profiles?: Array<Record<string, unknown>>; profileReadiness?: Array<Record<string, unknown>>; setup?: Record<string, unknown>; audit?: Array<Record<string, unknown>> }

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ generatedAt: 1_700_000_000_000 })
    expect(body.nodes).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'node-a', status: 'online', capacity: 2, inFlight: 0, lastSeenAt: 1_700_000_000_000 })]))
    expect(body.profiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'mesh-default-qwen36-35b', upstreamModel: QWEN_UPSTREAM, sourceMode: 'meshllm-ref', version: 1, rolloutPercent: 100, active: true })
    ]))
    expect(body.profiles?.[0]).toHaveProperty('publicAliases')
    expect(body.profileReadiness).toEqual(expect.arrayContaining([
      expect.objectContaining({ profileId: 'mesh-default-qwen36-35b', ready: 1, downloading: 0, failed: 1 })
    ]))
    expect(body.setup).toEqual(expect.objectContaining({ completedAt: 1_700_000_000_000 }))
    expect(body.audit).toEqual([expect.objectContaining({ id: 'audit-a', type: 'profile_rollout', actor: 'admin', target: 'mesh-default-qwen36-35b' })])
    expect(new Set(valuesOf(body)).has('sha256:hidden')).toBe(false)
  })

  it('REQ-ADM-004 returns installer commands backed by release-tagged platform artifact plans', async () => {
    const { router, store } = routerFixture({ env: { AGENT_RELEASE_TAG: 'v0.1.0-dev.1782860991', WORKER_BASE_URL: 'https://codeflare-inference-mesh-router.<your-subdomain>.workers.dev' } })
    const commandResponse = await router(new Request('https://router.test/admin/installers/linux', { headers: bearer('admin-secret') }))
    const command = await commandResponse.text()
    const scriptUrl = new URL(command.split(/\s+/).find((part) => part.startsWith('https://'))!)
    const scriptResponse = await router(new Request('https://router.test/install.sh?platform=linux'))
    const script = await scriptResponse.text()
    const fallbackScript = await (await routerFixture().router(new Request('https://router.test/install.sh?platform=linux'))).text()
    const windowsScript = await (await router(new Request('https://router.test/install.ps1'))).text()
    const linuxPlan = installerPlan('linux', 'amd64')
    const windowsPlan = installerPlan('windows', 'amd64')

    expect(commandResponse.status).toBe(200)
    expect(scriptUrl.origin).toBe('https://router.test')
    expect(scriptUrl.pathname).toBe('/install.sh')
    expect(scriptUrl.searchParams.get('platform')).toBe('linux')
    expect(script).toContain('https://github.com/nikolanovoselec/codeflare-inference-mesh/releases/download/v0.1.0-dev.1782860991')
    expect(fallbackScript).toContain('https://github.com/nikolanovoselec/codeflare-inference-mesh/releases/latest/download')
    expect(windowsScript).toContain('Register-ScheduledTask')
    expect(windowsScript).not.toContain('New-Service')
    expect(linuxPlan).toEqual({ assetName: 'inference-mesh-agent-linux-amd64.tar.gz', extractedBinary: 'inference-mesh-agent-linux-amd64', installedBinary: 'inference-mesh-agent', checksumFile: 'checksums.txt' })
    expect(windowsPlan).toEqual({ assetName: 'inference-mesh-agent-windows-amd64.zip', extractedBinary: 'inference-mesh-agent-windows-amd64.exe', installedBinary: 'inference-mesh-agent.exe', checksumFile: 'checksums.txt' })
    expect(store.tokens.filter((token) => token.kind === 'setup' && token.active).length).toBe(1)
  })

  it('REQ-GWY-003 automates provider, route, version, and deployment creation while leaving BYOK manual', async () => {
    const calls: string[] = []
    const { router, store } = routerFixture({
      env: { CLOUDFLARE_ACCOUNT_ID: 'account-a', CLOUDFLARE_API_TOKEN_RUNTIME: 'runtime-token', AI_GATEWAY_ID: 'gateway-a', WORKER_BASE_URL: 'https://router.example.workers.dev' },
      cloudflareClient: {
        async syncCustomProvider(input) {
          calls.push(input.accountId, input.gatewayId, input.workerUrl, input.routeName, input.publicModel)
          return { providerId: 'provider-a', providerSlug: 'provider-slug', routeId: 'route-a', routeVersionId: 'version-a', deploymentId: 'deployment-a', gatewayId: input.gatewayId, routeName: input.routeName, publicModel: input.publicModel, workerUrl: input.workerUrl, manualProviderKeyRequired: true, providerTokenInstructions: input.providerTokenInstructions }
        },
        async provisionCustomDomain() { throw new Error('custom domain is not used in this test') }
      }
    })

    await store.putConfig('custom_domain', { hostname: 'ai.example.com', zoneId: '0123456789abcdef0123456789abcdef', status: 'provisioned' })

    const response = await router(new Request('https://router.test/admin/cloudflare/gateway/sync', { method: 'POST', headers: { ...bearer('admin-secret'), 'content-type': 'application/json' }, body: JSON.stringify({ accountId: 'account-admin', gatewayId: 'gateway-admin', routeName: 'mesh-admin', publicModel: 'mesh-smoke' }) }))
    const body = await response.json() as { manualProviderKeyRequired: boolean; deploymentId: string }

    expect(response.status).toBe(200)
    expect(calls).toEqual(['account-admin', 'gateway-admin', 'https://ai.example.com', 'mesh-admin', 'mesh-smoke'])
    expect(body).toMatchObject({ deploymentId: 'deployment-a', manualProviderKeyRequired: true })
  })

  it('REQ-GWY-003 uses idempotent Cloudflare custom-provider and dynamic-route payload contracts', async () => {
    const calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = []
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
      calls.push({ method, path: url.pathname, ...(body ? { body } : {}) })
      if (url.pathname.endsWith('/custom-providers') && method === 'GET') return Response.json({ success: true, result: [] })
      if (url.pathname.endsWith('/custom-providers') && method === 'POST') return Response.json({ success: true, result: { id: 'provider-a', slug: 'codeflare-inference-mesh-router-example-workers-dev' } })
      if (url.pathname.endsWith('/routes') && method === 'GET') return Response.json({ success: true, result: { data: { routes: [] } } })
      if (url.pathname.endsWith('/routes') && method === 'POST') return Response.json({ success: true, result: { id: 'route-a', name: 'mesh-default' } })
      if (url.pathname.endsWith('/versions') && method === 'GET') return Response.json({ success: true, result: { data: { versions: [] } } })
      if (url.pathname.endsWith('/versions') && method === 'POST') return Response.json({ success: true, result: { id: 'version-a' } })
      if (url.pathname.endsWith('/deployments') && method === 'GET') return Response.json({ success: true, result: { data: { deployments: [] } } })
      return Response.json({ success: true, result: { id: 'deployment-a' } })
    }) as typeof fetch
    const client = new CloudflareGatewayClient('runtime-token', fetcher)

    const result = await client.syncCustomProvider({ accountId: 'account-a', gatewayId: 'gateway-a', workerUrl: 'https://router.example.workers.dev/v1/chat/completions', providerName: 'Codeflare Inference Mesh', routeName: 'mesh-default', publicModel: 'mesh-default', providerTokenInstructions: 'manual' })
    const versionBody = calls.find((call) => call.path.endsWith('/versions') && call.method === 'POST')!.body as { elements: Array<{ type: string; properties?: Record<string, unknown> }> }
    const modelNode = versionBody.elements.find((element) => element.type === 'model')!

    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'GET /client/v4/accounts/account-a/ai-gateway/custom-providers',
      'POST /client/v4/accounts/account-a/ai-gateway/custom-providers',
      'GET /client/v4/accounts/account-a/ai-gateway/gateways/gateway-a/routes',
      'POST /client/v4/accounts/account-a/ai-gateway/gateways/gateway-a/routes',
      'GET /client/v4/accounts/account-a/ai-gateway/gateways/gateway-a/routes/route-a/versions',
      'POST /client/v4/accounts/account-a/ai-gateway/gateways/gateway-a/routes/route-a/versions',
      'GET /client/v4/accounts/account-a/ai-gateway/gateways/gateway-a/routes/route-a/deployments',
      'POST /client/v4/accounts/account-a/ai-gateway/gateways/gateway-a/routes/route-a/deployments'
    ])
    expect(calls[1]!.body).toEqual({ name: 'Codeflare Inference Mesh', slug: 'codeflare-inference-mesh-router-example-workers-dev', base_url: 'https://router.example.workers.dev', description: 'Codeflare Inference Mesh OpenAI-compatible router', enable: true })
    expect(modelNode.properties).toEqual({ provider: 'custom-codeflare-inference-mesh-router-example-workers-dev', model: 'mesh-default', retries: 1, timeout: 120000 })
    expect(result).toMatchObject({ providerId: 'provider-a', providerSlug: 'codeflare-inference-mesh-router-example-workers-dev', routeId: 'route-a', routeVersionId: 'version-a', deploymentId: 'deployment-a', gatewayId: 'gateway-a', routeName: 'mesh-default', publicModel: 'mesh-default', workerUrl: 'https://router.example.workers.dev', manualProviderKeyRequired: true, providerTokenInstructions: 'manual' })
  })

  it('REQ-ADM-005 upserts DNS and Worker route for custom-domain provisioning', async () => {
    const calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = []
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
      calls.push({ method, path: url.pathname + url.search, ...(body ? { body } : {}) })
      if (url.pathname === '/client/v4/zones/0123456789abcdef0123456789abcdef') return Response.json({ success: true, result: { id: '0123456789abcdef0123456789abcdef', name: 'example.com' } })
      if (url.pathname.endsWith('/dns_records') && method === 'GET') return Response.json({ success: true, result: [] })
      if (url.pathname.endsWith('/dns_records') && method === 'POST') return Response.json({ success: true, result: { id: 'dns-a', type: 'CNAME', name: 'ai.example.com', content: 'router.example.workers.dev', proxied: true } })
      if (url.pathname.endsWith('/workers/routes') && method === 'GET') return Response.json({ success: true, result: [] })
      if (url.pathname.endsWith('/workers/routes') && method === 'POST') return Response.json({ success: true, result: { id: 'route-a', pattern: 'ai.example.com/*', script: 'router-worker' } })
      throw new Error(`unexpected ${method} ${url.pathname}`)
    }) as typeof fetch

    const result = await new CloudflareGatewayClient('runtime-token', fetcher).provisionCustomDomain({ accountId: 'account-a', hostname: 'ai.example.com', zoneId: '0123456789abcdef0123456789abcdef', workerName: 'router-worker', workerUrl: 'https://router.example.workers.dev' })

    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'GET /client/v4/zones/0123456789abcdef0123456789abcdef',
      'GET /client/v4/zones/0123456789abcdef0123456789abcdef/dns_records?name=ai.example.com',
      'POST /client/v4/zones/0123456789abcdef0123456789abcdef/dns_records',
      'GET /client/v4/zones/0123456789abcdef0123456789abcdef/workers/routes',
      'POST /client/v4/zones/0123456789abcdef0123456789abcdef/workers/routes'
    ])
    expect(calls[2]!.body).toMatchObject({ type: 'CNAME', name: 'ai.example.com', content: 'router.example.workers.dev', proxied: true })
    expect(calls[4]!.body).toEqual({ pattern: 'ai.example.com/*', script: 'router-worker' })
    expect(result).toMatchObject({ hostname: 'ai.example.com', status: 'provisioned', dnsRecordId: 'dns-a', routeId: 'route-a' })
  })

  it('REQ-ADM-005 provisions custom domains from the configured Worker origin when deploy URL is usable', async () => {
    const calls: string[] = []
    const { router, store } = routerFixture({
      env: { CLOUDFLARE_ACCOUNT_ID: 'account-a', CLOUDFLARE_API_TOKEN_RUNTIME: 'runtime-token', WORKER_NAME: 'router-worker', WORKER_BASE_URL: 'https://configured.example.com' },
      cloudflareClient: {
        async syncCustomProvider() { throw new Error('Gateway sync is not used in this test') },
        async provisionCustomDomain(input) {
          calls.push(input.workerUrl, input.hostname, input.workerName)
          return { hostname: input.hostname, zoneId: 'zone-a', zoneName: 'example.com', dnsRecordId: 'dns-a', dnsRecordType: 'CNAME', routeId: 'route-a', routePattern: `${input.hostname}/*`, workerName: input.workerName, status: 'provisioned' }
        }
      }
    })

    const response = await router(new Request('https://bootstrap.example.workers.dev/admin/custom-domain/validate', { method: 'POST', headers: { ...bearer('admin-secret'), 'content-type': 'application/json' }, body: JSON.stringify({ hostname: 'ai.example.com' }) }))
    const stored = await store.getConfig<{ hostname: string; status: string }>('custom_domain')

    expect(response.status).toBe(200)
    expect(calls).toEqual(['https://configured.example.com', 'ai.example.com', 'router-worker'])
    expect(stored).toMatchObject({ hostname: 'ai.example.com', status: 'provisioned' })
  })

  it('REQ-ADM-005 provisions custom domains from the bootstrap request origin when deploy URL is a placeholder', async () => {
    const calls: string[] = []
    const { router, store } = routerFixture({
      env: { CLOUDFLARE_ACCOUNT_ID: 'account-a', CLOUDFLARE_API_TOKEN_RUNTIME: 'runtime-token', WORKER_NAME: 'router-worker', WORKER_BASE_URL: 'https://codeflare-inference-mesh-router.<your-subdomain>.workers.dev' },
      cloudflareClient: {
        async syncCustomProvider() { throw new Error('Gateway sync is not used in this test') },
        async provisionCustomDomain(input) {
          calls.push(input.workerUrl, input.hostname, input.workerName)
          return { hostname: input.hostname, zoneId: 'zone-a', zoneName: 'example.com', dnsRecordId: 'dns-a', dnsRecordType: 'CNAME', routeId: 'route-a', routePattern: `${input.hostname}/*`, workerName: input.workerName, status: 'provisioned' }
        }
      }
    })

    const response = await router(new Request('https://bootstrap.example.workers.dev/admin/custom-domain/validate', { method: 'POST', headers: { ...bearer('admin-secret'), 'content-type': 'application/json' }, body: JSON.stringify({ hostname: 'ai.example.com' }) }))
    const stored = await store.getConfig<{ hostname: string; status: string }>('custom_domain')

    expect(response.status).toBe(200)
    expect(calls).toEqual(['https://bootstrap.example.workers.dev', 'ai.example.com', 'router-worker'])
    expect(stored).toMatchObject({ hostname: 'ai.example.com', status: 'provisioned' })
  })

  it('REQ-ADM-005 leaves the existing Worker origin usable when custom-domain provisioning fails', async () => {
    const { router, store } = routerFixture({
      env: { CLOUDFLARE_ACCOUNT_ID: 'account-a', CLOUDFLARE_API_TOKEN_RUNTIME: 'runtime-token', WORKER_NAME: 'router-worker', WORKER_BASE_URL: 'https://codeflare-inference-mesh-router.<your-subdomain>.workers.dev' },
      cloudflareClient: {
        async syncCustomProvider() { throw new Error('Gateway sync is not used in this test') },
        async provisionCustomDomain() { throw new Error('DNS record conflict for ai.example.com') }
      }
    })

    const failure = await router(new Request('https://bootstrap.example.workers.dev/admin/custom-domain/validate', { method: 'POST', headers: { ...bearer('admin-secret'), 'content-type': 'application/json' }, body: JSON.stringify({ hostname: 'ai.example.com' }) }))
    const installer = await router(new Request('https://bootstrap.example.workers.dev/admin/installers/linux', { headers: bearer('admin-secret') }))
    const command = await installer.text()
    const scriptUrl = command.match(/curl -fsSL (?<script>\S+)/)?.groups?.script
    const routerUrl = command.match(/ROUTER_URL='(?<router>[^']+)'/)?.groups?.router

    expect(failure.status).toBe(409)
    expect(await store.getConfig('custom_domain')).toBeUndefined()
    expect(installer.status).toBe(200)
    expect(scriptUrl).toBe('https://bootstrap.example.workers.dev/install.sh?platform=linux')
    expect(routerUrl).toBe('https://bootstrap.example.workers.dev')
  })

  it('REQ-ADM-005 refuses to overwrite conflicting custom-domain DNS records', async () => {
    const calls: Array<{ method: string; path: string }> = []
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const method = init?.method ?? 'GET'
      calls.push({ method, path: url.pathname })
      if (url.pathname === '/client/v4/zones/0123456789abcdef0123456789abcdef') return Response.json({ success: true, result: { id: '0123456789abcdef0123456789abcdef', name: 'example.com' } })
      if (url.pathname.endsWith('/dns_records') && method === 'GET') return Response.json({ success: true, result: [{ id: 'txt-a', type: 'TXT', name: 'ai.example.com', content: 'verification' }] })
      throw new Error(`unexpected ${method} ${url.pathname}`)
    }) as typeof fetch
    const client = new CloudflareGatewayClient('runtime-token', fetcher)

    const result = await client.provisionCustomDomain({ accountId: 'account-a', hostname: 'ai.example.com', zoneId: '0123456789abcdef0123456789abcdef', workerName: 'router-worker', workerUrl: 'https://router.example.workers.dev' }).then(() => 'resolved', () => 'rejected')

    expect(result).toBe('rejected')
    expect(calls.map((call) => call.method)).toEqual(['GET', 'GET'])
  })

  it('REQ-ADM-010 refuses to sync Gateway to an unprovisioned custom domain', async () => {
    const { router, store } = routerFixture({ env: { CLOUDFLARE_ACCOUNT_ID: 'account-a', CLOUDFLARE_API_TOKEN_RUNTIME: 'runtime-token', WORKER_BASE_URL: 'https://router.example.workers.dev' } })
    await store.putConfig('custom_domain', { hostname: 'ai.example.com' })

    const response = await router(new Request('https://router.test/admin/cloudflare/gateway/sync', { method: 'POST', headers: bearer('admin-secret') }))
    const body = await response.json() as { error: string; hostname: string }

    expect(response.status).toBe(409)
    expect(body).toEqual({ error: 'custom_domain_not_provisioned', hostname: 'ai.example.com' })
  })

  it('REQ-GWY-003 uses the provisioned custom domain for Gateway sync instead of workers.dev bootstrap', async () => {
    const calls: string[] = []
    const { router, store } = routerFixture({
      env: { CLOUDFLARE_ACCOUNT_ID: 'account-a', CLOUDFLARE_API_TOKEN_RUNTIME: 'runtime-token', AI_GATEWAY_ID: 'gateway-a', WORKER_BASE_URL: 'https://router.example.workers.dev' },
      cloudflareClient: {
        async syncCustomProvider(input) {
          calls.push(input.workerUrl)
          return { providerId: 'provider-a', providerSlug: 'provider-slug', routeId: 'route-a', routeVersionId: 'version-a', deploymentId: 'deployment-a', gatewayId: input.gatewayId, routeName: input.routeName, publicModel: input.publicModel, workerUrl: input.workerUrl, manualProviderKeyRequired: true, providerTokenInstructions: 'manual' }
        },
        async provisionCustomDomain() { throw new Error('custom domain is not used in this test') }
      }
    })

    const beforeCustomDomain = await router(new Request('https://router.test/admin/cloudflare/gateway/sync', { method: 'POST', headers: bearer('admin-secret') }))
    await store.putConfig('custom_domain', { hostname: 'ai.example.com', zoneId: '0123456789abcdef0123456789abcdef', zoneName: 'example.com', dnsRecordId: 'dns-a', dnsRecordType: 'CNAME', routeId: 'route-a', routePattern: 'ai.example.com/*', workerName: 'router-worker', status: 'provisioned' })
    const afterCustomDomain = await router(new Request('https://router.test/admin/cloudflare/gateway/sync', { method: 'POST', headers: bearer('admin-secret') }))
    const missingCustomBody = await beforeCustomDomain.json() as { error: string }
    const settings = await store.getConfig<Record<string, unknown>>('cloudflare_gateway_settings')

    expect(beforeCustomDomain.status).toBe(409)
    expect(missingCustomBody).toEqual({ error: 'custom_domain_required' })
    expect(afterCustomDomain.status).toBe(200)
    expect(calls).toEqual(['https://ai.example.com'])
    expect(settings).not.toHaveProperty('workerUrl')
  })

  it('REQ-GWY-003 patches an existing Gateway provider when Worker URL drifts', async () => {
    const calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = []
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
      calls.push({ method, path: url.pathname, ...(body ? { body } : {}) })
      if (url.pathname.endsWith('/custom-providers') && method === 'GET') return Response.json({ success: true, result: [{ id: 'provider-a', slug: 'codeflare-inference-mesh-router-example-workers-dev', name: 'Codeflare Inference Mesh', base_url: 'https://old.example.com' }] })
      if (url.pathname.endsWith('/custom-providers/provider-a') && method === 'PATCH') return Response.json({ success: true, result: { id: 'provider-a', slug: 'codeflare-inference-mesh-router-example-workers-dev', name: body!.name, base_url: body!.base_url } })
      if (url.pathname.endsWith('/routes')) return Response.json({ success: true, result: { data: { routes: [{ id: 'route-a', name: 'mesh-default', enabled: true }] } } })
      if (url.pathname.endsWith('/versions')) return Response.json({ success: true, result: { data: { versions: [] } } })
      if (url.pathname.endsWith('/deployments')) return Response.json({ success: true, result: { data: { deployments: [] } } })
      return Response.json({ success: true, result: { id: 'created-a' } })
    }) as typeof fetch
    const client = new CloudflareGatewayClient('runtime-token', fetcher)

    await client.syncCustomProvider({ accountId: 'account-a', gatewayId: 'gateway-a', workerUrl: 'https://router.example.workers.dev', providerName: 'Codeflare Inference Mesh', routeName: 'mesh-default', publicModel: 'mesh-default', providerTokenInstructions: 'manual' })

    expect(calls.some((call) => call.method === 'PATCH' && call.path.endsWith('/custom-providers/provider-a') && call.body?.base_url === 'https://router.example.workers.dev')).toBe(true)
  })

  it('REQ-GWY-003 reuses existing Cloudflare Gateway resources on repeat sync', async () => {
    const calls: string[] = []
    const elements = [{ id: 'start', type: 'start', outputs: { next: { elementId: 'model' } } }, { id: 'model', type: 'model', properties: { provider: 'custom-codeflare-inference-mesh-router-example-workers-dev', model: 'mesh-default', retries: 1, timeout: 120000 }, outputs: { success: { elementId: 'end' }, fallback: { elementId: 'end' } } }, { id: 'end', type: 'end', outputs: {} }]
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const method = init?.method ?? 'GET'
      calls.push(`${method} ${url.pathname}`)
      if (url.pathname.endsWith('/custom-providers')) return Response.json({ success: true, result: [{ id: 'provider-a', slug: 'codeflare-inference-mesh-router-example-workers-dev', name: 'Codeflare Inference Mesh', base_url: 'https://router.example.workers.dev' }] })
      if (url.pathname.endsWith('/routes')) return Response.json({ success: true, result: { data: { routes: [{ id: 'route-a', name: 'mesh-default', enabled: true }] } } })
      if (url.pathname.endsWith('/versions')) return Response.json({ success: true, result: { data: { versions: [{ id: 'version-a', elements }] } } })
      if (url.pathname.endsWith('/deployments')) return Response.json({ success: true, result: { data: { deployments: [{ deployment_id: 'deployment-a', version_id: 'version-a' }] } } })
      throw new Error(`unexpected ${method} ${url.pathname}`)
    }) as typeof fetch

    const result = await new CloudflareGatewayClient('runtime-token', fetcher).syncCustomProvider({ accountId: 'account-a', gatewayId: 'gateway-a', workerUrl: 'https://router.example.workers.dev', providerName: 'Codeflare Inference Mesh', routeName: 'mesh-default', publicModel: 'mesh-default', providerTokenInstructions: 'manual' })

    expect(calls.every((call) => call.startsWith('GET '))).toBe(true)
    expect(result).toMatchObject({ providerId: 'provider-a', routeId: 'route-a', routeVersionId: 'version-a', deploymentId: 'deployment-a' })
  })

  it('REQ-ADM-005 provisions custom-domain DNS and Worker routing before accepting it', async () => {
    const provisioned: Array<{ hostname: string; zoneId?: string }> = []
    const { router, store } = routerFixture({
      env: { CLOUDFLARE_ACCOUNT_ID: 'account-a', CLOUDFLARE_API_TOKEN_RUNTIME: 'runtime-token', WORKER_NAME: 'router-worker', WORKER_BASE_URL: 'https://router.example.workers.dev' },
      cloudflareClient: {
        async syncCustomProvider() { throw new Error('gateway sync is not used in this test') },
        async provisionCustomDomain(input) {
          if (input.hostname === 'conflict.example.com') throw new Error('DNS record conflict for conflict.example.com')
          provisioned.push({ hostname: input.hostname, ...(input.zoneId ? { zoneId: input.zoneId } : {}) })
          return { hostname: input.hostname, zoneId: input.zoneId ?? 'zone-a', zoneName: 'example.com', dnsRecordId: 'dns-a', dnsRecordType: 'CNAME', routeId: 'route-a', routePattern: `${input.hostname}/*`, workerName: input.workerName, status: 'provisioned' }
        }
      }
    })
    const good = await router(new Request('https://router.test/admin/custom-domain/validate', { method: 'POST', headers: { ...bearer('admin-secret'), 'content-type': 'application/json' }, body: JSON.stringify({ hostname: 'ai.example.com', zoneId: '0123456789abcdef0123456789abcdef' }) }))
    const bad = await router(new Request('https://router.test/admin/custom-domain/validate', { method: 'POST', headers: { ...bearer('admin-secret'), 'content-type': 'application/json' }, body: JSON.stringify({ hostname: 'http://bad' }) }))
    const badZone = await router(new Request('https://router.test/admin/custom-domain/validate', { method: 'POST', headers: { ...bearer('admin-secret'), 'content-type': 'application/json' }, body: JSON.stringify({ hostname: 'ai.example.com', zoneId: 'not-a-zone' }) }))
    const conflict = await router(new Request('https://router.test/admin/custom-domain/validate', { method: 'POST', headers: { ...bearer('admin-secret'), 'content-type': 'application/json' }, body: JSON.stringify({ hostname: 'conflict.example.com' }) }))

    expect(good.status).toBe(200)
    expect(await store.getConfig('custom_domain')).toMatchObject({ hostname: 'ai.example.com', status: 'provisioned', routeId: 'route-a' })
    expect(provisioned).toEqual([{ hostname: 'ai.example.com', zoneId: '0123456789abcdef0123456789abcdef' }])
    expect(store.audit.some((event) => event.type === 'custom_domain_provisioned' && event.target === 'ai.example.com')).toBe(true)
    expect(bad.status).toBe(400)
    expect(badZone.status).toBe(400)
    expect(conflict.status).toBe(409)
  })

  it('REQ-ADM-002 recovers a lost admin token only with the recovery secret', async () => {
    const { router, store } = routerFixture({ env: { ADMIN_RECOVERY_TOKEN: 'recovery-secret' } })
    await store.putToken(await createTokenRecord('admin', 'old-admin', 1_700_000_000_000))

    const denied = await router(new Request('https://router.test/admin/recovery/reset', { method: 'POST', headers: bearer('wrong') }))
    const reset = await router(new Request('https://router.test/admin/recovery/reset', { method: 'POST', headers: bearer('recovery-secret') }))
    const body = await reset.json() as { adminToken: string }
    const login = await router(new Request('https://router.test/admin/login', { method: 'POST', headers: bearer(body.adminToken) }))

    expect(denied.status).toBe(401)
    expect(reset.status).toBe(201)
    expect(login.status).toBe(200)
    expect(store.tokens.filter((token) => token.kind === 'admin' && token.active).length).toBe(1)
    expect(store.audit.some((event) => event.type === 'admin_recovery_reset')).toBe(true)
  })

  it('REQ-SEC-003 strips client authorization and Cloudflare headers before Worker-to-node forwarding', async () => {
    // WorkerHeaderFilteringTestAnchor
    const capture: { request?: Request } = {}
    const { router, store } = routerFixture({ mesh: makeMesh(capture) })
    await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)
    await store.upsertNode(nodeFixture())

    await router(new Request('https://router.test/v1/chat/completions', {
      method: 'POST',
      headers: { ...bearer('provider-secret'), 'content-type': 'application/json', 'cf-access-client-secret': 'secret' },
      body: JSON.stringify({ model: 'mesh-default', messages: [] })
    }))

    expect(capture.request!.headers.get('authorization')).toBe('Bearer upstream-secret')
    expect(capture.request!.headers.get('cf-access-client-secret')).toBeNull()
  })

  it('REQ-RUN-004 updates profile rollout as versioned configuration', async () => {
    const { router, store } = routerFixture()
    await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)

    const response = await router(new Request('https://router.test/admin/profiles/rollout', {
      method: 'POST',
      headers: { ...bearer('admin-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ profileId: 'mesh-split-qwen36-35b', rolloutPercent: 25 })
    }))
    const profile = (await store.listProfiles()).find((item) => item.id === 'mesh-split-qwen36-35b')!

    expect(response.status).toBe(200)
    expect(profile.rolloutPercent).toBe(25)
    expect(profile.version).toBe(2)
  })

  it('REQ-RUN-009 activation deactivates alias-overlapping active profiles', async () => {
    const { router, store } = routerFixture()

    const activateSplit = await router(new Request('https://router.test/admin/profiles/activate', {
      method: 'POST',
      headers: { ...bearer('admin-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ profileId: 'mesh-split-qwen36-35b' })
    }))
    const afterSplit = await store.listProfiles()

    expect(activateSplit.status).toBe(200)
    expect(afterSplit.find((profile) => profile.id === 'mesh-split-qwen36-35b')).toMatchObject({ active: true, rolloutPercent: 100, version: 2 })
    expect(afterSplit.find((profile) => profile.id === 'mesh-default-qwen36-35b')).toMatchObject({ active: false, rolloutPercent: 0, version: 2 })
    expect(afterSplit.find((profile) => profile.id === 'mesh-smoke-qwen25-1.5b')).toMatchObject({ active: true, version: 1 })

    const activateSingle = await router(new Request('https://router.test/admin/profiles/activate', {
      method: 'POST',
      headers: { ...bearer('admin-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ profileId: 'mesh-default-qwen36-35b' })
    }))
    const afterSingle = await store.listProfiles()

    expect(activateSingle.status).toBe(200)
    expect(afterSingle.find((profile) => profile.id === 'mesh-default-qwen36-35b')).toMatchObject({ active: true, rolloutPercent: 100, version: 3 })
    expect(afterSingle.find((profile) => profile.id === 'mesh-split-qwen36-35b')).toMatchObject({ active: false, rolloutPercent: 0, version: 3 })

    const rollout = await router(new Request('https://router.test/admin/profiles/rollout', {
      method: 'POST',
      headers: { ...bearer('admin-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ profileId: 'mesh-split-qwen36-35b', rolloutPercent: 40 })
    }))
    const afterRollout = await store.listProfiles()
    const activeOwners = afterRollout.filter((profile) => profile.active && profile.publicAliases.includes('mesh-default'))

    expect(rollout.status).toBe(200)
    expect(activeOwners.map((profile) => profile.id)).toEqual(['mesh-split-qwen36-35b'])
    expect(afterRollout.find((profile) => profile.id === 'mesh-split-qwen36-35b')).toMatchObject({ active: true, rolloutPercent: 40 })
    expect(afterRollout.find((profile) => profile.id === 'mesh-default-qwen36-35b')).toMatchObject({ active: false, rolloutPercent: 0 })
  })

  it('REQ-ADM-009 activates profiles alias-exclusively and records the audit event', async () => {
    const { router, store } = routerFixture()

    const unauthorized = await router(new Request('https://router.test/admin/profiles/activate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profileId: 'mesh-split-qwen36-35b' })
    }))
    const unknown = await router(new Request('https://router.test/admin/profiles/activate', {
      method: 'POST',
      headers: { ...bearer('admin-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ profileId: 'missing-profile' })
    }))
    const invalid = await router(new Request('https://router.test/admin/profiles/activate', {
      method: 'POST',
      headers: { ...bearer('admin-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({})
    }))
    const activated = await router(new Request('https://router.test/admin/profiles/activate', {
      method: 'POST',
      headers: { ...bearer('admin-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ profileId: 'mesh-split-qwen36-35b' })
    }))
    const body = await activated.json() as { ok: boolean; activated: string; deactivated: string[] }
    const owners = (await store.listProfiles()).filter((profile) => profile.active && profile.publicAliases.includes('qwen3.6-coder'))

    expect(unauthorized.status).toBe(401)
    expect(unknown.status).toBe(404)
    expect(invalid.status).toBe(400)
    expect(activated.status).toBe(200)
    expect(body).toMatchObject({ ok: true, activated: 'mesh-split-qwen36-35b', deactivated: ['mesh-default-qwen36-35b'] })
    expect(owners.map((profile) => profile.id)).toEqual(['mesh-split-qwen36-35b'])
    expect(store.audit.some((event) => event.type === 'profile_activated' && event.actor === 'admin' && event.target === 'mesh-split-qwen36-35b')).toBe(true)
  })

  it('REQ-OBS-006 records profile activation audit events', async () => {
    const { router, store } = routerFixture()

    await router(new Request('https://router.test/admin/profiles/activate', {
      method: 'POST',
      headers: { ...bearer('admin-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ profileId: 'mesh-split-qwen36-35b' })
    }))
    const event = store.audit.find((item) => item.type === 'profile_activated')!

    expect(event).toMatchObject({ actor: 'admin', target: 'mesh-split-qwen36-35b' })
    expect(event.detail).toEqual({ deactivated: ['mesh-default-qwen36-35b'] })
  })

  it('REQ-NODE-002 heartbeat and claim responses carry mesh bootstrap and desired agent version', async () => {
    const { router, store } = routerFixture({
      env: { MESH_STATE_KEY: MESH_STATE_KEY_B64 },
      releasesFetcher: githubReleasesFetcher(['v0.2.0', 'v0.1.0'])
    })
    const setup = await (await router(new Request('https://router.test/admin/setup', { method: 'POST' }))).json() as { setupToken: string }
    expect((await router(new Request('https://router.test/admin/agent-versions', { headers: bearer('admin-secret') }))).status).toBe(200)
    const select = await router(new Request('https://router.test/admin/agent-version', {
      method: 'POST',
      headers: { ...bearer('admin-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ version: 'v0.2.0' })
    }))

    const claim = await router(new Request('https://router.test/node/claim', {
      method: 'POST',
      headers: { ...bearer(setup.setupToken), 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Node A', meshIp: '100.64.1.10', inferencePort: 8080, publicModels: ['mesh-default'], activeProfileIds: ['mesh-default-qwen36-35b'], capacity: 2 })
    }))
    const claimed = await claim.json() as { nodeId: string; nodeToken: string; meshBootstrap?: { action: string }; desiredAgentVersion?: string }
    const heartbeat = await router(new Request('https://router.test/node/heartbeat', {
      method: 'POST',
      headers: { ...bearer(claimed.nodeToken), 'content-type': 'application/json' },
      body: heartbeatBody({ nodeId: claimed.nodeId, agentVersion: 'v0.1.0' })
    }))
    const heartbeatResponse = await heartbeat.json() as { ok: boolean; desiredProfiles: unknown[]; meshBootstrap?: { action: string; rotation: number }; desiredAgentVersion?: string }
    const node = await store.getNode(claimed.nodeId)

    expect(select.ok).toBe(true)
    expect(claim.status).toBe(201)
    expect(claimed.desiredAgentVersion).toBe('v0.2.0')
    expect(claimed.meshBootstrap).toBeDefined()
    expect(['create', 'wait']).toContain(claimed.meshBootstrap!.action)
    expect(heartbeat.status).toBe(200)
    expect(heartbeatResponse.ok).toBe(true)
    expect(heartbeatResponse.meshBootstrap).toMatchObject({ action: 'create' })
    expect(typeof heartbeatResponse.meshBootstrap!.rotation).toBe('number')
    expect(heartbeatResponse.desiredAgentVersion).toBe('v0.2.0')
    expect(node?.agentVersion).toBe('v0.1.0')
  })

  it('REQ-OBS-002 reports node mesh membership and readiness fields in admin status', async () => {
    const { router, store } = routerFixture({ env: { MESH_STATE_KEY: MESH_STATE_KEY_B64 } })
    await store.upsertNode({ ...nodeFixture(), nodeTokenVerifier: await hashToken('node-secret') })
    const heartbeat = await router(new Request('https://router.test/node/heartbeat', {
      method: 'POST',
      headers: { ...bearer('node-secret'), 'content-type': 'application/json' },
      body: heartbeatBody({
        meshId: 'mesh-1',
        meshToken: 'invite-token-value-a',
        metrics: {
          runtimeState: 'ready',
          activeRequests: 0,
          meshId: 'mesh-1',
          meshRole: 'coordinator',
          peerCount: 2,
          readyModels: [QWEN_UPSTREAM],
          splitEnabled: false,
          stageCount: 1,
          apiReady: true,
          consoleReady: true,
          meshllmVersion: '0.72.2'
        }
      })
    }))

    const response = await router(new Request('https://router.test/admin/status', { headers: bearer('admin-secret') }))
    const body = await response.json() as { nodes?: Array<{ id: string; metrics?: Record<string, unknown> }>; meshHealth?: unknown[]; profileReadiness?: Array<Record<string, unknown>> }
    const nodeEntry = body.nodes?.find((node) => node.id === 'node-a')

    expect(heartbeat.status).toBe(200)
    expect(response.status).toBe(200)
    expect(nodeEntry?.metrics).toMatchObject({
      meshId: 'mesh-1',
      meshRole: 'coordinator',
      peerCount: 2,
      readyModels: [QWEN_UPSTREAM],
      splitEnabled: false,
      stageCount: 1,
      apiReady: true,
      consoleReady: true,
      meshllmVersion: '0.72.2'
    })
    expect(Array.isArray(body.meshHealth)).toBe(true)
    expect(body.meshHealth!.length).toBeGreaterThan(0)
    expect(body.profileReadiness).toEqual(expect.arrayContaining([
      expect.objectContaining({ profileId: 'mesh-default-qwen36-35b', ready: 1, downloading: 0, failed: 0 })
    ]))
  })

  it('REQ-OBS-002 reports node agent versions and the desired agent version in admin status', async () => {
    const { router, store } = routerFixture({ releasesFetcher: githubReleasesFetcher(['v0.2.0', 'v0.1.0']) })
    await store.upsertNode({ ...nodeFixture(), nodeTokenVerifier: await hashToken('node-secret') })
    expect((await router(new Request('https://router.test/admin/agent-versions', { headers: bearer('admin-secret') }))).status).toBe(200)
    const select = await router(new Request('https://router.test/admin/agent-version', {
      method: 'POST',
      headers: { ...bearer('admin-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ version: 'v0.2.0' })
    }))
    await router(new Request('https://router.test/node/heartbeat', {
      method: 'POST',
      headers: { ...bearer('node-secret'), 'content-type': 'application/json' },
      body: heartbeatBody({ agentVersion: 'v0.1.0' })
    }))

    const response = await router(new Request('https://router.test/admin/status', { headers: bearer('admin-secret') }))
    const body = await response.json() as { nodes?: Array<{ id: string; agentVersion?: string }>; desiredAgentVersion?: string }

    expect(select.ok).toBe(true)
    expect(response.status).toBe(200)
    expect(body.nodes?.find((node) => node.id === 'node-a')?.agentVersion).toBe('v0.1.0')
    expect(body.desiredAgentVersion).toBe('v0.2.0')
  })

  it('REQ-SEC-007 admin status reports token presence, age, and count without values', async () => {
    const { router, store } = routerFixture({ env: { MESH_STATE_KEY: MESH_STATE_KEY_B64 } })
    await store.upsertNode({ ...nodeFixture(), nodeTokenVerifier: await hashToken('node-secret') })
    const heartbeat = await router(new Request('https://router.test/node/heartbeat', {
      method: 'POST',
      headers: { ...bearer('node-secret'), 'content-type': 'application/json' },
      body: heartbeatBody({ meshId: 'mesh-1', meshToken: 'invite-token-value-a' })
    }))
    const meshState = store.config.get('mesh_state:mesh-default-qwen36-35b')

    const response = await router(new Request('https://router.test/admin/status', { headers: bearer('admin-secret') }))
    const body = await response.json() as { meshHealth?: unknown[] }

    expect(heartbeat.status).toBe(200)
    expect(meshState).toBeDefined()
    expect(JSON.stringify(meshState)).not.toContain('invite-token-value-a')
    expect(response.status).toBe(200)
    expect(Array.isArray(body.meshHealth)).toBe(true)
    expect(JSON.stringify(body)).not.toContain('invite-token-value-a')
  })

  it('REQ-SEC-007 node revoke removes the node mesh tokens from distribution', async () => {
    const { router, store } = routerFixture({ env: { MESH_STATE_KEY: MESH_STATE_KEY_B64 } })
    await store.upsertNode({ ...nodeFixture(), nodeTokenVerifier: await hashToken('node-secret') })
    await router(new Request('https://router.test/node/heartbeat', {
      method: 'POST',
      headers: { ...bearer('node-secret'), 'content-type': 'application/json' },
      body: heartbeatBody({ meshId: 'mesh-1', meshToken: 'invite-token-value-a' })
    }))
    expect(store.config.get('mesh_state:mesh-default-qwen36-35b')).toBeDefined()

    const revoke = await router(new Request('https://router.test/admin/nodes/node-a/revoke', { method: 'POST', headers: bearer('admin-secret') }))

    expect(revoke.status).toBe(200)
    expect(store.audit.some((event) => event.type === 'mesh_token_removed')).toBe(true)
  })

  it('REQ-OBS-007 reports per-profile mesh coordinator and peers in admin status', async () => {
    const { router, store } = routerFixture({ env: { MESH_STATE_KEY: MESH_STATE_KEY_B64 } })
    await store.upsertNode({ ...nodeFixture(), nodeTokenVerifier: await hashToken('node-secret-a') })
    await store.upsertNode({ ...nodeFixture({ id: 'node-b', displayName: 'Node B', meshIp: '100.64.1.11' }), nodeTokenVerifier: await hashToken('node-secret-b') })
    await router(new Request('https://router.test/node/heartbeat', {
      method: 'POST',
      headers: { ...bearer('node-secret-a'), 'content-type': 'application/json' },
      body: heartbeatBody({ meshId: 'mesh-1', meshToken: 'invite-token-value-a', metrics: { runtimeState: 'ready', activeRequests: 0, apiReady: true, readyModels: [QWEN_UPSTREAM], meshRole: 'coordinator' } })
    }))
    await router(new Request('https://router.test/node/heartbeat', {
      method: 'POST',
      headers: { ...bearer('node-secret-b'), 'content-type': 'application/json' },
      body: heartbeatBody({ nodeId: 'node-b', displayName: 'Node B', meshIp: '100.64.1.11', meshId: 'mesh-1', meshToken: 'invite-token-value-b', metrics: { runtimeState: 'ready', activeRequests: 0, apiReady: true, readyModels: [QWEN_UPSTREAM], meshRole: 'serving-peer' } })
    }))

    const response = await router(new Request('https://router.test/admin/status', { headers: bearer('admin-secret') }))
    const body = await response.json() as { meshHealth?: Array<{ profileId: string; meshId?: string; coordinatorNodeId?: string; peerNodeIds: string[] }> }
    const entry = body.meshHealth?.find((item) => item.profileId === 'mesh-default-qwen36-35b')

    expect(response.status).toBe(200)
    expect(entry?.meshId).toBe('mesh-1')
    expect(entry?.coordinatorNodeId).toBe('node-a')
    expect(entry?.peerNodeIds).toEqual(['node-a', 'node-b'])
  })

  it('REQ-OBS-007 reports ready models and failed nodes per mesh', async () => {
    const { router, store } = routerFixture({ env: { MESH_STATE_KEY: MESH_STATE_KEY_B64 } })
    await store.upsertNode({ ...nodeFixture(), nodeTokenVerifier: await hashToken('node-secret-a') })
    await store.upsertNode({ ...nodeFixture({ id: 'node-b', displayName: 'Node B', meshIp: '100.64.1.11' }), nodeTokenVerifier: await hashToken('node-secret-b') })
    await router(new Request('https://router.test/node/heartbeat', {
      method: 'POST',
      headers: { ...bearer('node-secret-a'), 'content-type': 'application/json' },
      body: heartbeatBody({ meshId: 'mesh-1', meshToken: 'invite-token-value-a' })
    }))
    await router(new Request('https://router.test/node/heartbeat', {
      method: 'POST',
      headers: { ...bearer('node-secret-b'), 'content-type': 'application/json' },
      body: heartbeatBody({ nodeId: 'node-b', displayName: 'Node B', meshIp: '100.64.1.11', metrics: { runtimeState: 'failed', activeRequests: 0, lastError: 'stage exited' } })
    }))

    const response = await router(new Request('https://router.test/admin/status', { headers: bearer('admin-secret') }))
    const body = await response.json() as { meshHealth?: Array<{ profileId: string; readyModels: string[]; failedNodeIds: string[] }> }
    const entry = body.meshHealth?.find((item) => item.profileId === 'mesh-default-qwen36-35b')

    expect(response.status).toBe(200)
    expect(entry?.readyModels).toEqual([QWEN_UPSTREAM])
    expect(entry?.failedNodeIds).toEqual(['node-b'])
  })

  it('REQ-OBS-007 surfaces the last MeshLLM error per mesh', async () => {
    const { router, store } = routerFixture({ env: { MESH_STATE_KEY: MESH_STATE_KEY_B64 } })
    await store.upsertNode({ ...nodeFixture(), nodeTokenVerifier: await hashToken('node-secret') })
    await router(new Request('https://router.test/node/heartbeat', {
      method: 'POST',
      headers: { ...bearer('node-secret'), 'content-type': 'application/json' },
      body: heartbeatBody({ meshId: 'mesh-1', meshToken: 'invite-token-value-a', metrics: { runtimeState: 'failed', activeRequests: 0, lastError: 'stage 0 exited before ready' } })
    }))

    const response = await router(new Request('https://router.test/admin/status', { headers: bearer('admin-secret') }))
    const body = await response.json() as { meshHealth?: Array<{ profileId: string; lastError?: string }> }
    const entry = body.meshHealth?.find((item) => item.profileId === 'mesh-default-qwen36-35b')

    expect(response.status).toBe(200)
    expect(entry?.lastError).toBe('stage 0 exited before ready')
  })

  it('REQ-OBS-007 shows rotation counter and secret presence without values', async () => {
    const { router, store } = routerFixture({ env: { MESH_STATE_KEY: MESH_STATE_KEY_B64 } })
    await store.upsertNode({ ...nodeFixture(), nodeTokenVerifier: await hashToken('node-secret') })
    await router(new Request('https://router.test/node/heartbeat', {
      method: 'POST',
      headers: { ...bearer('node-secret'), 'content-type': 'application/json' },
      body: heartbeatBody({ meshId: 'mesh-1', meshToken: 'invite-token-value-a' })
    }))

    const statusRequest = () => router(new Request('https://router.test/admin/status', { headers: bearer('admin-secret') }))
    const before = await (await statusRequest()).json() as { meshHealth?: Array<{ profileId: string; rotation: number; tokenCount: number; secretAgeMs?: number }> }
    const beforeEntry = before.meshHealth?.find((item) => item.profileId === 'mesh-default-qwen36-35b')

    expect(beforeEntry?.rotation).toBe(0)
    expect(beforeEntry?.tokenCount).toBe(1)
    expect(typeof beforeEntry?.secretAgeMs).toBe('number')
    expect(JSON.stringify(before)).not.toContain('invite-token-value-a')

    const rotate = await router(new Request('https://router.test/admin/mesh/rotate', {
      method: 'POST',
      headers: { ...bearer('admin-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ profileId: 'mesh-default-qwen36-35b' })
    }))
    const after = await (await statusRequest()).json() as { meshHealth?: Array<{ profileId: string; rotation: number; tokenCount: number; secretAgeMs?: number }> }
    const afterEntry = after.meshHealth?.find((item) => item.profileId === 'mesh-default-qwen36-35b')

    expect(rotate.status).toBe(200)
    expect(afterEntry?.rotation).toBe(1)
    expect(afterEntry?.tokenCount).toBe(0)
    expect(afterEntry?.secretAgeMs).toBeUndefined()
  })
})

describe('Access-first setup and host gating contracts', () => {
  const NOW = 1_700_000_000_000
  const TEAM = 'example-team.cloudflareaccess.com'
  const AUD = 'aud-mesh-admin'
  const HOST = 'mesh.example.com'

  function accessConfig(): Record<string, unknown> {
    return { teamDomain: TEAM, audience: AUD, appId: 'app-1', bypassAppId: 'app-2', adminEmails: ['operator@example.com'] }
  }

  function provisionedDomain(): Record<string, unknown> {
    return { hostname: HOST, zoneId: 'zone-1', zoneName: 'example.com', dnsRecordId: 'dns-1', dnsRecordType: 'CNAME', routeId: 'route-1', routePattern: `${HOST}/*`, workerName: 'router', status: 'provisioned' }
  }

  function accessPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      aud: [AUD],
      iss: `https://${TEAM}`,
      email: 'operator@example.com',
      iat: Math.floor(NOW / 1000) - 60,
      exp: Math.floor(NOW / 1000) + 3600,
      ...overrides
    }
  }

  it('REQ-SEC-009 requires a valid Access JWT on admin routes once access config is stored', async () => {
    resetJwksCache()
    const key = await accessTestKey('key-1')
    const store = new MemoryStore()
    await store.putConfig('access_config', accessConfig())
    const { router } = routerFixture({ store, jwksFetcher: accessJwksFetcher([key.jwk]) })

    const bearerOnly = await router(new Request(`https://${HOST}/admin/status`, { headers: bearer('admin-secret') }))
    expect(bearerOnly.status).toBe(401)

    const jwt = await signAccessJwt(key, accessPayload())
    const withJwt = await router(new Request(`https://${HOST}/admin/status`, { headers: { 'cf-access-jwt-assertion': jwt } }))
    expect(withJwt.status).toBe(200)

    const garbled = await router(new Request(`https://${HOST}/admin/status`, { headers: { 'cf-access-jwt-assertion': 'not-a-jwt', ...bearer('admin-secret') } }))
    expect(garbled.status).toBe(401)
  })

  it('REQ-SEC-009 records the Access email as the audit actor for admin actions', async () => {
    resetJwksCache()
    const key = await accessTestKey('key-1')
    const store = new MemoryStore()
    await store.putConfig('access_config', accessConfig())
    const { router } = routerFixture({ store, jwksFetcher: accessJwksFetcher([key.jwk]) })
    const jwt = await signAccessJwt(key, accessPayload())
    const response = await router(new Request(`https://${HOST}/admin/setup-tokens`, { method: 'POST', headers: { 'cf-access-jwt-assertion': jwt } }))
    expect(response.status).toBe(201)
    const audit = await store.listAudit(5)
    const created = audit.find((event) => event.type === 'setup_token_created')
    expect(created?.actor).toBe('operator@example.com')
  })

  it('REQ-ADM-005 REQ-ADM-011 provisions the domain step and advances the setup phase', async () => {
    const store = new MemoryStore()
    await store.putConfig('setup_state', { phase: 'claimed', claimedAt: NOW })
    const provisionCalls: unknown[] = []
    const { router } = routerFixture({
      store,
      env: { CLOUDFLARE_ACCOUNT_ID: 'acct-1' },
      cloudflareClient: {
        syncCustomProvider: async () => { throw new Error('unused') },
        provisionCustomDomain: async (input: unknown) => {
          provisionCalls.push(input)
          return { hostname: HOST, zoneId: 'zone-1', zoneName: 'example.com', dnsRecordId: 'dns-1', dnsRecordType: 'CNAME' as const, routeId: 'route-1', routePattern: `${HOST}/*`, workerName: 'router', status: 'provisioned' as const }
        }
      }
    })
    const response = await router(new Request('https://router.example.workers.dev/admin/setup/domain', {
      method: 'POST',
      headers: bearer('admin-secret'),
      body: JSON.stringify({ hostname: HOST })
    }))
    expect(response.status).toBe(200)
    expect(provisionCalls).toHaveLength(1)
    expect(await store.getConfig('custom_domain')).toMatchObject({ hostname: HOST, status: 'provisioned' })
    expect(await store.getConfig('setup_state')).toMatchObject({ phase: 'domain_ready' })
  })

  it('REQ-ADM-005 lists account zones for the domain step', async () => {
    const { router } = routerFixture({
      env: { CLOUDFLARE_ACCOUNT_ID: 'acct-1' },
      cloudflareClient: {
        syncCustomProvider: async () => { throw new Error('unused') },
        provisionCustomDomain: async () => { throw new Error('unused') },
        listZones: async () => [{ id: 'zone-1', name: 'example.com' }, { id: 'zone-2', name: 'example.org' }]
      }
    })
    const unauthorized = await router(new Request('https://router.example.workers.dev/admin/cloudflare/zones'))
    expect(unauthorized.status).toBe(401)
    const response = await router(new Request('https://router.example.workers.dev/admin/cloudflare/zones', { headers: bearer('admin-secret') }))
    expect(response.status).toBe(200)
    const body = await response.json() as { zones: readonly { id: string; name: string }[] }
    expect(body.zones.map((zone) => zone.id)).toEqual(['zone-1', 'zone-2'])
  })

  it('REQ-ADM-012 provisions Access from captured emails and stores the config', async () => {
    const store = new MemoryStore()
    await store.putConfig('custom_domain', provisionedDomain())
    await store.putConfig('setup_state', { phase: 'domain_ready' })
    const provisionCalls: { accountId: string; hostname: string; adminEmails: readonly string[] }[] = []
    const { router } = routerFixture({
      store,
      env: { CLOUDFLARE_ACCOUNT_ID: 'acct-1' },
      accessClient: {
        provisionAccess: async (input: { accountId: string; hostname: string; adminEmails: readonly string[] }) => {
          provisionCalls.push(input)
          return { teamDomain: TEAM, audience: AUD, appId: 'app-1', bypassAppId: 'app-2', adminEmails: input.adminEmails }
        }
      }
    })
    const invalid = await router(new Request('https://router.example.workers.dev/admin/setup/access', {
      method: 'POST', headers: bearer('admin-secret'), body: JSON.stringify({ emails: [] })
    }))
    expect(invalid.status).toBe(400)

    const response = await router(new Request('https://router.example.workers.dev/admin/setup/access', {
      method: 'POST', headers: bearer('admin-secret'), body: JSON.stringify({ emails: ['operator@example.com', 'sre@example.com'] })
    }))
    expect(response.status).toBe(200)
    expect(provisionCalls[0]).toEqual({ accountId: 'acct-1', hostname: HOST, adminEmails: ['operator@example.com', 'sre@example.com'] })
    expect(await store.getConfig('access_config')).toMatchObject({ teamDomain: TEAM, audience: AUD, appId: 'app-1', bypassAppId: 'app-2' })
    expect(await store.getConfig('setup_state')).toMatchObject({ phase: 'access_ready' })
    const body = await response.json() as { consoleUrl: string }
    expect(body.consoleUrl).toBe(`https://${HOST}/admin`)
  })

  it('REQ-ADM-012 refuses Access provisioning before the custom domain is provisioned', async () => {
    const { router } = routerFixture({
      env: { CLOUDFLARE_ACCOUNT_ID: 'acct-1' },
      accessClient: { provisionAccess: async () => { throw new Error('unused') } }
    })
    const response = await router(new Request('https://router.example.workers.dev/admin/setup/access', {
      method: 'POST', headers: bearer('admin-secret'), body: JSON.stringify({ emails: ['operator@example.com'] })
    }))
    expect(response.status).toBe(409)
  })

  it('REQ-ADM-014 locks non-custom-domain hosts after setup completes', async () => {
    const store = new MemoryStore()
    await store.putConfig('custom_domain', provisionedDomain())
    await store.putConfig('setup_state', { phase: 'complete', completedAt: NOW })
    const { router } = routerFixture({ store })

    const movedPage = await router(new Request('https://router.example.workers.dev/'))
    expect(movedPage.status).toBe(200)
    const movedHtml = await movedPage.text()
    expect(movedHtml).toContain(`https://${HOST}/admin`)
    expect(movedHtml).not.toContain('admin-ui-config')

    const chat = await router(new Request('https://router.example.workers.dev/v1/chat/completions', { method: 'POST', headers: bearer('provider-secret'), body: '{}' }))
    expect(chat.status).toBe(410)
    const heartbeat = await router(new Request('https://router.example.workers.dev/node/heartbeat', { method: 'POST', body: '{}' }))
    expect(heartbeat.status).toBe(410)
    const adminApi = await router(new Request('https://router.example.workers.dev/admin/status', { headers: bearer('admin-secret') }))
    expect(adminApi.status).toBe(410)

    const customDomainShell = await router(new Request(`https://${HOST}/admin`))
    expect(customDomainShell.status).toBe(200)
    expect(await customDomainShell.text()).toContain('admin-ui-config')
    const customDomainStatus = await router(new Request(`https://${HOST}/admin/status`, { headers: bearer('admin-secret') }))
    expect(customDomainStatus.status).toBe(200)
  })

  it('REQ-ADM-013 reopens the bootstrap origin while the reopen secret is unconsumed and audits entry once', async () => {
    const store = new MemoryStore()
    await store.putConfig('custom_domain', provisionedDomain())
    await store.putConfig('setup_state', { phase: 'complete', completedAt: NOW })
    const { router } = routerFixture({ store, env: { SETUP_REOPEN: 'reopen-1' } })

    const recovery = await router(new Request('https://router.example.workers.dev/'))
    expect(recovery.status).toBe(200)
    expect(await recovery.text()).toContain('admin-ui-config')
    await router(new Request('https://router.example.workers.dev/'))
    const audit = await store.listAudit(10)
    expect(audit.filter((event) => event.type === 'break_glass_entered')).toHaveLength(1)

    const adminApi = await router(new Request('https://router.example.workers.dev/admin/status', { headers: bearer('admin-secret') }))
    expect(adminApi.status).toBe(200)
    const machine = await router(new Request('https://router.example.workers.dev/node/heartbeat', { method: 'POST', body: '{}' }))
    expect(machine.status).toBe(410)
  })

  it('REQ-ADM-013 consuming the reopen secret closes the recovery surface', async () => {
    const store = new MemoryStore()
    await store.putConfig('custom_domain', provisionedDomain())
    await store.putConfig('setup_state', { phase: 'access_ready' })
    const { router } = routerFixture({ store, env: { SETUP_REOPEN: 'reopen-1' } })

    const complete = await router(new Request('https://router.example.workers.dev/admin/setup/complete', { method: 'POST', headers: bearer('admin-secret') }))
    expect(complete.status).toBe(200)
    expect(await store.getConfig('setup_state')).toMatchObject({ phase: 'complete' })
    expect(await store.getConfig('setup_reopen_consumed')).toBe(await hashToken('reopen-1'))
    const audit = await store.listAudit(10)
    expect(audit.some((event) => event.type === 'break_glass_completed')).toBe(true)
    expect(audit.some((event) => event.type === 'setup_completed')).toBe(true)

    const locked = await router(new Request('https://router.example.workers.dev/'))
    expect(await locked.text()).not.toContain('admin-ui-config')
  })

  it('REQ-ADM-013 completing setup requires the access-ready phase', async () => {
    const store = new MemoryStore()
    await store.putConfig('setup_state', { phase: 'claimed' })
    const { router } = routerFixture({ store })
    const premature = await router(new Request('https://router.example.workers.dev/admin/setup/complete', { method: 'POST', headers: bearer('admin-secret') }))
    expect(premature.status).toBe(409)
  })

  it('REQ-GWY-005 lists gateways, routes, and defaults for the gateway step', async () => {
    const routeCalls: string[] = []
    const { router } = routerFixture({
      env: { CLOUDFLARE_ACCOUNT_ID: 'acct-1', AI_GATEWAY_ID: 'inference-mesh' },
      cloudflareClient: {
        syncCustomProvider: async () => { throw new Error('unused') },
        provisionCustomDomain: async () => { throw new Error('unused') },
        listGateways: async () => [{ id: 'inference-mesh' }, { id: 'other-gw' }],
        listRoutes: async (_accountId: string, gatewayId: string) => {
          routeCalls.push(gatewayId)
          return [{ id: 'route-1', name: 'mesh-default', enabled: true }]
        }
      }
    })
    const response = await router(new Request('https://router.example.workers.dev/admin/cloudflare/gateway/options', { headers: bearer('admin-secret') }))
    expect(response.status).toBe(200)
    const body = await response.json() as { gateways: readonly { id: string }[]; routes: readonly { name?: string }[]; defaults: { gatewayId: string; routeName: string; publicModel: string } }
    expect(body.gateways.map((gateway) => gateway.id)).toEqual(['inference-mesh', 'other-gw'])
    expect(body.routes.map((route) => route.name)).toEqual(['mesh-default'])
    expect(body.defaults).toMatchObject({ gatewayId: 'inference-mesh', routeName: 'mesh-default' })
    expect(routeCalls).toEqual(['inference-mesh'])

    const selected = await router(new Request('https://router.example.workers.dev/admin/cloudflare/gateway/options?gateway=other-gw', { headers: bearer('admin-secret') }))
    expect(selected.status).toBe(200)
    expect(routeCalls).toEqual(['inference-mesh', 'other-gw'])
  })

  it('REQ-ADM-004 installer commands use the custom domain once recorded', async () => {
    const store = new MemoryStore()
    await store.putConfig('custom_domain', provisionedDomain())
    const { router } = routerFixture({ store })
    const response = await router(new Request(`https://${HOST}/admin/installers/linux`, { headers: bearer('admin-secret') }))
    expect(response.status).toBe(200)
    const command = await response.text()
    expect(command).toContain(`https://${HOST}`)
    expect(command).not.toContain('router.example.workers.dev')
  })
})
