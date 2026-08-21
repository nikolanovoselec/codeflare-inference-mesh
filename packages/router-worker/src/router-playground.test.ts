/**
 * operator playground contracts.
 *
 * One slice of the router's behavioural suite; shared fixtures live in
 * `./router-test-support`.
 */
import { adminUiHarness } from './admin-ui-harness'
import { describe, expect, it } from 'vitest'
import { MemoryStore } from './test-helpers'
import { bearer, routerFixture } from './router-test-support'

describe('operator playground contracts', () => {
  const connectedGateway = { gatewayId: 'inference-mesh', routeName: 'codeflare-mesh', publicModel: 'codeflare-mesh', providerSlug: 'custom-inference-mesh-router-test', manualProviderKeyRequired: true }

  function sseFetcher(capture: { url?: string; init?: RequestInit | undefined }): typeof fetch {
    return (async (url: string, init?: RequestInit) => {
      capture.url = String(url)
      capture.init = init
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n'))
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
          controller.close()
        }
      })
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream', 'cf-aig-log-id': 'log-should-not-leak' } })
    }) as typeof fetch
  }


  it('REQ-ADM-029 REQ-RUN-013 direct playground sends a stable session user for affinity', async () => {
    // DirectPlaygroundSessionUserTestAnchor
    const store = new MemoryStore()
    await store.putConfig('custom_domain', { hostname: 'mesh.example.com', status: 'provisioned' })
    await store.putConfig('setup_state', { phase: 'complete', completedAt: 1_700_000_000_000 })
    const { router } = routerFixture({ store })
    const html = await (await router(new Request('https://mesh.example.com/admin'))).text()
    const directProfile = { id: 'direct-qwen', displayName: 'Direct Qwen', publicAliases: ['codeflare-mesh', 'direct-qwen'], upstreamModel: 'unsloth/Qwen3-14B-GGUF:Q4_K_M', active: true, runtime: 'llamacpp' }
    const harness = adminUiHarness(html, async (path) => {
      if (path === '/admin/status') return Response.json({ nodes: [], profiles: [directProfile], profileReadiness: [], meshHealth: [], audit: [] })
      if (path === '/admin/agent-versions') return Response.json({ tags: [], stale: false })
      if (path.startsWith('/admin/cloudflare/gateway/options')) return Response.json({ gateways: [], routes: [], defaults: {} })
      if (path === '/admin/playground/direct-chat') {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'))
            controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
            controller.close()
          }
        })
        return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }
      return new Response('install', { status: 200, headers: { 'content-type': 'text/plain' } })
    }, { hostname: 'mesh.example.com', sessionToken: 'admin-secret' })
    harness.run()
    await harness.flush(10)
    harness.byId('playground-prompt').value = 'hello'

    await harness.clickAction('playground-send', { out: 'playground-output' })
    await harness.flush(10)
    await harness.clickAction('playground-send', { out: 'playground-output' })
    await harness.flush(10)

    const payloads = harness.fetchCalls.filter((call) => call.path === '/admin/playground/direct-chat').map((call) => JSON.parse(String(call.init?.body)) as { model: string; user: string; messages: readonly unknown[] })
    expect(payloads).toHaveLength(2)
    expect(payloads.map((payload) => payload.model)).toEqual(['direct-qwen', 'direct-qwen'])
    expect(payloads[0]!.user).toMatch(/^user:admin-playground\|session:/)
    expect(new Set(payloads.map((payload) => payload.user)).size).toBe(1)
    expect(payloads[0]!.messages).toHaveLength(1)
  })


  it('REQ-ADM-029 rejects unauthenticated playground requests', async () => {
    const { router } = routerFixture()
    const response = await router(new Request('https://router.test/admin/playground/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'codeflare-mesh', messages: [] })
    }))
    expect(response.status).toBe(401)
  })


  it('REQ-ADM-029 returns gateway_not_configured until a gateway is connected', async () => {
    const { router } = routerFixture()
    const response = await router(new Request('https://router.test/admin/playground/chat', {
      method: 'POST', headers: { ...bearer('admin-secret'), 'content-type': 'application/json' }, body: JSON.stringify({ model: 'codeflare-mesh', messages: [] })
    }))
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: 'gateway_not_configured' })
  })


  it('REQ-ADM-029 forwards playground prompts through the configured gateway route and strips upstream secrets', async () => {
    const store = new MemoryStore()
    await store.putConfig('cloudflare_gateway', connectedGateway)
    await store.putConfig('cloudflare_gateway_settings', { accountId: 'acct-1', gatewayId: 'inference-mesh' })
    const capture: { url?: string; init?: RequestInit | undefined } = {}
    const { router } = routerFixture({ store, env: { CLOUDFLARE_API_TOKEN_RUNTIME: 'aig-run-token' }, playgroundFetcher: sseFetcher(capture) })

    const response = await router(new Request('https://router.test/admin/playground/chat', {
      method: 'POST', headers: { ...bearer('admin-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'codeflare-mesh', user: 'user:admin-playground|session:gateway-session', messages: [{ role: 'user', content: 'hello' }] })
    }))

    expect(response.status).toBe(200)
    expect(capture.url).toBe('https://gateway.ai.cloudflare.com/v1/acct-1/inference-mesh/compat/chat/completions')
    expect(JSON.parse(String(capture.init?.body))).toEqual({ model: 'dynamic/codeflare-mesh', user: 'user:admin-playground|session:gateway-session', stream: true, messages: [{ role: 'user', content: 'hello' }] })
    expect(response.headers.get('cf-aig-log-id')).toBeNull()
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(await response.text()).toContain('"content":"Hi"')
  })


  it('REQ-SEC-012 fails fast when the gateway auth token is missing instead of an opaque upstream 401', async () => {
    const store = new MemoryStore()
    await store.putConfig('cloudflare_gateway', connectedGateway)
    await store.putConfig('cloudflare_gateway_settings', { accountId: 'acct-1', gatewayId: 'inference-mesh' })
    let called = false
    const { router } = routerFixture({ store, playgroundFetcher: (async () => { called = true; return new Response('', { status: 200 }) }) as typeof fetch })

    const response = await router(new Request('https://router.test/admin/playground/chat', {
      method: 'POST', headers: { ...bearer('admin-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'codeflare-mesh', messages: [] })
    }))

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: 'gateway_auth_token_missing' })
    expect(called).toBe(false)
  })


  it('REQ-SEC-012 playground authenticates to the gateway with cf-aig-authorization', async () => {
    const store = new MemoryStore()
    await store.putConfig('cloudflare_gateway', connectedGateway)
    await store.putConfig('cloudflare_gateway_settings', { accountId: 'acct-1', gatewayId: 'inference-mesh' })
    const capture: { url?: string; init?: RequestInit | undefined } = {}
    const { router } = routerFixture({ store, env: { CLOUDFLARE_API_TOKEN_RUNTIME: 'aig-run-token' }, playgroundFetcher: sseFetcher(capture) })

    await router(new Request('https://router.test/admin/playground/chat', {
      method: 'POST', headers: { ...bearer('admin-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'codeflare-mesh', messages: [] })
    }))

    expect(new Headers(capture.init?.headers as HeadersInit).get('cf-aig-authorization')).toBe('Bearer aig-run-token')
  })

})
