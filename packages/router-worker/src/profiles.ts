import type { ModelProfile, RuntimeKind } from './types'

// The single stable public model id AI Gateway forwards. Every model profile
// carries it as a shared public alias, and the single-active invariant
// guarantees exactly one profile owns it at a time — so a request for it always
// resolves to the currently active model and switching the underlying model
// never changes the Gateway route or the public model id clients call.
export const STABLE_PUBLIC_MODEL = 'codeflare-mesh'

export const DEFAULT_MODEL_PROFILES: readonly ModelProfile[] = [
  {
    id: 'mesh-default-qwen36-35b',
    displayName: 'Qwen3.6 35B',
    publicAliases: ['codeflare-mesh', 'qwen3.6:35b-a3b', 'qwen3.6-coder'],
    upstreamModel: 'unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ3_S',
    sourceMode: 'meshllm-ref',
    contextWindow: 262144,
    runtime: 'meshllm',
    meshllm: {
      modelRef: 'unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ3_S',
      split: false,
      bindPort: 4300
    },
    version: 1,
    rolloutPercent: 0,
    active: false
  },
  {
    id: 'mesh-split-qwen36-35b',
    displayName: 'Qwen3.6 35B (multi-machine)',
    publicAliases: ['codeflare-mesh', 'qwen3.6:35b-a3b', 'qwen3.6-coder'],
    upstreamModel: 'hf://meshllm/Qwen3.6-35B-A3B-UD-Q4_K_XL-layers@9b24bdc3dfb174ad6848f3f71c34f5302fa4dcfd',
    sourceMode: 'meshllm-ref',
    contextWindow: 262144,
    runtime: 'meshllm',
    meshllm: {
      modelRef: 'hf://meshllm/Qwen3.6-35B-A3B-UD-Q4_K_XL-layers@9b24bdc3dfb174ad6848f3f71c34f5302fa4dcfd',
      split: true,
      bindPort: 4310
    },
    version: 1,
    rolloutPercent: 0,
    active: false
  },
  {
    id: 'mesh-smoke-qwen25-1.5b',
    displayName: 'Qwen2.5 Coder 1.5B',
    publicAliases: ['codeflare-mesh', 'mesh-smoke', 'smoke-test'],
    upstreamModel: 'unsloth/Qwen2.5-Coder-1.5B-Instruct-GGUF:Q4_K_M',
    sourceMode: 'meshllm-ref',
    contextWindow: 32768,
    runtime: 'meshllm',
    meshllm: {
      modelRef: 'unsloth/Qwen2.5-Coder-1.5B-Instruct-GGUF:Q4_K_M',
      split: false,
      bindPort: 4320
    },
    version: 1,
    rolloutPercent: 100,
    active: true
  }
]

export function publicAliasIndex(profiles: readonly ModelProfile[]): Map<string, ModelProfile> {
  const index = new Map<string, ModelProfile>()
  for (const profile of profiles) {
    if (!profile.active) continue
    for (const alias of profile.publicAliases) index.set(alias, profile)
  }
  return index
}

const BIND_PORT_BASE = 4300
const BIND_PORT_STEP = 10

export const LLAMACPP_PROFILE_DEFAULTS = {
  // parallel -1 = Auto: llama-server plans the slot count (4) with unified KV.
  // kvUnified stays pinned on even for explicit slot counts: non-unified splits
  // --ctx-size across slots (262144/4 = 65536 per request), which 400s any longer
  // request and forces coding agents into early compaction.
  contextWindow: 262144,
  parallel: -1,
  kvUnified: true,
  cachePrompt: true,
  cacheReuse: 256,
  cacheTypeK: 'q4_0',
  cacheTypeV: 'q4_0',
  batch: 8192,
  ubatch: 2048,
  flashAttn: true,
  maxOutputTokens: 16384,
  gpuLayers: '99',
  reasoning: { enabled: true, format: 'deepseek', budget: 8192 }
} as const

// Per-model mesh-llm runtime tunable defaults (REQ-RUN-002 / REQ-RUN-003),
// templated from a proven single-GPU llama.cpp unit but adjusted for mesh-llm.
// Context window is deliberately left Auto (an omitted value) so mesh-llm sizes it
// to the node's GPU — pinning a small window collapses lanes and disables caching.
// parallel and prefixCache are set explicitly, not left to Auto: an omitted parallel
// lets mesh-llm pick a single lane, and an omitted prefix cache defers to family
// auto-detection, which leaves the resident cache OFF for uncertified families — the
// two together are why input caching never engaged. parallel 4 runs the cache in its
// unified-KV mode; prefixCache is enabled with a low max_entries (the uncertified
// fallback of 128 overruns the KV cell pool → 502). Every value is overridable per
// model from the console; q8_0 KV balances memory and quality (q4_0 for huge contexts).
export const MESHLLM_TUNABLE_DEFAULTS = {
  parallel: 4,
  cacheTypeK: 'q8_0',
  cacheTypeV: 'q8_0',
  batch: 2048,
  ubatch: 512,
  flashAttn: true,
  // Reasoning tokens count toward the output, so max output must exceed the reasoning
  // budget or the model can spend its whole allowance thinking with none left to answer.
  // The 8192 / 4096 (2:1) split matches the proven single-GPU unit.
  maxOutputTokens: 8192,
  reasoning: { enabled: true, format: 'deepseek', budget: 4096 },
  // payloadMode is set per model in buildCustomProfile (recurrent-hybrid families need
  // kv-recurrent; dense families are left Auto). shared_* widen the cross-session shared
  // prefix path a little past mesh-llm's conservative default of 2.
  prefixCache: { enabled: true, maxEntries: 16, sharedStrideTokens: 128, sharedRecordLimit: 4 }
} as const

