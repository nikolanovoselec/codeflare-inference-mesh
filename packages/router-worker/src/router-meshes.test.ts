/**
 * multi-mesh machine groups.
 *
 * One slice of the router's behavioural suite; shared fixtures live in
 * `./router-test-support`.
 */
import { CloudflareGatewayClient } from './cloudflare-api'
import { DEFAULT_MODEL_PROFILES } from './profiles'
import { describe, expect, it } from 'vitest'
import { hashToken } from './auth'
import { MESH_STATE_KEY_B64, bearer, heartbeatBody, routerFixture } from './router-test-support'
import { nodeFixture } from './test-helpers'

describe('multi-mesh machine groups', () => {
  const DEV_GGUF = 'unsloth/Qwen3-14B-GGUF:Q4_K_M'

  async function mintKey(router: (request: Request) => Promise<Response>): Promise<string> {
    const res = await router(new Request('https://router.test/api/v1/keys', { method: 'POST', headers: bearer('admin-secret') }))
    return ((await res.json()) as { token: string }).token
  }

  const createMeshReq = (router: (request: Request) => Promise<Response>, name: string, token = 'admin-secret') =>
    router(new Request('https://router.test/admin/meshes', {
      method: 'POST',
      headers: { ...bearer(token), 'content-type': 'application/json' },
      body: JSON.stringify({ name })
    }))

  const addModelReq = (router: (request: Request) => Promise<Response>, body: Record<string, unknown>) =>
    router(new Request('https://router.test/admin/profiles/add', {
      method: 'POST',
      headers: { ...bearer('admin-secret'), 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }))

  const configureProfile = (router: (request: Request) => Promise<Response>, body: Record<string, unknown>) =>
    router(new Request('https://router.test/admin/profiles/config', {
      method: 'POST',
      headers: { ...bearer('admin-secret'), 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }))


  it('REQ-ADM-037 creates and lists meshes with machine and model counts', async () => {
    const { router, store } = routerFixture()
    await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)

    const created = await createMeshReq(router, 'dEvElOpMeNt')
    expect(created.status).toBe(201)
    expect(await created.json()).toMatchObject({ mesh: { id: 'development', name: 'Development', alias: 'codeflare-mesh-development' } })
    expect(store.audit.some((event) => event.type === 'mesh_created' && event.target === 'development')).toBe(true)

    await store.upsertNode({ ...nodeFixture(), meshId: 'development' })
    expect((await addModelReq(router, { modelRef: DEV_GGUF, mode: 'single', meshId: 'development' })).status).toBe(201)

    const list = await router(new Request('https://router.test/admin/meshes', { headers: bearer('admin-secret') }))
    const body = await list.json() as { meshes: Array<{ id: string; name: string; alias: string; machineCount: number; modelCount: number }> }
    expect(list.status).toBe(200)
    expect(body.meshes[0]).toMatchObject({ id: 'default', name: 'Default', alias: 'codeflare-mesh', machineCount: 0, modelCount: 1 })
    expect(body.meshes.find((mesh) => mesh.id === 'development')).toMatchObject({ name: 'Development', alias: 'codeflare-mesh-development', machineCount: 1, modelCount: 1 })
  })


  it('REQ-ADM-037 rejects invalid, duplicate, and alias-colliding mesh names', async () => {
    const { router, store } = routerFixture()
    for (const bad of ['', 'Dev Ops', 'noobs!', 'a'.repeat(33)]) {
      const res = await createMeshReq(router, bad)
      expect(res.status).toBe(400)
      expect((await res.json() as { error: string }).error).toBe('invalid_mesh_name')
    }
    expect((await createMeshReq(router, 'Development')).status).toBe(201)
    for (const dup of ['DEVELOPMENT', 'development', 'Default']) {
      const res = await createMeshReq(router, dup)
      expect(res.status).toBe(409)
      expect((await res.json() as { error: string }).error).toBe('mesh_exists')
    }
    // A stored profile already answering the would-be mesh alias blocks creation:
    // the alias would gain two owners the moment a model activates in the new mesh.
    await store.setProfile({ ...LEGACY_MESH_DEFAULT, publicAliases: ['codeflare-mesh', 'codeflare-mesh-ops'] })
    const collision = await createMeshReq(router, 'Ops')
    expect(collision.status).toBe(409)
    expect((await collision.json() as { error: string }).error).toBe('mesh_alias_conflict')
  })


  it('REQ-ADM-037 deletes only empty non-default meshes', async () => {
    const { router, store } = routerFixture()
    const del = (id: string) => router(new Request(`https://router.test/admin/meshes/${id}`, { method: 'DELETE', headers: bearer('admin-secret') }))

    expect((await del('default')).status).toBe(400)
    expect((await del('ghost')).status).toBe(404)

    await createMeshReq(router, 'Development')
    await store.upsertNode({ ...nodeFixture(), meshId: 'development' })
    expect((await del('development')).status).toBe(409)
    expect((await (await del('development')).json() as { error: string }).error).toBe('mesh_not_empty')

    await createMeshReq(router, 'Ops')
    expect((await addModelReq(router, { modelRef: DEV_GGUF, mode: 'single', meshId: 'ops' })).status).toBe(201)
    expect((await del('ops')).status).toBe(409)

    await store.upsertNode({ ...nodeFixture(), meshId: 'default' })
    const emptied = await del('development')
    expect(emptied.status).toBe(200)
    const deletion = store.audit.find((event) => event.type === 'mesh_deleted' && event.target === 'development')
    expect(deletion?.detail).toMatchObject({ routeName: 'codeflare-mesh-development' })
    expect((await (await router(new Request('https://router.test/admin/meshes', { headers: bearer('admin-secret') }))).json() as { meshes: Array<{ id: string }> }).meshes.map((mesh) => mesh.id)).toEqual(['default', 'ops'])
  })


  it('REQ-API-011 automation manages meshes through the /api/v1 twins', async () => {
    const { router } = routerFixture()
    const token = await mintKey(router)

    expect((await router(new Request('https://router.test/api/v1/meshes', { headers: bearer('nope') }))).status).toBe(401)

    const created = await router(new Request('https://router.test/api/v1/meshes', {
      method: 'POST',
      headers: { ...bearer(token), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Noobs' })
    }))
    expect(created.status).toBe(201)
    expect(await created.json()).toMatchObject({ mesh: { id: 'noobs', name: 'Noobs', alias: 'codeflare-mesh-noobs' } })

    const list = await router(new Request('https://router.test/api/v1/meshes', { headers: bearer(token) }))
    expect(list.status).toBe(200)
    expect((await list.json() as { meshes: Array<{ id: string }> }).meshes.map((mesh) => mesh.id)).toEqual(['default', 'noobs'])

    expect((await router(new Request('https://router.test/api/v1/meshes/noobs', { method: 'DELETE', headers: bearer(token) }))).status).toBe(200)
  })


  it('REQ-SCH-006 heartbeat and claim send only the node mesh profiles', async () => {
    const { router, store } = routerFixture()
    await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)
    await createMeshReq(router, 'Development')
    expect((await addModelReq(router, { modelRef: DEV_GGUF, mode: 'single', meshId: 'development' })).status).toBe(201)
    const devProfileId = (await store.listProfiles()).find((profile) => profile.meshId === 'development')!.id
    await store.upsertNode({ ...nodeFixture(), nodeTokenVerifier: await hashToken('node-secret') })

    const beat = (body: string) => router(new Request('https://router.test/node/heartbeat', {
      method: 'POST',
      headers: { ...bearer('node-secret'), 'content-type': 'application/json' },
      body
    }))
    const first = await (await beat(heartbeatBody())).json() as { desiredProfiles: Array<{ id: string }> }
    expect(first.desiredProfiles.map((profile) => profile.id)).toContain('mesh-smoke-qwen25-1.5b')
    expect(first.desiredProfiles.map((profile) => profile.id)).not.toContain(devProfileId)

    // After reassignment the node still self-reports its old profile ids for a tick;
    // the router must answer with the new group's catalog anyway.
    const reassign = await router(new Request('https://router.test/admin/nodes/node-a/config', {
      method: 'POST',
      headers: { ...bearer('admin-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ meshId: 'development' })
    }))
    expect(reassign.status).toBe(200)
    const second = await (await beat(heartbeatBody())).json() as { desiredProfiles: Array<{ id: string }> }
    expect(second.desiredProfiles.map((profile) => profile.id)).toEqual([devProfileId])

    // A brand-new claim lands in the default mesh and receives only its catalog.
    const tokenResponse = await router(new Request('https://router.test/admin/setup-tokens', { method: 'POST', headers: bearer('admin-secret') }))
    const { setupToken } = await tokenResponse.json() as { setupToken: string }
    const claim = await router(new Request('https://router.test/node/claim', {
      method: 'POST',
      headers: { ...bearer(setupToken), 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Node B', meshIp: '100.64.1.11', inferencePort: 8080, publicModels: [], activeProfileIds: [], capacity: 1 })
    }))
    expect(claim.status).toBe(201)
    const claimed = await claim.json() as { nodeId: string; profiles: Array<{ id: string }> }
    expect(claimed.profiles.map((profile) => profile.id)).toContain('mesh-smoke-qwen25-1.5b')
    expect(claimed.profiles.map((profile) => profile.id)).not.toContain(devProfileId)
    expect((await store.getNode(claimed.nodeId))?.meshId ?? 'default').toBe('default')
  })


  it('REQ-ADM-023 reassigning a node drops its mesh tokens and heartbeats do not re-add them', async () => {
    const { router, store } = routerFixture({ env: { MESH_STATE_KEY: MESH_STATE_KEY_B64 } })
    await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)
    await createMeshReq(router, 'Development')
    await store.upsertNode({ ...nodeFixture(), nodeTokenVerifier: await hashToken('node-secret') })
    const beat = () => router(new Request('https://router.test/node/heartbeat', {
      method: 'POST',
      headers: { ...bearer('node-secret'), 'content-type': 'application/json' },
      body: heartbeatBody({ meshId: 'mesh-1', meshToken: 'invite-token-value-a' })
    }))
    await beat()
    expect(store.config.get('mesh_state:mesh-smoke-qwen25-1.5b')).toBeDefined()

    const config = (body: Record<string, unknown>) => router(new Request('https://router.test/admin/nodes/node-a/config', {
      method: 'POST',
      headers: { ...bearer('admin-secret'), 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }))
    expect((await config({ meshId: 'ghost' })).status).toBe(400)
    expect((await (await config({ meshId: 'ghost' })).json() as { error: string }).error).toBe('unknown_mesh')

    const moved = await config({ meshId: 'development' })
    expect(moved.status).toBe(200)
    expect((await moved.json() as { meshId: string }).meshId).toBe('development')
    const assignment = store.audit.find((event) => event.type === 'node_mesh_assigned' && event.target === 'node-a')
    expect(assignment?.detail).toMatchObject({ from: 'default', to: 'development' })
    expect(store.audit.some((event) => event.type === 'mesh_token_removed' && event.target === 'node-a')).toBe(true)

    // The node's next heartbeat still carries the old mesh token and stale profile ids;
    // the mesh gate must not hand back a bootstrap or re-add the token.
    const after = await (await beat()).json() as { desiredProfiles: unknown[]; meshBootstrap?: unknown }
    expect(after.desiredProfiles).toEqual([])
    expect(after.meshBootstrap).toBeUndefined()
    const status = await router(new Request('https://router.test/admin/status', { headers: bearer('admin-secret') }))
    const statusBody = await status.json() as { meshHealth?: Array<{ profileId: string; tokenCount?: number }> }
    expect((statusBody.meshHealth ?? []).find((entry) => entry.profileId === 'mesh-smoke-qwen25-1.5b')?.tokenCount ?? 0).toBe(0)
  })


  it('REQ-API-004 the reconfigure twin accepts meshId and api nodes carry it', async () => {
    const { router, store } = routerFixture()
    await createMeshReq(router, 'Development')
    await store.upsertNode(nodeFixture())
    const token = await mintKey(router)

    const moved = await router(new Request('https://router.test/api/v1/nodes/node-a/reconfigure', {
      method: 'POST',
      headers: { ...bearer(token), 'content-type': 'application/json' },
      body: JSON.stringify({ meshId: 'development' })
    }))
    expect(moved.status).toBe(200)
    expect((await moved.json() as { node: { meshId: string } }).node.meshId).toBe('development')

    const list = await router(new Request('https://router.test/api/v1/nodes', { headers: bearer(token) }))
    const nodes = (await list.json() as { nodes: Array<{ id: string; meshId: string }> }).nodes
    expect(nodes.find((node) => node.id === 'node-a')?.meshId).toBe('development')
  })


  it('REQ-SCH-006 profile readiness counts only same-mesh nodes', async () => {
    const { router, store } = routerFixture()
    await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)
    await createMeshReq(router, 'Development')
    await store.upsertNode({ ...nodeFixture(), nodeTokenVerifier: await hashToken('node-secret') })
    await router(new Request('https://router.test/node/heartbeat', {
      method: 'POST',
      headers: { ...bearer('node-secret'), 'content-type': 'application/json' },
      body: heartbeatBody()
    }))

    const readiness = async () => {
      const res = await router(new Request('https://router.test/admin/status', { headers: bearer('admin-secret') }))
      const body = await res.json() as { profileReadiness?: Array<{ profileId: string; ready: number }> }
      return (body.profileReadiness ?? []).find((entry) => entry.profileId === 'mesh-smoke-qwen25-1.5b')?.ready ?? 0
    }
    expect(await readiness()).toBe(1)

    const node = (await store.getNode('node-a'))!
    await store.upsertNode({ ...node, meshId: 'development' })
    expect(await readiness()).toBe(0)
  })


  it('REQ-RUN-016 reassigning a model swaps its mesh alias and deactivates it', async () => {
    const { router, store } = routerFixture()
    await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)
    await createMeshReq(router, 'Development')
    const add = await addModelReq(router, { modelRef: DEV_GGUF, mode: 'single' })
    const profileId = (await add.json() as { profileId: string }).profileId
    await router(new Request('https://router.test/admin/profiles/activate', {
      method: 'POST',
      headers: { ...bearer('admin-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ profileId })
    }))
    const activated = (await store.listProfiles()).find((profile) => profile.id === profileId)!
    expect(activated.active).toBe(true)

    const moved = await configureProfile(router, { profileId, meshId: 'development' })
    expect(moved.status).toBe(200)
    expect((await moved.json() as { meshId: string }).meshId).toBe('development')
    const reassigned = (await store.listProfiles()).find((profile) => profile.id === profileId)!
    expect(reassigned.meshId).toBe('development')
    expect(reassigned.publicAliases[0]).toBe('codeflare-mesh-development')
    expect(reassigned.publicAliases).not.toContain('codeflare-mesh')
    expect(reassigned.active).toBe(false)
    expect(reassigned.rolloutPercent).toBe(0)
    expect(reassigned.version).toBeGreaterThan(activated.version)
  })


  it('REQ-RUN-016 mesh reassignment records the audit event and rejects an unknown mesh', async () => {
    const { router, store } = routerFixture()
    await createMeshReq(router, 'Development')
    const add = await addModelReq(router, { modelRef: DEV_GGUF, mode: 'single' })
    const profileId = (await add.json() as { profileId: string }).profileId

    expect((await configureProfile(router, { profileId, meshId: 'ghost' })).status).toBe(400)
    expect(store.audit.find((event) => event.type === 'model_mesh_assigned')).toBeUndefined()
    expect((await store.listProfiles()).find((profile) => profile.id === profileId)?.meshId ?? 'default').toBe('default')

    expect((await configureProfile(router, { profileId, meshId: 'development' })).status).toBe(200)
    const assignment = store.audit.find((event) => event.type === 'model_mesh_assigned' && event.target === profileId)
    expect(assignment?.detail).toMatchObject({ from: 'default', to: 'development' })
  })


  it('REQ-RUN-016 call-name edits preserve the mesh alias and reject reserved names', async () => {
    const { router, store } = routerFixture()
    await createMeshReq(router, 'Development')
    const add = await addModelReq(router, { modelRef: DEV_GGUF, mode: 'single', meshId: 'development' })
    const profileId = (await add.json() as { profileId: string }).profileId

    const renamed = await configureProfile(router, { profileId, callName: 'fast' })
    expect(renamed.status).toBe(200)
    expect((await store.listProfiles()).find((profile) => profile.id === profileId)?.publicAliases).toEqual(['codeflare-mesh-development', 'fast'])

    for (const reserved of ['codeflare-mesh', 'codeflare-mesh-noobs']) {
      const res = await configureProfile(router, { profileId, callName: reserved })
      expect(res.status).toBe(409)
      expect((await res.json() as { error: string }).error).toBe('call_name_conflict')
    }
  })


  it('REQ-RUN-016 onboarding accepts a target mesh and stamps its alias', async () => {
    const { router, store } = routerFixture()
    await createMeshReq(router, 'Development')

    expect((await addModelReq(router, { modelRef: DEV_GGUF, mode: 'single', meshId: 'ghost' })).status).toBe(400)

    const add = await addModelReq(router, { modelRef: DEV_GGUF, mode: 'single', runtime: 'llamacpp', meshId: 'development' })
    expect(add.status).toBe(201)
    expect((await add.json() as { model: { meshId: string } }).model.meshId).toBe('development')
    const created = (await store.listProfiles()).find((profile) => profile.upstreamModel === DEV_GGUF)!
    expect(created.publicAliases[0]).toBe('codeflare-mesh-development')
    expect(created.meshId).toBe('development')
  })


  it('REQ-API-005 the model configure twin accepts meshId and api models carry it', async () => {
    const { router, store } = routerFixture()
    await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)
    await createMeshReq(router, 'Development')
    const token = await mintKey(router)

    const moved = await router(new Request('https://router.test/api/v1/models/mesh-smoke-qwen25-1.5b', {
      method: 'POST',
      headers: { ...bearer(token), 'content-type': 'application/json' },
      body: JSON.stringify({ meshId: 'development' })
    }))
    expect(moved.status).toBe(200)

    const list = await router(new Request('https://router.test/api/v1/models', { headers: bearer(token) }))
    const models = (await list.json() as { models: Array<{ id: string; meshId: string }> }).models
    expect(models.find((model) => model.id === 'mesh-smoke-qwen25-1.5b')?.meshId).toBe('development')
  })


  it('REQ-GWY-009 gateway sync ensures one dynamic route per mesh', async () => {
    let received: { extraRoutes: readonly { routeName: string; publicModel: string }[] | undefined; routeName: string } | undefined
    const { router, store } = routerFixture({
      env: { CLOUDFLARE_ACCOUNT_ID: 'acct-1', AI_GATEWAY_ID: 'inference-mesh' },
      cloudflareClient: {
        async syncCustomProvider(input) {
          received = { extraRoutes: input.extraRoutes, routeName: input.routeName }
          return { providerId: 'p', providerSlug: 'slug', routeId: 'r', routeVersionId: 'v', deploymentId: 'd', gatewayId: input.gatewayId, routeName: input.routeName, publicModel: input.publicModel, workerUrl: input.workerUrl, manualProviderKeyRequired: true, providerTokenInstructions: 'x' }
        },
        async provisionCustomDomain() { throw new Error('custom domain is not used in this test') }
      }
    })
    await store.putConfig('custom_domain', { hostname: 'mesh.example.com', status: 'provisioned' })
    const sync = () => router(new Request('https://router.test/admin/cloudflare/gateway/sync', { method: 'POST', headers: bearer('admin-secret') }))

    expect((await sync()).status).toBe(200)
    expect(received?.routeName).toBe('codeflare-mesh')
    expect(received?.extraRoutes).toBeUndefined()

    await createMeshReq(router, 'Development')
    await createMeshReq(router, 'Ops')
    expect((await sync()).status).toBe(200)
    expect(received?.extraRoutes).toEqual([
      { routeName: 'codeflare-mesh-development', publicModel: 'codeflare-mesh-development' },
      { routeName: 'codeflare-mesh-ops', publicModel: 'codeflare-mesh-ops' }
    ])
  })


  it('REQ-GWY-009 the gateway client upserts a route per extra mesh route', async () => {
    const calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = []
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
      calls.push({ method, path: url.pathname, ...(body ? { body } : {}) })
      if (url.pathname.endsWith('/custom-providers') && method === 'GET') return Response.json({ success: true, result: [] })
      if (url.pathname.endsWith('/custom-providers') && method === 'POST') return Response.json({ success: true, result: { id: 'provider-a', slug: 'codeflare-inference-mesh' } })
      if (url.pathname.endsWith('/ai-gateway/gateways') && method === 'GET') return Response.json({ success: true, result: [{ id: 'gateway-a', authentication: true }] })
      if (url.pathname.endsWith('/routes') && method === 'GET') return Response.json({ success: true, data: { routes: [] } })
      return Response.json({ success: true, result: { id: `route-${calls.length}`, name: (body?.name as string) ?? 'unknown', version: { version_id: 'version-a' }, deployment: { deployment_id: 'deployment-a', version_id: 'version-a' } } })
    }) as typeof fetch

    const result = await new CloudflareGatewayClient('runtime-token', fetcher).syncCustomProvider({
      accountId: 'account-a',
      gatewayId: 'gateway-a',
      workerUrl: 'https://router.example.workers.dev/v1/chat/completions',
      providerName: 'Codeflare Inference Mesh',
      routeName: 'codeflare-mesh',
      publicModel: 'codeflare-mesh',
      extraRoutes: [{ routeName: 'codeflare-mesh-development', publicModel: 'codeflare-mesh-development' }],
      providerTokenInstructions: 'manual'
    })

    const routePosts = calls.filter((call) => call.method === 'POST' && call.path.endsWith('/routes')).map((call) => call.body?.name)
    expect(routePosts).toEqual(['codeflare-mesh', 'codeflare-mesh-development'])
    expect(result.routes?.map((route) => route.routeName)).toEqual(['codeflare-mesh', 'codeflare-mesh-development'])
  })


  it('REQ-ADM-037 admin status lists meshes with counts', async () => {
    const { router, store } = routerFixture()
    await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)
    await createMeshReq(router, 'Development')
    await store.upsertNode({ ...nodeFixture(), meshId: 'development' })

    const status = await router(new Request('https://router.test/admin/status', { headers: bearer('admin-secret') }))
    const body = await status.json() as { meshes?: Array<{ id: string; name: string; alias: string; machineCount: number; modelCount: number }> }
    expect(status.status).toBe(200)
    expect(body.meshes?.[0]).toMatchObject({ id: 'default', alias: 'codeflare-mesh', machineCount: 0, modelCount: 1 })
    expect(body.meshes?.find((mesh) => mesh.id === 'development')).toMatchObject({ name: 'Development', machineCount: 1, modelCount: 0 })
  })


  it('REQ-RUN-017 duplicates a profile as an inactive same-mesh copy with a derived call name', async () => {
    const { router, store } = routerFixture()
    await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)
    await createMeshReq(router, 'Development')
    const add = await addModelReq(router, { modelRef: DEV_GGUF, mode: 'single', name: 'Coder', meshId: 'development' })
    const sourceId = (await add.json() as { profileId: string }).profileId
    const duplicate = (profileId: string) => router(new Request('https://router.test/admin/profiles/duplicate', {
      method: 'POST',
      headers: { ...bearer('admin-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ profileId })
    }))

    expect((await duplicate('ghost')).status).toBe(404)

    const first = await duplicate(sourceId)
    expect(first.status).toBe(201)
    const firstId = (await first.json() as { profileId: string }).profileId
    expect(firstId).not.toBe(sourceId)
    const source = (await store.listProfiles()).find((profile) => profile.id === sourceId)!
    const copy = (await store.listProfiles()).find((profile) => profile.id === firstId)!
    expect(copy.displayName).toBe('Coder (copy)')
    expect(copy.meshId).toBe('development')
    expect(copy.publicAliases[0]).toBe('codeflare-mesh-development')
    expect(copy.publicAliases[1]).toBe(`${source.publicAliases[1]}-copy`)
    expect(copy.upstreamModel).toBe(source.upstreamModel)
    expect(copy.runtime).toBe(source.runtime)
    expect(copy.contextWindow).toBe(source.contextWindow)
    expect(copy.active).toBe(false)
    expect(copy.rolloutPercent).toBe(0)
    expect(copy.version).toBe(1)
    expect(copy.meshllm?.modelRef).toBe(source.meshllm?.modelRef)
    expect(copy.meshllm?.bindPort).not.toBe(source.meshllm?.bindPort)
    expect(store.audit.some((event) => event.type === 'model_duplicated' && event.target === firstId)).toBe(true)

    // A second duplicate of the same source coexists under the next derived name.
    const second = await duplicate(sourceId)
    expect(second.status).toBe(201)
    const secondId = (await second.json() as { profileId: string }).profileId
    expect(secondId).not.toBe(firstId)
    const copy2 = (await store.listProfiles()).find((profile) => profile.id === secondId)!
    expect(copy2.publicAliases[1]).toBe(`${source.publicAliases[1]}-copy-2`)

    // The copy is an ordinary profile: its details are editable independently.
    const edited = await configureProfile(router, { profileId: firstId, name: 'Coder Tuned', contextWindow: 8192 })
    expect(edited.status).toBe(200)
    expect((await store.listProfiles()).find((profile) => profile.id === sourceId)?.displayName).toBe('Coder')
  })


  it('REQ-ADM-020 REQ-API-004 node projections carry the derived operator status vocabulary', async () => {
    const { router, store } = routerFixture()
    const token = await mintKey(router)
    const base = nodeFixture()
    await store.upsertNode({ ...base, id: 'n-serving', metrics: { runtimeState: 'ready', activeRequests: 0, readyModels: ['m'] } })
    await store.upsertNode({ ...base, id: 'n-preparing', metrics: { runtimeState: 'starting', activeRequests: 0, readyModels: [] } })
    await store.upsertNode({ ...base, id: 'n-disconnected', metrics: { runtimeState: 'stopped', activeRequests: 0 } })
    await store.upsertNode({ ...base, id: 'n-error', metrics: { runtimeState: 'dependency-missing', activeRequests: 0 } })
    await store.upsertNode({ ...base, id: 'n-offline', status: 'offline', metrics: { runtimeState: 'starting', activeRequests: 0 } })
    await store.upsertNode({ ...base, id: 'n-deactivated', deactivated: true, metrics: { runtimeState: 'ready', activeRequests: 0, readyModels: ['m'] } })
    // An api-client mesh-llm advertises the mesh catalog while holding no stage: ready
    // models without a ready/running runtime or a stage assignment are not Serving.
    await store.upsertNode({ ...base, id: 'n-ghost', metrics: { runtimeState: 'starting', activeRequests: 0, readyModels: ['m'] } })
    await store.upsertNode({ ...base, id: 'n-stage', metrics: { runtimeState: 'starting', activeRequests: 0, readyModels: [], stageCount: 1, apiReady: true, consoleReady: true } })

    const res = await router(new Request('https://router.test/api/v1/nodes', { headers: bearer(token) }))
    const nodes = (await res.json() as { nodes: Array<{ id: string; displayStatus: string }> }).nodes
    const statusOf = (id: string) => nodes.find((node) => node.id === id)?.displayStatus
    expect(statusOf('n-serving')).toBe('Serving')
    expect(statusOf('n-preparing')).toBe('Preparing')
    expect(statusOf('n-ghost')).toBe('Preparing')
    expect(statusOf('n-stage')).toBe('Serving')
    expect(statusOf('n-disconnected')).toBe('Disconnected')
    expect(statusOf('n-error')).toBe('Error')
    expect(statusOf('n-offline')).toBe('Offline')
    expect(statusOf('n-deactivated')).toBe('Deactivated')

    // Admin status nodes carry the same field, so the console renders the identical contract.
    const status = await router(new Request('https://router.test/admin/status', { headers: bearer('admin-secret') }))
    const statusNodes = (await status.json() as { nodes: Array<{ id: string; displayStatus?: string }> }).nodes
    expect(statusNodes.find((node) => node.id === 'n-serving')?.displayStatus).toBe('Serving')
  })


  it('REQ-ADM-033 a starting runtime with stderr chatter is never reported as an install failure', async () => {
    const { router, store } = routerFixture()
    const token = await mintKey(router)
    // The runtime has not reported its version yet (still starting) and mesh-llm emitted a
    // benign WARN on stderr; the install status must stay pending, not phantom-fail.
    await store.upsertNode({
      ...nodeFixture(),
      metrics: { runtimeKind: 'meshllm', runtimeState: 'starting', activeRequests: 0, runtimeDetail: 'WARN noq_proto::connection: failed closing path err=MultipathNotNegotiated' }
    })

    const res = await router(new Request('https://router.test/api/v1/nodes', { headers: bearer(token) }))
    const node = (await res.json() as { nodes: Array<{ runtimeInstall?: Record<string, unknown> }> }).nodes[0]
    expect(node?.runtimeInstall).toMatchObject({ runtime: 'meshllm', installedVersion: null, state: 'pending', error: null })
  })


  it('REQ-RUN-017 the automation duplicate twin mirrors the console behavior', async () => {
    const { router, store } = routerFixture()
    await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)
    const token = await mintKey(router)

    expect((await router(new Request('https://router.test/api/v1/models/mesh-smoke-qwen25-1.5b/duplicate', { method: 'POST', headers: bearer('nope') }))).status).toBe(401)

    const res = await router(new Request('https://router.test/api/v1/models/mesh-smoke-qwen25-1.5b/duplicate', { method: 'POST', headers: bearer(token) }))
    expect(res.status).toBe(201)
    const body = await res.json() as { model: { id: string; meshId: string; active: boolean } }
    expect(body.model.id).not.toBe('mesh-smoke-qwen25-1.5b')
    expect(body.model.meshId).toBe('default')
    expect(body.model.active).toBe(false)
    expect((await store.listProfiles()).some((profile) => profile.id === body.model.id)).toBe(true)
  })
})
