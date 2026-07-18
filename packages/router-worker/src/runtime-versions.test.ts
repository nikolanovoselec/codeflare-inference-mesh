import { describe, expect, it } from 'vitest'
import { createTokenRecord, hashToken } from './auth'
import { createRouter } from './router'
import { StoreScheduler } from './scheduler'
import { MemoryStore, nodeFixture } from './test-helpers'
import { activeMeshllmRepository, DEFAULT_LLAMACPP_VERSION, DEFAULT_MESHLLM_VERSION, desiredRuntimeVersions, handleRuntimeVersionsList, handleRuntimeVersionsSelect } from './runtime-versions'

interface RuntimeVersionsBody {
  readonly meshllm: { readonly tags: readonly string[]; readonly desired: string; readonly stale: boolean }
  readonly llamacpp: { readonly tags: readonly string[]; readonly desired: string; readonly stale: boolean }
}

function releasesFetcher(tags: readonly string[]): typeof fetch {
  return (async () => Response.json(tags.map((tag) => ({ tag_name: tag })))) as typeof fetch
}

function selectRequest(body: unknown): Request {
  return new Request('https://router.test/admin/runtime-versions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

describe('runtime binary version management', () => {
  it('REQ-ADM-033 lists MeshLLM and llama.cpp release tags with defaults selected', async () => {
    const store = new MemoryStore()
    const response = await handleRuntimeVersionsList(new Request('https://router.test/admin/runtime-versions'), store, releasesFetcher(['v0.73.0', 'b9912']))
    const body = await response.json() as RuntimeVersionsBody

    expect(response.status).toBe(200)
    expect(body.meshllm.tags).toContain('v0.73.0')
    expect(body.llamacpp.tags).toContain('b9912')
    expect(body.meshllm.desired).toBe(DEFAULT_MESHLLM_VERSION)
    expect(body.llamacpp.desired).toBe(DEFAULT_LLAMACPP_VERSION)
    expect(body.meshllm.stale).toBe(false)
    expect(body.llamacpp.stale).toBe(false)
  })

  it('REQ-ADM-033 stores selected runtime versions and audits the operator action', async () => {
    const store = new MemoryStore()
    await store.putConfig('meshllm_versions_cache', { fetchedAt: Date.now(), tags: ['v0.73.0', DEFAULT_MESHLLM_VERSION] })
    await store.putConfig('llamacpp_versions_cache', { fetchedAt: Date.now(), tags: ['b9912', 'b9900'] })

    const response = await handleRuntimeVersionsSelect(selectRequest({ meshllm: 'v0.73.0', llamacpp: 'b9900' }), store, releasesFetcher([]), 'admin:test')
    const body = await response.json() as { ok: boolean; desired: { meshllm: string; llamacpp: string } }

    expect(response.status).toBe(200)
    expect(body).toEqual({ ok: true, desired: { meshllm: 'v0.73.0', llamacpp: 'b9900' } })
    expect(await desiredRuntimeVersions(store)).toEqual({ meshllm: 'v0.73.0', llamacpp: 'b9900' })
    expect(store.audit.find((event) => event.type === 'runtime_versions_selected')).toMatchObject({ actor: 'admin:test', detail: { meshllm: 'v0.73.0', llamacpp: 'b9900' } })
  })

  it('REQ-ADM-033 rejects unknown runtime versions without changing stored desires', async () => {
    const store = new MemoryStore()
    await store.putConfig('meshllm_versions_cache', { fetchedAt: Date.now(), tags: ['v0.73.0'] })

    const response = await handleRuntimeVersionsSelect(selectRequest({ meshllm: 'v9.9.9' }), store, releasesFetcher([]))

    expect(response.status).toBe(400)
    expect(await desiredRuntimeVersions(store)).toEqual({ meshllm: DEFAULT_MESHLLM_VERSION, llamacpp: DEFAULT_LLAMACPP_VERSION })
    expect(store.audit.some((event) => event.type === 'runtime_versions_selected')).toBe(false)
  })

  it('REQ-NODE-013 includes selected runtime versions in heartbeat responses', async () => {
    const store = new MemoryStore()
    await store.putConfig('desired_meshllm_version', 'v0.73.0')
    await store.putConfig('desired_llamacpp_version', 'b9900')
    await store.upsertNode({ ...nodeFixture(), nodeTokenVerifier: await hashToken('node-secret') })
    const router = createRouter({
      store,
      scheduler: new StoreScheduler(store),
      mesh: { fetch: async () => Response.json({}) } as unknown as Fetcher,
      env: {}
    })

    const response = await router(new Request('https://router.test/node/heartbeat', {
      method: 'POST',
      headers: { ...bearer('node-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: 'node-a', displayName: 'Node A', meshIp: '100.64.1.10', inferencePort: 8080, localDashboardPort: 17777, status: 'online', publicModels: ['codeflare-mesh'], activeProfileIds: ['mesh-default-qwen36-35b'], capacity: 2, inFlight: 0, runtime: 'meshllm', metrics: { runtimeState: 'ready', activeRequests: 0 } })
    }))
    const body = await response.json() as { ok: boolean; desiredRuntimeVersions: { meshllm: string; llamacpp: string } }

    expect(response.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.desiredRuntimeVersions).toEqual({ meshllm: 'v0.73.0', llamacpp: 'b9900' })
  })

  it('REQ-NODE-014 defaults the active source to the fork when configured, upstream when not', async () => {
    const store = new MemoryStore()
    expect(await activeMeshllmRepository({ MESHLLM_RELEASE_REPOSITORY: 'nikolanovoselec/mesh-llm' }, store)).toBe('nikolanovoselec/mesh-llm')
    expect(await activeMeshllmRepository({}, store)).toBeUndefined()
  })

  it('REQ-NODE-014 lists the active source and fork option for the console', async () => {
    const store = new MemoryStore()
    const env = { MESHLLM_RELEASE_REPOSITORY: 'nikolanovoselec/mesh-llm' }
    const response = await handleRuntimeVersionsList(new Request('https://router.test/admin/runtime-versions'), store, releasesFetcher(['v0.73.0']), env)
    const body = await response.json() as { meshllm: { source: string; forkRepository?: string; officialRepository: string } }

    expect(response.status).toBe(200)
    expect(body.meshllm.source).toBe('fork')
    expect(body.meshllm.forkRepository).toBe('nikolanovoselec/mesh-llm')
    expect(body.meshllm.officialRepository).toBe('Mesh-LLM/mesh-llm')
  })

  it('REQ-NODE-014 persists the operator binary-source choice, audits it, and flips the active repository', async () => {
    const store = new MemoryStore()
    const env = { MESHLLM_RELEASE_REPOSITORY: 'nikolanovoselec/mesh-llm' }
    const response = await handleRuntimeVersionsSelect(selectRequest({ meshllmSource: 'official' }), store, releasesFetcher([]), 'admin:test', env)
    const body = await response.json() as { ok: boolean; source: string }

    expect(response.status).toBe(200)
    expect(body).toEqual({ ok: true, source: 'official' })
    expect(await store.getConfig('meshllm_release_source')).toBe('official')
    expect(store.audit.find((event) => event.type === 'runtime_source_selected')).toMatchObject({ actor: 'admin:test', detail: { meshllm: 'official' } })
    // Choosing official drops the active repository to upstream and the list follows.
    expect(await activeMeshllmRepository(env, store)).toBeUndefined()
    const list = await handleRuntimeVersionsList(new Request('https://router.test/admin/runtime-versions'), store, releasesFetcher([]), env)
    expect((await list.json() as { meshllm: { source: string } }).meshllm.source).toBe('official')
  })

  it('REQ-NODE-014 rejects a fork choice with no fork configured and rejects unknown sources', async () => {
    const store = new MemoryStore()
    const noFork = await handleRuntimeVersionsSelect(selectRequest({ meshllmSource: 'fork' }), store, releasesFetcher([]), 'admin', {})
    expect(noFork.status).toBe(400)
    expect((await noFork.json() as { error: string }).error).toBe('meshllm_fork_unavailable')

    const bogus = await handleRuntimeVersionsSelect(selectRequest({ meshllmSource: 'sideload' }), store, releasesFetcher([]), 'admin', { MESHLLM_RELEASE_REPOSITORY: 'nikolanovoselec/mesh-llm' })
    expect(bogus.status).toBe(400)
    expect((await bogus.json() as { error: string }).error).toBe('invalid_meshllm_source')
    expect(store.audit.some((event) => event.type === 'runtime_source_selected')).toBe(false)
  })

  it('REQ-API-010 lets automation list and select runtime versions', async () => {
    const store = new MemoryStore()
    await store.putToken(await createTokenRecord('automation', 'auto-secret', Date.now()))
    const router = createRouter({
      store,
      scheduler: new StoreScheduler(store),
      mesh: { fetch: async () => Response.json({}) } as unknown as Fetcher,
      env: {},
      releasesFetcher: releasesFetcher(['v0.73.0', 'b9900'])
    })

    const listed = await router(new Request('https://router.test/api/v1/runtime-versions', { headers: bearer('auto-secret') }))
    const updated = await router(new Request('https://router.test/api/v1/runtime-versions', {
      method: 'PUT',
      headers: { ...bearer('auto-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ meshllm: 'v0.73.0', llamacpp: 'b9900' })
    }))

    expect(listed.status).toBe(200)
    expect(updated.status).toBe(200)
    expect(await desiredRuntimeVersions(store)).toEqual({ meshllm: 'v0.73.0', llamacpp: 'b9900' })
    expect(store.audit.find((event) => event.type === 'runtime_versions_selected')?.actor).toMatch(/^automation:/)
  })
})
