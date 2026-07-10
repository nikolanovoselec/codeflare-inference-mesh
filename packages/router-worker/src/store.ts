import { normalizeModelProfile } from './profiles'
import type { AuditEvent, CredentialKind, DirectSessionRecord, ModelProfile, NodeRecord, Store, TokenRecord } from './types'

// The host gate reads these two config keys on every request; cache them
// per D1 binding with a short TTL so the hot path avoids two D1 round-trips.
// putConfig invalidates the cached entry, keeping same-isolate reads exact.
const GATE_CONFIG_KEYS = new Set(['setup_state', 'custom_domain'])
const GATE_CONFIG_TTL_MS = 5000
const gateConfigCache = new WeakMap<D1Database, Map<string, { at: number; value: unknown }>>()

/**
 * Internal per-heartbeat bookkeeping audit types excluded from the operational
 * events feed (the console suppresses the same set). The API events endpoint is
 * for operational events, not internal mesh-state churn.
 */
export const OPERATIONAL_EVENT_CHURN_TYPES = ['mesh_state_stored', 'mesh_state_cleared', 'mesh_token_rotated', 'mesh_token_removed'] as const

export class D1Store implements Store {
  constructor(private readonly db: D1Database, private readonly now: () => number = Date.now) {}

  async seedDefaultProfiles(profiles: readonly ModelProfile[]): Promise<void> {
    const existingProfiles = await this.listProfiles()
    for (const profile of retiredDefaultProfiles(existingProfiles, profiles)) await this.setProfile(profile)
    const seededDefaults = profiles.map((profile) => seedDefaultActivation(profile, existingProfiles, profiles))
    for (const profile of seededDefaults) {
      const existing = existingProfiles.find((item) => item.id === profile.id)
      if (!existing || shouldRefreshDefaultProfile(existing, profile)) await this.setProfile(profile)
    }
  }

  async getProfileByPublicModel(publicModel: string): Promise<ModelProfile | undefined> {
    const rows = await this.db.prepare('SELECT profile_json FROM model_profiles WHERE active = 1').all<{ profile_json: string }>()
    for (const row of rows.results ?? []) {
      const profile = normalizeModelProfile(parseJson<ModelProfile>(row.profile_json))
      if (profile.publicAliases.includes(publicModel)) return profile
    }
    return undefined
  }

  async getProfileById(profileId: string): Promise<ModelProfile | undefined> {
    const row = await this.db.prepare('SELECT profile_json FROM model_profiles WHERE id = ?').bind(profileId).first<{ profile_json: string }>()
    return row ? normalizeModelProfile(parseJson<ModelProfile>(row.profile_json)) : undefined
  }

  async listProfiles(): Promise<readonly ModelProfile[]> {
    const rows = await this.db.prepare('SELECT profile_json FROM model_profiles ORDER BY id').all<{ profile_json: string }>()
    return (rows.results ?? []).map((row) => normalizeModelProfile(parseJson<ModelProfile>(row.profile_json)))
  }

