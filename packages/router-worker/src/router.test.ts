import { describe, expect, it } from 'vitest'
import { ADMIN_UI_ACTIONS, ADMIN_UI_OPERATOR_FLOW, ADMIN_UI_RESPONSIVE } from './admin-ui'
import { createTokenRecord, hashToken, timingSafeEqualText } from './auth'
import { CloudflareGatewayClient } from './cloudflare-api'
import { installerPlan } from './installers'
import { DEFAULT_MODEL_PROFILES } from './profiles'
import { createRouter } from './router'
import { isSafeMeshTarget, StoreScheduler } from './scheduler'
import { MemoryStore, nodeFixture } from './test-helpers'
import type { Scheduler } from './types'

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
      ...(overrides.cloudflareClient !== undefined ? { cloudflareClient: overrides.cloudflareClient } : {})
    })
  }
}

function bearer(token: string): HeadersInit {
  return { authorization: `Bearer ${token}` }
}

function valuesOf(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(valuesOf)
  if (value && typeof value === 'object') return Object.values(value).flatMap(valuesOf)
  return []
}

function adminUiConfig(html: string): { actions: typeof ADMIN_UI_ACTIONS; responsive: typeof ADMIN_UI_RESPONSIVE; operatorFlow: typeof ADMIN_UI_OPERATOR_FLOW; workerOrigin: string } {
  const match = html.match(/<script type="application\/json" id="admin-ui-config">([^<]+)<\/script>/)
  expect(match).not.toBeNull()
  expect(match![1]).not.toContain('&quot;')
  return JSON.parse(match![1]!) as { actions: typeof ADMIN_UI_ACTIONS; responsive: typeof ADMIN_UI_RESPONSIVE; operatorFlow: typeof ADMIN_UI_OPERATOR_FLOW; workerOrigin: string }
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
    const html = await admin.text()
    const config = adminUiConfig(html)
    const actionIds = config.actions.map((action) => action.id)

    expect(root.status).toBe(200)
    expect(admin.status).toBe(200)
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
      'profile-rollout'
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
      '/admin/profiles/rollout'
    ])
    expect(config.responsive).toEqual({ mobileBreakpointPx: 760, desktopMinColumns: 1, minTouchTargetPx: 44 })
    expect(config.operatorFlow).toEqual({
      stages: ['setup/authentication', 'enrollment/installers', 'Gateway/domain routing', 'status/node/profile operations'],
      panelOrder: ['setup', 'login', 'setup-token', 'installer', 'gateway', 'domain', 'status', 'node', 'profile']
    })
    const controls = [...html.matchAll(/data-action="([^"]+)"/g)].map((match) => match[1])
    const idlePanels = [...html.matchAll(/data-state="idle"/g)]
    const outputSurfaces = [...html.matchAll(/data-empty="[^"]+"/g)]
    const operatorPanels = [...html.matchAll(/<div class="panel[^"]*" id="([^"]+)"[^>]*data-step="([1-9])"/g)].map((match) => ({ id: match[1], step: Number(match[2]) }))
    expect(controls).toEqual(expect.arrayContaining(['first-run-setup', 'admin-login', 'status-refresh', 'setup-token-create', 'installer-generate', 'gateway-sync', 'custom-domain-validate', 'node-revoke', 'profile-rollout']))
    expect(idlePanels).toHaveLength(9)
    expect(outputSurfaces).toHaveLength(8)
    expect(operatorPanels).toEqual([
      { id: 'setup', step: 1 },
      { id: 'login', step: 2 },
      { id: 'setup-token', step: 3 },
      { id: 'installer', step: 4 },
      { id: 'gateway', step: 5 },
      { id: 'domain', step: 6 },
      { id: 'status', step: 7 },
      { id: 'node', step: 8 },
      { id: 'profile', step: 9 }
    ])
    expect(html).toMatch(/data-responsive="desktop mobile"/)
    expect(html).toMatch(/data-layout="operator-sequence"/)
    expect(html).toMatch(/data-density="wide"/)
    expect(html).toMatch(/data-panel-order="setup login setup-token installer gateway domain status node profile"/)
    expect(html).toMatch(/class="live-badge"/)
    expect(html).toMatch(/\.status-dot\{display:inline-block/)
    expect(html).toMatch(/#origin-label\{[^}]*white-space:normal;overflow-wrap:anywhere/)
    expect(html).toMatch(/@media \(max-width:760px\)/)
    expect(html).toContain('sessionStorage.getItem(tokenKey)')
    expect(html).toContain('localStorage.getItem(tokenKey)')
    expect(() => new Function(adminUiScript(html))).not.toThrow()
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
    expect(body.data.map((model) => model.id)).toEqual(expect.arrayContaining(['mesh-default', 'gemma4-26b-a4b', 'mesh-smoke']))
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
    expect(forwarded.model).toBe('qwen36-27b-256k-3090')
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
    await router(new Request('https://router.test/node/claim', {
      method: 'POST',
      headers: { ...bearer(setup.setupToken), 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Node A', meshIp: '100.64.1.10', inferencePort: 8080, publicModels: ['mesh-default'], activeProfileIds: ['qwen36-27b-256k-3090'], capacity: 1 })
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

    expect(response.status).toBe(500)
    expect([...store.reservations.values()][0]?.releasedAt).toBe(1_700_000_000_000)
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
      body: JSON.stringify({ model: 'mesh-default', stream: true, messages: [] })
    }))

    expect(response.headers.get('content-type')?.split(';')[0]).toBe('text/event-stream')
    expect(await response.text()).toBe('data: one\n\ndata: two\n\n')
  })

  it('REQ-RTR-004 accepts only private Mesh IP destinations and rejects full upstream URLs', () => {
    expect(isSafeMeshTarget('100.64.1.10', 8080)).toBe(true)
    expect(isSafeMeshTarget('10.0.0.5', 8080)).toBe(true)
    expect(isSafeMeshTarget('https://evil.example', 443)).toBe(false)
    expect(isSafeMeshTarget('8.8.8.8', 8080)).toBe(false)
  })

  it('REQ-SCH-003 returns no-node when no eligible node has capacity', async () => {
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

  it('REQ-SCH-003 returns no-profile when the public model has no configured profile', async () => {
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

  it('REQ-SCH-004 preserves session affinity when the sticky node remains eligible', async () => {
    const store = new MemoryStore()
    await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)
    await store.upsertNode(nodeFixture({ id: 'node-a', inFlight: 0 }))
    await store.upsertNode(nodeFixture({ id: 'node-b', displayName: 'Node B', meshIp: '100.64.1.11', inFlight: 0 }))
    await store.putSession({ sessionId: 'session-a', nodeId: 'node-b', publicModel: 'mesh-default', profileId: 'qwen36-27b-256k-3090', upstreamModel: 'qwen36-27b-256k-3090', expiresAt: 1_700_000_100_000 })
    const scheduler = new StoreScheduler(store, () => 'reservation-b')

    const result = await scheduler.reserve({ publicModel: 'mesh-default', sessionId: 'session-a', now: 1_700_000_000_000 })

    expect(result.reservation?.nodeId).toBe('node-b')
  })

  it('REQ-ADM-001 REQ-ADM-003 consumes setup tokens during node claim', async () => {
    // FirstRunSetupTokenTestAnchor
    const { router, store } = routerFixture()
    const expiredRecord = await createTokenRecord('setup', 'expired-setup', 1_699_913_599_999, undefined, 1_700_000_000_000)
    await store.putToken(expiredRecord)
    const expired = await router(new Request('https://router.test/node/claim', {
      method: 'POST',
      headers: { ...bearer('expired-setup'), 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Expired Node', meshIp: '100.64.1.9', inferencePort: 8080, publicModels: ['mesh-default'], activeProfileIds: ['qwen36-27b-256k-3090'], capacity: 1 })
    }))
    const setupResponse = await router(new Request('https://router.test/admin/setup', { method: 'POST' }))
    const setup = await setupResponse.json() as { setupToken: string }
    const claim = await router(new Request('https://router.test/node/claim', {
      method: 'POST',
      headers: { ...bearer(setup.setupToken), 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Node A', meshIp: '100.64.1.10', inferencePort: 8080, publicModels: ['mesh-default'], activeProfileIds: ['qwen36-27b-256k-3090'], capacity: 2 })
    }))
    const consumed = await router(new Request('https://router.test/node/claim', {
      method: 'POST',
      headers: { ...bearer(setup.setupToken), 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Node B', meshIp: '100.64.1.11', inferencePort: 8080, publicModels: ['mesh-default'], activeProfileIds: ['qwen36-27b-256k-3090'], capacity: 2 })
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
      body: JSON.stringify({ nodeId: 'node-a', displayName: 'Node A', meshIp: '100.64.1.10', inferencePort: 8080, localDashboardPort: 17777, status: 'online', publicModels: ['mesh-default'], activeProfileIds: ['qwen36-27b-256k-3090'], capacity: 2, inFlight: 1, runtime: 'llama.cpp', runtimeModel: 'qwen36-27b-256k-3090', metrics: { runtimeState: 'ready', loadedModel: 'qwen36-27b-256k-3090', activeRequests: 1, gpuName: 'RTX 3090' } })
    }))

    expect(response.status).toBe(200)
    expect((await store.getNode('node-a'))?.metrics?.gpuName).toBe('RTX 3090')
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
      body: JSON.stringify({ nodeId: 'node-a', displayName: 'Node A', meshIp: '100.64.1.10', inferencePort: 8080, localDashboardPort: 17777, status: 'online', publicModels: ['mesh-default'], activeProfileIds: ['qwen36-27b-256k-3090'], capacity: 2, inFlight: 0, runtime: 'llama.cpp', metrics: { runtimeState: 'ready', activeRequests: 0 } })
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

  it('REQ-OBS-004 records audit events for setup, claim, unregister, revoke, route provisioning, and profile switch actions', async () => {
    const { router, store } = routerFixture({
      env: { CLOUDFLARE_ACCOUNT_ID: 'account-a', CLOUDFLARE_API_TOKEN_RUNTIME: 'runtime-token', AI_GATEWAY_ID: 'gateway-a', WORKER_BASE_URL: 'https://router.example.workers.dev' },
      cloudflareClient: {
        async syncCustomProvider() {
          return { providerId: 'provider-a', routeId: 'route-a', routeVersionId: 'version-a', deploymentId: 'deployment-a', manualProviderKeyRequired: true, providerTokenInstructions: 'manual' }
        }
      }
    })

    const setupResponse = await router(new Request('https://router.test/admin/setup', { method: 'POST' }))
    const setup = await setupResponse.json() as { setupToken: string }
    const claim = await router(new Request('https://router.test/node/claim', {
      method: 'POST',
      headers: { ...bearer(setup.setupToken), 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Node A', meshIp: '100.64.1.10', inferencePort: 8080, publicModels: ['mesh-default'], activeProfileIds: ['qwen36-27b-256k-3090'], capacity: 2 })
    }))
    const claimed = await claim.json() as { nodeId: string; nodeToken: string }

    await router(new Request('https://router.test/node/unregister', { method: 'POST', headers: { ...bearer(claimed.nodeToken), 'content-type': 'application/json' }, body: JSON.stringify({ nodeId: claimed.nodeId }) }))
    await router(new Request(`https://router.test/admin/nodes/${claimed.nodeId}/revoke`, { method: 'POST', headers: bearer('admin-secret') }))
    await router(new Request('https://router.test/admin/cloudflare/gateway/sync', { method: 'POST', headers: bearer('admin-secret') }))
    await router(new Request('https://router.test/admin/profiles/rollout', { method: 'POST', headers: { ...bearer('admin-secret'), 'content-type': 'application/json' }, body: JSON.stringify({ profileId: 'qwen36-27b-256k-3090', rolloutPercent: 50 }) }))

    expect(store.audit.map((event) => event.type)).toEqual(expect.arrayContaining(['first_setup', 'node_claimed', 'node_unregistered', 'node_revoked', 'gateway_sync', 'profile_rollout']))
  })

  it('REQ-SCH-002 REQ-NODE-002 keeps scheduler reservation counts authoritative over heartbeats', async () => {
    const { router, store } = routerFixture()
    await store.upsertNode({ ...nodeFixture({ capacity: 1, inFlight: 0 }), nodeTokenVerifier: await hashToken('node-secret') })

    const staleHigh = await router(new Request('https://router.test/node/heartbeat', {
      method: 'POST',
      headers: { ...bearer('node-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: 'node-a', displayName: 'Node A', meshIp: '100.64.1.10', inferencePort: 8080, localDashboardPort: 17777, status: 'online', publicModels: ['mesh-default'], activeProfileIds: ['qwen36-27b-256k-3090'], capacity: 1, inFlight: 1, runtime: 'llama.cpp', metrics: { runtimeState: 'ready', activeRequests: 1 } })
    }))
    const afterStaleHigh = await store.getNode('node-a')
    await store.upsertNode({ ...afterStaleHigh!, inFlight: 1 })

    const staleZero = await router(new Request('https://router.test/node/heartbeat', {
      method: 'POST',
      headers: { ...bearer('node-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: 'node-a', displayName: 'Node A', meshIp: '100.64.1.10', inferencePort: 8080, localDashboardPort: 17777, status: 'online', publicModels: ['mesh-default'], activeProfileIds: ['qwen36-27b-256k-3090'], capacity: 1, inFlight: 0, runtime: 'llama.cpp', metrics: { runtimeState: 'ready', activeRequests: 0 } })
    }))
    const afterStaleZero = await store.getNode('node-a')

    expect(staleHigh.status).toBe(200)
    expect(afterStaleHigh?.inFlight).toBe(0)
    expect(afterStaleHigh?.metrics?.activeRequests).toBe(1)
    expect(staleZero.status).toBe(200)
    expect(afterStaleZero?.inFlight).toBe(1)
    expect(afterStaleZero?.metrics?.activeRequests).toBe(0)
  })

  it('REQ-ADM-002 REQ-OBS-002 returns redacted machine-readable admin status', async () => {
    // AdminStatusRedactionTestAnchor
    const { router, store } = routerFixture()
    await store.upsertNode({ ...nodeFixture(), upstreamTokenVerifier: 'sha256:hidden' })

    const response = await router(new Request('https://router.test/admin/status', { headers: bearer('admin-secret') }))
    const body = await response.json() as Record<string, unknown>

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ generatedAt: 1_700_000_000_000 })
    expect(new Set(valuesOf(body)).has('sha256:hidden')).toBe(false)
  })

  it('REQ-ADM-004 returns installer commands backed by release-tagged platform artifact plans', async () => {
    const { router, store } = routerFixture({ env: { AGENT_RELEASE_TAG: 'v0.1.0-dev.1782860991' } })
    const commandResponse = await router(new Request('https://router.test/admin/installers/linux', { headers: bearer('admin-secret') }))
    const command = await commandResponse.text()
    const scriptUrl = new URL(command.split(/\s+/).find((part) => part.startsWith('https://'))!)
    const scriptResponse = await router(new Request('https://router.test/install.sh?platform=linux'))
    const script = await scriptResponse.text()
    const fallbackScript = await (await routerFixture().router(new Request('https://router.test/install.sh?platform=linux'))).text()
    const linuxPlan = installerPlan('linux', 'amd64')
    const windowsPlan = installerPlan('windows', 'amd64')

    expect(commandResponse.status).toBe(200)
    expect(scriptUrl.pathname).toBe('/install.sh')
    expect(scriptUrl.searchParams.get('platform')).toBe('linux')
    expect(script).toContain('https://github.com/nikolanovoselec/codeflare-inference-mesh/releases/download/v0.1.0-dev.1782860991')
    expect(fallbackScript).toContain('https://github.com/nikolanovoselec/codeflare-inference-mesh/releases/latest/download')
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
          calls.push(input.accountId, input.gatewayId, input.workerUrl)
          return { providerId: 'provider-a', routeId: 'route-a', routeVersionId: 'version-a', deploymentId: 'deployment-a', manualProviderKeyRequired: true, providerTokenInstructions: input.providerTokenInstructions }
        }
      }
    })

    await store.putConfig('custom_domain', { hostname: 'ai.example.com', zoneId: '0123456789abcdef0123456789abcdef' })

    const response = await router(new Request('https://router.test/admin/cloudflare/gateway/sync', { method: 'POST', headers: bearer('admin-secret') }))
    const body = await response.json() as { manualProviderKeyRequired: boolean; deploymentId: string }

    expect(response.status).toBe(200)
    expect(calls).toEqual(['account-a', 'gateway-a', 'https://ai.example.com'])
    expect(body).toMatchObject({ deploymentId: 'deployment-a', manualProviderKeyRequired: true })
  })

  it('REQ-GWY-003 uses Cloudflare custom-provider and dynamic-route payload contracts', async () => {
    const calls: Array<{ path: string; body: Record<string, unknown> }> = []
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      calls.push({ path: url.pathname, body })
      if (url.pathname.endsWith('/custom-providers')) return Response.json({ success: true, result: { id: 'provider-a', slug: 'codeflare-inference-mesh' } })
      if (url.pathname.endsWith('/routes')) return Response.json({ success: true, result: { id: 'route-a' } })
      if (url.pathname.endsWith('/versions')) return Response.json({ success: true, result: { id: 'version-a' } })
      return Response.json({ success: true, result: { id: 'deployment-a' } })
    }) as typeof fetch
    const client = new CloudflareGatewayClient('runtime-token', fetcher)

    const result = await client.syncCustomProvider({ accountId: 'account-a', gatewayId: 'gateway-a', workerUrl: 'https://router.example.workers.dev/v1/chat/completions', providerName: 'Codeflare Inference Mesh', routeName: 'mesh-default', providerTokenInstructions: 'manual' })
    const versionBody = calls[2]!.body as { elements: Array<{ type: string; properties?: Record<string, unknown> }> }
    const modelNode = versionBody.elements.find((element) => element.type === 'model')!

    expect(calls.map((call) => call.path)).toEqual([
      '/client/v4/accounts/account-a/ai-gateway/custom-providers',
      '/client/v4/accounts/account-a/ai-gateway/gateways/gateway-a/routes',
      '/client/v4/accounts/account-a/ai-gateway/gateways/gateway-a/routes/route-a/versions',
      '/client/v4/accounts/account-a/ai-gateway/gateways/gateway-a/routes/route-a/deployments'
    ])
    expect(calls[0]!.body).toEqual({ name: 'Codeflare Inference Mesh', slug: 'codeflare-inference-mesh', base_url: 'https://router.example.workers.dev', description: 'Codeflare Inference Mesh OpenAI-compatible router', enable: true })
    expect(modelNode.properties).toEqual({ provider: 'custom-codeflare-inference-mesh', model: 'mesh-default', retries: 1, timeout: 120000 })
    expect(result).toEqual({ providerId: 'provider-a', routeId: 'route-a', routeVersionId: 'version-a', deploymentId: 'deployment-a', manualProviderKeyRequired: true, providerTokenInstructions: 'manual' })
  })

  it('REQ-ADM-005 validates and stores optional custom-domain hostnames before accepting them', async () => {
    const { router, store } = routerFixture()
    const zoneId = '0123456789abcdef0123456789abcdef'
    const good = await router(new Request('https://router.test/admin/custom-domain/validate', { method: 'POST', headers: { ...bearer('admin-secret'), 'content-type': 'application/json' }, body: JSON.stringify({ hostname: 'ai.example.com', zoneId }) }))
    const bad = await router(new Request('https://router.test/admin/custom-domain/validate', { method: 'POST', headers: { ...bearer('admin-secret'), 'content-type': 'application/json' }, body: JSON.stringify({ hostname: 'http://bad', zoneId }) }))
    const badZone = await router(new Request('https://router.test/admin/custom-domain/validate', { method: 'POST', headers: { ...bearer('admin-secret'), 'content-type': 'application/json' }, body: JSON.stringify({ hostname: 'ai.example.com', zoneId: 'not-a-zone' }) }))

    expect(good.status).toBe(200)
    expect(await store.getConfig('custom_domain')).toEqual({ hostname: 'ai.example.com', zoneId })
    expect(store.audit.some((event) => event.type === 'custom_domain_validated' && event.target === 'ai.example.com')).toBe(true)
    expect(bad.status).toBe(400)
    expect(badZone.status).toBe(400)
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
      body: JSON.stringify({ profileId: 'gemma4-26b-a4b-256k-3090', rolloutPercent: 25 })
    }))
    const profile = (await store.listProfiles()).find((item) => item.id === 'gemma4-26b-a4b-256k-3090')!

    expect(response.status).toBe(200)
    expect(profile.rolloutPercent).toBe(25)
    expect(profile.version).toBe(2)
  })
})
