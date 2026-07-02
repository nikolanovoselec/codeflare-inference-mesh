import { describe, expect, it } from 'vitest'
import { desiredAgentVersion, handleAgentVersionSelect, handleAgentVersionsList } from './agent-versions'
import { hashToken } from './auth'
import { createRouter } from './router'
import { StoreScheduler } from './scheduler'
import { MemoryStore, nodeFixture } from './test-helpers'
import type { RouterEnv } from './types'

const CACHE_KEY = 'agent_versions_cache'
const DESIRED_KEY = 'desired_agent_version'
const EXPIRED_AGE_MS = 11 * 60_000
const emptyEnv = {} as RouterEnv

interface FetchCall {
  readonly url: string
  readonly userAgent: string | null
}

interface ListBody {
  readonly tags: string[]
  readonly fetchedAt?: number
  readonly stale: boolean
  readonly desired?: string
  readonly error?: string
}

interface StoredCache {
  readonly fetchedAt: number
  readonly tags: readonly string[]
}

function releasesFetcher(tags: readonly string[], calls: FetchCall[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    calls.push({ url: request.url, userAgent: request.headers.get('user-agent') })
    return Response.json(tags.map((tag) => ({ tag_name: tag })))
  }) as typeof fetch
}

function failingFetcher(calls: FetchCall[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    calls.push({ url: request.url, userAgent: request.headers.get('user-agent') })
    throw new Error('releases fetch unavailable')
  }) as typeof fetch
}

function rateLimitedFetcher(): typeof fetch {
  return (async () => new Response('rate limited', { status: 403 })) as typeof fetch
}

function listRequest(): Request {
  return new Request('https://router.test/admin/agent-versions')
}

