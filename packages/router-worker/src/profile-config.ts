/**
 * Validation and normalisation for model-profile and node configuration.
 *
 * These resolvers turn untrusted request bodies into profile and node records,
 * or into an error the caller renders. They return plain results rather than
 * responses, so they carry no HTTP concern and the route handlers stay thin.
 * Lifted out of router.ts, where they were the single largest block.
 */
import { listMeshes, meshAliasFor } from './meshes'
import { buildCustomProfile, llamaCppQuantError, parseLlamaCppModelRef, profileMeshId, slugify, STABLE_PUBLIC_MODEL } from './profiles'
import { RUNTIME_KINDS } from './types'
import type { LlamaCppProfileSettings, ModelProfile, NodeRecord, RuntimeKind, Store, VllmProfileSettings } from './types'

/** The slice of the router's dependencies these resolvers use. RouterDeps satisfies it. */
export interface ProfileConfigDeps {
  readonly store: Store
}

export const INVALID_MAX_VRAM = Symbol('invalid_max_vram')
export function resolveMaxVram(value: number | undefined): number | undefined | typeof INVALID_MAX_VRAM {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return INVALID_MAX_VRAM
  return value
}

export function resolveRuntime(value: unknown): RuntimeKind | 'invalid_runtime' {
  if (value === undefined || value === null || value === '') return 'meshllm'
  return (RUNTIME_KINDS as readonly unknown[]).includes(value) ? (value as RuntimeKind) : 'invalid_runtime'
}

// A model's own callable alias sits alongside its mesh's stable alias. Editing it must
// preserve that mesh alias — the old hardcoded [codeflare-mesh, alias] silently
// repatriated non-default-mesh profiles — and may not take the reserved stable alias
// of any mesh (codeflare-mesh or any codeflare-mesh-*). REQ-RUN-016.
export function resolveCallNameAliases(existing: ModelProfile, rawCallName: unknown, profiles: readonly ModelProfile[]): readonly string[] | { readonly error: string; readonly status: number } {
  const alias = slugify(typeof rawCallName === 'string' ? rawCallName : '')
  if (!alias) return { error: 'invalid_call_name', status: 400 }
  if (alias === STABLE_PUBLIC_MODEL || alias.startsWith(`${STABLE_PUBLIC_MODEL}-`)) return { error: 'call_name_conflict', status: 409 }
  if (profiles.some((profile) => profile.id !== existing.id && profile.publicAliases.includes(alias))) return { error: 'call_name_conflict', status: 409 }
  return [meshAliasFor(profileMeshId(existing)), alias]
}

// Applies a requested mesh reassignment to a profile before the rest of its config is
// resolved (REQ-RUN-016): the mesh's stable alias is swapped in, and the model arrives
// in its new group INACTIVE (rollout 0) so the operator activates it there explicitly.
// The caller's later version bump also protects the row from any default re-seed.
export async function resolveMeshReassignment(deps: ProfileConfigDeps, existing: ModelProfile, rawMeshId: unknown): Promise<{ readonly profile: ModelProfile; readonly change?: { readonly from: string; readonly to: string } } | { readonly error: string }> {
  if (rawMeshId === undefined) return { profile: existing }
  if (typeof rawMeshId !== 'string' || !(await listMeshes(deps.store)).some((mesh) => mesh.id === rawMeshId)) return { error: 'unknown_mesh' }
  const from = profileMeshId(existing)
  if (rawMeshId === from) return { profile: existing }
  const ownAliases = existing.publicAliases.filter((alias) => alias !== meshAliasFor(from))
  return {
    profile: { ...existing, meshId: rawMeshId, publicAliases: [meshAliasFor(rawMeshId), ...ownAliases], active: false, rolloutPercent: 0 },
    change: { from, to: rawMeshId }
  }
}

