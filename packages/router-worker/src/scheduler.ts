import type { ModelProfile, NodeRecord, ReservationRecord, ReservationRequest, ReservationResult, Scheduler, Store } from './types'

const SESSION_TTL_MS = 24 * 60 * 60 * 1000
const RESERVATION_TTL_MS = 30 * 60 * 1000
const HEARTBEAT_TTL_MS = 45_000
const FAILURE_PENALTY_MS = 30_000

export class StoreScheduler implements Scheduler {
  constructor(private readonly store: Store, private readonly requestId: () => string = randomId) {}

  async reserve(request: ReservationRequest): Promise<ReservationResult> {
    const profile = await this.store.getProfileByPublicModel(request.publicModel)
    if (!profile) return { reason: 'no-profile' }

    const sticky = await this.store.getSession(request.sessionId)
    const stickyNode = sticky && sticky.expiresAt > request.now ? await this.store.getNode(sticky.nodeId) : undefined
    const nodes = await this.store.listNodes(request.now)
    const eligible = eligibleNodes(nodes, profile, request.now)
    const selected = stickyNode && isEligible(stickyNode, profile, request.now) ? stickyNode : selectNode(eligible)
    if (!selected) return { reason: 'no-node' }

    const reservation: ReservationRecord = {
      reservationId: this.requestId(),
      nodeId: selected.id,
      sessionId: request.sessionId,
      publicModel: request.publicModel,
      profileId: profile.id,
      upstreamModel: profile.upstreamModel,
      expiresAt: request.now + RESERVATION_TTL_MS
    }
    await this.store.putReservation(reservation)
    await this.store.putSession({
      sessionId: request.sessionId,
      nodeId: selected.id,
      publicModel: request.publicModel,
      profileId: profile.id,
      upstreamModel: profile.upstreamModel,
      expiresAt: request.now + SESSION_TTL_MS
    })
    await this.store.upsertNode({ ...selected, inFlight: selected.inFlight + 1 })
    return { reservation, node: selected, profile }
  }

  async release(reservationId: string, now: number): Promise<void> {
    await this.finishReservation(reservationId, now)
  }

  async recordFailure(reservationId: string, now: number): Promise<void> {
    await this.finishReservation(reservationId, now, FAILURE_PENALTY_MS)
  }

  private async finishReservation(reservationId: string, now: number, failurePenaltyMs = 0): Promise<void> {
    const reservation = await this.store.getReservation(reservationId)
    await this.store.releaseReservation(reservationId, now)
    if (!reservation || reservation.releasedAt !== undefined) return
    const node = await this.store.getNode(reservation.nodeId)
    if (!node) return
    await this.store.upsertNode({
      ...node,
      inFlight: Math.max(0, node.inFlight - 1),
      ...(failurePenaltyMs > 0 ? { failurePenaltyUntil: now + failurePenaltyMs } : {})
    })
  }
}

export class DurableSchedulerClient implements Scheduler {
  constructor(private readonly namespace: DurableObjectNamespace) {}

  async reserve(request: ReservationRequest): Promise<ReservationResult> {
    const stub = this.namespace.get(this.namespace.idFromName('global'))
    const response = await stub.fetch('https://registry/reserve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request)
    })
    return await response.json() as ReservationResult
  }

  async release(reservationId: string, now: number): Promise<void> {
    await this.postReservationUpdate('/release', reservationId, now)
  }

  async recordFailure(reservationId: string, now: number): Promise<void> {
    await this.postReservationUpdate('/failure', reservationId, now)
  }

  private async postReservationUpdate(path: string, reservationId: string, now: number): Promise<void> {
    const stub = this.namespace.get(this.namespace.idFromName('global'))
    await stub.fetch(`https://registry${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reservationId, now })
    })
  }
}

export function eligibleNodes(nodes: readonly NodeRecord[], profile: ModelProfile, now: number): readonly NodeRecord[] {
  return nodes.filter((node) => isEligible(node, profile, now))
}

export function isEligible(node: NodeRecord, profile: ModelProfile, now: number): boolean {
  if (node.status !== 'online') return false
  if (now - node.lastSeenAt > HEARTBEAT_TTL_MS) return false
  if (node.failurePenaltyUntil !== undefined && node.failurePenaltyUntil > now) return false
  if (!node.publicModels.some((model) => profile.publicAliases.includes(model))) return false
  if (!node.activeProfileIds.includes(profile.id)) return false
  const runtimeState = node.metrics?.runtimeState
  if (runtimeState !== 'ready' && runtimeState !== 'running') return false
  const loadedModel = node.metrics?.loadedModel ?? node.runtimeModel
  if (loadedModel !== profile.upstreamModel) return false
  if (node.runtimeModel !== undefined && node.runtimeModel !== profile.upstreamModel) return false
  if (node.inFlight >= node.capacity) return false
  if (!isSafeMeshTarget(node.meshIp, node.inferencePort)) return false
  return true
}

export function selectNode(nodes: readonly NodeRecord[]): NodeRecord | undefined {
  return [...nodes].sort((left, right) => {
    const leftScore = left.inFlight / Math.max(left.capacity, 1)
    const rightScore = right.inFlight / Math.max(right.capacity, 1)
    if (leftScore !== rightScore) return leftScore - rightScore
    return right.lastSeenAt - left.lastSeenAt
  })[0]
}

export function isSafeMeshTarget(meshIp: string, port: number): boolean {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false
  if (/^https?:\/\//i.test(meshIp)) return false
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(meshIp)) return false
  const octets = meshIp.split('.').map((item) => Number(item))
  if (octets.some((item) => !Number.isInteger(item) || item < 0 || item > 255)) return false
  const [a = 0, b = 0] = octets
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
}

export function meshUrl(node: NodeRecord, path: string): string {
  if (!isSafeMeshTarget(node.meshIp, node.inferencePort)) throw new Error('unsafe mesh destination')
  return `http://${node.meshIp}:${node.inferencePort}${path}`
}

function randomId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export const SCHEDULER_ANCHORS = {
  REQ_SCH_002: 'REQ-SCH-002',
  REQ_SCH_003: 'REQ-SCH-003',
  REQ_SCH_004: 'REQ-SCH-004',
  REQ_RTR_004: 'REQ-RTR-004'
} as const
