/**
 * Profile sampling defaults (REQ-RUN-023). Every profile resolves six sampling
 * parameters from stored overrides layered over a mode preset, and the data
 * plane injects the effective values into each forwarded chat completion the
 * caller left unset. Injection at the router is the single wiring point for
 * all three runtimes: mesh-llm, llama.cpp, and vLLM all read these parameters
 * from the request, so no launch-argument rendering is involved.
 */
import type { ModelProfile, SamplingSettings } from './types'

// The recommended parameter sets for thinking and instruct serving. A model
// generating a reasoning trace wants exploratory sampling with no presence
// penalty; an instruct model wants tighter nucleus sampling with a strong
// presence penalty against repetition.
const SAMPLING_PRESETS = {
  thinking: { temperature: 1.0, topP: 0.95, topK: 20, minP: 0, presencePenalty: 0, repetitionPenalty: 1.0 },
  instruct: { temperature: 0.7, topP: 0.8, topK: 20, minP: 0, presencePenalty: 1.5, repetitionPenalty: 1.0 }
} as const

type SamplingMode = keyof typeof SAMPLING_PRESETS

type EffectiveSampling = { readonly mode: SamplingMode } & { readonly [K in Exclude<keyof SamplingSettings, 'mode'>]-?: number }

// A profile without an explicit mode follows its runtime's reasoning setting:
// a model configured to think gets the thinking preset. vLLM profiles carry no
// reasoning knob and resolve to instruct unless the mode is set explicitly.
function samplingMode(profile: ModelProfile): SamplingMode {
  const stored = profile.sampling?.mode
  if (stored) return stored
  const reasoning = profile.llamacpp?.reasoning ?? profile.meshllm?.reasoning
  return reasoning?.enabled === true ? 'thinking' : 'instruct'
}

export function effectiveSampling(profile: ModelProfile): EffectiveSampling {
  const mode = samplingMode(profile)
  const preset = SAMPLING_PRESETS[mode]
  const stored = profile.sampling ?? {}
  return {
    mode,
    temperature: stored.temperature ?? preset.temperature,
    topP: stored.topP ?? preset.topP,
    topK: stored.topK ?? preset.topK,
    minP: stored.minP ?? preset.minP,
    presencePenalty: stored.presencePenalty ?? preset.presencePenalty,
    repetitionPenalty: stored.repetitionPenalty ?? preset.repetitionPenalty
  }
}

// llama.cpp's server reads repeat_penalty; vLLM and mesh-llm read
// repetition_penalty. Both spellings are checked before injecting so a caller
// using either name is never overridden.
export function withSamplingDefaults(body: Record<string, unknown>, profile: ModelProfile): Record<string, unknown> {
  const effective = effectiveSampling(profile)
  const next: Record<string, unknown> = { ...body }
  if (next.temperature === undefined) next.temperature = effective.temperature
  if (next.top_p === undefined) next.top_p = effective.topP
  if (next.top_k === undefined) next.top_k = effective.topK
  if (next.min_p === undefined) next.min_p = effective.minP
  if (next.presence_penalty === undefined) next.presence_penalty = effective.presencePenalty
  if (next.repeat_penalty === undefined && next.repetition_penalty === undefined) {
    next[profile.runtime === 'llamacpp' ? 'repeat_penalty' : 'repetition_penalty'] = effective.repetitionPenalty
  }
  return next
}

const SAMPLING_RULES: ReadonlyArray<{ key: Exclude<keyof SamplingSettings, 'mode'>; ok: (value: number) => boolean }> = [
  { key: 'temperature', ok: (value) => value >= 0 && value <= 2 },
  { key: 'topP', ok: (value) => value > 0 && value <= 1 },
  { key: 'topK', ok: (value) => Number.isInteger(value) && value >= 0 },
  { key: 'minP', ok: (value) => value >= 0 && value <= 1 },
  { key: 'presencePenalty', ok: (value) => value >= -2 && value <= 2 },
  { key: 'repetitionPenalty', ok: (value) => value > 0 && value <= 2 }
]

// resolveSampling layers a sampling update onto the stored block, house
// convention: a present valid value sets a field, null clears it back to the
// mode preset by removing the key (never assigning undefined, which
// JSON.stringify would silently strip), an absent field is preserved. A null
// block clears every override.
export function resolveSampling(existing: SamplingSettings | undefined, value: unknown): { sampling?: SamplingSettings } | { error: string } {
  if (value === undefined) return existing ? { sampling: existing } : {}
  if (value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) return { error: 'invalid_sampling' }
  const body = value as Record<string, unknown>
  const next: { -readonly [K in keyof SamplingSettings]?: SamplingSettings[K] } = { ...existing }
  if (body.mode !== undefined) {
    if (body.mode === null || body.mode === '') delete next.mode
    else if (body.mode === 'thinking' || body.mode === 'instruct') next.mode = body.mode
    else return { error: 'invalid_sampling_mode' }
  }
  for (const rule of SAMPLING_RULES) {
    const raw = body[rule.key]
    if (raw === undefined) continue
    if (raw === null) { delete next[rule.key]; continue }
    if (typeof raw !== 'number' || !Number.isFinite(raw) || !rule.ok(raw)) return { error: `invalid_sampling_${rule.key}` }
    next[rule.key] = raw
  }
  return Object.keys(next).length === 0 ? {} : { sampling: next as SamplingSettings }
}

// applySamplingUpdate returns the profile with its sampling block replaced by
// the resolved update, or the validation error. Shared by the console and
// automation model-config twins so the two doors never diverge.
export function applySamplingUpdate(profile: ModelProfile, value: unknown): { profile: ModelProfile } | { error: string } {
  const resolved = resolveSampling(profile.sampling, value)
  if ('error' in resolved) return resolved
  const { sampling: _stored, ...withoutSampling } = profile
  void _stored
  return { profile: { ...withoutSampling, ...(resolved.sampling ? { sampling: resolved.sampling } : {}) } }
}
