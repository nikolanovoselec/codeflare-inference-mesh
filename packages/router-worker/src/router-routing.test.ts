/**
 * router route, scheduling and gateway contracts.
 *
 * One slice of the router's behavioural suite; shared fixtures live in
 * `./router-test-support`.
 */
import { adminUiHarness } from './admin-ui-harness'
import { CloudflareGatewayClient } from './cloudflare-api'
import { createRouter, required, ROUTES } from './router'
import { createTokenRecord, hashToken, timingSafeEqualText } from './auth'
import { DEFAULT_MODEL_PROFILES, buildCustomProfile } from './profiles'
import { describe, expect, it } from 'vitest'
import { FAMILY_GATES, IDENTIFIES_CALLER_FROM_BODY, MESH_STATE_KEY_B64, QWEN_UPSTREAM, SMOKE_UPSTREAM, bearer, heartbeatBody, legacyRuntimeProfile, makeMesh, routeFamily, routerFixture, samplePath, seedLegacyDefaults } from './router-test-support'
import { isSafeMeshTarget, StoreScheduler } from './scheduler'
import { MemoryStore, nodeFixture } from './test-helpers'
import type { ModelProfile, NodeRecord } from './types'

describe('router route, scheduling and gateway contracts', () => {

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


  it('REQ-GWY-001 REQ-RTR-001 separates health, provider, node, and admin route families', async () => {
    // RouteFamilySeparationTestAnchor
    const { router } = routerFixture()

    expect((await router(new Request('https://router.test/health'))).status).toBe(200)
    expect((await router(new Request('https://router.test/v1/models'))).status).toBe(401)
    expect((await router(new Request('https://router.test/v1/models', { headers: bearer('provider-secret') }))).status).toBe(200)
    expect((await router(new Request('https://router.test/admin/status', { headers: bearer('provider-secret') }))).status).toBe(401)
    expect((await router(new Request('https://router.test/missing'))).status).toBe(404)
  })


  it('REQ-RTR-006 REQ-SEC-001 refuses every gated route without a credential and keeps each gate in its route family', async () => {
    // RouteGateMatrixTestAnchor
    const { router, store } = routerFixture()
    // /admin/setup is open only while the deployment is unclaimed; claim it so its gate applies.
    await store.putToken(await createTokenRecord('admin', 'admin-secret', 1_700_000_000_000))

    const misfiled: string[] = []
    const admitted: string[] = []
    const unguarded: string[] = []
    for (const route of ROUTES) {
      const pathname = samplePath(route.path)
      if (!FAMILY_GATES[routeFamily(pathname)].includes(route.gate)) {
        misfiled.push(`${route.method} ${pathname} declares ${route.gate}`)
      }
      const status = (await router(new Request(`https://router.test${pathname}`, { method: route.method }))).status
      if (route.gate === 'open') {
        if (status === 401) unguarded.push(`${route.method} ${pathname} is open but answered 401`)
        continue
      }
      // The security invariant: a gated route never serves an uncredentialed caller.
      if (status < 400) admitted.push(`${route.method} ${pathname} gate=${route.gate} answered ${status}`)
      // And it refuses with 401 specifically, unless it must read the body to identify the caller.
      if (status !== 401 && !IDENTIFIES_CALLER_FROM_BODY.has(pathname)) {
        unguarded.push(`${route.method} ${pathname} gate=${route.gate} answered ${status}`)
      }
    }

    expect(misfiled).toEqual([])
    expect(admitted).toEqual([])
    expect(unguarded).toEqual([])
    // Guards the sweep itself: an empty or truncated table would pass both checks vacuously.
    expect(ROUTES).toHaveLength(79)
    expect(new Set(ROUTES.map((route) => route.gate)).size).toBe(11)
  })


  it('REQ-RTR-006 REQ-SEC-001 admits a shared handler only through the credential its own route declares', async () => {
    // RouteGateEnforcementTestAnchor
    const { router, store } = routerFixture()
    await store.putToken(await createTokenRecord('admin', 'admin-secret', 1_700_000_000_000))
    await store.putToken(await createTokenRecord('automation', 'auto-secret', 1_700_000_000_000))

    // GET /admin/meshes and GET /api/v1/meshes are one function, meshListCore, reached by two
    // rows that differ only in their gate. Nothing inside it inspects the caller, so the only
    // thing separating these four outcomes is the dispatcher enforcing the declared gate.
    const consoleWithAdmin = await router(new Request('https://router.test/admin/meshes', { headers: bearer('admin-secret') }))
    const consoleWithAutomation = await router(new Request('https://router.test/admin/meshes', { headers: bearer('auto-secret') }))
    const apiWithAutomation = await router(new Request('https://router.test/api/v1/meshes', { headers: bearer('auto-secret') }))
    const apiWithAdmin = await router(new Request('https://router.test/api/v1/meshes', { headers: bearer('admin-secret') }))

    expect([consoleWithAdmin.status, apiWithAutomation.status]).toEqual([200, 200])
    expect([consoleWithAutomation.status, apiWithAdmin.status]).toEqual([401, 401])
    // Admitted through either door, the shared handler answers identically.
    expect(await consoleWithAdmin.json()).toEqual(await apiWithAutomation.json())
  })


  it('REQ-RTR-006 refuses a gate-provided value the route did not resolve rather than passing undefined', () => {
    // Verified directly: no row can reach this, because every gate a row declares resolves the
    // fields that row's handler reads. It exists for the edit that breaks that pairing, where
    // passing undefined through would spend nothing and look like success.
    expect(required('setup-token-1', 'credentialId', '/node/claim')).toBe('setup-token-1')
    expect(() => required(undefined, 'credentialId', '/node/claim')).toThrow('route /node/claim declares a gate that does not resolve credentialId')
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


  it('REQ-GWY-006 surfaces the Cloudflare error code and message on a failed API call', async () => {
    const fetcher = (async () => Response.json({ success: false, errors: [{ code: 2003, message: 'model id invalid' }] }, { status: 400 })) as unknown as typeof fetch
    const client = new CloudflareGatewayClient('runtime-token', fetcher)
    await expect(client.listGateways('account-a')).rejects.toThrow(/400.*2003.*model id invalid/)
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

})
