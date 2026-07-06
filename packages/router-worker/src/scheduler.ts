import type { EntrySelection, EntrySelectionRequest, ModelProfile, NodeRecord, Scheduler, Store } from './types'

const HEARTBEAT_TTL_MS = 45_000

export class StoreScheduler implements Scheduler {
  constructor(private readonly store: Store) {}

  // The router holds no live reservation state. It selects an eligible node and
  // forwards; mesh-llm owns dispatch, per-node concurrency, and KV-aware routing
  // across the peered mesh. REQ-SCH-002.
  async selectEntryNode(request: EntrySelectionRequest): Promise<EntrySelection> {
    const profile = await this.store.getProfileByPublicModel(request.publicModel)
    if (!profile) return { reason: 'no-profile' }
    const nodes = await this.store.listNodes(request.now)
    const selected = selectNode(eligibleNodes(nodes, profile, request.now))
    if (!selected) return { reason: 'no-node' }
    return { node: selected, profile }
  }
}

export function eligibleNodes(nodes: readonly NodeRecord[], profile: ModelProfile, now: number): readonly NodeRecord[] {
  return nodes.filter((node) => isEligible(node, profile, now))
}

export function isEligible(node: NodeRecord, profile: ModelProfile, now: number): boolean {
  if (node.status !== 'online') return false
  if (node.deactivated === true) return false
  if (now - node.lastSeenAt > HEARTBEAT_TTL_MS) return false
  if ((node.runtime as string) !== 'meshllm') return false
  if (!node.publicModels.some((model) => profile.publicAliases.includes(model))) return false
  if (!node.activeProfileIds.includes(profile.id)) return false
  const runtimeState = node.metrics?.runtimeState
  if (runtimeState !== 'ready' && runtimeState !== 'running') return false
  if (node.metrics?.apiReady !== true) return false
  if (node.metrics?.readyModels?.includes(profile.upstreamModel) !== true) return false
  if (!isSafeMeshTarget(node.meshIp, node.inferencePort)) return false
  return true
}

export function selectNode(nodes: readonly NodeRecord[]): NodeRecord | undefined {
  // Spread the entry pick toward the least busy ready node using the node-reported
  // active-request count; mesh-llm still owns cross-node dispatch once forwarded. REQ-SCH-002.
  return [...nodes].sort((left, right) => {
    const leftActive = left.metrics?.activeRequests ?? 0
    const rightActive = right.metrics?.activeRequests ?? 0
    if (leftActive !== rightActive) return leftActive - rightActive
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

export const SCHEDULER_ANCHORS = {
  REQ_SCH_002: 'REQ-SCH-002',
  REQ_SCH_003: 'REQ-SCH-003',
  REQ_RTR_004: 'REQ-RTR-004'
} as const