  async setProfile(profile: ModelProfile): Promise<void> {
    const normalized = normalizeModelProfile(profile)
    await this.db.prepare('INSERT OR REPLACE INTO model_profiles (id, profile_json, active, rollout_percent, version, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(normalized.id, JSON.stringify(normalized), normalized.active ? 1 : 0, normalized.rolloutPercent, normalized.version, this.now())
      .run()
  }

  async setActiveProfile(profileId: string, rolloutPercent: number): Promise<void> {
    const profile = await this.getProfileById(profileId)
    if (!profile) throw new Error(`unknown profile ${profileId}`)
    await this.setProfile({ ...profile, active: rolloutPercent > 0, rolloutPercent, version: profile.version + 1 })
  }

  async deleteProfile(profileId: string): Promise<void> {
    await this.db.prepare('DELETE FROM model_profiles WHERE id = ?').bind(profileId).run()
  }

  async listNodes(now: number): Promise<readonly NodeRecord[]> {
    const rows = await this.db.prepare('SELECT node_json, in_flight FROM nodes ORDER BY id').all<NodeRow>()
    // A revoked node is a tombstone: its credentials are stripped and it is on its way out.
    // Exclude it from every fleet listing so it never reappears in the console or API, even
    // when a mid-revoke failure leaves the row behind (deleteNode is the last, non-fail-closed step).
    return (rows.results ?? []).map((row) => materializeNode(nodeFromRow(row), now)).filter((node) => node.status !== 'revoked')
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

  async getDirectSession(affinityKey: string): Promise<DirectSessionRecord | undefined> {
    const row = await this.db.prepare('SELECT affinity_key, profile_id, public_model, node_id, user_hash, session_hash, created_at, updated_at, expires_at, failover_count FROM direct_sessions WHERE affinity_key = ?')
      .bind(affinityKey)
      .first<DirectSessionRow>()
    return row ? directSessionFromRow(row) : undefined
  }

  async putDirectSession(session: DirectSessionRecord): Promise<void> {
    await this.db.prepare('INSERT OR REPLACE INTO direct_sessions (affinity_key, profile_id, public_model, node_id, user_hash, session_hash, created_at, updated_at, expires_at, failover_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(session.affinityKey, session.profileId, session.publicModel, session.nodeId, session.userHash, session.sessionHash, session.createdAt, session.updatedAt, session.expiresAt, session.failoverCount)
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

  async deleteNode(nodeId: string): Promise<void> {
    await this.db.prepare('DELETE FROM nodes WHERE id = ?').bind(nodeId).run()
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

  async listEventsSince(sinceMs: number, sinceId: string, types: readonly string[] | undefined, limit: number): Promise<readonly AuditEvent[]> {
    const churnClause = `type NOT IN (${OPERATIONAL_EVENT_CHURN_TYPES.map(() => '?').join(', ')})`
    const clauses = sinceId ? ['(at > ? OR (at = ? AND id > ?))', churnClause] : ['at > ?', churnClause]
    const binds: unknown[] = sinceId ? [sinceMs, sinceMs, sinceId, ...OPERATIONAL_EVENT_CHURN_TYPES] : [sinceMs, ...OPERATIONAL_EVENT_CHURN_TYPES]
    if (types && types.length > 0) {
      clauses.push(`type IN (${types.map(() => '?').join(', ')})`)
      binds.push(...types)
    }
    binds.push(limit)
    const rows = await this.db
      .prepare(`SELECT event_json FROM audit_events WHERE ${clauses.join(' AND ')} ORDER BY at ASC, id ASC LIMIT ?`)
      .bind(...binds)
      .all<{ event_json: string }>()
    return (rows.results ?? []).map((row) => parseJson<AuditEvent>(row.event_json))
  }
}

interface NodeRow {
  readonly node_json: string
  readonly in_flight: number
}

interface DirectSessionRow {
  readonly affinity_key: string
  readonly profile_id: string
  readonly public_model: string
  readonly node_id: string
  readonly user_hash: string
  readonly session_hash: string
  readonly created_at: number
  readonly updated_at: number
  readonly expires_at: number
  readonly failover_count: number
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

function directSessionFromRow(row: DirectSessionRow): DirectSessionRecord {
  return {
    affinityKey: row.affinity_key,
    profileId: row.profile_id,
    publicModel: row.public_model,
    nodeId: row.node_id,
    userHash: row.user_hash,
    sessionHash: row.session_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    failoverCount: row.failover_count
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

function seedDefaultActivation(profile: ModelProfile, existing: readonly ModelProfile[], defaults: readonly ModelProfile[]): ModelProfile {
  if (!profile.active) return profile
  const defaultIds = new Set(defaults.map((item) => item.id))
  const claimed = existing.some((item) => item.active && !defaultIds.has(item.id) && item.publicAliases.some((alias) => profile.publicAliases.includes(alias)))
  return claimed ? { ...profile, active: false, rolloutPercent: 0 } : profile
}

function retiredDefaultProfiles(existing: readonly ModelProfile[], defaults: readonly ModelProfile[]): readonly ModelProfile[] {
  const defaultIds = new Set(defaults.map((profile) => profile.id))
  const defaultAliases = new Set(defaults.flatMap((profile) => [...profile.publicAliases]))
  return existing
    .filter((profile) => profile.active && profile.version <= 1 && !defaultIds.has(profile.id) && profile.publicAliases.some((alias) => defaultAliases.has(alias)))
    .map((profile) => ({ ...profile, active: false, rolloutPercent: 0, version: profile.version + 1 }))
}

// Single-active activation: activating one model deactivates every other active
// model, so a mesh serves exactly one model at a time (one mesh, one active model).
export function singleActiveActivation(profiles: readonly ModelProfile[], profileId: string): { readonly activated: ModelProfile; readonly deactivated: readonly ModelProfile[] } | undefined {
  const target = profiles.find((profile) => profile.id === profileId)
  if (!target) return undefined
  return {
    activated: { ...target, active: true, rolloutPercent: 100, version: target.version + 1 },
    deactivated: profiles
      .filter((profile) => profile.id !== target.id && profile.active)
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
  REQ_RUN_002: 'REQ-RUN-002'
} as const
