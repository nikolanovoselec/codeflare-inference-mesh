/**
 * router admin console contracts.
 *
 * One slice of the router's behavioural suite; shared fixtures live in
 * `./router-test-support`.
 */
import { ADMIN_UI_CLIENT_FRAGMENTS, ADMIN_UI_CLIENT_SCRIPT } from './admin-ui-client'
import { adminUiHarness } from './admin-ui-harness'
import { buildCustomProfile, DEFAULT_MODEL_PROFILES } from './profiles'
import { CloudflareGatewayClient } from './cloudflare-api'
import { createTokenRecord, hashToken } from './auth'
import { describe, expect, it } from 'vitest'
import { installerPlan, SETUP_TOKEN_PLACEHOLDER } from './installers'
import { MESH_STATE_KEY_B64, SMOKE_UPSTREAM, adminUiConfig, adminUiScript, bearer, heartbeatBody, routerFixture, seedLegacyDefaults, valuesOf } from './router-test-support'
import { nodeFixture } from './test-helpers'

describe('router admin console contracts', () => {

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


  it('REQ-ADM-007 assembles the console client script from its fragments in order', () => {
    // The script is concatenated from per-topic fragments. A dropped, duplicated or
    // reordered fragment still yields a string and only the browser would notice, so
    // assert the closure the page actually needs.
    expect(ADMIN_UI_CLIENT_SCRIPT.startsWith("(() => {\n  'use strict';")).toBe(true)
    expect(ADMIN_UI_CLIENT_SCRIPT.endsWith('})();')).toBe(true)
    // Interpolation is what let esbuild's __name helper leak into the page and crash it.
    expect(ADMIN_UI_CLIENT_SCRIPT).not.toContain('${')

    expect(ADMIN_UI_CLIENT_FRAGMENTS.length).toBeGreaterThan(1)
    let cursor = -1
    for (const fragment of ADMIN_UI_CLIENT_FRAGMENTS) {
      const at = ADMIN_UI_CLIENT_SCRIPT.indexOf(fragment)
      expect(at).toBeGreaterThan(cursor)
      expect(ADMIN_UI_CLIENT_SCRIPT.indexOf(fragment, at + 1)).toBe(-1)
      cursor = at
    }
  })


  it('REQ-ADM-007 dispatches every console action through the action table', () => {
    // The console had one 418-line if-chain over action ids. Every action a button can
    // carry now resolves through the table, so a bound id is what makes an action exist.
    const bound = [...ADMIN_UI_CLIENT_SCRIPT.matchAll(/^ {2}bindAction\((?:'([^']+)'|([\w.]+)),/gm)].map((match) => match[1] ?? match[2])
    expect(bound.length).toBeGreaterThan(30)
    expect(new Set(bound).size).toBe(bound.length)
    // The dispatcher resolves one handler and does nothing for an id it does not know,
    // so no branch chain over action ids survives. (A lone `if (action === …)` is still
    // fine where it special-cases one action's error copy rather than routing it.)
    expect(ADMIN_UI_CLIENT_SCRIPT).toContain('const handler = ACTIONS[action];')
    expect(ADMIN_UI_CLIENT_SCRIPT).not.toMatch(/else if \(action === /)
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

})