interface LlamaCppConfigBody {
  readonly contextWindow?: unknown
  readonly parallel?: unknown
  readonly cachePrompt?: unknown
  readonly cacheReuse?: unknown
  readonly cacheTypeK?: unknown
  readonly cacheTypeV?: unknown
  readonly batch?: unknown
  readonly ubatch?: unknown
  readonly flashAttn?: unknown
  readonly mmproj?: unknown
  readonly kvUnified?: unknown
  readonly maxOutputTokens?: unknown
  readonly gpuLayers?: unknown
  readonly bindPort?: unknown
  readonly hfRepo?: unknown
  readonly hfFile?: unknown
  readonly quant?: unknown
  readonly reasoning?: unknown
}

function resolveLlamaCppSettings(existing: LlamaCppProfileSettings, value: unknown): { settings: LlamaCppProfileSettings } | { error: string } {
  if (value === undefined) return { settings: existing }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { error: 'invalid_llamacpp' }
  const body = value as LlamaCppConfigBody
  const next: Record<string, unknown> = { ...existing }
  const applyInt = (key: 'contextWindow' | 'cacheReuse' | 'bindPort', raw: unknown, min: number): string | null => {
    if (raw === undefined) return null
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < min) return `invalid_${key}`
    next[key] = raw
    return null
  }
  // contextWindow 0 = Auto (llama-server loads the model's native context via
  // --ctx-size 0); a fixed direct context keeps the 4096 sanity floor.
  const applyContextWindow = (raw: unknown): string | null => {
    if (raw === undefined) return null
    if (typeof raw !== 'number' || !Number.isInteger(raw) || (raw !== 0 && raw < 4096)) return 'invalid_contextWindow'
    next.contextWindow = raw
    return null
  }
  // parallel -1 = Auto (llama-server plans the slot count with unified KV);
  // otherwise a fixed slot count >= 1. 0 is invalid upstream and rejected here.
  const applyParallel = (raw: unknown): string | null => {
    if (raw === undefined) return null
    if (typeof raw !== 'number' || !Number.isInteger(raw) || (raw !== -1 && raw < 1)) return 'invalid_parallel'
    next.parallel = raw
    return null
  }
  const applyOptionalInt = (key: 'batch' | 'ubatch' | 'maxOutputTokens', raw: unknown, min: number): string | null => {
    if (raw === undefined) return null
    if (raw === null || raw === 0) { delete next[key]; return null }
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < min) return `invalid_${key}`
    next[key] = raw
    return null
  }
  const applyCacheType = (key: 'cacheTypeK' | 'cacheTypeV', raw: unknown): string | null => {
    if (raw === undefined) return null
    if (raw === null || raw === '') { delete next[key]; return null }
    if (typeof raw !== 'string' || !LLAMACPP_CACHE_TYPES.has(raw)) return `invalid_${key}`
    next[key] = raw
    return null
  }
  const applyGpuLayers = (raw: unknown): string | null => {
    if (raw === undefined) return null
    if (raw === null || raw === '') { delete next.gpuLayers; return null }
    if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0) { next.gpuLayers = String(raw); return null }
    if (typeof raw === 'string') {
      const trimmed = raw.trim().toLowerCase()
      if (trimmed === 'auto' || trimmed === 'all' || /^\d+$/.test(trimmed)) { next.gpuLayers = trimmed; return null }
    }
    return 'invalid_gpuLayers'
  }
  for (const err of [
    applyContextWindow(body.contextWindow),
    applyParallel(body.parallel),
    applyInt('cacheReuse', body.cacheReuse, 0),
    applyInt('bindPort', body.bindPort, 1),
    applyOptionalInt('batch', body.batch, 1),
    applyOptionalInt('ubatch', body.ubatch, 1),
    applyOptionalInt('maxOutputTokens', body.maxOutputTokens, 1),
    applyCacheType('cacheTypeK', body.cacheTypeK),
    applyCacheType('cacheTypeV', body.cacheTypeV),
    applyGpuLayers(body.gpuLayers)
  ]) {
    if (err) return { error: err }
  }
  if (typeof next.bindPort === 'number' && (next.bindPort === 9337 || next.bindPort === 3131)) return { error: 'bind_port_conflict' }
  if (body.cachePrompt !== undefined) {
    if (typeof body.cachePrompt !== 'boolean') return { error: 'invalid_cachePrompt' }
    next.cachePrompt = body.cachePrompt
  }
  if (body.flashAttn !== undefined) {
    if (body.flashAttn === null) delete next.flashAttn
    else if (typeof body.flashAttn === 'boolean') next.flashAttn = body.flashAttn
    else return { error: 'invalid_flash_attn' }
  }
  if (body.mmproj !== undefined) {
    if (body.mmproj === null) delete next.mmproj
    else if (typeof body.mmproj === 'boolean') next.mmproj = body.mmproj
    else return { error: 'invalid_mmproj' }
  }
  if (body.kvUnified !== undefined) {
    if (body.kvUnified === null) delete next.kvUnified
    else if (typeof body.kvUnified === 'boolean') next.kvUnified = body.kvUnified
    else return { error: 'invalid_kv_unified' }
  }
  // llama-server force-enables unified KV under Auto slot planning, so an explicit
  // off with Auto parallel would silently lie; require a fixed slot count instead.
  if (next.parallel === -1 && next.kvUnified === false) return { error: 'kv_unified_auto_conflict' }
  for (const key of ['hfRepo', 'hfFile', 'quant'] as const) {
    const raw = body[key]
    if (raw === undefined) continue
    if (raw === null || raw === '') delete next[key]
    else if (typeof raw === 'string') next[key] = raw.trim()
    else return { error: `invalid_${key}` }
  }
  if (typeof next.hfRepo !== 'string' || next.hfRepo.length === 0) return { error: 'invalid_hfRepo' }
  if (body.reasoning !== undefined) {
    if (body.reasoning === null) delete next.reasoning
    else {
      const reasoning = resolveReasoning(existing.reasoning, body.reasoning)
      if ('error' in reasoning) return reasoning
      if (Object.keys(reasoning.value).length === 0) delete next.reasoning
      else next.reasoning = reasoning.value
    }
  }
  return { settings: next as unknown as LlamaCppProfileSettings }
}

