import { describe, expect, it } from 'vitest'
import { ADMIN_UI_ACTIONS, ADMIN_UI_CONFIRM, ADMIN_UI_NAV, ADMIN_UI_RESPONSIVE, ADMIN_UI_SETUP_LOCKED_FEEDBACK, ADMIN_UI_VIEWS, ADMIN_UI_WIZARD } from './admin-ui'
import { ADMIN_UI_CLIENT_SCRIPT } from './admin-ui-client'
import { adminUiHarness, descendants, elementStub } from './admin-ui-harness'
import { resetJwksCache } from './access'
import { createTokenRecord, hashToken, timingSafeEqualText } from './auth'
import { CloudflareGatewayClient } from './cloudflare-api'
import { installerPlan, SETUP_TOKEN_PLACEHOLDER } from './installers'
import { buildCustomProfile, DEFAULT_MODEL_PROFILES, STABLE_PUBLIC_MODEL } from './profiles'
import { createRouter } from './router'
import { isSafeMeshTarget, StoreScheduler } from './scheduler'
import { accessJwksFetcher, accessTestKey, MemoryStore, nodeFixture, signAccessJwt } from './test-helpers'
import type { LastSpeedTestSummary, ModelProfile, NodeRecord } from './types'

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
  const scheduler = overrides.scheduler ?? new StoreScheduler(store)
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
      ...(overrides.jwksFetcher !== undefined ? { jwksFetcher: overrides.jwksFetcher } : {}),
      ...(overrides.identityFetcher !== undefined ? { identityFetcher: overrides.identityFetcher } : {}),
      ...(overrides.playgroundFetcher !== undefined ? { playgroundFetcher: overrides.playgroundFetcher } : {})
    })
  }
}

function bearer(token: string): HeadersInit {
  return { authorization: `Bearer ${token}` }
}

// The 35B profiles left the shipped catalog (it is now the single smoke starter).
// Tests that exercise multi-profile behavior seed them as ordinary stored profiles.
const LEGACY_MESH_DEFAULT: ModelProfile = {
  id: 'mesh-default-qwen36-35b',
  displayName: 'Qwen3.6 35B',
  publicAliases: ['codeflare-mesh', 'qwen3.6:35b-a3b', 'qwen3.6-coder'],
  upstreamModel: 'unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ3_S',
  sourceMode: 'meshllm-ref',
  contextWindow: 262144,
  runtime: 'meshllm',
  meshllm: { modelRef: 'unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ3_S', split: false, bindPort: 4300 },
  version: 1,
  rolloutPercent: 0,
  active: false,
  meshId: 'default'
}
const LEGACY_MESH_SPLIT: ModelProfile = {
  ...LEGACY_MESH_DEFAULT,
  id: 'mesh-split-qwen36-35b',
  displayName: 'Qwen3.6 35B (multi-machine)',
  upstreamModel: 'hf://meshllm/Qwen3.6-35B-A3B-UD-Q4_K_XL-layers@9b24bdc3dfb174ad6848f3f71c34f5302fa4dcfd',
  meshllm: { modelRef: 'hf://meshllm/Qwen3.6-35B-A3B-UD-Q4_K_XL-layers@9b24bdc3dfb174ad6848f3f71c34f5302fa4dcfd', split: true, bindPort: 4310 }
}
async function seedLegacyDefaults(store: MemoryStore): Promise<void> {
  await store.setProfile(LEGACY_MESH_DEFAULT)
  await store.setProfile(LEGACY_MESH_SPLIT)
}

const QWEN_UPSTREAM = 'unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ3_S'
const SMOKE_UPSTREAM = 'unsloth/Qwen2.5-Coder-1.5B-Instruct-GGUF:Q4_K_M'
const MESH_STATE_KEY_B64 = `${'A'.repeat(43)}=`

