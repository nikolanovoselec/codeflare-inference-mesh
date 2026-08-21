/**
 * router runtime profile and node contracts.
 *
 * One slice of the router's behavioural suite; shared fixtures live in
 * `./router-test-support`.
 */
import { createTokenRecord, hashToken } from './auth'
import { CUSTOM_GGUF, LEGACY_MESH_DEFAULT, LEGACY_MESH_SPLIT, MESH_STATE_KEY_B64, QWEN_UPSTREAM, addModel, bearer, githubReleasesFetcher, heartbeatBody, routerFixture, seedLegacyDefaults } from './router-test-support'
import { DEFAULT_MODEL_PROFILES, STABLE_PUBLIC_MODEL, buildCustomProfile } from './profiles'
import { describe, expect, it } from 'vitest'
import { MemoryStore, nodeFixture } from './test-helpers'

describe('router runtime profile and node contracts', () => {

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


  it('REQ-RUN-013 sets and clears the multimodal projector opt-out', async () => {
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
    const profile = async () => (await store.listProfiles()).find((candidate) => candidate.id === profileId)!

    // Off opts the text workload out of the projector's VRAM (agent renders --no-mmproj).
    expect((await configure({ llamacpp: { mmproj: false } })).status).toBe(200)
    expect((await profile()).llamacpp?.mmproj).toBe(false)
    // null clears the opt-out back to llama.cpp's default.
    expect((await configure({ llamacpp: { mmproj: null } })).status).toBe(200)
    expect((await profile()).llamacpp?.mmproj).toBeUndefined()
    // A non-boolean is refused.
    expect((await configure({ llamacpp: { mmproj: 'yes' } })).status).toBe(400)
  })


  it('REQ-RUN-013 re-derives the launch source when the model reference is edited', async () => {
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
    const profile = async () => (await store.listProfiles()).find((candidate) => candidate.id === profileId)!

    // A file override pointing into the current repo, as a repaired profile would carry.
    const seeded = await profile()
    await store.setProfile({ ...seeded, llamacpp: { ...seeded.llamacpp!, hfFile: 'qwen-14b-q4.gguf' } })

    // Pointing the model at a new quantization re-derives the launch source from the
    // reference: repo and quant follow, the stale file override drops with the old repo,
    // and the operator's tunables carry over.
    const edited = await configure({ modelRef: 'unsloth/Qwen3-14B-GGUF:Q5_K_M' })
    expect(edited.status).toBe(200)
    const afterEdit = await profile()
    expect(afterEdit.upstreamModel).toBe('unsloth/Qwen3-14B-GGUF:Q5_K_M')
    expect(afterEdit.llamacpp).toMatchObject({ hfRepo: 'unsloth/Qwen3-14B-GGUF', quant: 'Q5_K_M', modelRef: 'unsloth/Qwen3-14B-GGUF:Q5_K_M', alias: 'unsloth/Qwen3-14B-GGUF:Q5_K_M' })
    expect(afterEdit.llamacpp?.hfFile).toBeUndefined()
    expect(afterEdit.llamacpp?.parallel).toBe(-1)

    // Moving to a whole other repo re-derives the repo as well.
    const moved = await configure({ modelRef: 'bartowski/Llama-3.1-8B-Instruct-GGUF:Q6_K' })
    expect(moved.status).toBe(200)
    const afterMove = await profile()
    expect(afterMove.llamacpp).toMatchObject({ hfRepo: 'bartowski/Llama-3.1-8B-Instruct-GGUF', quant: 'Q6_K' })
    expect(afterMove.llamacpp?.hfFile).toBeUndefined()
  })


  it('REQ-RUN-013 refuses launch sources that cannot reconstruct the model reference', async () => {
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
    const profile = async () => (await store.listProfiles()).find((candidate) => candidate.id === profileId)!

    // The P1 typo class: a trailing dot in the quant tag resolves no file on
    // Hugging Face. It is refused from the reference and from an explicit tag.
    const trailingDot = await configure({ modelRef: 'unsloth/Qwen3-14B-GGUF:Q4_K_M.' })
    expect(trailingDot.status).toBe(400)
    expect(await trailingDot.json()).toMatchObject({ error: 'invalid_quant_tag' })
    const explicitDot = await configure({ modelRef: 'unsloth/Qwen3-14B-GGUF:Q4_K_M', llamacpp: { quant: 'Q4_K_M.' } })
    expect(explicitDot.status).toBe(400)
    expect(await explicitDot.json()).toMatchObject({ error: 'invalid_quant_tag' })
    // Whitespace in the tag is the same class.
    const spaced = await configure({ modelRef: 'unsloth/Qwen3-14B-GGUF:Q4_K M' })
    expect(spaced.status).toBe(400)
    expect(await spaced.json()).toMatchObject({ error: 'invalid_quant_tag' })
    // An explicit source that no longer reconstructs from the reference is refused,
    // so the console can never show one model while the node launches another.
    const divergentRepo = await configure({ modelRef: 'unsloth/Qwen3-14B-GGUF:Q4_K_M', llamacpp: { hfRepo: 'someone/else', quant: 'Q4_K_M' } })
    expect(divergentRepo.status).toBe(400)
    expect(await divergentRepo.json()).toMatchObject({ error: 'model_source_mismatch' })
    const driftedQuant = await configure({ modelRef: 'unsloth/Qwen3-14B-GGUF:Q4_K_M', llamacpp: { hfRepo: 'unsloth/Qwen3-14B-GGUF', quant: 'Q5_K_M' } })
    expect(driftedQuant.status).toBe(400)
    expect(await driftedQuant.json()).toMatchObject({ error: 'model_source_mismatch' })
    const quantOnUntaggedRef = await configure({ modelRef: 'unsloth/Qwen3-14B-GGUF', llamacpp: { hfRepo: 'unsloth/Qwen3-14B-GGUF', quant: 'Q4_K_M' } })
    expect(quantOnUntaggedRef.status).toBe(400)
    expect(await quantOnUntaggedRef.json()).toMatchObject({ error: 'model_source_mismatch' })
    // Refused saves leave the stored profile untouched.
    expect(await profile()).toMatchObject({ upstreamModel: 'unsloth/Qwen3-14B-GGUF:Q4_K_M' })
    expect((await profile()).llamacpp).toMatchObject({ hfRepo: 'unsloth/Qwen3-14B-GGUF', quant: 'Q4_K_M' })
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

    const set = await configure({ profileId: 'mesh-smoke-qwen25-1.5b', parallel: 4, cacheTypeK: 'q4_0', cacheTypeV: 'q4_0', batch: 8192, ubatch: 4096, flashAttn: true, maxOutputTokens: 8192, toolEmulation: true, wireDtype: 'q8', prefillChunking: 'fixed', prefillChunkSize: 512, reasoning: { enabled: true, format: 'deepseek', budget: 4096 }, prefixCache: { enabled: true, maxEntries: 16, payloadMode: 'kv-recurrent', sharedStrideTokens: 128, sharedRecordLimit: 4 } })
    expect(set.status).toBe(200)
    let m = await meshllm()
    expect(m.toolEmulation).toBe(true)
    expect(m.wireDtype).toBe('q8')
    expect(m.prefillChunking).toBe('fixed')
    expect(m.prefillChunkSize).toBe(512)
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
    expect((await configure({ profileId: 'mesh-smoke-qwen25-1.5b', parallel: null, cacheTypeK: '', flashAttn: null, toolEmulation: null, wireDtype: null, prefillChunking: '', prefillChunkSize: null, reasoning: null, prefixCache: null })).status).toBe(200)
    m = await meshllm()
    expect('parallel' in m).toBe(false)
    expect('cacheTypeK' in m).toBe(false)
    expect('flashAttn' in m).toBe(false)
    expect('toolEmulation' in m).toBe(false)
    expect('wireDtype' in m).toBe(false)
    expect('prefillChunking' in m).toBe(false)
    expect('prefillChunkSize' in m).toBe(false)
    expect('reasoning' in m).toBe(false)
    expect('prefixCache' in m).toBe(false)
    expect(m.cacheTypeV).toBe('q4_0')
    expect(m.batch).toBe(8192)

    // Invalid values are rejected at the boundary.
    expect((await configure({ profileId: 'mesh-smoke-qwen25-1.5b', parallel: 0.5 })).status).toBe(400)
    expect((await configure({ profileId: 'mesh-smoke-qwen25-1.5b', cacheTypeK: 'bogus' })).status).toBe(400)
    expect((await configure({ profileId: 'mesh-smoke-qwen25-1.5b', toolEmulation: 'yes' })).status).toBe(400)
    expect((await configure({ profileId: 'mesh-smoke-qwen25-1.5b', wireDtype: 'q4' })).status).toBe(400)
    expect((await configure({ profileId: 'mesh-smoke-qwen25-1.5b', prefillChunking: 'schedule' })).status).toBe(400)
    expect((await configure({ profileId: 'mesh-smoke-qwen25-1.5b', prefillChunkSize: 0.5 })).status).toBe(400)
    expect((await configure({ profileId: 'mesh-smoke-qwen25-1.5b', batch: -1 })).status).toBe(400)
    expect((await configure({ profileId: 'mesh-smoke-qwen25-1.5b', flashAttn: 'yes' })).status).toBe(400)
    // maxEntries is capped at 128 so an operator cannot re-introduce the KV-pool overrun.
    expect((await configure({ profileId: 'mesh-smoke-qwen25-1.5b', prefixCache: { maxEntries: 256 } })).status).toBe(400)
    expect((await configure({ profileId: 'mesh-smoke-qwen25-1.5b', prefixCache: 'on' })).status).toBe(400)
    // payloadMode must be one of the mesh-llm payload kinds.
    expect((await configure({ profileId: 'mesh-smoke-qwen25-1.5b', prefixCache: { payloadMode: 'bogus' } })).status).toBe(400)
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
    expect(claimed.desiredRuntimeVersions).toEqual({ meshllm: 'v0.72.2', llamacpp: 'b9912', vllm: 'v0.27.1' })
    expect(claimed.meshBootstrap).toBeDefined()
    expect(['create', 'wait']).toContain(claimed.meshBootstrap!.action)
    expect(heartbeat.status).toBe(200)
    expect(heartbeatResponse.ok).toBe(true)
    expect(heartbeatResponse.meshBootstrap).toMatchObject({ action: 'create' })
    expect(typeof heartbeatResponse.meshBootstrap!.rotation).toBe('number')
    expect(heartbeatResponse.desiredAgentVersion).toBe('v0.2.0')
    expect(heartbeatResponse.desiredRuntimeVersions).toEqual({ meshllm: 'v0.72.2', llamacpp: 'b9912', vllm: 'v0.27.1' })
    expect(node?.agentVersion).toBe('v0.1.0')
  })



  it('REQ-NODE-014 claim and heartbeat carry the configured mesh-llm release repository', async () => {
    const urls: string[] = []
    const fetcher: typeof fetch = async (input) => {
      urls.push(String(input))
      return Response.json([{ tag_name: 'v0.73.1-codeflare.1' }])
    }
    const { router, store } = routerFixture({ releasesFetcher: fetcher, env: { MESHLLM_RELEASE_REPOSITORY: 'nikolanovoselec/mesh-llm' } })
    await store.putToken(await createTokenRecord('setup', 'setup-secret', 1_700_000_000_000))
    const claim = await router(new Request('https://router.test/node/claim', { method: 'POST', headers: { ...bearer('setup-secret'), 'content-type': 'application/json' }, body: JSON.stringify({ displayName: 'Node A', meshIp: '100.64.1.10', inferencePort: 8080, publicModels: ['codeflare-mesh'], activeProfileIds: [], capacity: 1 }) }))
    const claimed = await claim.json() as { desiredRuntimeVersions?: { meshllmRepository?: string } }
    expect(claim.status).toBe(201)
    expect(claimed.desiredRuntimeVersions?.meshllmRepository).toBe('nikolanovoselec/mesh-llm')

    // The runtime list fetches the fork's releases, not upstream.
    const list = await router(new Request('https://router.test/admin/runtime-versions', { headers: bearer('admin-secret') }))
    expect(list.status).toBe(200)
    expect(urls.some((url) => url.includes('/repos/nikolanovoselec/mesh-llm/releases'))).toBe(true)

    // The automation select twin validates against the fork's tags and never touches upstream.
    await store.putToken(await createTokenRecord('automation', 'auto-secret', 1_700_000_000_000))
    const select = await router(new Request('https://router.test/api/v1/runtime-versions', { method: 'PUT', headers: { ...bearer('auto-secret'), 'content-type': 'application/json' }, body: JSON.stringify({ meshllm: 'v0.73.1-codeflare.1' }) }))
    expect(select.status).toBe(200)
    expect(urls.some((url) => url.includes('/repos/Mesh-LLM/mesh-llm/'))).toBe(false)

    // An invalid override never rides the wire: the field is simply absent.
    const plain = routerFixture({ env: { MESHLLM_RELEASE_REPOSITORY: 'not a repo!' } })
    await plain.store.putToken(await createTokenRecord('setup', 'setup-2', 1_700_000_000_000))
    const claim2 = await plain.router(new Request('https://router.test/node/claim', { method: 'POST', headers: { ...bearer('setup-2'), 'content-type': 'application/json' }, body: JSON.stringify({ displayName: 'Node B', meshIp: '100.64.1.11', inferencePort: 8080, publicModels: ['codeflare-mesh'], activeProfileIds: [], capacity: 1 }) }))
    const claimed2 = await claim2.json() as { desiredRuntimeVersions?: { meshllmRepository?: string } }
    expect(claimed2.desiredRuntimeVersions?.meshllmRepository).toBeUndefined()
  })


  it('REQ-NODE-014 the operator switches the active binary source between official and fork', async () => {
    const { router, store } = routerFixture({ releasesFetcher: async () => Response.json([{ tag_name: 'v0.73.1-codeflare.1' }]), env: { MESHLLM_RELEASE_REPOSITORY: 'nikolanovoselec/mesh-llm' } })
    // The fleet-facing desired repository is read from admin status, which shares the
    // claim/heartbeat payload path (desiredRuntimeVersionsPayload) without consuming a token.
    const activeRepo = async () => {
      const status = await router(new Request('https://router.test/admin/status', { headers: bearer('admin-secret') }))
      return (await status.json() as { desiredRuntimeVersions?: { meshllmRepository?: string } }).desiredRuntimeVersions?.meshllmRepository
    }

    // Default (no stored choice) serves the fork.
    expect(await activeRepo()).toBe('nikolanovoselec/mesh-llm')

    // Switching to official drops the repository so agents reset to upstream.
    const toOfficial = await router(new Request('https://router.test/admin/runtime-versions', { method: 'POST', headers: { ...bearer('admin-secret'), 'content-type': 'application/json' }, body: JSON.stringify({ meshllmSource: 'official' }) }))
    expect(toOfficial.status).toBe(200)
    expect(await activeRepo()).toBeUndefined()

    // The automation twin switches it back to the fork and is audited as an automation actor.
    await store.putToken(await createTokenRecord('automation', 'auto-secret', 1_700_000_000_000))
    const back = await router(new Request('https://router.test/api/v1/runtime-versions', { method: 'PUT', headers: { ...bearer('auto-secret'), 'content-type': 'application/json' }, body: JSON.stringify({ meshllmSource: 'fork' }) }))
    expect(back.status).toBe(200)
    expect(await activeRepo()).toBe('nikolanovoselec/mesh-llm')
    // The automation twin's switch is audited under an automation actor (the admin
    // switch above logged its own runtime_source_selected event, so match on actor).
    expect(store.audit.some((event) => event.type === 'runtime_source_selected' && String(event.actor ?? '').startsWith('automation:'))).toBe(true)
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

})
