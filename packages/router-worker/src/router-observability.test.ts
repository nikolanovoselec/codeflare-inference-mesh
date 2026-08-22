/**
 * router observability, security and status contracts.
 *
 * One slice of the router's behavioural suite; shared fixtures live in
 * `./router-test-support`.
 */
import { adminUiHarness, descendants, elementStub } from './admin-ui-harness'
import { CloudflareGatewayClient } from './cloudflare-api'
import { createTokenRecord, hashToken } from './auth'
import { DEFAULT_MODEL_PROFILES } from './profiles'
import { describe, expect, it } from 'vitest'
import { MESH_STATE_KEY_B64, SMOKE_UPSTREAM, bearer, githubReleasesFetcher, heartbeatBody, makeMesh, routerFixture, seedLegacyDefaults } from './router-test-support'
import { nodeFixture } from './test-helpers'

describe('router observability, security and status contracts', () => {

  it('REQ-SEC-011 rate-limits a public endpoint before reaching its handler', async () => {
    const over = { limit: async () => ({ success: false }) }
    const { router } = routerFixture({ env: { RL_INFERENCE: over } })
    // A bad token would normally 401; the 429 proves the limiter short-circuits before auth + body read.
    const res = await router(new Request('https://router.test/v1/chat/completions', { method: 'POST', headers: { ...bearer('nope'), 'content-type': 'application/json' }, body: '{}' }))
    const body = await res.json() as { error: string }
    expect(res.status).toBe(429)
    expect(body.error).toBe('rate_limited')
    expect(res.headers.get('retry-after')).toBe('60')
  })


  it('REQ-SEC-011 lets a request through to its handler when under the limit', async () => {
    const under = { limit: async () => ({ success: true }) }
    const { router } = routerFixture({ env: { RL_INFERENCE: under } })
    // Under the limit the request reaches handleModels and fails auth (401), not 429.
    const res = await router(new Request('https://router.test/v1/models', { headers: bearer('bad-token') }))
    expect(res.status).toBe(401)
  })


  it('REQ-SEC-002 asks for confirmation before revoking a node from the Admin UI', async () => {
    const { router } = routerFixture()
    const html = await (await router(new Request('https://router.test/admin'))).text()
    const harness = adminUiHarness(html, async (path) => Response.json(path.includes('/revoke') ? { revoked: true } : {}), { sessionToken: 'admin-secret' })
    harness.run()
    const revoke = elementStub({ tagName: 'button', textContent: 'Revoke' })
    revoke.dataset.action = 'node-revoke'
    revoke.dataset.nodeId = 'node/a'
    revoke.dataset.confirm = 'Confirm revoke?'
    revoke.dataset.out = 'node-output'

    await harness.click(revoke)
    expect(harness.fetchCalls).toHaveLength(0)
    expect(revoke.dataset.armed).toBe('true')
    expect(revoke.textContent).toBe('Confirm revoke?')

    await harness.click(revoke)
    expect(harness.fetchCalls[0]!.path).toBe('/admin/nodes/node%2Fa/revoke')
    expect(revoke.dataset.armed).toBeUndefined()
    expect(revoke.textContent).toBe('Revoke')
    expect(harness.byId('node-output').textContent).toBe('Machine revoked.')
  })


  it('REQ-OBS-012 REQ-RUN-013 keeps direct llama.cpp UI controls backed by admin API payloads', async () => {
    // DirectRuntimeUiParityTestAnchor
    const { router, store } = routerFixture()
    await store.putConfig('custom_domain', { hostname: 'mesh.example.com', status: 'provisioned' })
    await store.putConfig('setup_state', { phase: 'complete', completedAt: 1_700_000_000_000 })
    const directProfile = {
      id: 'direct-qwen',
      displayName: 'Direct Qwen',
      publicAliases: ['codeflare-mesh', 'direct-qwen'],
      upstreamModel: 'unsloth/Qwen3-14B-GGUF:Q4_K_M',
      contextWindow: 262144,
      active: true,
      rolloutPercent: 100,
      runtime: 'llamacpp',
      sourceMode: 'llamacpp-hf',
      version: 1,
      llamacpp: { alias: 'unsloth/Qwen3-14B-GGUF:Q4_K_M', modelRef: 'unsloth/Qwen3-14B-GGUF:Q4_K_M', hfRepo: 'unsloth/Qwen3-14B-GGUF', hfFile: 'qwen.gguf', quant: 'Q4_K_M', contextWindow: 262144, bindPort: 9338, parallel: 1, cachePrompt: true, cacheReuse: 256 }
    }
    const status = {
      nodes: [{ id: 'node-direct', displayName: 'Direct Node', meshIp: '100.64.1.20', inferencePort: 8080, localDashboardPort: 3131, status: 'online', publicModels: ['direct-qwen'], activeProfileIds: ['direct-qwen'], capacity: 1, inFlight: 0, lastSeenAt: Date.now(), runtime: 'llamacpp', metrics: { runtimeKind: 'llamacpp', runtimeState: 'ready', activeRequests: 0, tokensPerSecond: 12, readyModels: ['unsloth/Qwen3-14B-GGUF:Q4_K_M'], loadedModel: 'unsloth/Qwen3-14B-GGUF:Q4_K_M', gpuMemoryUsedMiB: 1024, gpuMemoryTotalMiB: 24576, llamacppVersion: 'b5000', ctxSize: 262144, parallel: 1, cachePrompt: true, cacheReuse: 256, slotCount: 1, activeSlots: 0, cachedTokensLast: 4096, apiReady: true, consoleReady: true } }],
      profiles: [directProfile],
      profileReadiness: [{ profileId: 'direct-qwen', ready: 1, failed: 0 }],
      meshHealth: [],
      audit: [],
      desiredAgentVersion: 'agent-v1',
      offlinePruneSeconds: 300
    }
    const html = await (await router(new Request('https://mesh.example.com/admin'))).text()
    const harness = adminUiHarness(html, async (path) => {
      if (path === '/admin/status') return Response.json(status)
      if (path === '/admin/agent-versions') return Response.json({ tags: [], stale: false })
      if (path.startsWith('/admin/cloudflare/gateway/options')) return Response.json({ gateways: [], routes: [], defaults: {} })
      if (path === '/admin/profiles/add') return Response.json({ ok: true, profileId: 'custom-direct' }, { status: 201 })
      if (path === '/admin/profiles/config') return Response.json({ ok: true, profileId: 'direct-qwen' })
      return new Response('install', { status: 200, headers: { 'content-type': 'text/plain' } })
    }, { hostname: 'mesh.example.com', sessionToken: 'admin-secret' })
    harness.run()
    await harness.flush(10)

    const addMode = harness.byId('model-add-mode')
    const addRuntime = harness.byId('model-add-runtime')
    addRuntime.value = 'llamacpp'
    addMode.value = 'split'
    addMode.dataset.modelAddMode = 'true'
    await harness.change(addMode)
    expect(addRuntime.disabled).toBe(true)
    expect(addRuntime.value).toBe('meshllm')

    addMode.value = 'single'
    await harness.change(addMode)
    addRuntime.value = 'llamacpp'
    harness.byId('model-add-ref').value = ' unsloth/Qwen3-14B-GGUF:Q4_K_M '
    await harness.clickAction('model-add', { out: 'profile-output' })
    const addCall = harness.fetchCalls.find((call) => call.path === '/admin/profiles/add')
    expect(JSON.parse(String(addCall?.init?.body))).toMatchObject({ modelRef: 'unsloth/Qwen3-14B-GGUF:Q4_K_M', mode: 'single', runtime: 'llamacpp' })

    const profileRow = harness.byId('profile-list').children.find((row) => row.dataset.profileRow === 'direct-qwen')
    expect(profileRow).toBeDefined()
    expect(descendants(profileRow!).find((item) => item.dataset.runtime)?.dataset.runtime).toBe('llamacpp')
    expect(descendants(profileRow!).find((item) => item.dataset.servingMode)?.dataset.servingMode).toBe('single')

    await harness.clickAction('model-detail', { profileId: 'direct-qwen' })
    const modelDrawer = descendants(harness.byId('drawer-body'))
    expect(modelDrawer.find((item) => item.dataset.drawerField === 'runtime')?.dataset.value).toBe('llamacpp')
    // The effective launch source reads back from the stored settings: what the
    // node will actually run, visible before a save (REQ-RUN-013).
    expect(modelDrawer.find((item) => item.dataset.drawerField === 'model-source')?.dataset.value).toBe('unsloth/Qwen3-14B-GGUF:Q4_K_M · qwen.gguf')
    expect(modelDrawer.some((item) => item.id === 'model-edit-llama-parallel')).toBe(true)
    expect(modelDrawer.some((item) => item.id === 'model-edit-llama-kv-unified')).toBe(true)
    expect(modelDrawer.some((item) => item.id === 'model-edit-parallel')).toBe(false)
    expect(modelDrawer.some((item) => item.id === 'model-edit-vram')).toBe(false)

    harness.byId('model-edit-context').value = '131072'
    harness.byId('model-edit-llama-parallel').value = '2'
    harness.byId('model-edit-llama-gpu-layers').value = '99'
    harness.byId('model-edit-llama-cache-k').value = 'q4_0'
    harness.byId('model-edit-llama-cache-v').value = 'q4_0'
    harness.byId('model-edit-llama-batch').value = '8192'
    harness.byId('model-edit-llama-ubatch').value = '2048'
    harness.byId('model-edit-llama-flash').value = 'on'
    harness.byId('model-edit-llama-maxout').value = '8192'
    harness.byId('model-edit-llama-cache-prompt').value = 'off'
    harness.byId('model-edit-llama-cache-reuse').value = '512'
    harness.byId('model-edit-llama-reasoning').value = 'on'
    harness.byId('model-edit-llama-reasoning-format').value = 'deepseek'
    harness.byId('model-edit-llama-reasoning-budget').value = '4096'
    await harness.clickAction('model-save', { profileId: 'direct-qwen', runtime: 'llamacpp', out: 'model-edit-output' })
    const configCall = harness.fetchCalls.filter((call) => call.path === '/admin/profiles/config').at(-1)
    expect(JSON.parse(String(configCall?.init?.body))).toEqual({
      profileId: 'direct-qwen',
      runtime: 'llamacpp',
      contextWindow: 131072,
      modelRef: 'unsloth/Qwen3-14B-GGUF:Q4_K_M',
      llamacpp: { parallel: 2, kvUnified: true, cacheReuse: 512, cachePrompt: false, gpuLayers: '99', cacheTypeK: 'q4_0', cacheTypeV: 'q4_0', batch: 8192, ubatch: 2048, flashAttn: true, mmproj: true, maxOutputTokens: 8192, reasoning: { enabled: true, format: 'deepseek', budget: 4096 } },
      // Sampling rides every save (REQ-RUN-023); untouched blank fields post
      // null, which the router reads as "no override" for an unset parameter.
      sampling: { mode: null, temperature: null, topP: null, topK: null, minP: null, presencePenalty: null, repetitionPenalty: null }
    })

    await harness.clickAction('node-detail', { nodeId: 'node-direct' })
    const nodeFields = new Map(descendants(harness.byId('drawer-body')).filter((item) => item.dataset.drawerField).map((item) => [item.dataset.drawerField, item.dataset.value]))
    expect(nodeFields.get('direct-context')).toBe('262144')
    expect(nodeFields.get('direct-parallel')).toBe('1')
    expect(nodeFields.get('direct-cached-tokens')).toBe('4096')
  })


  it('REQ-API-011 answers not-found for an id the URL decoder rejects instead of faulting', async () => {
    const { router, store } = routerFixture()
    await store.putToken(await createTokenRecord('automation', 'auto-secret', 1_700_000_000_000))

    // A bare '%' satisfies the route pattern but decodeURIComponent throws on it. A malformed
    // id is a client's mistake, so it has to reach the handler's unknown-id answer rather than
    // the dispatcher's audited fault path.
    const response = await router(new Request('https://router.test/api/v1/meshes/%', { method: 'DELETE', headers: bearer('auto-secret') }))
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ error: 'unknown_mesh' })
    expect((await store.listAudit(10)).some((entry) => entry.type === 'router_error')).toBe(false)
  })


  it('REQ-SEC-007 rejects unsafe node claim network targets before creating a node', async () => {
    const { router, store } = routerFixture()
    const setupResponse = await router(new Request('https://router.test/admin/setup', { method: 'POST' }))
    const claimAdmin = (await setupResponse.json() as { adminToken: string }).adminToken
    const setup = await (await router(new Request('https://router.test/admin/setup-tokens', { method: 'POST', headers: bearer(claimAdmin) }))).json() as { setupToken: string }

    const claim = await router(new Request('https://router.test/node/claim', {
      method: 'POST',
      headers: { ...bearer(setup.setupToken), 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Node A', meshIp: '10.0.0.5', inferencePort: 8080, publicModels: ['codeflare-mesh'], activeProfileIds: ['mesh-default-qwen36-35b'], capacity: 2 })
    }))

    expect(claim.status).toBe(400)
    expect(await claim.json()).toMatchObject({ error: 'invalid_claim', fields: expect.arrayContaining(['meshTarget']) })
    expect(store.nodes.size).toBe(0)
  })


  it('REQ-OBS-005 lets an authenticated node remove itself from scheduling', async () => {
    // NodeUnregisterAuthorizationTestAnchor
    const { router, store } = routerFixture()
    await store.upsertNode({ ...nodeFixture({ status: 'online', inFlight: 1 }), nodeTokenVerifier: await hashToken('node-secret') })

    const response = await router(new Request('https://router.test/node/unregister', {
      method: 'POST',
      headers: { ...bearer('node-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: 'node-a' })
    }))
    const node = await store.getNode('node-a')

    expect(response.status).toBe(200)
    expect(node?.status).toBe('offline')
    expect(node?.inFlight).toBe(0)
  })


  it('REQ-SEC-002 lets an admin revoke a node token and audit the action', async () => {
    const { router, store } = routerFixture()
    await store.upsertNode({ ...nodeFixture({ status: 'online' }), nodeTokenVerifier: await hashToken('node-secret'), upstreamTokenVerifier: await hashToken('upstream-secret') })
    await store.putToken(await createTokenRecord('node', 'node-secret', 1_700_000_000_000, 'node-a'))

    const response = await router(new Request('https://router.test/admin/nodes/node-a/revoke', { method: 'POST', headers: bearer('admin-secret') }))
    const heartbeat = await router(new Request('https://router.test/node/heartbeat', {
      method: 'POST',
      headers: { ...bearer('node-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: 'node-a', displayName: 'Node A', meshIp: '100.64.1.10', inferencePort: 8080, localDashboardPort: 17777, status: 'online', publicModels: ['codeflare-mesh'], activeProfileIds: ['mesh-default-qwen36-35b'], capacity: 2, inFlight: 0, runtime: 'meshllm', metrics: { runtimeState: 'ready', activeRequests: 0 } })
    }))
    const unregister = await router(new Request('https://router.test/node/unregister', {
      method: 'POST',
      headers: { ...bearer('node-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: 'node-a' })
    }))
    const node = await store.getNode('node-a')
    const listed = await store.listNodes(1_700_000_000_000)

    expect(response.status).toBe(200)
    // The node record is gone, so a still-running agent's heartbeat and unregister are
    // rejected as unknown (404) and cannot resurrect it.
    expect(heartbeat.status).toBe(404)
    expect(unregister.status).toBe(404)
    // Revoke removes the node outright: it is gone from the store and from the list,
    // so it disappears from the console immediately (no lingering tombstone row).
    expect(node).toBeUndefined()
    expect(listed.some((candidate) => candidate.id === 'node-a')).toBe(false)
    // Its node tokens are revoked so a still-running agent cannot re-authenticate.
    expect(store.tokens.filter((token) => token.kind === 'node' && token.nodeId === 'node-a').every((token) => token.active === false)).toBe(true)
    expect(store.audit.some((event) => event.type === 'node_revoked' && event.target === 'node-a')).toBe(true)
  })


  it('REQ-OBS-006 records audit events for setup, claim, unregister, revoke, route provisioning, and profile switch actions', async () => {
    const { router, store } = routerFixture({
      env: { CLOUDFLARE_ACCOUNT_ID: 'account-a', CLOUDFLARE_API_TOKEN_RUNTIME: 'runtime-token', AI_GATEWAY_ID: 'gateway-a', WORKER_BASE_URL: 'https://router.example.workers.dev' },
      cloudflareClient: {
        async syncCustomProvider(input) {
          return { providerId: 'provider-a', providerSlug: 'provider-slug', routeId: 'route-a', routeVersionId: 'version-a', deploymentId: 'deployment-a', gatewayId: input.gatewayId, routeName: input.routeName, publicModel: input.publicModel, workerUrl: input.workerUrl, manualProviderKeyRequired: true, providerTokenInstructions: 'manual' }
        },
        async provisionCustomDomain() { throw new Error('custom domain is not used in this test') }
      }
    })
    await seedLegacyDefaults(store)

    const setupResponse = await router(new Request('https://router.test/admin/setup', { method: 'POST' }))
    const claimAdmin = (await setupResponse.json() as { adminToken: string }).adminToken
    const setup = await (await router(new Request('https://router.test/admin/setup-tokens', { method: 'POST', headers: bearer(claimAdmin) }))).json() as { setupToken: string }
    const claim = await router(new Request('https://router.test/node/claim', {
      method: 'POST',
      headers: { ...bearer(setup.setupToken), 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Node A', meshIp: '100.64.1.10', inferencePort: 8080, publicModels: ['codeflare-mesh'], activeProfileIds: ['mesh-default-qwen36-35b'], capacity: 2 })
    }))
    const claimed = await claim.json() as { nodeId: string; nodeToken: string }

    await router(new Request('https://router.test/node/unregister', { method: 'POST', headers: { ...bearer(claimed.nodeToken), 'content-type': 'application/json' }, body: JSON.stringify({ nodeId: claimed.nodeId }) }))
    await router(new Request(`https://router.test/admin/nodes/${claimed.nodeId}/revoke`, { method: 'POST', headers: bearer('admin-secret') }))
    await store.putConfig('custom_domain', { hostname: 'ai.example.com', zoneId: '0123456789abcdef0123456789abcdef', zoneName: 'example.com', dnsRecordId: 'dns-a', dnsRecordType: 'CNAME', routeId: 'route-a', routePattern: 'ai.example.com/*', workerName: 'router-worker', status: 'provisioned' })
    const gatewaySync = await router(new Request('https://router.test/admin/cloudflare/gateway/sync', { method: 'POST', headers: bearer('admin-secret') }))
    await router(new Request('https://router.test/admin/profiles/rollout', { method: 'POST', headers: { ...bearer('admin-secret'), 'content-type': 'application/json' }, body: JSON.stringify({ profileId: 'mesh-default-qwen36-35b', rolloutPercent: 50 }) }))

    expect(gatewaySync.status).toBe(200)
    expect(store.audit.map((event) => event.type)).toEqual(expect.arrayContaining(['first_setup', 'node_claimed', 'node_unregistered', 'node_revoked', 'gateway_sync', 'profile_rollout']))
  })


  it('REQ-SEC-012 provisions an Authenticated Gateway and reconciles an existing open gateway', async () => {
    const makeFetcher = (gatewaysList: readonly unknown[]) => {
      const calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = []
      const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input))
        const method = init?.method ?? 'GET'
        const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
        calls.push({ method, path: url.pathname, ...(body ? { body } : {}) })
        if (url.pathname.endsWith('/ai-gateway/gateways') && method === 'GET') return Response.json({ success: true, result: gatewaysList })
        if (url.pathname.endsWith('/ai-gateway/gateways') && method === 'POST') return Response.json({ success: true, result: { id: 'gateway-a' } })
        if (url.pathname.endsWith('/ai-gateway/gateways/gateway-a') && method === 'PUT') return Response.json({ success: true, result: { id: 'gateway-a', authentication: true } })
        if (url.pathname.endsWith('/custom-providers') && method === 'GET') return Response.json({ success: true, result: [] })
        if (url.pathname.endsWith('/custom-providers') && method === 'POST') return Response.json({ success: true, result: { id: 'provider-a', slug: 'codeflare-inference-mesh' } })
        if (url.pathname.endsWith('/routes') && method === 'GET') return Response.json({ success: true, data: { routes: [] } })
        return Response.json({ success: true, result: { id: 'route-a', name: 'codeflare-mesh', version: { version_id: 'version-a' }, deployment: { deployment_id: 'deployment-a', version_id: 'version-a' } } })
      }) as typeof fetch
      return { calls, fetcher }
    }
    const syncInput = { accountId: 'account-a', gatewayId: 'gateway-a', workerUrl: 'https://router.example.workers.dev/v1/chat/completions', providerName: 'Codeflare Inference Mesh', routeName: 'codeflare-mesh', publicModel: 'codeflare-mesh', providerTokenInstructions: 'manual' }

    // A new gateway is created authenticated.
    const created = makeFetcher([])
    await new CloudflareGatewayClient('runtime-token', created.fetcher).syncCustomProvider(syncInput)
    expect(created.calls.find((call) => call.method === 'POST' && call.path.endsWith('/ai-gateway/gateways'))!.body).toMatchObject({ authentication: true })

    // An existing open gateway is reconciled to authenticated via PUT, preserving
    // its operator-tuned cache/rate-limit settings instead of resetting them.
    const reconciled = makeFetcher([{ id: 'gateway-a', authentication: false, cache_ttl: 300, rate_limiting_limit: 50 }])
    await new CloudflareGatewayClient('runtime-token', reconciled.fetcher).syncCustomProvider(syncInput)
    expect(reconciled.calls.find((call) => call.method === 'PUT' && call.path.endsWith('/ai-gateway/gateways/gateway-a'))?.body).toMatchObject({ authentication: true, cache_ttl: 300, rate_limiting_limit: 50 })

    // An already-authenticated gateway triggers no reconcile write.
    const skipped = makeFetcher([{ id: 'gateway-a', authentication: true }])
    await new CloudflareGatewayClient('runtime-token', skipped.fetcher).syncCustomProvider(syncInput)
    expect(skipped.calls.some((call) => call.method === 'PUT')).toBe(false)
  })


  it('CloudflareGatewayClient invokes the fetcher as a free function so the global fetch keeps its native receiver (no Workers illegal invocation)', async () => {
    let receiver: unknown = 'unset'
    // Recorded through a helper rather than assigned to a local: the point is which receiver
    // the client invokes the fetcher with, and passing `this` as an argument says that
    // without aliasing it.
    const recordReceiver = (value: unknown) => { receiver = value }
    const fetcher = function (this: unknown, _input: RequestInfo | URL, _init?: RequestInit) {
      recordReceiver(this)
      return Promise.resolve(Response.json({ success: true, result: [] }))
    } as unknown as typeof fetch
    const client = new CloudflareGatewayClient('runtime-token', fetcher)
    await client.listGateways('account-a')
    expect(receiver).not.toBe(client)
    expect(receiver).toBeUndefined()
  })


  it('REQ-SEC-003 strips client authorization and Cloudflare headers before Worker-to-node forwarding', async () => {
    // WorkerHeaderFilteringTestAnchor
    const capture: { request?: Request } = {}
    const { router, store } = routerFixture({ mesh: makeMesh(capture) })
    await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)
    await store.upsertNode(nodeFixture())

    await router(new Request('https://router.test/v1/chat/completions', {
      method: 'POST',
      headers: { ...bearer('provider-secret'), 'content-type': 'application/json', 'cf-access-client-secret': 'secret' },
      body: JSON.stringify({ model: 'codeflare-mesh', messages: [] })
    }))

    expect(capture.request!.headers.get('authorization')).toBe('Bearer upstream-secret')
    expect(capture.request!.headers.get('cf-access-client-secret')).toBeNull()
  })


  it('REQ-OBS-006 records profile activation audit events', async () => {
    const { router, store } = routerFixture()
    await seedLegacyDefaults(store)

    await router(new Request('https://router.test/admin/profiles/activate', {
      method: 'POST',
      headers: { ...bearer('admin-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ profileId: 'mesh-split-qwen36-35b' })
    }))
    const event = store.audit.find((item) => item.type === 'profile_activated')!

    expect(event).toMatchObject({ actor: 'admin', target: 'mesh-split-qwen36-35b' })
    expect(event.detail).toEqual({ deactivated: ['mesh-smoke-qwen25-1.5b'] })
  })


  it('REQ-OBS-002 reports node mesh membership and readiness fields in admin status', async () => {
    const { router, store } = routerFixture({ env: { MESH_STATE_KEY: MESH_STATE_KEY_B64 } })
    await store.upsertNode({ ...nodeFixture(), nodeTokenVerifier: await hashToken('node-secret') })
    const heartbeat = await router(new Request('https://router.test/node/heartbeat', {
      method: 'POST',
      headers: { ...bearer('node-secret'), 'content-type': 'application/json' },
      body: heartbeatBody({
        meshId: 'mesh-1',
        meshToken: 'invite-token-value-a',
        metrics: {
          runtimeState: 'ready',
          activeRequests: 0,
          meshId: 'mesh-1',
          meshRole: 'coordinator',
          peerCount: 2,
          readyModels: [SMOKE_UPSTREAM],
          splitEnabled: false,
          stageCount: 1,
          apiReady: true,
          consoleReady: true,
          meshllmVersion: '0.72.2'
        }
      })
    }))

    const response = await router(new Request('https://router.test/admin/status', { headers: bearer('admin-secret') }))
    const body = await response.json() as { nodes?: Array<{ id: string; metrics?: Record<string, unknown> }>; meshHealth?: unknown[]; profileReadiness?: Array<Record<string, unknown>> }
    const nodeEntry = body.nodes?.find((node) => node.id === 'node-a')

    expect(heartbeat.status).toBe(200)
    expect(response.status).toBe(200)
    expect(nodeEntry?.metrics).toMatchObject({
      meshId: 'mesh-1',
      meshRole: 'coordinator',
      peerCount: 2,
      readyModels: [SMOKE_UPSTREAM],
      splitEnabled: false,
      stageCount: 1,
      apiReady: true,
      consoleReady: true,
      meshllmVersion: '0.72.2'
    })
    expect(Array.isArray(body.meshHealth)).toBe(true)
    expect(body.meshHealth!.length).toBeGreaterThan(0)
    expect(body.profileReadiness).toEqual(expect.arrayContaining([
      expect.objectContaining({ profileId: 'mesh-smoke-qwen25-1.5b', ready: 1, downloading: 0, failed: 0 })
    ]))
  })


  it('REQ-OBS-002 reports node agent versions and the desired agent version in admin status', async () => {
    const { router, store } = routerFixture({ releasesFetcher: githubReleasesFetcher(['v0.2.0', 'v0.1.0']) })
    await store.upsertNode({ ...nodeFixture(), nodeTokenVerifier: await hashToken('node-secret') })
    expect((await router(new Request('https://router.test/admin/agent-versions', { headers: bearer('admin-secret') }))).status).toBe(200)
    const select = await router(new Request('https://router.test/admin/agent-version', {
      method: 'POST',
      headers: { ...bearer('admin-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ version: 'v0.2.0' })
    }))
    await router(new Request('https://router.test/node/heartbeat', {
      method: 'POST',
      headers: { ...bearer('node-secret'), 'content-type': 'application/json' },
      body: heartbeatBody({ agentVersion: 'v0.1.0' })
    }))

    const response = await router(new Request('https://router.test/admin/status', { headers: bearer('admin-secret') }))
    const body = await response.json() as { nodes?: Array<{ id: string; agentVersion?: string }>; desiredAgentVersion?: string }

    expect(select.ok).toBe(true)
    expect(response.status).toBe(200)
    expect(body.nodes?.find((node) => node.id === 'node-a')?.agentVersion).toBe('v0.1.0')
    expect(body.desiredAgentVersion).toBe('v0.2.0')
  })


  it('REQ-SEC-007 admin status reports token presence, age, and count without values', async () => {
    const { router, store } = routerFixture({ env: { MESH_STATE_KEY: MESH_STATE_KEY_B64 } })
    await store.upsertNode({ ...nodeFixture(), nodeTokenVerifier: await hashToken('node-secret') })
    const heartbeat = await router(new Request('https://router.test/node/heartbeat', {
      method: 'POST',
      headers: { ...bearer('node-secret'), 'content-type': 'application/json' },
      body: heartbeatBody({ meshId: 'mesh-1', meshToken: 'invite-token-value-a' })
    }))
    const meshState = store.config.get('mesh_state:mesh-smoke-qwen25-1.5b')

    const response = await router(new Request('https://router.test/admin/status', { headers: bearer('admin-secret') }))
    const body = await response.json() as { meshHealth?: unknown[] }

    expect(heartbeat.status).toBe(200)
    expect(meshState).toBeDefined()
    expect(JSON.stringify(meshState)).not.toContain('invite-token-value-a')
    expect(response.status).toBe(200)
    expect(Array.isArray(body.meshHealth)).toBe(true)
    expect(JSON.stringify(body)).not.toContain('invite-token-value-a')
  })


  it('REQ-SEC-007 node revoke removes the node mesh tokens from distribution', async () => {
    const { router, store } = routerFixture({ env: { MESH_STATE_KEY: MESH_STATE_KEY_B64 } })
    await store.upsertNode({ ...nodeFixture(), nodeTokenVerifier: await hashToken('node-secret') })
    await router(new Request('https://router.test/node/heartbeat', {
      method: 'POST',
      headers: { ...bearer('node-secret'), 'content-type': 'application/json' },
      body: heartbeatBody({ meshId: 'mesh-1', meshToken: 'invite-token-value-a' })
    }))
    expect(store.config.get('mesh_state:mesh-smoke-qwen25-1.5b')).toBeDefined()

    const revoke = await router(new Request('https://router.test/admin/nodes/node-a/revoke', { method: 'POST', headers: bearer('admin-secret') }))

    expect(revoke.status).toBe(200)
    expect(store.audit.some((event) => event.type === 'mesh_token_removed')).toBe(true)
  })


  it('REQ-OBS-007 reports per-profile mesh coordinator and peers in admin status', async () => {
    const { router, store } = routerFixture({ env: { MESH_STATE_KEY: MESH_STATE_KEY_B64 } })
    await store.upsertNode({ ...nodeFixture(), nodeTokenVerifier: await hashToken('node-secret-a') })
    await store.upsertNode({ ...nodeFixture({ id: 'node-b', displayName: 'Node B', meshIp: '100.64.1.11' }), nodeTokenVerifier: await hashToken('node-secret-b') })
    await router(new Request('https://router.test/node/heartbeat', {
      method: 'POST',
      headers: { ...bearer('node-secret-a'), 'content-type': 'application/json' },
      body: heartbeatBody({ meshId: 'mesh-1', meshToken: 'invite-token-value-a', metrics: { runtimeState: 'ready', activeRequests: 0, apiReady: true, readyModels: [SMOKE_UPSTREAM], meshRole: 'coordinator' } })
    }))
    await router(new Request('https://router.test/node/heartbeat', {
      method: 'POST',
      headers: { ...bearer('node-secret-b'), 'content-type': 'application/json' },
      body: heartbeatBody({ nodeId: 'node-b', displayName: 'Node B', meshIp: '100.64.1.11', meshId: 'mesh-1', meshToken: 'invite-token-value-b', metrics: { runtimeState: 'ready', activeRequests: 0, apiReady: true, readyModels: [SMOKE_UPSTREAM], meshRole: 'serving-peer' } })
    }))

    const response = await router(new Request('https://router.test/admin/status', { headers: bearer('admin-secret') }))
    const body = await response.json() as { meshHealth?: Array<{ profileId: string; meshId?: string; coordinatorNodeId?: string; peerNodeIds: string[] }> }
    const entry = body.meshHealth?.find((item) => item.profileId === 'mesh-smoke-qwen25-1.5b')

    expect(response.status).toBe(200)
    expect(entry?.meshId).toBe('mesh-1')
    expect(entry?.coordinatorNodeId).toBe('node-a')
    expect(entry?.peerNodeIds).toEqual(['node-a', 'node-b'])
  })


  it('REQ-OBS-007 reports ready models and failed nodes per mesh', async () => {
    const { router, store } = routerFixture({ env: { MESH_STATE_KEY: MESH_STATE_KEY_B64 } })
    await store.upsertNode({ ...nodeFixture(), nodeTokenVerifier: await hashToken('node-secret-a') })
    await store.upsertNode({ ...nodeFixture({ id: 'node-b', displayName: 'Node B', meshIp: '100.64.1.11' }), nodeTokenVerifier: await hashToken('node-secret-b') })
    await router(new Request('https://router.test/node/heartbeat', {
      method: 'POST',
      headers: { ...bearer('node-secret-a'), 'content-type': 'application/json' },
      body: heartbeatBody({ meshId: 'mesh-1', meshToken: 'invite-token-value-a' })
    }))
    await router(new Request('https://router.test/node/heartbeat', {
      method: 'POST',
      headers: { ...bearer('node-secret-b'), 'content-type': 'application/json' },
      body: heartbeatBody({ nodeId: 'node-b', displayName: 'Node B', meshIp: '100.64.1.11', metrics: { runtimeState: 'failed', activeRequests: 0, lastError: 'stage exited' } })
    }))

    const response = await router(new Request('https://router.test/admin/status', { headers: bearer('admin-secret') }))
    const body = await response.json() as { meshHealth?: Array<{ profileId: string; readyModels: string[]; failedNodeIds: string[] }> }
    const entry = body.meshHealth?.find((item) => item.profileId === 'mesh-smoke-qwen25-1.5b')

    expect(response.status).toBe(200)
    expect(entry?.readyModels).toEqual([SMOKE_UPSTREAM])
    expect(entry?.failedNodeIds).toEqual(['node-b'])
  })


  it('REQ-OBS-007 surfaces the last MeshLLM error per mesh', async () => {
    const { router, store } = routerFixture({ env: { MESH_STATE_KEY: MESH_STATE_KEY_B64 } })
    await store.upsertNode({ ...nodeFixture(), nodeTokenVerifier: await hashToken('node-secret') })
    await router(new Request('https://router.test/node/heartbeat', {
      method: 'POST',
      headers: { ...bearer('node-secret'), 'content-type': 'application/json' },
      body: heartbeatBody({ meshId: 'mesh-1', meshToken: 'invite-token-value-a', metrics: { runtimeState: 'failed', activeRequests: 0, lastError: 'stage 0 exited before ready' } })
    }))

    const response = await router(new Request('https://router.test/admin/status', { headers: bearer('admin-secret') }))
    const body = await response.json() as { meshHealth?: Array<{ profileId: string; lastError?: string }> }
    const entry = body.meshHealth?.find((item) => item.profileId === 'mesh-smoke-qwen25-1.5b')

    expect(response.status).toBe(200)
    expect(entry?.lastError).toBe('stage 0 exited before ready')
  })


  it('REQ-OBS-007 shows rotation counter and secret presence without values', async () => {
    const { router, store } = routerFixture({ env: { MESH_STATE_KEY: MESH_STATE_KEY_B64 } })
    await store.upsertNode({ ...nodeFixture(), nodeTokenVerifier: await hashToken('node-secret') })
    await router(new Request('https://router.test/node/heartbeat', {
      method: 'POST',
      headers: { ...bearer('node-secret'), 'content-type': 'application/json' },
      body: heartbeatBody({ meshId: 'mesh-1', meshToken: 'invite-token-value-a' })
    }))

    const statusRequest = () => router(new Request('https://router.test/admin/status', { headers: bearer('admin-secret') }))
    const before = await (await statusRequest()).json() as { meshHealth?: Array<{ profileId: string; rotation: number; tokenCount: number; secretAgeMs?: number }> }
    const beforeEntry = before.meshHealth?.find((item) => item.profileId === 'mesh-smoke-qwen25-1.5b')

    expect(beforeEntry?.rotation).toBe(0)
    expect(beforeEntry?.tokenCount).toBe(1)
    expect(typeof beforeEntry?.secretAgeMs).toBe('number')
    expect(JSON.stringify(before)).not.toContain('invite-token-value-a')

    const rotate = await router(new Request('https://router.test/admin/mesh/rotate', {
      method: 'POST',
      headers: { ...bearer('admin-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ profileId: 'mesh-smoke-qwen25-1.5b' })
    }))
    const after = await (await statusRequest()).json() as { meshHealth?: Array<{ profileId: string; rotation: number; tokenCount: number; secretAgeMs?: number }> }
    const afterEntry = after.meshHealth?.find((item) => item.profileId === 'mesh-smoke-qwen25-1.5b')

    expect(rotate.status).toBe(200)
    expect(afterEntry?.rotation).toBe(1)
    expect(afterEntry?.tokenCount).toBe(0)
    expect(afterEntry?.secretAgeMs).toBeUndefined()
  })
})