function legacyRuntimeProfile(input: { id: string; publicAliases: readonly string[]; version: number }): ModelProfile {
  return {
    id: input.id,
    displayName: input.id,
    publicAliases: input.publicAliases,
    upstreamModel: input.id,
    sourceMode: 'legacy-source',
    contextWindow: 262144,
    runtime: 'legacy-runtime',
    meshllm: { modelRef: input.id, split: false, bindPort: 4990 },
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
    publicModels: ['codeflare-mesh'],
    activeProfileIds: ['mesh-smoke-qwen25-1.5b'],
    capacity: 2,
    inFlight: 0,
    runtime: 'meshllm',
    metrics: { runtimeState: 'ready', activeRequests: 0, apiReady: true, readyModels: [SMOKE_UPSTREAM] },
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
  readonly state: { view: string; phase: string; customDomain?: string; recovery?: boolean }
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
  it('REQ-ADM-006 REQ-ADM-035 serves a responsive browser admin UI for every admin-facing function', async () => {
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
      'setup-domain',
      'setup-access',
      'setup-complete',
      'zones-refresh',
      'gateway-options',
      'gateway-provision-status',
      'status-refresh',
      'setup-token-create',
      'installer-linux',
      'installer-macos',
      'installer-windows',
      'gateway-sync',
      'custom-domain-validate',
      'node-revoke',
      'node-deactivate',
      'node-activate',
      'mesh-create',
      'mesh-delete',
      'profile-rollout',
      'profile-activate',
      'profile-config',
      'profile-duplicate',
      'agent-versions-refresh',
      'agent-version-set',
      'runtime-versions-refresh',
      'runtime-versions-set',
      'settings-save',
      'mesh-rotate',
      'playground-chat',
      'playground-direct'
    ])
    expect(config.actions.filter((action) => action.auth === 'admin').map((action) => action.path)).toEqual([
      '/admin/login',
      '/admin/setup/domain',
      '/admin/setup/access',
      '/admin/setup/complete',
      '/admin/cloudflare/zones',
      '/admin/cloudflare/gateway/options',
      '/admin/cloudflare/gateway/provision-status',
      '/admin/status',
      '/admin/setup-tokens',
      '/admin/installers/linux',
      '/admin/installers/macos',
      '/admin/installers/windows',
      '/admin/cloudflare/gateway/sync',
      '/admin/custom-domain/validate',
      '/admin/nodes/{nodeId}/revoke',
      '/admin/nodes/{nodeId}/deactivate',
      '/admin/nodes/{nodeId}/activate',
      '/admin/meshes',
      '/admin/meshes/{meshId}',
      '/admin/profiles/rollout',
      '/admin/profiles/activate',
      '/admin/profiles/config',
      '/admin/profiles/duplicate',
      '/admin/agent-versions',
      '/admin/agent-version',
      '/admin/runtime-versions',
      '/admin/runtime-versions',
      '/admin/settings',
      '/admin/mesh/rotate',
      '/admin/playground/chat',
      '/admin/playground/direct-chat'
    ])
    expect(config.responsive).toEqual({ mobileBreakpointPx: 760, desktopMinColumns: 1, minTouchTargetPx: 44 })
    expect(config.views).toEqual({ modes: ['setup', 'dashboard'], attribute: 'data-view' })
    expect(config.nav).toEqual({ sections: ['overview', 'nodes', 'models', 'routing', 'playground', 'settings'] })
    expect(config.wizard).toEqual({
      steps: ['connect', 'domain', 'access', 'gateway', 'node', 'review'],
      skippable: ['gateway', 'node'],
      phaseSteps: { unclaimed: 'connect', claimed: 'domain', domain_ready: 'access', access_ready: 'gateway', complete: 'review' }
    })
    expect(config.confirm).toEqual({ attribute: 'data-confirm', disarmMs: 5000 })
    expect(config.setupLockedFeedback).toEqual({ status: 401, variant: 'setup-locked' })
    const controls = new Set([...html.matchAll(/data-action="([^"]+)"/g)].map((match) => match[1]))
    // mesh-rotate is no longer a server-rendered control: the sharing-key reset lives in
    // a model's Manage drawer, rendered client-side, so it is not in the initial HTML.
    const serverControls = ['first-run-setup', 'setup-domain', 'access-ident-add', 'setup-access', 'setup-complete', 'gateway-provision-default', 'status-refresh', 'setup-token-create', 'gateway-sync', 'custom-domain-validate', 'agent-versions-refresh', 'agent-version-set', 'runtime-versions-refresh', 'runtime-versions-set', 'settings-save', 'playground-send', 'sign-out']
    serverControls.forEach((action) => expect(controls.has(action), `missing control ${action}`).toBe(true))
    const apiDocLinks = [...html.matchAll(/data-api-docs-link="([^"]+)"/g)].map((match) => match[1])
    expect(apiDocLinks).toEqual(config.actions.map((action) => action.id))
    // The full href is the contract, branch included: a link into a deleted branch is a
    // dead Docs button even though the path and anchor look right.
    expect(html).toContain('https://github.com/nikolanovoselec/codeflare-inference-mesh/blob/develop/documentation/lanes/api-reference-admin.md#post-adminsetup')
    expect(html).toContain('data-login-form="true"')
    expect(html).toContain('data-installer-platform="true"')
    // Only the wizard keeps a zone picker; Routing matches the zone from the hostname server-side.
    expect([...html.matchAll(/name="zoneId"/g)]).toHaveLength(1)
    // Routing discovers the gateway from the runtime token; the route is pinned to codeflare-mesh
    // server-side, so no route picker is rendered — only a gateway select and a provider-name field.
    expect(html).toContain('id="rt-gateway-select"')
    expect(html).not.toContain('id="rt-route-select"')
    expect(html).toContain('id="rt-gateway-provider-name"')
    expect(html).not.toContain('id="gateway-account-id"')
    expect(html).not.toContain('id="custom-domain-zone"')
    const liveOutputSurfaces = [...html.matchAll(/data-output="[^"]+"[^>]*role="log"[^>]*aria-live="polite"/g)]
    expect(liveOutputSurfaces.length).toBeGreaterThanOrEqual(12)
    expect(html).toMatch(/<meta name="viewport" content="width=device-width, initial-scale=1">/)
    expect(html).toMatch(/<meta name="color-scheme" content="dark">/)
    expect(html).toMatch(/<link rel="icon" href="data:image\/svg\+xml/)
    expect(html).toContain('<noscript>')
    expect(html).toMatch(/@media \(max-width:760px\)/)
    expect(html).not.toContain('class="tab-bar"')
    expect(html).toContain('id="mobile-menu-toggle"')
    expect(html).toContain('aria-label="Open menu"')
    expect(html).toContain('M3,6H21V8H3V6M3,11H21V13H3V11M3,16H21V18H3V16Z')
    expect(html).not.toContain('>Menu</button>')
    expect(html).toContain('id="mobile-menu"')
    // The served behavior script is the pure literal, byte for byte: nothing is
    // serialized from bundled code, so bundler helpers (__name) cannot leak in.
    expect(adminUiScript(html)).toBe(ADMIN_UI_CLIENT_SCRIPT)
    expect(html).not.toContain('__name')
    expect(() => new Function(adminUiScript(html))).not.toThrow()
  })

  it('REQ-ADM-007 pre-renders the entry view from host and setup phase', async () => {
    // AdminEntryViewTestAnchor
    const { router, store } = routerFixture()
    const fresh = await (await router(new Request('https://router.test/'))).text()
    expect(fresh).toContain('<body data-view="setup">')
    expect(fresh).not.toMatch(/id="view-setup"[^>]*hidden/)
    expect(fresh).toMatch(/id="view-dashboard" hidden/)
    expect(adminUiConfig(fresh).state).toMatchObject({ view: 'setup', phase: 'unclaimed' })

    const setup = await router(new Request('https://router.test/admin/setup', { method: 'POST' }))
    expect(setup.status).toBe(201)
    const claimed = await (await router(new Request('https://router.test/'))).text()
    expect(claimed).toContain('<body data-view="setup">')
    expect(adminUiConfig(claimed).state).toMatchObject({ view: 'setup', phase: 'claimed' })

    await store.putConfig('custom_domain', { hostname: 'mesh.example.com', status: 'provisioned' })
    await store.putConfig('setup_state', { phase: 'complete', completedAt: 1_700_000_000_000 })
    const dashboard = await (await router(new Request('https://mesh.example.com/admin'))).text()
    expect(dashboard).toContain('<body data-view="dashboard">')
    expect(adminUiConfig(dashboard).state).toMatchObject({ view: 'dashboard', phase: 'complete', customDomain: 'mesh.example.com' })
    expect(dashboard).toMatch(/id="view-setup"[^>]*hidden/)
    expect(dashboard).not.toMatch(/id="view-dashboard" hidden/)
  })

  it('REQ-ADM-007 serves a sectioned operator dashboard with persistent navigation', async () => {
    // AdminDashboardNavTestAnchor
    const { router } = routerFixture()
    const html = await (await router(new Request('https://router.test/admin'))).text()
    const config = adminUiConfig(html)
    const sections = [...html.matchAll(/data-section="([^"]+)"/g)].map((match) => match[1])
    const navTargets = [...html.matchAll(/class="nav-item" href="#([^"]+)"/g)].map((match) => match[1])
    const sectionIds = new Set([...html.matchAll(/<section class="panel section-panel" id="([^"]+)"/g)].map((match) => match[1]))

    expect(sections).toEqual(['overview', 'nodes', 'models', 'routing', 'playground', 'settings'])
    expect([...config.nav.sections]).toEqual(sections)
    expect(navTargets.slice(0, 6)).toEqual(sections)
    expect(navTargets.slice(6)).toEqual(sections)
    expect(navTargets.every((target) => sectionIds.has(target))).toBe(true)
    expect(html.match(/data-mobile-menu="([^"]+)"/)?.[1]).toBe('overview nodes models routing playground settings')
    expect(html).not.toContain('data-mobile-tabs=')
    expect(html).not.toContain('class="tab-item"')
    expect([...html.matchAll(/data-active="true"/g)]).toHaveLength(1)
    expect(html).toMatch(/<a[^>]*data-nav="overview"[^>]*aria-current="page"/)
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
    const expectedSteps = [...ADMIN_UI_WIZARD.steps]
    const expectedStepList = expectedSteps.join(' ')

    expect(html.match(/data-wizard="([^"]+)"/)?.[1]).toBe(expectedStepList)
    expect([...html.matchAll(/<li data-step="([^"]+)"/g)].map((match) => match[1])).toEqual(expectedSteps)
    expect(html).toMatch(/<li data-step="connect" aria-current="step">/)
    expect([...html.matchAll(/data-step-panel="([^"]+)"/g)].map((match) => match[1])).toEqual(expectedSteps)
    const setupHeroAt = html.indexOf('data-setup-hero="true"')
    const setupRailAt = html.indexOf('class="setup-rail"')
    const setupPanelsAt = html.indexOf('class="setup-panels"')
    expect(setupHeroAt).toBeGreaterThan(-1)
    expect(setupRailAt).toBeGreaterThan(setupHeroAt)
    expect(setupPanelsAt).toBeGreaterThan(setupRailAt)
    const setupHero = html.slice(setupHeroAt, setupRailAt)
    expect(setupHero).toContain('data-scramble')
    expect(html).toContain('grid-template-areas:"setup-hero" "setup-body"')
    expect(html).toContain('.setup-layout{grid-area:setup-body;')
    expect(html).toContain('.dashboard-hero.setup-hero{grid-area:setup-hero}')
    expect([...html.matchAll(/data-setup-stat="([^"]+)"/g)].map((match) => match[1])).toEqual(['claim', 'domain', 'access', 'route', 'node'])
    expect(html.indexOf(`data-stepper="${expectedStepList}"`)).toBeGreaterThan(setupRailAt)
    expect(html.indexOf(`data-stepper="${expectedStepList}"`)).toBeLessThan(setupPanelsAt)
    expect(html).not.toMatch(/data-step-panel="connect"[^>]*hidden/)
    expect(html).toMatch(/data-step-panel="domain"[^>]*hidden/)
    expect(html).toMatch(/data-step-panel="gateway"[^>]*hidden/)
    expect(html).toMatch(/data-step-panel="review"[^>]*hidden/)
    const gatewayStep = html.slice(html.indexOf('id="step-gateway"'), html.indexOf('id="step-node"'))
    const nodeStep = html.slice(html.indexOf('id="step-node"'), html.indexOf('id="step-review"'))
    const reviewStep = html.slice(html.indexOf('id="step-review"'))
    expect(gatewayStep).toContain('data-wizard-next')
    expect(nodeStep).toContain('data-wizard-next')
    expect(html).toMatch(/id="wizard-continue-connect" hidden/)
    expect(html).toContain('id="connect-signin"')
    expect(html).toContain('data-login-form="true"')
    expect(html).toContain('data-zone-select="true"')
    expect(html).toContain('data-ident-chips="admin"')
    expect(html).toMatch(/id="wizard-handoff" hidden/)
    expect(html).toMatch(/id="wizard-gateway-empty" hidden/)
    expect(reviewStep).toContain('data-action="setup-complete"')
    // The wizard enroll step tags its create-token button with the wizard prefix, so the minted
    // token fills the wizard's own install-command output rather than the Nodes panel's.
    expect(nodeStep).toMatch(/data-action="setup-token-create"[^>]*data-prefix="wiz-"/)
  })

  it('REQ-ADM-019 renders setup-locked recovery affordances instead of raw JSON', async () => {
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

  it('REQ-GWY-003 connects a gateway from Routing using the discovered gateway and provider name only', async () => {
    const { router } = routerFixture()
    const html = await (await router(new Request('https://router.test/admin'))).text()
    const harness = adminUiHarness(html, async () => Response.json({ deploymentId: 'deployment-a' }), { sessionToken: 'admin-secret' })
    harness.run()
    // No account id, route, public model, or worker URL to type — only the gateway and provider name.
    harness.byId('rt-gateway-new').value = 'gateway-admin'
    harness.byId('rt-gateway-provider-name').value = 'Mesh Provider'

    await harness.clickAction('gateway-sync', { out: 'gateway-output', prefix: 'rt-' })

    expect(harness.fetchCalls).toHaveLength(1)
    expect(harness.fetchCalls[0]!.path).toBe('/admin/cloudflare/gateway/sync')
    expect(harness.fetchCalls[0]!.init?.method).toBe('POST')
    expect(harness.fetchCalls[0]!.init?.headers).toMatchObject({ authorization: 'Bearer admin-secret', 'content-type': 'application/json' })
    // Account id, worker url, route, and public model are all resolved/pinned server-side; the client
    // posts only the chosen gateway and the provider name, never a route or public model.
    expect(JSON.parse(String(harness.fetchCalls[0]!.init?.body))).toEqual({ gatewayId: 'gateway-admin', providerName: 'Mesh Provider' })
    expect(harness.byId('gateway-output').textContent).toBe('Gateway provisioned.')
  })

  it('REQ-GWY-002 gateway sync mints and reveals a fresh provider key, rotating prior ones', async () => {
    // ProviderKeyAtGatewayTestAnchor
    const gatewayResult = { providerId: 'prov', providerSlug: 'custom-inference-mesh-router-test', routeId: 'route', routeVersionId: 'ver', deploymentId: 'dep', gatewayId: 'inference-mesh', routeName: 'codeflare-mesh', publicModel: 'codeflare-mesh', workerUrl: 'https://mesh.example.com', manualProviderKeyRequired: true as const, providerTokenInstructions: 'x' }
    const { router, store } = routerFixture({
      env: { CLOUDFLARE_ACCOUNT_ID: 'acct-1', AI_GATEWAY_ID: 'inference-mesh' },
      cloudflareClient: {
        syncCustomProvider: async () => gatewayResult,
        provisionCustomDomain: async () => { throw new Error('unused') }
      }
    })
    await store.putConfig('custom_domain', { hostname: 'mesh.example.com', status: 'provisioned' })

    const first = await router(new Request('https://router.test/admin/cloudflare/gateway/sync', { method: 'POST', headers: bearer('admin-secret') }))
    const firstBody = await first.json() as { providerToken: string; byokInstruction: string }
    expect(first.status).toBe(200)
    expect(firstBody.providerToken).toMatch(/^provider_/)
    expect(firstBody.byokInstruction).toContain('custom-inference-mesh-router-test')
    const afterFirst = store.tokens.filter((token) => token.kind === 'provider' && token.active)
    expect(afterFirst).toHaveLength(1)
    expect(afterFirst[0]!.verifier).not.toBe(firstBody.providerToken)

    const second = await router(new Request('https://router.test/admin/cloudflare/gateway/sync', { method: 'POST', headers: bearer('admin-secret') }))
    const secondBody = await second.json() as { providerToken: string }
    expect(secondBody.providerToken).not.toBe(firstBody.providerToken)
    const afterSecond = store.tokens.filter((token) => token.kind === 'provider' && token.active)
    expect(afterSecond).toHaveLength(1)
    expect(afterSecond[0]!.verifier).not.toBe(afterFirst[0]!.verifier)
  })

  it('REQ-ADM-019 surfaces an actionable message when Gateway sync fails', async () => {
    const { router, store } = routerFixture({
      env: { CLOUDFLARE_ACCOUNT_ID: 'acct-1', AI_GATEWAY_ID: 'inference-mesh' },
      cloudflareClient: {
        syncCustomProvider: async () => { throw new Error('Cloudflare API failed: 403 10000 Authentication error') },
        provisionCustomDomain: async () => { throw new Error('unused') }
      }
    })
    await store.putConfig('custom_domain', { hostname: 'mesh.example.com', status: 'provisioned' })

    const res = await router(new Request('https://router.test/admin/cloudflare/gateway/sync', { method: 'POST', headers: bearer('admin-secret') }))
    const body = await res.json() as { error?: string; providerToken?: string }

    // A 4xx keeps the client from collapsing the failure to the generic 5xx "temporary error" copy.
    expect(res.status).toBe(424)
    expect(body.error).toBeTruthy()
    expect(body.error).not.toBe('internal_error')
    // No provider key is minted when the sync never completed.
    expect(body.providerToken).toBeUndefined()
    expect(store.tokens.some((token) => token.kind === 'provider' && token.active)).toBe(false)
    // The raw cause is retained for support without being shown to the operator.
    const failure = store.audit.find((event) => event.type === 'gateway_sync_failed')
    expect(failure).toBeDefined()
    expect((failure!.detail as { reason?: string }).reason).toContain('403')
  })

  it('REQ-SEC-011 rate-limits a public endpoint before reaching its handler', async () => {
    const over = { limit: async () => ({ success: false }) }
    const { router } = routerFixture({ env: { RL_INFERENCE: over } })
    // A bad token would normally 401; the 429 proves the limiter short-circuits before auth + body read.
    const res = await router(new Request('https://router.test/v1/chat/completions', { method: 'POST', headers: { ...bearer('nope'), 'content-type': 'application/json' }, body: '{}' }))
    const body = await res.json() as { error: string }
    expect(res.status).toBe(429)
    expect(body.error).toBe('rate_limited')
    expect(res.headers.get('retry-after')).toBe('60')
  })

  it('REQ-SEC-011 lets a request through to its handler when under the limit', async () => {
    const under = { limit: async () => ({ success: true }) }
    const { router } = routerFixture({ env: { RL_INFERENCE: under } })
    // Under the limit the request reaches handleModels and fails auth (401), not 429.
    const res = await router(new Request('https://router.test/v1/models', { headers: bearer('bad-token') }))
    expect(res.status).toBe(401)
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
    expect(harness.byId('node-output').textContent).toBe('Machine revoked.')
  })

  it('REQ-ADM-006 reveals only the one-time bootstrap token at claim', async () => {
    const { router } = routerFixture()
    const html = await (await router(new Request('https://router.test/'))).text()
    const harness = adminUiHarness(html, async () => Response.json({ adminToken: 'admin-a' }, { status: 201 }))
    harness.run()

    await harness.clickAction('first-run-setup', { out: 'setup-output' })
    const output = harness.byId('setup-output')
    const cards = output.children.filter((child) => child.dataset.tokenCard)

    expect(output.children[0]!.dataset.tokenWarning).toBe('true')
    // Exactly one credential is shown — the bootstrap token — and no machine tokens.
    expect(cards).toHaveLength(1)
    expect(cards[0]!.dataset.tokenCard).toBe('Setup access token')
    expect(cards[0]!.children.find((child) => child.tagName === 'code')!.textContent).toBe('admin-a')
    expect(cards[0]!.children.find((child) => child.dataset.copy)!.dataset.copy).toBe('admin-a')
    expect(output.children.find((child) => child.dataset.copyAll === 'true')).toBeUndefined()
    expect(harness.events.some((event) => event.kind === 'setItem' && event.detail === 'session:codeflareInferenceMeshAdminToken=admin-a')).toBe(true)
    expect(harness.byId('wizard-continue-connect').hidden).toBe(false)
  })

  it('REQ-ADM-006 auto-loads installer command for saved tokens and platform changes', async () => {
    const { router, store } = routerFixture()
    await store.putConfig('custom_domain', { hostname: 'mesh.example.com', status: 'provisioned' })
    await store.putConfig('setup_state', { phase: 'complete', completedAt: 1_700_000_000_000 })
    const html = await (await router(new Request('https://mesh.example.com/admin'))).text()
    expect(html).toContain('<body data-view="dashboard">')
    let releaseLinux: (() => void) | undefined
    const linuxWait = new Promise<void>((resolve) => { releaseLinux = resolve })
    const harness = adminUiHarness(html, async (path) => {
      if (path === '/admin/status') return Response.json({})
      if (path === '/admin/agent-versions') return Response.json({ tags: [], stale: false })
      if (path.endsWith('/linux')) await linuxWait
      return new Response('install command for ' + path, { status: 200, headers: { 'content-type': 'text/plain' } })
    }, { hostname: 'mesh.example.com' })
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

  it('REQ-OBS-012 REQ-RUN-013 keeps direct llama.cpp UI controls backed by admin API payloads', async () => {
    // DirectRuntimeUiParityTestAnchor
    const { router, store } = routerFixture()
    await store.putConfig('custom_domain', { hostname: 'mesh.example.com', status: 'provisioned' })
    await store.putConfig('setup_state', { phase: 'complete', completedAt: 1_700_000_000_000 })
    const directProfile = {
      id: 'direct-qwen',
      displayName: 'Direct Qwen',
      publicAliases: ['codeflare-mesh', 'direct-qwen'],
      upstreamModel: 'unsloth/Qwen3-14B-GGUF:Q4_K_M',
      contextWindow: 262144,
      active: true,
      rolloutPercent: 100,
      runtime: 'llamacpp',
      sourceMode: 'llamacpp-hf',
      version: 1,
      llamacpp: { alias: 'unsloth/Qwen3-14B-GGUF:Q4_K_M', modelRef: 'unsloth/Qwen3-14B-GGUF:Q4_K_M', hfRepo: 'unsloth/Qwen3-14B-GGUF', hfFile: 'qwen.gguf', quant: 'Q4_K_M', contextWindow: 262144, bindPort: 9338, parallel: 1, cachePrompt: true, cacheReuse: 256 }
    }
    const status = {
      nodes: [{ id: 'node-direct', displayName: 'Direct Node', meshIp: '100.64.1.20', inferencePort: 8080, localDashboardPort: 3131, status: 'online', publicModels: ['direct-qwen'], activeProfileIds: ['direct-qwen'], capacity: 1, inFlight: 0, lastSeenAt: Date.now(), runtime: 'llamacpp', metrics: { runtimeKind: 'llamacpp', runtimeState: 'ready', activeRequests: 0, tokensPerSecond: 12, readyModels: ['unsloth/Qwen3-14B-GGUF:Q4_K_M'], loadedModel: 'unsloth/Qwen3-14B-GGUF:Q4_K_M', gpuMemoryUsedMiB: 1024, gpuMemoryTotalMiB: 24576, llamacppVersion: 'b5000', ctxSize: 262144, parallel: 1, cachePrompt: true, cacheReuse: 256, slotCount: 1, activeSlots: 0, cachedTokensLast: 4096, apiReady: true, consoleReady: true } }],
      profiles: [directProfile],
      profileReadiness: [{ profileId: 'direct-qwen', ready: 1, failed: 0 }],
      meshHealth: [],
      audit: [],
      desiredAgentVersion: 'agent-v1',
      offlinePruneSeconds: 300
    }
    const html = await (await router(new Request('https://mesh.example.com/admin'))).text()
    const harness = adminUiHarness(html, async (path) => {
      if (path === '/admin/status') return Response.json(status)
      if (path === '/admin/agent-versions') return Response.json({ tags: [], stale: false })
      if (path.startsWith('/admin/cloudflare/gateway/options')) return Response.json({ gateways: [], routes: [], defaults: {} })
      if (path === '/admin/profiles/add') return Response.json({ ok: true, profileId: 'custom-direct' }, { status: 201 })
      if (path === '/admin/profiles/config') return Response.json({ ok: true, profileId: 'direct-qwen' })
      return new Response('install', { status: 200, headers: { 'content-type': 'text/plain' } })
    }, { hostname: 'mesh.example.com', sessionToken: 'admin-secret' })
    harness.run()
    await harness.flush(10)

    const addMode = harness.byId('model-add-mode')
    const addRuntime = harness.byId('model-add-runtime')
    addRuntime.value = 'llamacpp'
    addMode.value = 'split'
    addMode.dataset.modelAddMode = 'true'
    await harness.change(addMode)
    expect(addRuntime.disabled).toBe(true)
    expect(addRuntime.value).toBe('meshllm')

    addMode.value = 'single'
    await harness.change(addMode)
    addRuntime.value = 'llamacpp'
    harness.byId('model-add-ref').value = ' unsloth/Qwen3-14B-GGUF:Q4_K_M '
    await harness.clickAction('model-add', { out: 'profile-output' })
    const addCall = harness.fetchCalls.find((call) => call.path === '/admin/profiles/add')
    expect(JSON.parse(String(addCall?.init?.body))).toMatchObject({ modelRef: 'unsloth/Qwen3-14B-GGUF:Q4_K_M', mode: 'single', runtime: 'llamacpp' })

    const profileRow = harness.byId('profile-list').children.find((row) => row.dataset.profileRow === 'direct-qwen')
    expect(profileRow).toBeDefined()
    expect(descendants(profileRow!).find((item) => item.dataset.runtime)?.dataset.runtime).toBe('llamacpp')
    expect(descendants(profileRow!).find((item) => item.dataset.servingMode)?.dataset.servingMode).toBe('single')

    await harness.clickAction('model-detail', { profileId: 'direct-qwen' })
    const modelDrawer = descendants(harness.byId('drawer-body'))
    expect(modelDrawer.find((item) => item.dataset.drawerField === 'runtime')?.dataset.value).toBe('llamacpp')
    expect(modelDrawer.some((item) => item.id === 'model-edit-llama-parallel')).toBe(true)
    expect(modelDrawer.some((item) => item.id === 'model-edit-llama-kv-unified')).toBe(true)
    expect(modelDrawer.some((item) => item.id === 'model-edit-parallel')).toBe(false)
    expect(modelDrawer.some((item) => item.id === 'model-edit-vram')).toBe(false)

    harness.byId('model-edit-context').value = '131072'
    harness.byId('model-edit-llama-parallel').value = '2'
    harness.byId('model-edit-llama-gpu-layers').value = '99'
    harness.byId('model-edit-llama-cache-k').value = 'q4_0'
    harness.byId('model-edit-llama-cache-v').value = 'q4_0'
    harness.byId('model-edit-llama-batch').value = '8192'
    harness.byId('model-edit-llama-ubatch').value = '2048'
    harness.byId('model-edit-llama-flash').value = 'on'
    harness.byId('model-edit-llama-maxout').value = '8192'
    harness.byId('model-edit-llama-cache-prompt').value = 'off'
    harness.byId('model-edit-llama-cache-reuse').value = '512'
    harness.byId('model-edit-llama-reasoning').value = 'on'
    harness.byId('model-edit-llama-reasoning-format').value = 'deepseek'
    harness.byId('model-edit-llama-reasoning-budget').value = '4096'
    await harness.clickAction('model-save', { profileId: 'direct-qwen', runtime: 'llamacpp', out: 'model-edit-output' })
    const configCall = harness.fetchCalls.filter((call) => call.path === '/admin/profiles/config').at(-1)
    expect(JSON.parse(String(configCall?.init?.body))).toEqual({
      profileId: 'direct-qwen',
      runtime: 'llamacpp',
      contextWindow: 131072,
      modelRef: 'unsloth/Qwen3-14B-GGUF:Q4_K_M',
      llamacpp: { parallel: 2, kvUnified: true, cacheReuse: 512, cachePrompt: false, gpuLayers: '99', cacheTypeK: 'q4_0', cacheTypeV: 'q4_0', batch: 8192, ubatch: 2048, flashAttn: true, maxOutputTokens: 8192, reasoning: { enabled: true, format: 'deepseek', budget: 4096 } }
    })

    await harness.clickAction('node-detail', { nodeId: 'node-direct' })
    const nodeFields = new Map(descendants(harness.byId('drawer-body')).filter((item) => item.dataset.drawerField).map((item) => [item.dataset.drawerField, item.dataset.value]))
    expect(nodeFields.get('direct-context')).toBe('262144')
    expect(nodeFields.get('direct-parallel')).toBe('1')
    expect(nodeFields.get('direct-cached-tokens')).toBe('4096')
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
    const body = await response.json() as { adminToken: string }

    expect(response.status).toBe(201)
    // Claim reveals only the bootstrap token; machine tokens surface at their own steps.
    expect(Object.keys(body)).toEqual(['adminToken'])
    expect(store.tokens.every((token) => token.verifier.startsWith('sha256:'))).toBe(true)
    expect(timingSafeEqualText('sha256:same', 'sha256:same')).toBe(true)
    expect(timingSafeEqualText('sha256:same', 'sha256:different')).toBe(false)
    expect(store.tokens.some((token) => token.verifier === body.adminToken)).toBe(false)

    const first = await router(new Request('https://router.test/admin/setup-tokens', { method: 'POST', headers: bearer(body.adminToken) }))
    const firstBody = await first.json() as { setupToken: string }
    const second = await router(new Request('https://router.test/admin/setup-tokens', { method: 'POST', headers: bearer(body.adminToken) }))
    const secondBody = await second.json() as { setupToken: string }
    const activeSetupTokens = store.tokens.filter((token) => token.kind === 'setup' && token.active)

    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    expect(new Set([body.adminToken, firstBody.setupToken, secondBody.setupToken]).size).toBe(3)
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
    // Claim no longer mints a setup token, so only the one created here is active.
    expect(activeSetupTokens.map((token) => token.expiresAt)).toEqual([1_700_086_400_000])
  })

  it('REQ-GWY-004 REQ-SEC-001 prevents credential classes from crossing route families', async () => {
    // CredentialBoundaryTestAnchor
    const { router } = routerFixture()
    const setupResponse = await router(new Request('https://router.test/admin/setup', { method: 'POST' }))
    const claimAdmin = (await setupResponse.json() as { adminToken: string }).adminToken
    const setup = await (await router(new Request('https://router.test/admin/setup-tokens', { method: 'POST', headers: bearer(claimAdmin) }))).json() as { setupToken: string }

    expect((await router(new Request('https://router.test/v1/models', { headers: bearer('admin-secret') }))).status).toBe(401)
    expect((await router(new Request('https://router.test/admin/status', { headers: bearer(setup.setupToken) }))).status).toBe(401)

    // Non-node credentials must never authenticate a valid heartbeat for an existing node.
    const claimed = await (await router(new Request('https://router.test/node/claim', {
      method: 'POST',
      headers: { ...bearer(setup.setupToken), 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Node A', meshIp: '100.64.1.10', inferencePort: 8080, publicModels: ['codeflare-mesh'], activeProfileIds: ['mesh-smoke-qwen25-1.5b'], capacity: 1 })
    }))).json() as { nodeId: string }
    const validHeartbeat = heartbeatBody({ nodeId: claimed.nodeId })
    expect((await router(new Request('https://router.test/node/heartbeat', { method: 'POST', headers: { ...bearer('provider-secret'), 'content-type': 'application/json' }, body: validHeartbeat }))).status).toBe(401)
    expect((await router(new Request('https://router.test/node/heartbeat', { method: 'POST', headers: { ...bearer('admin-secret'), 'content-type': 'application/json' }, body: validHeartbeat }))).status).toBe(401)
    expect((await router(new Request('https://router.test/node/heartbeat', { method: 'POST', headers: { ...bearer(setup.setupToken), 'content-type': 'application/json' }, body: validHeartbeat }))).status).toBe(401)
  })

  it('REQ-RUN-001 REQ-RUN-002 exposes seeded public model aliases through the provider API', async () => {
    const { router } = routerFixture()
    const response = await router(new Request('https://router.test/v1/models', { headers: bearer('provider-secret') }))
    const body = await response.json() as { data: Array<{ id: string }> }

    expect(response.status).toBe(200)
    // Only the smoke profile is active in the default seed, so the listing carries its aliases.
    expect(body.data.map((model) => model.id)).toEqual(expect.arrayContaining(['codeflare-mesh', 'mesh-smoke', 'smoke-test']))
  })

  it('REQ-RUN-001 exposes one stable public model constant carried as a shared alias by every profile', () => {
    expect(STABLE_PUBLIC_MODEL).toBe('codeflare-mesh')
    for (const profile of DEFAULT_MODEL_PROFILES) {
      // The stable public model is a shared constant every profile carries, never a per-profile wiring id.
      expect(profile.publicAliases).toContain(STABLE_PUBLIC_MODEL)
      expect(profile.id).not.toBe(STABLE_PUBLIC_MODEL)
    }
  })

  it('REQ-RUN-001 the stable public model codeflare-mesh resolves to whichever model is active', async () => {
    const { router, store } = routerFixture()
    await seedLegacyDefaults(store)
    // The default seed makes the smoke model the single active owner of the stable public model.
    await router(new Request('https://router.test/health'))
    const seeded = await store.getProfileByPublicModel('codeflare-mesh')
    expect(seeded?.id).toBe('mesh-smoke-qwen25-1.5b')

    // Switching the active model to the 35B resolves codeflare-mesh to it instead.
    const activated = await router(new Request('https://router.test/admin/profiles/activate', {
      method: 'POST',
      headers: { ...bearer('admin-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ profileId: 'mesh-default-qwen36-35b' })
    }))
    const switched = await store.getProfileByPublicModel('codeflare-mesh')

    expect(activated.status).toBe(200)
    expect(switched?.id).toBe('mesh-default-qwen36-35b')
    // Both models answer to the same stable public alias, so the gateway route/public model never has to change.
    expect(seeded?.publicAliases).toContain('codeflare-mesh')
    expect(switched?.publicAliases).toContain('codeflare-mesh')
  })

  const CUSTOM_GGUF = 'unsloth/Qwen3-14B-GGUF:Q4_K_M'
  const addModel = (router: (request: Request) => Promise<Response>, modelRef: string, mode: string, token = 'admin-secret') =>
    router(new Request('https://router.test/admin/profiles/add', {
      method: 'POST',
      headers: { ...bearer(token), 'content-type': 'application/json' },
      body: JSON.stringify({ modelRef, mode })
    }))

  it('REQ-RUN-011 adds a single-machine model as an inactive profile carrying the stable alias', async () => {
    const { router, store } = routerFixture()
    const response = await addModel(router, CUSTOM_GGUF, 'single')
    expect(response.status).toBe(201)
    const created = (await store.listProfiles()).find((profile) => profile.upstreamModel === CUSTOM_GGUF)
    expect(created).toBeDefined()
    expect(created?.publicAliases).toContain('codeflare-mesh')
    expect(created?.meshllm!.split).toBe(false)
    expect(created?.active).toBe(false)
    expect(created?.rolloutPercent).toBe(0)
  })

  it('REQ-RUN-002 a new model ships with input caching enabled and multi-lane by default', async () => {
    const { router, store } = routerFixture()
    // A dense family (Qwen3-14B) leaves payloadMode Auto (mesh-llm infers resident-kv).
    expect((await addModel(router, CUSTOM_GGUF, 'single')).status).toBe(201)
    const dense = (await store.listProfiles()).find((profile) => profile.upstreamModel === CUSTOM_GGUF)
    expect(dense?.meshllm!.prefixCache).toEqual({ enabled: true, maxEntries: 16, sharedStrideTokens: 128, sharedRecordLimit: 4 })
    expect(dense?.meshllm!.parallel).toBeGreaterThanOrEqual(2)

    // A recurrent-hybrid family (Qwen3.5) must pin payloadMode kv-recurrent, or mesh-llm's
    // Auto inference picks resident-kv (the wrong layout) and the cache silently no-ops.
    const recurrentRef = 'unsloth/Qwen3.5-4B-MTP-GGUF:Q6_K'
    expect((await addModel(router, recurrentRef, 'single')).status).toBe(201)
    const recurrent = (await store.listProfiles()).find((profile) => profile.upstreamModel === recurrentRef)
    expect(recurrent?.meshllm!.prefixCache?.payloadMode).toBe('kv-recurrent')
  })

  it('REQ-RUN-013 adds a direct llama.cpp single model as an inactive profile', async () => {
    const { router, store } = routerFixture()
    const response = await router(new Request('https://router.test/admin/profiles/add', {
      method: 'POST',
      headers: { ...bearer('admin-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ modelRef: CUSTOM_GGUF, mode: 'single', runtime: 'llamacpp' })
    }))
    const created = (await store.listProfiles()).find((profile) => profile.upstreamModel === CUSTOM_GGUF && profile.runtime === 'llamacpp')

    expect(response.status).toBe(201)
    expect(created).toMatchObject({ runtime: 'llamacpp', sourceMode: 'llamacpp-hf', active: false, rolloutPercent: 0 })
    expect(created?.llamacpp).toMatchObject({ hfRepo: 'unsloth/Qwen3-14B-GGUF', quant: 'Q4_K_M', contextWindow: 0, cachePrompt: true, cacheReuse: 256, parallel: -1, kvUnified: true, gpuLayers: '99', cacheTypeK: 'q4_0', cacheTypeV: 'q4_0', batch: 8192, ubatch: 2048, flashAttn: true, maxOutputTokens: 16384, reasoning: { enabled: true, format: 'deepseek', budget: 8192 } })
  })

  it('REQ-RUN-013 rejects direct llama.cpp for split models', async () => {
    const { router, store } = routerFixture()
    const response = await router(new Request('https://router.test/admin/profiles/add', {
      method: 'POST',
      headers: { ...bearer('admin-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ modelRef: CUSTOM_GGUF, mode: 'split', runtime: 'llamacpp' })
    }))

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'split_requires_meshllm' })
    expect((await store.listProfiles()).some((profile) => profile.runtime === 'llamacpp')).toBe(false)
  })

  it('REQ-RUN-011 adds a split model as a profile with split enabled', async () => {
    const { router, store } = routerFixture()
    const ref = 'hf://meshllm/Qwen3-14B-UD-Q4_K_XL-layers@abc123'
    const response = await addModel(router, ref, 'split')
    expect(response.status).toBe(201)
    const created = (await store.listProfiles()).find((profile) => profile.upstreamModel === ref)
    expect(created?.meshllm!.split).toBe(true)
    expect(created?.active).toBe(false)
    expect(created?.publicAliases).toContain('codeflare-mesh')
  })

  it('REQ-RUN-011 derives a unique profile id and refuses a duplicate model', async () => {
    const { router, store } = routerFixture()
    const first = await addModel(router, CUSTOM_GGUF, 'single')
    expect(first.status).toBe(201)
    const firstId = (await first.json() as { profileId: string }).profileId
    const second = await addModel(router, CUSTOM_GGUF, 'single')
    expect(second.status).toBe(409)
    // The duplicate request must not add or overwrite: the derived id exists exactly once.
    expect((await store.listProfiles()).filter((profile) => profile.id === firstId).length).toBe(1)
  })

  it('REQ-RUN-011 rejects a blank model reference', async () => {
    const { router, store } = routerFixture()
    const response = await addModel(router, '   ', 'single')
    expect(response.status).toBe(400)
    expect((await store.listProfiles()).some((profile) => profile.id.startsWith('custom-'))).toBe(false)
  })

  it('REQ-RUN-011 activating an added model deactivates the previously active profile', async () => {
    const { router, store } = routerFixture()
    // The seeded smoke profile is the active owner of codeflare-mesh until the added model is activated.
    const added = await (await addModel(router, CUSTOM_GGUF, 'single')).json() as { profileId: string }
    const activated = await router(new Request('https://router.test/admin/profiles/activate', {
      method: 'POST',
      headers: { ...bearer('admin-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ profileId: added.profileId })
    }))
    expect(activated.status).toBe(200)
    const activeIds = (await store.listProfiles()).filter((profile) => profile.active).map((profile) => profile.id)
    expect(activeIds).toEqual([added.profileId])
    expect(await store.getProfileByPublicModel('codeflare-mesh')).toMatchObject({ id: added.profileId })
  })

  it('REQ-RUN-011 requires admin authentication to add a model', async () => {
    const { router, store } = routerFixture()
    const response = await addModel(router, CUSTOM_GGUF, 'single', 'provider-secret')
    expect(response.status).toBe(401)
    expect((await store.listProfiles()).some((profile) => profile.id.startsWith('custom-'))).toBe(false)
  })

  it('REQ-RUN-011 records a profile-added audit event on a successful add', async () => {
    const { router, store } = routerFixture()
    const added = await (await addModel(router, CUSTOM_GGUF, 'single')).json() as { profileId: string }
    const event = (await store.listAudit(10)).find((entry) => entry.type === 'profile_added')
    expect(event).toBeDefined()
    expect(event?.target).toBe(added.profileId)
  })

  it('REQ-RUN-011 single and split of the same model create distinct profiles', async () => {
    const { router, store } = routerFixture()
    const single = await (await addModel(router, CUSTOM_GGUF, 'single')).json() as { profileId: string }
    const split = await (await addModel(router, CUSTOM_GGUF, 'split')).json() as { profileId: string }
    expect(single.profileId).not.toBe(split.profileId)
    const ids = (await store.listProfiles()).map((profile) => profile.id)
    expect(ids).toContain(single.profileId)
    expect(ids).toContain(split.profileId)
  })

  it('REQ-RUN-001 a chat for codeflare-mesh with no active model returns model-not-found', async () => {
    const { router, store } = routerFixture()
    // Deactivate the seeded model (seed-once never refreshes an existing row back on): no model is active.
    await store.setProfile({ ...DEFAULT_MODEL_PROFILES[0]!, active: false, rolloutPercent: 0, version: 2 })

    const response = await router(new Request('https://router.test/v1/chat/completions', {
      method: 'POST',
      headers: { ...bearer('provider-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'codeflare-mesh', messages: [] })
    }))

    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ error: 'no-profile', requestId: 'request-a' })
  })

  it('REQ-RUN-009 activation is single-active', async () => {
    const { router, store } = routerFixture()
    // Seed two extra active legacy profiles; the default seed then brings the smoke starter up
    // switched off (an active non-default profile already owns the shared alias), so two
    // profiles are active before activation.
    await store.setProfile({ ...LEGACY_MESH_DEFAULT, active: true, rolloutPercent: 100 })
    await store.setProfile({ ...LEGACY_MESH_SPLIT, active: true, rolloutPercent: 100 })

    const res = await router(new Request('https://router.test/admin/profiles/activate', {
      method: 'POST',
      headers: { ...bearer('admin-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ profileId: 'mesh-default-qwen36-35b' })
    }))
    const profiles = await store.listProfiles()

    expect(res.status).toBe(200)
    // Exactly one model stays active after activation: every other active profile is switched off.
    expect(profiles.filter((profile) => profile.active).map((profile) => profile.id)).toEqual(['mesh-default-qwen36-35b'])
    expect(profiles.find((profile) => profile.id === 'mesh-split-qwen36-35b')?.active).toBe(false)
    expect(profiles.find((profile) => profile.id === 'mesh-smoke-qwen25-1.5b')?.active).toBe(false)
  })

  it('REQ-RUN-009 seeds the starter exactly once and never resurrects or refreshes rows', async () => {
    const { router, store } = routerFixture()
    await router(new Request('https://router.test/health'))
    const seeded = await store.listProfiles()
    expect(seeded.map((profile) => profile.id)).toEqual(['mesh-smoke-qwen25-1.5b'])

    // Operator edits to the stored starter survive later requests: seeding never refreshes rows.
    await store.setProfile({ ...seeded[0]!, displayName: 'Renamed', version: 5 })
    await router(new Request('https://router.test/health'))
    const after = await store.listProfiles()
    expect(after.map((profile) => profile.id)).toEqual(['mesh-smoke-qwen25-1.5b'])
    expect(after[0]).toMatchObject({ displayName: 'Renamed', version: 5 })

    // Deleting the starter sticks: the seeded marker keeps later requests from resurrecting it.
    await store.deleteProfile('mesh-smoke-qwen25-1.5b')
    await router(new Request('https://router.test/health'))
    expect(await store.listProfiles()).toEqual([])
  })

  it('REQ-RUN-009 preserves active llama.cpp custom profiles during first seeding', async () => {
    const store = new MemoryStore()
    const direct = { ...buildCustomProfile({ modelRef: 'unsloth/Code-Model-GGUF:Q4_K_M', split: false, runtime: 'llamacpp', existing: [] }), active: true, rolloutPercent: 100, version: 7 }
    await store.setProfile(direct)

    await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)
    const profiles = await store.listProfiles()
    const preserved = profiles.find((profile) => profile.id === direct.id)!
    const starter = profiles.find((profile) => profile.id === 'mesh-smoke-qwen25-1.5b')!
    const current = await store.getProfileByPublicModel('codeflare-mesh')

    expect(preserved).toMatchObject({ active: true, rolloutPercent: 100, version: 7, runtime: 'llamacpp', sourceMode: 'llamacpp-hf' })
    expect(preserved.llamacpp).toMatchObject({ hfRepo: 'unsloth/Code-Model-GGUF', quant: 'Q4_K_M', cachePrompt: true, cacheReuse: 256 })
    // The starter must not steal the shared alias: it seeds switched off and the custom profile stays the owner.
    expect(starter).toMatchObject({ active: false, rolloutPercent: 0 })
    expect(current).toMatchObject({ id: direct.id, runtime: 'llamacpp' })
  })

  it('REQ-SCH-001 normalizes legacy profile rows without retiring them by runtime string', async () => {
    const { router, store } = routerFixture()
    await store.setProfile(legacyRuntimeProfile({ id: 'legacy-runtime-row', publicAliases: ['legacy-router-alias'], version: 3 }))

    await router(new Request('https://router.test/health'))
    const normalized = (await store.listProfiles()).find((profile) => profile.id === 'legacy-runtime-row')!

    expect(normalized).toMatchObject({ active: true, rolloutPercent: 100, version: 3, runtime: 'meshllm', sourceMode: 'meshllm-ref' })
    expect(await store.getProfileByPublicModel('legacy-router-alias')).toMatchObject({ id: 'legacy-runtime-row' })
  })

  it('REQ-SCH-005 lists only active profile aliases in the public model listing', async () => {
    const { router, store } = routerFixture()
    await seedLegacyDefaults(store)
    await store.setProfile({ ...DEFAULT_MODEL_PROFILES[0]!, id: 'ghost-profile', publicAliases: ['ghost-alias'], rolloutPercent: 0, active: false })

    const response = await router(new Request('https://router.test/v1/models', { headers: bearer('provider-secret') }))
    const body = await response.json() as { data: Array<{ id: string }> }
    const ids = body.data.map((model) => model.id)

    expect(response.status).toBe(200)
    // Only the active (smoke) profile's aliases are listed; the inactive 35B/split aliases and the ghost are not.
    expect(ids).toEqual(expect.arrayContaining(['codeflare-mesh', 'mesh-smoke', 'smoke-test']))
    expect(ids).not.toContain('qwen3.6-coder')
    expect(ids).not.toContain('ghost-alias')
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('REQ-RUN-002 seeds the smoke starter with contract values and leaves stored legacy rows intact', async () => {
    const { router, store } = routerFixture()
    await seedLegacyDefaults(store)
    await router(new Request('https://router.test/health'))
    const profiles = await store.listProfiles()
    const single = profiles.find((profile) => profile.id === 'mesh-default-qwen36-35b')!
    const split = profiles.find((profile) => profile.id === 'mesh-split-qwen36-35b')!
    const smoke = profiles.find((profile) => profile.id === 'mesh-smoke-qwen25-1.5b')!

    // The shipped catalog is exactly the single smoke starter.
    expect(DEFAULT_MODEL_PROFILES.map((profile) => profile.id)).toEqual(['mesh-smoke-qwen25-1.5b'])
    expect(single).toMatchObject({
      displayName: 'Qwen3.6 35B',
      publicAliases: ['codeflare-mesh', 'qwen3.6:35b-a3b', 'qwen3.6-coder'],
      meshllm: { modelRef: 'unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ3_S', split: false, bindPort: 4300 },
      contextWindow: 262144,
      rolloutPercent: 0,
      active: false
    })
    expect(split).toMatchObject({
      displayName: 'Qwen3.6 35B (multi-machine)',
      publicAliases: ['codeflare-mesh', 'qwen3.6:35b-a3b', 'qwen3.6-coder'],
      meshllm: { modelRef: 'hf://meshllm/Qwen3.6-35B-A3B-UD-Q4_K_XL-layers@9b24bdc3dfb174ad6848f3f71c34f5302fa4dcfd', split: true, bindPort: 4310 },
      contextWindow: 262144,
      rolloutPercent: 0,
      active: false
    })
    expect(smoke).toMatchObject({
      displayName: 'Qwen2.5 Coder 1.5B',
      publicAliases: ['codeflare-mesh', 'mesh-smoke', 'smoke-test'],
      meshllm: { modelRef: 'unsloth/Qwen2.5-Coder-1.5B-Instruct-GGUF:Q4_K_M', split: false, bindPort: 4320 },
      contextWindow: 32768,
      rolloutPercent: 100,
      active: true
    })
    // Canonical identity: every profile carries a human display name distinct from its wiring id.
    for (const profile of DEFAULT_MODEL_PROFILES) {
      expect(typeof profile.displayName).toBe('string')
      expect(profile.displayName.length).toBeGreaterThan(0)
      expect(profile.displayName).not.toBe(profile.id)
    }
  })

  it('REQ-RUN-002 exposes profile source modes and meshllm contract values', () => {
    for (const profile of DEFAULT_MODEL_PROFILES) {
      expect(profile.sourceMode).toBe('meshllm-ref')
      expect(profile.runtime).toBe('meshllm')
      expect(profile.upstreamModel).toBe(profile.meshllm!.modelRef)
      expect(profile.version).toBe(1)
      expect(Number.isInteger(profile.meshllm!.bindPort)).toBe(true)
      expect(profile.meshllm!.bindPort).toBeGreaterThan(0)
      expect(profile.displayName.trim()).toBe(profile.displayName)
      expect(profile.displayName.length).toBeGreaterThan(0)
    }
  })

  it('REQ-RTR-002 REQ-SCH-002 REQ-OBS-001 forwards the rewritten chat request to the selected node and streams the response', async () => {
    const capture: { request?: Request } = {}
    const { router, store } = routerFixture({ mesh: makeMesh(capture) })
    await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)
    await store.upsertNode(nodeFixture())

    const response = await router(new Request('https://router.test/v1/chat/completions', {
      method: 'POST',
      headers: { ...bearer('provider-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'codeflare-mesh', messages: [{ role: 'user', content: 'hello' }] })
    }))
    await response.text()
    const forwarded = await capture.request!.json() as { model: string }

    expect(response.status).toBe(200)
    expect(capture.request!.url).toBe('http://100.64.1.10:8080/v1/chat/completions')
    // codeflare-mesh resolves to the single active profile (smoke), so the request is rewritten to its upstream.
    expect(forwarded.model).toBe(SMOKE_UPSTREAM)
    expect(capture.request!.headers.get('authorization')).toBe('Bearer upstream-secret')
    expect(response.headers.get('x-inference-mesh-request-id')).toBe('request-a')
    expect(response.headers.get('x-inference-mesh-node')).toBe('node-a')
    // Forwarding is stateless: selecting the node never mutates its in-flight count.
    expect((await store.getNode('node-a'))?.inFlight).toBe(0)
  })

  it('REQ-GWY-003 REQ-RTR-002 accepts AI Gateway dynamic route model names for MeshLLM profiles', async () => {
    const capture: { request?: Request } = {}
    const { router, store } = routerFixture({ mesh: makeMesh(capture) })
    await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)
    await store.upsertNode(nodeFixture())

    const response = await router(new Request('https://router.test/v1/chat/completions', {
      method: 'POST',
      headers: { ...bearer('provider-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'dynamic/codeflare-mesh', user: 'user:admin-playground|session:gateway-session', messages: [{ role: 'user', content: 'test' }], stream: true })
    }))
    await response.text()
    const forwarded = await capture.request!.json() as { model: string; user?: string }

    expect(response.status).toBe(200)
    expect(forwarded.model).toBe(SMOKE_UPSTREAM)
    expect(forwarded.user).toBe('user:admin-playground|session:gateway-session')
  })

  it('REQ-SCH-004 uses a provider-scoped fallback session when Gateway metadata is not forwarded', async () => {
    const capture: { request?: Request } = {}
    const { router, store } = routerFixture({ mesh: makeMesh(capture), env: { SESSION_AFFINITY_KEY: 'affinity-secret' } })
    const direct = { ...buildCustomProfile({ modelRef: 'unsloth/Code-Model-GGUF:Q4_K_M', split: false, runtime: 'llamacpp', existing: [] }), active: true, rolloutPercent: 100, version: 2 }
    await store.setProfile(direct)
    await store.upsertNode(nodeFixture({
      runtime: 'llamacpp',
      activeProfileIds: [direct.id],
      publicModels: [...direct.publicAliases],
      runtimeModel: direct.upstreamModel,
      metrics: { runtimeState: 'ready', runtimeKind: 'llamacpp', activeRequests: 0, apiReady: true, readyModels: [direct.upstreamModel] }
    }))
    const callable = direct.publicAliases.find((alias) => alias !== 'codeflare-mesh') ?? direct.publicAliases[0]!

    const response = await router(new Request('https://router.test/v1/chat/completions', {
      method: 'POST',
      headers: { ...bearer('provider-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ model: callable, messages: [{ role: 'user', content: 'hi' }] })
    }))
    await response.text()
    const forwarded = await capture.request!.json() as { user?: string }
    const sessions = [...store.directSessions.values()]

    expect(response.status).toBe(200)
    expect(response.headers.get('x-inference-mesh-affinity')).toBe('pinned')
    expect(forwarded.user).toBe('user:ai-gateway|session:provider-default')
    expect(sessions).toHaveLength(1)
    expect(JSON.stringify(sessions[0])).not.toContain('provider-secret')
  })

  it('REQ-SCH-004 derives direct llama.cpp session affinity from AI Gateway metadata', async () => {
    const capture: { request?: Request } = {}
    const { router, store } = routerFixture({ mesh: makeMesh(capture), env: { SESSION_AFFINITY_KEY: 'affinity-secret' } })
    const direct = { ...buildCustomProfile({ modelRef: 'unsloth/Code-Model-GGUF:Q4_K_M', split: false, runtime: 'llamacpp', existing: [] }), active: true, rolloutPercent: 100, version: 2 }
    await store.setProfile(direct)
    await store.upsertNode(nodeFixture({
      runtime: 'llamacpp',
      activeProfileIds: [direct.id],
      publicModels: [...direct.publicAliases],
      runtimeModel: direct.upstreamModel,
      metrics: { runtimeState: 'ready', runtimeKind: 'llamacpp', activeRequests: 0, apiReady: true, readyModels: [direct.upstreamModel] }
    }))
    const callable = direct.publicAliases.find((alias) => alias !== 'codeflare-mesh') ?? direct.publicAliases[0]!

    const headerResponse = await router(new Request('https://router.test/v1/chat/completions', {
      method: 'POST',
      headers: { ...bearer('provider-secret'), 'content-type': 'application/json', 'cf-aig-metadata': JSON.stringify({ user: 'operator@example.com', ignored: true }) },
      body: JSON.stringify({ model: callable, messages: [{ role: 'user', content: 'hi' }] })
    }))
    await headerResponse.text()
    const headerForwarded = await capture.request!.json() as { user?: string }

    const bodyResponse = await router(new Request('https://router.test/v1/chat/completions', {
      method: 'POST',
      headers: { ...bearer('provider-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ model: callable, metadata: { user: 'body@example.com', session: 'body-session' }, messages: [{ role: 'user', content: 'hi' }] })
    }))
    await bodyResponse.text()
    const bodyForwarded = await capture.request!.json() as { user?: string }
    const sessions = [...store.directSessions.values()]

    expect(headerResponse.status).toBe(200)
    expect(bodyResponse.status).toBe(200)
    expect(headerResponse.headers.get('x-inference-mesh-affinity')).toBe('pinned')
    expect(bodyResponse.headers.get('x-inference-mesh-affinity')).toBe('pinned')
    expect(headerForwarded.user).toBe('user:operator@example.com|session:operator@example.com')
    expect(bodyForwarded.user).toBe('user:body@example.com|session:body-session')
    expect(sessions).toHaveLength(2)
    expect(JSON.stringify(sessions)).not.toContain('operator@example.com')
    expect(JSON.stringify(sessions)).not.toContain('body@example.com')
    expect(JSON.stringify(sessions)).not.toContain('body-session')
  })

  it('REQ-SCH-004 reuses the pinned direct node and stores only hashed affinity keys', async () => {
    const capture: { request?: Request } = {}
    const { router, store } = routerFixture({ mesh: makeMesh(capture), env: { SESSION_AFFINITY_KEY: 'affinity-secret' } })
    const direct = { ...buildCustomProfile({ modelRef: 'unsloth/Code-Model-GGUF:Q4_K_M', split: false, runtime: 'llamacpp', existing: [] }), active: true, rolloutPercent: 100, version: 2 }
    await store.setProfile(direct)
    await store.upsertNode(nodeFixture({
      runtime: 'llamacpp',
      activeProfileIds: [direct.id],
      publicModels: [...direct.publicAliases],
      runtimeModel: direct.upstreamModel,
      metrics: { runtimeState: 'ready', runtimeKind: 'llamacpp', activeRequests: 0, apiReady: true, readyModels: [direct.upstreamModel], cachePrompt: true, cacheReuse: 256, parallel: 1 }
    }))

    const payload = { model: direct.publicAliases[0], user: 'user:operator-a|session:session-a', messages: [{ role: 'user', content: 'hello' }] }
    const first = await router(new Request('https://router.test/v1/chat/completions', { method: 'POST', headers: { ...bearer('provider-secret'), 'content-type': 'application/json' }, body: JSON.stringify(payload) }))
    await first.text()
    const second = await router(new Request('https://router.test/v1/chat/completions', { method: 'POST', headers: { ...bearer('provider-secret'), 'content-type': 'application/json' }, body: JSON.stringify({ ...payload, messages: [{ role: 'user', content: 'hello again' }] }) }))
    await second.text()
    const forwarded = await capture.request!.json() as { model: string; user: string }
    const sessions = [...store.directSessions.values()]

    expect(first.status).toBe(200)
    expect(first.headers.get('x-inference-mesh-affinity')).toBe('pinned')
    expect(second.headers.get('x-inference-mesh-affinity')).toBe('reused')
    expect(second.headers.get('x-inference-mesh-session-node')).toBe('node-a')
    expect(forwarded.model).toBe(direct.upstreamModel)
    expect(forwarded.user).toBe('user:operator-a|session:session-a')
    expect(sessions).toHaveLength(1)
    expect(JSON.stringify(sessions[0])).not.toContain('operator-a')
    expect(JSON.stringify(sessions[0])).not.toContain('session-a')
    expect(sessions[0]!.affinityKey).toMatch(/^codeflare-mesh\|custom-code-model-gguf-q4-k-m-llamacpp\|hmac-sha256:[a-f0-9]{64}$/)
  })

  it('REQ-SCH-004 fails over a direct session when the pinned node is no longer eligible', async () => {
    const { router, store } = routerFixture({ env: { SESSION_AFFINITY_KEY: 'affinity-secret' } })
    const direct = { ...buildCustomProfile({ modelRef: 'unsloth/Code-Model-GGUF:Q4_K_M', split: false, runtime: 'llamacpp', existing: [] }), active: true, rolloutPercent: 100, version: 2 }
    await store.setProfile(direct)
    const directNode = (id: string, activeRequests: number) => nodeFixture({ id, meshIp: id === 'node-a' ? '100.64.1.10' : '100.64.1.11', runtime: 'llamacpp', activeProfileIds: [direct.id], publicModels: [...direct.publicAliases], runtimeModel: direct.upstreamModel, metrics: { runtimeState: 'ready', runtimeKind: 'llamacpp', activeRequests, apiReady: true, readyModels: [direct.upstreamModel] } })
    await store.upsertNode(directNode('node-a', 0))
    await store.upsertNode(directNode('node-b', 1))

    const payload = { model: direct.publicAliases[0], user: 'user:operator-a|session:session-a', messages: [] }
    const first = await router(new Request('https://router.test/v1/chat/completions', { method: 'POST', headers: { ...bearer('provider-secret'), 'content-type': 'application/json' }, body: JSON.stringify(payload) }))
    await first.text()
    await store.upsertNode({ ...directNode('node-a', 0), deactivated: true })
    const second = await router(new Request('https://router.test/v1/chat/completions', { method: 'POST', headers: { ...bearer('provider-secret'), 'content-type': 'application/json' }, body: JSON.stringify(payload) }))
    await second.text()
    const session = [...store.directSessions.values()][0]!

    expect(first.headers.get('x-inference-mesh-session-node')).toBe('node-a')
    expect(second.headers.get('x-inference-mesh-affinity')).toBe('failed_over')
    expect(second.headers.get('x-inference-mesh-session-node')).toBe('node-b')
    expect(session.failoverCount).toBe(1)
  })

  it('REQ-RTR-002 REQ-SEC-001 reuses generated upstream token when no env secret exists', async () => {
    // UpstreamTokenReuseTestAnchor
    const capture: { request?: Request } = {}
    const store = new MemoryStore()
    const router = createRouter({
      store,
      scheduler: new StoreScheduler(store),
      mesh: makeMesh(capture),
      now: () => 1_700_000_000_000,
      requestId: () => 'request-generated',
      env: { ROUTER_PROVIDER_TOKEN: 'provider-secret', WORKER_BASE_URL: 'https://router.example.workers.dev', MAX_REQUEST_BYTES: '4096' }
    })
    const setupResponse = await router(new Request('https://router.test/admin/setup', { method: 'POST' }))
    const { adminToken } = await setupResponse.json() as { adminToken: string }
    const tokenResponse = await router(new Request('https://router.test/admin/setup-tokens', { method: 'POST', headers: bearer(adminToken) }))
    const { setupToken } = await tokenResponse.json() as { setupToken: string }
    const claim = await router(new Request('https://router.test/node/claim', {
      method: 'POST',
      headers: { ...bearer(setupToken), 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Node A', meshIp: '100.64.1.10', inferencePort: 8080, publicModels: ['codeflare-mesh'], activeProfileIds: ['mesh-smoke-qwen25-1.5b'], capacity: 1 })
    }))
    const claimed = await claim.json() as { nodeId: string; nodeToken: string; upstreamToken: string }
    await router(new Request('https://router.test/node/heartbeat', {
      method: 'POST',
      headers: { ...bearer(claimed.nodeToken), 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: claimed.nodeId, displayName: 'Node A', meshIp: '100.64.1.10', inferencePort: 8080, localDashboardPort: 17777, status: 'online', publicModels: ['codeflare-mesh'], activeProfileIds: ['mesh-smoke-qwen25-1.5b'], capacity: 1, inFlight: 0, runtime: 'meshllm', runtimeModel: SMOKE_UPSTREAM, metrics: { runtimeState: 'ready', loadedModel: SMOKE_UPSTREAM, activeRequests: 0, apiReady: true, readyModels: [SMOKE_UPSTREAM] } })
    }))

    const response = await router(new Request('https://router.test/v1/chat/completions', {
      method: 'POST',
      headers: { ...bearer('provider-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'codeflare-mesh', messages: [] })
    }))

    expect(response.status).toBe(200)
    expect(capture.request!.headers.get('authorization')).toBe(`Bearer ${claimed.upstreamToken}`)
  })

  it('REQ-RTR-002 REQ-SCH-005 returns 502 node_unreachable when the mesh fetch throws', async () => {
    const mesh = {
      fetch: async () => { throw new Error('mesh unavailable') },
      connect() { throw new Error('connect is not used by inference forwarding') }
    } as Fetcher
    const { router, store } = routerFixture({ mesh })
    await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)
    await store.upsertNode(nodeFixture())

    const response = await router(new Request('https://router.test/v1/chat/completions', {
      method: 'POST',
      headers: { ...bearer('provider-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'codeflare-mesh', messages: [] })
    }))

    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ error: 'node_unreachable', requestId: 'request-a' })
    // A transport failure leaves no reservation/in-flight residue: forwarding is stateless.
    expect((await store.getNode('node-a'))?.inFlight).toBe(0)
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
      body: JSON.stringify({ model: 'codeflare-mesh', stream: true, messages: [] })
    }))

    expect(response.headers.get('content-type')?.split(';')[0]).toBe('text/event-stream')
    expect(await response.text()).toBe('data: one\n\ndata: two\n\n')
  })

  it('REQ-RTR-004 accepts only configured Mesh IP destinations and proxy ports', () => {
    expect(isSafeMeshTarget('100.64.1.10', 8080)).toBe(true)
    expect(isSafeMeshTarget('10.0.0.5', 8080)).toBe(false)
    expect(isSafeMeshTarget('10.0.0.5', 8080, { MESH_ALLOWED_CIDRS: '10.0.0.0/24', MESH_ALLOWED_PORTS: '8080' })).toBe(true)
    expect(isSafeMeshTarget('100.64.1.10', 443)).toBe(false)
    expect(isSafeMeshTarget('https://evil.example', 443)).toBe(false)
    expect(isSafeMeshTarget('8.8.8.8', 8080)).toBe(false)
  })

  it('REQ-RTR-004 rejects node redirects instead of following a new destination', async () => {
    const mesh = {
      fetch: async () => new Response(null, { status: 302, headers: { location: 'http://10.0.0.9:8080/v1/chat/completions' } }),
      connect() { throw new Error('connect is not used by inference forwarding') }
    } as Fetcher
    const { router, store } = routerFixture({ mesh })
    await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)
    await store.upsertNode(nodeFixture())

    const response = await router(new Request('https://router.test/v1/chat/completions', {
      method: 'POST',
      headers: { ...bearer('provider-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'codeflare-mesh', messages: [] })
    }))

    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ error: 'node_redirect_rejected', requestId: 'request-a' })
  })

  it('REQ-SCH-005 returns 503 no_healthy_node when no eligible node is ready', async () => {
    const { router, store } = routerFixture()
    await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)
    // The node is up but its runtime is not ready, so no node is eligible to serve.
    await store.upsertNode(nodeFixture({ metrics: { runtimeState: 'starting', activeRequests: 0, apiReady: false, readyModels: [] } }))

    const response = await router(new Request('https://router.test/v1/chat/completions', {
      method: 'POST',
      headers: { ...bearer('provider-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'codeflare-mesh', messages: [] })
    }))

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: 'no_healthy_node', requestId: 'request-a' })
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

  it('REQ-SCH-003 REQ-OBS-004 excludes expired unhealthy and unsafe nodes from selection', async () => {
    const now = 1_700_000_000_000
    const ineligibleNodes = [
      nodeFixture({ id: 'expired', lastSeenAt: now - 45_001 }),
      nodeFixture({ id: 'offline', status: 'offline' }),
      nodeFixture({ id: 'unsupported-model', publicModels: ['other-alias'] }),
      nodeFixture({ id: 'unloaded-profile', activeProfileIds: [] }),
      nodeFixture({ id: 'runtime-failed', metrics: { runtimeState: 'failed', activeRequests: 0, apiReady: true, readyModels: [SMOKE_UPSTREAM] } }),
      nodeFixture({ id: 'stale-ready-models', metrics: { runtimeState: 'ready', activeRequests: 0, apiReady: true, readyModels: ['other-model'] } }),
      nodeFixture({ id: 'unsafe-mesh', meshIp: '8.8.8.8' })
    ] as const

    for (const node of ineligibleNodes) {
      const store = new MemoryStore()
      await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)
      await store.upsertNode(node)
      const result = await new StoreScheduler(store).selectEntryNode({ publicModel: 'codeflare-mesh', now })

      expect(result.reason).toBe('no-node')
      expect(result.node).toBeUndefined()
    }
  })

  it('REQ-SCH-003 excludes nodes whose runtime is not meshllm from scheduling', async () => {
    const store = new MemoryStore()
    await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)
    await store.upsertNode({ ...nodeFixture(), runtime: 'legacy-runtime' } as unknown as NodeRecord)

    const result = await new StoreScheduler(store).selectEntryNode({ publicModel: 'codeflare-mesh', now: 1_700_000_000_000 })

    expect(result.reason).toBe('no-node')
    expect(result.node).toBeUndefined()
  })

  it('REQ-SCH-003 excludes nodes whose MeshLLM API is not ready from scheduling', async () => {
    const store = new MemoryStore()
    await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)
    await store.upsertNode(nodeFixture({ metrics: { runtimeState: 'ready', activeRequests: 0, apiReady: false, readyModels: [SMOKE_UPSTREAM] } }))

    const result = await new StoreScheduler(store).selectEntryNode({ publicModel: 'codeflare-mesh', now: 1_700_000_000_000 })

    expect(result.reason).toBe('no-node')
    expect(result.node).toBeUndefined()
  })

  it('REQ-SCH-003 excludes nodes whose ready models omit the requested upstream model', async () => {
    const store = new MemoryStore()
    await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)
    await store.upsertNode(nodeFixture({ metrics: { runtimeState: 'ready', activeRequests: 0, apiReady: true, readyModels: [QWEN_UPSTREAM] } }))

    const result = await new StoreScheduler(store).selectEntryNode({ publicModel: 'codeflare-mesh', now: 1_700_000_000_000 })

    expect(result.reason).toBe('no-node')
    expect(result.node).toBeUndefined()
  })

  it('REQ-SCH-003 keeps standby nodes unschedulable even when ready models list the requested model', async () => {
    const store = new MemoryStore()
    await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)
    await store.upsertNode(nodeFixture({ metrics: { runtimeState: 'starting', activeRequests: 0, apiReady: true, readyModels: [SMOKE_UPSTREAM] } }))
    const standby = await new StoreScheduler(store).selectEntryNode({ publicModel: 'codeflare-mesh', now: 1_700_000_000_000 })

    await store.upsertNode(nodeFixture({ metrics: { runtimeState: 'ready', activeRequests: 0, apiReady: true, readyModels: [SMOKE_UPSTREAM] } }))
    const ready = await new StoreScheduler(store).selectEntryNode({ publicModel: 'codeflare-mesh', now: 1_700_000_000_000 })

    expect(standby.reason).toBe('no-node')
    expect(standby.node).toBeUndefined()
    expect(ready.node?.id).toBe('node-a')
  })

  it('REQ-ADM-001 REQ-ADM-003 consumes setup tokens during node claim', async () => {
    // FirstRunSetupTokenTestAnchor
    const { router, store } = routerFixture()
    const expiredRecord = await createTokenRecord('setup', 'expired-setup', 1_699_913_599_999, undefined, 1_700_000_000_000)
    await store.putToken(expiredRecord)
    const expired = await router(new Request('https://router.test/node/claim', {
      method: 'POST',
      headers: { ...bearer('expired-setup'), 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Expired Node', meshIp: '100.64.1.9', inferencePort: 8080, publicModels: ['codeflare-mesh'], activeProfileIds: ['mesh-default-qwen36-35b'], capacity: 1 })
    }))
    const setupResponse = await router(new Request('https://router.test/admin/setup', { method: 'POST' }))
    const claimAdmin = (await setupResponse.json() as { adminToken: string }).adminToken
    const setup = await (await router(new Request('https://router.test/admin/setup-tokens', { method: 'POST', headers: bearer(claimAdmin) }))).json() as { setupToken: string }
    const claim = await router(new Request('https://router.test/node/claim', {
      method: 'POST',
      headers: { ...bearer(setup.setupToken), 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Node A', meshIp: '100.64.1.10', inferencePort: 8080, publicModels: ['codeflare-mesh'], activeProfileIds: ['mesh-default-qwen36-35b'], capacity: 2 })
    }))
    const consumed = await router(new Request('https://router.test/node/claim', {
      method: 'POST',
      headers: { ...bearer(setup.setupToken), 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Node B', meshIp: '100.64.1.11', inferencePort: 8080, publicModels: ['codeflare-mesh'], activeProfileIds: ['mesh-default-qwen36-35b'], capacity: 2 })
    }))

    expect(expired.status).toBe(401)
    expect(claim.status).toBe(201)
    expect(consumed.status).toBe(401)
    expect(store.tokens.find((token) => token.id === expiredRecord.id)?.active).toBe(true)
    expect(store.tokens.filter((token) => token.kind === 'setup' && token.id !== expiredRecord.id).every((token) => token.active === false)).toBe(true)
    expect(store.nodes.has('node-a-100-64-1-10')).toBe(true)
  })

  it('REQ-SEC-007 rejects unsafe node claim network targets before creating a node', async () => {
    const { router, store } = routerFixture()
    const setupResponse = await router(new Request('https://router.test/admin/setup', { method: 'POST' }))
    const claimAdmin = (await setupResponse.json() as { adminToken: string }).adminToken
    const setup = await (await router(new Request('https://router.test/admin/setup-tokens', { method: 'POST', headers: bearer(claimAdmin) }))).json() as { setupToken: string }

    const claim = await router(new Request('https://router.test/node/claim', {
      method: 'POST',
      headers: { ...bearer(setup.setupToken), 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Node A', meshIp: '10.0.0.5', inferencePort: 8080, publicModels: ['codeflare-mesh'], activeProfileIds: ['mesh-default-qwen36-35b'], capacity: 2 })
    }))

    expect(claim.status).toBe(400)
    expect(await claim.json()).toMatchObject({ error: 'invalid_claim', fields: expect.arrayContaining(['meshTarget']) })
    expect(store.nodes.size).toBe(0)
  })

  it('REQ-NODE-002 REQ-OBS-003 accepts authenticated heartbeats and stores node metrics', async () => {
    const { router, store } = routerFixture()
    await store.upsertNode({ ...nodeFixture(), nodeTokenVerifier: await hashToken('node-secret') })

    const response = await router(new Request('https://router.test/node/heartbeat', {
      method: 'POST',
      headers: { ...bearer('node-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: 'node-a', displayName: 'Node A', meshIp: '100.64.1.10', inferencePort: 8080, localDashboardPort: 17777, status: 'online', publicModels: ['codeflare-mesh'], activeProfileIds: ['mesh-default-qwen36-35b'], capacity: 2, inFlight: 1, runtime: 'meshllm', runtimeModel: 'unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ3_S', metrics: { runtimeState: 'ready', loadedModel: 'unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ3_S', activeRequests: 1, gpuName: 'RTX 3090', apiReady: true, readyModels: ['unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ3_S'] } })
    }))

    const stored = await store.getNode('node-a')

    expect(response.status).toBe(200)
    expect(stored?.metrics?.gpuName).toBe('RTX 3090')
    expect(stored?.metrics?.readyModels).toEqual([QWEN_UPSTREAM])
  })

  it('REQ-ADM-023 persists node name and VRAM override across heartbeat', async () => {
    const { router, store } = routerFixture()
    await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)
    await store.upsertNode({ ...nodeFixture({ status: 'online' }), nodeTokenVerifier: await hashToken('node-secret') })
    const config = (body: unknown) => router(new Request('https://router.test/admin/nodes/node-a/config', { method: 'POST', headers: { ...bearer('admin-secret'), 'content-type': 'application/json' }, body: JSON.stringify(body) }))
    const heartbeat = () => router(new Request('https://router.test/node/heartbeat', { method: 'POST', headers: { ...bearer('node-secret'), 'content-type': 'application/json' }, body: JSON.stringify({ nodeId: 'node-a', displayName: 'Node A', meshIp: '100.64.1.10', inferencePort: 8080, localDashboardPort: 17777, status: 'online', publicModels: ['codeflare-mesh'], activeProfileIds: ['mesh-default-qwen36-35b'], capacity: 2, inFlight: 1, runtime: 'meshllm' }) }))

    expect((await config({ displayName: 'Battlestation', maxVramGbOverride: 4 })).status).toBe(200)
    expect((await store.getNode('node-a'))?.displayName).toBe('Battlestation')
    expect((await store.getNode('node-a'))?.maxVramGbOverride).toBe(4)
    // The node's heartbeat now carries the override on every desired profile, capping it below the global,
    // but its self-reported displayName no longer overwrites the operator's stored name.
    const capped = await (await heartbeat()).json() as { desiredProfiles: Array<{ meshllm: { maxVramGb?: number } }> }
    expect(capped.desiredProfiles.length).toBeGreaterThan(0)
    expect(capped.desiredProfiles.every((profile) => profile.meshllm!.maxVramGb === 4)).toBe(true)
    expect((await store.getNode('node-a'))?.displayName).toBe('Battlestation')

    // Clearing removes the override so the node follows the model default again.
    expect((await config({ maxVramGbOverride: null })).status).toBe(200)
    expect((await store.getNode('node-a'))?.maxVramGbOverride).toBeUndefined()

    // Boundary + auth: a negative override is 400, a blank name is 400, an unknown node 404, a non-admin 401.
    expect((await config({ maxVramGbOverride: -1 })).status).toBe(400)
    expect((await config({ displayName: '   ' })).status).toBe(400)
    expect((await router(new Request('https://router.test/admin/nodes/ghost/config', { method: 'POST', headers: { ...bearer('admin-secret'), 'content-type': 'application/json' }, body: JSON.stringify({ maxVramGbOverride: 4 }) }))).status).toBe(404)
    expect((await router(new Request('https://router.test/admin/nodes/node-a/config', { method: 'POST', headers: { ...bearer('not-admin'), 'content-type': 'application/json' }, body: JSON.stringify({ maxVramGbOverride: 4 }) }))).status).toBe(401)
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
      body: JSON.stringify({ nodeId: 'node-a', displayName: 'Node A', meshIp: '100.64.1.10', inferencePort: 8080, localDashboardPort: 17777, status: 'online', publicModels: ['codeflare-mesh'], activeProfileIds: ['mesh-default-qwen36-35b'], capacity: 2, inFlight: 0, runtime: 'meshllm', metrics: { runtimeState: 'ready', activeRequests: 0 } })
    }))
    const unregister = await router(new Request('https://router.test/node/unregister', {
      method: 'POST',
      headers: { ...bearer('node-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: 'node-a' })
    }))
    const node = await store.getNode('node-a')
    const listed = await store.listNodes(1_700_000_000_000)

    expect(response.status).toBe(200)
    // The node record is gone, so a still-running agent's heartbeat and unregister are
    // rejected as unknown (404) and cannot resurrect it.
    expect(heartbeat.status).toBe(404)
    expect(unregister.status).toBe(404)
    // Revoke removes the node outright: it is gone from the store and from the list,
    // so it disappears from the console immediately (no lingering tombstone row).
    expect(node).toBeUndefined()
    expect(listed.some((candidate) => candidate.id === 'node-a')).toBe(false)
    // Its node tokens are revoked so a still-running agent cannot re-authenticate.
    expect(store.tokens.filter((token) => token.kind === 'node' && token.nodeId === 'node-a').every((token) => token.active === false)).toBe(true)
    expect(store.audit.some((event) => event.type === 'node_revoked' && event.target === 'node-a')).toBe(true)
  })

  it('REQ-ADM-020 prunes nodes offline past the configured window and records the removal', async () => {
    const { router, store } = routerFixture()
    await store.upsertNode(nodeFixture({ id: 'stale', status: 'offline', lastSeenAt: 1_700_000_000_000 - 7_200_000 }))
    await store.upsertNode(nodeFixture({ id: 'fresh', status: 'online', lastSeenAt: 1_700_000_000_000 }))
    await store.putConfig('offline_prune_seconds', 3600)

    const response = await router(new Request('https://router.test/admin/status', { headers: bearer('admin-secret') }))

    expect(response.status).toBe(200)
    expect(await store.getNode('stale')).toBeUndefined()
    expect(await store.getNode('fresh')).toBeDefined()
    expect(store.audit.some((event) => event.type === 'node_pruned' && event.target === 'stale')).toBe(true)
  })

  it('REQ-ADM-020 keeps offline nodes when the prune window is zero', async () => {
    const { router, store } = routerFixture()
    await store.upsertNode(nodeFixture({ id: 'stale', status: 'offline', lastSeenAt: 1 }))
    await store.putConfig('offline_prune_seconds', 0)
    await router(new Request('https://router.test/admin/status', { headers: bearer('admin-secret') }))
    expect(await store.getNode('stale')).toBeDefined()
  })

  it('REQ-ADM-020 sets the offline prune window through the settings endpoint', async () => {
    const { router, store } = routerFixture()
    const ok = await router(new Request('https://router.test/admin/settings', { method: 'POST', headers: { ...bearer('admin-secret'), 'content-type': 'application/json' }, body: JSON.stringify({ offlinePruneSeconds: 3600 }) }))
    expect(ok.status).toBe(200)
    expect(await store.getConfig('offline_prune_seconds')).toBe(3600)
    expect((await router(new Request('https://router.test/admin/settings', { method: 'POST', headers: { ...bearer('admin-secret'), 'content-type': 'application/json' }, body: JSON.stringify({ offlinePruneSeconds: -5 }) }))).status).toBe(400)
    expect((await router(new Request('https://router.test/admin/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ offlinePruneSeconds: 3600 }) }))).status).toBe(401)
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
    await seedLegacyDefaults(store)

    const setupResponse = await router(new Request('https://router.test/admin/setup', { method: 'POST' }))
    const claimAdmin = (await setupResponse.json() as { adminToken: string }).adminToken
    const setup = await (await router(new Request('https://router.test/admin/setup-tokens', { method: 'POST', headers: bearer(claimAdmin) }))).json() as { setupToken: string }
    const claim = await router(new Request('https://router.test/node/claim', {
      method: 'POST',
      headers: { ...bearer(setup.setupToken), 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Node A', meshIp: '100.64.1.10', inferencePort: 8080, publicModels: ['codeflare-mesh'], activeProfileIds: ['mesh-default-qwen36-35b'], capacity: 2 })
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

  it('REQ-NODE-002 a heartbeat refreshes the node-reported active-request metric that drives selection', async () => {
    const { router, store } = routerFixture()
    await store.upsertNode({ ...nodeFixture({ capacity: 1 }), nodeTokenVerifier: await hashToken('node-secret') })

    const busy = await router(new Request('https://router.test/node/heartbeat', {
      method: 'POST',
      headers: { ...bearer('node-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: 'node-a', displayName: 'Node A', meshIp: '100.64.1.10', inferencePort: 8080, localDashboardPort: 17777, status: 'online', publicModels: ['codeflare-mesh'], activeProfileIds: ['mesh-default-qwen36-35b'], capacity: 1, inFlight: 0, runtime: 'meshllm', metrics: { runtimeState: 'ready', activeRequests: 3 } })
    }))
    const afterBusy = await store.getNode('node-a')

    const idle = await router(new Request('https://router.test/node/heartbeat', {
      method: 'POST',
      headers: { ...bearer('node-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: 'node-a', displayName: 'Node A', meshIp: '100.64.1.10', inferencePort: 8080, localDashboardPort: 17777, status: 'online', publicModels: ['codeflare-mesh'], activeProfileIds: ['mesh-default-qwen36-35b'], capacity: 1, inFlight: 0, runtime: 'meshllm', metrics: { runtimeState: 'ready', activeRequests: 0 } })
    }))
    const afterIdle = await store.getNode('node-a')

    // activeRequests is the node-reported load signal selectNode orders on; each heartbeat must persist it.
    expect(busy.status).toBe(200)
    expect(afterBusy?.metrics?.activeRequests).toBe(3)
    expect(idle.status).toBe(200)
    expect(afterIdle?.metrics?.activeRequests).toBe(0)
  })

  it('REQ-ADM-030 deactivates and reactivates a node from the admin console with audit', async () => {
    const { router, store } = routerFixture()
    await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)
    await store.upsertNode(nodeFixture())

    const off = await router(new Request('https://router.test/admin/nodes/node-a/deactivate', { method: 'POST', headers: bearer('admin-secret') }))
    expect(off.status).toBe(200)
    expect(await off.json()).toMatchObject({ ok: true, deactivated: true })
    expect((await store.getNode('node-a'))?.deactivated).toBe(true)
    expect(store.audit.some((event) => event.type === 'node_deactivated' && event.target === 'node-a')).toBe(true)

    const on = await router(new Request('https://router.test/admin/nodes/node-a/activate', { method: 'POST', headers: bearer('admin-secret') }))
    expect(on.status).toBe(200)
    expect(await on.json()).toMatchObject({ ok: true, deactivated: false })
    expect((await store.getNode('node-a'))?.deactivated).toBe(false)
    expect(store.audit.some((event) => event.type === 'node_activated' && event.target === 'node-a')).toBe(true)
  })

  it('REQ-ADM-030 deactivate requires an admin credential and leaves the node untouched otherwise', async () => {
    const { router, store } = routerFixture()
    await store.upsertNode(nodeFixture())
    expect((await router(new Request('https://router.test/admin/nodes/node-a/deactivate', { method: 'POST', headers: bearer('provider-secret') }))).status).toBe(401)
    expect((await store.getNode('node-a'))?.deactivated).toBeUndefined()
  })

  it('REQ-ADM-032 REQ-NODE-012 force reload stamps a nonce, delivers it once, and retires it on ack', async () => {
    const { router, store } = routerFixture()
    await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)
    await store.upsertNode({ ...nodeFixture(), nodeTokenVerifier: await hashToken('node-secret') })

    const requested = await router(new Request('https://router.test/admin/nodes/node-a/reload', { method: 'POST', headers: bearer('admin-secret') }))
    expect(requested.status).toBe(200)
    const { reloadNonce } = await requested.json() as { reloadNonce: string }
    expect(reloadNonce).toBeTruthy()
    expect((await store.getNode('node-a'))?.reloadNonce).toBe(reloadNonce)
    expect(store.audit.some((event) => event.type === 'node_reload_requested' && event.target === 'node-a')).toBe(true)

    const heartbeat = (ack?: string) => router(new Request('https://router.test/node/heartbeat', {
      method: 'POST',
      headers: { ...bearer('node-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: 'node-a', displayName: 'Node A', meshIp: '100.64.1.10', inferencePort: 8080, localDashboardPort: 17777, status: 'online', publicModels: ['codeflare-mesh'], activeProfileIds: ['mesh-smoke-qwen25-1.5b'], capacity: 2, inFlight: 0, runtime: 'meshllm', ...(ack !== undefined ? { reloadNonce: ack } : {}) })
    }))

    // The pending directive rides the heartbeat until the node applies it.
    const first = await (await heartbeat()).json() as { reloadNonce?: string }
    expect(first.reloadNonce).toBe(reloadNonce)

    // The node echoes the applied nonce → the router retires the directive.
    expect((await heartbeat(reloadNonce)).status).toBe(200)
    expect((await store.getNode('node-a'))?.reloadNonce).toBe('')
    const after = await (await heartbeat(reloadNonce)).json() as { reloadNonce?: string }
    expect(after.reloadNonce).toBeUndefined()
  })

  it('REQ-ADM-032 force reload requires an admin credential', async () => {
    const { router, store } = routerFixture()
    await store.upsertNode(nodeFixture())
    expect((await router(new Request('https://router.test/admin/nodes/node-a/reload', { method: 'POST', headers: bearer('provider-secret') }))).status).toBe(401)
    expect((await store.getNode('node-a'))?.reloadNonce).toBeUndefined()
  })

  it('REQ-ADM-030 REQ-NODE-011 a deactivated node heartbeat gets no desired profiles and the flag survives', async () => {
    const { router, store } = routerFixture()
    await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)
    await store.upsertNode({ ...nodeFixture({ deactivated: true }), nodeTokenVerifier: await hashToken('node-secret') })

    const res = await router(new Request('https://router.test/node/heartbeat', {
      method: 'POST',
      headers: { ...bearer('node-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: 'node-a', displayName: 'Node A', meshIp: '100.64.1.10', inferencePort: 8080, localDashboardPort: 17777, status: 'online', publicModels: ['codeflare-mesh'], activeProfileIds: ['mesh-smoke-qwen25-1.5b'], capacity: 2, inFlight: 0, runtime: 'meshllm', metrics: { runtimeState: 'ready', activeRequests: 0, apiReady: true, readyModels: [SMOKE_UPSTREAM] } })
    }))
    const body = await res.json() as { ok: boolean; desiredProfiles: unknown[]; deactivated?: boolean; meshBootstrap?: unknown }

    expect(res.status).toBe(200)
    expect(body.deactivated).toBe(true)
    expect(body.desiredProfiles).toEqual([])
    expect(body.meshBootstrap).toBeUndefined()
    // The heartbeat body never carries the operator flag; the router carries it forward across the write.
    expect((await store.getNode('node-a'))?.deactivated).toBe(true)
  })

  it('REQ-ADM-030 a deactivated node is excluded from inference selection', async () => {
    const { router, store } = routerFixture()
    await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)
    await store.upsertNode(nodeFixture({ deactivated: true }))

    const res = await router(new Request('https://router.test/v1/chat/completions', {
      method: 'POST',
      headers: { ...bearer('provider-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'codeflare-mesh', messages: [] })
    }))
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: 'no_healthy_node' })
  })

  it('REQ-ADM-002 REQ-OBS-002 returns redacted machine-readable admin status and REQ-RUN-004 reports profile readiness in admin status', async () => {
    // AdminStatusRedactionTestAnchor
    const { router, store } = routerFixture()
    await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)
    const directProfile = buildCustomProfile({ modelRef: 'unsloth/Code-Model-GGUF:Q4_K_M', split: false, runtime: 'llamacpp', existing: [] })
    await store.setProfile({
      ...directProfile,
      llamacpp: {
        ...directProfile.llamacpp!,
        parallel: 2,
        gpuLayers: '99',
        cacheTypeK: 'q4_0',
        cacheTypeV: 'q8_0',
        batch: 8192,
        ubatch: 1024,
        flashAttn: true,
        maxOutputTokens: 99,
        cachePrompt: true,
        cacheReuse: 256,
        reasoning: { enabled: true, format: 'deepseek', budget: 32 }
      }
    })
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
      expect.objectContaining({ id: 'mesh-smoke-qwen25-1.5b', upstreamModel: SMOKE_UPSTREAM, sourceMode: 'meshllm-ref', version: 1, rolloutPercent: 100, active: true })
    ]))
    expect(body.profiles?.[0]).toHaveProperty('publicAliases')
    const directStatusProfile = body.profiles?.find((profile) => profile.id === directProfile.id) as { llamacpp?: Record<string, unknown> } | undefined
    expect(directStatusProfile?.llamacpp).toMatchObject({
      parallel: 2,
      gpuLayers: '99',
      cacheTypeK: 'q4_0',
      cacheTypeV: 'q8_0',
      batch: 8192,
      ubatch: 1024,
      flashAttn: true,
      maxOutputTokens: 99,
      cachePrompt: true,
      cacheReuse: 256,
      reasoning: { enabled: true, format: 'deepseek', budget: 32 }
    })
    expect(body.profileReadiness).toEqual(expect.arrayContaining([
      expect.objectContaining({ profileId: 'mesh-smoke-qwen25-1.5b', ready: 1, downloading: 0, failed: 1 })
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
    // Windows install and its scheduled task resolve an explicit config path under ProgramData.
    expect(windowsScript).toContain('--config $ConfigPath --data-dir $StateDir')
    expect(windowsScript).toContain('-Argument "run --config $ConfigPath"')
    expect(linuxPlan).toEqual({ assetName: 'inference-mesh-agent-linux-amd64.tar.gz', extractedBinary: 'inference-mesh-agent-linux-amd64', installedBinary: 'inference-mesh-agent', checksumFile: 'checksums.txt' })
    expect(windowsPlan).toEqual({ assetName: 'inference-mesh-agent-windows-amd64.zip', extractedBinary: 'inference-mesh-agent-windows-amd64.exe', installedBinary: 'inference-mesh-agent.exe', checksumFile: 'checksums.txt' })
    // Fetching a command never mints: no orphan setup token is created on view.
    expect(store.tokens.filter((token) => token.kind === 'setup').length).toBe(0)
  })

  it('REQ-ADM-004 unix install wrapper runs the agent from an explicit config path and system state dir', async () => {
    const { router } = routerFixture({ env: { AGENT_RELEASE_TAG: 'v0.1.0-dev.test' } })
    const script = await (await router(new Request('https://router.test/install.sh?platform=linux'))).text()

    // The service resolves the same config the install step wrote, independent of $HOME.
    expect(script).toContain('mkdir -p /var/lib/inference-mesh')
    expect(script).toContain('INFERENCE_MESH_CONFIG=/var/lib/inference-mesh/config.json /usr/local/bin/inference-mesh-agent install')
    expect(script).toContain('--config /var/lib/inference-mesh/config.json --data-dir /var/lib/inference-mesh')
    expect(script).toContain('Environment=INFERENCE_MESH_CONFIG=/var/lib/inference-mesh/config.json')
    expect(script).toContain('WorkingDirectory=/var/lib/inference-mesh')
    expect(script).toContain('ExecStart=/usr/local/bin/inference-mesh-agent run --config /var/lib/inference-mesh/config.json')
    // Distro-agnostic: enrollment uses a static binary + systemd only, no distribution package manager.
    expect(script).not.toMatch(/\b(apt-get|apt|yum|dnf|pacman|zypper)\b/)
  })

  it('REQ-ADM-003 does not mint a setup token when an install command is fetched', async () => {
    const { router, store } = routerFixture()
    const first = await router(new Request('https://router.test/admin/installers/linux', { headers: bearer('admin-secret') }))
    const command = await first.text()
    // Repeat views must not accumulate tokens either.
    await router(new Request('https://router.test/admin/installers/windows', { headers: bearer('admin-secret') }))

    expect(first.status).toBe(200)
    // The command carries the placeholder, not a live setup_ token.
    expect(command).toContain(SETUP_TOKEN_PLACEHOLDER)
    expect(command).not.toMatch(/setup_[A-Za-z0-9]/)
    expect(store.tokens.filter((token) => token.kind === 'setup').length).toBe(0)
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
    // The body's routeName/publicModel ('mesh-admin'/'mesh-smoke') are ignored: the router pins both to codeflare-mesh.
    expect(calls).toEqual(['account-admin', 'gateway-admin', 'https://ai.example.com', 'codeflare-mesh', 'codeflare-mesh'])
    expect(body).toMatchObject({ deploymentId: 'deployment-a', manualProviderKeyRequired: true })
  })

  it('REQ-GWY-003 gateway sync pins route and model to codeflare-mesh regardless of request body', async () => {
    let received: { routeName: string; publicModel: string } | undefined
    const { router, store } = routerFixture({
      env: { CLOUDFLARE_ACCOUNT_ID: 'acct-1', AI_GATEWAY_ID: 'inference-mesh' },
      cloudflareClient: {
        async syncCustomProvider(input) {
          received = { routeName: input.routeName, publicModel: input.publicModel }
          return { providerId: 'p', providerSlug: 'slug', routeId: 'r', routeVersionId: 'v', deploymentId: 'd', gatewayId: input.gatewayId, routeName: input.routeName, publicModel: input.publicModel, workerUrl: input.workerUrl, manualProviderKeyRequired: true, providerTokenInstructions: 'x' }
        },
        async provisionCustomDomain() { throw new Error('custom domain is not used in this test') }
      }
    })
    await store.putConfig('custom_domain', { hostname: 'mesh.example.com', status: 'provisioned' })

    const res = await router(new Request('https://router.test/admin/cloudflare/gateway/sync', {
      method: 'POST',
      headers: { ...bearer('admin-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ routeName: 'operator-typed-route', publicModel: 'operator-typed-model' })
    }))

    expect(res.status).toBe(200)
    expect(received).toEqual({ routeName: 'codeflare-mesh', publicModel: 'codeflare-mesh' })
  })

  it('REQ-GWY-005 gateway sync defaults the provider name', async () => {
    let receivedProviderName: string | undefined
    const { router, store } = routerFixture({
      env: { CLOUDFLARE_ACCOUNT_ID: 'acct-1', AI_GATEWAY_ID: 'inference-mesh' },
      cloudflareClient: {
        async syncCustomProvider(input) {
          receivedProviderName = input.providerName
          return { providerId: 'p', providerSlug: 'slug', routeId: 'r', routeVersionId: 'v', deploymentId: 'd', gatewayId: input.gatewayId, routeName: input.routeName, publicModel: input.publicModel, workerUrl: input.workerUrl, manualProviderKeyRequired: true, providerTokenInstructions: 'x' }
        },
        async provisionCustomDomain() { throw new Error('custom domain is not used in this test') }
      }
    })
    await store.putConfig('custom_domain', { hostname: 'mesh.example.com', status: 'provisioned' })

    const res = await router(new Request('https://router.test/admin/cloudflare/gateway/sync', {
      method: 'POST',
      headers: { ...bearer('admin-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({})
    }))

    expect(res.status).toBe(200)
    expect(receivedProviderName).toBe('Codeflare Inference Mesh')
  })

  it('REQ-GWY-003 uses idempotent Cloudflare custom-provider and dynamic-route payload contracts', async () => {
    const calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = []
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
      calls.push({ method, path: url.pathname, ...(body ? { body } : {}) })
      if (url.pathname.endsWith('/ai-gateway/gateways') && method === 'GET') return Response.json({ success: true, result: [] })
      if (url.pathname.endsWith('/ai-gateway/gateways') && method === 'POST') return Response.json({ success: true, result: { id: 'gateway-a' } })
      if (url.pathname.endsWith('/custom-providers') && method === 'GET') return Response.json({ success: true, result: [] })
      if (url.pathname.endsWith('/custom-providers') && method === 'POST') return Response.json({ success: true, result: { id: 'provider-a', slug: 'codeflare-inference-mesh' } })
      if (url.pathname.endsWith('/routes') && method === 'GET') return Response.json({ success: true, data: { routes: [] } })
      // Creating a route with elements inline yields the version and deployment in one call.
      return Response.json({ success: true, result: { id: 'route-a', name: 'codeflare-mesh', version: { version_id: 'version-a' }, deployment: { deployment_id: 'deployment-a', version_id: 'version-a' } } })
    }) as typeof fetch
    const client = new CloudflareGatewayClient('runtime-token', fetcher)

    const result = await client.syncCustomProvider({ accountId: 'account-a', gatewayId: 'gateway-a', workerUrl: 'https://router.example.workers.dev/v1/chat/completions', providerName: 'Codeflare Inference Mesh', routeName: 'codeflare-mesh', publicModel: 'codeflare-mesh', providerTokenInstructions: 'manual' })
    const routeBody = calls.find((call) => call.path.endsWith('/routes') && call.method === 'POST')!.body as { name: string; enabled: boolean; elements: Array<{ type: string; properties?: Record<string, unknown> }> }
    const modelNode = routeBody.elements.find((element) => element.type === 'model')!

    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'GET /client/v4/accounts/account-a/ai-gateway/gateways',
      'POST /client/v4/accounts/account-a/ai-gateway/gateways',
      'GET /client/v4/accounts/account-a/ai-gateway/custom-providers',
      'POST /client/v4/accounts/account-a/ai-gateway/custom-providers',
      'GET /client/v4/accounts/account-a/ai-gateway/gateways/gateway-a/routes',
      'POST /client/v4/accounts/account-a/ai-gateway/gateways/gateway-a/routes'
    ])
    expect(calls[1]!.body).toEqual({ id: 'gateway-a', cache_invalidate_on_update: false, cache_ttl: 0, collect_logs: true, rate_limiting_interval: 0, rate_limiting_limit: 0, authentication: true })
    expect(calls[3]!.body).toEqual({ name: 'Codeflare Inference Mesh', slug: 'codeflare-inference-mesh', base_url: 'https://router.example.workers.dev', description: 'Codeflare Inference Mesh OpenAI-compatible router', enable: true })
    expect(routeBody.name).toBe('codeflare-mesh')
    expect(routeBody.enabled).toBe(true)
    expect(modelNode.properties).toEqual({ provider: 'custom-codeflare-inference-mesh', model: 'codeflare-mesh', retries: 3, timeout: 120000 })
    expect(result).toMatchObject({ providerId: 'provider-a', providerSlug: 'codeflare-inference-mesh', routeId: 'route-a', routeVersionId: 'version-a', deploymentId: 'deployment-a', gatewayId: 'gateway-a', routeName: 'codeflare-mesh', publicModel: 'codeflare-mesh', workerUrl: 'https://router.example.workers.dev', manualProviderKeyRequired: true, providerTokenInstructions: 'manual' })
  })

  it('REQ-GWY-007 keeps the provider slug stable across worker origins so a re-sync reconciles instead of duplicating', async () => {
    const providers: Array<{ id: string; slug: string; name: string; base_url: string }> = []
    const calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = []
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
      calls.push({ method, path: url.pathname, ...(body ? { body } : {}) })
      if (url.pathname.endsWith('/ai-gateway/gateways') && method === 'GET') return Response.json({ success: true, result: [{ id: 'gateway-a', authentication: true }] })
      if (url.pathname.endsWith('/custom-providers') && method === 'GET') return Response.json({ success: true, result: providers })
      if (url.pathname.endsWith('/custom-providers') && method === 'POST') {
        const created = { id: 'provider-a', slug: String(body!.slug), name: String(body!.name), base_url: String(body!.base_url) }
        providers.push(created)
        return Response.json({ success: true, result: created })
      }
      if (url.pathname.includes('/custom-providers/') && method === 'PATCH') {
        providers[0]!.base_url = String(body!.base_url)
        return Response.json({ success: true, result: providers[0] })
      }
      if (url.pathname.endsWith('/routes') && method === 'GET') return Response.json({ success: true, data: { routes: [] } })
      if (url.pathname.endsWith('/routes') && method === 'POST') return Response.json({ success: true, result: { id: 'route-a', name: 'codeflare-mesh', version: { version_id: 'v' }, deployment: { deployment_id: 'd', version_id: 'v' } } })
      throw new Error(`unexpected ${method} ${url.pathname}`)
    }) as typeof fetch
    const client = new CloudflareGatewayClient('runtime-token', fetcher)
    const base = { accountId: 'account-a', gatewayId: 'gateway-a', providerName: 'Codeflare Inference Mesh', routeName: 'codeflare-mesh', publicModel: 'codeflare-mesh', providerTokenInstructions: 'manual' }

    // First sync against the workers.dev origin creates the provider.
    const first = await client.syncCustomProvider({ ...base, workerUrl: 'https://router.example.workers.dev/v1/chat/completions' })
    // Second sync against the custom domain must reconcile the SAME provider, not create a second.
    const second = await client.syncCustomProvider({ ...base, workerUrl: 'https://mesh.example.com/v1/chat/completions' })

    const providerPosts = calls.filter((call) => call.path.endsWith('/custom-providers') && call.method === 'POST')
    expect(providerPosts).toHaveLength(1)
    expect(first.providerSlug).toBe('codeflare-inference-mesh')
    expect(second.providerSlug).toBe('codeflare-inference-mesh')
    expect(providers).toHaveLength(1)
    expect(providers[0]!.base_url).toBe('https://mesh.example.com')
    expect(calls.some((call) => call.method === 'PATCH' && call.path.includes('/custom-providers/'))).toBe(true)
  })

  it('REQ-GWY-008 exposes live provision status for the selected gateway to admins only', async () => {
    const calls: Array<{ accountId: string; gatewayId: string; routeName: string; providerName: string }> = []
    const { router } = routerFixture({
      env: { CLOUDFLARE_API_TOKEN_RUNTIME: 'runtime-token', CLOUDFLARE_ACCOUNT_ID: 'account-a' },
      cloudflareClient: {
        syncCustomProvider: async () => { throw new Error('unused') },
        provisionCustomDomain: async () => { throw new Error('unused') },
        provisionStatus: async (accountId, gatewayId, routeName, providerName) => {
          calls.push({ accountId, gatewayId, routeName, providerName })
          return { provisioned: true, routeEnabled: true, routeId: 'route-a', providerId: 'provider-a' }
        }
      }
    })
    // Unauthenticated callers get 401; the live check never runs for them.
    expect((await router(new Request('https://router.test/admin/cloudflare/gateway/provision-status?gateway=gw-2'))).status).toBe(401)
    const res = await router(new Request('https://router.test/admin/cloudflare/gateway/provision-status?gateway=gw-2', { headers: bearer('admin-secret') }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ gatewayId: 'gw-2', provisioned: true, routeEnabled: true, routeId: 'route-a', providerId: 'provider-a' })
    // The pinned route/provider names are resolved server-side for the requested gateway.
    expect(calls).toEqual([{ accountId: 'account-a', gatewayId: 'gw-2', routeName: 'codeflare-mesh', providerName: 'Codeflare Inference Mesh' }])
  })

  it('REQ-GWY-008 reports a gateway provisioned only when the mesh route is enabled and the canonical provider exists', async () => {
    const scenario = (routes: unknown[], providers: unknown[]) => {
      const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input))
        const method = init?.method ?? 'GET'
        if (url.pathname.endsWith('/custom-providers') && method === 'GET') return Response.json({ success: true, result: providers })
        if (url.pathname.endsWith('/routes') && method === 'GET') return Response.json({ success: true, data: { routes } })
        throw new Error(`unexpected ${method} ${url.pathname}`)
      }) as typeof fetch
      return new CloudflareGatewayClient('runtime-token', fetcher).provisionStatus('account-a', 'gateway-a', 'codeflare-mesh', 'Codeflare Inference Mesh')
    }
    const provider = { id: 'provider-a', slug: 'codeflare-inference-mesh', name: 'Codeflare Inference Mesh', base_url: 'https://mesh.example.com' }
    // Route enabled + canonical (name-derived) provider present -> provisioned.
    expect(await scenario([{ id: 'route-a', name: 'codeflare-mesh', enabled: true }], [provider])).toEqual({ provisioned: true, routeEnabled: true, routeId: 'route-a', providerId: 'provider-a' })
    // No matching route -> not provisioned.
    expect((await scenario([], [provider])).provisioned).toBe(false)
    // Route present but disabled -> not provisioned even though the provider exists.
    expect(await scenario([{ id: 'route-a', name: 'codeflare-mesh', enabled: false }], [provider])).toMatchObject({ provisioned: false, routeEnabled: false, routeId: 'route-a' })
    // Route enabled but the canonical provider is absent -> not provisioned.
    expect(await scenario([{ id: 'route-a', name: 'codeflare-mesh', enabled: true }], [])).toMatchObject({ provisioned: false, routeEnabled: true })
  })

  it('REQ-GWY-003 re-sync reuses the existing dynamic route (data + route envelopes) instead of re-creating it', async () => {
    const calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = []
    const workerUrl = 'https://router.example.workers.dev/v1/chat/completions'
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
      calls.push({ method, path: url.pathname, ...(body ? { body } : {}) })
      if (url.pathname.endsWith('/ai-gateway/gateways') && method === 'GET') return Response.json({ success: true, result: [{ id: 'gateway-a', authentication: true }] })
      if (url.pathname.endsWith('/custom-providers') && method === 'GET') return Response.json({ success: true, result: [{ id: 'provider-a', slug: 'codeflare-inference-mesh', name: 'Codeflare Inference Mesh', base_url: 'https://router.example.workers.dev' }] })
      // Listing routes uses the `data` envelope; the existing route must be found here so sync stays idempotent.
      if (url.pathname.endsWith('/routes') && method === 'GET') return Response.json({ success: true, data: { routes: [{ id: 'route-a', name: 'codeflare-mesh', elements: [{ stale: true }] }] } })
      // Get-one uses `result`; stale elements force reconciliation down the PATCH branch.
      if (url.pathname.endsWith('/routes/route-a') && method === 'GET') return Response.json({ success: true, result: { id: 'route-a', name: 'codeflare-mesh', enabled: true, elements: [{ stale: true }] } })
      // PATCH returns the route under the `route` envelope; unwrapping it (not `result`) proves the fix.
      if (url.pathname.endsWith('/routes/route-a') && method === 'PATCH') return Response.json({ success: true, route: { id: 'route-a', name: 'codeflare-mesh', version: { version_id: 'version-b' }, deployment: { deployment_id: 'deployment-b', version_id: 'version-b' } } })
      throw new Error(`unexpected call ${method} ${url.pathname}`)
    }) as typeof fetch

    const result = await new CloudflareGatewayClient('runtime-token', fetcher).syncCustomProvider({ accountId: 'account-a', gatewayId: 'gateway-a', workerUrl, providerName: 'Codeflare Inference Mesh', routeName: 'codeflare-mesh', publicModel: 'codeflare-mesh', providerTokenInstructions: 'manual' })

    const routeCalls = calls.filter((call) => call.path.includes('/routes')).map((call) => `${call.method} ${call.path.split('/ai-gateway/')[1]}`)
    expect(routeCalls).toEqual([
      'GET gateways/gateway-a/routes',
      'GET gateways/gateway-a/routes/route-a',
      'PATCH gateways/gateway-a/routes/route-a'
    ])
    expect(calls.some((call) => call.method === 'POST' && call.path.endsWith('/routes'))).toBe(false)
    expect(result).toMatchObject({ routeId: 'route-a', routeVersionId: 'version-b', deploymentId: 'deployment-b' })
  })

  it('REQ-SEC-012 provisions an Authenticated Gateway and reconciles an existing open gateway', async () => {
    const makeFetcher = (gatewaysList: readonly unknown[]) => {
      const calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = []
      const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input))
        const method = init?.method ?? 'GET'
        const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
        calls.push({ method, path: url.pathname, ...(body ? { body } : {}) })
        if (url.pathname.endsWith('/ai-gateway/gateways') && method === 'GET') return Response.json({ success: true, result: gatewaysList })
        if (url.pathname.endsWith('/ai-gateway/gateways') && method === 'POST') return Response.json({ success: true, result: { id: 'gateway-a' } })
        if (url.pathname.endsWith('/ai-gateway/gateways/gateway-a') && method === 'PUT') return Response.json({ success: true, result: { id: 'gateway-a', authentication: true } })
        if (url.pathname.endsWith('/custom-providers') && method === 'GET') return Response.json({ success: true, result: [] })
        if (url.pathname.endsWith('/custom-providers') && method === 'POST') return Response.json({ success: true, result: { id: 'provider-a', slug: 'codeflare-inference-mesh' } })
        if (url.pathname.endsWith('/routes') && method === 'GET') return Response.json({ success: true, data: { routes: [] } })
        return Response.json({ success: true, result: { id: 'route-a', name: 'codeflare-mesh', version: { version_id: 'version-a' }, deployment: { deployment_id: 'deployment-a', version_id: 'version-a' } } })
      }) as typeof fetch
      return { calls, fetcher }
    }
    const syncInput = { accountId: 'account-a', gatewayId: 'gateway-a', workerUrl: 'https://router.example.workers.dev/v1/chat/completions', providerName: 'Codeflare Inference Mesh', routeName: 'codeflare-mesh', publicModel: 'codeflare-mesh', providerTokenInstructions: 'manual' }

    // A new gateway is created authenticated.
    const created = makeFetcher([])
    await new CloudflareGatewayClient('runtime-token', created.fetcher).syncCustomProvider(syncInput)
    expect(created.calls.find((call) => call.method === 'POST' && call.path.endsWith('/ai-gateway/gateways'))!.body).toMatchObject({ authentication: true })

    // An existing open gateway is reconciled to authenticated via PUT, preserving
    // its operator-tuned cache/rate-limit settings instead of resetting them.
    const reconciled = makeFetcher([{ id: 'gateway-a', authentication: false, cache_ttl: 300, rate_limiting_limit: 50 }])
    await new CloudflareGatewayClient('runtime-token', reconciled.fetcher).syncCustomProvider(syncInput)
    expect(reconciled.calls.find((call) => call.method === 'PUT' && call.path.endsWith('/ai-gateway/gateways/gateway-a'))?.body).toMatchObject({ authentication: true, cache_ttl: 300, rate_limiting_limit: 50 })

    // An already-authenticated gateway triggers no reconcile write.
    const skipped = makeFetcher([{ id: 'gateway-a', authentication: true }])
    await new CloudflareGatewayClient('runtime-token', skipped.fetcher).syncCustomProvider(syncInput)
    expect(skipped.calls.some((call) => call.method === 'PUT')).toBe(false)
  })

  it('CloudflareGatewayClient invokes the fetcher as a free function so the global fetch keeps its native receiver (no Workers illegal invocation)', async () => {
    let receiver: unknown = 'unset'
    const fetcher = function (this: unknown, _input: RequestInfo | URL, _init?: RequestInit) {
      receiver = this
      return Promise.resolve(Response.json({ success: true, result: [] }))
    } as unknown as typeof fetch
    const client = new CloudflareGatewayClient('runtime-token', fetcher)
    await client.listGateways('account-a')
    expect(receiver).not.toBe(client)
    expect(receiver).toBeUndefined()
  })

  it('REQ-GWY-006 surfaces the Cloudflare error code and message on a failed API call', async () => {
    const fetcher = (async () => Response.json({ success: false, errors: [{ code: 2003, message: 'model id invalid' }] }, { status: 400 })) as unknown as typeof fetch
    const client = new CloudflareGatewayClient('runtime-token', fetcher)
    await expect(client.listGateways('account-a')).rejects.toThrow(/400.*2003.*model id invalid/)
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
      if (url.pathname.endsWith('/ai-gateway/gateways') && method === 'GET') return Response.json({ success: true, result: [{ id: 'gateway-a', authentication: true }] })
      if (url.pathname.endsWith('/custom-providers') && method === 'GET') return Response.json({ success: true, result: [{ id: 'provider-a', slug: 'codeflare-inference-mesh', name: 'Codeflare Inference Mesh', base_url: 'https://old.example.com' }] })
      if (url.pathname.endsWith('/custom-providers/provider-a') && method === 'PATCH') return Response.json({ success: true, result: { id: 'provider-a', slug: 'codeflare-inference-mesh', name: body!.name, base_url: body!.base_url } })
      if (url.pathname.endsWith('/routes') && method === 'GET') return Response.json({ success: true, result: { data: { routes: [{ id: 'route-a', name: 'codeflare-mesh' }] } } })
      if (url.pathname.endsWith('/routes/route-a') && method === 'GET') return Response.json({ success: true, result: { id: 'route-a', name: 'codeflare-mesh', elements: [] } })
      return Response.json({ success: true, result: { id: 'route-a', version: { version_id: 'version-a' }, deployment: { deployment_id: 'deployment-a', version_id: 'version-a' } } })
    }) as typeof fetch
    const client = new CloudflareGatewayClient('runtime-token', fetcher)

    await client.syncCustomProvider({ accountId: 'account-a', gatewayId: 'gateway-a', workerUrl: 'https://router.example.workers.dev', providerName: 'Codeflare Inference Mesh', routeName: 'codeflare-mesh', publicModel: 'codeflare-mesh', providerTokenInstructions: 'manual' })

    expect(calls.some((call) => call.method === 'PATCH' && call.path.endsWith('/custom-providers/provider-a') && call.body?.base_url === 'https://router.example.workers.dev')).toBe(true)
    expect(calls.some((call) => call.method === 'PATCH' && call.path.endsWith('/routes/route-a') && Array.isArray((call.body as { elements?: unknown }).elements) && (call.body as { enabled?: unknown }).enabled === true)).toBe(true)
  })

  it('REQ-GWY-003 reuses existing Cloudflare Gateway resources on repeat sync', async () => {
    const calls: string[] = []
    const elements = [{ id: 'start', type: 'start', outputs: { next: { elementId: 'model' } } }, { id: 'model', type: 'model', properties: { provider: 'custom-codeflare-inference-mesh', model: 'codeflare-mesh', retries: 3, timeout: 120000 }, outputs: { success: { elementId: 'end' }, fallback: { elementId: 'end' } } }, { id: 'end', type: 'end', outputs: {} }]
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const method = init?.method ?? 'GET'
      calls.push(`${method} ${url.pathname}`)
      if (url.pathname.endsWith('/ai-gateway/gateways')) return Response.json({ success: true, result: [{ id: 'gateway-a', authentication: true }] })
      if (url.pathname.endsWith('/custom-providers')) return Response.json({ success: true, result: [{ id: 'provider-a', slug: 'codeflare-inference-mesh', name: 'Codeflare Inference Mesh', base_url: 'https://router.example.workers.dev' }] })
      if (url.pathname.endsWith('/routes')) return Response.json({ success: true, result: { data: { routes: [{ id: 'route-a', name: 'codeflare-mesh' }] } } })
      if (url.pathname.endsWith('/routes/route-a')) return Response.json({ success: true, result: { id: 'route-a', name: 'codeflare-mesh', elements, version: { version_id: 'version-a' }, deployment: { deployment_id: 'deployment-a', version_id: 'version-a' } } })
      throw new Error(`unexpected ${method} ${url.pathname}`)
    }) as typeof fetch

    const result = await new CloudflareGatewayClient('runtime-token', fetcher).syncCustomProvider({ accountId: 'account-a', gatewayId: 'gateway-a', workerUrl: 'https://router.example.workers.dev', providerName: 'Codeflare Inference Mesh', routeName: 'codeflare-mesh', publicModel: 'codeflare-mesh', providerTokenInstructions: 'manual' })

    expect(calls.every((call) => call.startsWith('GET '))).toBe(true)
    expect(result).toMatchObject({ providerId: 'provider-a', routeId: 'route-a', routeVersionId: 'version-a', deploymentId: 'deployment-a' })
  })

  it('REQ-GWY-003 re-enables a disabled route even when its routing elements already match', async () => {
    const elements = [{ id: 'start', type: 'start', outputs: { next: { elementId: 'model' } } }, { id: 'model', type: 'model', properties: { provider: 'custom-codeflare-inference-mesh', model: 'codeflare-mesh', retries: 3, timeout: 120000 }, outputs: { success: { elementId: 'end' }, fallback: { elementId: 'end' } } }, { id: 'end', type: 'end', outputs: {} }]
    const calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = []
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
      calls.push({ method, path: url.pathname, ...(body ? { body } : {}) })
      if (url.pathname.endsWith('/ai-gateway/gateways')) return Response.json({ success: true, result: [{ id: 'gateway-a', authentication: true }] })
      if (url.pathname.endsWith('/custom-providers')) return Response.json({ success: true, result: [{ id: 'provider-a', slug: 'codeflare-inference-mesh', name: 'Codeflare Inference Mesh', base_url: 'https://router.example.workers.dev' }] })
      if (url.pathname.endsWith('/routes') && method === 'GET') return Response.json({ success: true, result: { data: { routes: [{ id: 'route-a', name: 'codeflare-mesh' }] } } })
      if (url.pathname.endsWith('/routes/route-a') && method === 'GET') return Response.json({ success: true, result: { id: 'route-a', name: 'codeflare-mesh', elements, enabled: false } })
      return Response.json({ success: true, result: { id: 'route-a', enabled: true, version: { version_id: 'version-a' }, deployment: { deployment_id: 'deployment-a', version_id: 'version-a' } } })
    }) as typeof fetch

    await new CloudflareGatewayClient('runtime-token', fetcher).syncCustomProvider({ accountId: 'account-a', gatewayId: 'gateway-a', workerUrl: 'https://router.example.workers.dev', providerName: 'Codeflare Inference Mesh', routeName: 'codeflare-mesh', publicModel: 'codeflare-mesh', providerTokenInstructions: 'manual' })

    expect(calls.some((call) => call.method === 'PATCH' && call.path.endsWith('/routes/route-a') && (call.body as { enabled?: unknown }).enabled === true)).toBe(true)
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
      body: JSON.stringify({ model: 'codeflare-mesh', messages: [] })
    }))

    expect(capture.request!.headers.get('authorization')).toBe('Bearer upstream-secret')
    expect(capture.request!.headers.get('cf-access-client-secret')).toBeNull()
  })

  it('REQ-RUN-004 updates profile rollout as versioned configuration', async () => {
    const { router, store } = routerFixture()
    await seedLegacyDefaults(store)
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
    await seedLegacyDefaults(store)

    const activateSplit = await router(new Request('https://router.test/admin/profiles/activate', {
      method: 'POST',
      headers: { ...bearer('admin-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ profileId: 'mesh-split-qwen36-35b' })
    }))
    const afterSplit = await store.listProfiles()

    expect(activateSplit.status).toBe(200)
    expect(afterSplit.find((profile) => profile.id === 'mesh-split-qwen36-35b')).toMatchObject({ active: true, rolloutPercent: 100, version: 2 })
    // Single-active: activating split deactivates the seeded active model (smoke); the already-inactive 35B is untouched.
    expect(afterSplit.find((profile) => profile.id === 'mesh-smoke-qwen25-1.5b')).toMatchObject({ active: false, rolloutPercent: 0, version: 2 })
    expect(afterSplit.find((profile) => profile.id === 'mesh-default-qwen36-35b')).toMatchObject({ active: false, rolloutPercent: 0, version: 1 })

    const activateSingle = await router(new Request('https://router.test/admin/profiles/activate', {
      method: 'POST',
      headers: { ...bearer('admin-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ profileId: 'mesh-default-qwen36-35b' })
    }))
    const afterSingle = await store.listProfiles()

    expect(activateSingle.status).toBe(200)
    // 35B was inactive at v1, so activating it bumps it to v2; split (active at v2) is deactivated to v3.
    expect(afterSingle.find((profile) => profile.id === 'mesh-default-qwen36-35b')).toMatchObject({ active: true, rolloutPercent: 100, version: 2 })
    expect(afterSingle.find((profile) => profile.id === 'mesh-split-qwen36-35b')).toMatchObject({ active: false, rolloutPercent: 0, version: 3 })

    const rollout = await router(new Request('https://router.test/admin/profiles/rollout', {
      method: 'POST',
      headers: { ...bearer('admin-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ profileId: 'mesh-split-qwen36-35b', rolloutPercent: 40 })
    }))
    const afterRollout = await store.listProfiles()
    const activeOwners = afterRollout.filter((profile) => profile.active && profile.publicAliases.includes('codeflare-mesh'))

    expect(rollout.status).toBe(200)
    expect(activeOwners.map((profile) => profile.id)).toEqual(['mesh-split-qwen36-35b'])
    expect(afterRollout.find((profile) => profile.id === 'mesh-split-qwen36-35b')).toMatchObject({ active: true, rolloutPercent: 40 })
    expect(afterRollout.find((profile) => profile.id === 'mesh-default-qwen36-35b')).toMatchObject({ active: false, rolloutPercent: 0 })
  })

  it('REQ-ADM-021 configures a profile context window, model ref, and VRAM budget through the validated store path', async () => {
    const { router, store } = routerFixture()
    await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)
    const configure = (body: unknown) => router(new Request('https://router.test/admin/profiles/config', {
      method: 'POST',
      headers: { ...bearer('admin-secret'), 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }))

    const ok = await configure({ profileId: 'mesh-smoke-qwen25-1.5b', contextWindow: 8192, modelRef: 'unsloth/Qwen2.5-Coder-1.5B-Instruct-GGUF:Q4_K_M' })
    const smoke = (await store.listProfiles()).find((profile) => profile.id === 'mesh-smoke-qwen25-1.5b')!

    expect(ok.status).toBe(200)
    expect(smoke.contextWindow).toBe(8192)
    expect(smoke.meshllm!.modelRef).toBe('unsloth/Qwen2.5-Coder-1.5B-Instruct-GGUF:Q4_K_M')
    expect(smoke.upstreamModel).toBe('unsloth/Qwen2.5-Coder-1.5B-Instruct-GGUF:Q4_K_M')

    // A context-only update must leave the model ref untouched.
    const ctxOnly = await configure({ profileId: 'mesh-smoke-qwen25-1.5b', contextWindow: 4096 })
    const afterCtx = (await store.listProfiles()).find((profile) => profile.id === 'mesh-smoke-qwen25-1.5b')!
    expect(ctxOnly.status).toBe(200)
    expect(afterCtx.contextWindow).toBe(4096)
    expect(afterCtx.meshllm!.modelRef).toBe('unsloth/Qwen2.5-Coder-1.5B-Instruct-GGUF:Q4_K_M')

    // A per-model VRAM budget persists to the mesh settings; a fractional cap is allowed and
    // 0 clears the cap. A context-only update must not disturb an existing budget.
    expect((await configure({ profileId: 'mesh-smoke-qwen25-1.5b', maxVramGb: 22.5 })).status).toBe(200)
    expect((await store.listProfiles()).find((profile) => profile.id === 'mesh-smoke-qwen25-1.5b')!.meshllm!.maxVramGb).toBe(22.5)
    expect((await configure({ profileId: 'mesh-smoke-qwen25-1.5b', contextWindow: 2048 })).status).toBe(200)
    expect((await store.listProfiles()).find((profile) => profile.id === 'mesh-smoke-qwen25-1.5b')!.meshllm!.maxVramGb).toBe(22.5)
    expect((await configure({ profileId: 'mesh-smoke-qwen25-1.5b', maxVramGb: 0 })).status).toBe(200)
    expect((await store.listProfiles()).find((profile) => profile.id === 'mesh-smoke-qwen25-1.5b')!.meshllm!.maxVramGb).toBe(0)

    // Context window 0 means Auto (mesh-llm sizes it) and is accepted; a negative or
    // non-integer context, blank model, negative VRAM, unknown profile, and missing
    // admin auth are all rejected.
    expect((await configure({ profileId: 'mesh-smoke-qwen25-1.5b', contextWindow: 0 })).status).toBe(200)
    expect((await configure({ profileId: 'mesh-smoke-qwen25-1.5b', contextWindow: -1 })).status).toBe(400)
    expect((await configure({ profileId: 'mesh-smoke-qwen25-1.5b', contextWindow: 2.5 })).status).toBe(400)
    expect((await configure({ profileId: 'mesh-smoke-qwen25-1.5b', modelRef: '   ' })).status).toBe(400)
    expect((await configure({ profileId: 'mesh-smoke-qwen25-1.5b', maxVramGb: -1 })).status).toBe(400)
    expect((await configure({ profileId: 'no-such-profile', contextWindow: 1024 })).status).toBe(404)
    const noAuth = await router(new Request('https://router.test/admin/profiles/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profileId: 'mesh-smoke-qwen25-1.5b', contextWindow: 1024 }) }))
    expect(noAuth.status).toBe(401)
  })

  it('REQ-ADM-021 configures direct llama.cpp settings through the admin profile config path', async () => {
    const { router, store } = routerFixture()
    const add = await router(new Request('https://router.test/admin/profiles/add', {
      method: 'POST',
      headers: { ...bearer('admin-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ modelRef: 'unsloth/Qwen3-14B-GGUF:Q4_K_M', mode: 'single', runtime: 'llamacpp' })
    }))
    const profileId = (await add.json() as { profileId: string }).profileId
    const configure = (body: Record<string, unknown>) => router(new Request('https://router.test/admin/profiles/config', {
      method: 'POST',
      headers: { ...bearer('admin-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ profileId, ...body })
    }))

    const ok = await configure({ llamacpp: { contextWindow: 131072, parallel: 2, kvUnified: false, cachePrompt: false, cacheReuse: 512, gpuLayers: '99', cacheTypeK: 'q4_0', cacheTypeV: 'q4_0', batch: 8192, ubatch: 2048, flashAttn: true, maxOutputTokens: 8192, reasoning: { enabled: true, format: 'deepseek', budget: 4096 } } })
    const configured = (await store.listProfiles()).find((profile) => profile.id === profileId)!

    expect(ok.status).toBe(200)
    expect(configured.runtime).toBe('llamacpp')
    expect(configured.contextWindow).toBe(131072)
    expect(configured.llamacpp).toMatchObject({ contextWindow: 131072, parallel: 2, kvUnified: false, cachePrompt: false, cacheReuse: 512, gpuLayers: '99', cacheTypeK: 'q4_0', cacheTypeV: 'q4_0', batch: 8192, ubatch: 2048, flashAttn: true, maxOutputTokens: 8192, reasoning: { enabled: true, format: 'deepseek', budget: 4096 } })
    expect((await configure({ llamacpp: { batch: null, flashAttn: null, maxOutputTokens: null, reasoning: null } })).status).toBe(200)
    const cleared = (await store.listProfiles()).find((profile) => profile.id === profileId)!
    expect(cleared.llamacpp?.batch).toBeUndefined()
    expect(cleared.llamacpp?.flashAttn).toBeUndefined()
    expect(cleared.llamacpp?.maxOutputTokens).toBeUndefined()
    expect(cleared.llamacpp?.reasoning).toBeUndefined()
    // A null kvUnified clears the stored field; normalization then reads it back as
    // on — the same coercion that upgrades pre-field profile blobs without a migration.
    expect((await configure({ llamacpp: { kvUnified: null } })).status).toBe(200)
    const kvReset = (await store.listProfiles()).find((profile) => profile.id === profileId)!
    expect(kvReset.llamacpp?.kvUnified).toBe(true)
    expect((await configure({ llamacpp: { parallel: -1 } })).status).toBe(200)
    const autoParallel = (await store.listProfiles()).find((profile) => profile.id === profileId)!
    expect(autoParallel.llamacpp?.parallel).toBe(-1)
    // contextWindow 0 = Auto (llama-server loads the model's native context) on both the
    // settings block and the top-level field the drawer saves; a fixed value below the
    // 4096 floor is still rejected.
    expect((await configure({ llamacpp: { contextWindow: 0 } })).status).toBe(200)
    const autoContext = (await store.listProfiles()).find((profile) => profile.id === profileId)!
    expect(autoContext.llamacpp?.contextWindow).toBe(0)
    expect((await configure({ contextWindow: 0 })).status).toBe(200)
    const autoTopLevel = (await store.listProfiles()).find((profile) => profile.id === profileId)!
    expect(autoTopLevel.contextWindow).toBe(0)
    expect((await configure({ llamacpp: { contextWindow: 2048 } })).status).toBe(400)
    expect((await configure({ contextWindow: 2048 })).status).toBe(400)
    expect((await configure({ llamacpp: { contextWindow: 2048 } })).status).toBe(400)
    expect((await configure({ llamacpp: { parallel: 0 } })).status).toBe(400)
    expect((await configure({ llamacpp: { parallel: -2 } })).status).toBe(400)
    expect((await configure({ llamacpp: { kvUnified: 'yes' } })).status).toBe(400)
    expect((await configure({ llamacpp: { parallel: -1, kvUnified: false } })).status).toBe(400)
    expect((await configure({ llamacpp: { cacheTypeK: 'bad' } })).status).toBe(400)
    expect((await configure({ llamacpp: { gpuLayers: 'bad' } })).status).toBe(400)
    expect((await configure({ llamacpp: { bindPort: 9337 } })).status).toBe(400)
  })

  it('REQ-RUN-002 persists per-model runtime tunables and clears them back to Auto', async () => {
    const { router, store } = routerFixture()
    await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)
    const configure = (body: unknown) => router(new Request('https://router.test/admin/profiles/config', {
      method: 'POST',
      headers: { ...bearer('admin-secret'), 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }))
    const meshllm = async () => (await store.listProfiles()).find((profile) => profile.id === 'mesh-smoke-qwen25-1.5b')!.meshllm!

    const set = await configure({ profileId: 'mesh-smoke-qwen25-1.5b', parallel: 4, cacheTypeK: 'q4_0', cacheTypeV: 'q4_0', batch: 8192, ubatch: 4096, flashAttn: true, maxOutputTokens: 8192, reasoning: { enabled: true, format: 'deepseek', budget: 4096 }, prefixCache: { enabled: true, maxEntries: 16, payloadMode: 'kv-recurrent', sharedStrideTokens: 128, sharedRecordLimit: 4 } })
    expect(set.status).toBe(200)
    let m = await meshllm()
    expect(m.parallel).toBe(4)
    expect(m.cacheTypeK).toBe('q4_0')
    expect(m.cacheTypeV).toBe('q4_0')
    expect(m.batch).toBe(8192)
    expect(m.ubatch).toBe(4096)
    expect(m.flashAttn).toBe(true)
    expect(m.maxOutputTokens).toBe(8192)
    expect(m.reasoning).toEqual({ enabled: true, format: 'deepseek', budget: 4096 })
    expect(m.prefixCache).toEqual({ enabled: true, maxEntries: 16, payloadMode: 'kv-recurrent', sharedStrideTokens: 128, sharedRecordLimit: 4 })

    // A partial prefix-cache update layers onto the existing block: sending only enabled
    // keeps maxEntries and payloadMode.
    expect((await configure({ profileId: 'mesh-smoke-qwen25-1.5b', prefixCache: { enabled: false } })).status).toBe(200)
    expect((await meshllm()).prefixCache).toEqual({ enabled: false, maxEntries: 16, payloadMode: 'kv-recurrent', sharedStrideTokens: 128, sharedRecordLimit: 4 })

    // A partial reasoning update layers onto the existing block instead of replacing it,
    // so sending only the budget keeps the enabled flag and format.
    expect((await configure({ profileId: 'mesh-smoke-qwen25-1.5b', reasoning: { budget: 2048 } })).status).toBe(200)
    expect((await meshllm()).reasoning).toEqual({ enabled: true, format: 'deepseek', budget: 2048 })

    // An explicit null clears a single reasoning sub-field back to Auto (like the scalar
    // tunables) while the others survive.
    expect((await configure({ profileId: 'mesh-smoke-qwen25-1.5b', reasoning: { budget: null } })).status).toBe(200)
    expect((await meshllm()).reasoning).toEqual({ enabled: true, format: 'deepseek' })

    // Clearing a field back to Auto removes the key entirely, so JSON.stringify never
    // leaves a stale undefined; untouched fields persist.
    expect((await configure({ profileId: 'mesh-smoke-qwen25-1.5b', parallel: null, cacheTypeK: '', flashAttn: null, reasoning: null, prefixCache: null })).status).toBe(200)
    m = await meshllm()
    expect('parallel' in m).toBe(false)
    expect('cacheTypeK' in m).toBe(false)
    expect('flashAttn' in m).toBe(false)
    expect('reasoning' in m).toBe(false)
    expect('prefixCache' in m).toBe(false)
    expect(m.cacheTypeV).toBe('q4_0')
    expect(m.batch).toBe(8192)

    // Invalid values are rejected at the boundary.
    expect((await configure({ profileId: 'mesh-smoke-qwen25-1.5b', parallel: 0.5 })).status).toBe(400)
    expect((await configure({ profileId: 'mesh-smoke-qwen25-1.5b', cacheTypeK: 'bogus' })).status).toBe(400)
    expect((await configure({ profileId: 'mesh-smoke-qwen25-1.5b', batch: -1 })).status).toBe(400)
    expect((await configure({ profileId: 'mesh-smoke-qwen25-1.5b', flashAttn: 'yes' })).status).toBe(400)
    // maxEntries is capped at 128 so an operator cannot re-introduce the KV-pool overrun.
    expect((await configure({ profileId: 'mesh-smoke-qwen25-1.5b', prefixCache: { maxEntries: 256 } })).status).toBe(400)
    expect((await configure({ profileId: 'mesh-smoke-qwen25-1.5b', prefixCache: 'on' })).status).toBe(400)
    // payloadMode must be one of the mesh-llm payload kinds.
    expect((await configure({ profileId: 'mesh-smoke-qwen25-1.5b', prefixCache: { payloadMode: 'bogus' } })).status).toBe(400)
  })

  it('REQ-ADM-027 names a model on creation and defaults the name to the model file', async () => {
    const { router, store } = routerFixture()
    const add = (body: unknown) => router(new Request('https://router.test/admin/profiles/add', { method: 'POST', headers: { ...bearer('admin-secret'), 'content-type': 'application/json' }, body: JSON.stringify(body) }))

    // A supplied name becomes the display name; the model's own call name comes from the ref.
    const named = await add({ modelRef: 'unsloth/Qwen3-14B-GGUF:Q4_K_M', name: 'Fast Coder' })
    expect(named.status).toBe(201)
    const created = (await store.listProfiles()).find((profile) => profile.displayName === 'Fast Coder')
    expect(created).toBeDefined()
    expect(created!.publicAliases[0]).toBe('codeflare-mesh')
    expect(created!.publicAliases).toContain('qwen3-14b-gguf-q4-k-m')

    // With no name, the display name is the model-file segment — and a split model gets
    // no "(multi-machine)" suffix, because the serving-mode badge carries that now.
    const unnamed = await add({ modelRef: 'unsloth/Other-Model-GGUF:Q4_K_M', mode: 'split' })
    expect(unnamed.status).toBe(201)
    const other = (await store.listProfiles()).find((profile) => profile.id.indexOf('custom-other-model') === 0)!
    expect(other.displayName).toBe('Other-Model-GGUF:Q4_K_M')
    expect(other.meshllm!.split).toBe(true)
  })

  it('REQ-ADM-027 renames a model display name and call name with collision and reserved-alias guards', async () => {
    const { router, store } = routerFixture()
    await seedLegacyDefaults(store)
    await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)
    const configure = (body: unknown) => router(new Request('https://router.test/admin/profiles/config', { method: 'POST', headers: { ...bearer('admin-secret'), 'content-type': 'application/json' }, body: JSON.stringify(body) }))
    const smoke = async () => (await store.listProfiles()).find((profile) => profile.id === 'mesh-smoke-qwen25-1.5b')!

    // A freshly-seeded default carries extra canonical aliases; an unrelated setting save
    // must NOT collapse them (the config path only rewrites aliases when callName is sent).
    expect((await configure({ profileId: 'mesh-smoke-qwen25-1.5b', contextWindow: 16384 })).status).toBe(200)
    expect((await smoke()).publicAliases).toEqual(['codeflare-mesh', 'mesh-smoke', 'smoke-test'])

    // Rename sets the display name and swaps the model's own call name, keeping the shared alias.
    expect((await configure({ profileId: 'mesh-smoke-qwen25-1.5b', name: 'Speedy', callName: 'Speedy Coder!' })).status).toBe(200)
    const renamed = await smoke()
    expect(renamed.displayName).toBe('Speedy')
    expect(renamed.publicAliases).toEqual(['codeflare-mesh', 'speedy-coder'])

    // A context-only save leaves the name and aliases untouched (partial update, so a
    // default model never loses its extra canonical aliases on an unrelated edit).
    expect((await configure({ profileId: 'mesh-smoke-qwen25-1.5b', contextWindow: 4096 })).status).toBe(200)
    const afterCtx = await smoke()
    expect(afterCtx.displayName).toBe('Speedy')
    expect(afterCtx.publicAliases).toEqual(['codeflare-mesh', 'speedy-coder'])

    // A call name whose slug collides with another model's alias is refused; unchanged.
    expect((await configure({ profileId: 'mesh-split-qwen36-35b', callName: 'shared' })).status).toBe(200)
    expect((await configure({ profileId: 'mesh-smoke-qwen25-1.5b', callName: 'Shared' })).status).toBe(409)
    expect((await smoke()).publicAliases).toEqual(['codeflare-mesh', 'speedy-coder'])

    // The reserved shared alias, an empty slug, and a blank display name are all rejected.
    expect((await configure({ profileId: 'mesh-smoke-qwen25-1.5b', callName: 'codeflare-mesh' })).status).toBe(409)
    expect((await configure({ profileId: 'mesh-smoke-qwen25-1.5b', callName: '   ' })).status).toBe(400)
    expect((await configure({ profileId: 'mesh-smoke-qwen25-1.5b', name: '   ' })).status).toBe(400)
  })

  it('REQ-ADM-027 renames a model over the automation API with the same guards', async () => {
    const { router, store } = routerFixture()
    await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)
    const key = await (await router(new Request('https://router.test/api/v1/keys', { method: 'POST', headers: bearer('admin-secret') }))).json() as { token: string }
    const configure = (body: unknown) => router(new Request('https://router.test/api/v1/models/mesh-smoke-qwen25-1.5b', { method: 'POST', headers: { ...bearer(key.token), 'content-type': 'application/json' }, body: JSON.stringify(body) }))

    const ok = await configure({ name: 'API Named', callName: 'api-handle' })
    expect(ok.status).toBe(200)
    const model = (await ok.json() as { model: { displayName: string; callableNames: string[] } }).model
    expect(model.displayName).toBe('API Named')
    expect(model.callableNames).toEqual(['codeflare-mesh', 'api-handle'])
    expect((await store.listProfiles()).find((profile) => profile.id === 'mesh-smoke-qwen25-1.5b')!.publicAliases).toEqual(['codeflare-mesh', 'api-handle'])

    // The reserved shared alias is refused over the API too.
    expect((await configure({ callName: 'codeflare-mesh' })).status).toBe(409)
  })

  it('REQ-ADM-009 activates profiles alias-exclusively and records the audit event', async () => {
    const { router, store } = routerFixture()
    await seedLegacyDefaults(store)

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
    // Single-active: the seeded active model (smoke) is the one deactivated when split is activated.
    expect(body).toMatchObject({ ok: true, activated: 'mesh-split-qwen36-35b', deactivated: ['mesh-smoke-qwen25-1.5b'] })
    expect(owners.map((profile) => profile.id)).toEqual(['mesh-split-qwen36-35b'])
    expect(store.audit.some((event) => event.type === 'profile_activated' && event.actor === 'admin' && event.target === 'mesh-split-qwen36-35b')).toBe(true)
  })

  it('REQ-OBS-006 records profile activation audit events', async () => {
    const { router, store } = routerFixture()
    await seedLegacyDefaults(store)

    await router(new Request('https://router.test/admin/profiles/activate', {
      method: 'POST',
      headers: { ...bearer('admin-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ profileId: 'mesh-split-qwen36-35b' })
    }))
    const event = store.audit.find((item) => item.type === 'profile_activated')!

    expect(event).toMatchObject({ actor: 'admin', target: 'mesh-split-qwen36-35b' })
    expect(event.detail).toEqual({ deactivated: ['mesh-smoke-qwen25-1.5b'] })
  })

  it('REQ-NODE-002 heartbeat and claim responses carry mesh bootstrap and desired versions', async () => {
    const { router, store } = routerFixture({
      env: { MESH_STATE_KEY: MESH_STATE_KEY_B64 },
      releasesFetcher: githubReleasesFetcher(['v0.2.0', 'v0.1.0'])
    })
    const claimAdmin = (await (await router(new Request('https://router.test/admin/setup', { method: 'POST' }))).json() as { adminToken: string }).adminToken
    const setup = await (await router(new Request('https://router.test/admin/setup-tokens', { method: 'POST', headers: bearer(claimAdmin) }))).json() as { setupToken: string }
    expect((await router(new Request('https://router.test/admin/agent-versions', { headers: bearer('admin-secret') }))).status).toBe(200)
    const select = await router(new Request('https://router.test/admin/agent-version', {
      method: 'POST',
      headers: { ...bearer('admin-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ version: 'v0.2.0' })
    }))

    const claim = await router(new Request('https://router.test/node/claim', {
      method: 'POST',
      headers: { ...bearer(setup.setupToken), 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Node A', meshIp: '100.64.1.10', inferencePort: 8080, publicModels: ['codeflare-mesh'], activeProfileIds: ['mesh-smoke-qwen25-1.5b'], capacity: 2 })
    }))
    const claimed = await claim.json() as { nodeId: string; nodeToken: string; meshBootstrap?: { action: string }; desiredAgentVersion?: string; desiredRuntimeVersions?: { meshllm: string; llamacpp: string } }
    const heartbeat = await router(new Request('https://router.test/node/heartbeat', {
      method: 'POST',
      headers: { ...bearer(claimed.nodeToken), 'content-type': 'application/json' },
      body: heartbeatBody({ nodeId: claimed.nodeId, agentVersion: 'v0.1.0' })
    }))
    const heartbeatResponse = await heartbeat.json() as { ok: boolean; desiredProfiles: unknown[]; meshBootstrap?: { action: string; rotation: number }; desiredAgentVersion?: string; desiredRuntimeVersions?: { meshllm: string; llamacpp: string } }
    const node = await store.getNode(claimed.nodeId)

    expect(select.ok).toBe(true)
    expect(claim.status).toBe(201)
    expect(claimed.desiredAgentVersion).toBe('v0.2.0')
    expect(claimed.desiredRuntimeVersions).toEqual({ meshllm: 'v0.72.2', llamacpp: 'b9912' })
    expect(claimed.meshBootstrap).toBeDefined()
    expect(['create', 'wait']).toContain(claimed.meshBootstrap!.action)
    expect(heartbeat.status).toBe(200)
    expect(heartbeatResponse.ok).toBe(true)
    expect(heartbeatResponse.meshBootstrap).toMatchObject({ action: 'create' })
    expect(typeof heartbeatResponse.meshBootstrap!.rotation).toBe('number')
    expect(heartbeatResponse.desiredAgentVersion).toBe('v0.2.0')
    expect(heartbeatResponse.desiredRuntimeVersions).toEqual({ meshllm: 'v0.72.2', llamacpp: 'b9912' })
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
          readyModels: [SMOKE_UPSTREAM],
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
      readyModels: [SMOKE_UPSTREAM],
      splitEnabled: false,
      stageCount: 1,
      apiReady: true,
      consoleReady: true,
      meshllmVersion: '0.72.2'
    })
    expect(Array.isArray(body.meshHealth)).toBe(true)
    expect(body.meshHealth!.length).toBeGreaterThan(0)
    expect(body.profileReadiness).toEqual(expect.arrayContaining([
      expect.objectContaining({ profileId: 'mesh-smoke-qwen25-1.5b', ready: 1, downloading: 0, failed: 0 })
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
    const meshState = store.config.get('mesh_state:mesh-smoke-qwen25-1.5b')

    const response = await router(new Request('https://router.test/admin/status', { headers: bearer('admin-secret') }))
    const body = await response.json() as { meshHealth?: unknown[] }

    expect(heartbeat.status).toBe(200)
    expect(meshState).toBeDefined()
    expect(JSON.stringify(meshState)).not.toContain('invite-token-value-a')
    expect(response.status).toBe(200)
    expect(Array.isArray(body.meshHealth)).toBe(true)
    expect(JSON.stringify(body)).not.toContain('invite-token-value-a')
  })

  it('REQ-SCH-004 direct llama.cpp heartbeats never receive mesh bootstrap or write mesh state', async () => {
    const { router, store } = routerFixture({ env: { MESH_STATE_KEY: MESH_STATE_KEY_B64 } })
    const direct = { ...buildCustomProfile({ modelRef: 'unsloth/Code-Model-GGUF:Q4_K_M', split: false, runtime: 'llamacpp', existing: [] }), active: true, rolloutPercent: 100, version: 3 }
    await store.setProfile(direct)
    await store.upsertNode({
      ...nodeFixture({ runtime: 'llamacpp', activeProfileIds: [direct.id], publicModels: [...direct.publicAliases], runtimeModel: direct.upstreamModel, metrics: { runtimeState: 'ready', runtimeKind: 'llamacpp', activeRequests: 0, apiReady: true, readyModels: [direct.upstreamModel], cachePrompt: true, cacheReuse: 256 } }),
      nodeTokenVerifier: await hashToken('node-secret')
    })

    const heartbeat = await router(new Request('https://router.test/node/heartbeat', {
      method: 'POST',
      headers: { ...bearer('node-secret'), 'content-type': 'application/json' },
      body: heartbeatBody({ runtime: 'llamacpp', runtimeModel: direct.upstreamModel, activeProfileIds: [direct.id], publicModels: [...direct.publicAliases], metrics: { runtimeState: 'ready', runtimeKind: 'llamacpp', activeRequests: 0, apiReady: true, readyModels: [direct.upstreamModel], cachePrompt: true, cacheReuse: 256 } })
    }))
    const body = await heartbeat.json() as { meshBootstrap?: unknown; desiredProfiles: ModelProfile[] }

    expect(heartbeat.status).toBe(200)
    expect(body.meshBootstrap).toBeUndefined()
    expect(body.desiredProfiles.some((profile) => profile.id === direct.id && profile.runtime === 'llamacpp')).toBe(true)
    expect(store.config.get(`mesh_state:${direct.id}`)).toBeUndefined()
    expect(store.audit.some((event) => event.type.startsWith('mesh_state'))).toBe(false)
  })

  it('REQ-NODE-002 rejects malformed heartbeat payloads before persisting node telemetry', async () => {
    const { router, store } = routerFixture()
    await store.upsertNode({ ...nodeFixture(), nodeTokenVerifier: await hashToken('node-secret') })

    const response = await router(new Request('https://router.test/node/heartbeat', {
      method: 'POST',
      headers: { ...bearer('node-secret'), 'content-type': 'application/json' },
      body: heartbeatBody({ meshIp: '10.0.0.5', metrics: { runtimeState: 'ready', activeRequests: -1 } })
    }))
    const node = await store.getNode('node-a')

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'invalid_heartbeat', fields: expect.arrayContaining(['meshTarget', 'metrics']) })
    expect(node?.meshIp).toBe('100.64.1.10')
    expect(node?.metrics?.activeRequests).toBe(0)
  })

  it('REQ-NODE-002 accepts the llama.cpp Auto parallel sentinel in heartbeat metrics', async () => {
    const { router, store } = routerFixture()
    await store.upsertNode({ ...nodeFixture(), nodeTokenVerifier: await hashToken('node-secret') })

    // parallel -1 is the documented Auto value the profile editor stores (REQ-RUN-013); the agent
    // echoes it back, and the heartbeat must refresh the lease instead of 400ing the node offline.
    const response = await router(new Request('https://router.test/node/heartbeat', {
      method: 'POST',
      headers: { ...bearer('node-secret'), 'content-type': 'application/json' },
      body: heartbeatBody({ runtime: 'llamacpp', metrics: { runtimeState: 'ready', runtimeKind: 'llamacpp', activeRequests: 0, parallel: -1 } })
    }))
    const node = await store.getNode('node-a')

    expect(response.status).toBe(200)
    expect(node?.metrics?.parallel).toBe(-1)
  })

  it('REQ-SEC-007 node revoke removes the node mesh tokens from distribution', async () => {
    const { router, store } = routerFixture({ env: { MESH_STATE_KEY: MESH_STATE_KEY_B64 } })
    await store.upsertNode({ ...nodeFixture(), nodeTokenVerifier: await hashToken('node-secret') })
    await router(new Request('https://router.test/node/heartbeat', {
      method: 'POST',
      headers: { ...bearer('node-secret'), 'content-type': 'application/json' },
      body: heartbeatBody({ meshId: 'mesh-1', meshToken: 'invite-token-value-a' })
    }))
    expect(store.config.get('mesh_state:mesh-smoke-qwen25-1.5b')).toBeDefined()

    const revoke = await router(new Request('https://router.test/admin/nodes/node-a/revoke', { method: 'POST', headers: bearer('admin-secret') }))

    expect(revoke.status).toBe(200)
    expect(store.audit.some((event) => event.type === 'mesh_token_removed')).toBe(true)
  })

  it('REQ-ADM-030 REQ-NODE-011 deactivating a node drops its mesh token and later heartbeats do not re-add it', async () => {
    const { router, store } = routerFixture({ env: { MESH_STATE_KEY: MESH_STATE_KEY_B64 } })
    await store.upsertNode({ ...nodeFixture(), nodeTokenVerifier: await hashToken('node-secret') })
    await router(new Request('https://router.test/node/heartbeat', {
      method: 'POST',
      headers: { ...bearer('node-secret'), 'content-type': 'application/json' },
      body: heartbeatBody({ meshId: 'mesh-1', meshToken: 'invite-token-value-a' })
    }))
    expect(store.config.get('mesh_state:mesh-smoke-qwen25-1.5b')).toBeDefined()

    // Deactivating tears the node's now-dead invite token out of mesh state so peers stop dialing it.
    const off = await router(new Request('https://router.test/admin/nodes/node-a/deactivate', { method: 'POST', headers: bearer('admin-secret') }))
    expect(off.status).toBe(200)
    expect(store.audit.some((event) => event.type === 'mesh_token_removed' && event.target === 'node-a')).toBe(true)

    // A heartbeat from the still-deactivated node must not re-add the token (the mesh-state guard).
    await router(new Request('https://router.test/node/heartbeat', {
      method: 'POST',
      headers: { ...bearer('node-secret'), 'content-type': 'application/json' },
      body: heartbeatBody({ meshId: 'mesh-1', meshToken: 'invite-token-value-a' })
    }))
    const status = await router(new Request('https://router.test/admin/status', { headers: bearer('admin-secret') }))
    const statusBody = await status.json() as { meshHealth?: Array<{ profileId: string; tokenCount?: number }> }
    const entry = (statusBody.meshHealth ?? []).find((candidate) => candidate.profileId === 'mesh-smoke-qwen25-1.5b')
    expect(entry?.tokenCount ?? 0).toBe(0)
  })

  it('REQ-OBS-007 reports per-profile mesh coordinator and peers in admin status', async () => {
    const { router, store } = routerFixture({ env: { MESH_STATE_KEY: MESH_STATE_KEY_B64 } })
    await store.upsertNode({ ...nodeFixture(), nodeTokenVerifier: await hashToken('node-secret-a') })
    await store.upsertNode({ ...nodeFixture({ id: 'node-b', displayName: 'Node B', meshIp: '100.64.1.11' }), nodeTokenVerifier: await hashToken('node-secret-b') })
    await router(new Request('https://router.test/node/heartbeat', {
      method: 'POST',
      headers: { ...bearer('node-secret-a'), 'content-type': 'application/json' },
      body: heartbeatBody({ meshId: 'mesh-1', meshToken: 'invite-token-value-a', metrics: { runtimeState: 'ready', activeRequests: 0, apiReady: true, readyModels: [SMOKE_UPSTREAM], meshRole: 'coordinator' } })
    }))
    await router(new Request('https://router.test/node/heartbeat', {
      method: 'POST',
      headers: { ...bearer('node-secret-b'), 'content-type': 'application/json' },
      body: heartbeatBody({ nodeId: 'node-b', displayName: 'Node B', meshIp: '100.64.1.11', meshId: 'mesh-1', meshToken: 'invite-token-value-b', metrics: { runtimeState: 'ready', activeRequests: 0, apiReady: true, readyModels: [SMOKE_UPSTREAM], meshRole: 'serving-peer' } })
    }))

    const response = await router(new Request('https://router.test/admin/status', { headers: bearer('admin-secret') }))
    const body = await response.json() as { meshHealth?: Array<{ profileId: string; meshId?: string; coordinatorNodeId?: string; peerNodeIds: string[] }> }
    const entry = body.meshHealth?.find((item) => item.profileId === 'mesh-smoke-qwen25-1.5b')

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
    const entry = body.meshHealth?.find((item) => item.profileId === 'mesh-smoke-qwen25-1.5b')

    expect(response.status).toBe(200)
    expect(entry?.readyModels).toEqual([SMOKE_UPSTREAM])
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
    const entry = body.meshHealth?.find((item) => item.profileId === 'mesh-smoke-qwen25-1.5b')

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
    const beforeEntry = before.meshHealth?.find((item) => item.profileId === 'mesh-smoke-qwen25-1.5b')

    expect(beforeEntry?.rotation).toBe(0)
    expect(beforeEntry?.tokenCount).toBe(1)
    expect(typeof beforeEntry?.secretAgeMs).toBe('number')
    expect(JSON.stringify(before)).not.toContain('invite-token-value-a')

    const rotate = await router(new Request('https://router.test/admin/mesh/rotate', {
      method: 'POST',
      headers: { ...bearer('admin-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ profileId: 'mesh-smoke-qwen25-1.5b' })
    }))
    const after = await (await statusRequest()).json() as { meshHealth?: Array<{ profileId: string; rotation: number; tokenCount: number; secretAgeMs?: number }> }
    const afterEntry = after.meshHealth?.find((item) => item.profileId === 'mesh-smoke-qwen25-1.5b')

    expect(rotate.status).toBe(200)
    expect(afterEntry?.rotation).toBe(1)
    expect(afterEntry?.tokenCount).toBe(0)
    expect(afterEntry?.secretAgeMs).toBeUndefined()
  })
})

// HostGatingTestAnchor
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

  it('REQ-ADM-002 failed admin authentication returns an identical unauthorized response before and after setup completes', async () => {
    // SetupStateNondisclosureTestAnchor
    // Pre-setup: no Access config, so admin routes fall back to the bootstrap admin token.
    const before = routerFixture()
    const beforeResponse = await before.router(new Request(`https://${HOST}/admin/setup-tokens`, { method: 'POST', headers: bearer('wrong-secret') }))

    // Post-setup: Access config stored and setup marked complete; no custom domain, so the host stays unlocked.
    const after = routerFixture()
    await after.store.putConfig('access_config', accessConfig())
    await after.store.putConfig('setup_state', { phase: 'complete', completedAt: NOW })
    const afterResponse = await after.router(new Request(`https://${HOST}/admin/setup-tokens`, { method: 'POST', headers: bearer('wrong-secret') }))

    // A rejected admin request looks the same in both states, so it never leaks whether setup has completed.
    expect(beforeResponse.status).toBe(401)
    expect(afterResponse.status).toBe(beforeResponse.status)
    expect(await afterResponse.json()).toEqual(await beforeResponse.json())
  })

  it('REQ-SEC-009 records the Access email as the audit actor for admin actions', async () => {
    resetJwksCache()
    const key = await accessTestKey('key-1')
    const store = new MemoryStore()
    await store.putConfig('access_config', accessConfig())
    const { router } = routerFixture({ store, jwksFetcher: accessJwksFetcher([key.jwk]) })
    const jwt = await signAccessJwt(key, accessPayload())
    const response = await router(new Request(`https://${HOST}/admin/setup-tokens`, { method: 'POST', headers: { 'cf-access-jwt-assertion': jwt, origin: `https://${HOST}` } }))
    expect(response.status).toBe(201)
    const audit = await store.listAudit(5)
    const created = audit.find((event) => event.type === 'setup_token_created')
    expect(created?.actor).toBe('operator@example.com')
  })

  it('REQ-SEC-009 rejects Access-backed admin mutations without same-origin evidence', async () => {
    resetJwksCache()
    const key = await accessTestKey('key-1')
    const store = new MemoryStore()
    await store.putConfig('access_config', accessConfig())
    const { router } = routerFixture({ store, jwksFetcher: accessJwksFetcher([key.jwk]) })
    const jwt = await signAccessJwt(key, accessPayload())

    const cookieOnlyCrossSite = await router(new Request(`https://${HOST}/admin/setup-tokens`, {
      method: 'POST',
      headers: { cookie: `CF_Authorization=${jwt}` }
    }))
    const accessHeaderAndCookieCrossSite = await router(new Request(`https://${HOST}/admin/setup-tokens`, {
      method: 'POST',
      headers: { 'cf-access-jwt-assertion': jwt, cookie: `CF_Authorization=${jwt}` }
    }))
    const sameOrigin = await router(new Request(`https://${HOST}/admin/setup-tokens`, {
      method: 'POST',
      headers: { 'cf-access-jwt-assertion': jwt, cookie: `CF_Authorization=${jwt}`, origin: `https://${HOST}` }
    }))

    expect(cookieOnlyCrossSite.status).toBe(401)
    expect(accessHeaderAndCookieCrossSite.status).toBe(401)
    expect(sameOrigin.status).toBe(201)
  })

  it('REQ-SEC-009 rejects Access-backed user mutations without same-origin evidence', async () => {
    resetJwksCache()
    const key = await accessTestKey('key-1')
    const store = new MemoryStore()
    await store.putConfig('access_config', accessConfig())
    const { router } = routerFixture({ store, jwksFetcher: accessJwksFetcher([key.jwk]) })
    const jwt = await signAccessJwt(key, accessPayload())

    const response = await router(new Request(`https://${HOST}/admin/playground/speed-test`, {
      method: 'POST',
      headers: { 'cf-access-jwt-assertion': jwt, cookie: `CF_Authorization=${jwt}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'codeflare-mesh' })
    }))

    expect(response.status).toBe(401)
    expect(await store.getConfig<LastSpeedTestSummary>('last_speed_test')).toBeUndefined()
  })

  function roleConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { teamDomain: TEAM, audience: AUD, appId: 'app-1', bypassAppId: 'app-2', adminEmails: [], adminGroups: [], userEmails: [], userGroups: [], usersOpen: false, ...overrides }
  }

  function identityGroupsFetcher(groups: readonly string[]): typeof fetch {
    return (async () => Response.json({ groups })) as typeof fetch
  }

  async function roleRouter(config: Record<string, unknown>, groups: readonly string[]) {
    resetJwksCache()
    const key = await accessTestKey('key-1')
    const store = new MemoryStore()
    await store.putConfig('access_config', config)
    const { router } = routerFixture({ store, jwksFetcher: accessJwksFetcher([key.jwk]), identityFetcher: identityGroupsFetcher(groups) })
    return { router, key }
  }

  it('REQ-SEC-010 resolves the admin role from an admin group and lets admins write config', async () => {
    const { router, key } = await roleRouter(roleConfig({ adminGroups: ['admins'], userGroups: ['viewers'] }), ['admins', 'viewers'])
    const jwt = await signAccessJwt(key, accessPayload({ email: 'person@example.com' }))
    const headers = { 'cf-access-jwt-assertion': jwt }
    const whoami = await router(new Request(`https://${HOST}/admin/whoami`, { headers }))
    expect(whoami.status).toBe(200)
    expect(await whoami.json()).toMatchObject({ role: 'admin', actor: 'person@example.com' })
    const status = await router(new Request(`https://${HOST}/admin/status`, { headers }))
    expect((await status.json() as { viewerRole: string }).viewerRole).toBe('admin')
  })

  it('REQ-SEC-010 resolves the read-only user role from a user group and refuses config writes', async () => {
    const { router, key } = await roleRouter(roleConfig({ adminGroups: ['admins'], userGroups: ['viewers'] }), ['viewers'])
    const jwt = await signAccessJwt(key, accessPayload({ email: 'viewer@example.com' }))
    const headers = { 'cf-access-jwt-assertion': jwt }
    const status = await router(new Request(`https://${HOST}/admin/status`, { headers }))
    expect(status.status).toBe(200)
    expect((await status.json() as { viewerRole: string }).viewerRole).toBe('user')
    const write = await router(new Request(`https://${HOST}/admin/setup/access`, { method: 'POST', headers, body: JSON.stringify({ adminEmails: ['x@example.com'] }) }))
    expect(write.status).toBe(401)
  })

  it('REQ-SEC-010 grants admin when a caller matches both admin and user groups', async () => {
    const { router, key } = await roleRouter(roleConfig({ adminGroups: ['admins'], userGroups: ['viewers'] }), ['admins', 'viewers'])
    const jwt = await signAccessJwt(key, accessPayload({ email: 'both@example.com' }))
    const whoami = await router(new Request(`https://${HOST}/admin/whoami`, { headers: { 'cf-access-jwt-assertion': jwt } }))
    expect((await whoami.json() as { role: string }).role).toBe('admin')
  })

  it('REQ-SEC-010 refuses a verified identity that matches neither set when a user set is configured', async () => {
    const { router, key } = await roleRouter(roleConfig({ adminEmails: ['admin@example.com'], userEmails: ['viewer@example.com'] }), [])
    const jwt = await signAccessJwt(key, accessPayload({ email: 'stranger@example.com' }))
    const status = await router(new Request(`https://${HOST}/admin/status`, { headers: { 'cf-access-jwt-assertion': jwt } }))
    expect(status.status).toBe(401)
  })

  it('REQ-SEC-010 grants read-only user to any verified identity when no user set is configured', async () => {
    const { router, key } = await roleRouter(roleConfig({ adminEmails: ['admin@example.com'], usersOpen: true }), [])
    const jwt = await signAccessJwt(key, accessPayload({ email: 'anyone@example.com' }))
    const headers = { 'cf-access-jwt-assertion': jwt }
    const whoami = await router(new Request(`https://${HOST}/admin/whoami`, { headers }))
    expect((await whoami.json() as { role: string }).role).toBe('user')
    const write = await router(new Request(`https://${HOST}/admin/setup/access`, { method: 'POST', headers, body: JSON.stringify({ adminEmails: ['x@example.com'] }) }))
    expect(write.status).toBe(401)
  })

  it('REQ-SEC-010 matches configured emails case-insensitively against the JWT claim', async () => {
    const { router, key } = await roleRouter(roleConfig({ adminEmails: ['admin@example.com'], userEmails: ['viewer@example.com'] }), [])
    const jwt = await signAccessJwt(key, accessPayload({ email: 'Admin@Example.com' }))
    const whoami = await router(new Request(`https://${HOST}/admin/whoami`, { headers: { 'cf-access-jwt-assertion': jwt } }))
    expect((await whoami.json() as { role: string }).role).toBe('admin')
  })

  it('REQ-ADM-017 withholds configuration state and the audit log from the read-only user role', async () => {
    resetJwksCache()
    const key = await accessTestKey('key-1')
    const store = new MemoryStore()
    await store.putConfig('access_config', roleConfig({ adminEmails: ['admin@example.com'], userEmails: ['viewer@example.com'] }))
    await store.putConfig('cloudflare_gateway', { gatewayId: 'inference-mesh', routeName: 'codeflare-mesh', publicModel: 'codeflare-mesh' })
    await store.putConfig('custom_domain', { hostname: HOST, status: 'provisioned' })
    await store.putConfig('setup_state', { phase: 'complete', completedAt: NOW })
    const { router } = routerFixture({ store, jwksFetcher: accessJwksFetcher([key.jwk]), identityFetcher: identityGroupsFetcher([]) })

    const userStatus = await router(new Request(`https://${HOST}/admin/status`, { headers: { 'cf-access-jwt-assertion': await signAccessJwt(key, accessPayload({ email: 'viewer@example.com' })) } }))
    const userBody = await userStatus.json() as Record<string, unknown>
    expect(userBody.viewerRole).toBe('user')
    expect(userBody.nodes).toBeDefined()
    for (const field of ['gateway', 'customDomain', 'setup', 'audit']) expect(userBody[field]).toBeUndefined()

    const adminStatus = await router(new Request(`https://${HOST}/admin/status`, { headers: { 'cf-access-jwt-assertion': await signAccessJwt(key, accessPayload({ email: 'admin@example.com' })) } }))
    const adminBody = await adminStatus.json() as Record<string, unknown>
    expect(adminBody.viewerRole).toBe('admin')
    expect(adminBody.gateway).toBeDefined()
    expect(adminBody.audit).toBeDefined()
  })

  it('REQ-ADM-029 REQ-ADM-017 lets the read-only user role reach the playground endpoint', async () => {
    const { router, key } = await roleRouter(roleConfig({ adminEmails: ['admin@example.com'], userEmails: ['viewer@example.com'] }), [])
    const jwt = await signAccessJwt(key, accessPayload({ email: 'viewer@example.com' }))
    const response = await router(new Request(`https://${HOST}/admin/playground/chat`, { method: 'POST', headers: { 'cf-access-jwt-assertion': jwt, origin: `https://${HOST}` }, body: JSON.stringify({ model: 'codeflare-mesh', messages: [] }) }))
    // A user role clears the requireUser gate (a rejected role would be 401); here it reaches the gateway-config check.
    expect(response.status).not.toBe(401)
    expect(await response.json()).toMatchObject({ error: 'gateway_not_configured' })
  })

  it('REQ-ADM-029 playground gateway target forwards dynamic/<route> to the selected gateway compat endpoint', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = []
    const playgroundFetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init!.body)) as Record<string, unknown>, headers: Object.fromEntries(new Headers(init!.headers).entries()) })
      return new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }) as typeof fetch
    const { router } = routerFixture({ env: { CLOUDFLARE_ACCOUNT_ID: 'account-a', CLOUDFLARE_API_TOKEN_RUNTIME: 'aig-token' }, playgroundFetcher })
    const res = await router(new Request('https://router.test/admin/playground/chat', { method: 'POST', headers: { ...bearer('admin-secret'), 'content-type': 'application/json' }, body: JSON.stringify({ gatewayId: 'gw-x', route: 'custom-route', user: 'user:admin-playground|session:gateway-session', messages: [{ role: 'user', content: 'hi' }] }) }))
    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)
    // The selected gateway id builds the compat URL, and the selected route plus direct-session user are sent upstream.
    expect(calls[0]!.url).toBe('https://gateway.ai.cloudflare.com/v1/account-a/gw-x/compat/chat/completions')
    expect(calls[0]!.body).toMatchObject({ model: 'dynamic/custom-route', user: 'user:admin-playground|session:gateway-session', stream: true, messages: [{ role: 'user', content: 'hi' }] })
    expect(calls[0]!.headers['cf-aig-authorization']).toBe('Bearer aig-token')
  })

  it('REQ-ADM-029 forwards playground tools and a max-token cap to the upstream route when supplied', async () => {
    const calls: Array<{ body: Record<string, unknown> }> = []
    const playgroundFetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ body: JSON.parse(String(init!.body)) as Record<string, unknown> })
      return new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }) as typeof fetch
    const { router } = routerFixture({ env: { CLOUDFLARE_ACCOUNT_ID: 'account-a', CLOUDFLARE_API_TOKEN_RUNTIME: 'aig-token' }, playgroundFetcher })
    const tools = [{ type: 'function', function: { name: 'get_weather', parameters: {} } }]
    const res = await router(new Request('https://router.test/admin/playground/chat', { method: 'POST', headers: { ...bearer('admin-secret'), 'content-type': 'application/json' }, body: JSON.stringify({ gatewayId: 'gw-x', route: 'custom-route', messages: [{ role: 'user', content: 'hi' }], tools, maxTokens: 256 }) }))
    expect(res.status).toBe(200)
    // The client sends maxTokens; the endpoint forwards OpenAI-native tools and max_tokens.
    expect(calls[0]!.body).toMatchObject({ model: 'dynamic/custom-route', tools, max_tokens: 256 })
  })

  it('REQ-ADM-029 playground direct target selects a node and forwards the internal model straight to it', async () => {
    const capture: { request?: Request } = {}
    const { router, store } = routerFixture({ mesh: makeMesh(capture) })
    await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)
    await store.upsertNode(nodeFixture())
    // Unauthenticated -> 401; a missing model -> 400 before any scheduling.
    expect((await router(new Request('https://router.test/admin/playground/direct-chat', { method: 'POST', body: JSON.stringify({ model: 'codeflare-mesh', messages: [] }) }))).status).toBe(401)
    const noModel = await router(new Request('https://router.test/admin/playground/direct-chat', { method: 'POST', headers: { ...bearer('admin-secret'), 'content-type': 'application/json' }, body: JSON.stringify({ messages: [] }) }))
    expect(noModel.status).toBe(400)
    expect(await noModel.json()).toMatchObject({ error: 'model_required' })
    // With a serving node, the direct target selects and forwards the resolved upstream model to the node.
    const response = await router(new Request('https://router.test/admin/playground/direct-chat', { method: 'POST', headers: { ...bearer('admin-secret'), 'content-type': 'application/json' }, body: JSON.stringify({ model: 'codeflare-mesh', messages: [{ role: 'user', content: 'hi' }] }) }))
    await response.text()
    expect(response.status).toBe(200)
    expect(capture.request!.url).toBe('http://100.64.1.10:8080/v1/chat/completions')
    expect((await capture.request!.json() as { model: string }).model).toBe(SMOKE_UPSTREAM)
    // Tools, a max-token cap, and the direct-session user ride the direct path through to the node.
    const withTools = await router(new Request('https://router.test/admin/playground/direct-chat', { method: 'POST', headers: { ...bearer('admin-secret'), 'content-type': 'application/json' }, body: JSON.stringify({ model: 'codeflare-mesh', user: 'user:admin-playground|session:test-session', messages: [{ role: 'user', content: 'hi' }], tools: [{ type: 'function', function: { name: 'get_weather' } }], maxTokens: 256 }) }))
    await withTools.text()
    const forwarded = await capture.request!.json() as { user?: string; tools?: unknown; max_tokens?: number }
    expect(forwarded.user).toBe('user:admin-playground|session:test-session')
    expect(forwarded.tools).toEqual([{ type: 'function', function: { name: 'get_weather' } }])
    expect(forwarded.max_tokens).toBe(256)
  })

  it('REQ-ADM-034 playground speed test measures direct router token ingestion and generation', async () => {
    const capture: { request?: Request } = {}
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"reasoning_content":"hello "}}]}\n\n'))
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"world"}}],"usage":{"prompt_tokens":256,"completion_tokens":2},"timings":{"cache_n":0,"prompt_n":256,"prompt_ms":128,"prompt_per_second":2000,"predicted_n":2,"predicted_ms":20,"predicted_per_second":100}}\n\n'))
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
        controller.close()
      }
    })
    const mesh = {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        capture.request = new Request(input, init)
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
      },
      connect() { throw new Error('connect is not used by speed-test forwarding') }
    } as Fetcher
    const { router, store } = routerFixture({ mesh })
    await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)
    await store.upsertNode(nodeFixture())

    const response = await router(new Request('https://router.test/admin/playground/speed-test', {
      method: 'POST',
      headers: { ...bearer('admin-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'codeflare-mesh', promptTokens: 256, maxTokens: 32 })
    }))
    const measured = await response.json() as { nodeId?: string; cacheTokens?: number; tokens: { prompt: number; completion: number; promptEstimated: boolean; completionEstimated: boolean }; throughput: { promptTokensPerSecond: number | null; generationTokensPerSecond: number }; requestedPromptTokens: number; requestedMaxTokens: number; chunks: number; outputChars: number; upstreamTimings: { cache_n: number; prompt_per_second: number; predicted_per_second: number } }
    const forwarded = await capture.request!.json() as { model: string; user?: string; max_tokens?: number; messages: Array<{ role: string; content: string }> }
    const stored = await store.getConfig<LastSpeedTestSummary>('last_speed_test')

    expect(response.status).toBe(200)
    expect(forwarded.model).toBe(SMOKE_UPSTREAM)
    expect(forwarded.user).toMatch(/^user:speed-test\|session:request-a$/)
    expect(forwarded.max_tokens).toBe(32)
    expect(forwarded.messages[0]!.content).toMatch(/^Speed test nonce request-a\./)
    expect(forwarded.messages[0]!.content.length).toBeGreaterThan(900)
    expect(measured.requestedPromptTokens).toBe(256)
    expect(measured.requestedMaxTokens).toBe(32)
    expect(measured.tokens).toMatchObject({ prompt: 256, completion: 2, promptEstimated: false, completionEstimated: false })
    expect(measured.chunks).toBe(2)
    expect(measured.outputChars).toBe(11)
    expect(measured.nodeId).toBe('node-a')
    expect(measured.cacheTokens).toBe(0)
    expect(measured.upstreamTimings).toMatchObject({ cache_n: 0, prompt_per_second: 2000, predicted_per_second: 100 })
    expect(measured.throughput.promptTokensPerSecond).toBe(2000)
    expect(measured.throughput.generationTokensPerSecond).toBe(100)
    expect(stored).toMatchObject({ requestId: 'request-a', model: 'codeflare-mesh', nodeId: 'node-a', promptTokens: 256, completionTokens: 2, promptTokensPerSecond: 2000, generationTokensPerSecond: 100, cacheTokens: 0 })
  })

  it('REQ-API-009 exposes the direct router speed test to automation callers', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"}}],"usage":{"prompt_tokens":64,"completion_tokens":1}}\n\n'))
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
        controller.close()
      }
    })
    const mesh = {
      fetch: async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
      connect() { throw new Error('connect is not used by speed-test forwarding') }
    } as Fetcher
    const { router, store } = routerFixture({ mesh })
    await store.putToken(await createTokenRecord('automation', 'auto-secret', 1_700_000_000_000))
    await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)
    await store.upsertNode(nodeFixture())

    const unauthorized = await router(new Request('https://router.test/api/v1/speed-test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'codeflare-mesh' }) }))
    const response = await router(new Request('https://router.test/api/v1/speed-test', { method: 'POST', headers: { ...bearer('auto-secret'), 'content-type': 'application/json' }, body: JSON.stringify({ model: 'codeflare-mesh', promptTokens: 64, maxTokens: 16 }) }))
    const measured = await response.json() as { tokens: { prompt: number; completion: number }; throughput: { promptTokensPerSecond: number | null; generationTokensPerSecond: number } }
    const status = await router(new Request('https://router.test/api/v1/status', { headers: bearer('auto-secret') }))
    const statusBody = await status.json() as { lastSpeedTest?: LastSpeedTestSummary }

    expect(unauthorized.status).toBe(401)
    expect(response.status).toBe(200)
    expect(status.status).toBe(200)
    expect(measured.tokens).toMatchObject({ prompt: 64, completion: 1 })
    expect(measured.throughput.promptTokensPerSecond).toBeGreaterThan(0)
    expect(measured.throughput.generationTokensPerSecond).toBeGreaterThan(0)
    expect(statusBody.lastSpeedTest).toMatchObject({ requestId: 'request-a', model: 'codeflare-mesh', nodeId: 'node-a', promptTokens: 64, completionTokens: 1 })
  })

  it('REQ-ADM-029 direct playground forwards the session user required by llama.cpp profiles', async () => {
    const capture: { request?: Request } = {}
    const { router, store } = routerFixture({ mesh: makeMesh(capture), env: { SESSION_AFFINITY_KEY: 'affinity-secret' } })
    const direct = { ...buildCustomProfile({ modelRef: 'unsloth/Code-Model-GGUF:Q4_K_M', split: false, runtime: 'llamacpp', existing: [] }), active: true, rolloutPercent: 100, version: 2 }
    await store.setProfile(direct)
    await store.upsertNode(nodeFixture({
      runtime: 'llamacpp',
      activeProfileIds: [direct.id],
      publicModels: [...direct.publicAliases],
      runtimeModel: direct.upstreamModel,
      metrics: { runtimeState: 'ready', runtimeKind: 'llamacpp', activeRequests: 0, apiReady: true, readyModels: [direct.upstreamModel] }
    }))
    const callable = direct.publicAliases.find((alias) => alias !== 'codeflare-mesh') ?? direct.publicAliases[0]!

    const response = await router(new Request('https://router.test/admin/playground/direct-chat', { method: 'POST', headers: { ...bearer('admin-secret'), 'content-type': 'application/json' }, body: JSON.stringify({ model: callable, user: 'user:admin-playground|session:direct-session', messages: [{ role: 'user', content: 'hi' }] }) }))
    await response.text()
    const forwarded = await capture.request!.json() as { model: string; user?: string }

    expect(response.status).toBe(200)
    expect(forwarded.model).toBe(direct.upstreamModel)
    expect(forwarded.user).toBe('user:admin-playground|session:direct-session')
  })

  it('REQ-GWY-008 restricts live provision status to admins', async () => {
    const { router, key } = await roleRouter(roleConfig({ adminEmails: ['admin@example.com'], userEmails: ['viewer@example.com'] }), [])
    const jwt = await signAccessJwt(key, accessPayload({ email: 'viewer@example.com' }))
    // A valid read-only user role must be rejected: provision-status is an admin-only surface.
    const res = await router(new Request(`https://${HOST}/admin/cloudflare/gateway/provision-status?gateway=gw`, { headers: { 'cf-access-jwt-assertion': jwt } }))
    expect(res.status).toBe(401)
  })

  it('REQ-ADM-029 scopes a non-admin playground gateway target to the default gateway', async () => {
    resetJwksCache()
    const key = await accessTestKey('key-1')
    const store = new MemoryStore()
    await store.putConfig('access_config', roleConfig({ adminEmails: ['admin@example.com'], userEmails: ['viewer@example.com'] }))
    await store.putConfig('cloudflare_gateway_settings', { accountId: 'acct-1', gatewayId: 'default-gw' })
    const calls: string[] = []
    const playgroundFetcher = (async (input: RequestInfo | URL) => { calls.push(String(input)); return new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } }) }) as typeof fetch
    const { router } = routerFixture({ store, env: { CLOUDFLARE_API_TOKEN_RUNTIME: 'aig-token' }, jwksFetcher: accessJwksFetcher([key.jwk]), identityFetcher: identityGroupsFetcher([]), playgroundFetcher })
    const jwt = await signAccessJwt(key, accessPayload({ email: 'viewer@example.com' }))
    // The read-only user asks for an arbitrary gateway; the server ignores it and uses the default.
    const res = await router(new Request(`https://${HOST}/admin/playground/chat`, { method: 'POST', headers: { 'cf-access-jwt-assertion': jwt, 'content-type': 'application/json', origin: `https://${HOST}` }, body: JSON.stringify({ gatewayId: 'evil-gw', route: 'evil-route', messages: [] }) }))
    expect(res.status).toBe(200)
    expect(calls).toEqual(['https://gateway.ai.cloudflare.com/v1/acct-1/default-gw/compat/chat/completions'])
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

  it('REQ-ADM-012 REQ-SEC-010 provisions Access from captured admin and user identities and stores the role config', async () => {
    const store = new MemoryStore()
    await store.putConfig('custom_domain', provisionedDomain())
    await store.putConfig('setup_state', { phase: 'domain_ready' })
    const provisionCalls: {
      accountId: string; hostname: string; workerName: string
      adminEmails: readonly string[]; adminGroups: readonly string[]; userEmails: readonly string[]; userGroups: readonly string[]
    }[] = []
    const { router } = routerFixture({
      store,
      env: { CLOUDFLARE_ACCOUNT_ID: 'acct-1', WORKER_NAME: 'router' },
      accessClient: {
        provisionAccess: async (input) => {
          provisionCalls.push(input)
          return {
            teamDomain: TEAM, audience: AUD, appId: 'app-1', bypassAppId: 'app-2',
            adminEmails: input.adminEmails, adminGroups: input.adminGroups,
            userEmails: input.userEmails, userGroups: input.userGroups,
            usersOpen: input.userEmails.length === 0 && input.userGroups.length === 0
          }
        }
      }
    })
    const invalid = await router(new Request('https://router.example.workers.dev/admin/setup/access', {
      method: 'POST', headers: bearer('admin-secret'), body: JSON.stringify({ adminEmails: [], adminGroups: [] })
    }))
    expect(invalid.status).toBe(400)

    const response = await router(new Request('https://router.example.workers.dev/admin/setup/access', {
      method: 'POST', headers: bearer('admin-secret'), body: JSON.stringify({
        adminEmails: ['operator@example.com'], adminGroups: ['ops-admins'],
        userEmails: ['viewer@example.com'], userGroups: ['ops-viewers']
      })
    }))
    expect(response.status).toBe(200)
    expect(provisionCalls[0]).toMatchObject({
      accountId: 'acct-1', hostname: HOST, workerName: 'router',
      adminEmails: ['operator@example.com'], adminGroups: ['ops-admins'],
      userEmails: ['viewer@example.com'], userGroups: ['ops-viewers']
    })
    expect(await store.getConfig('access_config')).toMatchObject({ teamDomain: TEAM, audience: AUD, appId: 'app-1', bypassAppId: 'app-2', usersOpen: false })
    expect(await store.getConfig('setup_state')).toMatchObject({ phase: 'access_ready' })
    const body = await response.json() as { consoleUrl: string; usersOpen: boolean }
    expect(body.consoleUrl).toBe(`https://${HOST}/admin`)
    expect(body.usersOpen).toBe(false)
  })

  it('REQ-SEC-010 opens Access to everyone as read-only when no user set is configured', async () => {
    const store = new MemoryStore()
    await store.putConfig('custom_domain', provisionedDomain())
    await store.putConfig('setup_state', { phase: 'domain_ready' })
    const { router } = routerFixture({
      store,
      env: { CLOUDFLARE_ACCOUNT_ID: 'acct-1' },
      accessClient: {
        provisionAccess: async (input) => ({
          teamDomain: TEAM, audience: AUD, appId: 'app-1', bypassAppId: 'app-2',
          adminEmails: input.adminEmails, adminGroups: input.adminGroups,
          userEmails: input.userEmails, userGroups: input.userGroups,
          usersOpen: input.userEmails.length === 0 && input.userGroups.length === 0
        })
      }
    })
    const response = await router(new Request('https://router.example.workers.dev/admin/setup/access', {
      method: 'POST', headers: bearer('admin-secret'), body: JSON.stringify({ adminEmails: ['operator@example.com'] })
    }))
    expect(response.status).toBe(200)
    const body = await response.json() as { usersOpen: boolean }
    expect(body.usersOpen).toBe(true)
    expect(await store.getConfig('access_config')).toMatchObject({ usersOpen: true })
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
          return [{ id: 'route-1', name: 'codeflare-mesh', enabled: true }]
        }
      }
    })
    const response = await router(new Request('https://router.example.workers.dev/admin/cloudflare/gateway/options', { headers: bearer('admin-secret') }))
    expect(response.status).toBe(200)
    const body = await response.json() as { gateways: readonly { id: string }[]; routes: readonly { name?: string }[]; defaults: { gatewayId: string; routeName: string; publicModel: string } }
    expect(body.gateways.map((gateway) => gateway.id)).toEqual(['inference-mesh', 'other-gw'])
    expect(body.routes.map((route) => route.name)).toEqual(['codeflare-mesh'])
    expect(body.defaults).toMatchObject({ gatewayId: 'inference-mesh', routeName: 'codeflare-mesh' })
    expect(routeCalls).toEqual(['inference-mesh'])

    const selected = await router(new Request('https://router.example.workers.dev/admin/cloudflare/gateway/options?gateway=other-gw', { headers: bearer('admin-secret') }))
    expect(selected.status).toBe(200)
    expect(routeCalls).toEqual(['inference-mesh', 'other-gw'])
  })

  it('REQ-ADM-011 wizard domain step loads zones and provisioning advances to the access step', async () => {
    const { router } = routerFixture()
    const html = await (await router(new Request('https://router.test/'))).text()
    const harness = adminUiHarness(html, async (path) => {
      if (path === '/admin/setup') return Response.json({ adminToken: 'admin-a', providerToken: 'provider-a', setupToken: 'setup-a', upstreamToken: 'upstream-a' }, { status: 201 })
      if (path === '/admin/cloudflare/zones') return Response.json({ zones: [{ id: 'zone-1', name: 'example.com' }, { id: 'zone-2', name: 'example.org' }] })
      if (path === '/admin/setup/domain') return Response.json({ valid: true, hostname: 'mesh.example.com', status: 'provisioned' })
      return Response.json({})
    })
    harness.run()
    await harness.clickAction('first-run-setup', { out: 'setup-output' })
    const next = elementStub({ tagName: 'button' })
    next.dataset.wizardNext = 'true'
    await harness.click(next)
    await harness.flush(8)

    const zoneSelect = harness.byId('wizard-domain-zone')
    expect(zoneSelect.children.map((option) => option.value)).toEqual(['', 'zone-1', 'zone-2'])
    expect(zoneSelect.children[1]!.dataset.zoneOption).toBe('zone-1')

    zoneSelect.value = 'zone-1'
    harness.byId('wizard-domain-hostname').value = 'mesh.example.com'
    await harness.clickAction('setup-domain', { out: 'wizard-domain-output' })
    const domainCall = harness.fetchCalls.find((call) => call.path === '/admin/setup/domain')
    expect(JSON.parse(String(domainCall?.init?.body))).toEqual({ hostname: 'mesh.example.com', zoneId: 'zone-1' })
    expect(harness.byId('step-domain').hidden).toBe(true)
    expect(harness.byId('step-access').hidden).toBe(false)
  })

  it('REQ-ADM-011 REQ-SEC-010 access step collects admin and user identities and reveals the handoff link', async () => {
    const { router } = routerFixture()
    const html = await (await router(new Request('https://router.test/'))).text()
    const harness = adminUiHarness(html, async (path) => {
      if (path === '/admin/setup/access') return Response.json({ ok: true, teamDomain: 'team.cloudflareaccess.com', hostname: 'mesh.example.com', consoleUrl: 'https://mesh.example.com/admin', usersOpen: false })
      return Response.json({ zones: [] })
    })
    harness.run()

    // A malformed '@' string is neither a valid email nor a group name.
    harness.byId('wizard-admin-ident').value = 'not@an'
    await harness.clickAction('access-ident-add', { identInput: 'wizard-admin-ident', identList: 'admin' })
    expect(harness.byId('wizard-admin-idents').children).toHaveLength(0)
    expect(harness.byId('wizard-access-output').classList.contains('is-error')).toBe(true)

    // Emails normalize + dedupe; group names (no '@') are accepted verbatim.
    harness.byId('wizard-admin-ident').value = ' Operator@Example.com '
    await harness.clickAction('access-ident-add', { identInput: 'wizard-admin-ident', identList: 'admin' })
    harness.byId('wizard-admin-ident').value = 'operator@example.com'
    await harness.clickAction('access-ident-add', { identInput: 'wizard-admin-ident', identList: 'admin' })
    harness.byId('wizard-admin-ident').value = 'ops-admins'
    await harness.clickAction('access-ident-add', { identInput: 'wizard-admin-ident', identList: 'admin' })
    expect(harness.byId('wizard-admin-idents').children.map((chip) => chip.dataset.identChip)).toEqual(['operator@example.com', 'ops-admins'])

    harness.byId('wizard-user-ident').value = 'viewer@example.com'
    await harness.clickAction('access-ident-add', { identInput: 'wizard-user-ident', identList: 'user' })
    expect(harness.byId('wizard-user-idents').children.map((chip) => chip.dataset.identChip)).toEqual(['viewer@example.com'])

    const remove = elementStub({ tagName: 'button' })
    remove.dataset.removeIdent = 'ops-admins'
    remove.dataset.removeKind = 'admin'
    await harness.click(remove)
    expect(harness.byId('wizard-admin-idents').children.map((chip) => chip.dataset.identChip)).toEqual(['operator@example.com'])

    await harness.clickAction('setup-access', { out: 'wizard-access-output' })
    const accessCall = harness.fetchCalls.find((call) => call.path === '/admin/setup/access')
    expect(JSON.parse(String(accessCall?.init?.body))).toEqual({ adminEmails: ['operator@example.com'], adminGroups: [], userEmails: ['viewer@example.com'], userGroups: [] })
    expect(harness.byId('wizard-handoff').hidden).toBe(false)
    expect(harness.byId('wizard-handoff-link').attributes.href).toBe('https://mesh.example.com/admin')
    // The confirmation is the clean handoff card, never a raw JSON dump, and the link names the
    // destination host so it reads as a "log in here" button.
    expect(harness.byId('wizard-access-output').textContent).toBe('')
    expect(harness.byId('wizard-handoff-link').textContent).toContain('mesh.example.com')
  })

  it('REQ-GWY-005 gateway step renders selects from live options and syncs the selection', async () => {
    const { router } = routerFixture()
    const html = await (await router(new Request('https://router.test/'))).text()
    const harness = adminUiHarness(html, async (path) => {
      if (path.startsWith('/admin/cloudflare/gateway/options')) {
        return Response.json({
          gateways: [{ id: 'inference-mesh' }, { id: 'other-gw' }],
          routes: [{ id: 'route-1', name: 'codeflare-mesh', enabled: true }],
          defaults: { gatewayId: 'inference-mesh', routeName: 'codeflare-mesh', providerName: 'codeflare-inference-mesh', publicModel: 'codeflare-mesh' }
        })
      }
      if (path === '/admin/cloudflare/gateway/sync') return Response.json({ deploymentId: 'deployment-a' })
      return Response.json({ zones: [] })
    }, { sessionToken: 'admin-secret' })
    harness.run()
    for (let hop = 0; hop < 3; hop += 1) {
      const next = elementStub({ tagName: 'button' })
      next.dataset.wizardNext = 'true'
      await harness.click(next)
    }
    await harness.flush(8)

    expect(harness.byId('wizard-gateway-empty').hidden).toBe(true)
    const gatewaySelect = harness.byId('wiz-gateway-select')
    expect(gatewaySelect.children.map((option) => option.value)).toEqual(['inference-mesh', 'other-gw', '__new__'])
    expect(gatewaySelect.value).toBe('inference-mesh')
    // No route picker: the route is pinned to codeflare-mesh server-side. The client posts the chosen
    // gateway plus the provider name only.
    expect(harness.byId('wiz-gateway-new-wrap').hidden).toBe(true)
    harness.byId('wiz-gateway-provider-name').value = 'Mesh Provider'

    await harness.clickAction('gateway-sync', { prefix: 'wiz-', out: 'wiz-gateway-output' })
    const syncCall = harness.fetchCalls.find((call) => call.path === '/admin/cloudflare/gateway/sync')
    expect(JSON.parse(String(syncCall?.init?.body))).toEqual({ gatewayId: 'inference-mesh', providerName: 'Mesh Provider' })
  })

  it('REQ-GWY-005 gateway step offers one-click provisioning when the account has no gateway', async () => {
    const { router } = routerFixture()
    const html = await (await router(new Request('https://router.test/'))).text()
    const harness = adminUiHarness(html, async (path) => {
      if (path.startsWith('/admin/cloudflare/gateway/options')) {
        return Response.json({ gateways: [], routes: [], defaults: { gatewayId: 'inference-mesh', routeName: 'codeflare-mesh' } })
      }
      if (path === '/admin/cloudflare/gateway/sync') return Response.json({ deploymentId: 'deployment-a', gatewayId: 'inference-mesh' })
      return Response.json({ zones: [] })
    }, { sessionToken: 'admin-secret' })
    harness.run()
    for (let hop = 0; hop < 3; hop += 1) {
      const next = elementStub({ tagName: 'button' })
      next.dataset.wizardNext = 'true'
      await harness.click(next)
    }
    await harness.flush(8)

    expect(harness.byId('wizard-gateway-empty').hidden).toBe(false)
    expect(harness.byId('wizard-gateway-selects').hidden).toBe(true)
    await harness.clickAction('gateway-provision-default', { out: 'wiz-gateway-output' })
    const syncCall = harness.fetchCalls.find((call) => call.path === '/admin/cloudflare/gateway/sync')
    expect(JSON.parse(String(syncCall?.init?.body))).toEqual({})
  })

  it('REQ-ADM-011 finishing setup on the custom domain opens the dashboard', async () => {
    const { router, store } = routerFixture()
    await store.putConfig('custom_domain', { hostname: 'mesh.example.com', status: 'provisioned' })
    await store.putConfig('setup_state', { phase: 'access_ready' })
    const html = await (await router(new Request('https://mesh.example.com/admin'))).text()
    expect(adminUiConfig(html).state).toMatchObject({ view: 'setup', phase: 'access_ready', customDomain: 'mesh.example.com' })
    const harness = adminUiHarness(html, async (path) => {
      if (path === '/admin/setup/complete') return Response.json({ ok: true, customDomain: 'mesh.example.com' })
      if (path.startsWith('/admin/cloudflare/gateway/options')) return Response.json({ gateways: [], routes: [], defaults: {} })
      if (path === '/admin/agent-versions') return Response.json({ tags: [], stale: false })
      if (path.endsWith('/linux') || path.endsWith('/macos') || path.endsWith('/windows')) return new Response('install', { status: 200, headers: { 'content-type': 'text/plain' } })
      return Response.json({})
    }, { hostname: 'mesh.example.com' })
    harness.run()
    await harness.flush(6)
    expect(harness.byId('step-gateway').hidden).toBe(false)

    await harness.clickAction('setup-complete', { out: 'wizard-complete-output' })
    await harness.flush(6)
    expect(harness.body.dataset.view).toBe('dashboard')
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

describe('operator playground contracts', () => {
  // PlaygroundTestAnchor
  const connectedGateway = { gatewayId: 'inference-mesh', routeName: 'codeflare-mesh', publicModel: 'codeflare-mesh', providerSlug: 'custom-inference-mesh-router-test', manualProviderKeyRequired: true }

  function sseFetcher(capture: { url?: string; init?: RequestInit | undefined }): typeof fetch {
    return (async (url: string, init?: RequestInit) => {
      capture.url = String(url)
      capture.init = init
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n'))
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
          controller.close()
        }
      })
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream', 'cf-aig-log-id': 'log-should-not-leak' } })
    }) as typeof fetch
  }

  it('REQ-ADM-029 REQ-RUN-013 direct playground sends a stable session user for affinity', async () => {
    // DirectPlaygroundSessionUserTestAnchor
    const store = new MemoryStore()
    await store.putConfig('custom_domain', { hostname: 'mesh.example.com', status: 'provisioned' })
    await store.putConfig('setup_state', { phase: 'complete', completedAt: 1_700_000_000_000 })
    const { router } = routerFixture({ store })
    const html = await (await router(new Request('https://mesh.example.com/admin'))).text()
    const directProfile = { id: 'direct-qwen', displayName: 'Direct Qwen', publicAliases: ['codeflare-mesh', 'direct-qwen'], upstreamModel: 'unsloth/Qwen3-14B-GGUF:Q4_K_M', active: true, runtime: 'llamacpp' }
    const harness = adminUiHarness(html, async (path) => {
      if (path === '/admin/status') return Response.json({ nodes: [], profiles: [directProfile], profileReadiness: [], meshHealth: [], audit: [] })
      if (path === '/admin/agent-versions') return Response.json({ tags: [], stale: false })
      if (path.startsWith('/admin/cloudflare/gateway/options')) return Response.json({ gateways: [], routes: [], defaults: {} })
      if (path === '/admin/playground/direct-chat') {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'))
            controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
            controller.close()
          }
        })
        return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }
      return new Response('install', { status: 200, headers: { 'content-type': 'text/plain' } })
    }, { hostname: 'mesh.example.com', sessionToken: 'admin-secret' })
    harness.run()
    await harness.flush(10)
    harness.byId('playground-prompt').value = 'hello'

    await harness.clickAction('playground-send', { out: 'playground-output' })
    await harness.flush(10)
    await harness.clickAction('playground-send', { out: 'playground-output' })
    await harness.flush(10)

    const payloads = harness.fetchCalls.filter((call) => call.path === '/admin/playground/direct-chat').map((call) => JSON.parse(String(call.init?.body)) as { model: string; user: string; messages: readonly unknown[] })
    expect(payloads).toHaveLength(2)
    expect(payloads.map((payload) => payload.model)).toEqual(['direct-qwen', 'direct-qwen'])
    expect(payloads[0]!.user).toMatch(/^user:admin-playground\|session:/)
    expect(new Set(payloads.map((payload) => payload.user)).size).toBe(1)
    expect(payloads[0]!.messages).toHaveLength(1)
  })

  it('REQ-ADM-029 rejects unauthenticated playground requests', async () => {
    const { router } = routerFixture()
    const response = await router(new Request('https://router.test/admin/playground/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'codeflare-mesh', messages: [] })
    }))
    expect(response.status).toBe(401)
  })

  it('REQ-ADM-029 returns gateway_not_configured until a gateway is connected', async () => {
    const { router } = routerFixture()
    const response = await router(new Request('https://router.test/admin/playground/chat', {
      method: 'POST', headers: { ...bearer('admin-secret'), 'content-type': 'application/json' }, body: JSON.stringify({ model: 'codeflare-mesh', messages: [] })
    }))
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: 'gateway_not_configured' })
  })

  it('REQ-ADM-029 forwards playground prompts through the configured gateway route and strips upstream secrets', async () => {
    const store = new MemoryStore()
    await store.putConfig('cloudflare_gateway', connectedGateway)
    await store.putConfig('cloudflare_gateway_settings', { accountId: 'acct-1', gatewayId: 'inference-mesh' })
    const capture: { url?: string; init?: RequestInit | undefined } = {}
    const { router } = routerFixture({ store, env: { CLOUDFLARE_API_TOKEN_RUNTIME: 'aig-run-token' }, playgroundFetcher: sseFetcher(capture) })

    const response = await router(new Request('https://router.test/admin/playground/chat', {
      method: 'POST', headers: { ...bearer('admin-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'codeflare-mesh', user: 'user:admin-playground|session:gateway-session', messages: [{ role: 'user', content: 'hello' }] })
    }))

    expect(response.status).toBe(200)
    expect(capture.url).toBe('https://gateway.ai.cloudflare.com/v1/acct-1/inference-mesh/compat/chat/completions')
    expect(JSON.parse(String(capture.init?.body))).toEqual({ model: 'dynamic/codeflare-mesh', user: 'user:admin-playground|session:gateway-session', stream: true, messages: [{ role: 'user', content: 'hello' }] })
    expect(response.headers.get('cf-aig-log-id')).toBeNull()
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(await response.text()).toContain('"content":"Hi"')
  })

  it('REQ-SEC-012 fails fast when the gateway auth token is missing instead of an opaque upstream 401', async () => {
    const store = new MemoryStore()
    await store.putConfig('cloudflare_gateway', connectedGateway)
    await store.putConfig('cloudflare_gateway_settings', { accountId: 'acct-1', gatewayId: 'inference-mesh' })
    let called = false
    const { router } = routerFixture({ store, playgroundFetcher: (async () => { called = true; return new Response('', { status: 200 }) }) as typeof fetch })

    const response = await router(new Request('https://router.test/admin/playground/chat', {
      method: 'POST', headers: { ...bearer('admin-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'codeflare-mesh', messages: [] })
    }))

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: 'gateway_auth_token_missing' })
    expect(called).toBe(false)
  })

  it('REQ-SEC-012 playground authenticates to the gateway with cf-aig-authorization', async () => {
    const store = new MemoryStore()
    await store.putConfig('cloudflare_gateway', connectedGateway)
    await store.putConfig('cloudflare_gateway_settings', { accountId: 'acct-1', gatewayId: 'inference-mesh' })
    const capture: { url?: string; init?: RequestInit | undefined } = {}
    const { router } = routerFixture({ store, env: { CLOUDFLARE_API_TOKEN_RUNTIME: 'aig-run-token' }, playgroundFetcher: sseFetcher(capture) })

    await router(new Request('https://router.test/admin/playground/chat', {
      method: 'POST', headers: { ...bearer('admin-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'codeflare-mesh', messages: [] })
    }))

    expect(new Headers(capture.init?.headers as HeadersInit).get('cf-aig-authorization')).toBe('Bearer aig-run-token')
  })

})

describe('control-plane API (/api/v1)', () => {
  async function mintKey(router: (request: Request) => Promise<Response>): Promise<{ id: string; token: string; createdAt: number }> {
    const res = await router(new Request('https://router.test/api/v1/keys', { method: 'POST', headers: bearer('admin-secret') }))
    return await res.json() as { id: string; token: string; createdAt: number }
  }

  it('REQ-API-001 mints an automation key for an admin and returns the secret once', async () => {
    const { router } = routerFixture()
    const res = await router(new Request('https://router.test/api/v1/keys', { method: 'POST', headers: bearer('admin-secret') }))
    expect(res.status).toBe(201)
    const body = await res.json() as { id: string; token: string; createdAt: number }
    expect(body.id).toMatch(/^automation_/)
    expect(body.token).toMatch(/^automation_/)
    expect(body.createdAt).toBe(1_700_000_000_000)
  })

  it('REQ-API-001 lists active automation keys without the secret or verifier', async () => {
    const { router } = routerFixture()
    const created = await mintKey(router)
    const res = await router(new Request('https://router.test/api/v1/keys', { headers: bearer('admin-secret') }))
    expect(res.status).toBe(200)
    const body = await res.json() as { keys: Array<{ id: string; createdAt: number }> }
    expect(body.keys.map((key) => key.id)).toContain(created.id)
    const serialized = JSON.stringify(body)
    expect(serialized).not.toContain(created.token)
    expect(serialized).not.toContain('verifier')
  })

  it('REQ-API-001 revokes an automation key so it stops authenticating', async () => {
    const { router } = routerFixture()
    const created = await mintKey(router)
    // The key authenticates the control plane before revocation.
    expect((await router(new Request('https://router.test/api/v1/status', { headers: bearer(created.token) }))).status).toBe(200)
    const del = await router(new Request(`https://router.test/api/v1/keys/${created.id}`, { method: 'DELETE', headers: bearer('admin-secret') }))
    expect(del.status).toBe(200)
    // After revocation the same key no longer authenticates.
    expect((await router(new Request('https://router.test/api/v1/status', { headers: bearer(created.token) }))).status).toBe(401)
    // An unknown key id is a 404.
    expect((await router(new Request('https://router.test/api/v1/keys/automation_nope', { method: 'DELETE', headers: bearer('admin-secret') }))).status).toBe(404)
  })

  it('REQ-API-001 rotates an automation key so the old secret dies and a new one authenticates', async () => {
    const { router, store } = routerFixture()
    const created = await mintKey(router)
    expect((await router(new Request('https://router.test/api/v1/status', { headers: bearer(created.token) }))).status).toBe(200)
    const rot = await router(new Request(`https://router.test/api/v1/keys/${created.id}/rotate`, { method: 'POST', headers: bearer('admin-secret') }))
    expect(rot.status).toBe(201)
    const rotated = await rot.json() as { id: string; token: string; rotatedFrom: string }
    expect(rotated.rotatedFrom).toBe(created.id)
    expect(rotated.token).not.toBe(created.token)
    // The retired secret stops authenticating; the fresh secret works.
    expect((await router(new Request('https://router.test/api/v1/status', { headers: bearer(created.token) }))).status).toBe(401)
    expect((await router(new Request('https://router.test/api/v1/status', { headers: bearer(rotated.token) }))).status).toBe(200)
    // Rotation is audited by key id, never the secret; unknown id is 404; a non-admin is refused.
    expect(store.audit.find((event) => event.type === 'automation_key_rotated')?.detail).toMatchObject({ previousKeyId: created.id, keyId: rotated.id })
    expect(JSON.stringify(store.audit)).not.toContain(rotated.token)
    expect((await router(new Request('https://router.test/api/v1/keys/automation_nope/rotate', { method: 'POST', headers: bearer('admin-secret') }))).status).toBe(404)
    expect((await router(new Request(`https://router.test/api/v1/keys/${rotated.id}/rotate`, { method: 'POST', headers: bearer('not-admin') }))).status).toBe(401)
  })

  it('REQ-API-001 accepts the admin bearer credential for key cleanup after Access is provisioned', async () => {
    const store = new MemoryStore()
    await store.putConfig('access_config', { teamDomain: 'example-team.cloudflareaccess.com', audience: 'aud-mesh-admin', appId: 'app-1', bypassAppId: 'app-2', adminEmails: ['operator@example.com'] })
    const tempKey = await createTokenRecord('automation', 'automation-temp-secret', 1_700_000_000_000)
    await store.putToken(tempKey)
    const { router } = routerFixture({ store })

    const list = await router(new Request('https://router.test/api/v1/keys', { headers: bearer('admin-secret') }))
    expect(list.status).toBe(200)
    const listed = await list.json() as { keys: Array<{ id: string }> }
    expect(listed.keys.map((key) => key.id)).toContain(tempKey.id)

    const del = await router(new Request(`https://router.test/api/v1/keys/${tempKey.id}`, { method: 'DELETE', headers: bearer('admin-secret') }))
    expect(del.status).toBe(200)
    expect((await router(new Request('https://router.test/api/v1/status', { headers: bearer('automation-temp-secret') }))).status).toBe(401)

    const consoleAdmin = await router(new Request('https://router.test/admin/status', { headers: bearer('admin-secret') }))
    expect(consoleAdmin.status).toBe(401)
  })

  it('REQ-API-001 refuses automation-key management without an admin credential', async () => {
    const { router } = routerFixture()
    expect((await router(new Request('https://router.test/api/v1/keys', { method: 'POST', headers: bearer('not-admin') }))).status).toBe(401)
    expect((await router(new Request('https://router.test/api/v1/keys', { headers: bearer('not-admin') }))).status).toBe(401)
    expect((await router(new Request('https://router.test/api/v1/keys/automation_x', { method: 'DELETE', headers: bearer('not-admin') }))).status).toBe(401)
  })

  it('REQ-API-001 audits automation key creation and revocation', async () => {
    const { router, store } = routerFixture()
    const created = await mintKey(router)
    await router(new Request(`https://router.test/api/v1/keys/${created.id}`, { method: 'DELETE', headers: bearer('admin-secret') }))
    const createdEvent = store.audit.find((event) => event.type === 'automation_key_created')
    const revokedEvent = store.audit.find((event) => event.type === 'automation_key_revoked')
    expect(createdEvent?.detail).toMatchObject({ keyId: created.id })
    expect(revokedEvent?.detail).toMatchObject({ keyId: created.id })
    // The secret never lands in the audit trail.
    expect(JSON.stringify(store.audit)).not.toContain(created.token)
  })

  it('REQ-API-010 syncs the Gateway over the automation API and returns the provider token once', async () => {
    const gatewayResult = { providerId: 'prov', providerSlug: 'custom-inference-mesh-router-test', routeId: 'route', routeVersionId: 'ver', deploymentId: 'dep', gatewayId: 'inference-mesh', routeName: 'codeflare-mesh', publicModel: 'codeflare-mesh', workerUrl: 'https://mesh.example.com', manualProviderKeyRequired: true as const, providerTokenInstructions: 'x' }
    const { router, store } = routerFixture({
      env: { CLOUDFLARE_ACCOUNT_ID: 'acct-1', AI_GATEWAY_ID: 'inference-mesh' },
      cloudflareClient: {
        syncCustomProvider: async () => gatewayResult,
        provisionCustomDomain: async () => { throw new Error('unused') }
      }
    })
    await store.putConfig('custom_domain', { hostname: 'mesh.example.com', status: 'provisioned' })
    const key = await mintKey(router)

    const res = await router(new Request('https://router.test/api/v1/gateway/sync', { method: 'POST', headers: bearer(key.token) }))
    const body = await res.json() as { providerToken?: string; byokInstruction?: string }

    expect(res.status).toBe(200)
    expect(body.providerToken).toMatch(/^provider_/)
    expect(body.byokInstruction).toContain('custom-inference-mesh-router-test')
    expect(store.tokens.filter((token) => token.kind === 'provider' && token.active)).toHaveLength(1)
    expect(store.audit.some((event) => event.type === 'gateway_sync' && event.actor === `automation:${key.id}`)).toBe(true)
    expect((await router(new Request('https://router.test/api/v1/gateway/sync', { method: 'POST' }))).status).toBe(401)
  })

  it('REQ-API-002 returns a fleet snapshot to an authenticated automation caller', async () => {
    const { router } = routerFixture()
    const created = await mintKey(router)
    const res = await router(new Request('https://router.test/api/v1/status', { headers: bearer(created.token) }))
    expect(res.status).toBe(200)
    const body = await res.json() as { generatedAt: number; nodes: { total: number; online: number }; models: { total: number; active: number }; runtimeVersions: { meshllm: string; llamacpp: string }; runtimeInstalls: unknown[] }
    expect(body.generatedAt).toBe(1_700_000_000_000)
    expect(typeof body.nodes.total).toBe('number')
    expect(typeof body.nodes.online).toBe('number')
    expect(body.runtimeVersions).toEqual({ meshllm: 'v0.72.2', llamacpp: 'b9912' })
    expect(body.runtimeInstalls).toEqual([])
    // Seeded default profiles are visible to the snapshot.
    expect(body.models.total).toBeGreaterThan(0)
    expect(typeof body.models.active).toBe('number')
  })

  it('REQ-API-002 exposes detailed mesh roles, readiness, and stage ownership on request', async () => {
    const { router, store } = routerFixture({ env: { MESH_STATE_KEY: MESH_STATE_KEY_B64 } })
    const key = await mintKey(router)
    await store.upsertNode(nodeFixture({
      id: 'battlestation',
      activeProfileIds: ['mesh-smoke-qwen25-1.5b'],
      metrics: {
        runtimeKind: 'meshllm', runtimeState: 'starting', nodeState: 'standby', meshRole: 'api-client', apiReady: true, consoleReady: true,
        activeRequests: 0, readyModels: [SMOKE_UPSTREAM], meshllmVersion: '0.72.2', runtimeDetail: '\u001b[33m WARN\u001b[0m failed closing path',
        stageAssignments: [{ stageId: 'stage-0', stageIndex: 0, nodeId: 'battlestation', layerStart: 0, layerEnd: 15, state: 'ready', backend: 'metal', bindAddr: '100.64.1.10:4420' }]
      }
    }))

    const res = await router(new Request('https://router.test/api/v1/status?detail=full', { headers: bearer(key.token) }))
    expect(res.status).toBe(200)
    const body = await res.json() as { details?: { nodes: Array<{ id: string; runtimeInstall?: Record<string, unknown>; metrics?: Record<string, unknown> }>; profileReadiness: Array<Record<string, unknown>>; meshHealth: Array<{ profileId: string; coordinatorNodeId?: string; stageAssignments?: Array<Record<string, unknown>> }> } }
    const node = body.details?.nodes.find((candidate) => candidate.id === 'battlestation')
    expect(node?.metrics).toMatchObject({ meshRole: 'api-client', nodeState: 'standby' })
    expect(node?.runtimeInstall).toMatchObject({ runtime: 'meshllm', desiredVersion: 'v0.72.2', installedVersion: '0.72.2', state: 'installed', error: null })
    expect(body.details?.profileReadiness.find((entry) => entry.profileId === 'mesh-smoke-qwen25-1.5b')).toMatchObject({ ready: 1, downloading: 0, failed: 0 })
    const mesh = body.details?.meshHealth.find((entry) => entry.profileId === 'mesh-smoke-qwen25-1.5b')
    expect(mesh?.coordinatorNodeId).toBe('battlestation')
    expect(mesh?.stageAssignments).toContainEqual(expect.objectContaining({ stageIndex: 0, nodeId: 'battlestation', layerStart: 0, layerEnd: 15, reportedByNodeId: 'battlestation' }))
  })

  it('REQ-API-002 exposes per-node runtime install status to automation callers', async () => {
    const { router, store } = routerFixture()
    const key = await mintKey(router)
    await store.putConfig('desired_llamacpp_version', 'b9912')
    await store.upsertNode({
      ...nodeFixture(),
      runtime: 'llamacpp',
      metrics: { runtimeKind: 'llamacpp', runtimeState: 'dependency-missing', activeRequests: 0, lastError: 'llama-server checksum mismatch' }
    })

    const status = await router(new Request('https://router.test/api/v1/status', { headers: bearer(key.token) }))
    const nodes = await router(new Request('https://router.test/api/v1/nodes', { headers: bearer(key.token) }))
    const statusBody = await status.json() as { runtimeInstalls: Array<Record<string, unknown>> }
    const nodesBody = await nodes.json() as { nodes: Array<{ runtimeInstall?: Record<string, unknown> }> }

    expect(statusBody.runtimeInstalls).toContainEqual(expect.objectContaining({ nodeId: 'node-a', runtime: 'llamacpp', desiredVersion: 'b9912', installedVersion: null, state: 'failed', error: 'llama-server checksum mismatch' }))
    expect(nodesBody.nodes[0]?.runtimeInstall).toMatchObject({ runtime: 'llamacpp', desiredVersion: 'b9912', installedVersion: null, state: 'failed', error: 'llama-server checksum mismatch' })
  })

  it('REQ-API-002 REQ-ADM-030 deactivates and reactivates a node over the automation API', async () => {
    const { router, store } = routerFixture()
    await store.upsertNode(nodeFixture())
    const key = await mintKey(router)

    const off = await router(new Request('https://router.test/api/v1/nodes/node-a/deactivate', { method: 'POST', headers: bearer(key.token) }))
    expect(off.status).toBe(200)
    expect((await off.json() as { node: { deactivated: boolean } }).node.deactivated).toBe(true)
    // The machine-facing node projection surfaces the taint so fleet tooling can read it back.
    const got = await router(new Request('https://router.test/api/v1/nodes/node-a', { headers: bearer(key.token) }))
    expect((await got.json() as { node: { deactivated: boolean } }).node.deactivated).toBe(true)

    const on = await router(new Request('https://router.test/api/v1/nodes/node-a/activate', { method: 'POST', headers: bearer(key.token) }))
    expect(on.status).toBe(200)
    expect((await on.json() as { node: { deactivated: boolean } }).node.deactivated).toBe(false)
    expect(store.audit.some((event) => event.type === 'node_activated' && event.target === 'node-a')).toBe(true)
  })

  it('REQ-API-002 rejects an api request without a valid automation key', async () => {
    const { router } = routerFixture()
    expect((await router(new Request('https://router.test/api/v1/status', { headers: bearer('not-a-key') }))).status).toBe(401)
    // An admin session is not an automation key for the machine plane; the credential classes stay separate.
    expect((await router(new Request('https://router.test/api/v1/status', { headers: bearer('admin-secret') }))).status).toBe(401)
  })

  it('REQ-RTR-005 rejects a malformed JSON body with 400 invalid_json on an api endpoint', async () => {
    const { router } = routerFixture()
    const key = await mintKey(router)
    const res = await router(new Request('https://router.test/api/v1/models', { method: 'POST', headers: { ...bearer(key.token), 'content-type': 'application/json' }, body: '{ not valid json' }))
    // A malformed body is client error, not a router fault: 400 invalid_json, never a 500.
    expect(res.status).toBe(400)
    expect((await res.json() as { error: string }).error).toBe('invalid_json')
  })

  it('REQ-RTR-005 rejects a malformed JSON body with 400 invalid_json on a node endpoint', async () => {
    const { router } = routerFixture()
    // handleNodeHeartbeat parses the body via readJson before auth, so a malformed body is 400 invalid_json.
    const res = await router(new Request('https://router.test/node/heartbeat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{ not valid json' }))
    expect(res.status).toBe(400)
    expect((await res.json() as { error: string }).error).toBe('invalid_json')
  })

  it('REQ-RTR-005 rejects a malformed JSON body with 400 invalid_json on an admin endpoint', async () => {
    const { router } = routerFixture()
    // handleAgentVersionSelect parses the body directly (not via readJson); it routes a malformed
    // body through the same InvalidJsonBodyError boundary, so this admin route is 400 not 500.
    const res = await router(new Request('https://router.test/admin/agent-version', { method: 'POST', headers: { ...bearer('admin-secret'), 'content-type': 'application/json' }, body: '{ not valid json' }))
    expect(res.status).toBe(400)
    expect((await res.json() as { error: string }).error).toBe('invalid_json')
  })

  it('REQ-RTR-005 rejects a malformed body but accepts an absent one on an optional-body route', async () => {
    const { router } = routerFixture()
    // gateway/sync (readOptionalObject) and mesh/rotate (rotateProfileId) treat the body as
    // optional, but a PRESENT-yet-malformed body is still a client error -> 400 invalid_json.
    const badSync = await router(new Request('https://router.test/admin/cloudflare/gateway/sync', { method: 'POST', headers: { ...bearer('admin-secret'), 'content-type': 'application/json' }, body: '{ not json' }))
    expect(badSync.status).toBe(400)
    expect((await badSync.json() as { error: string }).error).toBe('invalid_json')
    const badRotate = await router(new Request('https://router.test/admin/mesh/rotate', { method: 'POST', headers: { ...bearer('admin-secret'), 'content-type': 'application/json' }, body: '{ not json' }))
    expect(badRotate.status).toBe(400)
    expect((await badRotate.json() as { error: string }).error).toBe('invalid_json')
    const badChat = await router(new Request('https://router.test/admin/playground/chat', { method: 'POST', headers: { ...bearer('admin-secret'), 'content-type': 'application/json' }, body: '{ not json' }))
    expect(badChat.status).toBe(400)
    expect((await badChat.json() as { error: string }).error).toBe('invalid_json')
    // An ABSENT body is still accepted (the route applies its defaults) — never rejected as invalid_json.
    const absentSync = await router(new Request('https://router.test/admin/cloudflare/gateway/sync', { method: 'POST', headers: bearer('admin-secret') }))
    expect((await absentSync.json() as { error?: string }).error).not.toBe('invalid_json')
  })

  it('REQ-API-003 mints an enrollment token from an automation key', async () => {
    const { router } = routerFixture()
    const key = await mintKey(router)
    const res = await router(new Request('https://router.test/api/v1/enrollment-tokens', { method: 'POST', headers: bearer(key.token) }))
    expect(res.status).toBe(201)
    const body = await res.json() as { setupToken: string; expiresAt: number }
    expect(body.setupToken).toMatch(/^setup_/)
    expect(body.expiresAt).toBe(1_700_000_000_000 + 24 * 60 * 60 * 1000)
  })

  it('REQ-API-003 also mints an enrollment token from an admin credential', async () => {
    const { router } = routerFixture()
    const res = await router(new Request('https://router.test/api/v1/enrollment-tokens', { method: 'POST', headers: bearer('admin-secret') }))
    expect(res.status).toBe(201)
    expect((await res.json() as { setupToken: string }).setupToken).toMatch(/^setup_/)
  })

  it('REQ-API-003 audits enrollment-token minting with the automation caller', async () => {
    const { router, store } = routerFixture()
    const key = await mintKey(router)
    await router(new Request('https://router.test/api/v1/enrollment-tokens', { method: 'POST', headers: bearer(key.token) }))
    const event = store.audit.find((entry) => entry.type === 'setup_token_created' && String(entry.actor).startsWith('automation:'))
    expect(event?.actor).toBe(`automation:${key.id}`)
  })

  it('REQ-API-003 refuses enrollment-token minting without a credential', async () => {
    const { router } = routerFixture()
    expect((await router(new Request('https://router.test/api/v1/enrollment-tokens', { method: 'POST', headers: bearer('nope') }))).status).toBe(401)
  })

  it('REQ-API-004 lists nodes as projections without token verifiers', async () => {
    const { router, store } = routerFixture()
    const key = await mintKey(router)
    await store.upsertNode(nodeFixture({ id: 'node-x', nodeTokenVerifier: 'node-verifier-hash', upstreamTokenVerifier: 'up-verifier-hash' }))
    const res = await router(new Request('https://router.test/api/v1/nodes', { headers: bearer(key.token) }))
    expect(res.status).toBe(200)
    const body = await res.json() as { nodes: Array<{ id: string }>; nextCursor: string | null }
    expect(body.nodes.map((node) => node.id)).toContain('node-x')
    const serialized = JSON.stringify(body)
    expect(serialized).not.toContain('node-verifier-hash')
    expect(serialized).not.toContain('up-verifier-hash')
    expect(serialized).not.toContain('inferencePort')
  })

  it('REQ-API-004 filters the node list by status and search', async () => {
    const { router, store } = routerFixture()
    const key = await mintKey(router)
    await store.upsertNode(nodeFixture({ id: 'node-fresh', displayName: 'Alpha', status: 'online' }))
    await store.upsertNode(nodeFixture({ id: 'node-stale', displayName: 'Beta', status: 'offline' }))
    const online = await (await router(new Request('https://router.test/api/v1/nodes?status=online', { headers: bearer(key.token) }))).json() as { nodes: Array<{ id: string }> }
    expect(online.nodes.map((node) => node.id)).toEqual(['node-fresh'])
    const offline = await (await router(new Request('https://router.test/api/v1/nodes?status=offline', { headers: bearer(key.token) }))).json() as { nodes: Array<{ id: string }> }
    expect(offline.nodes.map((node) => node.id)).toEqual(['node-stale'])
    const bySearch = await (await router(new Request('https://router.test/api/v1/nodes?q=alph', { headers: bearer(key.token) }))).json() as { nodes: Array<{ id: string }> }
    expect(bySearch.nodes.map((node) => node.id)).toEqual(['node-fresh'])
  })

  it('REQ-API-004 paginates the node list by id cursor', async () => {
    const { router, store } = routerFixture()
    const key = await mintKey(router)
    for (const suffix of ['a', 'b', 'c']) await store.upsertNode(nodeFixture({ id: `node-${suffix}` }))
    const first = await (await router(new Request('https://router.test/api/v1/nodes?limit=2', { headers: bearer(key.token) }))).json() as { nodes: Array<{ id: string }>; nextCursor: string | null }
    expect(first.nodes.map((node) => node.id)).toEqual(['node-a', 'node-b'])
    expect(first.nextCursor).toBe('node-b')
    const second = await (await router(new Request('https://router.test/api/v1/nodes?limit=2&cursor=node-b', { headers: bearer(key.token) }))).json() as { nodes: Array<{ id: string }>; nextCursor: string | null }
    expect(second.nodes.map((node) => node.id)).toEqual(['node-c'])
    expect(second.nextCursor).toBeNull()
  })

  it('REQ-API-004 returns a single node and 404 for an unknown node', async () => {
    const { router, store } = routerFixture()
    const key = await mintKey(router)
    await store.upsertNode(nodeFixture({ id: 'node-solo' }))
    const found = await router(new Request('https://router.test/api/v1/nodes/node-solo', { headers: bearer(key.token) }))
    expect(found.status).toBe(200)
    expect((await found.json() as { node: { id: string } }).node.id).toBe('node-solo')
    const missing = await router(new Request('https://router.test/api/v1/nodes/node-ghost', { headers: bearer(key.token) }))
    expect(missing.status).toBe(404)
  })

  it('REQ-API-004 decommissions a node and revokes its credentials', async () => {
    const { router, store } = routerFixture()
    const key = await mintKey(router)
    await store.upsertNode(nodeFixture({ id: 'node-doomed' }))
    await store.putToken(await createTokenRecord('node', 'node-secret', 1_700_000_000_000, 'node-doomed'))
    const res = await router(new Request('https://router.test/api/v1/nodes/node-doomed', { method: 'DELETE', headers: bearer(key.token) }))
    expect(res.status).toBe(200)
    // Decommission removes the node from the store, not just soft-revokes it.
    expect(await store.getNode('node-doomed')).toBeUndefined()
    // The node's credential is revoked so it can no longer authenticate.
    const nodeTokens = await store.listTokens('node')
    expect(nodeTokens.filter((token) => token.nodeId === 'node-doomed' && token.active)).toHaveLength(0)
    const event = store.audit.find((entry) => entry.type === 'node_revoked' && entry.target === 'node-doomed')
    expect(event?.actor).toBe(`automation:${key.id}`)
    // Decommissioning an unknown node is a 404.
    expect((await router(new Request('https://router.test/api/v1/nodes/node-ghost', { method: 'DELETE', headers: bearer(key.token) }))).status).toBe(404)
  })

  it('REQ-SEC-002 hides a revoked tombstone node from every fleet listing', async () => {
    const { router, store } = routerFixture()
    const key = await mintKey(router)
    await store.upsertNode(nodeFixture({ id: 'node-live', status: 'online' }))
    await store.upsertNode(nodeFixture({ id: 'node-tombstone', status: 'online' }))
    // Simulate a mid-revoke failure (or a legacy revoke): the row is marked revoked but the
    // deleteNode step never ran, so the tombstone lingers in storage.
    await store.revokeNode('node-tombstone', 1_700_000_000_000)
    expect(await store.getNode('node-tombstone')).toBeDefined()

    // A revoked tombstone must not surface in listNodes or in the automation node list.
    const listed = await store.listNodes(1_700_000_000_000)
    expect(listed.map((node) => node.id)).toEqual(['node-live'])
    const api = await router(new Request('https://router.test/api/v1/nodes', { headers: bearer(key.token) }))
    expect(((await api.json()) as { nodes: { id: string }[] }).nodes.map((node) => node.id)).toEqual(['node-live'])
    // The single-node GET treats the tombstone as gone too (404, not the projection).
    expect((await router(new Request('https://router.test/api/v1/nodes/node-tombstone', { headers: bearer(key.token) }))).status).toBe(404)
  })

  it('REQ-API-004 decommission reaps a lingering revoked tombstone row', async () => {
    const { router, store } = routerFixture()
    const key = await mintKey(router)
    await store.upsertNode(nodeFixture({ id: 'node-tombstone', status: 'online' }))
    // Leave a revoked-but-undeleted tombstone (deleteNode never ran).
    await store.revokeNode('node-tombstone', 1_700_000_000_000)
    expect(await store.getNode('node-tombstone')).toBeDefined()
    // Decommission must still reach it (getNode, not the revoked-filtered listNodes) and hard-delete it.
    const res = await router(new Request('https://router.test/api/v1/nodes/node-tombstone', { method: 'DELETE', headers: bearer(key.token) }))
    expect(res.status).toBe(200)
    expect(await store.getNode('node-tombstone')).toBeUndefined()
  })

  it('REQ-ADM-023 refuses reconfigure and admin config for a revoked node', async () => {
    const { router, store } = routerFixture()
    const key = await mintKey(router)
    await store.upsertNode(nodeFixture({ id: 'node-tombstone', status: 'online' }))
    await store.revokeNode('node-tombstone', 1_700_000_000_000)
    // A revoked node is treated as gone: the reconfigure/config endpoints refuse it as unknown
    // (matching GET's 404), even though getNode can still reach it for decommission cleanup.
    const res = await router(new Request('https://router.test/api/v1/nodes/node-tombstone/reconfigure', { method: 'POST', headers: { ...bearer(key.token), 'content-type': 'application/json' }, body: JSON.stringify({ maxVramGbOverride: 6 }) }))
    expect(res.status).toBe(404)
    // The admin console config path (handleNodeConfig) refuses it identically.
    const adminConfig = await router(new Request('https://router.test/admin/nodes/node-tombstone/config', { method: 'POST', headers: { ...bearer('admin-secret'), 'content-type': 'application/json' }, body: JSON.stringify({ maxVramGbOverride: 6 }) }))
    expect(adminConfig.status).toBe(404)
  })

  it('REQ-ADM-023 reconfigures node name and VRAM override through the automation API', async () => {
    const { router, store } = routerFixture()
    const key = await mintKey(router)
    await store.upsertNode(nodeFixture({ id: 'node-weak' }))
    const res = await router(new Request('https://router.test/api/v1/nodes/node-weak/reconfigure', { method: 'POST', headers: { ...bearer(key.token), 'content-type': 'application/json' }, body: JSON.stringify({ displayName: 'Mac mini', maxVramGbOverride: 6 }) }))
    expect(res.status).toBe(200)
    expect((await res.json() as { node: { displayName: string; maxVramGbOverride: number } }).node).toMatchObject({ displayName: 'Mac mini', maxVramGbOverride: 6 })
    expect((await store.getNode('node-weak'))).toMatchObject({ displayName: 'Mac mini', maxVramGbOverride: 6 })
    // Unknown node is 404; a request without an automation key is 401.
    expect((await router(new Request('https://router.test/api/v1/nodes/node-ghost/reconfigure', { method: 'POST', headers: { ...bearer(key.token), 'content-type': 'application/json' }, body: JSON.stringify({ maxVramGbOverride: 6 }) }))).status).toBe(404)
    expect((await router(new Request('https://router.test/api/v1/nodes/node-weak/reconfigure', { method: 'POST', headers: { ...bearer('nope'), 'content-type': 'application/json' }, body: JSON.stringify({ maxVramGbOverride: 6 }) }))).status).toBe(401)
  })

  it('REQ-ADM-032 REQ-API-004 force reloads a node over the automation API', async () => {
    const { router, store } = routerFixture()
    const key = await mintKey(router)
    await store.upsertNode(nodeFixture())
    const res = await router(new Request('https://router.test/api/v1/nodes/node-a/reload', { method: 'POST', headers: bearer(key.token) }))
    expect(res.status).toBe(200)
    const { reloadNonce } = await res.json() as { reloadNonce: string }
    expect(reloadNonce).toBeTruthy()
    // The directive lands on the node record so the next heartbeat carries it, and the request is audited.
    expect((await store.getNode('node-a'))?.reloadNonce).toBe(reloadNonce)
    expect(store.audit.some((event) => event.type === 'node_reload_requested' && event.target === 'node-a' && event.actor.startsWith('automation:'))).toBe(true)
    // Unknown node is 404; a request without an automation key is 401.
    expect((await router(new Request('https://router.test/api/v1/nodes/node-ghost/reload', { method: 'POST', headers: bearer(key.token) }))).status).toBe(404)
    expect((await router(new Request('https://router.test/api/v1/nodes/node-a/reload', { method: 'POST', headers: bearer('nope') }))).status).toBe(401)
  })

  it('REQ-API-004 refuses node access without an automation key', async () => {
    const { router } = routerFixture()
    expect((await router(new Request('https://router.test/api/v1/nodes', { headers: bearer('nope') }))).status).toBe(401)
    expect((await router(new Request('https://router.test/api/v1/nodes/node-a', { headers: bearer('nope') }))).status).toBe(401)
    expect((await router(new Request('https://router.test/api/v1/nodes/node-a', { method: 'DELETE', headers: bearer('nope') }))).status).toBe(401)
  })

  it('REQ-SEC-006 REQ-API-002 rotates the mesh secret over the automation API', async () => {
    const { router, store } = routerFixture({ env: { MESH_STATE_KEY: MESH_STATE_KEY_B64 } })
    const key = await mintKey(router)
    const res = await router(new Request('https://router.test/api/v1/mesh/rotate', { method: 'POST', headers: { ...bearer(key.token), 'content-type': 'application/json' }, body: JSON.stringify({ profileId: 'mesh-smoke-qwen25-1.5b' }) }))
    expect(res.status).toBe(200)
    expect((await res.json() as { rotation: number }).rotation).toBe(1)
    expect(store.audit.some((event) => event.type === 'mesh_token_rotated' && event.actor.startsWith('automation:'))).toBe(true)
    // Unknown profile is 404; a request without an automation key is 401.
    expect((await router(new Request('https://router.test/api/v1/mesh/rotate', { method: 'POST', headers: { ...bearer(key.token), 'content-type': 'application/json' }, body: JSON.stringify({ profileId: 'ghost' }) }))).status).toBe(404)
    expect((await router(new Request('https://router.test/api/v1/mesh/rotate', { method: 'POST', headers: { ...bearer('nope'), 'content-type': 'application/json' }, body: JSON.stringify({ profileId: 'mesh-smoke-qwen25-1.5b' }) }))).status).toBe(401)
  })

  it('REQ-ADM-020 REQ-API-002 reads and writes fleet settings over the automation API', async () => {
    const { router, store } = routerFixture()
    const key = await mintKey(router)
    const put = await router(new Request('https://router.test/api/v1/settings', { method: 'PUT', headers: { ...bearer(key.token), 'content-type': 'application/json' }, body: JSON.stringify({ offlinePruneSeconds: 3600 }) }))
    expect(put.status).toBe(200)
    expect((await put.json() as { offlinePruneSeconds: number }).offlinePruneSeconds).toBe(3600)
    // The written value reads back through the GET twin and the write is audited to the automation caller.
    const got = await router(new Request('https://router.test/api/v1/settings', { headers: bearer(key.token) }))
    expect((await got.json() as { offlinePruneSeconds: number }).offlinePruneSeconds).toBe(3600)
    expect(store.audit.some((event) => event.type === 'settings_updated' && event.actor.startsWith('automation:'))).toBe(true)
    // A negative value is rejected; a request without an automation key is 401.
    expect((await router(new Request('https://router.test/api/v1/settings', { method: 'PUT', headers: { ...bearer(key.token), 'content-type': 'application/json' }, body: JSON.stringify({ offlinePruneSeconds: -5 }) }))).status).toBe(400)
    expect((await router(new Request('https://router.test/api/v1/settings', { headers: bearer('nope') }))).status).toBe(401)
  })

  it('REQ-API-005 lists models as projections with callable names', async () => {
    const { router, store } = routerFixture()
    await seedLegacyDefaults(store)
    const key = await mintKey(router)
    const res = await router(new Request('https://router.test/api/v1/models', { headers: bearer(key.token) }))
    expect(res.status).toBe(200)
    const body = await res.json() as { models: Array<{ id: string; callableNames: string[]; displayName: string; maxVramGb: number; split: boolean }> }
    const model = body.models.find((entry) => entry.id === 'mesh-default-qwen36-35b')
    expect(model?.displayName).toBe('Qwen3.6 35B')
    expect(model?.callableNames).toContain('codeflare-mesh')
    // The projection always carries a numeric VRAM budget (0 = no cap) so machine callers can read it.
    expect(typeof model?.maxVramGb).toBe('number')
    // The split serving flag is projected so automation can read back which models run multi-machine.
    expect(model?.split).toBe(false)
  })

  const apiAddModel = (router: (request: Request) => Promise<Response>, token: string | undefined, modelRef: string, mode: string, runtime?: 'meshllm' | 'llamacpp') =>
    router(new Request('https://router.test/api/v1/models', {
      method: 'POST',
      headers: { ...(token ? bearer(token) : {}), 'content-type': 'application/json' },
      body: JSON.stringify({ modelRef, mode, ...(runtime ? { runtime } : {}) })
    }))

  it('REQ-API-007 adds a single-machine model as an inactive projection', async () => {
    const { router, store } = routerFixture()
    const key = await mintKey(router)
    const res = await apiAddModel(router, key.token, 'unsloth/Qwen3-14B-GGUF:Q4_K_M', 'single')
    expect(res.status).toBe(201)
    const body = await res.json() as { model: { id: string; active: boolean; callableNames: string[]; modelRef: string } }
    expect(body.model.active).toBe(false)
    expect(body.model.callableNames).toContain('codeflare-mesh')
    expect(body.model.modelRef).toBe('unsloth/Qwen3-14B-GGUF:Q4_K_M')
    expect((await store.listProfiles()).some((profile) => profile.id === body.model.id && !profile.meshllm!.split)).toBe(true)
  })

  it('REQ-API-007 adds a direct llama.cpp single model as an inactive projection', async () => {
    const { router, store } = routerFixture()
    const key = await mintKey(router)
    const res = await apiAddModel(router, key.token, 'unsloth/Qwen3-14B-GGUF:Q4_K_M', 'single', 'llamacpp')
    expect(res.status).toBe(201)
    const body = await res.json() as { model: { id: string; runtime: string; tunables: unknown; llamacpp?: { cachePrompt: boolean; cacheReuse: number; parallel: number; gpuLayers?: string; cacheTypeK?: string; cacheTypeV?: string; batch?: number; ubatch?: number; maxOutputTokens?: number; reasoning?: { enabled?: boolean; format?: string; budget?: number } } } }
    const created = (await store.listProfiles()).find((profile) => profile.id === body.model.id)

    expect(body.model.runtime).toBe('llamacpp')
    expect(body.model.tunables).toBeNull()
    expect(body.model.llamacpp).toMatchObject({ cachePrompt: true, cacheReuse: 256, parallel: -1, kvUnified: true, gpuLayers: '99', cacheTypeK: 'q4_0', cacheTypeV: 'q4_0', batch: 8192, ubatch: 2048, maxOutputTokens: 16384, reasoning: { enabled: true, format: 'deepseek', budget: 8192 } })
    expect(created).toMatchObject({ runtime: 'llamacpp', sourceMode: 'llamacpp-hf', active: false })
  })

  it('REQ-API-007 rejects direct llama.cpp split model onboarding', async () => {
    const { router, store } = routerFixture()
    const key = await mintKey(router)
    const res = await apiAddModel(router, key.token, 'unsloth/Qwen3-14B-GGUF:Q4_K_M', 'split', 'llamacpp')

    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'split_requires_meshllm' })
    expect((await store.listProfiles()).some((profile) => profile.runtime === 'llamacpp')).toBe(false)
  })

  it('REQ-API-007 adds a split model with split serving enabled', async () => {
    const { router, store } = routerFixture()
    const key = await mintKey(router)
    const ref = 'hf://meshllm/Qwen3-14B-UD-Q4_K_XL-layers@abc123'
    const res = await apiAddModel(router, key.token, ref, 'split')
    expect(res.status).toBe(201)
    const body = await res.json() as { model: { split: boolean } }
    expect(body.model.split).toBe(true)
    const created = (await store.listProfiles()).find((profile) => profile.upstreamModel === ref)
    expect(created?.meshllm!.split).toBe(true)
    expect(created?.active).toBe(false)
  })

  it('REQ-API-007 rejects a blank model reference', async () => {
    const { router, store } = routerFixture()
    const key = await mintKey(router)
    const res = await apiAddModel(router, key.token, '  ', 'single')
    expect(res.status).toBe(400)
    expect((await store.listProfiles()).some((profile) => profile.id.startsWith('custom-'))).toBe(false)
  })

  it('REQ-API-007 refuses a duplicate model without overwriting', async () => {
    const { router, store } = routerFixture()
    const key = await mintKey(router)
    const first = await apiAddModel(router, key.token, 'unsloth/Qwen3-14B-GGUF:Q4_K_M', 'single')
    expect(first.status).toBe(201)
    const firstId = (await first.json() as { model: { id: string } }).model.id
    const second = await apiAddModel(router, key.token, 'unsloth/Qwen3-14B-GGUF:Q4_K_M', 'single')
    expect(second.status).toBe(409)
    expect((await store.listProfiles()).filter((profile) => profile.id === firstId).length).toBe(1)
  })

  it('REQ-API-007 refuses model creation without an automation key', async () => {
    const { router, store } = routerFixture()
    const res = await apiAddModel(router, undefined, 'unsloth/Qwen3-14B-GGUF:Q4_K_M', 'single')
    expect(res.status).toBe(401)
    expect((await store.listProfiles()).some((profile) => profile.id.startsWith('custom-'))).toBe(false)
  })

  it('REQ-OBS-006 records a profile-added audit event for programmatic model onboarding', async () => {
    const { router, store } = routerFixture()
    const key = await mintKey(router)
    const res = await apiAddModel(router, key.token, 'unsloth/Qwen3-14B-GGUF:Q4_K_M', 'single')
    expect(res.status).toBe(201)
    const added = await res.json() as { model: { id: string } }
    const event = (await store.listAudit(10)).find((entry) => entry.type === 'profile_added')
    expect(event?.target).toBe(added.model.id)
    // The API path stamps an automation actor, distinguishing it from the Access-session console add.
    expect(event?.actor).toMatch(/^automation:/)
    expect(event?.detail).toMatchObject({ modelRef: 'unsloth/Qwen3-14B-GGUF:Q4_K_M', split: false })
  })

  const apiDeleteModel = (router: (request: Request) => Promise<Response>, token: string | undefined, id: string) =>
    router(new Request('https://router.test/api/v1/models/' + id, { method: 'DELETE', headers: token ? bearer(token) : {} }))

  const adminAddModel = (router: (request: Request) => Promise<Response>, ref: string, mode = 'single', token = 'admin-secret') =>
    router(new Request('https://router.test/admin/profiles/add', { method: 'POST', headers: { ...bearer(token), 'content-type': 'application/json' }, body: JSON.stringify({ modelRef: ref, mode }) }))

  const adminDeleteModel = (router: (request: Request) => Promise<Response>, profileId: string, token = 'admin-secret') =>
    router(new Request('https://router.test/admin/profiles/delete', { method: 'POST', headers: { ...bearer(token), 'content-type': 'application/json' }, body: JSON.stringify({ profileId }) }))

  const addApiModelId = async (router: (request: Request) => Promise<Response>, token: string, ref = 'unsloth/Qwen3-14B-GGUF:Q4_K_M') =>
    (await (await apiAddModel(router, token, ref, 'single')).json() as { model: { id: string } }).model.id

  it('REQ-API-008 REQ-RUN-012 deletes a custom inactive model over the API', async () => {
    const { router, store } = routerFixture()
    const key = await mintKey(router)
    const id = await addApiModelId(router, key.token)
    const res = await apiDeleteModel(router, key.token, id)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, id })
    expect((await store.listProfiles()).some((profile) => profile.id === id)).toBe(false)
  })

  it('REQ-API-008 REQ-RUN-012 refuses deleting the active model', async () => {
    const { router, store } = routerFixture()
    const key = await mintKey(router)
    const id = await addApiModelId(router, key.token)
    await router(new Request('https://router.test/api/v1/models/' + id + '/enable', { method: 'POST', headers: bearer(key.token) }))
    const res = await apiDeleteModel(router, key.token, id)
    expect(res.status).toBe(409)
    expect((await res.json() as { error: string }).error).toBe('model_active')
    expect((await store.listProfiles()).some((profile) => profile.id === id)).toBe(true)
  })

  it('REQ-API-008 REQ-RUN-012 deletes the switched-off starter like any other model and it never re-seeds', async () => {
    const { router, store } = routerFixture()
    const key = await mintKey(router)
    // The seeded starter is active; switching it off makes it deletable (REQ-RUN-012).
    await router(new Request('https://router.test/api/v1/models/mesh-smoke-qwen25-1.5b/disable', { method: 'POST', headers: bearer(key.token) }))
    const res = await apiDeleteModel(router, key.token, 'mesh-smoke-qwen25-1.5b')
    expect(res.status).toBe(200)
    expect((await store.listProfiles()).some((profile) => profile.id === 'mesh-smoke-qwen25-1.5b')).toBe(false)
    // Seed-once: another request cycle must not resurrect the deleted starter (REQ-RUN-002).
    await router(new Request('https://router.test/health'))
    expect((await store.listProfiles()).some((profile) => profile.id === 'mesh-smoke-qwen25-1.5b')).toBe(false)
  })

  it('REQ-API-008 REQ-RUN-012 returns 404 deleting an unknown model', async () => {
    const { router } = routerFixture()
    const key = await mintKey(router)
    const res = await apiDeleteModel(router, key.token, 'custom-does-not-exist')
    expect(res.status).toBe(404)
  })

  it('REQ-API-008 refuses model deletion without an automation key', async () => {
    const { router, store } = routerFixture()
    const key = await mintKey(router)
    const id = await addApiModelId(router, key.token)
    const res = await apiDeleteModel(router, undefined, id)
    expect(res.status).toBe(401)
    expect((await store.listProfiles()).some((profile) => profile.id === id)).toBe(true)
  })

  it('REQ-ADM-026 deletes a custom model from the console', async () => {
    const { router, store } = routerFixture()
    const added = await (await adminAddModel(router, 'unsloth/Qwen3-14B-GGUF:Q4_K_M')).json() as { profileId: string }
    const res = await adminDeleteModel(router, added.profileId)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, profileId: added.profileId })
    expect((await store.listProfiles()).some((profile) => profile.id === added.profileId)).toBe(false)
  })

  it('REQ-ADM-026 refuses console deletion only while the model is active', async () => {
    const { router, store } = routerFixture()
    const res = await adminDeleteModel(router, 'mesh-smoke-qwen25-1.5b')
    expect(res.status).toBe(409)
    expect((await res.json() as { error: string }).error).toBe('model_active')
    expect((await store.listProfiles()).some((profile) => profile.id === 'mesh-smoke-qwen25-1.5b')).toBe(true)
  })

  it('REQ-ADM-026 refuses console model deletion without an admin credential', async () => {
    const { router } = routerFixture()
    const res = await adminDeleteModel(router, 'custom-anything', 'not-admin')
    expect(res.status).toBe(401)
  })

  it('REQ-OBS-006 records a profile-deleted audit event for model deletion', async () => {
    const { router, store } = routerFixture()
    const key = await mintKey(router)
    const id = await addApiModelId(router, key.token)
    await apiDeleteModel(router, key.token, id)
    const event = (await store.listAudit(10)).find((entry) => entry.type === 'profile_deleted')
    expect(event?.target).toBe(id)
    expect(event?.actor).toMatch(/^automation:/)
  })

  it('REQ-API-005 configures a model context window and rejects invalid input', async () => {
    const { router, store } = routerFixture()
    await seedLegacyDefaults(store)
    const key = await mintKey(router)
    const headers = { ...bearer(key.token), 'content-type': 'application/json' }
    const ok = await router(new Request('https://router.test/api/v1/models/mesh-default-qwen36-35b', { method: 'POST', headers, body: JSON.stringify({ contextWindow: 8192 }) }))
    expect(ok.status).toBe(200)
    expect((await store.listProfiles()).find((profile) => profile.id === 'mesh-default-qwen36-35b')?.contextWindow).toBe(8192)
    // A VRAM budget is accepted, stored, and echoed in the returned projection; a negative budget is rejected.
    const vram = await router(new Request('https://router.test/api/v1/models/mesh-default-qwen36-35b', { method: 'POST', headers, body: JSON.stringify({ maxVramGb: 16 }) }))
    expect(vram.status).toBe(200)
    expect((await vram.json() as { model: { maxVramGb: number } }).model.maxVramGb).toBe(16)
    expect((await store.listProfiles()).find((profile) => profile.id === 'mesh-default-qwen36-35b')?.meshllm!.maxVramGb).toBe(16)
    expect((await router(new Request('https://router.test/api/v1/models/mesh-default-qwen36-35b', { method: 'POST', headers, body: JSON.stringify({ maxVramGb: -5 }) }))).status).toBe(400)
    // Context window 0 = Auto is accepted; a negative context is rejected.
    const autoCtx = await router(new Request('https://router.test/api/v1/models/mesh-default-qwen36-35b', { method: 'POST', headers, body: JSON.stringify({ contextWindow: 0 }) }))
    expect(autoCtx.status).toBe(200)
    const bad = await router(new Request('https://router.test/api/v1/models/mesh-default-qwen36-35b', { method: 'POST', headers, body: JSON.stringify({ contextWindow: -1 }) }))
    expect(bad.status).toBe(400)
    const missing = await router(new Request('https://router.test/api/v1/models/ghost', { method: 'POST', headers, body: JSON.stringify({ contextWindow: 8192 }) }))
    expect(missing.status).toBe(404)
  })

  it('REQ-API-005 configures direct llama.cpp settings over the automation API', async () => {
    const { router, store } = routerFixture()
    const key = await mintKey(router)
    const headers = { ...bearer(key.token), 'content-type': 'application/json' }
    const add = await apiAddModel(router, key.token, 'unsloth/Qwen3-14B-GGUF:Q4_K_M', 'single', 'llamacpp')
    const profileId = (await add.json() as { model: { id: string } }).model.id

    const ok = await router(new Request(`https://router.test/api/v1/models/${profileId}`, { method: 'POST', headers, body: JSON.stringify({ llamacpp: { contextWindow: 131072, parallel: 2, cacheReuse: 512 } }) }))
    const body = await ok.json() as { model: { runtime: string; llamacpp?: { contextWindow: number; parallel: number; cacheReuse: number } } }
    const stored = (await store.listProfiles()).find((profile) => profile.id === profileId)!

    expect(ok.status).toBe(200)
    expect(body.model.runtime).toBe('llamacpp')
    expect(body.model.llamacpp).toMatchObject({ contextWindow: 131072, parallel: 2, cacheReuse: 512 })
    expect(stored.llamacpp).toMatchObject({ contextWindow: 131072, parallel: 2, cacheReuse: 512 })
    expect((await router(new Request(`https://router.test/api/v1/models/${profileId}`, { method: 'POST', headers, body: JSON.stringify({ llamacpp: { cacheReuse: -1 } }) }))).status).toBe(400)
  })

  it('REQ-API-005 enables a model and switches off another with the same callable name', async () => {
    const { router, store } = routerFixture()
    await seedLegacyDefaults(store)
    const key = await mintKey(router)
    const res = await router(new Request('https://router.test/api/v1/models/mesh-split-qwen36-35b/enable', { method: 'POST', headers: bearer(key.token) }))
    expect(res.status).toBe(200)
    const body = await res.json() as { activated: string; deactivated: string[] }
    expect(body.activated).toBe('mesh-split-qwen36-35b')
    // Single-active: enabling split switches off the seeded active model (smoke), not the already-inactive 35B.
    expect(body.deactivated).toContain('mesh-smoke-qwen25-1.5b')
    const profiles = await store.listProfiles()
    expect(profiles.find((profile) => profile.id === 'mesh-split-qwen36-35b')?.active).toBe(true)
    expect(profiles.find((profile) => profile.id === 'mesh-default-qwen36-35b')?.active).toBe(false)
  })

  it('REQ-API-005 disables a model by dropping its traffic to zero', async () => {
    const { router, store } = routerFixture()
    await seedLegacyDefaults(store)
    const key = await mintKey(router)
    const res = await router(new Request('https://router.test/api/v1/models/mesh-default-qwen36-35b/disable', { method: 'POST', headers: bearer(key.token) }))
    expect(res.status).toBe(200)
    const profile = (await store.listProfiles()).find((entry) => entry.id === 'mesh-default-qwen36-35b')
    expect(profile?.rolloutPercent).toBe(0)
    expect(profile?.active).toBe(false)
  })

  it('REQ-API-010 lists available agent versions to an automation caller', async () => {
    const { router } = routerFixture({ releasesFetcher: githubReleasesFetcher(['v1.2.0', 'v1.1.0']) })
    const key = await mintKey(router)
    const res = await router(new Request('https://router.test/api/v1/agent-versions', { headers: bearer(key.token) }))
    expect(res.status).toBe(200)
    expect((await res.json() as { tags: string[] }).tags).toContain('v1.2.0')
  })

  it('REQ-API-010 sets the fleet agent version and rejects an unknown version', async () => {
    const { router, store } = routerFixture({ releasesFetcher: githubReleasesFetcher(['v1.2.0', 'v1.1.0']) })
    const key = await mintKey(router)
    const headers = { ...bearer(key.token), 'content-type': 'application/json' }
    const ok = await router(new Request('https://router.test/api/v1/agent-version', { method: 'PUT', headers, body: JSON.stringify({ version: 'v1.2.0' }) }))
    expect(ok.status).toBe(200)
    expect(await store.getConfig('desired_agent_version')).toBe('v1.2.0')
    const bad = await router(new Request('https://router.test/api/v1/agent-version', { method: 'PUT', headers, body: JSON.stringify({ version: 'v9.9.9' }) }))
    expect(bad.status).toBe(400)
  })

  it('REQ-API-010 refuses model and version endpoints without an automation key', async () => {
    const { router } = routerFixture()
    expect((await router(new Request('https://router.test/api/v1/models', { headers: bearer('nope') }))).status).toBe(401)
    expect((await router(new Request('https://router.test/api/v1/models/x/enable', { method: 'POST', headers: bearer('nope') }))).status).toBe(401)
    expect((await router(new Request('https://router.test/api/v1/agent-versions', { headers: bearer('nope') }))).status).toBe(401)
    expect((await router(new Request('https://router.test/api/v1/agent-version', { method: 'PUT', headers: { ...bearer('nope'), 'content-type': 'application/json' }, body: '{}' }))).status).toBe(401)
    expect((await router(new Request('https://router.test/api/v1/runtime-versions', { headers: bearer('nope') }))).status).toBe(401)
    expect((await router(new Request('https://router.test/api/v1/runtime-versions', { method: 'PUT', headers: { ...bearer('nope'), 'content-type': 'application/json' }, body: '{}' }))).status).toBe(401)
  })

  // Events tests seed the automation key directly (no mint) so no automation_key_created event pollutes the log.
  async function seedAutomationKey(store: MemoryStore): Promise<string> {
    await store.putToken(await createTokenRecord('automation', 'auto-secret', 1_700_000_000_000))
    return 'auto-secret'
  }

  it('REQ-API-006 lists operational events oldest-first and hides internal bookkeeping', async () => {
    const { router, store } = routerFixture()
    const token = await seedAutomationKey(store)
    await store.appendAudit({ id: 'e1', type: 'node_claimed', at: 100, actor: 'setup', target: 'node-a', detail: {} })
    await store.appendAudit({ id: 'e2', type: 'mesh_state_stored', at: 150, actor: 'system', detail: {} })
    await store.appendAudit({ id: 'e3', type: 'profile_activated', at: 200, actor: 'admin', target: 'm', detail: {} })
    const res = await router(new Request('https://router.test/api/v1/events', { headers: bearer(token) }))
    expect(res.status).toBe(200)
    const body = await res.json() as { events: Array<{ id: string; type: string }>; nextCursor: string | null }
    expect(body.events.map((event) => event.id)).toEqual(['e1', 'e3'])
    expect(body.events.map((event) => event.type)).not.toContain('mesh_state_stored')
  })

  it('REQ-API-006 returns only events after the since timestamp', async () => {
    const { router, store } = routerFixture()
    const token = await seedAutomationKey(store)
    await store.appendAudit({ id: 'old', type: 'node_claimed', at: 100, actor: 'setup', target: 'n', detail: {} })
    await store.appendAudit({ id: 'new', type: 'node_claimed', at: 500, actor: 'setup', target: 'n', detail: {} })
    const body = await (await router(new Request('https://router.test/api/v1/events?since=200', { headers: bearer(token) }))).json() as { events: Array<{ id: string }> }
    expect(body.events.map((event) => event.id)).toEqual(['new'])
  })

  it('REQ-API-006 filters events by type', async () => {
    const { router, store } = routerFixture()
    const token = await seedAutomationKey(store)
    await store.appendAudit({ id: 'a', type: 'node_claimed', at: 100, actor: 'setup', target: 'n', detail: {} })
    await store.appendAudit({ id: 'b', type: 'profile_activated', at: 200, actor: 'admin', target: 'm', detail: {} })
    const body = await (await router(new Request('https://router.test/api/v1/events?type=profile_activated', { headers: bearer(token) }))).json() as { events: Array<{ id: string }> }
    expect(body.events.map((event) => event.id)).toEqual(['b'])
  })

  it('REQ-API-006 paginates events by cursor', async () => {
    const { router, store } = routerFixture()
    const token = await seedAutomationKey(store)
    for (const [id, at] of [['x1', 10], ['x2', 20], ['x3', 30]] as const) {
      await store.appendAudit({ id, type: 'node_claimed', at, actor: 'setup', target: 'n', detail: {} })
    }
    const first = await (await router(new Request('https://router.test/api/v1/events?limit=2', { headers: bearer(token) }))).json() as { events: Array<{ id: string }>; nextCursor: string | null }
    expect(first.events.map((event) => event.id)).toEqual(['x1', 'x2'])
    expect(first.nextCursor).toBe('20:x2')
    const second = await (await router(new Request(`https://router.test/api/v1/events?limit=2&since=${first.nextCursor}`, { headers: bearer(token) }))).json() as { events: Array<{ id: string }>; nextCursor: string | null }
    expect(second.events.map((event) => event.id)).toEqual(['x3'])
    expect(second.nextCursor).toBeNull()
  })

  it('REQ-API-006 keyset cursor does not skip same-millisecond events across a page boundary', async () => {
    const { router, store } = routerFixture()
    const token = await seedAutomationKey(store)
    await store.appendAudit({ id: 'a1', type: 'node_claimed', at: 50, actor: 'setup', target: 'n', detail: {} })
    await store.appendAudit({ id: 'a2', type: 'node_claimed', at: 50, actor: 'setup', target: 'n', detail: {} })
    const first = await (await router(new Request('https://router.test/api/v1/events?limit=1', { headers: bearer(token) }))).json() as { events: Array<{ id: string }>; nextCursor: string | null }
    expect(first.events.map((event) => event.id)).toEqual(['a1'])
    expect(first.nextCursor).toBe('50:a1')
    const second = await (await router(new Request(`https://router.test/api/v1/events?limit=1&since=${first.nextCursor}`, { headers: bearer(token) }))).json() as { events: Array<{ id: string }> }
    expect(second.events.map((event) => event.id)).toEqual(['a2'])
    // A bare millisecond cursor stays exclusive: both events AT 50 are skipped.
    const bare = await (await router(new Request('https://router.test/api/v1/events?since=50', { headers: bearer(token) }))).json() as { events: Array<{ id: string }> }
    expect(bare.events.map((event) => event.id)).toEqual([])
  })

  it('REQ-API-006 refuses events access without an automation key', async () => {
    const { router } = routerFixture()
    expect((await router(new Request('https://router.test/api/v1/events', { headers: bearer('nope') }))).status).toBe(401)
  })
})

