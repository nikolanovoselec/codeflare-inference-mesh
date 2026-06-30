import { describe, expect, it } from 'vitest'
import { DEFAULT_MODEL_PROFILES } from './profiles'
import { StoreScheduler } from './scheduler'
import { D1Store } from './store'
import { nodeFixture } from './test-helpers'
import type { AuditEvent, ReservationRecord, SessionRecord, TokenRecord } from './types'

type Row = Record<string, unknown>

class FakeD1Database {
  readonly config = new Map<string, Row>()
  readonly tokens = new Map<string, Row>()
  readonly profiles = new Map<string, Row>()
  readonly nodes = new Map<string, Row>()
  readonly sessions = new Map<string, Row>()
  readonly reservations = new Map<string, Row>()
  audit: readonly Row[] = []

  prepare(query: string): FakeD1Statement {
    return new FakeD1Statement(this, query)
  }
}

class FakeD1Statement {
  private readonly query: string

  constructor(private readonly db: FakeD1Database, query: string, private readonly values: readonly unknown[] = []) {
    this.query = query.replace(/\s+/g, ' ').trim()
  }

  bind(...values: readonly unknown[]): FakeD1Statement {
    return new FakeD1Statement(this.db, this.query, values)
  }

  async run(): Promise<D1Result> {
    const q = this.query
    const values = this.values

    if (q.startsWith('INSERT OR REPLACE INTO router_config')) {
      this.db.config.set(text(values[0]), { value_json: text(values[1]), updated_at: number(values[2]) })
      return ok()
    }
    if (q.startsWith('INSERT OR REPLACE INTO tokens')) {
      const row = {
        kind: text(values[0]),
        id: text(values[1]),
        verifier: text(values[2]),
        active: number(values[3]),
        node_id: nullableText(values[4]),
        created_at: number(values[5]),
        expires_at: nullableNumber(values[6])
      }
      this.db.tokens.set(tokenKey(row.kind, row.id), row)
      return ok()
    }
    if (q.startsWith('UPDATE tokens SET active = 0')) {
      const key = tokenKey(text(values[0]), text(values[1]))
      const row = this.db.tokens.get(key)
      if (row) this.db.tokens.set(key, { ...row, active: 0 })
      return ok()
    }
    if (q.startsWith('INSERT OR REPLACE INTO model_profiles')) {
      this.db.profiles.set(text(values[0]), { profile_json: text(values[1]), active: number(values[2]), rollout_percent: number(values[3]), version: number(values[4]), updated_at: number(values[5]) })
      return ok()
    }
    if (q.startsWith('INSERT OR REPLACE INTO nodes')) {
      this.db.nodes.set(text(values[0]), { node_json: text(values[1]), status: text(values[2]), mesh_ip: text(values[3]), inference_port: number(values[4]), in_flight: number(values[5]), capacity: number(values[6]), last_seen_at: number(values[7]), updated_at: number(values[8]) })
      return ok()
    }
    if (q.startsWith('UPDATE nodes SET')) {
      const id = text(values[7])
      const existing = this.db.nodes.get(id)
      const inFlight = number(existing?.in_flight ?? 0)
      this.db.nodes.set(id, { node_json: text(values[0]), status: text(values[1]), mesh_ip: text(values[2]), inference_port: number(values[3]), capacity: number(values[4]), last_seen_at: number(values[5]), updated_at: number(values[6]), in_flight: inFlight })
      return ok()
    }
    if (q.startsWith('INSERT OR REPLACE INTO sessions')) {
      this.db.sessions.set(text(values[0]), { node_id: text(values[1]), public_model: text(values[2]), profile_id: text(values[3]), upstream_model: text(values[4]), expires_at: number(values[5]) })
      return ok()
    }
    if (q.startsWith('INSERT OR REPLACE INTO reservations')) {
      this.db.reservations.set(text(values[0]), { reservation_id: text(values[0]), node_id: text(values[1]), session_id: text(values[2]), public_model: text(values[3]), profile_id: text(values[4]), upstream_model: text(values[5]), expires_at: number(values[6]), released_at: nullableNumber(values[7]) })
      return ok()
    }
    if (q.startsWith('UPDATE reservations SET released_at')) {
      const key = text(values[1])
      const row = this.db.reservations.get(key)
      if (row) this.db.reservations.set(key, { ...row, released_at: row.released_at ?? number(values[0]) })
      return ok()
    }
    if (q.startsWith('INSERT INTO audit_events')) {
      this.db.audit = [...this.db.audit, { id: text(values[0]), event_json: text(values[1]), type: text(values[2]), at: number(values[3]), actor: text(values[4]), target: nullableText(values[5]) }]
      return ok()
    }

    throw new Error(`Unhandled D1 run query: ${q}`)
  }

