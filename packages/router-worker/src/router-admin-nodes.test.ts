/**
 * node lifecycle contracts: prune, deactivate, reload.
 *
 * One slice of the router's admin suite; shared fixtures live in
 * `./router-test-support`.
 */
import { DEFAULT_MODEL_PROFILES } from './profiles'
import { describe, expect, it } from 'vitest'
import { hashToken } from './auth'
import { MESH_STATE_KEY_B64, SMOKE_UPSTREAM, bearer, heartbeatBody, routerFixture } from './router-test-support'
import { nodeFixture } from './test-helpers'

describe('node lifecycle contracts: prune, deactivate, reload', () => {

  it('REQ-ADM-023 persists node name and VRAM override across heartbeat', async () => {
    const { router, store } = routerFixture()
    await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)
    await store.upsertNode({ ...nodeFixture({ status: 'online' }), nodeTokenVerifier: await hashToken('node-secret') })
    const config = (body: unknown) => router(new Request('https://router.test/admin/nodes/node-a/config', { method: 'POST', headers: { ...bearer('admin-secret'), 'content-type': 'application/json' }, body: JSON.stringify(body) }))
    const heartbeat = () => router(new Request('https://router.test/node/heartbeat', { method: 'POST', headers: { ...bearer('node-secret'), 'content-type': 'application/json' }, body: JSON.stringify({ nodeId: 'node-a', displayName: 'Node A', meshIp: '100.64.1.10', inferencePort: 8080, localDashboardPort: 17777, status: 'online', publicModels: ['codeflare-mesh'], activeProfileIds: ['mesh-default-qwen36-35b'], capacity: 2, inFlight: 1, runtime: 'meshllm' }) }))

    expect((await config({ displayName: 'Battlestation', maxVramGbOverride: 4 })).status).toBe(200)
    expect((await store.getNode('node-a'))?.displayName).toBe('Battlestation')
    expect((await store.getNode('node-a'))?.maxVramGbOverride).toBe(4)
    // The node's heartbeat now carries the override on every desired profile, capping it below the global,
    // but its self-reported displayName no longer overwrites the operator's stored name.
    const capped = await (await heartbeat()).json() as { desiredProfiles: Array<{ meshllm: { maxVramGb?: number } }> }
    expect(capped.desiredProfiles.length).toBeGreaterThan(0)
    expect(capped.desiredProfiles.every((profile) => profile.meshllm!.maxVramGb === 4)).toBe(true)
    expect((await store.getNode('node-a'))?.displayName).toBe('Battlestation')

    // Clearing removes the override so the node follows the model default again.
    expect((await config({ maxVramGbOverride: null })).status).toBe(200)
    expect((await store.getNode('node-a'))?.maxVramGbOverride).toBeUndefined()

    // Boundary + auth: a negative override is 400, a blank name is 400, an unknown node 404, a non-admin 401.
    expect((await config({ maxVramGbOverride: -1 })).status).toBe(400)
    expect((await config({ displayName: '   ' })).status).toBe(400)
    expect((await router(new Request('https://router.test/admin/nodes/ghost/config', { method: 'POST', headers: { ...bearer('admin-secret'), 'content-type': 'application/json' }, body: JSON.stringify({ maxVramGbOverride: 4 }) }))).status).toBe(404)
    expect((await router(new Request('https://router.test/admin/nodes/node-a/config', { method: 'POST', headers: { ...bearer('not-admin'), 'content-type': 'application/json' }, body: JSON.stringify({ maxVramGbOverride: 4 }) }))).status).toBe(401)
  })



  it('REQ-ADM-020 prunes nodes offline past the configured window and records the removal', async () => {
    const { router, store } = routerFixture()
    await store.upsertNode(nodeFixture({ id: 'stale', status: 'offline', lastSeenAt: 1_700_000_000_000 - 7_200_000 }))
    await store.upsertNode(nodeFixture({ id: 'fresh', status: 'online', lastSeenAt: 1_700_000_000_000 }))
    await store.putConfig('offline_prune_seconds', 3600)

    const response = await router(new Request('https://router.test/admin/status', { headers: bearer('admin-secret') }))

    expect(response.status).toBe(200)
    expect(await store.getNode('stale')).toBeUndefined()
    expect(await store.getNode('fresh')).toBeDefined()
    expect(store.audit.some((event) => event.type === 'node_pruned' && event.target === 'stale')).toBe(true)
  })



  it('REQ-ADM-020 keeps offline nodes when the prune window is zero', async () => {
    const { router, store } = routerFixture()
    await store.upsertNode(nodeFixture({ id: 'stale', status: 'offline', lastSeenAt: 1 }))
    await store.putConfig('offline_prune_seconds', 0)
    await router(new Request('https://router.test/admin/status', { headers: bearer('admin-secret') }))
    expect(await store.getNode('stale')).toBeDefined()
  })



  it('REQ-ADM-020 sets the offline prune window through the settings endpoint', async () => {
    const { router, store } = routerFixture()
    const ok = await router(new Request('https://router.test/admin/settings', { method: 'POST', headers: { ...bearer('admin-secret'), 'content-type': 'application/json' }, body: JSON.stringify({ offlinePruneSeconds: 3600 }) }))
    expect(ok.status).toBe(200)
    expect(await store.getConfig('offline_prune_seconds')).toBe(3600)
    expect((await router(new Request('https://router.test/admin/settings', { method: 'POST', headers: { ...bearer('admin-secret'), 'content-type': 'application/json' }, body: JSON.stringify({ offlinePruneSeconds: -5 }) }))).status).toBe(400)
    expect((await router(new Request('https://router.test/admin/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ offlinePruneSeconds: 3600 }) }))).status).toBe(401)
  })



  it('REQ-ADM-030 deactivates and reactivates a node from the admin console with audit', async () => {
    const { router, store } = routerFixture()
    await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)
    await store.upsertNode(nodeFixture())

    const off = await router(new Request('https://router.test/admin/nodes/node-a/deactivate', { method: 'POST', headers: bearer('admin-secret') }))
    expect(off.status).toBe(200)
    expect(await off.json()).toMatchObject({ ok: true, deactivated: true })
    expect((await store.getNode('node-a'))?.deactivated).toBe(true)
    expect(store.audit.some((event) => event.type === 'node_deactivated' && event.target === 'node-a')).toBe(true)

    const on = await router(new Request('https://router.test/admin/nodes/node-a/activate', { method: 'POST', headers: bearer('admin-secret') }))
    expect(on.status).toBe(200)
    expect(await on.json()).toMatchObject({ ok: true, deactivated: false })
    expect((await store.getNode('node-a'))?.deactivated).toBe(false)
    expect(store.audit.some((event) => event.type === 'node_activated' && event.target === 'node-a')).toBe(true)
  })



  it('REQ-ADM-030 deactivate requires an admin credential and leaves the node untouched otherwise', async () => {
    const { router, store } = routerFixture()
    await store.upsertNode(nodeFixture())
    expect((await router(new Request('https://router.test/admin/nodes/node-a/deactivate', { method: 'POST', headers: bearer('provider-secret') }))).status).toBe(401)
    expect((await store.getNode('node-a'))?.deactivated).toBeUndefined()
  })



  it('REQ-ADM-032 REQ-NODE-012 force reload stamps a nonce, delivers it once, and retires it on ack', async () => {
    const { router, store } = routerFixture()
    await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)
    await store.upsertNode({ ...nodeFixture(), nodeTokenVerifier: await hashToken('node-secret') })

    const requested = await router(new Request('https://router.test/admin/nodes/node-a/reload', { method: 'POST', headers: bearer('admin-secret') }))
    expect(requested.status).toBe(200)
    const { reloadNonce } = await requested.json() as { reloadNonce: string }
    expect(reloadNonce).toBeTruthy()
    expect((await store.getNode('node-a'))?.reloadNonce).toBe(reloadNonce)
    expect(store.audit.some((event) => event.type === 'node_reload_requested' && event.target === 'node-a')).toBe(true)

    const heartbeat = (ack?: string) => router(new Request('https://router.test/node/heartbeat', {
      method: 'POST',
      headers: { ...bearer('node-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: 'node-a', displayName: 'Node A', meshIp: '100.64.1.10', inferencePort: 8080, localDashboardPort: 17777, status: 'online', publicModels: ['codeflare-mesh'], activeProfileIds: ['mesh-smoke-qwen25-1.5b'], capacity: 2, inFlight: 0, runtime: 'meshllm', ...(ack !== undefined ? { reloadNonce: ack } : {}) })
    }))

    // The pending directive rides the heartbeat until the node applies it.
    const first = await (await heartbeat()).json() as { reloadNonce?: string }
    expect(first.reloadNonce).toBe(reloadNonce)

    // The node echoes the applied nonce → the router retires the directive.
    expect((await heartbeat(reloadNonce)).status).toBe(200)
    expect((await store.getNode('node-a'))?.reloadNonce).toBe('')
    const after = await (await heartbeat(reloadNonce)).json() as { reloadNonce?: string }
    expect(after.reloadNonce).toBeUndefined()
  })



  it('REQ-ADM-032 force reload requires an admin credential', async () => {
    const { router, store } = routerFixture()
    await store.upsertNode(nodeFixture())
    expect((await router(new Request('https://router.test/admin/nodes/node-a/reload', { method: 'POST', headers: bearer('provider-secret') }))).status).toBe(401)
    expect((await store.getNode('node-a'))?.reloadNonce).toBeUndefined()
  })



  it('REQ-ADM-030 REQ-NODE-011 a deactivated node heartbeat gets no desired profiles and the flag survives', async () => {
    const { router, store } = routerFixture()
    await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)
    await store.upsertNode({ ...nodeFixture({ deactivated: true }), nodeTokenVerifier: await hashToken('node-secret') })

    const res = await router(new Request('https://router.test/node/heartbeat', {
      method: 'POST',
      headers: { ...bearer('node-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: 'node-a', displayName: 'Node A', meshIp: '100.64.1.10', inferencePort: 8080, localDashboardPort: 17777, status: 'online', publicModels: ['codeflare-mesh'], activeProfileIds: ['mesh-smoke-qwen25-1.5b'], capacity: 2, inFlight: 0, runtime: 'meshllm', metrics: { runtimeState: 'ready', activeRequests: 0, apiReady: true, readyModels: [SMOKE_UPSTREAM] } })
    }))
    const body = await res.json() as { ok: boolean; desiredProfiles: unknown[]; deactivated?: boolean; meshBootstrap?: unknown }

    expect(res.status).toBe(200)
    expect(body.deactivated).toBe(true)
    expect(body.desiredProfiles).toEqual([])
    expect(body.meshBootstrap).toBeUndefined()
    // The heartbeat body never carries the operator flag; the router carries it forward across the write.
    expect((await store.getNode('node-a'))?.deactivated).toBe(true)
  })



  it('REQ-ADM-030 a deactivated node is excluded from inference selection', async () => {
    const { router, store } = routerFixture()
    await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)
    await store.upsertNode(nodeFixture({ deactivated: true }))

    const res = await router(new Request('https://router.test/v1/chat/completions', {
      method: 'POST',
      headers: { ...bearer('provider-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'codeflare-mesh', messages: [] })
    }))
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: 'no_healthy_node' })
  })



  it('REQ-ADM-030 REQ-NODE-011 deactivating a node drops its mesh token and later heartbeats do not re-add it', async () => {
    const { router, store } = routerFixture({ env: { MESH_STATE_KEY: MESH_STATE_KEY_B64 } })
    await store.upsertNode({ ...nodeFixture(), nodeTokenVerifier: await hashToken('node-secret') })
    await router(new Request('https://router.test/node/heartbeat', {
      method: 'POST',
      headers: { ...bearer('node-secret'), 'content-type': 'application/json' },
      body: heartbeatBody({ meshId: 'mesh-1', meshToken: 'invite-token-value-a' })
    }))
    expect(store.config.get('mesh_state:mesh-smoke-qwen25-1.5b')).toBeDefined()

    // Deactivating tears the node's now-dead invite token out of mesh state so peers stop dialing it.
    const off = await router(new Request('https://router.test/admin/nodes/node-a/deactivate', { method: 'POST', headers: bearer('admin-secret') }))
    expect(off.status).toBe(200)
    expect(store.audit.some((event) => event.type === 'mesh_token_removed' && event.target === 'node-a')).toBe(true)

    // A heartbeat from the still-deactivated node must not re-add the token (the mesh-state guard).
    await router(new Request('https://router.test/node/heartbeat', {
      method: 'POST',
      headers: { ...bearer('node-secret'), 'content-type': 'application/json' },
      body: heartbeatBody({ meshId: 'mesh-1', meshToken: 'invite-token-value-a' })
    }))
    const status = await router(new Request('https://router.test/admin/status', { headers: bearer('admin-secret') }))
    const statusBody = await status.json() as { meshHealth?: Array<{ profileId: string; tokenCount?: number }> }
    const entry = (statusBody.meshHealth ?? []).find((candidate) => candidate.profileId === 'mesh-smoke-qwen25-1.5b')
    expect(entry?.tokenCount ?? 0).toBe(0)
  })

})
