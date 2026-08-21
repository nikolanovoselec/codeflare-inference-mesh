/**
 * control-plane API: node listing and lifecycle.
 *
 * One slice of the control-plane suite; shared fixtures live in
 * `./router-test-support`.
 */
import { bearer, mintKey, routerFixture } from './router-test-support'
import { createTokenRecord } from './auth'
import { describe, expect, it } from 'vitest'
import { nodeFixture } from './test-helpers'

describe('control-plane API: node listing and lifecycle', () => {
  it('REQ-API-002 exposes per-node runtime install status to automation callers', async () => {
    const { router, store } = routerFixture()
    const key = await mintKey(router)
    await store.putConfig('desired_llamacpp_version', 'b9912')
    await store.upsertNode({
      ...nodeFixture(),
      runtime: 'llamacpp',
      metrics: { runtimeKind: 'llamacpp', runtimeState: 'dependency-missing', activeRequests: 0, lastError: 'llama-server checksum mismatch' }
    })

    const status = await router(new Request('https://router.test/api/v1/status', { headers: bearer(key.token) }))
    const nodes = await router(new Request('https://router.test/api/v1/nodes', { headers: bearer(key.token) }))
    const statusBody = await status.json() as { runtimeInstalls: Array<Record<string, unknown>> }
    const nodesBody = await nodes.json() as { nodes: Array<{ runtimeInstall?: Record<string, unknown> }> }

    expect(statusBody.runtimeInstalls).toContainEqual(expect.objectContaining({ nodeId: 'node-a', runtime: 'llamacpp', desiredVersion: 'b9912', installedVersion: null, state: 'failed', error: 'llama-server checksum mismatch' }))
    expect(nodesBody.nodes[0]?.runtimeInstall).toMatchObject({ runtime: 'llamacpp', desiredVersion: 'b9912', installedVersion: null, state: 'failed', error: 'llama-server checksum mismatch' })
  })

  it('REQ-API-002 REQ-ADM-030 deactivates and reactivates a node over the automation API', async () => {
    const { router, store } = routerFixture()
    await store.upsertNode(nodeFixture())
    const key = await mintKey(router)

    const off = await router(new Request('https://router.test/api/v1/nodes/node-a/deactivate', { method: 'POST', headers: bearer(key.token) }))
    expect(off.status).toBe(200)
    expect((await off.json() as { node: { deactivated: boolean } }).node.deactivated).toBe(true)
    // The machine-facing node projection surfaces the taint so fleet tooling can read it back.
    const got = await router(new Request('https://router.test/api/v1/nodes/node-a', { headers: bearer(key.token) }))
    expect((await got.json() as { node: { deactivated: boolean } }).node.deactivated).toBe(true)

    const on = await router(new Request('https://router.test/api/v1/nodes/node-a/activate', { method: 'POST', headers: bearer(key.token) }))
    expect(on.status).toBe(200)
    expect((await on.json() as { node: { deactivated: boolean } }).node.deactivated).toBe(false)
    expect(store.audit.some((event) => event.type === 'node_activated' && event.target === 'node-a')).toBe(true)
  })

  it('REQ-API-004 lists nodes as projections without token verifiers', async () => {
    const { router, store } = routerFixture()
    const key = await mintKey(router)
    await store.upsertNode(nodeFixture({ id: 'node-x', nodeTokenVerifier: 'node-verifier-hash', upstreamTokenVerifier: 'up-verifier-hash' }))
    const res = await router(new Request('https://router.test/api/v1/nodes', { headers: bearer(key.token) }))
    expect(res.status).toBe(200)
    const body = await res.json() as { nodes: Array<{ id: string }>; nextCursor: string | null }
    expect(body.nodes.map((node) => node.id)).toContain('node-x')
    const serialized = JSON.stringify(body)
    expect(serialized).not.toContain('node-verifier-hash')
    expect(serialized).not.toContain('up-verifier-hash')
    expect(serialized).not.toContain('inferencePort')
  })

  it('REQ-API-012 filters the node list by status and search', async () => {
    const { router, store } = routerFixture()
    const key = await mintKey(router)
    await store.upsertNode(nodeFixture({ id: 'node-fresh', displayName: 'Alpha', status: 'online' }))
    await store.upsertNode(nodeFixture({ id: 'node-stale', displayName: 'Beta', status: 'offline' }))
    const online = await (await router(new Request('https://router.test/api/v1/nodes?status=online', { headers: bearer(key.token) }))).json() as { nodes: Array<{ id: string }> }
    expect(online.nodes.map((node) => node.id)).toEqual(['node-fresh'])
    const offline = await (await router(new Request('https://router.test/api/v1/nodes?status=offline', { headers: bearer(key.token) }))).json() as { nodes: Array<{ id: string }> }
    expect(offline.nodes.map((node) => node.id)).toEqual(['node-stale'])
    const bySearch = await (await router(new Request('https://router.test/api/v1/nodes?q=alph', { headers: bearer(key.token) }))).json() as { nodes: Array<{ id: string }> }
    expect(bySearch.nodes.map((node) => node.id)).toEqual(['node-fresh'])
  })

  it('REQ-API-012 paginates the node list by id cursor', async () => {
    const { router, store } = routerFixture()
    const key = await mintKey(router)
    for (const suffix of ['a', 'b', 'c']) await store.upsertNode(nodeFixture({ id: `node-${suffix}` }))
    const first = await (await router(new Request('https://router.test/api/v1/nodes?limit=2', { headers: bearer(key.token) }))).json() as { nodes: Array<{ id: string }>; nextCursor: string | null }
    expect(first.nodes.map((node) => node.id)).toEqual(['node-a', 'node-b'])
    expect(first.nextCursor).toBe('node-b')
    const second = await (await router(new Request('https://router.test/api/v1/nodes?limit=2&cursor=node-b', { headers: bearer(key.token) }))).json() as { nodes: Array<{ id: string }>; nextCursor: string | null }
    expect(second.nodes.map((node) => node.id)).toEqual(['node-c'])
    expect(second.nextCursor).toBeNull()
  })

  it('REQ-API-004 returns a single node and 404 for an unknown node', async () => {
    const { router, store } = routerFixture()
    const key = await mintKey(router)
    await store.upsertNode(nodeFixture({ id: 'node-solo' }))
    const found = await router(new Request('https://router.test/api/v1/nodes/node-solo', { headers: bearer(key.token) }))
    expect(found.status).toBe(200)
    expect((await found.json() as { node: { id: string } }).node.id).toBe('node-solo')
    const missing = await router(new Request('https://router.test/api/v1/nodes/node-ghost', { headers: bearer(key.token) }))
    expect(missing.status).toBe(404)
  })

  it('REQ-API-004 decommissions a node and revokes its credentials', async () => {
    const { router, store } = routerFixture()
    const key = await mintKey(router)
    await store.upsertNode(nodeFixture({ id: 'node-doomed' }))
    await store.putToken(await createTokenRecord('node', 'node-secret', 1_700_000_000_000, 'node-doomed'))
    const res = await router(new Request('https://router.test/api/v1/nodes/node-doomed', { method: 'DELETE', headers: bearer(key.token) }))
    expect(res.status).toBe(200)
    // Decommission removes the node from the store, not just soft-revokes it.
    expect(await store.getNode('node-doomed')).toBeUndefined()
    // The node's credential is revoked so it can no longer authenticate.
    const nodeTokens = await store.listTokens('node')
    expect(nodeTokens.filter((token) => token.nodeId === 'node-doomed' && token.active)).toHaveLength(0)
    const event = store.audit.find((entry) => entry.type === 'node_revoked' && entry.target === 'node-doomed')
    expect(event?.actor).toBe(`automation:${key.id}`)
    // Decommissioning an unknown node is a 404.
    expect((await router(new Request('https://router.test/api/v1/nodes/node-ghost', { method: 'DELETE', headers: bearer(key.token) }))).status).toBe(404)
  })

  it('REQ-SEC-002 hides a revoked tombstone node from every fleet listing', async () => {
    const { router, store } = routerFixture()
    const key = await mintKey(router)
    await store.upsertNode(nodeFixture({ id: 'node-live', status: 'online' }))
    await store.upsertNode(nodeFixture({ id: 'node-tombstone', status: 'online' }))
    // Simulate a mid-revoke failure (or a legacy revoke): the row is marked revoked but the
    // deleteNode step never ran, so the tombstone lingers in storage.
    await store.revokeNode('node-tombstone', 1_700_000_000_000)
    expect(await store.getNode('node-tombstone')).toBeDefined()

    // A revoked tombstone must not surface in listNodes or in the automation node list.
    const listed = await store.listNodes(1_700_000_000_000)
    expect(listed.map((node) => node.id)).toEqual(['node-live'])
    const api = await router(new Request('https://router.test/api/v1/nodes', { headers: bearer(key.token) }))
    expect(((await api.json()) as { nodes: { id: string }[] }).nodes.map((node) => node.id)).toEqual(['node-live'])
    // The single-node GET treats the tombstone as gone too (404, not the projection).
    expect((await router(new Request('https://router.test/api/v1/nodes/node-tombstone', { headers: bearer(key.token) }))).status).toBe(404)
  })

  it('REQ-API-004 decommission reaps a lingering revoked tombstone row', async () => {
    const { router, store } = routerFixture()
    const key = await mintKey(router)
    await store.upsertNode(nodeFixture({ id: 'node-tombstone', status: 'online' }))
    // Leave a revoked-but-undeleted tombstone (deleteNode never ran).
    await store.revokeNode('node-tombstone', 1_700_000_000_000)
    expect(await store.getNode('node-tombstone')).toBeDefined()
    // Decommission must still reach it (getNode, not the revoked-filtered listNodes) and hard-delete it.
    const res = await router(new Request('https://router.test/api/v1/nodes/node-tombstone', { method: 'DELETE', headers: bearer(key.token) }))
    expect(res.status).toBe(200)
    expect(await store.getNode('node-tombstone')).toBeUndefined()
  })

  it('REQ-ADM-023 refuses reconfigure and admin config for a revoked node', async () => {
    const { router, store } = routerFixture()
    const key = await mintKey(router)
    await store.upsertNode(nodeFixture({ id: 'node-tombstone', status: 'online' }))
    await store.revokeNode('node-tombstone', 1_700_000_000_000)
    // A revoked node is treated as gone: the reconfigure/config endpoints refuse it as unknown
    // (matching GET's 404), even though getNode can still reach it for decommission cleanup.
    const res = await router(new Request('https://router.test/api/v1/nodes/node-tombstone/reconfigure', { method: 'POST', headers: { ...bearer(key.token), 'content-type': 'application/json' }, body: JSON.stringify({ maxVramGbOverride: 6 }) }))
    expect(res.status).toBe(404)
    // The admin console config path (handleNodeConfig) refuses it identically.
    const adminConfig = await router(new Request('https://router.test/admin/nodes/node-tombstone/config', { method: 'POST', headers: { ...bearer('admin-secret'), 'content-type': 'application/json' }, body: JSON.stringify({ maxVramGbOverride: 6 }) }))
    expect(adminConfig.status).toBe(404)
  })

  it('REQ-ADM-023 reconfigures node name and VRAM override through the automation API', async () => {
    const { router, store } = routerFixture()
    const key = await mintKey(router)
    await store.upsertNode(nodeFixture({ id: 'node-weak' }))
    const res = await router(new Request('https://router.test/api/v1/nodes/node-weak/reconfigure', { method: 'POST', headers: { ...bearer(key.token), 'content-type': 'application/json' }, body: JSON.stringify({ displayName: 'Mac mini', maxVramGbOverride: 6 }) }))
    expect(res.status).toBe(200)
    expect((await res.json() as { node: { displayName: string; maxVramGbOverride: number } }).node).toMatchObject({ displayName: 'Mac mini', maxVramGbOverride: 6 })
    expect((await store.getNode('node-weak'))).toMatchObject({ displayName: 'Mac mini', maxVramGbOverride: 6 })
    // Unknown node is 404; a request without an automation key is 401.
    expect((await router(new Request('https://router.test/api/v1/nodes/node-ghost/reconfigure', { method: 'POST', headers: { ...bearer(key.token), 'content-type': 'application/json' }, body: JSON.stringify({ maxVramGbOverride: 6 }) }))).status).toBe(404)
    expect((await router(new Request('https://router.test/api/v1/nodes/node-weak/reconfigure', { method: 'POST', headers: { ...bearer('nope'), 'content-type': 'application/json' }, body: JSON.stringify({ maxVramGbOverride: 6 }) }))).status).toBe(401)
  })

  it('REQ-ADM-032 REQ-API-004 force reloads a node over the automation API', async () => {
    const { router, store } = routerFixture()
    const key = await mintKey(router)
    await store.upsertNode(nodeFixture())
    const res = await router(new Request('https://router.test/api/v1/nodes/node-a/reload', { method: 'POST', headers: bearer(key.token) }))
    expect(res.status).toBe(200)
    const { reloadNonce } = await res.json() as { reloadNonce: string }
    expect(reloadNonce).toBeTruthy()
    // The directive lands on the node record so the next heartbeat carries it, and the request is audited.
    expect((await store.getNode('node-a'))?.reloadNonce).toBe(reloadNonce)
    expect(store.audit.some((event) => event.type === 'node_reload_requested' && event.target === 'node-a' && event.actor.startsWith('automation:'))).toBe(true)
    // Unknown node is 404; a request without an automation key is 401.
    expect((await router(new Request('https://router.test/api/v1/nodes/node-ghost/reload', { method: 'POST', headers: bearer(key.token) }))).status).toBe(404)
    expect((await router(new Request('https://router.test/api/v1/nodes/node-a/reload', { method: 'POST', headers: bearer('nope') }))).status).toBe(401)
  })

})
