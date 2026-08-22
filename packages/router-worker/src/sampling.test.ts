/**
 * Sampling parameter defaults (REQ-RUN-023): preset resolution, override
 * layering, per-runtime injection naming, and update validation.
 */
import { applySamplingUpdate, effectiveSampling, resolveSampling, withSamplingDefaults } from './sampling'
import { describe, expect, it } from 'vitest'
import type { ModelProfile } from './types'

const vllmProfile = (overrides: Partial<ModelProfile> = {}): ModelProfile => ({
  id: 'custom-test-vllm',
  displayName: 'Test',
  publicAliases: ['codeflare-mesh', 'test'],
  upstreamModel: 'org/model',
  sourceMode: 'vllm-hf',
  contextWindow: 0,
  runtime: 'vllm',
  vllm: { hfRepo: 'org/model', bindPort: 4310, contextWindow: 0 },
  version: 1,
  rolloutPercent: 0,
  active: false,
  ...overrides
})

const llamacppProfile = (overrides: Partial<ModelProfile> = {}): ModelProfile => ({
  id: 'custom-test-llamacpp',
  displayName: 'Test',
  publicAliases: ['codeflare-mesh', 'test'],
  upstreamModel: 'org/model-GGUF:Q4_K_M',
  sourceMode: 'llamacpp-hf',
  contextWindow: 32768,
  runtime: 'llamacpp',
  llamacpp: { modelRef: 'org/model-GGUF:Q4_K_M', hfRepo: 'org/model-GGUF', quant: 'Q4_K_M', bindPort: 4310, contextWindow: 32768, parallel: -1, kvUnified: true, cachePrompt: true, cacheReuse: 256, alias: 'org/model-GGUF:Q4_K_M', reasoning: { enabled: true, format: 'deepseek', budget: 8192 } },
  version: 1,
  rolloutPercent: 0,
  active: false,
  ...overrides
})

describe('sampling parameter defaults', () => {
  it('REQ-RUN-023 resolves instruct for non-reasoning profiles and thinking for reasoning-enabled ones', () => {
    // A vLLM profile has no reasoning knob: instruct preset.
    expect(effectiveSampling(vllmProfile())).toEqual({ mode: 'instruct', temperature: 0.7, topP: 0.8, topK: 20, minP: 0, presencePenalty: 1.5, repetitionPenalty: 1.0 })
    // A llama.cpp profile with reasoning enabled: thinking preset.
    expect(effectiveSampling(llamacppProfile())).toEqual({ mode: 'thinking', temperature: 1.0, topP: 0.95, topK: 20, minP: 0, presencePenalty: 0, repetitionPenalty: 1.0 })
    // An explicit mode always wins over the derivation.
    expect(effectiveSampling(vllmProfile({ sampling: { mode: 'thinking' } })).temperature).toBe(1.0)
    expect(effectiveSampling(llamacppProfile({ sampling: { mode: 'instruct' } })).presencePenalty).toBe(1.5)
  })

  it('REQ-RUN-023 stored overrides beat the preset field-wise', () => {
    const effective = effectiveSampling(vllmProfile({ sampling: { temperature: 0.55, topK: 40 } }))
    expect(effective.temperature).toBe(0.55)
    expect(effective.topK).toBe(40)
    // Untouched fields still follow the preset.
    expect(effective.presencePenalty).toBe(1.5)
  })

  it('REQ-RUN-023 injects only unset parameters and maps the repetition key per runtime', () => {
    const injected = withSamplingDefaults({}, llamacppProfile())
    expect(injected).toMatchObject({ temperature: 1.0, top_p: 0.95, top_k: 20, min_p: 0, presence_penalty: 0, repeat_penalty: 1.0 })
    expect(injected).not.toHaveProperty('repetition_penalty')
    expect(withSamplingDefaults({}, vllmProfile())).toMatchObject({ repetition_penalty: 1.0 })
    // Caller-supplied values are never overridden, under either repetition spelling.
    expect(withSamplingDefaults({ temperature: 0.2 }, vllmProfile()).temperature).toBe(0.2)
    const callerRepetition = withSamplingDefaults({ repetition_penalty: 1.3 }, llamacppProfile())
    expect(callerRepetition.repetition_penalty).toBe(1.3)
    expect(callerRepetition).not.toHaveProperty('repeat_penalty')
  })

  it('REQ-RUN-023 validates ranges, clears fields with null, and clears the block with a null value', () => {
    expect(resolveSampling(undefined, { temperature: 3 })).toEqual({ error: 'invalid_sampling_temperature' })
    expect(resolveSampling(undefined, { topP: 0 })).toEqual({ error: 'invalid_sampling_topP' })
    expect(resolveSampling(undefined, { topK: 1.5 })).toEqual({ error: 'invalid_sampling_topK' })
    expect(resolveSampling(undefined, { minP: 1.2 })).toEqual({ error: 'invalid_sampling_minP' })
    expect(resolveSampling(undefined, { presencePenalty: -3 })).toEqual({ error: 'invalid_sampling_presencePenalty' })
    expect(resolveSampling(undefined, { repetitionPenalty: 0 })).toEqual({ error: 'invalid_sampling_repetitionPenalty' })
    expect(resolveSampling(undefined, { mode: 'creative' })).toEqual({ error: 'invalid_sampling_mode' })
    expect(resolveSampling(undefined, [1])).toEqual({ error: 'invalid_sampling' })
    // null clears one field back to the preset; a null block clears everything.
    expect(resolveSampling({ temperature: 0.5, topK: 40 }, { temperature: null })).toEqual({ sampling: { topK: 40 } })
    expect(resolveSampling({ temperature: 0.5 }, null)).toEqual({})
    // An absent field is preserved, and clearing the last field removes the block.
    expect(resolveSampling({ temperature: 0.5 }, { topK: 40 })).toEqual({ sampling: { temperature: 0.5, topK: 40 } })
    expect(resolveSampling({ temperature: 0.5 }, { temperature: null })).toEqual({})
  })

  it('REQ-RUN-023 applySamplingUpdate rebuilds the profile without a cleared block', () => {
    const profile = vllmProfile({ sampling: { temperature: 0.5 } })
    const cleared = applySamplingUpdate(profile, null)
    expect('profile' in cleared && 'sampling' in cleared.profile).toBe(false)
    const updated = applySamplingUpdate(profile, { topK: 40 })
    expect('profile' in updated && updated.profile.sampling).toEqual({ temperature: 0.5, topK: 40 })
    expect(applySamplingUpdate(profile, { temperature: 9 })).toEqual({ error: 'invalid_sampling_temperature' })
  })
})