  async first<T = unknown>(): Promise<T | null> {
    const rows = (await this.all<T>()).results ?? []
    return rows[0] ?? null
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    return { ...ok(), results: this.selectRows() as T[] } as D1Result<T>
  }

  private selectRows(): readonly Row[] {
    const q = this.query
    const values = this.values

    if (q === 'SELECT value_json FROM router_config WHERE key = ?') {
      return maybe(this.db.config.get(text(values[0])), ['value_json'])
    }
    if (q === 'SELECT id, kind, verifier, active, node_id, created_at, expires_at FROM tokens WHERE kind = ? AND id = ?') {
      return maybe(this.db.tokens.get(tokenKey(text(values[0]), text(values[1]))))
    }
    if (q === 'SELECT id, kind, verifier, active, node_id, created_at, expires_at FROM tokens WHERE kind = ? ORDER BY created_at DESC') {
      return [...this.db.tokens.values()].filter((row) => row.kind === text(values[0])).sort(desc('created_at'))
    }
    if (q === 'SELECT id, kind, verifier, active, node_id, created_at, expires_at FROM tokens ORDER BY created_at DESC') {
      return [...this.db.tokens.values()].sort(desc('created_at'))
    }
    if (q === 'SELECT profile_json FROM model_profiles WHERE active = 1') {
      return [...this.db.profiles.values()].filter((row) => row.active === 1).map((row) => pick(row, ['profile_json']))
    }
    if (q === 'SELECT profile_json FROM model_profiles WHERE id = ?') {
      return maybe(this.db.profiles.get(text(values[0])), ['profile_json'])
    }
    if (q === 'SELECT profile_json FROM model_profiles ORDER BY id') {
      return [...this.db.profiles.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, row]) => pick(row, ['profile_json']))
    }
    if (q === 'SELECT node_json, in_flight FROM nodes ORDER BY id') {
      return [...this.db.nodes.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, row]) => pick(row, ['node_json', 'in_flight']))
    }
    if (q === 'SELECT node_json, in_flight FROM nodes WHERE id = ?') {
      return maybe(this.db.nodes.get(text(values[0])), ['node_json', 'in_flight'])
    }
    if (q === 'SELECT node_id, public_model, profile_id, upstream_model, expires_at FROM sessions WHERE session_id = ?') {
      return maybe(this.db.sessions.get(text(values[0])))
    }
    if (q === 'SELECT reservation_id, node_id, session_id, public_model, profile_id, upstream_model, expires_at, released_at FROM reservations WHERE reservation_id = ?') {
      return maybe(this.db.reservations.get(text(values[0])))
    }
    if (q === 'SELECT event_json FROM audit_events ORDER BY at DESC LIMIT ?') {
      return [...this.db.audit].sort(desc('at')).slice(0, number(values[0])).map((row) => pick(row, ['event_json']))
    }

    throw new Error(`Unhandled D1 select query: ${q}`)
  }
}

function ok(): D1Result {
  return { success: true, meta: {} } as D1Result
}

function tokenKey(kind: string, id: string): string {
  return `${kind}:${id}`
}

function text(value: unknown): string {
  return String(value)
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

function number(value: unknown): number {
  return Number(value)
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value)
}

