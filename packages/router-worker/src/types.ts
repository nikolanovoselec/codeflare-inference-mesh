export type CredentialKind = 'provider' | 'admin' | 'setup' | 'node' | 'upstream' | 'automation'

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

export type ModelSourceMode = 'meshllm-ref'

export interface ModelProfile {
  readonly id: string
  readonly displayName: string
  readonly publicAliases: readonly string[]
  readonly upstreamModel: string
  readonly sourceMode: ModelSourceMode
  readonly contextWindow: number
  readonly runtime: 'meshllm'
  readonly meshllm: {
    readonly modelRef: string
    readonly split: boolean
    readonly bindPort: number
    readonly maxVramGb?: number
    // Per-model mesh-llm runtime tunables (REQ-RUN-002 / REQ-RUN-003). Each maps
    // to a mesh-llm config key and is optional: an omitted value means "Auto" and
    // is not rendered into the node config, so mesh-llm auto-plans it. An omitted
    // parallel does NOT auto-plan to 4 lanes; mesh-llm may pick a single lane, which
    // keeps the resident prefix cache out of its unified-KV mode, so 2 or more is
    // required for input caching to run.
    readonly parallel?: number
    readonly cacheTypeK?: string
    readonly cacheTypeV?: string
    readonly batch?: number
    readonly ubatch?: number
    readonly flashAttn?: boolean
    readonly maxOutputTokens?: number
    readonly reasoning?: {
      readonly enabled?: boolean
      readonly format?: string
      readonly budget?: number
    }
    // Prompt-prefix cache. This is what populates prompt_tokens_details.cached_tokens; it
    // is NOT enabled by parallel. maxEntries is capped low (16): the uncertified fallback of
    // 128 overruns the KV cell pool. payloadMode is load-bearing for recurrent-hybrid
    // families (qwen35, qwen3-next, falcon-h1): left Auto, mesh-llm picks resident-kv (the
    // wrong layout) and the cache silently no-ops, so those must pin `kv-recurrent`.
    readonly prefixCache?: {
      readonly enabled?: boolean
      readonly maxEntries?: number
      readonly payloadMode?: string
      readonly sharedStrideTokens?: number
      readonly sharedRecordLimit?: number
    }
  }
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
  readonly promptTokensPerSecond?: number
  readonly generationTokensPerSecond?: number
  readonly loadedProfileId?: string
  readonly loadedProfileVersion?: number
  readonly meshId?: string
  readonly meshRole?: 'coordinator' | 'serving-peer' | 'api-client'
  readonly peerCount?: number
  readonly readyModels?: readonly string[]
  readonly splitEnabled?: boolean
  readonly stageCount?: number
  readonly apiReady?: boolean
  readonly consoleReady?: boolean
  readonly meshllmVersion?: string
  readonly lastError?: string
  /** Most recent error-looking line from mesh-llm's own stderr (REQ-OBS-011), and the console's raw node_state, so the console can show why a runtime is wedged. */
  readonly runtimeDetail?: string
  readonly nodeState?: string
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
  readonly runtime: 'meshllm'
  readonly runtimeModel?: string
  readonly agentVersion?: string
  readonly nodeTokenVerifier?: string
  readonly upstreamTokenVerifier?: string
  readonly metrics?: NodeMetrics
  /** Per-node VRAM budget in GB that overrides the model's global maxVramGb for this node (0 = uncapped on this node). */
  readonly maxVramGbOverride?: number
  /** Operator taint (REQ-ADM-030): a deactivated node stays enrolled and heartbeating but runs no model and is never selected for inference. */
  readonly deactivated?: boolean
  /** Pending one-shot Force Reload directive (REQ-NODE-012): a nonce stamped when an operator requests a reload, echoed to the node in its heartbeat and retired once the node acks it. */
  readonly reloadNonce?: string
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

export interface MeshBootstrap {
  readonly action: 'create' | 'join' | 'wait'
  readonly rotation: number
  readonly meshId?: string
  readonly joinTokens?: readonly string[]
}

export interface ClaimResponse {
  readonly nodeId: string
  readonly nodeToken: string
  readonly upstreamToken: string
  readonly profiles: readonly ModelProfile[]
  readonly meshBootstrap?: MeshBootstrap
  readonly desiredAgentVersion?: string
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
  readonly runtime: 'meshllm'
  readonly runtimeModel?: string
  readonly meshId?: string
  readonly meshToken?: string
  readonly agentVersion?: string
  /** The Force Reload nonce the node has already applied, echoed back so the router can retire the directive (REQ-NODE-012). */
  readonly reloadNonce?: string
  readonly metrics?: NodeMetrics
}

export interface HeartbeatResponse {
  readonly ok: boolean
  readonly desiredProfiles: readonly ModelProfile[]
  readonly meshBootstrap?: MeshBootstrap
  readonly desiredAgentVersion?: string
  /** When true the node is deactivated: it must tear down / not launch mesh-llm. REQ-ADM-030. */
  readonly deactivated?: boolean
  /** One-shot Force Reload directive: when it differs from the nonce the node last applied, the node restarts mesh-llm once. REQ-NODE-012. */
  readonly reloadNonce?: string
}

export interface EntrySelectionRequest {
  readonly publicModel: string
  readonly now: number
}

export interface EntrySelection {
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
  deleteProfile(profileId: string): Promise<void>
  listNodes(now: number): Promise<readonly NodeRecord[]>
  getNode(nodeId: string): Promise<NodeRecord | undefined>
  upsertNode(node: NodeRecord): Promise<void>
  updateNodeHeartbeat(node: NodeRecord): Promise<void>
  revokeNode(nodeId: string, now: number): Promise<void>
  deleteNode(nodeId: string): Promise<void>
  getToken(kind: CredentialKind, id: string): Promise<TokenRecord | undefined>
  putToken(token: TokenRecord): Promise<void>
  revokeToken(kind: CredentialKind, id: string, now: number): Promise<void>
  listTokens(kind?: CredentialKind): Promise<readonly TokenRecord[]>
  putConfig(key: string, value: unknown): Promise<void>
  getConfig<T>(key: string): Promise<T | undefined>
  appendAudit(event: AuditEvent): Promise<void>
  listAudit(limit: number): Promise<readonly AuditEvent[]>
  listEventsSince(sinceMs: number, sinceId: string, types: readonly string[] | undefined, limit: number): Promise<readonly AuditEvent[]>
}

export interface Scheduler {
  selectEntryNode(request: EntrySelectionRequest): Promise<EntrySelection>
}

/**
 * Cloudflare Workers rate-limiting binding surface. Structurally matches the runtime
 * `RateLimit` binding so production wiring needs no adapter and tests can inject a fake.
 */
export interface RateLimiter {
  limit(input: { readonly key: string }): Promise<{ readonly success: boolean }>
}

export interface RouterEnv {
  readonly DB: D1Database
  readonly REGISTRY: DurableObjectNamespace
  readonly MESH: Fetcher
  readonly RL_INFERENCE?: RateLimiter
  readonly RL_HEARTBEAT?: RateLimiter
  readonly RL_ENROLL?: RateLimiter
  readonly RL_AUTH?: RateLimiter
  readonly RL_PUBLIC?: RateLimiter
  readonly RL_API?: RateLimiter
  readonly ROUTER_PROVIDER_TOKEN?: string
  readonly ADMIN_TOKEN?: string
  readonly NODE_UPSTREAM_TOKEN?: string
  readonly CLOUDFLARE_API_TOKEN_RUNTIME?: string
  readonly CLOUDFLARE_ACCOUNT_ID?: string
  readonly AI_GATEWAY_ACCOUNT_ID?: string
  readonly AI_GATEWAY_ID?: string
  readonly AI_GATEWAY_ROUTE_NAME?: string
  readonly AI_GATEWAY_PUBLIC_MODEL?: string
  readonly AI_GATEWAY_PROVIDER_NAME?: string
  readonly WORKER_NAME?: string
  readonly ADMIN_RECOVERY_TOKEN?: string
  readonly SETUP_REOPEN?: string
  readonly MESH_STATE_KEY?: string
  readonly WORKER_BASE_URL?: string
  readonly GITHUB_REPOSITORY?: string
  readonly AGENT_RELEASE_TAG?: string
  readonly MAX_REQUEST_BYTES?: string
  readonly HEARTBEAT_TTL_SECONDS?: string
}
