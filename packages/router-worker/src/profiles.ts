import type { ModelProfile } from './types'

export const DEFAULT_MODEL_PROFILES: readonly ModelProfile[] = [
  {
    id: 'qwen36-27b-256k-3090',
    publicAliases: ['mesh-default', 'qwen3.6-coder', 'qwen36-27b'],
    upstreamModel: 'qwen36-27b-256k-3090',
    hfSpecifier: 'Qwen/Qwen3.6-27B-GGUF:qwen3.6-27b-q4_k_m.gguf',
    localFilename: 'qwen3.6-27b-q4_k_m.gguf',
    llamaServerModelArg: 'qwen3.6-27b-q4_k_m.gguf',
    contextWindow: 262144,
    runtime: 'llama.cpp',
    runtimeCommand: {
      executable: 'llama-server',
      args: ['--model', 'qwen3.6-27b-q4_k_m.gguf', '--ctx-size', '262144', '--host', '0.0.0.0'],
      env: { LLAMA_ARG_THREADS: 'auto' }
    },
    version: 1,
    rolloutPercent: 100,
    active: true
  },
  {
    id: 'gemma4-26b-a4b-256k-3090',
    publicAliases: ['gemma4-26b-a4b', 'mesh-benchmark'],
    upstreamModel: 'gemma4-26b-a4b-256k-3090',
    hfSpecifier: 'google/gemma-4-26b-a4b-it-GGUF:gemma-4-26b-a4b-q4_k_m.gguf',
    localFilename: 'gemma-4-26b-a4b-q4_k_m.gguf',
    llamaServerModelArg: 'gemma-4-26b-a4b-q4_k_m.gguf',
    contextWindow: 262144,
    runtime: 'llama.cpp',
    runtimeCommand: {
      executable: 'llama-server',
      args: ['--model', 'gemma-4-26b-a4b-q4_k_m.gguf', '--ctx-size', '262144', '--host', '0.0.0.0'],
      env: { LLAMA_ARG_THREADS: 'auto' }
    },
    version: 1,
    rolloutPercent: 100,
    active: true
  },
  {
    id: 'small-smoke-test-32k',
    publicAliases: ['mesh-smoke', 'smoke-test'],
    upstreamModel: 'small-smoke-test-32k',
    hfSpecifier: 'Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF:qwen2.5-coder-1.5b-instruct-q4_k_m.gguf',
    localFilename: 'qwen2.5-coder-1.5b-instruct-q4_k_m.gguf',
    llamaServerModelArg: 'qwen2.5-coder-1.5b-instruct-q4_k_m.gguf',
    contextWindow: 32768,
    runtime: 'llama.cpp',
    runtimeCommand: {
      executable: 'llama-server',
      args: ['--model', 'qwen2.5-coder-1.5b-instruct-q4_k_m.gguf', '--ctx-size', '32768', '--host', '0.0.0.0'],
      env: { LLAMA_ARG_THREADS: 'auto' }
    },
    version: 1,
    rolloutPercent: 100,
    active: true
  }
]

export function validateProfile(profile: ModelProfile): string[] {
  const errors: string[] = []
  if (!profile.id) errors.push('profile id is required')
  if (profile.publicAliases.length === 0) errors.push('at least one public alias is required')
  if (!profile.hfSpecifier.includes(':')) errors.push('hfSpecifier must include repository and filename')
  if (!profile.llamaServerModelArg) errors.push('llamaServerModelArg is required')
  if (profile.contextWindow < 32768) errors.push('context window must be at least 32768')
  if (profile.rolloutPercent < 0 || profile.rolloutPercent > 100) errors.push('rollout percent must be 0..100')
  return errors
}

export function publicAliasIndex(profiles: readonly ModelProfile[]): Map<string, ModelProfile> {
  const index = new Map<string, ModelProfile>()
  for (const profile of profiles) {
    if (!profile.active) continue
    for (const alias of profile.publicAliases) index.set(alias, profile)
  }
  return index
}

export const PROFILE_ANCHORS = {
  REQ_RUN_001: 'REQ-RUN-001',
  REQ_RUN_002: 'REQ-RUN-002',
  REQ_RUN_003: 'REQ-RUN-003',
  REQ_RUN_004: 'REQ-RUN-004'
} as const