// mesh-llm's Auto prefix-cache payload inference matches the "qwen3" substring and picks
// resident-kv, which silently no-ops for recurrent-hybrid architectures. Pin kv-recurrent for
// the families mesh-llm classifies as recurrent (family_policy.rs); dense families stay Auto.
const MESHLLM_RECURRENT_REF_MARKERS = ['qwen3.5', 'qwen35', 'qwen3.6', 'qwen36', 'qwen3-next', 'qwen3next', 'falcon-h1', 'falcon_h1', 'kimi-linear', 'kimi_linear', 'jamba', 'mamba', 'rwkv', 'nemotron-h', 'nemotron_h']
export function meshllmPayloadMode(ref: string): string | undefined {
  const lower = ref.toLowerCase()
  return MESHLLM_RECURRENT_REF_MARKERS.some((marker) => lower.includes(marker)) ? 'kv-recurrent' : undefined
}

// The readable last segment of a model reference: the hf:// scheme, the owner
// prefix, and any @commit pin are dropped so `hf://meshllm/Model-layers@sha`
// and `unsloth/Model-GGUF:Q4_K_M` both reduce to their model name.
function modelRefSegment(ref: string): string {
  const withoutScheme = ref.replace(/^hf:\/\//, '')
  const lastSegment = withoutScheme.split('/').pop() ?? withoutScheme
  return lastSegment.split('@')[0] ?? lastSegment
}

// slugify reduces an arbitrary human string to a url-safe, lowercase token so an
// operator-chosen callable name becomes a valid public alias.
export function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

// slugifyModelRef derives a stable, url-safe public alias / id fragment from a
// model reference so two different quantizations never collapse to one alias
// while the same reference always yields the same slug.
export function slugifyModelRef(ref: string): string {
  return slugify(modelRefSegment(ref))
}

// buildCustomProfile constructs an inactive profile from an operator-supplied
// model reference. It carries the STABLE_PUBLIC_MODEL shared alias, starts
// deactivated with zero rollout so it never serves until an admin activates it,
// and sets split per the chosen serving mode. An optional name becomes the human
// display name (the serving-mode badge, not the name, carries single/split); when
// omitted it falls back to the model reference's last segment. The bind port
// advances past every existing profile so a later live process never collides on
// the mesh bind port. The profile ships with the MESHLLM_TUNABLE_DEFAULTS runtime
// tunables and an Auto (0) context window; an operator refines both per model.
export function buildCustomProfile(input: { modelRef: string; split: boolean; existing: readonly ModelProfile[]; name?: string | undefined; runtime?: RuntimeKind }): ModelProfile {
  const ref = input.modelRef.trim()
  const runtime = input.runtime ?? 'meshllm'
  const slug = slugifyModelRef(ref)
  const segment = modelRefSegment(ref)
  const name = input.name?.trim()
  const highestBindPort = input.existing.reduce((max, profile) => Math.max(max, profile.meshllm?.bindPort ?? profile.llamacpp?.bindPort ?? BIND_PORT_BASE), BIND_PORT_BASE)
  const bindPort = highestBindPort + BIND_PORT_STEP
  const common = {
    displayName: name && name.length > 0 ? name : segment,
    publicAliases: [STABLE_PUBLIC_MODEL, slug],
    upstreamModel: ref,
    version: 1,
    rolloutPercent: 0,
    active: false
  } as const
  if (runtime === 'llamacpp') {
    const parsed = parseLlamaCppModelRef(ref)
    return {
      id: `custom-${slug}-llamacpp`,
      ...common,
      sourceMode: 'llamacpp-hf',
      contextWindow: LLAMACPP_PROFILE_DEFAULTS.contextWindow,
      runtime,
      llamacpp: {
        modelRef: ref,
        hfRepo: parsed.hfRepo,
        ...(parsed.hfFile ? { hfFile: parsed.hfFile } : {}),
        ...(parsed.quant ? { quant: parsed.quant } : {}),
        bindPort,
        contextWindow: LLAMACPP_PROFILE_DEFAULTS.contextWindow,
        parallel: LLAMACPP_PROFILE_DEFAULTS.parallel,
        kvUnified: LLAMACPP_PROFILE_DEFAULTS.kvUnified,
        cachePrompt: LLAMACPP_PROFILE_DEFAULTS.cachePrompt,
        cacheReuse: LLAMACPP_PROFILE_DEFAULTS.cacheReuse,
        cacheTypeK: LLAMACPP_PROFILE_DEFAULTS.cacheTypeK,
        cacheTypeV: LLAMACPP_PROFILE_DEFAULTS.cacheTypeV,
        batch: LLAMACPP_PROFILE_DEFAULTS.batch,
        ubatch: LLAMACPP_PROFILE_DEFAULTS.ubatch,
        flashAttn: LLAMACPP_PROFILE_DEFAULTS.flashAttn,
        maxOutputTokens: LLAMACPP_PROFILE_DEFAULTS.maxOutputTokens,
        gpuLayers: LLAMACPP_PROFILE_DEFAULTS.gpuLayers,
        reasoning: { ...LLAMACPP_PROFILE_DEFAULTS.reasoning },
        alias: ref
      }
    }
  }
  const payloadMode = meshllmPayloadMode(ref)
  return {
    id: `custom-${slug}${input.split ? '-split' : ''}`,
    ...common,
    sourceMode: 'meshllm-ref',
    // 0 = Auto: mesh-llm sizes the context to the node's GPU instead of a pinned
    // small window that would collapse parallel lanes and disable input caching.
    contextWindow: 0,
    runtime,
    meshllm: {
      modelRef: ref,
      split: input.split,
      bindPort,
      parallel: MESHLLM_TUNABLE_DEFAULTS.parallel,
      cacheTypeK: MESHLLM_TUNABLE_DEFAULTS.cacheTypeK,
      cacheTypeV: MESHLLM_TUNABLE_DEFAULTS.cacheTypeV,
      batch: MESHLLM_TUNABLE_DEFAULTS.batch,
      ubatch: MESHLLM_TUNABLE_DEFAULTS.ubatch,
      flashAttn: MESHLLM_TUNABLE_DEFAULTS.flashAttn,
      maxOutputTokens: MESHLLM_TUNABLE_DEFAULTS.maxOutputTokens,
      reasoning: { ...MESHLLM_TUNABLE_DEFAULTS.reasoning },
      prefixCache: {
        ...MESHLLM_TUNABLE_DEFAULTS.prefixCache,
        ...(payloadMode ? { payloadMode } : {})
      }
    }
  }
}

function parseLlamaCppModelRef(ref: string): { readonly hfRepo: string; readonly hfFile?: string; readonly quant?: string } {
  const withoutScheme = ref.replace(/^hf:\/\//, '')
  const quantSeparator = withoutScheme.lastIndexOf(':')
  if (quantSeparator <= 0) return { hfRepo: withoutScheme }
  return {
    hfRepo: withoutScheme.slice(0, quantSeparator),
    quant: withoutScheme.slice(quantSeparator + 1)
  }
}

export function normalizeModelProfile(profile: ModelProfile): ModelProfile {
  const runtime = profile.runtime ?? 'meshllm'
  if (runtime === 'llamacpp' && profile.llamacpp) {
    const { meshllm: _meshllm, ...withoutMesh } = profile
    void _meshllm
    return {
      ...withoutMesh,
      runtime,
      sourceMode: 'llamacpp-hf',
      contextWindow: profile.contextWindow || profile.llamacpp.contextWindow,
      upstreamModel: profile.upstreamModel || profile.llamacpp.alias,
      llamacpp: {
        ...profile.llamacpp,
        alias: profile.llamacpp.alias || profile.upstreamModel,
        contextWindow: profile.llamacpp.contextWindow || profile.contextWindow || LLAMACPP_PROFILE_DEFAULTS.contextWindow,
        parallel: profile.llamacpp.parallel || LLAMACPP_PROFILE_DEFAULTS.parallel,
        cachePrompt: profile.llamacpp.cachePrompt !== false,
        // Stored blobs predating the field coerce to on, so deployed profiles regain
        // the full per-request context on the next heartbeat without a migration.
        kvUnified: profile.llamacpp.kvUnified !== false,
        cacheReuse: profile.llamacpp.cacheReuse ?? LLAMACPP_PROFILE_DEFAULTS.cacheReuse
      }
    }
  }
  return {
    ...profile,
    runtime: 'meshllm',
    sourceMode: 'meshllm-ref'
  }
}

// A default (shipped) profile re-seeds on boot, so it cannot be permanently deleted;
// deletion is reserved for custom onboarded models.
export function isDefaultModelId(profileId: string): boolean {
  return DEFAULT_MODEL_PROFILES.some((profile) => profile.id === profileId)
}

export const PROFILE_ANCHORS = {
  REQ_RUN_001: 'REQ-RUN-001',
  REQ_RUN_002: 'REQ-RUN-002',
  REQ_RUN_004: 'REQ-RUN-004'
} as const
