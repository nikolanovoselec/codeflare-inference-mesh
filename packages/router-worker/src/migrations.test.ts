import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../migrations')

/**
 * Replay the migration sequence in filename order and return the tables that survive it.
 * Comments are stripped first so prose about a table never reads as DDL against it.
 */
function tablesAfterMigrations(): ReadonlySet<string> {
  const tables = new Set<string>()
  for (const file of readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort()) {
    const sql = readFileSync(join(migrationsDir, file), 'utf8').replace(/--[^\n]*/g, '')
    for (const [, name] of sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?([a-z_]+)/gi)) if (name) tables.add(name)
    for (const [, name] of sql.matchAll(/DROP TABLE (?:IF EXISTS )?([a-z_]+)/gi)) if (name) tables.delete(name)
  }
  return tables
}

describe('migrations', () => {
  // Replays the declared DDL rather than executing it: there is no SQLite harness in this
  // package, so this asserts the migration corpus, not a live schema. It still fails if
  // 0004 is dropped, or if a migration reintroduces either retired table.
  it('REQ-SCH-001 declares exactly the durable tables across the migration corpus, with no session-lease or reservation schema', () => {
    expect([...tablesAfterMigrations()].sort()).toEqual([
      'audit_events',
      'direct_sessions',
      'model_profiles',
      'nodes',
      'router_config',
      'tokens'
    ])
  })
})
