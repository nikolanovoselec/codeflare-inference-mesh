import { describe, expect, it } from 'vitest'
import { hashToken } from './auth'
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

describe('router worker behavioral contracts', () => {
  it('REQ-GWY-001 REQ-RTR-001 separates health, provider, node, and admin route families', async () => {
    const { router } = routerFixture()

    expect((await router(new Request('https://router.test/health'))).status).toBe(200)
    expect((await router(new Request('https://router.test/v1/models'))).status).toBe(401)
    expect((await router(new Request('https://router.test/v1/models', { headers: bearer('provider-secret') }))).status).toBe(200)
    expect((await router(new Request('https://router.test/admin/status', { headers: bearer('provider-secret') }))).status).toBe(401)
    expect((await router(new Request('https://router.test/missing'))).status).toBe(404)
  })

  it('REQ-GWY-002 REQ-SEC-002 generates distinct bearer tokens and stores only verifiers', async () => {
    const { router, store } = routerFixture()
    const response = await router(new Request('https://router.test/admin/setup', { method: 'POST' }))
    const body = await response.json() as Record<string, string>

    expect(response.status).toBe(201)
    expect(new Set([body.adminToken, body.providerToken, body.setupToken, body.upstreamToken]).size).toBe(4)
    expect(store.tokens.every((token) => token.verifier.startsWith('sha256:'))).toBe(true)
    const returnedValues = new Set(Object.values(body))
    expect(store.tokens.some((token) => returnedValues.has(token.verifier))).toBe(false)
  })

  it('REQ-GWY-004 REQ-SEC-001 prevents credential classes from crossing route families', async () => {
    const { router } = routerFixture()
    expect((await router(new Request('https://router.test/node/heartbeat', { method: 'POST', headers: bearer('provider-secret'), body: JSON.stringify({ nodeId: 'node-a' }) }))).status).toBe(404)
    expect((await router(new Request('https://router.test/v1/models', { headers: bearer('admin-secret') }))).status).toBe(401)
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

  it('REQ-SCH-003 returns busy when no eligible node has capacity', async () => {
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
    const { router, store } = routerFixture()
    const setupResponse = await router(new Request('https://router.test/admin/setup', { method: 'POST' }))
    const setup = await setupResponse.json() as { setupToken: string }
    const claim = await router(new Request('https://router.test/node/claim', {
      method: 'POST',
      headers: { ...bearer(setup.setupToken), 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Node A', meshIp: '100.64.1.10', inferencePort: 8080, publicModels: ['mesh-default'], activeProfileIds: ['qwen36-27b-256k-3090'], capacity: 2 })
    }))

    expect(claim.status).toBe(201)
    expect(store.tokens.filter((token) => token.kind === 'setup').every((token) => token.active === false)).toBe(true)
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

  it('REQ-ADM-002 REQ-OBS-002 returns redacted machine-readable admin status', async () => {
    const { router, store } = routerFixture()
    await store.upsertNode({ ...nodeFixture(), upstreamTokenVerifier: 'sha256:hidden' })

    const response = await router(new Request('https://router.test/admin/status', { headers: bearer('admin-secret') }))
    const body = await response.json() as Record<string, unknown>

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ generatedAt: 1_700_000_000_000 })
    expect(new Set(valuesOf(body)).has('sha256:hidden')).toBe(false)
  })

  it('REQ-ADM-004 returns one-line installer commands with a fresh setup token', async () => {
    const { router, store } = routerFixture()
    const response = await router(new Request('https://router.test/admin/installers/linux', { headers: bearer('admin-secret') }))
    const command = await response.text()

    const download = new URL(command.split(/\s+/).find((part) => part.startsWith('https://'))!)

    expect(response.status).toBe(200)
    expect(download.pathname.endsWith('/inference-mesh-agent-linux-amd64.tar.gz')).toBe(true)
    expect(store.tokens.filter((token) => token.kind === 'setup' && token.active).length).toBe(1)
  })

  it('REQ-GWY-003 automates provider, route, version, and deployment creation while leaving BYOK manual', async () => {
    const calls: string[] = []
    const { router } = routerFixture({
      env: { CLOUDFLARE_ACCOUNT_ID: 'account-a', CLOUDFLARE_API_TOKEN_RUNTIME: 'runtime-token', AI_GATEWAY_ID: 'gateway-a', WORKER_BASE_URL: 'https://router.example.workers.dev' },
      cloudflareClient: {
        async syncCustomProvider(input) {
          calls.push(input.accountId, input.gatewayId, input.workerUrl)
          return { providerId: 'provider-a', routeId: 'route-a', routeVersionId: 'version-a', deploymentId: 'deployment-a', manualProviderKeyRequired: true, providerTokenInstructions: input.providerTokenInstructions }
        }
      }
    })

    const response = await router(new Request('https://router.test/admin/cloudflare/gateway/sync', { method: 'POST', headers: bearer('admin-secret') }))
    const body = await response.json() as { manualProviderKeyRequired: boolean; deploymentId: string }

    expect(response.status).toBe(200)
    expect(calls).toEqual(['account-a', 'gateway-a', 'https://router.example.workers.dev'])
    expect(body).toMatchObject({ deploymentId: 'deployment-a', manualProviderKeyRequired: true })
  })

  it('REQ-ADM-005 validates optional custom-domain hostnames before accepting them', async () => {
    const { router } = routerFixture()
    const good = await router(new Request('https://router.test/admin/custom-domain/validate', { method: 'POST', headers: { ...bearer('admin-secret'), 'content-type': 'application/json' }, body: JSON.stringify({ hostname: 'ai.example.com' }) }))
    const bad = await router(new Request('https://router.test/admin/custom-domain/validate', { method: 'POST', headers: { ...bearer('admin-secret'), 'content-type': 'application/json' }, body: JSON.stringify({ hostname: 'http://bad' }) }))

    expect(good.status).toBe(200)
    expect(bad.status).toBe(400)
  })

  it('REQ-SEC-003 strips client authorization and Cloudflare headers before Worker-to-node forwarding', async () => {
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
