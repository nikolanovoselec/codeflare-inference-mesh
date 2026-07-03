import type { AuditEvent, CredentialKind, ModelProfile, NodeRecord, ReservationRecord, SessionRecord, Store, TokenRecord } from './types'

export class MemoryStore implements Store {
  readonly profiles = new Map<string, ModelProfile>()
  readonly nodes = new Map<string, NodeRecord>()
  readonly sessions = new Map<string, SessionRecord>()
  readonly reservations = new Map<string, ReservationRecord>()
  readonly tokens: TokenRecord[] = []
  readonly config = new Map<string, unknown>()
  readonly audit: AuditEvent[] = []

  async seedDefaultProfiles(profiles: readonly ModelProfile[]): Promise<void> {
    const existingProfiles = [...this.profiles.values()]
    for (const profile of retiredDefaultProfiles(existingProfiles, profiles)) this.profiles.set(profile.id, profile)
    for (const profile of profiles) {
      const existing = this.profiles.get(profile.id)
      if (!existing || shouldRefreshDefaultProfile(existing, profile)) this.profiles.set(profile.id, profile)
    }
  }

  async getProfileByPublicModel(publicModel: string): Promise<ModelProfile | undefined> {
    return [...this.profiles.values()].find((profile) => profile.active && profile.publicAliases.includes(publicModel))
  }

  async listProfiles(): Promise<readonly ModelProfile[]> {
    return [...this.profiles.values()]
  }

  async setProfile(profile: ModelProfile): Promise<void> {
    this.profiles.set(profile.id, profile)
  }

  async setActiveProfile(profileId: string, rolloutPercent: number): Promise<void> {
    const profile = this.profiles.get(profileId)
    if (!profile) throw new Error(`unknown profile ${profileId}`)
    this.profiles.set(profileId, { ...profile, rolloutPercent, active: rolloutPercent > 0, version: profile.version + 1 })
  }

  async listNodes(_now: number): Promise<readonly NodeRecord[]> {
    return [...this.nodes.values()]
  }

  async getNode(nodeId: string): Promise<NodeRecord | undefined> {
    return this.nodes.get(nodeId)
  }

  async upsertNode(node: NodeRecord): Promise<void> {
    this.nodes.set(node.id, node)
  }

  async updateNodeHeartbeat(node: NodeRecord): Promise<void> {
    const existing = this.nodes.get(node.id)
    this.nodes.set(node.id, { ...node, inFlight: existing?.inFlight ?? node.inFlight })
  }

  async revokeNode(nodeId: string, now: number): Promise<void> {
    const node = this.nodes.get(nodeId)
    if (!node) return
    const { nodeTokenVerifier, upstreamTokenVerifier, ...nodeWithoutCredentials } = node
    void nodeTokenVerifier
    void upstreamTokenVerifier
    this.nodes.set(nodeId, { ...nodeWithoutCredentials, status: 'revoked', failurePenaltyUntil: now + 31536000000 })
  }

  async getSession(sessionId: string): Promise<SessionRecord | undefined> {
    return this.sessions.get(sessionId)
  }

  async putSession(session: SessionRecord): Promise<void> {
    this.sessions.set(session.sessionId, session)
  }

  async putReservation(reservation: ReservationRecord): Promise<void> {
    this.reservations.set(reservation.reservationId, reservation)
  }

  async getReservation(reservationId: string): Promise<ReservationRecord | undefined> {
    return this.reservations.get(reservationId)
  }

  async releaseReservation(reservationId: string, now: number): Promise<void> {
    const reservation = this.reservations.get(reservationId)
    if (reservation) this.reservations.set(reservationId, { ...reservation, releasedAt: reservation.releasedAt ?? now })
  }

  async getToken(kind: CredentialKind, id: string): Promise<TokenRecord | undefined> {
    return this.tokens.find((token) => token.kind === kind && token.id === id)
  }

