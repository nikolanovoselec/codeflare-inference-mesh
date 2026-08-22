/**
 * control-plane API: fleet status, settings, versions and body handling.
 *
 * One slice of the control-plane suite; shared fixtures live in
 * `./router-test-support`.
 */
import { describe, expect, it } from 'vitest'
import { MESH_STATE_KEY_B64, SMOKE_UPSTREAM, apiAddModel, bearer, githubReleasesFetcher, mintKey, routerFixture } from './router-test-support'
import { nodeFixture } from './test-helpers'

describe('control-plane API: fleet status, settings, versions and body handling', () => {
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
    expect(body.runtimeVersions).toEqual({ meshllm: 'v0.72.2', llamacpp: 'b9912', vllm: 'v0.27.1' })
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

  it('REQ-API-005 REQ-RUN-020 configures direct llama.cpp settings over the automation API', async () => {
    const { router, store } = routerFixture()
    const key = await mintKey(router)
    const headers = { ...bearer(key.token), 'content-type': 'application/json' }
    const add = await apiAddModel(router, key.token, 'unsloth/Qwen3-14B-GGUF:Q4_K_M', 'single', 'llamacpp')
    const profileId = (await add.json() as { model: { id: string } }).model.id

    const ok = await router(new Request(`https://router.test/api/v1/models/${profileId}`, { method: 'POST', headers, body: JSON.stringify({ llamacpp: { contextWindow: 131072, parallel: 2, cacheReuse: 512, mmproj: false } }) }))
    const body = await ok.json() as { model: { runtime: string; llamacpp?: { contextWindow: number; parallel: number; cacheReuse: number; mmproj?: boolean } } }
    const stored = (await store.listProfiles()).find((profile) => profile.id === profileId)!

    expect(ok.status).toBe(200)
    expect(body.model.runtime).toBe('llamacpp')
    expect(body.model.llamacpp).toMatchObject({ contextWindow: 131072, parallel: 2, cacheReuse: 512, mmproj: false })
    expect(stored.llamacpp).toMatchObject({ contextWindow: 131072, parallel: 2, cacheReuse: 512, mmproj: false })
    const cleared = await router(new Request(`https://router.test/api/v1/models/${profileId}`, { method: 'POST', headers, body: JSON.stringify({ llamacpp: { mmproj: null } }) }))
    expect(cleared.status).toBe(200)
    expect((await store.listProfiles()).find((profile) => profile.id === profileId)?.llamacpp?.mmproj).toBeUndefined()
    expect((await router(new Request(`https://router.test/api/v1/models/${profileId}`, { method: 'POST', headers, body: JSON.stringify({ llamacpp: { cacheReuse: -1 } }) }))).status).toBe(400)
  })

  it('REQ-API-005 REQ-RUN-021 configures direct vLLM settings over the automation API', async () => {
    const { router, store } = routerFixture()
    const key = await mintKey(router)
    const headers = { ...bearer(key.token), 'content-type': 'application/json' }
    const add = await apiAddModel(router, key.token, 'Qwen/Qwen3.8-27B-FP8', 'single', 'vllm')
    const profileId = (await add.json() as { model: { id: string } }).model.id

    const ok = await router(new Request(`https://router.test/api/v1/models/${profileId}`, { method: 'POST', headers, body: JSON.stringify({ contextWindow: 32768, vllm: { maxNumSeqs: 8, gpuMemoryUtilization: 0.85, dtype: 'bfloat16' } }) }))
    const body = await ok.json() as { model: { runtime: string; vllm?: { contextWindow: number; maxNumSeqs?: number; gpuMemoryUtilization?: number; dtype?: string } } }
    const stored = (await store.listProfiles()).find((profile) => profile.id === profileId)!

    expect(ok.status).toBe(200)
    expect(body.model.runtime).toBe('vllm')
    expect(body.model.vllm).toMatchObject({ contextWindow: 32768, maxNumSeqs: 8, gpuMemoryUtilization: 0.85, dtype: 'bfloat16' })
    expect(stored.vllm).toMatchObject({ contextWindow: 32768, maxNumSeqs: 8, gpuMemoryUtilization: 0.85, dtype: 'bfloat16' })
    // null clears a tunable back to vLLM's own model-derived default.
    const cleared = await router(new Request(`https://router.test/api/v1/models/${profileId}`, { method: 'POST', headers, body: JSON.stringify({ vllm: { maxNumSeqs: null } }) }))
    expect(cleared.status).toBe(200)
    expect((await store.listProfiles()).find((profile) => profile.id === profileId)?.vllm?.maxNumSeqs).toBeUndefined()
    expect((await router(new Request(`https://router.test/api/v1/models/${profileId}`, { method: 'POST', headers, body: JSON.stringify({ vllm: { gpuMemoryUtilization: 1.5 } }) }))).status).toBe(400)
  })

  it('REQ-RUN-023 REQ-API-005 configures sampling overrides over the automation API', async () => {
    const { router, store } = routerFixture()
    const key = await mintKey(router)
    const headers = { ...bearer(key.token), 'content-type': 'application/json' }
    const add = await apiAddModel(router, key.token, 'Qwen/Qwen3.8-27B-FP8', 'single', 'vllm')
    const profileId = (await add.json() as { model: { id: string } }).model.id

    const ok = await router(new Request(`https://router.test/api/v1/models/${profileId}`, { method: 'POST', headers, body: JSON.stringify({ sampling: { mode: 'thinking', temperature: 1.2 } }) }))
    const body = await ok.json() as { model: { sampling?: { mode?: string; temperature?: number } } }
    expect(ok.status).toBe(200)
    expect(body.model.sampling).toEqual({ mode: 'thinking', temperature: 1.2 })
    expect((await store.listProfiles()).find((profile) => profile.id === profileId)?.sampling).toEqual({ mode: 'thinking', temperature: 1.2 })
    // null clears one override back to the preset; out-of-range values are rejected.
    const cleared = await router(new Request(`https://router.test/api/v1/models/${profileId}`, { method: 'POST', headers, body: JSON.stringify({ sampling: { temperature: null } }) }))
    expect(cleared.status).toBe(200)
    expect((await store.listProfiles()).find((profile) => profile.id === profileId)?.sampling).toEqual({ mode: 'thinking' })
    expect((await router(new Request(`https://router.test/api/v1/models/${profileId}`, { method: 'POST', headers, body: JSON.stringify({ sampling: { topP: 2 } }) }))).status).toBe(400)

    // The llama.cpp arm carries the block through its profile rebuild too — the
    // arm where the repeat_penalty mapping applies at the data plane.
    const llamaAdd = await apiAddModel(router, key.token, 'unsloth/Qwen3-14B-GGUF:Q4_K_M', 'single', 'llamacpp')
    const llamaId = (await llamaAdd.json() as { model: { id: string } }).model.id
    const llamaOk = await router(new Request(`https://router.test/api/v1/models/${llamaId}`, { method: 'POST', headers, body: JSON.stringify({ sampling: { repetitionPenalty: 1.1 } }) }))
    expect(llamaOk.status).toBe(200)
    expect((await store.listProfiles()).find((profile) => profile.id === llamaId)?.sampling).toEqual({ repetitionPenalty: 1.1 })
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

})