function selectRequest(body: unknown): Request {
  return new Request('https://router.test/admin/agent-version', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
}

function warmCache(tags: readonly string[]): StoredCache {
  return { fetchedAt: Date.now(), tags }
}

function expiredCache(tags: readonly string[]): StoredCache {
  return { fetchedAt: Date.now() - EXPIRED_AGE_MS, tags }
}

describe('agent version management behavioral contracts', () => {
  it('REQ-ADM-008 lists release tags from the cached GitHub releases response', async () => {
    const store = new MemoryStore()
    const calls: FetchCall[] = []
    const before = Date.now()

    const response = await handleAgentVersionsList(listRequest(), store, emptyEnv, releasesFetcher(['v1.2.0', 'v1.1.0'], calls))
    const body = await response.json() as ListBody

    expect(response.status).toBe(200)
    expect(body.tags).toEqual(['v1.2.0', 'v1.1.0'])
    expect(body.stale).toBe(false)
    expect(body.fetchedAt).toBeGreaterThanOrEqual(before)
    expect(body.desired).toBeUndefined()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toContain('https://api.github.com/repos/nikolanovoselec/codeflare-inference-mesh/releases')
    expect(calls[0]?.userAgent).toBeTruthy()
    const cached = store.config.get(CACHE_KEY) as StoredCache
    expect(cached.tags).toEqual(['v1.2.0', 'v1.1.0'])
    expect(cached.fetchedAt).toBe(body.fetchedAt)
  })

  it('REQ-ADM-008 serves the warm cache without refetching inside the TTL', async () => {
    const store = new MemoryStore()
    const seeded = warmCache(['v1.1.0'])
    await store.putConfig(CACHE_KEY, seeded)
    const calls: FetchCall[] = []

    const response = await handleAgentVersionsList(listRequest(), store, emptyEnv, releasesFetcher(['v9.9.9'], calls))
    const body = await response.json() as ListBody

    expect(calls).toHaveLength(0)
    expect(body.tags).toEqual(['v1.1.0'])
    expect(body.fetchedAt).toBe(seeded.fetchedAt)
    expect(body.stale).toBe(false)
  })

  it('REQ-ADM-008 refetches the release list after the cache TTL expires', async () => {
    const store = new MemoryStore()
    await store.putConfig(CACHE_KEY, expiredCache(['v1.0.0']))
    const calls: FetchCall[] = []
    const env = { GITHUB_REPOSITORY: 'acme/mesh-agent' } as RouterEnv

    const response = await handleAgentVersionsList(listRequest(), store, env, releasesFetcher(['v1.1.0'], calls))
    const body = await response.json() as ListBody

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toContain('/repos/acme/mesh-agent/releases')
    expect(body.tags).toEqual(['v1.1.0'])
    expect(body.stale).toBe(false)
    expect((store.config.get(CACHE_KEY) as StoredCache).tags).toEqual(['v1.1.0'])
  })

  it('REQ-ADM-008 serves the stale cached tag list when the releases fetch fails', async () => {
    const store = new MemoryStore()
    const seeded = expiredCache(['v1.0.0'])
    await store.putConfig(CACHE_KEY, seeded)

    const response = await handleAgentVersionsList(listRequest(), store, emptyEnv, failingFetcher())
    const body = await response.json() as ListBody

    expect(response.status).toBe(200)
    expect(body.tags).toEqual(['v1.0.0'])
    expect(body.stale).toBe(true)
    expect(body.fetchedAt).toBe(seeded.fetchedAt)
    expect((store.config.get(CACHE_KEY) as StoredCache).fetchedAt).toBe(seeded.fetchedAt)
  })

  it('REQ-ADM-008 returns an empty error-marked list when the releases fetch fails with no cache', async () => {
    const store = new MemoryStore()

    const response = await handleAgentVersionsList(listRequest(), store, emptyEnv, rateLimitedFetcher())
    const body = await response.json() as ListBody

    expect(response.status).toBe(200)
    expect(body.tags).toEqual([])
    expect(body.stale).toBe(true)
    expect(body.error).toBe('releases_fetch_failed')
    expect(body.fetchedAt).toBeUndefined()
    expect(store.config.has(CACHE_KEY)).toBe(false)
  })

  it('REQ-ADM-008 stores the fleet-wide desired version and audits the selection', async () => {
    const store = new MemoryStore()
    await store.putConfig(CACHE_KEY, warmCache(['v1.2.0', 'v1.1.0']))
    const calls: FetchCall[] = []

    const response = await handleAgentVersionSelect(selectRequest({ version: 'v1.2.0' }), store, emptyEnv, releasesFetcher([], calls))

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, desired: 'v1.2.0' })
    expect(calls).toHaveLength(0)
    expect(store.config.get(DESIRED_KEY)).toBe('v1.2.0')
    const event = store.audit.find((item) => item.type === 'agent_version_selected')
    expect(event?.actor).toBe('admin')
    expect(event?.target).toBe('v1.2.0')
    expect(event?.detail).toEqual({ version: 'v1.2.0' })
    expect(await desiredAgentVersion(store)).toBe('v1.2.0')

    const list = await handleAgentVersionsList(listRequest(), store, emptyEnv, releasesFetcher([], calls))
    expect(((await list.json()) as ListBody).desired).toBe('v1.2.0')
  })

  it('REQ-ADM-008 rejects agent-version selections absent from the cached release list', async () => {
    const store = new MemoryStore()
    await store.putConfig(CACHE_KEY, warmCache(['v1.1.0']))
    const calls: FetchCall[] = []

    const unknown = await handleAgentVersionSelect(selectRequest({ version: 'v9.9.9' }), store, emptyEnv, releasesFetcher(['v1.1.0'], calls))
    const invalid = await handleAgentVersionSelect(selectRequest({}), store, emptyEnv, releasesFetcher(['v1.1.0'], calls))

    expect(unknown.status).toBe(400)
    expect(invalid.status).toBe(400)
    expect(calls).toHaveLength(0)
    expect(store.config.has(DESIRED_KEY)).toBe(false)
    expect(store.audit.some((event) => event.type === 'agent_version_selected')).toBe(false)
  })

  it('REQ-ADM-008 refreshes a stale cache before validating a selection', async () => {
    const store = new MemoryStore()
    await store.putConfig(CACHE_KEY, expiredCache(['v1.0.0']))
    const calls: FetchCall[] = []

    const response = await handleAgentVersionSelect(selectRequest({ version: 'v1.1.0' }), store, emptyEnv, releasesFetcher(['v1.1.0', 'v1.0.0'], calls))

    expect(response.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(store.config.get(DESIRED_KEY)).toBe('v1.1.0')
    expect((store.config.get(CACHE_KEY) as StoredCache).tags).toEqual(['v1.1.0', 'v1.0.0'])
  })

  it('REQ-ADM-008 round-trips the desired agent version through desiredAgentVersion', async () => {
    const store = new MemoryStore()
    expect(await desiredAgentVersion(store)).toBeUndefined()

    await store.putConfig(CACHE_KEY, warmCache(['v2.0.0']))
    await handleAgentVersionSelect(selectRequest({ version: 'v2.0.0' }), store, emptyEnv, failingFetcher())

    expect(await desiredAgentVersion(store)).toBe('v2.0.0')
  })

  it('REQ-ADM-008 heartbeat responses carry the desired agent version when set', async () => {
    const store = new MemoryStore()
    const router = createRouter({
      store,
      scheduler: new StoreScheduler(store, () => 'reservation-a'),
      mesh: { fetch: async () => new Response('{}', { status: 200 }) } as Fetcher,
      env: {}
    })
    await store.upsertNode({ ...nodeFixture(), nodeTokenVerifier: await hashToken('node-secret') })
    const heartbeat = () => router(new Request('https://router.test/node/heartbeat', {
      method: 'POST',
      headers: { authorization: 'Bearer node-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: 'node-a', displayName: 'Node A', meshIp: '100.64.1.10', inferencePort: 8080, localDashboardPort: 17777, status: 'online', publicModels: ['mesh-default'], activeProfileIds: ['mesh-default-qwen36-35b'], capacity: 2, inFlight: 0, runtime: 'meshllm', metrics: { runtimeState: 'ready', activeRequests: 0 } })
    }))

    const before = await (await heartbeat()).json() as { desiredAgentVersion?: string }
    expect(before.desiredAgentVersion).toBeUndefined()

    await store.putConfig(CACHE_KEY, warmCache(['v1.2.0']))
    await handleAgentVersionSelect(selectRequest({ version: 'v1.2.0' }), store, emptyEnv, rateLimitedFetcher())
    const after = await (await heartbeat()).json() as { ok: boolean; desiredAgentVersion?: string }

    expect(after.ok).toBe(true)
    expect(after.desiredAgentVersion).toBe('v1.2.0')
  })
})