  async putToken(token: TokenRecord): Promise<void> {
    const index = this.tokens.findIndex((item) => item.kind === token.kind && item.id === token.id)
    if (index >= 0) this.tokens[index] = token
    else this.tokens.push(token)
  }

  async revokeToken(kind: CredentialKind, id: string, _now: number): Promise<void> {
    const index = this.tokens.findIndex((token) => token.kind === kind && token.id === id)
    if (index >= 0) this.tokens[index] = { ...this.tokens[index]!, active: false }
  }

  async listTokens(kind?: CredentialKind): Promise<readonly TokenRecord[]> {
    return kind ? this.tokens.filter((token) => token.kind === kind) : [...this.tokens]
  }

  async putConfig(key: string, value: unknown): Promise<void> {
    this.config.set(key, value)
  }

  async getConfig<T>(key: string): Promise<T | undefined> {
    return this.config.get(key) as T | undefined
  }

  async appendAudit(event: AuditEvent): Promise<void> {
    this.audit.push(event)
  }

  async listAudit(limit: number): Promise<readonly AuditEvent[]> {
    return this.audit.slice(-limit)
  }
}

function shouldRefreshDefaultProfile(existing: ModelProfile, next: ModelProfile): boolean {
  return existing.version <= next.version && JSON.stringify(existing) !== JSON.stringify(next)
}

function retiredDefaultProfiles(existing: readonly ModelProfile[], defaults: readonly ModelProfile[]): readonly ModelProfile[] {
  const defaultIds = new Set(defaults.map((profile) => profile.id))
  const defaultAliases = new Set(defaults.flatMap((profile) => [...profile.publicAliases]))
  return existing
    .filter((profile) => profile.active && (
      (profile.runtime as string) !== 'meshllm' ||
      (profile.version <= 1 && !defaultIds.has(profile.id) && profile.publicAliases.some((alias) => defaultAliases.has(alias)))
    ))
    .map((profile) => ({ ...profile, active: false, rolloutPercent: 0, version: profile.version + 1 }))
}

export interface AccessTestKey {
  readonly privateKey: CryptoKey
  readonly jwk: JsonWebKey & { readonly kid: string }
}

/** Real RS256 keypair for Access-JWT behavioral tests. */
export async function accessTestKey(kid: string): Promise<AccessTestKey> {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify']
  ) as CryptoKeyPair
  const exported = await crypto.subtle.exportKey('jwk', pair.publicKey) as JsonWebKey
  return { privateKey: pair.privateKey, jwk: { ...exported, kid } }
}

export async function signAccessJwt(key: AccessTestKey, payload: Record<string, unknown>): Promise<string> {
  const encode = (value: unknown): string => accessBase64Url(new TextEncoder().encode(JSON.stringify(value)))
  const signingInput = `${encode({ alg: 'RS256', kid: key.jwk.kid })}.${encode(payload)}`
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key.privateKey, new TextEncoder().encode(signingInput))
  return `${signingInput}.${accessBase64Url(new Uint8Array(signature))}`
}

export function accessJwksFetcher(keys: readonly JsonWebKey[], calls: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    calls.push(new Request(input).url)
    return Response.json({ keys })
  }) as typeof fetch
}

function accessBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function nodeFixture(overrides: Partial<NodeRecord> = {}): NodeRecord {
  return {
    id: 'node-a',
    displayName: 'Node A',
    meshIp: '100.64.1.10',
    inferencePort: 8080,
    localDashboardPort: 17777,
    status: 'online',
    publicModels: ['mesh-default'],
    activeProfileIds: ['mesh-default-qwen36-35b'],
    capacity: 2,
    inFlight: 0,
    lastSeenAt: 1_700_000_000_000,
    runtime: 'meshllm',
    runtimeModel: 'unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ3_S',
    metrics: {
      runtimeState: 'ready',
      loadedModel: 'unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ3_S',
      activeRequests: 0,
      apiReady: true,
      readyModels: ['unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ3_S']
    },
    ...overrides
  }
}
