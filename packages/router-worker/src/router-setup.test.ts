/**
 * Access-first setup and host gating contracts.
 *
 * One slice of the router's behavioural suite; shared fixtures live in
 * `./router-test-support`.
 */
import { accessJwksFetcher, accessTestKey, MemoryStore, nodeFixture, signAccessJwt } from './test-helpers'
import { adminUiHarness, elementStub } from './admin-ui-harness'
import { createTokenRecord, hashToken } from './auth'
import { DEFAULT_MODEL_PROFILES, STABLE_PUBLIC_MODEL } from './profiles'
import { describe, expect, it } from 'vitest'
import type { LastSpeedTestSummary } from './types'
import { required, ROUTES } from './router'
import { resetJwksCache } from './access'
import { SMOKE_UPSTREAM, adminUiConfig, bearer, makeMesh, routerFixture, samplePath } from './router-test-support'

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
    expect(await store.getConfig<Record<string, LastSpeedTestSummary>>('last_speed_tests')).toBeUndefined()
  })


  it('REQ-ADM-034 REQ-SEC-010 measures a read-only viewer speed test without overwriting the stored summary', async () => {
    resetJwksCache()
    const key = await accessTestKey('key-1')
    const store = new MemoryStore()
    await store.putConfig('access_config', roleConfig({ adminGroups: ['admins'], userGroups: ['viewers'] }))
    await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)
    await store.upsertNode(nodeFixture())
    // Seeded so the assertion catches an overwrite, not merely the absence of a first write:
    // a handler that persisted only over an existing record would pass against undefined.
    const priorSummary = { at: 1_600_000_000_000, requestId: 'earlier', model: 'codeflare-mesh', requestedPromptTokens: 2048, requestedMaxTokens: 160, promptTokens: 2048, completionTokens: 80, promptTokensEstimated: false, completionTokensEstimated: false, promptTokensPerSecond: 1800.5, generationTokensPerSecond: 67.2, timeToFirstTokenMs: 900, generationMs: 1200, totalMs: 2100 }
    await store.putConfig('last_speed_tests', { 'mesh-smoke': priorSummary })
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}],"usage":{"prompt_tokens":8,"completion_tokens":1}}\n\n'))
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
        controller.close()
      }
    })
    const mesh = {
      fetch: async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
      connect() { throw new Error('connect is not used by speed-test forwarding') }
    } as Fetcher
    const { router } = routerFixture({ store, mesh, jwksFetcher: accessJwksFetcher([key.jwk]), identityFetcher: identityGroupsFetcher(['viewers']) })
    const jwt = await signAccessJwt(key, accessPayload({ email: 'viewer@example.com' }))

    const response = await router(new Request(`https://${HOST}/admin/playground/speed-test`, {
      method: 'POST',
      headers: { 'cf-access-jwt-assertion': jwt, origin: `https://${HOST}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'codeflare-mesh', promptTokens: 64, maxTokens: 16 })
    }))

    // The viewer gets its own measurement back...
    expect(response.status).toBe(200)
    expect((await response.json() as { tokens: { completion: number } }).tokens.completion).toBe(1)
    // ...but the shared per-profile record every mesh card reads is structurally unchanged.
    // An admin run of the same route does persist, asserted by the measurement test.
    expect(await store.getConfig<Record<string, LastSpeedTestSummary>>('last_speed_tests')).toEqual({ 'mesh-smoke': priorSummary })
  })


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


  it('REQ-RTR-006 REQ-SEC-010 refuses every admin-gated route to a verified read-only user', async () => {
    // The uncredentialed sweep cannot catch under-gating: a route declared `admin` whose
    // handler only calls requireUser answers 401 without a credential and passes. This
    // drives the case that separates them, a verified user-role session with same-origin
    // evidence so the CSRF gate is not what refuses it.
    const { router, key } = await roleRouter(roleConfig({ adminGroups: ['admins'], userGroups: ['viewers'] }), ['viewers'])
    const jwt = await signAccessJwt(key, accessPayload({ email: 'viewer@example.com' }))
    const headers = { 'cf-access-jwt-assertion': jwt, origin: `https://${HOST}` }

    const served: string[] = []
    for (const route of ROUTES) {
      if (route.gate !== 'admin' && route.gate !== 'keyAdmin') continue
      const pathname = samplePath(route.path)
      const response = await router(new Request(`https://${HOST}${pathname}`, { method: route.method, headers }))
      // Require the refusal to be the gate's. Accepting any 4xx would let a route that 404s
      // on the synthesized id, or 400s on a missing body, pass without ever authorizing.
      if (![401, 403].includes(response.status)) served.push(`${route.method} ${pathname} gate=${route.gate} answered ${response.status}`)
    }

    expect(served).toEqual([])
    // Non-vacuity guard: an empty or filtered-away table would satisfy the loop above.
    // Update this count when routes are added; do not delete it.
    expect(ROUTES.filter((route) => route.gate === 'admin' || route.gate === 'keyAdmin')).toHaveLength(34)
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
    const stored = await store.getConfig<Record<string, LastSpeedTestSummary>>('last_speed_tests')

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
    // The run is stored keyed by the resolved profile id — duplicated profiles share
    // an upstreamModel, so the id is the only key that keeps each mesh card's
    // measurement its own.
    expect(stored?.['mesh-smoke-qwen25-1.5b']).toMatchObject({ requestId: 'request-a', model: 'codeflare-mesh', nodeId: 'node-a', promptTokens: 256, completionTokens: 2, promptTokensPerSecond: 2000, generationTokensPerSecond: 100, cacheTokens: 0 })
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
    const statusBody = await status.json() as { lastSpeedTest?: LastSpeedTestSummary; lastSpeedTests?: Record<string, LastSpeedTestSummary> }

    expect(unauthorized.status).toBe(401)
    expect(response.status).toBe(200)
    expect(status.status).toBe(200)
    expect(measured.tokens).toMatchObject({ prompt: 64, completion: 1 })
    expect(measured.throughput.promptTokensPerSecond).toBeGreaterThan(0)
    expect(measured.throughput.generationTokensPerSecond).toBeGreaterThan(0)
    expect(statusBody.lastSpeedTest).toMatchObject({ requestId: 'request-a', model: 'codeflare-mesh', nodeId: 'node-a', promptTokens: 64, completionTokens: 1 })
    expect(statusBody.lastSpeedTests?.['mesh-smoke-qwen25-1.5b']).toMatchObject({ requestId: 'request-a', model: 'codeflare-mesh' })
  })


  it('REQ-API-009 surfaces a pre-map stored speed test as the seed map entry', async () => {
    const { router, store } = routerFixture({})
    await store.putToken(await createTokenRecord('automation', 'auto-secret', 1_700_000_000_000))
    const legacy: LastSpeedTestSummary = { at: 5, requestId: 'request-legacy', model: 'codeflare-mesh', requestedPromptTokens: 64, requestedMaxTokens: 16, promptTokens: 64, completionTokens: 1, promptTokensEstimated: false, completionTokensEstimated: false, promptTokensPerSecond: 2000, generationTokensPerSecond: 100, timeToFirstTokenMs: 10, generationMs: 10, totalMs: 20 }
    await store.putConfig('last_speed_test', legacy)

    const status = await router(new Request('https://router.test/api/v1/status', { headers: bearer('auto-secret') }))
    const statusBody = await status.json() as { lastSpeedTest?: LastSpeedTestSummary; lastSpeedTests?: Record<string, LastSpeedTestSummary> }

    expect(status.status).toBe(200)
    // The pre-map record surfaces in the map (keyed by its resolved profile id, or the
    // model string when no profile resolves) and as the newest lastSpeedTest.
    expect(Object.values(statusBody.lastSpeedTests ?? {}).some((entry) => entry.requestId === 'request-legacy')).toBe(true)
    expect(statusBody.lastSpeedTest).toMatchObject({ requestId: 'request-legacy' })
  })


  it('REQ-API-009 keys a pre-map speed test by the resolved profile id so the mesh card finds it', async () => {
    const { router, store } = routerFixture({})
    await store.putToken(await createTokenRecord('automation', 'auto-secret', 1_700_000_000_000))
    // With a profile resolvable for the record's model, the seed entry must key by the
    // profile id the per-mesh card looks up — not the model string (regression lock).
    await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)
    const profile = await store.getProfileByPublicModel(STABLE_PUBLIC_MODEL)
    const legacy: LastSpeedTestSummary = { at: 5, requestId: 'request-legacy', model: STABLE_PUBLIC_MODEL, requestedPromptTokens: 64, requestedMaxTokens: 16, promptTokens: 64, completionTokens: 1, promptTokensEstimated: false, completionTokensEstimated: false, promptTokensPerSecond: 2000, generationTokensPerSecond: 100, timeToFirstTokenMs: 10, generationMs: 10, totalMs: 20 }
    await store.putConfig('last_speed_test', legacy)

    const status = await router(new Request('https://router.test/api/v1/status', { headers: bearer('auto-secret') }))
    const statusBody = await status.json() as { lastSpeedTests?: Record<string, LastSpeedTestSummary> }

    expect(status.status).toBe(200)
    expect(profile).toBeDefined()
    expect(statusBody.lastSpeedTests?.[profile!.id]).toMatchObject({ requestId: 'request-legacy' })
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
