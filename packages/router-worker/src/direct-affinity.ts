import { selectNode } from './scheduler'
import type { DirectSessionRecord, NodeRecord, Store } from './types'

export const DIRECT_SESSION_TTL_MS = 24 * 60 * 60 * 1000

export type DirectAffinityOutcome = 'pinned' | 'reused' | 'failed_over'

export interface DirectSessionDecisionRequest {
  readonly affinityKey: string
  readonly profileId: string
  readonly publicModel: string
  readonly userHash: string
  readonly sessionHash: string
  readonly candidates: readonly NodeRecord[]
  readonly now: number
}

export interface DirectSessionDecision {
  readonly node?: NodeRecord
  readonly affinity?: DirectAffinityOutcome
  readonly session?: DirectSessionRecord
  readonly reason?: 'no-node'
}

export function directSessionKey(publicModel: string, profileId: string, sessionHash: string): string {
  return `${publicModel}|${profileId}|${sessionHash}`
}

export async function decideDirectSession(store: Store, request: DirectSessionDecisionRequest): Promise<DirectSessionDecision> {
  const existing = await store.getDirectSession(request.affinityKey)
  const eligibleById = new Map(request.candidates.map((node) => [node.id, node]))
  if (existing && existing.expiresAt > request.now) {
    const pinned = eligibleById.get(existing.nodeId)
    if (pinned) {
      const refreshed = { ...existing, updatedAt: request.now, expiresAt: request.now + DIRECT_SESSION_TTL_MS }
      await store.putDirectSession(refreshed)
      return { node: pinned, affinity: 'reused', session: refreshed }
    }
  }

  const selected = selectNode(request.candidates)
  if (!selected) return { reason: 'no-node' }

  const failedOver = Boolean(existing && existing.expiresAt > request.now && existing.nodeId !== selected.id)
  const next: DirectSessionRecord = {
    affinityKey: request.affinityKey,
    profileId: request.profileId,
    publicModel: request.publicModel,
    nodeId: selected.id,
    userHash: request.userHash,
    sessionHash: request.sessionHash,
    createdAt: existing?.createdAt ?? request.now,
    updatedAt: request.now,
    expiresAt: request.now + DIRECT_SESSION_TTL_MS,
    failoverCount: (existing?.failoverCount ?? 0) + (failedOver ? 1 : 0)
  }
  await store.putDirectSession(next)
  return { node: selected, affinity: failedOver ? 'failed_over' : 'pinned', session: next }
}

export const DIRECT_AFFINITY_ANCHORS = {
  REQ_SCH_006: 'REQ-SCH-006'
} as const
