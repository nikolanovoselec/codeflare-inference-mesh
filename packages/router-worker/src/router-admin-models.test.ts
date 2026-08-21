/**
 * model configuration and naming contracts.
 *
 * One slice of the router's admin suite; shared fixtures live in
 * `./router-test-support`.
 */
import { bearer, routerFixture, seedLegacyDefaults } from './router-test-support'
import { buildCustomProfile, DEFAULT_MODEL_PROFILES } from './profiles'
import { describe, expect, it } from 'vitest'

describe('model configuration and naming contracts', () => {

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


  it('REQ-RUN-021 adds and configures a direct vLLM profile through the admin paths', async () => {
    const { router, store } = routerFixture()
    const add = await router(new Request('https://router.test/admin/profiles/add', {
      method: 'POST',
      headers: { ...bearer('admin-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ modelRef: 'org/model', mode: 'single', runtime: 'vllm' })
    }))
    expect(add.status).toBe(200)
    const profileId = (await add.json() as { profileId: string }).profileId
    const added = (await store.listProfiles()).find((profile) => profile.id === profileId)!
    // A new vllm profile arrives inactive, HF-repo-sourced, with Auto context and
    // its own advanced bind port; tunables stay unset so vLLM's defaults rule.
    expect(added.runtime).toBe('vllm')
    expect(added.sourceMode).toBe('vllm-hf')
    expect(added.active).toBe(false)
    expect(added.vllm).toMatchObject({ hfRepo: 'org/model', contextWindow: 0 })
    expect(added.vllm!.bindPort).toBeGreaterThanOrEqual(4310)
    expect(added.vllm!.maxNumSeqs).toBeUndefined()
    expect(added.vllm!.gpuMemoryUtilization).toBeUndefined()

    const configure = (body: Record<string, unknown>) => router(new Request('https://router.test/admin/profiles/config', {
      method: 'POST',
      headers: { ...bearer('admin-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ profileId, ...body })
    }))
    const ok = await configure({ vllm: { contextWindow: 32768, maxNumSeqs: 8, gpuMemoryUtilization: 0.85, dtype: 'half', quantization: 'awq' } })
    expect(ok.status).toBe(200)
    const configured = (await store.listProfiles()).find((profile) => profile.id === profileId)!
    expect(configured.vllm).toMatchObject({ hfRepo: 'org/model', contextWindow: 32768, maxNumSeqs: 8, gpuMemoryUtilization: 0.85, dtype: 'half', quantization: 'awq' })
    expect(configured.contextWindow).toBe(32768)
    expect(configured.version).toBe(added.version + 1)

    // House clearing convention: null / 0 / "" removes a tunable back to Auto.
    expect((await configure({ vllm: { maxNumSeqs: null, gpuMemoryUtilization: null, dtype: '', quantization: null } })).status).toBe(200)
    const cleared = (await store.listProfiles()).find((profile) => profile.id === profileId)!
    expect(cleared.vllm?.maxNumSeqs).toBeUndefined()
    expect(cleared.vllm?.gpuMemoryUtilization).toBeUndefined()
    expect(cleared.vllm?.dtype).toBeUndefined()
    expect(cleared.vllm?.quantization).toBeUndefined()

    // Validation fails closed: fractional utilization above 1, unknown dtype,
    // agent-reserved bind ports, and sub-floor fixed contexts are rejected.
    expect((await configure({ vllm: { gpuMemoryUtilization: 1.5 } })).status).toBe(400)
    expect((await configure({ vllm: { dtype: 'q4' } })).status).toBe(400)
    expect((await configure({ vllm: { bindPort: 9337 } })).status).toBe(400)
    expect((await configure({ vllm: { bindPort: 3131 } })).status).toBe(400)
    expect((await configure({ vllm: { contextWindow: 2048 } })).status).toBe(400)
    expect((await configure({ vllm: { contextWindow: 0 } })).status).toBe(200)

    // A vllm model reference is a bare HF safetensors repo: llama-style :quant
    // file tags name GGUF files vLLM does not load in-tree.
    const quantRef = await router(new Request('https://router.test/admin/profiles/add', {
      method: 'POST',
      headers: { ...bearer('admin-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ modelRef: 'org/model:Q4_K_M', mode: 'single', runtime: 'vllm' })
    }))
    expect(quantRef.status).toBe(400)
  })


  it('REQ-RUN-021 advances new bind ports past every runtime block including vllm', () => {
    // The bind-port scan must see all three runtime blocks: a new profile built
    // beside a vllm profile holding the highest port has to advance past it, or
    // two runtimes would collide on the same node port.
    const vllmExisting = { ...buildCustomProfile({ modelRef: 'org/model', split: false, runtime: 'vllm', existing: [] }) }
    const vllmHigh = { ...vllmExisting, vllm: { ...vllmExisting.vllm!, bindPort: 4390 } }
    const nextLlama = buildCustomProfile({ modelRef: 'unsloth/x-GGUF:Q4', split: false, runtime: 'llamacpp', existing: [vllmHigh] })
    expect(nextLlama.llamacpp!.bindPort).toBe(4400)
    const nextVllm = buildCustomProfile({ modelRef: 'org/other', split: false, runtime: 'vllm', existing: [vllmHigh] })
    expect(nextVllm.vllm!.bindPort).toBe(4400)
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


})
