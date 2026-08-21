/**
 * model drawer and model management contracts.
 *
 * One slice of the console dashboard suite; shared fixtures live in
 * `./admin-ui-test-support`.
 */
import { ADMIN_UI_DRAWER, ADMIN_UI_POLLING } from './admin-ui'
import { dashboardHarness, resetDashboardEnvironment, statusFetches, statusFixture } from './admin-ui-test-support'
import { descendants } from './admin-ui-harness'
import { afterEach, describe, expect, it } from 'vitest'

describe('model drawer and model management contracts', () => {
  afterEach(resetDashboardEnvironment)


  it('REQ-ADM-015 opens a model drawer with editable identity and no duplicated serving list', async () => {
    const harness = await dashboardHarness()
    await harness.clickAction('model-detail', { profileId: 'mesh-default-qwen36-35b' })
    const drawer = harness.byId(ADMIN_UI_DRAWER.containerId)
    expect(drawer.hidden).toBe(false)
    expect(harness.byId(ADMIN_UI_DRAWER.titleId).textContent).toBe('Qwen3.6 35B')
    // Machine participation lives in the mesh card alone; the drawer repeats no
    // serving-node list of its own.
    const fields = descendants(harness.byId(ADMIN_UI_DRAWER.bodyId))
    expect(fields.some((node) => node.dataset.drawerServingNode)).toBe(false)
    expect(fields.some((node) => node.dataset.drawerField === 'serving')).toBe(false)
    // The drawer prefills the editable name and the model's own call name (its non-shared
    // alias) — not the shared codeflare-mesh alias, which apps use to reach the active model.
    expect(harness.byId('model-edit-name').value).toBe('Qwen3.6 35B')
    expect(harness.byId('model-edit-callname').value).toBe('qwen3.6:35b-a3b')
  })


  it('REQ-ADM-021 loads and saves a per-model VRAM budget from the model drawer', async () => {
    const profiles = [
      { id: 'mesh-default-qwen36-35b', displayName: 'Qwen3.6 35B', publicAliases: ['codeflare-mesh'], active: true, rolloutPercent: 100, contextWindow: 262144, meshllm: { split: false, modelRef: 'ref-a', maxVramGb: 18 } }
    ]
    const harness = await dashboardHarness({ status: statusFixture({ profiles }) })
    await harness.clickAction('model-detail', { profileId: 'mesh-default-qwen36-35b' })
    // The drawer loads the model's current VRAM budget.
    expect(harness.byId('model-edit-vram').value).toBe('18')
    // Saving a new budget posts it to the validated profile-config endpoint.
    harness.byId('model-edit-vram').value = '12.5'
    await harness.clickAction('model-save', { profileId: 'mesh-default-qwen36-35b', out: 'model-output' })
    const call = harness.fetchCalls.find((entry) => entry.path === '/admin/profiles/config')
    expect(JSON.parse(String(call?.init?.body)).maxVramGb).toBe(12.5)
  })


  it('REQ-RUN-002 loads and saves per-model runtime tunables from the model drawer', async () => {
    const profiles = [
      { id: 'mesh-default-qwen36-35b', displayName: 'Qwen3.6 35B', publicAliases: ['codeflare-mesh'], active: true, rolloutPercent: 100, contextWindow: 0, meshllm: { split: false, modelRef: 'ref-a', parallel: 4, cacheTypeK: 'q8_0', toolEmulation: true, wireDtype: 'f16', prefillChunking: 'fixed', prefillChunkSize: 256 } }
    ]
    const harness = await dashboardHarness({ status: statusFixture({ profiles }) })
    await harness.clickAction('model-detail', { profileId: 'mesh-default-qwen36-35b' })
    // An Auto (0) context window loads blank; stored tunables prefill their controls.
    expect(harness.byId('model-edit-context').value).toBe('')
    expect(harness.byId('model-edit-parallel').value).toBe('4')
    expect(harness.byId('model-edit-cache-k').value).toBe('q8_0')
    expect(harness.byId('model-edit-tool-emulation').value).toBe('emulated')
    expect(harness.byId('model-edit-wire-dtype').value).toBe('f16')
    expect(harness.byId('model-edit-prefill-chunking').value).toBe('fixed')
    expect(harness.byId('model-edit-prefill-chunk-size').value).toBe('256')
    // Each field carries plain-language help; assert the hint affordance renders (structure, not copy).
    expect(descendants(harness.byId(ADMIN_UI_DRAWER.bodyId)).some((node) => node.className === 'drawer-hint')).toBe(true)
    // Editing lanes / KV / max-output and saving posts the tunables to the validated endpoint;
    // a blank context window is sent as 0 (Auto), a Native tool-calling selection as null.
    harness.byId('model-edit-parallel').value = '2'
    harness.byId('model-edit-cache-v').value = 'q4_0'
    harness.byId('model-edit-maxout').value = '8192'
    harness.byId('model-edit-tool-emulation').value = ''
    harness.byId('model-edit-wire-dtype').value = 'q8'
    harness.byId('model-edit-prefill-chunking').value = ''
    harness.byId('model-edit-prefill-chunk-size').value = ''
    await harness.clickAction('model-save', { profileId: 'mesh-default-qwen36-35b', out: 'model-output' })
    const call = harness.fetchCalls.find((entry) => entry.path === '/admin/profiles/config')
    const body = JSON.parse(String(call?.init?.body))
    expect(body.parallel).toBe(2)
    expect(body.cacheTypeV).toBe('q4_0')
    expect(body.maxOutputTokens).toBe(8192)
    expect(body.contextWindow).toBe(0)
    expect(body.toolEmulation).toBe(null)
    expect(body.wireDtype).toBe('q8')
    expect(body.prefillChunking).toBe(null)
    expect(body.prefillChunkSize).toBe(null)
  })


  it('REQ-RUN-013 loads and saves direct llama.cpp runtime tunables from the model drawer', async () => {
    const profiles = [
      { id: 'custom-direct', displayName: 'Direct Qwen', publicAliases: ['codeflare-mesh', 'direct-qwen'], active: true, rolloutPercent: 100, contextWindow: 262144, runtime: 'llamacpp', llamacpp: { modelRef: 'unsloth/Qwen3-14B-GGUF:Q4_K_M', hfRepo: 'unsloth/Qwen3-14B-GGUF', quant: 'Q4_K_M', bindPort: 4330, contextWindow: 262144, parallel: 4, kvUnified: false, cachePrompt: true, cacheReuse: 256, gpuLayers: '99', cacheTypeK: 'q4_0', cacheTypeV: 'q4_0', batch: 8192, ubatch: 2048, flashAttn: true, maxOutputTokens: 16384, alias: 'unsloth/Qwen3-14B-GGUF:Q4_K_M', reasoning: { enabled: true, format: 'deepseek', budget: 8192 } } }
    ]
    const harness = await dashboardHarness({ status: statusFixture({ profiles }) })
    await harness.clickAction('model-detail', { profileId: 'custom-direct' })

    expect(harness.byId('model-edit-llama-parallel').value).toBe('4')
    expect(harness.byId('model-edit-llama-kv-unified').value).toBe('off')
    expect(harness.byId('model-edit-llama-gpu-layers').value).toBe('99')
    expect(harness.byId('model-edit-llama-cache-k').value).toBe('q4_0')
    expect(harness.byId('model-edit-llama-batch').value).toBe('8192')
    expect(harness.byId('model-edit-llama-ubatch').value).toBe('2048')
    expect(harness.byId('model-edit-llama-maxout').value).toBe('16384')
    expect(harness.byId('model-edit-llama-reasoning').value).toBe('on')
    expect(harness.byId('model-edit-llama-reasoning-budget').value).toBe('8192')

    harness.byId('model-edit-llama-parallel').value = ''
    harness.byId('model-edit-llama-kv-unified').value = 'on'
    harness.byId('model-edit-llama-gpu-layers').value = '99'
    harness.byId('model-edit-llama-cache-k').value = 'q4_0'
    harness.byId('model-edit-llama-cache-v').value = 'q4_0'
    harness.byId('model-edit-llama-batch').value = '8192'
    harness.byId('model-edit-llama-ubatch').value = '2048'
    harness.byId('model-edit-llama-flash').value = 'on'
    harness.byId('model-edit-llama-maxout').value = '16384'
    harness.byId('model-edit-llama-reasoning').value = 'on'
    harness.byId('model-edit-llama-reasoning-format').value = 'deepseek'
    harness.byId('model-edit-llama-reasoning-budget').value = '8192'
    await harness.clickAction('model-save', { profileId: 'custom-direct', runtime: 'llamacpp', out: 'model-output' })
    const call = harness.fetchCalls.find((entry) => entry.path === '/admin/profiles/config')
    const body = JSON.parse(String(call?.init?.body))
    expect(body.llamacpp).toMatchObject({ parallel: -1, kvUnified: true, gpuLayers: '99', cacheTypeK: 'q4_0', cacheTypeV: 'q4_0', batch: 8192, ubatch: 2048, flashAttn: true, maxOutputTokens: 16384, reasoning: { enabled: true, format: 'deepseek', budget: 8192 } })
  })


  it('REQ-RUN-021 loads and saves direct vLLM runtime tunables from the model drawer', async () => {
    const profiles = [
      { id: 'custom-vllm', displayName: 'Direct vLLM', publicAliases: ['codeflare-mesh', 'org-model'], upstreamModel: 'org/model', active: true, rolloutPercent: 100, contextWindow: 32768, runtime: 'vllm', vllm: { hfRepo: 'org/model', bindPort: 4400, contextWindow: 32768, maxNumSeqs: 8, gpuMemoryUtilization: 0.85, dtype: 'half', quantization: 'awq' } }
    ]
    const harness = await dashboardHarness({ status: statusFixture({ profiles }) })
    await harness.clickAction('model-detail', { profileId: 'custom-vllm' })

    expect(harness.byId('model-edit-vllm-max-num-seqs').value).toBe('8')
    expect(harness.byId('model-edit-vllm-gpu-mem').value).toBe('0.85')
    expect(harness.byId('model-edit-vllm-dtype').value).toBe('half')
    expect(harness.byId('model-edit-vllm-quant').value).toBe('awq')

    // Clearing a tunable saves it as null (back to vLLM's own default), and the
    // save posts the vllm block to the validated profile-config endpoint.
    harness.byId('model-edit-vllm-max-num-seqs').value = '16'
    harness.byId('model-edit-vllm-gpu-mem').value = '0.9'
    harness.byId('model-edit-vllm-dtype').value = ''
    harness.byId('model-edit-vllm-quant').value = ''
    await harness.clickAction('model-save', { profileId: 'custom-vllm', runtime: 'vllm', out: 'model-output' })
    const call = harness.fetchCalls.find((entry) => entry.path === '/admin/profiles/config')
    const body = JSON.parse(String(call?.init?.body))
    expect(body.vllm).toMatchObject({ maxNumSeqs: 16, gpuMemoryUtilization: 0.9, dtype: null, quantization: null })
  })


  it('REQ-ADM-026 shows a Delete control for any switched-off model', async () => {
    const profiles = [
      { id: 'custom-qwen3-14b-gguf-q4-k-m', displayName: 'Qwen3-14B', publicAliases: ['codeflare-mesh', 'q'], active: false, rolloutPercent: 0, contextWindow: 32768, meshllm: { split: false, modelRef: 'unsloth/x' } },
      { id: 'custom-live', displayName: 'Live custom', publicAliases: ['codeflare-mesh'], active: true, rolloutPercent: 100, contextWindow: 32768, meshllm: { split: false, modelRef: 'y' } },
      { id: 'mesh-default-qwen36-35b', displayName: 'Qwen3.6 35B', publicAliases: ['codeflare-mesh'], active: false, rolloutPercent: 0, contextWindow: 262144, meshllm: { split: false, modelRef: 'z' } }
    ]
    const harness = await dashboardHarness({ status: statusFixture({ profiles }) })
    const deleteButton = () => descendants(harness.byId(ADMIN_UI_DRAWER.bodyId)).find((node) => node.dataset.action === 'model-delete')

    await harness.clickAction('model-detail', { profileId: 'custom-qwen3-14b-gguf-q4-k-m' })
    const del = deleteButton()
    expect(del, 'a custom, off model exposes Delete').toBeDefined()
    expect(del!.dataset.profileId).toBe('custom-qwen3-14b-gguf-q4-k-m')
    expect(del!.dataset.confirm, 'delete must arm before submitting').toBeTruthy()
    await harness.clickAction(ADMIN_UI_DRAWER.closeAction)

    await harness.clickAction('model-detail', { profileId: 'custom-live' })
    expect(deleteButton(), 'an active model hides Delete (turn it off first)').toBeUndefined()
    await harness.clickAction(ADMIN_UI_DRAWER.closeAction)

    // Seed-once: a switched-off default-named model no longer re-seeds, so it is deletable too.
    await harness.clickAction('model-detail', { profileId: 'mesh-default-qwen36-35b' })
    const builtinDel = deleteButton()
    expect(builtinDel, 'a switched-off default-named model exposes Delete').toBeDefined()
    expect(builtinDel!.dataset.profileId).toBe('mesh-default-qwen36-35b')
  })


  it('REQ-ADM-026 deletes a model from the drawer through the profiles delete endpoint and closes the drawer', async () => {
    const profiles = [
      { id: 'custom-gone', displayName: 'Gone', publicAliases: ['codeflare-mesh', 'g'], active: false, rolloutPercent: 0, contextWindow: 32768, meshllm: { split: false, modelRef: 'r' } }
    ]
    const harness = await dashboardHarness({ status: statusFixture({ profiles }), respond: (path, init) => {
      if (path === '/admin/profiles/delete' && (init?.method || 'GET') === 'POST') return Response.json({ ok: true, profileId: 'custom-gone' })
      return undefined
    } })
    await harness.clickAction('model-detail', { profileId: 'custom-gone' })
    expect(harness.byId(ADMIN_UI_DRAWER.containerId).hidden).toBe(false)
    await harness.clickAction('model-delete', { profileId: 'custom-gone', out: 'model-edit-output' })
    await harness.flush(5)
    const call = harness.fetchCalls.find((entry) => entry.path === '/admin/profiles/delete')
    expect(call, 'delete posts to /admin/profiles/delete').toBeDefined()
    expect(JSON.parse(String(call?.init?.body)).profileId).toBe('custom-gone')
    expect(harness.byId(ADMIN_UI_DRAWER.containerId).hidden, 'drawer closes after delete').toBe(true)
  })


  it('REQ-ADM-026 holds the status poll while a destructive confirm is armed so it is not clobbered', async () => {
    const profiles = [
      { id: 'custom-keep', displayName: 'Keep', publicAliases: ['codeflare-mesh', 'k'], active: false, rolloutPercent: 0, contextWindow: 32768, meshllm: { split: false, modelRef: 'r' } }
    ]
    const harness = await dashboardHarness({ status: statusFixture({ profiles }) })
    await harness.clickAction('model-detail', { profileId: 'custom-keep' })
    const del = descendants(harness.byId(ADMIN_UI_DRAWER.bodyId)).find((node) => node.dataset.action === 'model-delete')
    expect(del, 'drawer exposes the delete control').toBeDefined()
    // The first click arms the confirm and must not submit or clear.
    await harness.click(del!)
    expect(del!.dataset.armed).toBe('true')
    const baseline = statusFetches(harness)
    // Firing the poll while armed must skip the refresh that would rebuild the cards and drop the arm.
    harness.runTimers()
    await harness.flush(10)
    expect(statusFetches(harness), 'poll is held while a confirm is armed').toBe(baseline)
    expect(harness.timers.some((timer) => timer.delay === ADMIN_UI_POLLING.intervalMs && !timer.cancelled), 'poll keeps rescheduling').toBe(true)
  })

})
