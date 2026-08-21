/**
 * control-plane API (/api/v1).
 *
 * One slice of the router's behavioural suite; shared fixtures live in
 * `./router-test-support`.
 */
import { createTokenRecord } from './auth'
import { describe, expect, it } from 'vitest'
import { MemoryStore, nodeFixture } from './test-helpers'
import { MESH_STATE_KEY_B64, SMOKE_UPSTREAM, bearer, githubReleasesFetcher, routerFixture, seedLegacyDefaults } from './router-test-support'

describe('control-plane API (/api/v1)', () => {
  async function mintKey(router: (request: Request) => Promise<Response>): Promise<{ id: string; token: string; createdAt: number }> {
    const res = await router(new Request('https://router.test/api/v1/keys', { method: 'POST', headers: bearer('admin-secret') }))
    return await res.json() as { id: string; token: string; createdAt: number }
  }

  const apiAddModel = (router: (request: Request) => Promise<Response>, token: string | undefined, modelRef: string, mode: string, runtime?: 'meshllm' | 'llamacpp') =>
    router(new Request('https://router.test/api/v1/models', {
      method: 'POST',
      headers: { ...(token ? bearer(token) : {}), 'content-type': 'application/json' },
      body: JSON.stringify({ modelRef, mode, ...(runtime ? { runtime } : {}) })
    }))

  const apiDeleteModel = (router: (request: Request) => Promise<Response>, token: string | undefined, id: string) =>
    router(new Request('https://router.test/api/v1/models/' + id, { method: 'DELETE', headers: token ? bearer(token) : {} }))

  const adminAddModel = (router: (request: Request) => Promise<Response>, ref: string, mode = 'single', token = 'admin-secret') =>
    router(new Request('https://router.test/admin/profiles/add', { method: 'POST', headers: { ...bearer(token), 'content-type': 'application/json' }, body: JSON.stringify({ modelRef: ref, mode }) }))

  const adminDeleteModel = (router: (request: Request) => Promise<Response>, profileId: string, token = 'admin-secret') =>
    router(new Request('https://router.test/admin/profiles/delete', { method: 'POST', headers: { ...bearer(token), 'content-type': 'application/json' }, body: JSON.stringify({ profileId }) }))

  const addApiModelId = async (router: (request: Request) => Promise<Response>, token: string, ref = 'unsloth/Qwen3-14B-GGUF:Q4_K_M') =>
    (await (await apiAddModel(router, token, ref, 'single')).json() as { model: { id: string } }).model.id

  async function seedAutomationKey(store: MemoryStore): Promise<string> {
    await store.putToken(await createTokenRecord('automation', 'auto-secret', 1_700_000_000_000))
    return 'auto-secret'
  }


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


  it('REQ-API-010 syncs the Gateway over the automation API and returns the provider token once', async () => {
    const gatewayResult = { providerId: 'prov', providerSlug: 'custom-inference-mesh-router-test', routeId: 'route', routeVersionId: 'ver', deploymentId: 'dep', gatewayId: 'inference-mesh', routeName: 'codeflare-mesh', publicModel: 'codeflare-mesh', workerUrl: 'https://mesh.example.com', manualProviderKeyRequired: true as const, providerTokenInstructions: 'x' }
    const { router, store } = routerFixture({
      env: { CLOUDFLARE_ACCOUNT_ID: 'acct-1', AI_GATEWAY_ID: 'inference-mesh' },
      cloudflareClient: {
        syncCustomProvider: async () => gatewayResult,
        provisionCustomDomain: async () => { throw new Error('unused') }
      }
    })
    await store.putConfig('custom_domain', { hostname: 'mesh.example.com', status: 'provisioned' })
    const key = await mintKey(router)

    const res = await router(new Request('https://router.test/api/v1/gateway/sync', { method: 'POST', headers: bearer(key.token) }))
    const body = await res.json() as { providerToken?: string; byokInstruction?: string }

    expect(res.status).toBe(200)
    expect(body.providerToken).toMatch(/^provider_/)
    expect(body.byokInstruction).toContain('custom-inference-mesh-router-test')
    expect(store.tokens.filter((token) => token.kind === 'provider' && token.active)).toHaveLength(1)
    expect(store.audit.some((event) => event.type === 'gateway_sync' && event.actor === `automation:${key.id}`)).toBe(true)
    expect((await router(new Request('https://router.test/api/v1/gateway/sync', { method: 'POST' }))).status).toBe(401)
  })


  it('REQ-API-002 returns a fleet snapshot to an authenticated automation caller', async () => {
    const { router } = routerFixture()
    const created = await mintKey(router)
    const res = await router(new Request('https://router.test/api/v1/status', { headers: bearer(created.token) }))
    expect(res.status).toBe(200)
    const body = await res.json() as { generatedAt: number; nodes: { total: number; online: number }; models: { total: number; active: number }; runtimeVersions: { meshllm: string; llamacpp: string }; runtimeInstalls: unknown[] }
    expect(body.generatedAt).toBe(1_700_000_000_000)
    expect(typeof body.nodes.total).toBe('number')
    expect(typeof body.nodes.online).toBe('number')
    expect(body.runtimeVersions).toEqual({ meshllm: 'v0.72.2', llamacpp: 'b9912' })
    expect(body.runtimeInstalls).toEqual([])
    // Seeded default profiles are visible to the snapshot.
    expect(body.models.total).toBeGreaterThan(0)
    expect(typeof body.models.active).toBe('number')
  })


  it('REQ-API-002 exposes detailed mesh roles, readiness, and stage ownership on request', async () => {
    const { router, store } = routerFixture({ env: { MESH_STATE_KEY: MESH_STATE_KEY_B64 } })
    const key = await mintKey(router)
    await store.upsertNode(nodeFixture({
      id: 'battlestation',
      activeProfileIds: ['mesh-smoke-qwen25-1.5b'],
      metrics: {
        runtimeKind: 'meshllm', runtimeState: 'starting', nodeState: 'standby', meshRole: 'api-client', apiReady: true, consoleReady: true,
        activeRequests: 0, readyModels: [SMOKE_UPSTREAM], meshllmVersion: '0.72.2', runtimeDetail: '\u001b[33m WARN\u001b[0m failed closing path',
        stageAssignments: [{ stageId: 'stage-0', stageIndex: 0, nodeId: 'battlestation', layerStart: 0, layerEnd: 15, state: 'ready', backend: 'metal', bindAddr: '100.64.1.10:4420' }]
      }
    }))

    const res = await router(new Request('https://router.test/api/v1/status?detail=full', { headers: bearer(key.token) }))
    expect(res.status).toBe(200)
    const body = await res.json() as { details?: { nodes: Array<{ id: string; runtimeInstall?: Record<string, unknown>; metrics?: Record<string, unknown> }>; profileReadiness: Array<Record<string, unknown>>; meshHealth: Array<{ profileId: string; coordinatorNodeId?: string; stageAssignments?: Array<Record<string, unknown>> }> } }
    const node = body.details?.nodes.find((candidate) => candidate.id === 'battlestation')
    expect(node?.metrics).toMatchObject({ meshRole: 'api-client', nodeState: 'standby' })
    expect(node?.runtimeInstall).toMatchObject({ runtime: 'meshllm', desiredVersion: 'v0.72.2', installedVersion: '0.72.2', state: 'installed', error: null })
    expect(body.details?.profileReadiness.find((entry) => entry.profileId === 'mesh-smoke-qwen25-1.5b')).toMatchObject({ ready: 1, downloading: 0, failed: 0 })
    const mesh = body.details?.meshHealth.find((entry) => entry.profileId === 'mesh-smoke-qwen25-1.5b')
    expect(mesh?.coordinatorNodeId).toBe('battlestation')
    expect(mesh?.stageAssignments).toContainEqual(expect.objectContaining({ stageIndex: 0, nodeId: 'battlestation', layerStart: 0, layerEnd: 15, reportedByNodeId: 'battlestation' }))
  })


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


  it('REQ-API-002 rejects an api request without a valid automation key', async () => {
    const { router } = routerFixture()
    expect((await router(new Request('https://router.test/api/v1/status', { headers: bearer('not-a-key') }))).status).toBe(401)
    // An admin session is not an automation key for the machine plane; the credential classes stay separate.
    expect((await router(new Request('https://router.test/api/v1/status', { headers: bearer('admin-secret') }))).status).toBe(401)
  })


  it('REQ-RTR-005 rejects a malformed JSON body with 400 invalid_json on an api endpoint', async () => {
    const { router } = routerFixture()
    const key = await mintKey(router)
    const res = await router(new Request('https://router.test/api/v1/models', { method: 'POST', headers: { ...bearer(key.token), 'content-type': 'application/json' }, body: '{ not valid json' }))
    // A malformed body is client error, not a router fault: 400 invalid_json, never a 500.
    expect(res.status).toBe(400)
    expect((await res.json() as { error: string }).error).toBe('invalid_json')
  })


  it('REQ-RTR-005 rejects a malformed JSON body with 400 invalid_json on a node endpoint', async () => {
    const { router } = routerFixture()
    // handleNodeHeartbeat parses the body via readJson before auth, so a malformed body is 400 invalid_json.
    const res = await router(new Request('https://router.test/node/heartbeat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{ not valid json' }))
    expect(res.status).toBe(400)
    expect((await res.json() as { error: string }).error).toBe('invalid_json')
  })


  it('REQ-RTR-005 rejects a malformed JSON body with 400 invalid_json on an admin endpoint', async () => {
    const { router } = routerFixture()
    // handleAgentVersionSelect parses the body directly (not via readJson); it routes a malformed
    // body through the same InvalidJsonBodyError boundary, so this admin route is 400 not 500.
    const res = await router(new Request('https://router.test/admin/agent-version', { method: 'POST', headers: { ...bearer('admin-secret'), 'content-type': 'application/json' }, body: '{ not valid json' }))
    expect(res.status).toBe(400)
    expect((await res.json() as { error: string }).error).toBe('invalid_json')
  })


  it('REQ-RTR-005 rejects a malformed body but accepts an absent one on an optional-body route', async () => {
    const { router } = routerFixture()
    // gateway/sync (readOptionalObject) and mesh/rotate (rotateProfileId) treat the body as
    // optional, but a PRESENT-yet-malformed body is still a client error -> 400 invalid_json.
    const badSync = await router(new Request('https://router.test/admin/cloudflare/gateway/sync', { method: 'POST', headers: { ...bearer('admin-secret'), 'content-type': 'application/json' }, body: '{ not json' }))
    expect(badSync.status).toBe(400)
    expect((await badSync.json() as { error: string }).error).toBe('invalid_json')
    const badRotate = await router(new Request('https://router.test/admin/mesh/rotate', { method: 'POST', headers: { ...bearer('admin-secret'), 'content-type': 'application/json' }, body: '{ not json' }))
    expect(badRotate.status).toBe(400)
    expect((await badRotate.json() as { error: string }).error).toBe('invalid_json')
    const badChat = await router(new Request('https://router.test/admin/playground/chat', { method: 'POST', headers: { ...bearer('admin-secret'), 'content-type': 'application/json' }, body: '{ not json' }))
    expect(badChat.status).toBe(400)
    expect((await badChat.json() as { error: string }).error).toBe('invalid_json')
    // An ABSENT body is still accepted (the route applies its defaults) — never rejected as invalid_json.
    const absentSync = await router(new Request('https://router.test/admin/cloudflare/gateway/sync', { method: 'POST', headers: bearer('admin-secret') }))
    expect((await absentSync.json() as { error?: string }).error).not.toBe('invalid_json')
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


  it('REQ-API-004 refuses node access without an automation key', async () => {
    const { router } = routerFixture()
    expect((await router(new Request('https://router.test/api/v1/nodes', { headers: bearer('nope') }))).status).toBe(401)
    expect((await router(new Request('https://router.test/api/v1/nodes/node-a', { headers: bearer('nope') }))).status).toBe(401)
    expect((await router(new Request('https://router.test/api/v1/nodes/node-a', { method: 'DELETE', headers: bearer('nope') }))).status).toBe(401)
  })


  it('REQ-SEC-006 REQ-API-002 rotates the mesh secret over the automation API', async () => {
    const { router, store } = routerFixture({ env: { MESH_STATE_KEY: MESH_STATE_KEY_B64 } })
    const key = await mintKey(router)
    const res = await router(new Request('https://router.test/api/v1/mesh/rotate', { method: 'POST', headers: { ...bearer(key.token), 'content-type': 'application/json' }, body: JSON.stringify({ profileId: 'mesh-smoke-qwen25-1.5b' }) }))
    expect(res.status).toBe(200)
    expect((await res.json() as { rotation: number }).rotation).toBe(1)
    expect(store.audit.some((event) => event.type === 'mesh_token_rotated' && event.actor.startsWith('automation:'))).toBe(true)
    // Unknown profile is 404; a request without an automation key is 401.
    expect((await router(new Request('https://router.test/api/v1/mesh/rotate', { method: 'POST', headers: { ...bearer(key.token), 'content-type': 'application/json' }, body: JSON.stringify({ profileId: 'ghost' }) }))).status).toBe(404)
    expect((await router(new Request('https://router.test/api/v1/mesh/rotate', { method: 'POST', headers: { ...bearer('nope'), 'content-type': 'application/json' }, body: JSON.stringify({ profileId: 'mesh-smoke-qwen25-1.5b' }) }))).status).toBe(401)
  })


  it('REQ-ADM-020 REQ-API-002 reads and writes fleet settings over the automation API', async () => {
    const { router, store } = routerFixture()
    const key = await mintKey(router)
    const put = await router(new Request('https://router.test/api/v1/settings', { method: 'PUT', headers: { ...bearer(key.token), 'content-type': 'application/json' }, body: JSON.stringify({ offlinePruneSeconds: 3600 }) }))
    expect(put.status).toBe(200)
    expect((await put.json() as { offlinePruneSeconds: number }).offlinePruneSeconds).toBe(3600)
    // The written value reads back through the GET twin and the write is audited to the automation caller.
    const got = await router(new Request('https://router.test/api/v1/settings', { headers: bearer(key.token) }))
    expect((await got.json() as { offlinePruneSeconds: number }).offlinePruneSeconds).toBe(3600)
    expect(store.audit.some((event) => event.type === 'settings_updated' && event.actor.startsWith('automation:'))).toBe(true)
    // A negative value is rejected; a request without an automation key is 401.
    expect((await router(new Request('https://router.test/api/v1/settings', { method: 'PUT', headers: { ...bearer(key.token), 'content-type': 'application/json' }, body: JSON.stringify({ offlinePruneSeconds: -5 }) }))).status).toBe(400)
    expect((await router(new Request('https://router.test/api/v1/settings', { headers: bearer('nope') }))).status).toBe(401)
  })


  it('REQ-API-005 lists models as projections with callable names', async () => {
    const { router, store } = routerFixture()
    await seedLegacyDefaults(store)
    const key = await mintKey(router)
    const res = await router(new Request('https://router.test/api/v1/models', { headers: bearer(key.token) }))
    expect(res.status).toBe(200)
    const body = await res.json() as { models: Array<{ id: string; callableNames: string[]; displayName: string; maxVramGb: number; split: boolean }> }
    const model = body.models.find((entry) => entry.id === 'mesh-default-qwen36-35b')
    expect(model?.displayName).toBe('Qwen3.6 35B')
    expect(model?.callableNames).toContain('codeflare-mesh')
    // The projection always carries a numeric VRAM budget (0 = no cap) so machine callers can read it.
    expect(typeof model?.maxVramGb).toBe('number')
    // The split serving flag is projected so automation can read back which models run multi-machine.
    expect(model?.split).toBe(false)
  })


  it('REQ-API-007 adds a single-machine model as an inactive projection', async () => {
    const { router, store } = routerFixture()
    const key = await mintKey(router)
    const res = await apiAddModel(router, key.token, 'unsloth/Qwen3-14B-GGUF:Q4_K_M', 'single')
    expect(res.status).toBe(201)
    const body = await res.json() as { model: { id: string; active: boolean; callableNames: string[]; modelRef: string } }
    expect(body.model.active).toBe(false)
    expect(body.model.callableNames).toContain('codeflare-mesh')
    expect(body.model.modelRef).toBe('unsloth/Qwen3-14B-GGUF:Q4_K_M')
    expect((await store.listProfiles()).some((profile) => profile.id === body.model.id && !profile.meshllm!.split)).toBe(true)
  })


  it('REQ-API-007 adds a direct llama.cpp single model as an inactive projection', async () => {
    const { router, store } = routerFixture()
    const key = await mintKey(router)
    const res = await apiAddModel(router, key.token, 'unsloth/Qwen3-14B-GGUF:Q4_K_M', 'single', 'llamacpp')
    expect(res.status).toBe(201)
    const body = await res.json() as { model: { id: string; runtime: string; tunables: unknown; llamacpp?: { cachePrompt: boolean; cacheReuse: number; parallel: number; gpuLayers?: string; cacheTypeK?: string; cacheTypeV?: string; batch?: number; ubatch?: number; maxOutputTokens?: number; reasoning?: { enabled?: boolean; format?: string; budget?: number } } } }
    const created = (await store.listProfiles()).find((profile) => profile.id === body.model.id)

    expect(body.model.runtime).toBe('llamacpp')
    expect(body.model.tunables).toBeNull()
    expect(body.model.llamacpp).toMatchObject({ cachePrompt: true, cacheReuse: 256, parallel: -1, kvUnified: true, gpuLayers: '99', cacheTypeK: 'q4_0', cacheTypeV: 'q4_0', batch: 8192, ubatch: 2048, maxOutputTokens: 16384, reasoning: { enabled: true, format: 'deepseek', budget: 8192 } })
    expect(created).toMatchObject({ runtime: 'llamacpp', sourceMode: 'llamacpp-hf', active: false })
  })


  it('REQ-API-007 rejects direct llama.cpp split model onboarding', async () => {
    const { router, store } = routerFixture()
    const key = await mintKey(router)
    const res = await apiAddModel(router, key.token, 'unsloth/Qwen3-14B-GGUF:Q4_K_M', 'split', 'llamacpp')

    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'split_requires_meshllm' })
    expect((await store.listProfiles()).some((profile) => profile.runtime === 'llamacpp')).toBe(false)
  })


  it('REQ-RUN-013 refuses a quant tag that resolves no file at creation', async () => {
    const { router, store } = routerFixture()
    const key = await mintKey(router)
    // The trailing-dot tag that once took codeflare-mesh down fleet-wide is refused
    // at the door, from the automation API and the console add path alike.
    const res = await apiAddModel(router, key.token, 'unsloth/Qwen3-14B-GGUF:UD-Q3_K_XL.', 'single', 'llamacpp')
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'invalid_quant_tag' })
    expect((await store.listProfiles()).some((profile) => profile.runtime === 'llamacpp')).toBe(false)

    const consoleAdd = await router(new Request('https://router.test/admin/profiles/add', {
      method: 'POST',
      headers: { ...bearer('admin-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ modelRef: 'unsloth/Qwen3-14B-GGUF:UD-Q3_K_XL.', mode: 'single', runtime: 'llamacpp' })
    }))
    expect(consoleAdd.status).toBe(400)
    expect(await consoleAdd.json()).toMatchObject({ error: 'invalid_quant_tag' })
    expect((await store.listProfiles()).some((profile) => profile.runtime === 'llamacpp')).toBe(false)
  })


  it('REQ-API-007 adds a split model with split serving enabled', async () => {
    const { router, store } = routerFixture()
    const key = await mintKey(router)
    const ref = 'hf://meshllm/Qwen3-14B-UD-Q4_K_XL-layers@abc123'
    const res = await apiAddModel(router, key.token, ref, 'split')
    expect(res.status).toBe(201)
    const body = await res.json() as { model: { split: boolean } }
    expect(body.model.split).toBe(true)
    const created = (await store.listProfiles()).find((profile) => profile.upstreamModel === ref)
    expect(created?.meshllm!.split).toBe(true)
    expect(created?.active).toBe(false)
  })


  it('REQ-API-007 rejects a blank model reference', async () => {
    const { router, store } = routerFixture()
    const key = await mintKey(router)
    const res = await apiAddModel(router, key.token, '  ', 'single')
    expect(res.status).toBe(400)
    expect((await store.listProfiles()).some((profile) => profile.id.startsWith('custom-'))).toBe(false)
  })


  it('REQ-API-007 refuses a duplicate model without overwriting', async () => {
    const { router, store } = routerFixture()
    const key = await mintKey(router)
    const first = await apiAddModel(router, key.token, 'unsloth/Qwen3-14B-GGUF:Q4_K_M', 'single')
    expect(first.status).toBe(201)
    const firstId = (await first.json() as { model: { id: string } }).model.id
    const second = await apiAddModel(router, key.token, 'unsloth/Qwen3-14B-GGUF:Q4_K_M', 'single')
    expect(second.status).toBe(409)
    expect((await store.listProfiles()).filter((profile) => profile.id === firstId).length).toBe(1)
  })


  it('REQ-API-007 refuses model creation without an automation key', async () => {
    const { router, store } = routerFixture()
    const res = await apiAddModel(router, undefined, 'unsloth/Qwen3-14B-GGUF:Q4_K_M', 'single')
    expect(res.status).toBe(401)
    expect((await store.listProfiles()).some((profile) => profile.id.startsWith('custom-'))).toBe(false)
  })


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


  it('REQ-API-008 REQ-RUN-012 deletes a custom inactive model over the API', async () => {
    const { router, store } = routerFixture()
    const key = await mintKey(router)
    const id = await addApiModelId(router, key.token)
    const res = await apiDeleteModel(router, key.token, id)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, id })
    expect((await store.listProfiles()).some((profile) => profile.id === id)).toBe(false)
  })


  it('REQ-API-008 REQ-RUN-012 refuses deleting the active model', async () => {
    const { router, store } = routerFixture()
    const key = await mintKey(router)
    const id = await addApiModelId(router, key.token)
    await router(new Request('https://router.test/api/v1/models/' + id + '/enable', { method: 'POST', headers: bearer(key.token) }))
    const res = await apiDeleteModel(router, key.token, id)
    expect(res.status).toBe(409)
    expect((await res.json() as { error: string }).error).toBe('model_active')
    expect((await store.listProfiles()).some((profile) => profile.id === id)).toBe(true)
  })


  it('REQ-API-008 REQ-RUN-012 deletes the switched-off starter like any other model and it never re-seeds', async () => {
    const { router, store } = routerFixture()
    const key = await mintKey(router)
    // The seeded starter is active; switching it off makes it deletable (REQ-RUN-012).
    await router(new Request('https://router.test/api/v1/models/mesh-smoke-qwen25-1.5b/disable', { method: 'POST', headers: bearer(key.token) }))
    const res = await apiDeleteModel(router, key.token, 'mesh-smoke-qwen25-1.5b')
    expect(res.status).toBe(200)
    expect((await store.listProfiles()).some((profile) => profile.id === 'mesh-smoke-qwen25-1.5b')).toBe(false)
    // Seed-once: another request cycle must not resurrect the deleted starter (REQ-RUN-002).
    await router(new Request('https://router.test/health'))
    expect((await store.listProfiles()).some((profile) => profile.id === 'mesh-smoke-qwen25-1.5b')).toBe(false)
  })


  it('REQ-API-008 REQ-RUN-012 returns 404 deleting an unknown model', async () => {
    const { router } = routerFixture()
    const key = await mintKey(router)
    const res = await apiDeleteModel(router, key.token, 'custom-does-not-exist')
    expect(res.status).toBe(404)
  })


  it('REQ-API-008 refuses model deletion without an automation key', async () => {
    const { router, store } = routerFixture()
    const key = await mintKey(router)
    const id = await addApiModelId(router, key.token)
    const res = await apiDeleteModel(router, undefined, id)
    expect(res.status).toBe(401)
    expect((await store.listProfiles()).some((profile) => profile.id === id)).toBe(true)
  })


  it('REQ-ADM-026 deletes a custom model from the console', async () => {
    const { router, store } = routerFixture()
    const added = await (await adminAddModel(router, 'unsloth/Qwen3-14B-GGUF:Q4_K_M')).json() as { profileId: string }
    const res = await adminDeleteModel(router, added.profileId)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, profileId: added.profileId })
    expect((await store.listProfiles()).some((profile) => profile.id === added.profileId)).toBe(false)
  })


  it('REQ-ADM-026 refuses console deletion only while the model is active', async () => {
    const { router, store } = routerFixture()
    const res = await adminDeleteModel(router, 'mesh-smoke-qwen25-1.5b')
    expect(res.status).toBe(409)
    expect((await res.json() as { error: string }).error).toBe('model_active')
    expect((await store.listProfiles()).some((profile) => profile.id === 'mesh-smoke-qwen25-1.5b')).toBe(true)
  })


  it('REQ-ADM-026 refuses console model deletion without an admin credential', async () => {
    const { router } = routerFixture()
    const res = await adminDeleteModel(router, 'custom-anything', 'not-admin')
    expect(res.status).toBe(401)
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


  it('REQ-API-005 configures a model context window and rejects invalid input', async () => {
    const { router, store } = routerFixture()
    await seedLegacyDefaults(store)
    const key = await mintKey(router)
    const headers = { ...bearer(key.token), 'content-type': 'application/json' }
    const ok = await router(new Request('https://router.test/api/v1/models/mesh-default-qwen36-35b', { method: 'POST', headers, body: JSON.stringify({ contextWindow: 8192 }) }))
    expect(ok.status).toBe(200)
    expect((await store.listProfiles()).find((profile) => profile.id === 'mesh-default-qwen36-35b')?.contextWindow).toBe(8192)
    // A VRAM budget is accepted, stored, and echoed in the returned projection; a negative budget is rejected.
    const vram = await router(new Request('https://router.test/api/v1/models/mesh-default-qwen36-35b', { method: 'POST', headers, body: JSON.stringify({ maxVramGb: 16 }) }))
    expect(vram.status).toBe(200)
    expect((await vram.json() as { model: { maxVramGb: number } }).model.maxVramGb).toBe(16)
    expect((await store.listProfiles()).find((profile) => profile.id === 'mesh-default-qwen36-35b')?.meshllm!.maxVramGb).toBe(16)
    expect((await router(new Request('https://router.test/api/v1/models/mesh-default-qwen36-35b', { method: 'POST', headers, body: JSON.stringify({ maxVramGb: -5 }) }))).status).toBe(400)
    // Context window 0 = Auto is accepted; a negative context is rejected.
    const autoCtx = await router(new Request('https://router.test/api/v1/models/mesh-default-qwen36-35b', { method: 'POST', headers, body: JSON.stringify({ contextWindow: 0 }) }))
    expect(autoCtx.status).toBe(200)
    const bad = await router(new Request('https://router.test/api/v1/models/mesh-default-qwen36-35b', { method: 'POST', headers, body: JSON.stringify({ contextWindow: -1 }) }))
    expect(bad.status).toBe(400)
    const missing = await router(new Request('https://router.test/api/v1/models/ghost', { method: 'POST', headers, body: JSON.stringify({ contextWindow: 8192 }) }))
    expect(missing.status).toBe(404)
  })


  it('REQ-API-005 REQ-RUN-020 configures direct llama.cpp settings over the automation API', async () => {
    const { router, store } = routerFixture()
    const key = await mintKey(router)
    const headers = { ...bearer(key.token), 'content-type': 'application/json' }
    const add = await apiAddModel(router, key.token, 'unsloth/Qwen3-14B-GGUF:Q4_K_M', 'single', 'llamacpp')
    const profileId = (await add.json() as { model: { id: string } }).model.id

    const ok = await router(new Request(`https://router.test/api/v1/models/${profileId}`, { method: 'POST', headers, body: JSON.stringify({ llamacpp: { contextWindow: 131072, parallel: 2, cacheReuse: 512, mmproj: false } }) }))
    const body = await ok.json() as { model: { runtime: string; llamacpp?: { contextWindow: number; parallel: number; cacheReuse: number; mmproj?: boolean } } }
    const stored = (await store.listProfiles()).find((profile) => profile.id === profileId)!

    expect(ok.status).toBe(200)
    expect(body.model.runtime).toBe('llamacpp')
    expect(body.model.llamacpp).toMatchObject({ contextWindow: 131072, parallel: 2, cacheReuse: 512, mmproj: false })
    expect(stored.llamacpp).toMatchObject({ contextWindow: 131072, parallel: 2, cacheReuse: 512, mmproj: false })
    const cleared = await router(new Request(`https://router.test/api/v1/models/${profileId}`, { method: 'POST', headers, body: JSON.stringify({ llamacpp: { mmproj: null } }) }))
    expect(cleared.status).toBe(200)
    expect((await store.listProfiles()).find((profile) => profile.id === profileId)?.llamacpp?.mmproj).toBeUndefined()
    expect((await router(new Request(`https://router.test/api/v1/models/${profileId}`, { method: 'POST', headers, body: JSON.stringify({ llamacpp: { cacheReuse: -1 } }) }))).status).toBe(400)
  })


  it('REQ-API-005 enables a model and switches off another with the same callable name', async () => {
    const { router, store } = routerFixture()
    await seedLegacyDefaults(store)
    const key = await mintKey(router)
    const res = await router(new Request('https://router.test/api/v1/models/mesh-split-qwen36-35b/enable', { method: 'POST', headers: bearer(key.token) }))
    expect(res.status).toBe(200)
    const body = await res.json() as { activated: string; deactivated: string[] }
    expect(body.activated).toBe('mesh-split-qwen36-35b')
    // Single-active: enabling split switches off the seeded active model (smoke), not the already-inactive 35B.
    expect(body.deactivated).toContain('mesh-smoke-qwen25-1.5b')
    const profiles = await store.listProfiles()
    expect(profiles.find((profile) => profile.id === 'mesh-split-qwen36-35b')?.active).toBe(true)
    expect(profiles.find((profile) => profile.id === 'mesh-default-qwen36-35b')?.active).toBe(false)
  })


  it('REQ-API-005 disables a model by dropping its traffic to zero', async () => {
    const { router, store } = routerFixture()
    await seedLegacyDefaults(store)
    const key = await mintKey(router)
    const res = await router(new Request('https://router.test/api/v1/models/mesh-default-qwen36-35b/disable', { method: 'POST', headers: bearer(key.token) }))
    expect(res.status).toBe(200)
    const profile = (await store.listProfiles()).find((entry) => entry.id === 'mesh-default-qwen36-35b')
    expect(profile?.rolloutPercent).toBe(0)
    expect(profile?.active).toBe(false)
  })


  it('REQ-API-010 lists available agent versions to an automation caller', async () => {
    const { router } = routerFixture({ releasesFetcher: githubReleasesFetcher(['v1.2.0', 'v1.1.0']) })
    const key = await mintKey(router)
    const res = await router(new Request('https://router.test/api/v1/agent-versions', { headers: bearer(key.token) }))
    expect(res.status).toBe(200)
    expect((await res.json() as { tags: string[] }).tags).toContain('v1.2.0')
  })


  it('REQ-API-010 sets the fleet agent version and rejects an unknown version', async () => {
    const { router, store } = routerFixture({ releasesFetcher: githubReleasesFetcher(['v1.2.0', 'v1.1.0']) })
    const key = await mintKey(router)
    const headers = { ...bearer(key.token), 'content-type': 'application/json' }
    const ok = await router(new Request('https://router.test/api/v1/agent-version', { method: 'PUT', headers, body: JSON.stringify({ version: 'v1.2.0' }) }))
    expect(ok.status).toBe(200)
    expect(await store.getConfig('desired_agent_version')).toBe('v1.2.0')
    const bad = await router(new Request('https://router.test/api/v1/agent-version', { method: 'PUT', headers, body: JSON.stringify({ version: 'v9.9.9' }) }))
    expect(bad.status).toBe(400)
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


  it('REQ-API-006 refuses events access without an automation key', async () => {
    const { router } = routerFixture()
    expect((await router(new Request('https://router.test/api/v1/events', { headers: bearer('nope') }))).status).toBe(401)
  })
})
