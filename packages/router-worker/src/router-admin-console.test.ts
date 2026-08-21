/**
 * admin console rendering and setup wizard contracts.
 *
 * One slice of the router's admin suite; shared fixtures live in
 * `./router-test-support`.
 */
import { ADMIN_UI_CLIENT_FRAGMENTS, ADMIN_UI_CLIENT_SCRIPT } from './admin-ui-client'
import { adminUiConfig, adminUiScript, bearer, routerFixture } from './router-test-support'
import { adminUiHarness } from './admin-ui-harness'
import { describe, expect, it } from 'vitest'
import { ADMIN_UI_WIZARD } from './admin-ui'

describe('admin console rendering and setup wizard contracts', () => {

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

})
