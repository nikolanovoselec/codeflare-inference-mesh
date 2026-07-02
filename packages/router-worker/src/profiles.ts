import type { ModelProfile } from './types'

export const DEFAULT_MODEL_PROFILES: readonly ModelProfile[] = [
  {
    id: 'qwen36-35b-a3b-262k-mm-3090',
    publicAliases: ['mesh-default', 'qwen3.6:35b-a3b', 'qwen3.6-coder'],
    upstreamModel: 'qwen36-35b-a3b-262k-mm-3090',
    sourceMode: 'llama-hf',
    hfSpecifier: 'unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ3_S',
    contextWindow: 262144,
    runtime: 'llama.cpp',
    runtimeCommand: {
      executable: 'llama-server',
      args: [
        '-hf', 'unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ3_S',
        '-ngl', '99',
        '-c', '262144',
        '-np', '1',
        '-b', '8192',
        '-ub', '4096',
        '-fa', 'on',
        '--cache-type-k', 'q4_0',
        '--cache-type-v', 'q4_0',
        '--mmproj-auto',
        '--alias', 'mesh-default,qwen3.6:35b-a3b,qwen3.6-coder',
        '-n', '16384',
        '--reasoning', 'on',
        '--reasoning-format', 'deepseek',
        '--reasoning-budget', '8192',
        '--host', '{{HOST}}',
        '--port', '{{PORT}}'
      ],
      env: { LLAMA_CACHE: '{{DATA_DIR}}/llama.cpp-cache', CUDA_VISIBLE_DEVICES: '0' }
    },
    version: 1,
    rolloutPercent: 100,
    active: true
  },
  {
    id: 'qwen36-35b-a3b-262k-text-3090',
    publicAliases: ['mesh-text', 'qwen3.6:35b-a3b-text'],
    upstreamModel: 'qwen36-35b-a3b-262k-text-3090',
    sourceMode: 'llama-hf',
    hfSpecifier: 'unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ3_S',
    contextWindow: 262144,
    runtime: 'llama.cpp',
    runtimeCommand: {
      executable: 'llama-server',
      args: [
        '-hf', 'unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ3_S',
        '-ngl', '99',
        '-c', '262144',
        '-np', '1',
        '-b', '8192',
        '-ub', '4096',
        '-fa', 'on',
        '--cache-type-k', 'q4_0',
        '--cache-type-v', 'q4_0',
        '--no-mmproj',
        '--alias', 'mesh-text,qwen3.6:35b-a3b-text',
        '-n', '16384',
        '--reasoning', 'on',
        '--reasoning-format', 'deepseek',
        '--reasoning-budget', '8192',
        '--host', '{{HOST}}',
        '--port', '{{PORT}}'
      ],
      env: { LLAMA_CACHE: '{{DATA_DIR}}/llama.cpp-cache', CUDA_VISIBLE_DEVICES: '0' }
    },
    version: 1,
    rolloutPercent: 0,
    active: false
  },
  {
    id: 'small-smoke-test-32k',
    publicAliases: ['mesh-smoke', 'smoke-test'],
    upstreamModel: 'small-smoke-test-32k',
    sourceMode: 'direct-gguf',
    hfSpecifier: 'Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF:qwen2.5-coder-1.5b-instruct-q4_k_m.gguf',
    downloadUrl: 'https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF/resolve/main/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf',
    localFilename: 'qwen2.5-coder-1.5b-instruct-q4_k_m.gguf',
    contextWindow: 32768,
    runtime: 'llama.cpp',
    runtimeCommand: {
      executable: 'llama-server',
      args: [
        '--model', '{{MODEL_PATH}}',
        '--ctx-size', '32768',
        '-np', '1',
        '-b', '2048',
        '-ub', '512',
        '--alias', 'mesh-smoke,smoke-test',
        '--host', '{{HOST}}',
        '--port', '{{PORT}}'
      ],
      env: { LLAMA_CACHE: '{{DATA_DIR}}/llama.cpp-cache' }
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
  if (profile.sourceMode !== 'llama-hf' && profile.sourceMode !== 'direct-gguf') errors.push('sourceMode must be llama-hf or direct-gguf')
  if (profile.sourceMode === 'llama-hf' && !profile.hfSpecifier) errors.push('llama-hf profiles require hfSpecifier')
  if (profile.sourceMode === 'direct-gguf' && (!profile.downloadUrl || !profile.localFilename)) errors.push('direct-gguf profiles require downloadUrl and localFilename')
  if (profile.contextWindow < 32768) errors.push('context window must be at least 32768')
  if (profile.rolloutPercent < 0 || profile.rolloutPercent > 100) errors.push('rollout percent must be 0..100')
  if (profile.runtimeCommand.executable !== 'llama-server') errors.push('runtimeCommand executable must be llama-server')
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