export type NodeConfigBody = { readonly maxVramGbOverride?: number | null; readonly displayName?: unknown; readonly name?: unknown; readonly meshId?: unknown }
export const INVALID_NODE_NAME = Symbol('invalid_node_name')

function normalizeNodeDisplayName(value: unknown): string | undefined | typeof INVALID_NODE_NAME {
  if (value === undefined) return undefined
  if (typeof value !== 'string') return INVALID_NODE_NAME
  const trimmed = value.trim()
  return trimmed.length > 0 && trimmed.length <= 80 ? trimmed : INVALID_NODE_NAME
}

// A node's VRAM override replaces the model's global maxVramGb for that node. `null` clears the
// override (revert to the model default); a finite number >= 0 sets it (0 = uncapped on this node).
function nodeWithVramOverride(node: NodeRecord, value: number | null | undefined): NodeRecord | typeof INVALID_MAX_VRAM {
  if (value === undefined) return node
  if (value === null) {
    const { maxVramGbOverride, ...rest } = node
    void maxVramGbOverride
    return rest
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return INVALID_MAX_VRAM
  return { ...node, maxVramGbOverride: value }
}

export function nodeWithConfig(node: NodeRecord, body: NodeConfigBody | undefined): NodeRecord | typeof INVALID_MAX_VRAM | typeof INVALID_NODE_NAME {
  let updated: NodeRecord | typeof INVALID_MAX_VRAM = nodeWithVramOverride(node, body?.maxVramGbOverride)
  if (updated === INVALID_MAX_VRAM) return updated
  const nextName = normalizeNodeDisplayName(body?.displayName ?? body?.name)
  if (nextName === INVALID_NODE_NAME) return nextName
  if (nextName !== undefined) updated = { ...updated, displayName: nextName }
  return updated
}

// Apply a node's VRAM override to the profile set it will run, so the agent renders --max-vram
// at the node's ceiling instead of the model's global budget.
export function applyNodeVramOverride(profiles: readonly ModelProfile[], override: number | undefined): readonly ModelProfile[] {
  if (override === undefined) return profiles
  return profiles.map((profile) => profile.runtime === 'meshllm' && profile.meshllm ? { ...profile, meshllm: { ...profile.meshllm, maxVramGb: override } } : profile)
}

const MESHLLM_CACHE_TYPES = new Set(['f16', 'q8_0', 'q4_0'])
const LLAMACPP_CACHE_TYPES = new Set(['f32', 'f16', 'bf16', 'q8_0', 'q4_0', 'q4_1', 'iq4_nl', 'q5_0', 'q5_1'])

interface MeshllmTunablesBody {
  parallel?: unknown
  cacheTypeK?: unknown
  cacheTypeV?: unknown
  batch?: unknown
  ubatch?: unknown
  flashAttn?: unknown
  maxOutputTokens?: unknown
  reasoning?: unknown
  prefixCache?: unknown
  toolEmulation?: unknown
  wireDtype?: unknown
  prefillChunking?: unknown
  prefillChunkSize?: unknown
}

// resolveReasoning layers a reasoning update onto the existing block, per sub-field,
// exactly like the scalar tunables: a present valid value sets it, an explicit null /
// "" / 0 clears it (removed, never undefined), and an absent field is preserved. This
// keeps partial updates (one sub-field) from dropping the others while still allowing
// each sub-field to be cleared back to Auto.
function resolveReasoning(existing: { enabled?: boolean; format?: string; budget?: number } | undefined, value: unknown): { value: { enabled?: boolean; format?: string; budget?: number } } | { error: string } {
  if (typeof value !== 'object' || value === null) return { error: 'invalid_reasoning' }
  const input = value as { enabled?: unknown; format?: unknown; budget?: unknown }
  const next: { enabled?: boolean; format?: string; budget?: number } = { ...existing }
  if (input.enabled !== undefined) {
    if (input.enabled === null) delete next.enabled
    else if (typeof input.enabled === 'boolean') next.enabled = input.enabled
    else return { error: 'invalid_reasoning' }
  }
  if (input.format !== undefined) {
    if (input.format === null || input.format === '') delete next.format
    else if (typeof input.format === 'string') next.format = input.format
    else return { error: 'invalid_reasoning' }
  }
  if (input.budget !== undefined) {
    if (input.budget === null || input.budget === 0) delete next.budget
    else if (typeof input.budget === 'number' && Number.isInteger(input.budget) && input.budget >= 1) next.budget = input.budget
    else return { error: 'invalid_reasoning' }
  }
  return { value: next }
}

// resolvePrefixCache layers a prefix-cache update onto the existing block per
// sub-field, like resolveReasoning: a present valid value sets it, null / 0 / ""
// clears it (removed, never undefined), an absent field is preserved. maxEntries is
// bounded to [1, 128] so an operator cannot re-introduce the pool-overrun the low
// default avoids (REQ-RUN-002 / REQ-RUN-003).
type PrefixCacheBlock = { enabled?: boolean; maxEntries?: number; payloadMode?: string; sharedStrideTokens?: number; sharedRecordLimit?: number }
const MESHLLM_PAYLOAD_MODES = new Set(['resident-kv', 'kv-recurrent', 'full-state'])
function resolvePrefixCache(existing: PrefixCacheBlock | undefined, value: unknown): { value: PrefixCacheBlock } | { error: string } {
  if (typeof value !== 'object' || value === null) return { error: 'invalid_prefix_cache' }
  const input = value as { enabled?: unknown; maxEntries?: unknown; payloadMode?: unknown; sharedStrideTokens?: unknown; sharedRecordLimit?: unknown }
  const next: PrefixCacheBlock = { ...existing }
  const applyInt = (key: 'maxEntries' | 'sharedStrideTokens' | 'sharedRecordLimit', v: unknown, max: number): boolean => {
    if (v === undefined) return true
    if (v === null || v === 0) { delete next[key]; return true }
    if (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= max) { next[key] = v; return true }
    return false
  }
  if (input.enabled !== undefined) {
    if (input.enabled === null) delete next.enabled
    else if (typeof input.enabled === 'boolean') next.enabled = input.enabled
    else return { error: 'invalid_prefix_cache' }
  }
  if (input.payloadMode !== undefined) {
    if (input.payloadMode === null || input.payloadMode === '') delete next.payloadMode
    else if (typeof input.payloadMode === 'string' && MESHLLM_PAYLOAD_MODES.has(input.payloadMode)) next.payloadMode = input.payloadMode
    else return { error: 'invalid_prefix_cache' }
  }
  // max_entries capped at 128 (mesh-llm's uncertified fallback overruns the KV pool there).
  if (!applyInt('maxEntries', input.maxEntries, 128)) return { error: 'invalid_prefix_cache' }
  if (!applyInt('sharedStrideTokens', input.sharedStrideTokens, 4096)) return { error: 'invalid_prefix_cache' }
  if (!applyInt('sharedRecordLimit', input.sharedRecordLimit, 64)) return { error: 'invalid_prefix_cache' }
  return { value: next }
}

// resolveMeshllmTunables layers the per-model mesh-llm runtime tunables from a
// config request onto the existing settings, immutably (REQ-RUN-002 / REQ-ADM-021).
// A field changes only when present in the body: a positive integer, an allowed
// cache type, or a boolean sets it; null / 0 / "" clears it back to Auto by removing
// the key (never assigning undefined, which JSON.stringify would silently strip from
// the stored blob). An invalid value yields an error code the caller returns as 400.
export type ModelConfigBody = { profileId?: string; contextWindow?: number; modelRef?: string; maxVramGb?: number; name?: string; callName?: string; runtime?: unknown; llamacpp?: unknown; vllm?: unknown; meshId?: unknown } & MeshllmTunablesBody

export function resolveMeshllmTunables(existing: NonNullable<ModelProfile['meshllm']>, body: MeshllmTunablesBody): { meshllm: NonNullable<ModelProfile['meshllm']> } | { error: string } {
  const next: Record<string, unknown> = { ...existing }
  const applyInt = (key: string, value: unknown, min: number): string | null => {
    if (value === undefined) return null
    if (value === null || value === 0) { delete next[key]; return null }
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min) return `invalid_${key}`
    next[key] = value
    return null
  }
  const applyCacheType = (key: string, value: unknown): string | null => {
    if (value === undefined) return null
    if (value === null || value === '') { delete next[key]; return null }
    if (typeof value !== 'string' || !MESHLLM_CACHE_TYPES.has(value)) return `invalid_${key}`
    next[key] = value
    return null
  }
  for (const err of [
    applyInt('parallel', body.parallel, 1),
    applyInt('batch', body.batch, 1),
    applyInt('ubatch', body.ubatch, 1),
    applyInt('maxOutputTokens', body.maxOutputTokens, 1),
    applyCacheType('cacheTypeK', body.cacheTypeK),
    applyCacheType('cacheTypeV', body.cacheTypeV)
  ]) {
    if (err) return { error: err }
  }
  if (body.flashAttn !== undefined) {
    if (body.flashAttn === null) delete next.flashAttn
    else if (typeof body.flashAttn === 'boolean') next.flashAttn = body.flashAttn
    else return { error: 'invalid_flash_attn' }
  }
  if (body.toolEmulation !== undefined) {
    if (body.toolEmulation === null || body.toolEmulation === false) delete next.toolEmulation
    else if (body.toolEmulation === true) next.toolEmulation = true
    else return { error: 'invalid_tool_emulation' }
  }
  const applyChoice = (key: string, value: unknown, allowed: readonly string[], error: string): string | null => {
    if (value === undefined) return null
    if (value === null || value === '') { delete next[key]; return null }
    if (typeof value !== 'string' || !allowed.includes(value)) return error
    next[key] = value
    return null
  }
  for (const err of [
    applyChoice('wireDtype', body.wireDtype, ['f16', 'f32', 'q8'], 'invalid_wire_dtype'),
    applyChoice('prefillChunking', body.prefillChunking, ['fixed', 'adaptive-ramp'], 'invalid_prefill_chunking'),
    applyInt('prefillChunkSize', body.prefillChunkSize, 1)
  ]) {
    if (err) return { error: err }
  }
  if (body.reasoning !== undefined) {
    if (body.reasoning === null) delete next.reasoning
    else {
      const reasoning = resolveReasoning(existing.reasoning, body.reasoning)
      if ('error' in reasoning) return reasoning
      // An all-empty result clears the block rather than storing {}.
      if (Object.keys(reasoning.value).length === 0) delete next.reasoning
      else next.reasoning = reasoning.value
    }
  }
  if (body.prefixCache !== undefined) {
    if (body.prefixCache === null) delete next.prefixCache
    else {
      const prefixCache = resolvePrefixCache(existing.prefixCache, body.prefixCache)
      if ('error' in prefixCache) return prefixCache
      if (Object.keys(prefixCache.value).length === 0) delete next.prefixCache
      else next.prefixCache = prefixCache.value
    }
  }
  return { meshllm: next as unknown as NonNullable<ModelProfile['meshllm']> }
}

