import { nodeMeshId, profileMeshId } from './profiles'
import type { EntrySelection, EntrySelectionRequest, ModelProfile, NodeRecord, RouterEnv, Scheduler, Store } from './types'

const HEARTBEAT_TTL_MS = 45_000
const DEFAULT_MESH_CIDRS = ['100.64.0.0/10']
const DEFAULT_MESH_PORTS = [8080, 11434]

export class StoreScheduler implements Scheduler {
  constructor(private readonly store: Store, private readonly env: Pick<RouterEnv, 'MESH_ALLOWED_CIDRS' | 'MESH_ALLOWED_PORTS'> = {}) {}

  // The router holds no live reservation state. It selects an eligible node and
  // forwards; mesh-llm owns dispatch, per-node concurrency, and KV-aware routing
  // across the peered mesh. REQ-SCH-002.
  async selectEntryNode(request: EntrySelectionRequest): Promise<EntrySelection> {
    const profile = await this.store.getProfileByPublicModel(request.publicModel)
    if (!profile) return { reason: 'no-profile' }
    const nodes = await this.store.listNodes(request.now)
    const selected = selectNode(eligibleNodes(nodes, profile, request.now, this.env))
    if (!selected) return { reason: 'no-node' }
    return { node: selected, profile }
  }
}

export function eligibleNodes(nodes: readonly NodeRecord[], profile: ModelProfile, now: number, env: Pick<RouterEnv, 'MESH_ALLOWED_CIDRS' | 'MESH_ALLOWED_PORTS'> = {}): readonly NodeRecord[] {
  return nodes.filter((node) => isEligible(node, profile, now, env))
}

export function eligibleDirectNodes(nodes: readonly NodeRecord[], profile: ModelProfile, publicModel: string, now: number, env: Pick<RouterEnv, 'MESH_ALLOWED_CIDRS' | 'MESH_ALLOWED_PORTS'> = {}): readonly NodeRecord[] {
  return nodes.filter((node) => isDirectEligible(node, profile, publicModel, now, env))
}

export function isEligible(node: NodeRecord, profile: ModelProfile, now: number, env: Pick<RouterEnv, 'MESH_ALLOWED_CIDRS' | 'MESH_ALLOWED_PORTS'> = {}): boolean {
  if (profile.runtime !== 'meshllm') return false
  // Mesh membership is router authority (REQ-SCH-006): a node self-reporting a
  // foreign profile id must never serve another mesh's model.
  if (nodeMeshId(node) !== profileMeshId(profile)) return false
  if (node.status !== 'online') return false
  if (node.deactivated === true) return false
  if (now - node.lastSeenAt > HEARTBEAT_TTL_MS) return false
  if (node.runtime !== 'meshllm') return false
  if (!node.publicModels.some((model) => profile.publicAliases.includes(model))) return false
  if (!node.activeProfileIds.includes(profile.id)) return false
  const runtimeState = node.metrics?.runtimeState
  if (runtimeState !== 'ready' && runtimeState !== 'running') return false
  if (node.metrics?.apiReady !== true) return false
  if (node.metrics?.readyModels?.includes(profile.upstreamModel) !== true) return false
  if (!isSafeMeshTarget(node.meshIp, node.inferencePort, env)) return false
  return true
}

export function isDirectEligible(node: NodeRecord, profile: ModelProfile, publicModel: string, now: number, env: Pick<RouterEnv, 'MESH_ALLOWED_CIDRS' | 'MESH_ALLOWED_PORTS'> = {}): boolean {
  if (profile.runtime !== 'llamacpp') return false
  if (nodeMeshId(node) !== profileMeshId(profile)) return false
  if (node.status !== 'online') return false
  if (node.deactivated === true) return false
  if (now - node.lastSeenAt > HEARTBEAT_TTL_MS) return false
  if (node.runtime !== 'llamacpp') return false
  if (!node.publicModels.includes(publicModel)) return false
  if (!node.activeProfileIds.includes(profile.id)) return false
  const runtimeState = node.metrics?.runtimeState
  if (runtimeState !== 'ready' && runtimeState !== 'running') return false
  if (node.metrics?.apiReady !== true) return false
  if (node.metrics?.readyModels?.includes(profile.upstreamModel) !== true) return false
  if (!isSafeMeshTarget(node.meshIp, node.inferencePort, env)) return false
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

export function isSafeMeshTarget(meshIp: string, port: number, env: Pick<RouterEnv, 'MESH_ALLOWED_CIDRS' | 'MESH_ALLOWED_PORTS'> = {}): boolean {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false
  if (!allowedMeshPorts(env).includes(port)) return false
  if (/^https?:\/\//i.test(meshIp)) return false
  const address = ipv4ToNumber(meshIp)
  if (address === undefined) return false
  return allowedMeshCidrs(env).some((cidr) => cidrContains(cidr, address))
}

export function meshUrl(node: NodeRecord, path: string, env: Pick<RouterEnv, 'MESH_ALLOWED_CIDRS' | 'MESH_ALLOWED_PORTS'> = {}): string {
  if (!isSafeMeshTarget(node.meshIp, node.inferencePort, env)) throw new Error('unsafe mesh destination')
  return `http://${node.meshIp}:${node.inferencePort}${path}`
}

function allowedMeshPorts(env: Pick<RouterEnv, 'MESH_ALLOWED_PORTS'>): readonly number[] {
  const configured = env.MESH_ALLOWED_PORTS?.split(',').map((item) => Number(item.trim())).filter((item) => Number.isInteger(item) && item >= 1 && item <= 65535) ?? []
  return configured.length > 0 ? configured : DEFAULT_MESH_PORTS
}

function allowedMeshCidrs(env: Pick<RouterEnv, 'MESH_ALLOWED_CIDRS'>): readonly string[] {
  const configured = env.MESH_ALLOWED_CIDRS?.split(',').map((item) => item.trim()).filter((item) => item.length > 0) ?? []
  return configured.length > 0 ? configured : DEFAULT_MESH_CIDRS
}

function ipv4ToNumber(value: string): number | undefined {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return undefined
  const octets = value.split('.').map((item) => Number(item))
  if (octets.some((item) => !Number.isInteger(item) || item < 0 || item > 255)) return undefined
  return (((octets[0]! << 24) >>> 0) + (octets[1]! << 16) + (octets[2]! << 8) + octets[3]!) >>> 0
}

function cidrContains(cidr: string, address: number): boolean {
  const [base, prefixText] = cidr.split('/')
  const baseAddress = base ? ipv4ToNumber(base) : undefined
  const prefix = prefixText === undefined ? 32 : Number(prefixText)
  if (baseAddress === undefined || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  return (address & mask) === (baseAddress & mask)
}

export const SCHEDULER_ANCHORS = {
  REQ_SCH_002: 'REQ-SCH-002',
  REQ_SCH_003: 'REQ-SCH-003',
  REQ_RTR_004: 'REQ-RTR-004'
} as const
