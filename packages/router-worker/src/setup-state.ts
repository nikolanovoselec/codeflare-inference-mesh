import { hashToken } from './auth'
import type { RouterEnv, Store } from './types'

export type SetupPhase = 'unclaimed' | 'claimed' | 'domain_ready' | 'access_ready' | 'complete'

export interface SetupStateRecord {
  readonly phase?: SetupPhase
  readonly claimedAt?: number
  readonly completedAt?: number
}

export interface AccessConfigRecord {
  readonly teamDomain: string
  readonly audience: string
  readonly appId: string
  readonly bypassAppId: string
  readonly adminEmails: readonly string[]
  readonly adminGroups: readonly string[]
  readonly userEmails: readonly string[]
  readonly userGroups: readonly string[]
  readonly usersOpen: boolean
}

export const SETUP_STATE_KEY = 'setup_state'
export const ACCESS_CONFIG_KEY = 'access_config'
export const SETUP_REOPEN_CONSUMED_KEY = 'setup_reopen_consumed'
export const SETUP_REOPEN_SEEN_KEY = 'setup_reopen_seen'

export async function setupPhase(store: Store): Promise<SetupPhase> {
  const record = await store.getConfig<SetupStateRecord>(SETUP_STATE_KEY)
  if (!record) return 'unclaimed'
  if (record.phase) return record.phase
  // Legacy records predate the domain/access phases: a claimed deployment, not a completed one.
  return record.completedAt !== undefined || record.claimedAt !== undefined ? 'claimed' : 'unclaimed'
}

export async function advancePhase(store: Store, phase: SetupPhase, patch: Partial<SetupStateRecord> = {}): Promise<void> {
  const existing = await store.getConfig<SetupStateRecord>(SETUP_STATE_KEY)
  await store.putConfig(SETUP_STATE_KEY, { ...existing, phase, ...patch })
}

export async function accessConfig(store: Store): Promise<AccessConfigRecord | undefined> {
  return await store.getConfig<AccessConfigRecord>(ACCESS_CONFIG_KEY)
}

/** True while the reopen secret is set and its digest has not been recorded as consumed. */
export async function breakGlassActive(store: Store, env: Partial<RouterEnv>): Promise<boolean> {
  if (!env.SETUP_REOPEN) return false
  return (await store.getConfig<string>(SETUP_REOPEN_CONSUMED_KEY)) !== await hashToken(env.SETUP_REOPEN)
}

export const SETUP_STATE_ANCHORS = {
  REQ_ADM_013: 'REQ-ADM-013',
  REQ_ADM_014: 'REQ-ADM-014'
} as const
