/**
 * control-plane API: model catalogue and configuration.
 *
 * One slice of the control-plane suite; shared fixtures live in
 * `./router-test-support`.
 */
import { addApiModelId, apiAddModel, apiDeleteModel, bearer, mintKey, routerFixture, seedLegacyDefaults } from './router-test-support'
import { describe, expect, it } from 'vitest'

describe('control-plane API: model catalogue and configuration', () => {
  const adminAddModel = (router: (request: Request) => Promise<Response>, ref: string, mode = 'single', token = 'admin-secret') =>
    router(new Request('https://router.test/admin/profiles/add', { method: 'POST', headers: { ...bearer(token), 'content-type': 'application/json' }, body: JSON.stringify({ modelRef: ref, mode }) }))

  const adminDeleteModel = (router: (request: Request) => Promise<Response>, profileId: string, token = 'admin-secret') =>
    router(new Request('https://router.test/admin/profiles/delete', { method: 'POST', headers: { ...bearer(token), 'content-type': 'application/json' }, body: JSON.stringify({ profileId }) }))

  it('REQ-API-005 lists models as projections with callable names', async () => {
    const { router, store } = routerFixture()
    await seedLegacyDefaults(store)
    const key = await mintKey(router)
    const res = await router(new Request('https://router.test/api/v1/models', { headers: bearer(key.token) }))
    expect(res.status).toBe(200)
    const body = await res.json() as { models: Array<{ id: string; callableNames: string[]; displayName: string; maxVramGb: number; split: boolean }> }
    const model = body.models.find((entry) => entry.id === 'mesh-default-qwen36-35b')
    expect(model?.displayName).toBe('Qwen3.6 35B')
    expect(model?.callableNames).toContain('codeflare-mesh')
    // The projection always carries a numeric VRAM budget (0 = no cap) so machine callers can read it.
    expect(typeof model?.maxVramGb).toBe('number')
    // The split serving flag is projected so automation can read back which models run multi-machine.
    expect(model?.split).toBe(false)
  })

  it('REQ-API-007 adds a single-machine model as an inactive projection', async () => {
    const { router, store } = routerFixture()
    const key = await mintKey(router)
    const res = await apiAddModel(router, key.token, 'unsloth/Qwen3-14B-GGUF:Q4_K_M', 'single')
    expect(res.status).toBe(201)
    const body = await res.json() as { model: { id: string; active: boolean; callableNames: string[]; modelRef: string } }
    expect(body.model.active).toBe(false)
    expect(body.model.callableNames).toContain('codeflare-mesh')
    expect(body.model.modelRef).toBe('unsloth/Qwen3-14B-GGUF:Q4_K_M')
    expect((await store.listProfiles()).some((profile) => profile.id === body.model.id && !profile.meshllm!.split)).toBe(true)
  })

  it('REQ-API-007 adds a direct llama.cpp single model as an inactive projection', async () => {
    const { router, store } = routerFixture()
    const key = await mintKey(router)
    const res = await apiAddModel(router, key.token, 'unsloth/Qwen3-14B-GGUF:Q4_K_M', 'single', 'llamacpp')
    expect(res.status).toBe(201)
    const body = await res.json() as { model: { id: string; runtime: string; tunables: unknown; llamacpp?: { cachePrompt: boolean; cacheReuse: number; parallel: number; gpuLayers?: string; cacheTypeK?: string; cacheTypeV?: string; batch?: number; ubatch?: number; maxOutputTokens?: number; reasoning?: { enabled?: boolean; format?: string; budget?: number } } } }
    const created = (await store.listProfiles()).find((profile) => profile.id === body.model.id)

    expect(body.model.runtime).toBe('llamacpp')
    expect(body.model.tunables).toBeNull()
    expect(body.model.llamacpp).toMatchObject({ cachePrompt: true, cacheReuse: 256, parallel: -1, kvUnified: true, gpuLayers: '99', cacheTypeK: 'q4_0', cacheTypeV: 'q4_0', batch: 8192, ubatch: 2048, maxOutputTokens: 16384, reasoning: { enabled: true, format: 'deepseek', budget: 8192 } })
    expect(created).toMatchObject({ runtime: 'llamacpp', sourceMode: 'llamacpp-hf', active: false })
  })

  it('REQ-API-007 rejects direct llama.cpp split model onboarding', async () => {
    const { router, store } = routerFixture()
    const key = await mintKey(router)
    const res = await apiAddModel(router, key.token, 'unsloth/Qwen3-14B-GGUF:Q4_K_M', 'split', 'llamacpp')

    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'split_requires_meshllm' })
    expect((await store.listProfiles()).some((profile) => profile.runtime === 'llamacpp')).toBe(false)
  })

  it('REQ-RUN-013 refuses a quant tag that resolves no file at creation', async () => {
    const { router, store } = routerFixture()
    const key = await mintKey(router)
    // The trailing-dot tag that once took codeflare-mesh down fleet-wide is refused
    // at the door, from the automation API and the console add path alike.
    const res = await apiAddModel(router, key.token, 'unsloth/Qwen3-14B-GGUF:UD-Q3_K_XL.', 'single', 'llamacpp')
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'invalid_quant_tag' })
    expect((await store.listProfiles()).some((profile) => profile.runtime === 'llamacpp')).toBe(false)

    const consoleAdd = await router(new Request('https://router.test/admin/profiles/add', {
      method: 'POST',
      headers: { ...bearer('admin-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ modelRef: 'unsloth/Qwen3-14B-GGUF:UD-Q3_K_XL.', mode: 'single', runtime: 'llamacpp' })
    }))
    expect(consoleAdd.status).toBe(400)
    expect(await consoleAdd.json()).toMatchObject({ error: 'invalid_quant_tag' })
    expect((await store.listProfiles()).some((profile) => profile.runtime === 'llamacpp')).toBe(false)
  })

  it('REQ-API-007 adds a split model with split serving enabled', async () => {
    const { router, store } = routerFixture()
    const key = await mintKey(router)
    const ref = 'hf://meshllm/Qwen3-14B-UD-Q4_K_XL-layers@abc123'
    const res = await apiAddModel(router, key.token, ref, 'split')
    expect(res.status).toBe(201)
    const body = await res.json() as { model: { split: boolean } }
    expect(body.model.split).toBe(true)
    const created = (await store.listProfiles()).find((profile) => profile.upstreamModel === ref)
    expect(created?.meshllm!.split).toBe(true)
    expect(created?.active).toBe(false)
  })

  it('REQ-API-007 rejects a blank model reference', async () => {
    const { router, store } = routerFixture()
    const key = await mintKey(router)
    const res = await apiAddModel(router, key.token, '  ', 'single')
    expect(res.status).toBe(400)
    expect((await store.listProfiles()).some((profile) => profile.id.startsWith('custom-'))).toBe(false)
  })

  it('REQ-API-007 refuses a duplicate model without overwriting', async () => {
    const { router, store } = routerFixture()
    const key = await mintKey(router)
    const first = await apiAddModel(router, key.token, 'unsloth/Qwen3-14B-GGUF:Q4_K_M', 'single')
    expect(first.status).toBe(201)
    const firstId = (await first.json() as { model: { id: string } }).model.id
    const second = await apiAddModel(router, key.token, 'unsloth/Qwen3-14B-GGUF:Q4_K_M', 'single')
    expect(second.status).toBe(409)
    expect((await store.listProfiles()).filter((profile) => profile.id === firstId).length).toBe(1)
  })

  it('REQ-API-008 REQ-RUN-012 deletes a custom inactive model over the API', async () => {
    const { router, store } = routerFixture()
    const key = await mintKey(router)
    const id = await addApiModelId(router, key.token)
    const res = await apiDeleteModel(router, key.token, id)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, id })
    expect((await store.listProfiles()).some((profile) => profile.id === id)).toBe(false)
  })

  it('REQ-API-008 REQ-RUN-012 refuses deleting the active model', async () => {
    const { router, store } = routerFixture()
    const key = await mintKey(router)
    const id = await addApiModelId(router, key.token)
    await router(new Request('https://router.test/api/v1/models/' + id + '/enable', { method: 'POST', headers: bearer(key.token) }))
    const res = await apiDeleteModel(router, key.token, id)
    expect(res.status).toBe(409)
    expect((await res.json() as { error: string }).error).toBe('model_active')
    expect((await store.listProfiles()).some((profile) => profile.id === id)).toBe(true)
  })

  it('REQ-API-008 REQ-RUN-012 deletes the switched-off starter like any other model and it never re-seeds', async () => {
    const { router, store } = routerFixture()
    const key = await mintKey(router)
    // The seeded starter is active; switching it off makes it deletable (REQ-RUN-012).
    await router(new Request('https://router.test/api/v1/models/mesh-smoke-qwen25-1.5b/disable', { method: 'POST', headers: bearer(key.token) }))
    const res = await apiDeleteModel(router, key.token, 'mesh-smoke-qwen25-1.5b')
    expect(res.status).toBe(200)
    expect((await store.listProfiles()).some((profile) => profile.id === 'mesh-smoke-qwen25-1.5b')).toBe(false)
    // Seed-once: another request cycle must not resurrect the deleted starter (REQ-RUN-002).
    await router(new Request('https://router.test/health'))
    expect((await store.listProfiles()).some((profile) => profile.id === 'mesh-smoke-qwen25-1.5b')).toBe(false)
  })

  it('REQ-API-008 REQ-RUN-012 returns 404 deleting an unknown model', async () => {
    const { router } = routerFixture()
    const key = await mintKey(router)
    const res = await apiDeleteModel(router, key.token, 'custom-does-not-exist')
    expect(res.status).toBe(404)
  })

  it('REQ-ADM-026 deletes a custom model from the console', async () => {
    const { router, store } = routerFixture()
    const added = await (await adminAddModel(router, 'unsloth/Qwen3-14B-GGUF:Q4_K_M')).json() as { profileId: string }
    const res = await adminDeleteModel(router, added.profileId)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, profileId: added.profileId })
    expect((await store.listProfiles()).some((profile) => profile.id === added.profileId)).toBe(false)
  })

  it('REQ-ADM-026 refuses console deletion only while the model is active', async () => {
    const { router, store } = routerFixture()
    const res = await adminDeleteModel(router, 'mesh-smoke-qwen25-1.5b')
    expect(res.status).toBe(409)
    expect((await res.json() as { error: string }).error).toBe('model_active')
    expect((await store.listProfiles()).some((profile) => profile.id === 'mesh-smoke-qwen25-1.5b')).toBe(true)
  })

  it('REQ-ADM-026 refuses console model deletion without an admin credential', async () => {
    const { router } = routerFixture()
    const res = await adminDeleteModel(router, 'custom-anything', 'not-admin')
    expect(res.status).toBe(401)
  })

  it('REQ-API-005 configures a model context window and rejects invalid input', async () => {
    const { router, store } = routerFixture()
    await seedLegacyDefaults(store)
    const key = await mintKey(router)
    const headers = { ...bearer(key.token), 'content-type': 'application/json' }
    const ok = await router(new Request('https://router.test/api/v1/models/mesh-default-qwen36-35b', { method: 'POST', headers, body: JSON.stringify({ contextWindow: 8192 }) }))
    expect(ok.status).toBe(200)
    expect((await store.listProfiles()).find((profile) => profile.id === 'mesh-default-qwen36-35b')?.contextWindow).toBe(8192)
    // A VRAM budget is accepted, stored, and echoed in the returned projection; a negative budget is rejected.
    const vram = await router(new Request('https://router.test/api/v1/models/mesh-default-qwen36-35b', { method: 'POST', headers, body: JSON.stringify({ maxVramGb: 16 }) }))
    expect(vram.status).toBe(200)
    expect((await vram.json() as { model: { maxVramGb: number } }).model.maxVramGb).toBe(16)
    expect((await store.listProfiles()).find((profile) => profile.id === 'mesh-default-qwen36-35b')?.meshllm!.maxVramGb).toBe(16)
    expect((await router(new Request('https://router.test/api/v1/models/mesh-default-qwen36-35b', { method: 'POST', headers, body: JSON.stringify({ maxVramGb: -5 }) }))).status).toBe(400)
    // Context window 0 = Auto is accepted; a negative context is rejected.
    const autoCtx = await router(new Request('https://router.test/api/v1/models/mesh-default-qwen36-35b', { method: 'POST', headers, body: JSON.stringify({ contextWindow: 0 }) }))
    expect(autoCtx.status).toBe(200)
    const bad = await router(new Request('https://router.test/api/v1/models/mesh-default-qwen36-35b', { method: 'POST', headers, body: JSON.stringify({ contextWindow: -1 }) }))
    expect(bad.status).toBe(400)
    const missing = await router(new Request('https://router.test/api/v1/models/ghost', { method: 'POST', headers, body: JSON.stringify({ contextWindow: 8192 }) }))
    expect(missing.status).toBe(404)
  })

  it('REQ-API-005 enables a model and switches off another with the same callable name', async () => {
    const { router, store } = routerFixture()
    await seedLegacyDefaults(store)
    const key = await mintKey(router)
    const res = await router(new Request('https://router.test/api/v1/models/mesh-split-qwen36-35b/enable', { method: 'POST', headers: bearer(key.token) }))
    expect(res.status).toBe(200)
    const body = await res.json() as { activated: string; deactivated: string[] }
    expect(body.activated).toBe('mesh-split-qwen36-35b')
    // Single-active: enabling split switches off the seeded active model (smoke), not the already-inactive 35B.
    expect(body.deactivated).toContain('mesh-smoke-qwen25-1.5b')
    const profiles = await store.listProfiles()
    expect(profiles.find((profile) => profile.id === 'mesh-split-qwen36-35b')?.active).toBe(true)
    expect(profiles.find((profile) => profile.id === 'mesh-default-qwen36-35b')?.active).toBe(false)
  })

  it('REQ-API-005 disables a model by dropping its traffic to zero', async () => {
    const { router, store } = routerFixture()
    await seedLegacyDefaults(store)
    const key = await mintKey(router)
    const res = await router(new Request('https://router.test/api/v1/models/mesh-default-qwen36-35b/disable', { method: 'POST', headers: bearer(key.token) }))
    expect(res.status).toBe(200)
    const profile = (await store.listProfiles()).find((entry) => entry.id === 'mesh-default-qwen36-35b')
    expect(profile?.rolloutPercent).toBe(0)
    expect(profile?.active).toBe(false)
  })

})