export function configureLlamaCppProfile(existing: ModelProfile, profiles: readonly ModelProfile[], body: ModelConfigBody): { profile: ModelProfile; settings: LlamaCppProfileSettings } | { error: string; status: number } {
  if (existing.meshllm?.split) return { error: 'split_requires_meshllm', status: 400 }
  const storedRef = existing.llamacpp?.modelRef ?? existing.meshllm?.modelRef ?? existing.upstreamModel
  const modelRef = body.modelRef !== undefined ? (typeof body.modelRef === 'string' ? body.modelRef.trim() : '') : storedRef
  if (!modelRef) return { error: 'invalid_model_ref', status: 400 }
  const generated = buildCustomProfile({ modelRef, split: false, runtime: 'llamacpp', existing: profiles }).llamacpp!
  const existingDirect = existing.runtime === 'llamacpp' ? existing.llamacpp : undefined
  const baseSource = existingDirect ?? generated
  // Editing the reference re-derives the launch source: the stored repo/quant belong
  // to the old reference, and a stale file override still points into the old repo.
  // The node agent reads only hfRepo/quant — never modelRef — so the source must
  // always follow the reference, or the console shows one model and the node
  // launches another.
  const refChanged = body.modelRef !== undefined && modelRef !== storedRef
  const sourceWithoutDerivedFields = Object.fromEntries(
    Object.entries(baseSource).filter(([key]) => key !== 'hfFile' && key !== 'quant')
  ) as LlamaCppProfileSettings
  const base: LlamaCppProfileSettings = {
    ...(refChanged ? sourceWithoutDerivedFields : baseSource),
    ...(refChanged ? { hfRepo: generated.hfRepo, ...(generated.quant !== undefined ? { quant: generated.quant } : {}) } : {}),
    bindPort: baseSource.bindPort ?? generated.bindPort,
    contextWindow: baseSource.contextWindow ?? generated.contextWindow,
    parallel: baseSource.parallel ?? generated.parallel,
    cachePrompt: baseSource.cachePrompt ?? generated.cachePrompt,
    cacheReuse: baseSource.cacheReuse ?? generated.cacheReuse
  }
  const settingsResult = resolveLlamaCppSettings(base, body.llamacpp)
  if ('error' in settingsResult) return { error: settingsResult.error, status: 400 }
  let settings = settingsResult.settings
  const contextWindow = body.contextWindow ?? settings.contextWindow
  // 0 = Auto (llama-server loads the model's native context); fixed values keep the 4096 floor.
  if (!Number.isInteger(contextWindow) || (contextWindow !== 0 && contextWindow < 4096)) return { error: 'invalid_context_window', status: 400 }
  settings = { ...settings, contextWindow, alias: modelRef, modelRef }
  // The launch source must always reconstruct from the reference and stay within
  // the typo class that once took the fleet down: a trailing-dot or whitespace
  // quant tag resolves no file on Hugging Face.
  const parsedRef = parseLlamaCppModelRef(modelRef)
  const quantError = llamaCppQuantError(settings.quant)
  if (quantError) return { error: quantError, status: 400 }
  if (settings.hfRepo !== parsedRef.hfRepo) return { error: 'model_source_mismatch', status: 400 }
  if (settings.quant !== parsedRef.quant) return { error: 'model_source_mismatch', status: 400 }
  let displayName = existing.displayName
  if (body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) return { error: 'invalid_display_name', status: 400 }
    displayName = name
  }
  let publicAliases = existing.publicAliases
  if (body.callName !== undefined) {
    const resolved = resolveCallNameAliases(existing, body.callName, profiles)
    if (!Array.isArray(resolved)) return resolved as { error: string; status: number }
    publicAliases = resolved
  }
  const { meshllm: _meshllm, ...withoutMesh } = existing
  void _meshllm
  return {
    settings,
    profile: {
      ...withoutMesh,
      displayName,
      publicAliases,
      upstreamModel: settings.alias,
      sourceMode: 'llamacpp-hf',
      contextWindow,
      runtime: 'llamacpp',
      llamacpp: settings,
      version: existing.version + 1
    }
  }
}

