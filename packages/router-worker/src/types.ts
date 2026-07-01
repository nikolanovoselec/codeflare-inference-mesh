export type CredentialKind = 'provider' | 'admin' | 'setup' | 'node' | 'upstream'

export type NodeStatus = 'online' | 'offline' | 'draining' | 'revoked'

export interface TokenRecord {
  readonly id: string
  readonly kind: CredentialKind
  readonly verifier: string
  readonly active: boolean
  readonly nodeId?: string
  readonly createdAt: number
  readonly expiresAt?: number
}

export interface RuntimeCommand {
  readonly executable: 'llama-server'
  readonly args: readonly string[]
  readonly env: Record<string, string>
}

export interface ModelProfile {
  readonly id: string
  readonly publicAliases: readonly string[]
  readonly upstreamModel: string
  readonly hfSpecifier: string
  readonly localFilename: string
  readonly sha256?: string
  readonly llamaServerModelArg: string
  readonly contextWindow: number
  readonly runtime: 'llama.cpp'
  readonly runtimeCommand: RuntimeCommand
  readonly version: number
  readonly rolloutPercent: number
  readonly active: boolean
}

export interface NodeMetrics {
  readonly gpuName?: string
  readonly gpuMemoryUsedMiB?: number
  readonly gpuMemoryTotalMiB?: number
  readonly runtimeState: string
  readonly loadedModel?: string
  readonly activeRequests: number
  readonly tokensPerSecond?: number
}

export interface NodeRecord {
  readonly id: string
  readonly displayName: string
  readonly meshIp: string
  readonly inferencePort: number
  readonly localDashboardPort: number
  readonly status: NodeStatus
  readonly publicModels: readonly string[]
  readonly activeProfileIds: readonly string[]
  readonly capacity: number
  readonly inFlight: number
  readonly lastSeenAt: number
  readonly failurePenaltyUntil?: number
  readonly runtime: 'llama.cpp'
  readonly runtimeModel?: string
  readonly nodeTokenVerifier?: string
  readonly upstreamTokenVerifier?: string
  readonly metrics?: NodeMetrics
}

export interface SessionRecord {
  readonly sessionId: string
  readonly nodeId: string
  readonly publicModel: string
  readonly profileId: string
  readonly upstreamModel: string
  readonly expiresAt: number
}

export interface ReservationRecord {
  readonly reservationId: string
  readonly nodeId: string
  readonly sessionId: string
  readonly publicModel: string
  readonly profileId: string
  readonly upstreamModel: string
  readonly expiresAt: number
  readonly releasedAt?: number
}

export interface AuditEvent {
  readonly id: string
  readonly type: string
  readonly at: number
  readonly actor: string
  readonly target?: string
  readonly detail: Record<string, unknown>
}

export interface ClaimRequest {
  readonly displayName: string
  readonly meshIp: string
  readonly inferencePort: number
  readonly publicModels: readonly string[]
  readonly activeProfileIds: readonly string[]
  readonly capacity: number
}

export interface HeartbeatRequest {
  readonly nodeId: string
  readonly displayName: string
  readonly meshIp: string
  readonly inferencePort: number
  readonly localDashboardPort: number
  readonly status: NodeStatus
  readonly publicModels: readonly string[]
  readonly activeProfileIds: readonly string[]
  readonly capacity: number
  readonly inFlight: number
  readonly runtime: 'llama.cpp'
  readonly runtimeModel?: string
  readonly metrics?: NodeMetrics
}

export interface ReservationRequest {
  readonly publicModel: string
  readonly sessionId: string
  readonly now: number
}

export interface ReservationResult {
  readonly reservation?: ReservationRecord
  readonly node?: NodeRecord
  readonly profile?: ModelProfile
  readonly reason?: 'no-profile' | 'no-node'
}

export interface Store {
  seedDefaultProfiles(profiles: readonly ModelProfile[]): Promise<void>
  getProfileByPublicModel(publicModel: string): Promise<ModelProfile | undefined>
  listProfiles(): Promise<readonly ModelProfile[]>
  setProfile(profile: ModelProfile): Promise<void>
  setActiveProfile(profileId: string, rolloutPercent: number): Promise<void>
  listNodes(now: number): Promise<readonly NodeRecord[]>
  getNode(nodeId: string): Promise<NodeRecord | undefined>
  upsertNode(node: NodeRecord): Promise<void>
  updateNodeHeartbeat(node: NodeRecord): Promise<void>
  revokeNode(nodeId: string, now: number): Promise<void>
  getSession(sessionId: string): Promise<SessionRecord | undefined>
  putSession(session: SessionRecord): Promise<void>
  putReservation(reservation: ReservationRecord): Promise<void>
  getReservation(reservationId: string): Promise<ReservationRecord | undefined>
  releaseReservation(reservationId: string, now: number): Promise<void>
  getToken(kind: CredentialKind, id: string): Promise<TokenRecord | undefined>
  putToken(token: TokenRecord): Promise<void>
  revokeToken(kind: CredentialKind, id: string, now: number): Promise<void>
  listTokens(kind?: CredentialKind): Promise<readonly TokenRecord[]>
  putConfig(key: string, value: unknown): Promise<void>
  getConfig<T>(key: string): Promise<T | undefined>
  appendAudit(event: AuditEvent): Promise<void>
  listAudit(limit: number): Promise<readonly AuditEvent[]>
}

export interface Scheduler {
  reserve(request: ReservationRequest): Promise<ReservationResult>
  release(reservationId: string, now: number): Promise<void>
}

export interface RouterEnv {
  readonly DB: D1Database
  readonly REGISTRY: DurableObjectNamespace
  readonly MESH: Fetcher
  readonly ROUTER_PROVIDER_TOKEN?: string
  readonly ADMIN_TOKEN?: string
  readonly NODE_UPSTREAM_TOKEN?: string
  readonly CLOUDFLARE_API_TOKEN_RUNTIME?: string
  readonly CLOUDFLARE_ACCOUNT_ID?: string
  readonly AI_GATEWAY_ACCOUNT_ID?: string
  readonly AI_GATEWAY_ID?: string
  readonly WORKER_BASE_URL?: string
  readonly GITHUB_REPOSITORY?: string
  readonly AGENT_RELEASE_TAG?: string
  readonly MAX_REQUEST_BYTES?: string
  readonly HEARTBEAT_TTL_SECONDS?: string
}