function maybe(row: Row | undefined, keys?: readonly string[]): readonly Row[] {
  return row ? [keys ? pick(row, keys) : row] : []
}

function pick(row: Row, keys: readonly string[]): Row {
  return Object.fromEntries(keys.map((key) => [key, row[key]]))
}

function desc(key: string): (left: Row, right: Row) => number {
  return (left, right) => number(right[key]) - number(left[key])
}

describe('D1 store behavioral contracts', () => {
  it('REQ-SCH-001 persists durable router state and reloads scheduler state from D1', async () => {
    const db = new FakeD1Database()
    const writer = new D1Store(db as unknown as D1Database, () => 1_700_000_000_000)
    const profile = DEFAULT_MODEL_PROFILES[0]!
    const node = nodeFixture({ nodeTokenVerifier: 'sha256:node-token', upstreamTokenVerifier: 'sha256:upstream-token' })
    const config = { setupComplete: true, defaultPublicModel: 'mesh-default', resources: { d1DatabaseId: 'd1-a', workerName: 'router-a' } }
    const providerToken: TokenRecord = { kind: 'provider', id: 'provider-a', verifier: 'sha256:provider', active: true, createdAt: 1_700_000_000_001 }
    const adminToken: TokenRecord = { kind: 'admin', id: 'admin-a', verifier: 'sha256:admin', active: true, createdAt: 1_700_000_000_002 }
    const setupToken: TokenRecord = { kind: 'setup', id: 'setup-a', verifier: 'sha256:setup', active: true, nodeId: 'node-a', createdAt: 1_700_000_000_003, expiresAt: 1_700_000_060_000 }
    const session: SessionRecord = { sessionId: 'session-a', nodeId: 'node-a', publicModel: 'mesh-default', profileId: profile.id, upstreamModel: profile.upstreamModel, expiresAt: 1_700_086_400_000 }
    const reservation: ReservationRecord = { reservationId: 'reservation-a', nodeId: 'node-a', sessionId: 'session-a', publicModel: 'mesh-default', profileId: profile.id, upstreamModel: profile.upstreamModel, expiresAt: 1_700_001_800_000 }
    const audit: AuditEvent = { id: 'audit-a', type: 'setup.completed', at: 1_700_000_000_010, actor: 'admin', target: 'router', detail: { workerName: 'router-a' } }

    await writer.putConfig('setup', config)
    await writer.putToken(providerToken)
    await writer.putToken(adminToken)
    await writer.putToken(setupToken)
    await writer.setProfile(profile)
    await writer.upsertNode(node)
    await writer.putSession(session)
    await writer.putReservation(reservation)
    await writer.appendAudit(audit)

    const reader = new D1Store(db as unknown as D1Database, () => 1_700_000_000_020)
    const scheduler = new StoreScheduler(reader, () => 'reservation-b')
    const rebuilt = await scheduler.reserve({ publicModel: 'mesh-default', sessionId: 'session-a', now: 1_700_000_000_020 })

    expect(await reader.getConfig('setup')).toEqual(config)
    expect(await reader.getToken('provider', 'provider-a')).toEqual(providerToken)
    expect(await reader.getToken('admin', 'admin-a')).toEqual(adminToken)
    expect(await reader.getToken('setup', 'setup-a')).toEqual(setupToken)
    expect(await reader.getProfileByPublicModel('mesh-default')).toEqual(profile)
    expect(await reader.listProfiles()).toEqual([profile])
    expect(await reader.getNode('node-a')).toEqual({ ...node, inFlight: 1 })
    expect(await reader.getSession('session-a')).toEqual({ ...session, expiresAt: 1_700_086_400_020 })
    expect(await reader.getReservation('reservation-a')).toEqual(reservation)
    expect(await reader.listAudit(1)).toEqual([audit])
    expect(rebuilt.reservation).toMatchObject({ reservationId: 'reservation-b', nodeId: 'node-a', publicModel: 'mesh-default', profileId: profile.id })
  })
})
