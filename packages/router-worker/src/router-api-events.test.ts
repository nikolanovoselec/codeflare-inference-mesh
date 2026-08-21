/**
 * control-plane API: operational event feed.
 *
 * One slice of the control-plane suite; shared fixtures live in
 * `./router-test-support`.
 */
import { addApiModelId, apiAddModel, apiDeleteModel, bearer, mintKey, routerFixture } from './router-test-support'
import { createTokenRecord } from './auth'
import { describe, expect, it } from 'vitest'
import { MemoryStore } from './test-helpers'

describe('control-plane API: operational event feed', () => {
  async function seedAutomationKey(store: MemoryStore): Promise<string> {
    await store.putToken(await createTokenRecord('automation', 'auto-secret', 1_700_000_000_000))
    return 'auto-secret'
  }

  it('REQ-OBS-006 records a profile-added audit event for programmatic model onboarding', async () => {
    const { router, store } = routerFixture()
    const key = await mintKey(router)
    const res = await apiAddModel(router, key.token, 'unsloth/Qwen3-14B-GGUF:Q4_K_M', 'single')
    expect(res.status).toBe(201)
    const added = await res.json() as { model: { id: string } }
    const event = (await store.listAudit(10)).find((entry) => entry.type === 'profile_added')
    expect(event?.target).toBe(added.model.id)
    // The API path stamps an automation actor, distinguishing it from the Access-session console add.
    expect(event?.actor).toMatch(/^automation:/)
    expect(event?.detail).toMatchObject({ modelRef: 'unsloth/Qwen3-14B-GGUF:Q4_K_M', split: false })
  })

  it('REQ-OBS-006 records a profile-deleted audit event for model deletion', async () => {
    const { router, store } = routerFixture()
    const key = await mintKey(router)
    const id = await addApiModelId(router, key.token)
    await apiDeleteModel(router, key.token, id)
    const event = (await store.listAudit(10)).find((entry) => entry.type === 'profile_deleted')
    expect(event?.target).toBe(id)
    expect(event?.actor).toMatch(/^automation:/)
  })

  it('REQ-API-006 lists operational events oldest-first and hides internal bookkeeping', async () => {
    const { router, store } = routerFixture()
    const token = await seedAutomationKey(store)
    await store.appendAudit({ id: 'e1', type: 'node_claimed', at: 100, actor: 'setup', target: 'node-a', detail: {} })
    await store.appendAudit({ id: 'e2', type: 'mesh_state_stored', at: 150, actor: 'system', detail: {} })
    await store.appendAudit({ id: 'e3', type: 'profile_activated', at: 200, actor: 'admin', target: 'm', detail: {} })
    const res = await router(new Request('https://router.test/api/v1/events', { headers: bearer(token) }))
    expect(res.status).toBe(200)
    const body = await res.json() as { events: Array<{ id: string; type: string }>; nextCursor: string | null }
    expect(body.events.map((event) => event.id)).toEqual(['e1', 'e3'])
    expect(body.events.map((event) => event.type)).not.toContain('mesh_state_stored')
  })

  it('REQ-API-006 returns only events after the since timestamp', async () => {
    const { router, store } = routerFixture()
    const token = await seedAutomationKey(store)
    await store.appendAudit({ id: 'old', type: 'node_claimed', at: 100, actor: 'setup', target: 'n', detail: {} })
    await store.appendAudit({ id: 'new', type: 'node_claimed', at: 500, actor: 'setup', target: 'n', detail: {} })
    const body = await (await router(new Request('https://router.test/api/v1/events?since=200', { headers: bearer(token) }))).json() as { events: Array<{ id: string }> }
    expect(body.events.map((event) => event.id)).toEqual(['new'])
  })

  it('REQ-API-006 filters events by type', async () => {
    const { router, store } = routerFixture()
    const token = await seedAutomationKey(store)
    await store.appendAudit({ id: 'a', type: 'node_claimed', at: 100, actor: 'setup', target: 'n', detail: {} })
    await store.appendAudit({ id: 'b', type: 'profile_activated', at: 200, actor: 'admin', target: 'm', detail: {} })
    const body = await (await router(new Request('https://router.test/api/v1/events?type=profile_activated', { headers: bearer(token) }))).json() as { events: Array<{ id: string }> }
    expect(body.events.map((event) => event.id)).toEqual(['b'])
  })

  it('REQ-API-006 paginates events by cursor', async () => {
    const { router, store } = routerFixture()
    const token = await seedAutomationKey(store)
    for (const [id, at] of [['x1', 10], ['x2', 20], ['x3', 30]] as const) {
      await store.appendAudit({ id, type: 'node_claimed', at, actor: 'setup', target: 'n', detail: {} })
    }
    const first = await (await router(new Request('https://router.test/api/v1/events?limit=2', { headers: bearer(token) }))).json() as { events: Array<{ id: string }>; nextCursor: string | null }
    expect(first.events.map((event) => event.id)).toEqual(['x1', 'x2'])
    expect(first.nextCursor).toBe('20:x2')
    const second = await (await router(new Request(`https://router.test/api/v1/events?limit=2&since=${first.nextCursor}`, { headers: bearer(token) }))).json() as { events: Array<{ id: string }>; nextCursor: string | null }
    expect(second.events.map((event) => event.id)).toEqual(['x3'])
    expect(second.nextCursor).toBeNull()
  })

  it('REQ-API-006 keyset cursor does not skip same-millisecond events across a page boundary', async () => {
    const { router, store } = routerFixture()
    const token = await seedAutomationKey(store)
    await store.appendAudit({ id: 'a1', type: 'node_claimed', at: 50, actor: 'setup', target: 'n', detail: {} })
    await store.appendAudit({ id: 'a2', type: 'node_claimed', at: 50, actor: 'setup', target: 'n', detail: {} })
    const first = await (await router(new Request('https://router.test/api/v1/events?limit=1', { headers: bearer(token) }))).json() as { events: Array<{ id: string }>; nextCursor: string | null }
    expect(first.events.map((event) => event.id)).toEqual(['a1'])
    expect(first.nextCursor).toBe('50:a1')
    const second = await (await router(new Request(`https://router.test/api/v1/events?limit=1&since=${first.nextCursor}`, { headers: bearer(token) }))).json() as { events: Array<{ id: string }> }
    expect(second.events.map((event) => event.id)).toEqual(['a2'])
    // A bare millisecond cursor stays exclusive: both events AT 50 are skipped.
    const bare = await (await router(new Request('https://router.test/api/v1/events?since=50', { headers: bearer(token) }))).json() as { events: Array<{ id: string }> }
    expect(bare.events.map((event) => event.id)).toEqual([])
  })

})