// vLLM dtype vocabulary (`--dtype`); quantization stays an open string because
// vLLM's method registry is wide and auto-detected from the checkpoint anyway.
const VLLM_DTYPES = new Set(['auto', 'half', 'float16', 'bfloat16', 'float', 'float32'])

interface VllmConfigBody {
  readonly contextWindow?: unknown
  readonly maxNumSeqs?: unknown
  readonly gpuMemoryUtilization?: unknown
  readonly dtype?: unknown
  readonly quantization?: unknown
  readonly bindPort?: unknown
  readonly hfRepo?: unknown
}

// resolveVllmSettings layers a vllm tunables update onto the existing settings,
// house convention: a present valid value sets a field, null / 0 / "" clears it
// back to vLLM's own default by removing the key (never assigning undefined,
// which JSON.stringify would silently strip), an absent field is preserved.
function resolveVllmSettings(existing: VllmProfileSettings, value: unknown): { settings: VllmProfileSettings } | { error: string } {
  if (value === undefined) return { settings: existing }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { error: 'invalid_vllm' }
  const body = value as VllmConfigBody
  const next: Record<string, unknown> = { ...existing }
  // contextWindow 0 = Auto (vLLM derives max-model-len from the model config);
  // a fixed value keeps the same 4096 sanity floor as the other runtimes.
  if (body.contextWindow !== undefined) {
    if (typeof body.contextWindow !== 'number' || !Number.isInteger(body.contextWindow) || (body.contextWindow !== 0 && body.contextWindow < 4096)) return { error: 'invalid_contextWindow' }
    next.contextWindow = body.contextWindow
  }
  if (body.maxNumSeqs !== undefined) {
    if (body.maxNumSeqs === null || body.maxNumSeqs === 0) delete next.maxNumSeqs
    else if (typeof body.maxNumSeqs === 'number' && Number.isInteger(body.maxNumSeqs) && body.maxNumSeqs >= 1) next.maxNumSeqs = body.maxNumSeqs
    else return { error: 'invalid_maxNumSeqs' }
  }
  if (body.gpuMemoryUtilization !== undefined) {
    if (body.gpuMemoryUtilization === null || body.gpuMemoryUtilization === 0) delete next.gpuMemoryUtilization
    else if (typeof body.gpuMemoryUtilization === 'number' && Number.isFinite(body.gpuMemoryUtilization) && body.gpuMemoryUtilization > 0 && body.gpuMemoryUtilization <= 1) next.gpuMemoryUtilization = body.gpuMemoryUtilization
    else return { error: 'invalid_gpuMemoryUtilization' }
  }
  if (body.dtype !== undefined) {
    if (body.dtype === null || body.dtype === '') delete next.dtype
    else if (typeof body.dtype === 'string' && VLLM_DTYPES.has(body.dtype)) next.dtype = body.dtype
    else return { error: 'invalid_dtype' }
  }
  if (body.quantization !== undefined) {
    if (body.quantization === null || body.quantization === '') delete next.quantization
    else if (typeof body.quantization === 'string' && body.quantization.trim().length > 0) next.quantization = body.quantization.trim()
    else return { error: 'invalid_quantization' }
  }
  if (body.bindPort !== undefined) {
    if (typeof body.bindPort !== 'number' || !Number.isInteger(body.bindPort) || body.bindPort < 1) return { error: 'invalid_bindPort' }
    next.bindPort = body.bindPort
  }
  if (typeof next.bindPort === 'number' && (next.bindPort === 9337 || next.bindPort === 3131)) return { error: 'bind_port_conflict' }
  if (body.hfRepo !== undefined) {
    if (body.hfRepo === null || body.hfRepo === '') delete next.hfRepo
    else if (typeof body.hfRepo === 'string') next.hfRepo = body.hfRepo.trim()
    else return { error: 'invalid_hfRepo' }
  }
  if (typeof next.hfRepo !== 'string' || next.hfRepo.length === 0) return { error: 'invalid_hfRepo' }
  return { settings: next as unknown as VllmProfileSettings }
}

