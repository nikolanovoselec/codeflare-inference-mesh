import type { AuditEvent, CredentialKind, ModelProfile, NodeRecord, ReservationRecord, SessionRecord, Store, TokenRecord } from './types'

// The host gate reads these two config keys on every request; cache them
// per D1 binding with a short TTL so the hot path avoids two D1 round-trips.
// putConfig writes through the cache, keeping same-isolate reads exact.
const GATE_CONFIG_KEYS = new Set(['setup_state', 'custom_domain'])
const GATE_CONFIG_TTL_MS = 5000
const gateConfigCache = new WeakMap<D1Database, Map<string, { at: number; value: unknown }>>()

export class D1Store implements Store {
  constructor(private readonly db: D1Database, private readonly now: () => number = Date.now) {}

  async seedDefaultProfiles(profiles: readonly ModelProfile[]): Promise<void> {
    const existingProfiles = await this.listProfiles()
    for (const profile of retiredDefaultProfiles(existingProfiles, profiles)) await this.setProfile(profile)
    for (const profile of profiles) {
      const existing = existingProfiles.find((item) => item.id === profile.id)
      if (!existing || shouldRefreshDefaultProfile(existing, profile)) await this.setProfile(profile)
    }
  }

  async getProfileByPublicModel(publicModel: string): Promise<ModelProfile | undefined> {
    const rows = await this.db.prepare('SELECT profile_json FROM model_profiles WHERE active = 1').all<{ profile_json: string }>()
    for (const row of rows.results ?? []) {
      const profile = parseJson<ModelProfile>(row.profile_json)
      if (profile.publicAliases.includes(publicModel)) return profile
    }
    return undefined
  }

  async getProfileById(profileId: string): Promise<ModelProfile | undefined> {
    const row = await this.db.prepare('SELECT profile_json FROM model_profiles WHERE id = ?').bind(profileId).first<{ profile_json: string }>()
    return row ? parseJson<ModelProfile>(row.profile_json) : undefined
  }

  async listProfiles(): Promise<readonly ModelProfile[]> {
    const rows = await this.db.prepare('SELECT profile_json FROM model_profiles ORDER BY id').all<{ profile_json: string }>()
    return (rows.results ?? []).map((row) => parseJson<ModelProfile>(row.profile_json))
  }

