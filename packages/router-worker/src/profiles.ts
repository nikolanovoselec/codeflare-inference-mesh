import type { ModelProfile } from './types'

export const DEFAULT_MODEL_PROFILES: readonly ModelProfile[] = [
  {
    id: 'mesh-default-qwen36-35b',
    publicAliases: ['mesh-default', 'qwen3.6:35b-a3b', 'qwen3.6-coder'],
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
    rolloutPercent: 100,
    active: true
  },
  {
    id: 'mesh-split-qwen36-35b',
    publicAliases: ['mesh-default', 'qwen3.6:35b-a3b', 'qwen3.6-coder'],
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
    publicAliases: ['mesh-smoke', 'smoke-test'],
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

export const PROFILE_ANCHORS = {
  REQ_RUN_001: 'REQ-RUN-001',
  REQ_RUN_002: 'REQ-RUN-002',
  REQ_RUN_004: 'REQ-RUN-004'
} as const