export function configureVllmProfile(existing: ModelProfile, profiles: readonly ModelProfile[], body: ModelConfigBody): { profile: ModelProfile; settings: VllmProfileSettings } | { error: string; status: number } {
  if (existing.meshllm?.split) return { error: 'split_requires_meshllm', status: 400 }
  const storedRef = existing.vllm?.hfRepo ?? existing.meshllm?.modelRef ?? existing.upstreamModel
  const modelRef = body.modelRef !== undefined ? (typeof body.modelRef === 'string' ? body.modelRef.trim() : '') : storedRef
  if (!modelRef) return { error: 'invalid_model_ref', status: 400 }
  // A vLLM reference is a bare HF safetensors repo: llama-style :quant file
  // tags name GGUF files vLLM does not load in-tree (REQ-RUN-021).
  const parsedRef = parseLlamaCppModelRef(modelRef)
  if (parsedRef.quant !== undefined) return { error: 'invalid_model_ref', status: 400 }
  const generated = buildCustomProfile({ modelRef, split: false, runtime: 'vllm', existing: profiles }).vllm!
  const existingDirect = existing.runtime === 'vllm' ? existing.vllm : undefined
  const baseSource = existingDirect ?? generated
  const refChanged = body.modelRef !== undefined && modelRef !== storedRef
  const base: VllmProfileSettings = {
    ...baseSource,
    ...(refChanged ? { hfRepo: generated.hfRepo } : {}),
    bindPort: baseSource.bindPort ?? generated.bindPort,
    contextWindow: baseSource.contextWindow ?? generated.contextWindow
  }
  const settingsResult = resolveVllmSettings(base, body.vllm)
  if ('error' in settingsResult) return { error: settingsResult.error, status: 400 }
  let settings = settingsResult.settings
  const contextWindow = body.contextWindow ?? settings.contextWindow
  if (!Number.isInteger(contextWindow) || (contextWindow !== 0 && contextWindow < 4096)) return { error: 'invalid_context_window', status: 400 }
  settings = { ...settings, contextWindow }
  // The launch source must always reconstruct from the reference: the agent
  // reads only hfRepo, so a drifted repo means the console shows one model and
  // the node launches another.
  if (settings.hfRepo !== parsedRef.hfRepo) return { error: 'model_source_mismatch', status: 400 }
  let displayName = existing.displayName
  if (body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) return { error: 'invalid_display_name', status: 400 }
    displayName = name
  }
  let publicAliases = existing.publicAliases
  if (body.callName !== undefined) {
    const resolved = resolveCallNameAliases(existing, body.callName, profiles)
    if (!Array.isArray(resolved)) return resolved as { error: string; status: number }
    publicAliases = resolved
  }
  const { meshllm: _meshllm, llamacpp: _llamacpp, ...withoutOthers } = existing
  void _meshllm
  void _llamacpp
  return {
    settings,
    profile: {
      ...withoutOthers,
      displayName,
      publicAliases,
      upstreamModel: settings.hfRepo,
      sourceMode: 'vllm-hf',
      contextWindow,
      runtime: 'vllm',
      vllm: settings,
      version: existing.version + 1
    }
  }
}

// handleProfileConfig persists a profile's serving settings — the context window,
// the model ref, the per-model VRAM budget, and the mesh-llm runtime tunables —
// through the validated store path so the active column and the profile_json blob
// stay consistent. contextWindow must be a non-negative integer (0 = Auto, so
// mesh-llm sizes it); a supplied modelRef is trimmed, must be non-empty, and updates
// both the mesh runtime ref and the gateway upstream model together.