  async setProfile(profile: ModelProfile): Promise<void> {
    await this.db.prepare('INSERT OR REPLACE INTO model_profiles (id, profile_json, active, rollout_percent, version, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(profile.id, JSON.stringify(profile), profile.active ? 1 : 0, profile.rolloutPercent, profile.version, this.now())
      .run()
  }

  async setActiveProfile(profileId: string, rolloutPercent: number): Promise<void> {
    const profile = await this.getProfileById(profileId)
    if (!profile) throw new Error(`unknown profile ${profileId}`)
    await this.setProfile({ ...profile, active: rolloutPercent > 0, rolloutPercent, version: profile.version + 1 })
  }

  async listNodes(now: number): Promise<readonly NodeRecord[]> {
    const rows = await this.db.prepare('SELECT node_json, in_flight FROM nodes ORDER BY id').all<NodeRow>()
    return (rows.results ?? []).map((row) => materializeNode(nodeFromRow(row), now))
  }

  async getNode(nodeId: string): Promise<NodeRecord | undefined> {
    const row = await this.db.prepare('SELECT node_json, in_flight FROM nodes WHERE id = ?').bind(nodeId).first<NodeRow>()
    return row ? nodeFromRow(row) : undefined
  }

  async upsertNode(node: NodeRecord): Promise<void> {
    await this.db.prepare('INSERT OR REPLACE INTO nodes (id, node_json, status, mesh_ip, inference_port, in_flight, capacity, last_seen_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(node.id, JSON.stringify(node), node.status, node.meshIp, node.inferencePort, node.inFlight, node.capacity, node.lastSeenAt, this.now())
      .run()
  }

  async updateNodeHeartbeat(node: NodeRecord): Promise<void> {
    await this.db.prepare('UPDATE nodes SET node_json = ?, status = ?, mesh_ip = ?, inference_port = ?, capacity = ?, last_seen_at = ?, updated_at = ? WHERE id = ?')
      .bind(JSON.stringify(node), node.status, node.meshIp, node.inferencePort, node.capacity, node.lastSeenAt, this.now(), node.id)
      .run()
  }

  async revokeNode(nodeId: string, now: number): Promise<void> {
    const node = await this.getNode(nodeId)
    if (!node) return
    const { nodeTokenVerifier, upstreamTokenVerifier, ...nodeWithoutCredentials } = node
    void nodeTokenVerifier
    void upstreamTokenVerifier
    await this.upsertNode({ ...nodeWithoutCredentials, status: 'revoked', failurePenaltyUntil: now + 31536000000 })
  }

  async getSession(sessionId: string): Promise<SessionRecord | undefined> {
    const row = await this.db.prepare('SELECT node_id, public_model, profile_id, upstream_model, expires_at FROM sessions WHERE session_id = ?').bind(sessionId).first<{ node_id: string; public_model: string; profile_id: string; upstream_model: string; expires_at: number }>()
    if (!row) return undefined
    return { sessionId, nodeId: row.node_id, publicModel: row.public_model, profileId: row.profile_id, upstreamModel: row.upstream_model, expiresAt: row.expires_at }
  }

  async putSession(session: SessionRecord): Promise<void> {
    await this.db.prepare('INSERT OR REPLACE INTO sessions (session_id, node_id, public_model, profile_id, upstream_model, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(session.sessionId, session.nodeId, session.publicModel, session.profileId, session.upstreamModel, session.expiresAt)
      .run()
  }

  async putReservation(reservation: ReservationRecord): Promise<void> {
    await this.db.prepare('INSERT OR REPLACE INTO reservations (reservation_id, node_id, session_id, public_model, profile_id, upstream_model, expires_at, released_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(reservation.reservationId, reservation.nodeId, reservation.sessionId, reservation.publicModel, reservation.profileId, reservation.upstreamModel, reservation.expiresAt, reservation.releasedAt ?? null)
      .run()
  }

  async getReservation(reservationId: string): Promise<ReservationRecord | undefined> {
    const row = await this.db.prepare('SELECT reservation_id, node_id, session_id, public_model, profile_id, upstream_model, expires_at, released_at FROM reservations WHERE reservation_id = ?')
      .bind(reservationId)
      .first<ReservationRow>()
    return row ? reservationFromRow(row) : undefined
  }

  async releaseReservation(reservationId: string, now: number): Promise<void> {
    await this.db.prepare('UPDATE reservations SET released_at = COALESCE(released_at, ?) WHERE reservation_id = ?').bind(now, reservationId).run()
  }

  async getToken(kind: CredentialKind, id: string): Promise<TokenRecord | undefined> {
    const row = await this.db.prepare('SELECT id, kind, verifier, active, node_id, created_at, expires_at FROM tokens WHERE kind = ? AND id = ?').bind(kind, id).first<TokenRow>()
    return row ? tokenFromRow(row) : undefined
  }

  async putToken(token: TokenRecord): Promise<void> {
    await this.db.prepare('INSERT OR REPLACE INTO tokens (kind, id, verifier, active, node_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(token.kind, token.id, token.verifier, token.active ? 1 : 0, token.nodeId ?? null, token.createdAt, token.expiresAt ?? null)
      .run()
  }

  async revokeToken(kind: CredentialKind, id: string, _now: number): Promise<void> {
    await this.db.prepare('UPDATE tokens SET active = 0 WHERE kind = ? AND id = ?').bind(kind, id).run()
  }

  async listTokens(kind?: CredentialKind): Promise<readonly TokenRecord[]> {
    const stmt = kind
      ? this.db.prepare('SELECT id, kind, verifier, active, node_id, created_at, expires_at FROM tokens WHERE kind = ? ORDER BY created_at DESC').bind(kind)
      : this.db.prepare('SELECT id, kind, verifier, active, node_id, created_at, expires_at FROM tokens ORDER BY created_at DESC')
    const rows = await stmt.all<TokenRow>()
    return (rows.results ?? []).map(tokenFromRow)
  }

  async putConfig(key: string, value: unknown): Promise<void> {
    await this.db.prepare('INSERT OR REPLACE INTO router_config (key, value_json, updated_at) VALUES (?, ?, ?)')
      .bind(key, JSON.stringify(value), this.now())
      .run()
    if (GATE_CONFIG_KEYS.has(key)) gateConfigCache.get(this.db)?.delete(key)
  }

  async getConfig<T>(key: string): Promise<T | undefined> {
    const cacheable = GATE_CONFIG_KEYS.has(key)
    if (cacheable) {
      const cached = gateConfigCache.get(this.db)?.get(key)
      if (cached && this.now() - cached.at < GATE_CONFIG_TTL_MS) return cached.value as T | undefined
    }
    const row = await this.db.prepare('SELECT value_json FROM router_config WHERE key = ?').bind(key).first<{ value_json: string }>()
    const value = row ? parseJson<T>(row.value_json) : undefined
    if (cacheable) {
      const perDb = gateConfigCache.get(this.db) ?? new Map<string, { at: number; value: unknown }>()
      perDb.set(key, { at: this.now(), value })
      gateConfigCache.set(this.db, perDb)
    }
    return value
  }

  async appendAudit(event: AuditEvent): Promise<void> {
    await this.db.prepare('INSERT INTO audit_events (id, event_json, type, at, actor, target) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(event.id, JSON.stringify(event), event.type, event.at, event.actor, event.target ?? null)
      .run()
  }

  async listAudit(limit: number): Promise<readonly AuditEvent[]> {
    const rows = await this.db.prepare('SELECT event_json FROM audit_events ORDER BY at DESC LIMIT ?').bind(limit).all<{ event_json: string }>()
    return (rows.results ?? []).map((row) => parseJson<AuditEvent>(row.event_json))
  }
}

interface NodeRow {
  readonly node_json: string
  readonly in_flight: number
}

interface ReservationRow {
  readonly reservation_id: string
  readonly node_id: string
  readonly session_id: string
  readonly public_model: string
  readonly profile_id: string
  readonly upstream_model: string
  readonly expires_at: number
  readonly released_at: number | null
}

interface TokenRow {
  readonly id: string
  readonly kind: CredentialKind
  readonly verifier: string
  readonly active: number
  readonly node_id: string | null
  readonly created_at: number
  readonly expires_at: number | null
}

function reservationFromRow(row: ReservationRow): ReservationRecord {
  return {
    reservationId: row.reservation_id,
    nodeId: row.node_id,
    sessionId: row.session_id,
    publicModel: row.public_model,
    profileId: row.profile_id,
    upstreamModel: row.upstream_model,
    expiresAt: row.expires_at,
    ...(row.released_at !== null ? { releasedAt: row.released_at } : {})
  }
}

function tokenFromRow(row: TokenRow): TokenRecord {
  return {
    id: row.id,
    kind: row.kind,
    verifier: row.verifier,
    active: row.active === 1,
    createdAt: row.created_at,
    ...(row.node_id !== null ? { nodeId: row.node_id } : {}),
    ...(row.expires_at !== null ? { expiresAt: row.expires_at } : {})
  }
}

function nodeFromRow(row: NodeRow): NodeRecord {
  const node = parseJson<NodeRecord>(row.node_json)
  return { ...node, inFlight: row.in_flight }
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

export function aliasExclusiveActivation(profiles: readonly ModelProfile[], profileId: string): { readonly activated: ModelProfile; readonly deactivated: readonly ModelProfile[] } | undefined {
  const target = profiles.find((profile) => profile.id === profileId)
  if (!target) return undefined
  return {
    activated: { ...target, active: true, rolloutPercent: 100, version: target.version + 1 },
    deactivated: profiles
      .filter((profile) => profile.id !== target.id && profile.active && profile.publicAliases.some((alias) => target.publicAliases.includes(alias)))
      .map((profile) => ({ ...profile, active: false, rolloutPercent: 0, version: profile.version + 1 }))
  }
}

function materializeNode(node: NodeRecord, now: number): NodeRecord {
  const status = node.status === 'online' && now - node.lastSeenAt > 45_000 ? 'offline' : node.status
  return status === node.status ? node : { ...node, status }
}

function parseJson<T>(text: string): T {
  return JSON.parse(text) as T
}

export const STORE_ANCHORS = {
  REQ_SCH_001: 'REQ-SCH-001',
  REQ_SCH_004: 'REQ-SCH-004',
  REQ_RUN_002: 'REQ-RUN-002'
} as const