describe('multi-mesh machine groups', () => {
  const DEV_GGUF = 'unsloth/Qwen3-14B-GGUF:Q4_K_M'

  async function mintKey(router: (request: Request) => Promise<Response>): Promise<string> {
    const res = await router(new Request('https://router.test/api/v1/keys', { method: 'POST', headers: bearer('admin-secret') }))
    return ((await res.json()) as { token: string }).token
  }

  const createMeshReq = (router: (request: Request) => Promise<Response>, name: string, token = 'admin-secret') =>
    router(new Request('https://router.test/admin/meshes', {
      method: 'POST',
      headers: { ...bearer(token), 'content-type': 'application/json' },
      body: JSON.stringify({ name })
    }))

  const addModelReq = (router: (request: Request) => Promise<Response>, body: Record<string, unknown>) =>
    router(new Request('https://router.test/admin/profiles/add', {
      method: 'POST',
      headers: { ...bearer('admin-secret'), 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }))

  const configureProfile = (router: (request: Request) => Promise<Response>, body: Record<string, unknown>) =>
    router(new Request('https://router.test/admin/profiles/config', {
      method: 'POST',
      headers: { ...bearer('admin-secret'), 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }))

  it('REQ-ADM-037 creates and lists meshes with machine and model counts', async () => {
    const { router, store } = routerFixture()
    await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)

    const created = await createMeshReq(router, 'dEvElOpMeNt')
    expect(created.status).toBe(201)
    expect(await created.json()).toMatchObject({ mesh: { id: 'development', name: 'Development', alias: 'codeflare-mesh-development' } })
    expect(store.audit.some((event) => event.type === 'mesh_created' && event.target === 'development')).toBe(true)

    await store.upsertNode({ ...nodeFixture(), meshId: 'development' })
    expect((await addModelReq(router, { modelRef: DEV_GGUF, mode: 'single', meshId: 'development' })).status).toBe(201)

    const list = await router(new Request('https://router.test/admin/meshes', { headers: bearer('admin-secret') }))
    const body = await list.json() as { meshes: Array<{ id: string; name: string; alias: string; machineCount: number; modelCount: number }> }
    expect(list.status).toBe(200)
    expect(body.meshes[0]).toMatchObject({ id: 'default', name: 'Default', alias: 'codeflare-mesh', machineCount: 0, modelCount: 1 })
    expect(body.meshes.find((mesh) => mesh.id === 'development')).toMatchObject({ name: 'Development', alias: 'codeflare-mesh-development', machineCount: 1, modelCount: 1 })
  })

  it('REQ-ADM-037 rejects invalid, duplicate, and alias-colliding mesh names', async () => {
    const { router, store } = routerFixture()
    for (const bad of ['', 'Dev Ops', 'noobs!', 'a'.repeat(33)]) {
      const res = await createMeshReq(router, bad)
      expect(res.status).toBe(400)
      expect((await res.json() as { error: string }).error).toBe('invalid_mesh_name')
    }
    expect((await createMeshReq(router, 'Development')).status).toBe(201)
    for (const dup of ['DEVELOPMENT', 'development', 'Default']) {
      const res = await createMeshReq(router, dup)
      expect(res.status).toBe(409)
      expect((await res.json() as { error: string }).error).toBe('mesh_exists')
    }
    // A stored profile already answering the would-be mesh alias blocks creation:
    // the alias would gain two owners the moment a model activates in the new mesh.
    await store.setProfile({ ...LEGACY_MESH_DEFAULT, publicAliases: ['codeflare-mesh', 'codeflare-mesh-ops'] })
    const collision = await createMeshReq(router, 'Ops')
    expect(collision.status).toBe(409)
    expect((await collision.json() as { error: string }).error).toBe('mesh_alias_conflict')
  })

  it('REQ-ADM-037 deletes only empty non-default meshes', async () => {
    const { router, store } = routerFixture()
    const del = (id: string) => router(new Request(`https://router.test/admin/meshes/${id}`, { method: 'DELETE', headers: bearer('admin-secret') }))

    expect((await del('default')).status).toBe(400)
    expect((await del('ghost')).status).toBe(404)

    await createMeshReq(router, 'Development')
    await store.upsertNode({ ...nodeFixture(), meshId: 'development' })
    expect((await del('development')).status).toBe(409)
    expect((await (await del('development')).json() as { error: string }).error).toBe('mesh_not_empty')

    await createMeshReq(router, 'Ops')
    expect((await addModelReq(router, { modelRef: DEV_GGUF, mode: 'single', meshId: 'ops' })).status).toBe(201)
    expect((await del('ops')).status).toBe(409)

    await store.upsertNode({ ...nodeFixture(), meshId: 'default' })
    const emptied = await del('development')
    expect(emptied.status).toBe(200)
    const deletion = store.audit.find((event) => event.type === 'mesh_deleted' && event.target === 'development')
    expect(deletion?.detail).toMatchObject({ routeName: 'codeflare-mesh-development' })
    expect((await (await router(new Request('https://router.test/admin/meshes', { headers: bearer('admin-secret') }))).json() as { meshes: Array<{ id: string }> }).meshes.map((mesh) => mesh.id)).toEqual(['default', 'ops'])
  })

  it('REQ-API-011 automation manages meshes through the /api/v1 twins', async () => {
    const { router } = routerFixture()
    const token = await mintKey(router)

    expect((await router(new Request('https://router.test/api/v1/meshes', { headers: bearer('nope') }))).status).toBe(401)

    const created = await router(new Request('https://router.test/api/v1/meshes', {
      method: 'POST',
      headers: { ...bearer(token), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Noobs' })
    }))
    expect(created.status).toBe(201)
    expect(await created.json()).toMatchObject({ mesh: { id: 'noobs', name: 'Noobs', alias: 'codeflare-mesh-noobs' } })

    const list = await router(new Request('https://router.test/api/v1/meshes', { headers: bearer(token) }))
    expect(list.status).toBe(200)
    expect((await list.json() as { meshes: Array<{ id: string }> }).meshes.map((mesh) => mesh.id)).toEqual(['default', 'noobs'])

    expect((await router(new Request('https://router.test/api/v1/meshes/noobs', { method: 'DELETE', headers: bearer(token) }))).status).toBe(200)
  })

  it('REQ-SCH-006 heartbeat and claim send only the node mesh profiles', async () => {
    const { router, store } = routerFixture()
    await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)
    await createMeshReq(router, 'Development')
    expect((await addModelReq(router, { modelRef: DEV_GGUF, mode: 'single', meshId: 'development' })).status).toBe(201)
    const devProfileId = (await store.listProfiles()).find((profile) => profile.meshId === 'development')!.id
    await store.upsertNode({ ...nodeFixture(), nodeTokenVerifier: await hashToken('node-secret') })

    const beat = (body: string) => router(new Request('https://router.test/node/heartbeat', {
      method: 'POST',
      headers: { ...bearer('node-secret'), 'content-type': 'application/json' },
      body
    }))
    const first = await (await beat(heartbeatBody())).json() as { desiredProfiles: Array<{ id: string }> }
    expect(first.desiredProfiles.map((profile) => profile.id)).toContain('mesh-smoke-qwen25-1.5b')
    expect(first.desiredProfiles.map((profile) => profile.id)).not.toContain(devProfileId)

    // After reassignment the node still self-reports its old profile ids for a tick;
    // the router must answer with the new group's catalog anyway.
    const reassign = await router(new Request('https://router.test/admin/nodes/node-a/config', {
      method: 'POST',
      headers: { ...bearer('admin-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ meshId: 'development' })
    }))
    expect(reassign.status).toBe(200)
    const second = await (await beat(heartbeatBody())).json() as { desiredProfiles: Array<{ id: string }> }
    expect(second.desiredProfiles.map((profile) => profile.id)).toEqual([devProfileId])

    // A brand-new claim lands in the default mesh and receives only its catalog.
    const tokenResponse = await router(new Request('https://router.test/admin/setup-tokens', { method: 'POST', headers: bearer('admin-secret') }))
    const { setupToken } = await tokenResponse.json() as { setupToken: string }
    const claim = await router(new Request('https://router.test/node/claim', {
      method: 'POST',
      headers: { ...bearer(setupToken), 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Node B', meshIp: '100.64.1.11', inferencePort: 8080, publicModels: [], activeProfileIds: [], capacity: 1 })
    }))
    expect(claim.status).toBe(201)
    const claimed = await claim.json() as { nodeId: string; profiles: Array<{ id: string }> }
    expect(claimed.profiles.map((profile) => profile.id)).toContain('mesh-smoke-qwen25-1.5b')
    expect(claimed.profiles.map((profile) => profile.id)).not.toContain(devProfileId)
    expect((await store.getNode(claimed.nodeId))?.meshId ?? 'default').toBe('default')
  })

  it('REQ-ADM-023 reassigning a node drops its mesh tokens and heartbeats do not re-add them', async () => {
    const { router, store } = routerFixture({ env: { MESH_STATE_KEY: MESH_STATE_KEY_B64 } })
    await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)
    await createMeshReq(router, 'Development')
    await store.upsertNode({ ...nodeFixture(), nodeTokenVerifier: await hashToken('node-secret') })
    const beat = () => router(new Request('https://router.test/node/heartbeat', {
      method: 'POST',
      headers: { ...bearer('node-secret'), 'content-type': 'application/json' },
      body: heartbeatBody({ meshId: 'mesh-1', meshToken: 'invite-token-value-a' })
    }))
    await beat()
    expect(store.config.get('mesh_state:mesh-smoke-qwen25-1.5b')).toBeDefined()

    const config = (body: Record<string, unknown>) => router(new Request('https://router.test/admin/nodes/node-a/config', {
      method: 'POST',
      headers: { ...bearer('admin-secret'), 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }))
    expect((await config({ meshId: 'ghost' })).status).toBe(400)
    expect((await (await config({ meshId: 'ghost' })).json() as { error: string }).error).toBe('unknown_mesh')

    const moved = await config({ meshId: 'development' })
    expect(moved.status).toBe(200)
    expect((await moved.json() as { meshId: string }).meshId).toBe('development')
    const assignment = store.audit.find((event) => event.type === 'node_mesh_assigned' && event.target === 'node-a')
    expect(assignment?.detail).toMatchObject({ from: 'default', to: 'development' })
    expect(store.audit.some((event) => event.type === 'mesh_token_removed' && event.target === 'node-a')).toBe(true)

    // The node's next heartbeat still carries the old mesh token and stale profile ids;
    // the mesh gate must not hand back a bootstrap or re-add the token.
    const after = await (await beat()).json() as { desiredProfiles: unknown[]; meshBootstrap?: unknown }
    expect(after.desiredProfiles).toEqual([])
    expect(after.meshBootstrap).toBeUndefined()
    const status = await router(new Request('https://router.test/admin/status', { headers: bearer('admin-secret') }))
    const statusBody = await status.json() as { meshHealth?: Array<{ profileId: string; tokenCount?: number }> }
    expect((statusBody.meshHealth ?? []).find((entry) => entry.profileId === 'mesh-smoke-qwen25-1.5b')?.tokenCount ?? 0).toBe(0)
  })

  it('REQ-API-004 the reconfigure twin accepts meshId and api nodes carry it', async () => {
    const { router, store } = routerFixture()
    await createMeshReq(router, 'Development')
    await store.upsertNode(nodeFixture())
    const token = await mintKey(router)

    const moved = await router(new Request('https://router.test/api/v1/nodes/node-a/reconfigure', {
      method: 'POST',
      headers: { ...bearer(token), 'content-type': 'application/json' },
      body: JSON.stringify({ meshId: 'development' })
    }))
    expect(moved.status).toBe(200)
    expect((await moved.json() as { node: { meshId: string } }).node.meshId).toBe('development')

    const list = await router(new Request('https://router.test/api/v1/nodes', { headers: bearer(token) }))
    const nodes = (await list.json() as { nodes: Array<{ id: string; meshId: string }> }).nodes
    expect(nodes.find((node) => node.id === 'node-a')?.meshId).toBe('development')
  })

  it('REQ-SCH-006 profile readiness counts only same-mesh nodes', async () => {
    const { router, store } = routerFixture()
    await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)
    await createMeshReq(router, 'Development')
    await store.upsertNode({ ...nodeFixture(), nodeTokenVerifier: await hashToken('node-secret') })
    await router(new Request('https://router.test/node/heartbeat', {
      method: 'POST',
      headers: { ...bearer('node-secret'), 'content-type': 'application/json' },
      body: heartbeatBody()
    }))

    const readiness = async () => {
      const res = await router(new Request('https://router.test/admin/status', { headers: bearer('admin-secret') }))
      const body = await res.json() as { profileReadiness?: Array<{ profileId: string; ready: number }> }
      return (body.profileReadiness ?? []).find((entry) => entry.profileId === 'mesh-smoke-qwen25-1.5b')?.ready ?? 0
    }
    expect(await readiness()).toBe(1)

    const node = (await store.getNode('node-a'))!
    await store.upsertNode({ ...node, meshId: 'development' })
    expect(await readiness()).toBe(0)
  })

  it('REQ-RUN-016 reassigning a model swaps its mesh alias and deactivates it', async () => {
    const { router, store } = routerFixture()
    await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)
    await createMeshReq(router, 'Development')
    const add = await addModelReq(router, { modelRef: DEV_GGUF, mode: 'single' })
    const profileId = (await add.json() as { profileId: string }).profileId
    await router(new Request('https://router.test/admin/profiles/activate', {
      method: 'POST',
      headers: { ...bearer('admin-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ profileId })
    }))
    const activated = (await store.listProfiles()).find((profile) => profile.id === profileId)!
    expect(activated.active).toBe(true)

    expect((await configureProfile(router, { profileId, meshId: 'ghost' })).status).toBe(400)

    const moved = await configureProfile(router, { profileId, meshId: 'development' })
    expect(moved.status).toBe(200)
    expect((await moved.json() as { meshId: string }).meshId).toBe('development')
    const reassigned = (await store.listProfiles()).find((profile) => profile.id === profileId)!
    expect(reassigned.meshId).toBe('development')
    expect(reassigned.publicAliases[0]).toBe('codeflare-mesh-development')
    expect(reassigned.publicAliases).not.toContain('codeflare-mesh')
    expect(reassigned.active).toBe(false)
    expect(reassigned.rolloutPercent).toBe(0)
    expect(reassigned.version).toBeGreaterThan(activated.version)
    const assignment = store.audit.find((event) => event.type === 'model_mesh_assigned' && event.target === profileId)
    expect(assignment?.detail).toMatchObject({ from: 'default', to: 'development' })
  })

  it('REQ-RUN-016 call-name edits preserve the mesh alias and reject reserved names', async () => {
    const { router, store } = routerFixture()
    await createMeshReq(router, 'Development')
    const add = await addModelReq(router, { modelRef: DEV_GGUF, mode: 'single', meshId: 'development' })
    const profileId = (await add.json() as { profileId: string }).profileId

    const renamed = await configureProfile(router, { profileId, callName: 'fast' })
    expect(renamed.status).toBe(200)
    expect((await store.listProfiles()).find((profile) => profile.id === profileId)?.publicAliases).toEqual(['codeflare-mesh-development', 'fast'])

    for (const reserved of ['codeflare-mesh', 'codeflare-mesh-noobs']) {
      const res = await configureProfile(router, { profileId, callName: reserved })
      expect(res.status).toBe(409)
      expect((await res.json() as { error: string }).error).toBe('call_name_conflict')
    }
  })

  it('REQ-RUN-016 onboarding accepts a target mesh and stamps its alias', async () => {
    const { router, store } = routerFixture()
    await createMeshReq(router, 'Development')

    expect((await addModelReq(router, { modelRef: DEV_GGUF, mode: 'single', meshId: 'ghost' })).status).toBe(400)

    const add = await addModelReq(router, { modelRef: DEV_GGUF, mode: 'single', runtime: 'llamacpp', meshId: 'development' })
    expect(add.status).toBe(201)
    expect((await add.json() as { model: { meshId: string } }).model.meshId).toBe('development')
    const created = (await store.listProfiles()).find((profile) => profile.upstreamModel === DEV_GGUF)!
    expect(created.publicAliases[0]).toBe('codeflare-mesh-development')
    expect(created.meshId).toBe('development')
  })

  it('REQ-API-005 the model configure twin accepts meshId and api models carry it', async () => {
    const { router, store } = routerFixture()
    await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)
    await createMeshReq(router, 'Development')
    const token = await mintKey(router)

    const moved = await router(new Request('https://router.test/api/v1/models/mesh-smoke-qwen25-1.5b', {
      method: 'POST',
      headers: { ...bearer(token), 'content-type': 'application/json' },
      body: JSON.stringify({ meshId: 'development' })
    }))
    expect(moved.status).toBe(200)

    const list = await router(new Request('https://router.test/api/v1/models', { headers: bearer(token) }))
    const models = (await list.json() as { models: Array<{ id: string; meshId: string }> }).models
    expect(models.find((model) => model.id === 'mesh-smoke-qwen25-1.5b')?.meshId).toBe('development')
  })

  it('REQ-GWY-009 gateway sync ensures one dynamic route per mesh', async () => {
    let received: { extraRoutes: readonly { routeName: string; publicModel: string }[] | undefined; routeName: string } | undefined
    const { router, store } = routerFixture({
      env: { CLOUDFLARE_ACCOUNT_ID: 'acct-1', AI_GATEWAY_ID: 'inference-mesh' },
      cloudflareClient: {
        async syncCustomProvider(input) {
          received = { extraRoutes: input.extraRoutes, routeName: input.routeName }
          return { providerId: 'p', providerSlug: 'slug', routeId: 'r', routeVersionId: 'v', deploymentId: 'd', gatewayId: input.gatewayId, routeName: input.routeName, publicModel: input.publicModel, workerUrl: input.workerUrl, manualProviderKeyRequired: true, providerTokenInstructions: 'x' }
        },
        async provisionCustomDomain() { throw new Error('custom domain is not used in this test') }
      }
    })
    await store.putConfig('custom_domain', { hostname: 'mesh.example.com', status: 'provisioned' })
    const sync = () => router(new Request('https://router.test/admin/cloudflare/gateway/sync', { method: 'POST', headers: bearer('admin-secret') }))

    expect((await sync()).status).toBe(200)
    expect(received?.routeName).toBe('codeflare-mesh')
    expect(received?.extraRoutes).toBeUndefined()

    await createMeshReq(router, 'Development')
    await createMeshReq(router, 'Ops')
    expect((await sync()).status).toBe(200)
    expect(received?.extraRoutes).toEqual([
      { routeName: 'codeflare-mesh-development', publicModel: 'codeflare-mesh-development' },
      { routeName: 'codeflare-mesh-ops', publicModel: 'codeflare-mesh-ops' }
    ])
  })

  it('REQ-GWY-009 the gateway client upserts a route per extra mesh route', async () => {
    const calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = []
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
      calls.push({ method, path: url.pathname, ...(body ? { body } : {}) })
      if (url.pathname.endsWith('/custom-providers') && method === 'GET') return Response.json({ success: true, result: [] })
      if (url.pathname.endsWith('/custom-providers') && method === 'POST') return Response.json({ success: true, result: { id: 'provider-a', slug: 'codeflare-inference-mesh' } })
      if (url.pathname.endsWith('/ai-gateway/gateways') && method === 'GET') return Response.json({ success: true, result: [{ id: 'gateway-a', authentication: true }] })
      if (url.pathname.endsWith('/routes') && method === 'GET') return Response.json({ success: true, data: { routes: [] } })
      return Response.json({ success: true, result: { id: `route-${calls.length}`, name: (body?.name as string) ?? 'unknown', version: { version_id: 'version-a' }, deployment: { deployment_id: 'deployment-a', version_id: 'version-a' } } })
    }) as typeof fetch

    const result = await new CloudflareGatewayClient('runtime-token', fetcher).syncCustomProvider({
      accountId: 'account-a',
      gatewayId: 'gateway-a',
      workerUrl: 'https://router.example.workers.dev/v1/chat/completions',
      providerName: 'Codeflare Inference Mesh',
      routeName: 'codeflare-mesh',
      publicModel: 'codeflare-mesh',
      extraRoutes: [{ routeName: 'codeflare-mesh-development', publicModel: 'codeflare-mesh-development' }],
      providerTokenInstructions: 'manual'
    })

    const routePosts = calls.filter((call) => call.method === 'POST' && call.path.endsWith('/routes')).map((call) => call.body?.name)
    expect(routePosts).toEqual(['codeflare-mesh', 'codeflare-mesh-development'])
    expect(result.routes?.map((route) => route.routeName)).toEqual(['codeflare-mesh', 'codeflare-mesh-development'])
  })

  it('REQ-ADM-037 admin status lists meshes with counts', async () => {
    const { router, store } = routerFixture()
    await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)
    await createMeshReq(router, 'Development')
    await store.upsertNode({ ...nodeFixture(), meshId: 'development' })

    const status = await router(new Request('https://router.test/admin/status', { headers: bearer('admin-secret') }))
    const body = await status.json() as { meshes?: Array<{ id: string; name: string; alias: string; machineCount: number; modelCount: number }> }
    expect(status.status).toBe(200)
    expect(body.meshes?.[0]).toMatchObject({ id: 'default', alias: 'codeflare-mesh', machineCount: 0, modelCount: 1 })
    expect(body.meshes?.find((mesh) => mesh.id === 'development')).toMatchObject({ name: 'Development', machineCount: 1, modelCount: 0 })
  })

  it('REQ-RUN-017 duplicates a profile as an inactive same-mesh copy with a derived call name', async () => {
    const { router, store } = routerFixture()
    await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)
    await createMeshReq(router, 'Development')
    const add = await addModelReq(router, { modelRef: DEV_GGUF, mode: 'single', name: 'Coder', meshId: 'development' })
    const sourceId = (await add.json() as { profileId: string }).profileId
    const duplicate = (profileId: string) => router(new Request('https://router.test/admin/profiles/duplicate', {
      method: 'POST',
      headers: { ...bearer('admin-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ profileId })
    }))

    expect((await duplicate('ghost')).status).toBe(404)

    const first = await duplicate(sourceId)
    expect(first.status).toBe(201)
    const firstId = (await first.json() as { profileId: string }).profileId
    expect(firstId).not.toBe(sourceId)
    const source = (await store.listProfiles()).find((profile) => profile.id === sourceId)!
    const copy = (await store.listProfiles()).find((profile) => profile.id === firstId)!
    expect(copy.displayName).toBe('Coder (copy)')
    expect(copy.meshId).toBe('development')
    expect(copy.publicAliases[0]).toBe('codeflare-mesh-development')
    expect(copy.publicAliases[1]).toBe(`${source.publicAliases[1]}-copy`)
    expect(copy.upstreamModel).toBe(source.upstreamModel)
    expect(copy.runtime).toBe(source.runtime)
    expect(copy.contextWindow).toBe(source.contextWindow)
    expect(copy.active).toBe(false)
    expect(copy.rolloutPercent).toBe(0)
    expect(copy.version).toBe(1)
    expect(copy.meshllm?.modelRef).toBe(source.meshllm?.modelRef)
    expect(copy.meshllm?.bindPort).not.toBe(source.meshllm?.bindPort)
    expect(store.audit.some((event) => event.type === 'model_duplicated' && event.target === firstId)).toBe(true)

    // A second duplicate of the same source coexists under the next derived name.
    const second = await duplicate(sourceId)
    expect(second.status).toBe(201)
    const secondId = (await second.json() as { profileId: string }).profileId
    expect(secondId).not.toBe(firstId)
    const copy2 = (await store.listProfiles()).find((profile) => profile.id === secondId)!
    expect(copy2.publicAliases[1]).toBe(`${source.publicAliases[1]}-copy-2`)

    // The copy is an ordinary profile: its details are editable independently.
    const edited = await configureProfile(router, { profileId: firstId, name: 'Coder Tuned', contextWindow: 8192 })
    expect(edited.status).toBe(200)
    expect((await store.listProfiles()).find((profile) => profile.id === sourceId)?.displayName).toBe('Coder')
  })

  it('REQ-ADM-020 REQ-API-004 node projections carry the derived operator status vocabulary', async () => {
    const { router, store } = routerFixture()
    const token = await mintKey(router)
    const base = nodeFixture()
    await store.upsertNode({ ...base, id: 'n-serving', metrics: { runtimeState: 'ready', activeRequests: 0, readyModels: ['m'] } })
    await store.upsertNode({ ...base, id: 'n-preparing', metrics: { runtimeState: 'starting', activeRequests: 0, readyModels: [] } })
    await store.upsertNode({ ...base, id: 'n-disconnected', metrics: { runtimeState: 'stopped', activeRequests: 0 } })
    await store.upsertNode({ ...base, id: 'n-error', metrics: { runtimeState: 'dependency-missing', activeRequests: 0 } })
    await store.upsertNode({ ...base, id: 'n-offline', status: 'offline', metrics: { runtimeState: 'starting', activeRequests: 0 } })
    await store.upsertNode({ ...base, id: 'n-deactivated', deactivated: true, metrics: { runtimeState: 'ready', activeRequests: 0, readyModels: ['m'] } })

    const res = await router(new Request('https://router.test/api/v1/nodes', { headers: bearer(token) }))
    const nodes = (await res.json() as { nodes: Array<{ id: string; displayStatus: string }> }).nodes
    const statusOf = (id: string) => nodes.find((node) => node.id === id)?.displayStatus
    expect(statusOf('n-serving')).toBe('Serving')
    expect(statusOf('n-preparing')).toBe('Preparing')
    expect(statusOf('n-disconnected')).toBe('Disconnected')
    expect(statusOf('n-error')).toBe('Error')
    expect(statusOf('n-offline')).toBe('Offline')
    expect(statusOf('n-deactivated')).toBe('Deactivated')

    // Admin status nodes carry the same field, so the console renders the identical contract.
    const status = await router(new Request('https://router.test/admin/status', { headers: bearer('admin-secret') }))
    const statusNodes = (await status.json() as { nodes: Array<{ id: string; displayStatus?: string }> }).nodes
    expect(statusNodes.find((node) => node.id === 'n-serving')?.displayStatus).toBe('Serving')
  })

  it('REQ-ADM-033 a starting runtime with stderr chatter is never reported as an install failure', async () => {
    const { router, store } = routerFixture()
    const token = await mintKey(router)
    // The runtime has not reported its version yet (still starting) and mesh-llm emitted a
    // benign WARN on stderr; the install status must stay pending, not phantom-fail.
    await store.upsertNode({
      ...nodeFixture(),
      metrics: { runtimeKind: 'meshllm', runtimeState: 'starting', activeRequests: 0, runtimeDetail: 'WARN noq_proto::connection: failed closing path err=MultipathNotNegotiated' }
    })

    const res = await router(new Request('https://router.test/api/v1/nodes', { headers: bearer(token) }))
    const node = (await res.json() as { nodes: Array<{ runtimeInstall?: Record<string, unknown> }> }).nodes[0]
    expect(node?.runtimeInstall).toMatchObject({ runtime: 'meshllm', installedVersion: null, state: 'pending', error: null })
  })

  it('REQ-RUN-017 the automation duplicate twin mirrors the console behavior', async () => {
    const { router, store } = routerFixture()
    await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)
    const token = await mintKey(router)

    expect((await router(new Request('https://router.test/api/v1/models/mesh-smoke-qwen25-1.5b/duplicate', { method: 'POST', headers: bearer('nope') }))).status).toBe(401)

    const res = await router(new Request('https://router.test/api/v1/models/mesh-smoke-qwen25-1.5b/duplicate', { method: 'POST', headers: bearer(token) }))
    expect(res.status).toBe(201)
    const body = await res.json() as { model: { id: string; meshId: string; active: boolean } }
    expect(body.model.id).not.toBe('mesh-smoke-qwen25-1.5b')
    expect(body.model.meshId).toBe('default')
    expect(body.model.active).toBe(false)
    expect((await store.listProfiles()).some((profile) => profile.id === body.model.id)).toBe(true)
  })
})
