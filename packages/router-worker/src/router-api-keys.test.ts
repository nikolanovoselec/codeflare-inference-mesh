/**
 * control-plane API: automation keys and enrollment.
 *
 * One slice of the control-plane suite; shared fixtures live in
 * `./router-test-support`.
 */
import { addApiModelId, apiAddModel, apiDeleteModel, bearer, mintKey, routerFixture } from './router-test-support'
import { createTokenRecord } from './auth'
import { describe, expect, it } from 'vitest'
import { MemoryStore } from './test-helpers'

describe('control-plane API: automation keys and enrollment', () => {
  it('REQ-API-001 mints an automation key for an admin and returns the secret once', async () => {
    const { router } = routerFixture()
    const res = await router(new Request('https://router.test/api/v1/keys', { method: 'POST', headers: bearer('admin-secret') }))
    expect(res.status).toBe(201)
    const body = await res.json() as { id: string; token: string; createdAt: number }
    expect(body.id).toMatch(/^automation_/)
    expect(body.token).toMatch(/^automation_/)
    expect(body.createdAt).toBe(1_700_000_000_000)
  })

  it('REQ-API-001 lists active automation keys without the secret or verifier', async () => {
    const { router } = routerFixture()
    const created = await mintKey(router)
    const res = await router(new Request('https://router.test/api/v1/keys', { headers: bearer('admin-secret') }))
    expect(res.status).toBe(200)
    const body = await res.json() as { keys: Array<{ id: string; createdAt: number }> }
    expect(body.keys.map((key) => key.id)).toContain(created.id)
    const serialized = JSON.stringify(body)
    expect(serialized).not.toContain(created.token)
    expect(serialized).not.toContain('verifier')
  })

  it('REQ-API-001 revokes an automation key so it stops authenticating', async () => {
    const { router } = routerFixture()
    const created = await mintKey(router)
    // The key authenticates the control plane before revocation.
    expect((await router(new Request('https://router.test/api/v1/status', { headers: bearer(created.token) }))).status).toBe(200)
    const del = await router(new Request(`https://router.test/api/v1/keys/${created.id}`, { method: 'DELETE', headers: bearer('admin-secret') }))
    expect(del.status).toBe(200)
    // After revocation the same key no longer authenticates.
    expect((await router(new Request('https://router.test/api/v1/status', { headers: bearer(created.token) }))).status).toBe(401)
    // An unknown key id is a 404.
    expect((await router(new Request('https://router.test/api/v1/keys/automation_nope', { method: 'DELETE', headers: bearer('admin-secret') }))).status).toBe(404)
  })

  it('REQ-API-001 rotates an automation key so the old secret dies and a new one authenticates', async () => {
    const { router, store } = routerFixture()
    const created = await mintKey(router)
    expect((await router(new Request('https://router.test/api/v1/status', { headers: bearer(created.token) }))).status).toBe(200)
    const rot = await router(new Request(`https://router.test/api/v1/keys/${created.id}/rotate`, { method: 'POST', headers: bearer('admin-secret') }))
    expect(rot.status).toBe(201)
    const rotated = await rot.json() as { id: string; token: string; rotatedFrom: string }
    expect(rotated.rotatedFrom).toBe(created.id)
    expect(rotated.token).not.toBe(created.token)
    // The retired secret stops authenticating; the fresh secret works.
    expect((await router(new Request('https://router.test/api/v1/status', { headers: bearer(created.token) }))).status).toBe(401)
    expect((await router(new Request('https://router.test/api/v1/status', { headers: bearer(rotated.token) }))).status).toBe(200)
    // Rotation is audited by key id, never the secret; unknown id is 404; a non-admin is refused.
    expect(store.audit.find((event) => event.type === 'automation_key_rotated')?.detail).toMatchObject({ previousKeyId: created.id, keyId: rotated.id })
    expect(JSON.stringify(store.audit)).not.toContain(rotated.token)
    expect((await router(new Request('https://router.test/api/v1/keys/automation_nope/rotate', { method: 'POST', headers: bearer('admin-secret') }))).status).toBe(404)
    expect((await router(new Request(`https://router.test/api/v1/keys/${rotated.id}/rotate`, { method: 'POST', headers: bearer('not-admin') }))).status).toBe(401)
  })

  it('REQ-API-001 accepts the admin bearer credential for key cleanup after Access is provisioned', async () => {
    const store = new MemoryStore()
    await store.putConfig('access_config', { teamDomain: 'example-team.cloudflareaccess.com', audience: 'aud-mesh-admin', appId: 'app-1', bypassAppId: 'app-2', adminEmails: ['operator@example.com'] })
    const tempKey = await createTokenRecord('automation', 'automation-temp-secret', 1_700_000_000_000)
    await store.putToken(tempKey)
    const { router } = routerFixture({ store })

    const list = await router(new Request('https://router.test/api/v1/keys', { headers: bearer('admin-secret') }))
    expect(list.status).toBe(200)
    const listed = await list.json() as { keys: Array<{ id: string }> }
    expect(listed.keys.map((key) => key.id)).toContain(tempKey.id)

    const del = await router(new Request(`https://router.test/api/v1/keys/${tempKey.id}`, { method: 'DELETE', headers: bearer('admin-secret') }))
    expect(del.status).toBe(200)
    expect((await router(new Request('https://router.test/api/v1/status', { headers: bearer('automation-temp-secret') }))).status).toBe(401)

    const consoleAdmin = await router(new Request('https://router.test/admin/status', { headers: bearer('admin-secret') }))
    expect(consoleAdmin.status).toBe(401)
  })

  it('REQ-API-001 refuses automation-key management without an admin credential', async () => {
    const { router } = routerFixture()
    expect((await router(new Request('https://router.test/api/v1/keys', { method: 'POST', headers: bearer('not-admin') }))).status).toBe(401)
    expect((await router(new Request('https://router.test/api/v1/keys', { headers: bearer('not-admin') }))).status).toBe(401)
    expect((await router(new Request('https://router.test/api/v1/keys/automation_x', { method: 'DELETE', headers: bearer('not-admin') }))).status).toBe(401)
  })

  it('REQ-API-001 audits automation key creation and revocation', async () => {
    const { router, store } = routerFixture()
    const created = await mintKey(router)
    await router(new Request(`https://router.test/api/v1/keys/${created.id}`, { method: 'DELETE', headers: bearer('admin-secret') }))
    const createdEvent = store.audit.find((event) => event.type === 'automation_key_created')
    const revokedEvent = store.audit.find((event) => event.type === 'automation_key_revoked')
    expect(createdEvent?.detail).toMatchObject({ keyId: created.id })
    expect(revokedEvent?.detail).toMatchObject({ keyId: created.id })
    // The secret never lands in the audit trail.
    expect(JSON.stringify(store.audit)).not.toContain(created.token)
  })

  it('REQ-API-002 rejects an api request without a valid automation key', async () => {
    const { router } = routerFixture()
    expect((await router(new Request('https://router.test/api/v1/status', { headers: bearer('not-a-key') }))).status).toBe(401)
    // An admin session is not an automation key for the machine plane; the credential classes stay separate.
    expect((await router(new Request('https://router.test/api/v1/status', { headers: bearer('admin-secret') }))).status).toBe(401)
  })

  it('REQ-API-003 mints an enrollment token from an automation key', async () => {
    const { router } = routerFixture()
    const key = await mintKey(router)
    const res = await router(new Request('https://router.test/api/v1/enrollment-tokens', { method: 'POST', headers: bearer(key.token) }))
    expect(res.status).toBe(201)
    const body = await res.json() as { setupToken: string; expiresAt: number }
    expect(body.setupToken).toMatch(/^setup_/)
    expect(body.expiresAt).toBe(1_700_000_000_000 + 24 * 60 * 60 * 1000)
  })

  it('REQ-API-003 also mints an enrollment token from an admin credential', async () => {
    const { router } = routerFixture()
    const res = await router(new Request('https://router.test/api/v1/enrollment-tokens', { method: 'POST', headers: bearer('admin-secret') }))
    expect(res.status).toBe(201)
    expect((await res.json() as { setupToken: string }).setupToken).toMatch(/^setup_/)
  })

  it('REQ-API-003 audits enrollment-token minting with the automation caller', async () => {
    const { router, store } = routerFixture()
    const key = await mintKey(router)
    await router(new Request('https://router.test/api/v1/enrollment-tokens', { method: 'POST', headers: bearer(key.token) }))
    const event = store.audit.find((entry) => entry.type === 'setup_token_created' && String(entry.actor).startsWith('automation:'))
    expect(event?.actor).toBe(`automation:${key.id}`)
  })

  it('REQ-API-003 refuses enrollment-token minting without a credential', async () => {
    const { router } = routerFixture()
    expect((await router(new Request('https://router.test/api/v1/enrollment-tokens', { method: 'POST', headers: bearer('nope') }))).status).toBe(401)
  })

  it('REQ-API-004 refuses node access without an automation key', async () => {
    const { router } = routerFixture()
    expect((await router(new Request('https://router.test/api/v1/nodes', { headers: bearer('nope') }))).status).toBe(401)
    expect((await router(new Request('https://router.test/api/v1/nodes/node-a', { headers: bearer('nope') }))).status).toBe(401)
    expect((await router(new Request('https://router.test/api/v1/nodes/node-a', { method: 'DELETE', headers: bearer('nope') }))).status).toBe(401)
  })

  it('REQ-API-007 refuses model creation without an automation key', async () => {
    const { router, store } = routerFixture()
    const res = await apiAddModel(router, undefined, 'unsloth/Qwen3-14B-GGUF:Q4_K_M', 'single')
    expect(res.status).toBe(401)
    expect((await store.listProfiles()).some((profile) => profile.id.startsWith('custom-'))).toBe(false)
  })

  it('REQ-API-008 refuses model deletion without an automation key', async () => {
    const { router, store } = routerFixture()
    const key = await mintKey(router)
    const id = await addApiModelId(router, key.token)
    const res = await apiDeleteModel(router, undefined, id)
    expect(res.status).toBe(401)
    expect((await store.listProfiles()).some((profile) => profile.id === id)).toBe(true)
  })

  it('REQ-API-010 refuses model and version endpoints without an automation key', async () => {
    const { router } = routerFixture()
    expect((await router(new Request('https://router.test/api/v1/models', { headers: bearer('nope') }))).status).toBe(401)
    expect((await router(new Request('https://router.test/api/v1/models/x/enable', { method: 'POST', headers: bearer('nope') }))).status).toBe(401)
    expect((await router(new Request('https://router.test/api/v1/agent-versions', { headers: bearer('nope') }))).status).toBe(401)
    expect((await router(new Request('https://router.test/api/v1/agent-version', { method: 'PUT', headers: { ...bearer('nope'), 'content-type': 'application/json' }, body: '{}' }))).status).toBe(401)
    expect((await router(new Request('https://router.test/api/v1/runtime-versions', { headers: bearer('nope') }))).status).toBe(401)
    expect((await router(new Request('https://router.test/api/v1/runtime-versions', { method: 'PUT', headers: { ...bearer('nope'), 'content-type': 'application/json' }, body: '{}' }))).status).toBe(401)
  })

  // Events tests seed the automation key directly (no mint) so no automation_key_created event pollutes the log.

  it('REQ-API-006 refuses events access without an automation key', async () => {
    const { router } = routerFixture()
    expect((await router(new Request('https://router.test/api/v1/events', { headers: bearer('nope') }))).status).toBe(401)
  })
})
