/**
 * Fixtures shared by the router behavioural suites.
 *
 * These were the header of one 5891-line test file; they live here so each suite can
 * be read on its own and none of them is redefined per file.
 */
import type { ModelProfile } from './types'
import type { RouteGate } from './routes'
import { ADMIN_UI_ACTIONS, ADMIN_UI_CONFIRM, ADMIN_UI_NAV, ADMIN_UI_RESPONSIVE, ADMIN_UI_SETUP_LOCKED_FEEDBACK, ADMIN_UI_VIEWS, ADMIN_UI_WIZARD } from './admin-ui'
import { MemoryStore } from './test-helpers'
import { StoreScheduler } from './scheduler'
import { createRouter } from './router'
import { expect } from 'vitest'

export function makeMesh(capture: { request?: Request } = {}): Fetcher {
  return {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      capture.request = new Request(input, init)
      return new Response(JSON.stringify({ id: 'chatcmpl-test', model: 'upstream' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
  } as Fetcher
}

export function routerFixture(overrides: Partial<Parameters<typeof createRouter>[0]> = {}) {
  const store = overrides.store ?? new MemoryStore()
  const scheduler = overrides.scheduler ?? new StoreScheduler(store)
  const mesh = overrides.mesh ?? makeMesh()
  return {
    store: store as MemoryStore,
    router: createRouter({
      store,
      scheduler,
      mesh,
      now: overrides.now ?? (() => 1_700_000_000_000),
      requestId: overrides.requestId ?? (() => 'request-a'),
      env: {
        ROUTER_PROVIDER_TOKEN: 'provider-secret',
        ADMIN_TOKEN: 'admin-secret',
        NODE_UPSTREAM_TOKEN: 'upstream-secret',
        WORKER_BASE_URL: 'https://router.example.workers.dev',
        GITHUB_REPOSITORY: 'nikolanovoselec/codeflare-inference-mesh',
        MAX_REQUEST_BYTES: '4096',
        ...overrides.env
      },
      ...(overrides.cloudflareClient !== undefined ? { cloudflareClient: overrides.cloudflareClient } : {}),
      ...(overrides.releasesFetcher !== undefined ? { releasesFetcher: overrides.releasesFetcher } : {}),
      ...(overrides.accessClient !== undefined ? { accessClient: overrides.accessClient } : {}),
      ...(overrides.jwksFetcher !== undefined ? { jwksFetcher: overrides.jwksFetcher } : {}),
      ...(overrides.identityFetcher !== undefined ? { identityFetcher: overrides.identityFetcher } : {}),
      ...(overrides.playgroundFetcher !== undefined ? { playgroundFetcher: overrides.playgroundFetcher } : {})
    })
  }
}

export function bearer(token: string): HeadersInit {
  return { authorization: `Bearer ${token}` }
}

/** A concrete pathname for a route, substituting a sample id for each pattern segment. */
export function samplePath(path: string | RegExp): string {
  if (typeof path === 'string') return path
  return path.source.replace(/^\^/, '').replace(/\$$/, '').replace(/\[\^\/\]\+/g, 'sample-id').replace(/\\\//g, '/')
}

type RouteFamily = 'data' | 'node' | 'admin' | 'api' | 'public'

export function routeFamily(pathname: string): RouteFamily {
  if (pathname.startsWith('/api/v1/')) return 'api'
  if (pathname.startsWith('/admin')) return 'admin'
  if (pathname.startsWith('/node/')) return 'node'
  if (pathname.startsWith('/v1/')) return 'data'
  return 'public'
}

/**
 * The two routes whose credential the dispatcher cannot resolve. Every other gate is
 * enforced before the handler runs, but a per-node token is selected by the `nodeId` in
 * the request body, so these handlers must parse the body first and body validation
 * answers 400 before the token check can run. They still never admit an uncredentialed
 * caller, which is what the sweep below actually asserts. Any third route joining this
 * set is a handler doing its own auth again, and has to be justified.
 */
export const IDENTIFIES_CALLER_FROM_BODY: ReadonlySet<string> = new Set(['/node/heartbeat', '/node/unregister'])

/** Credential classes each route family is allowed to declare. */
export const FAMILY_GATES: Record<RouteFamily, readonly RouteGate[]> = {
  data: ['provider'],
  node: ['setup', 'node'],
  admin: ['admin', 'user', 'bootstrapOrAdmin', 'recovery'],
  api: ['automation', 'keyAdmin', 'adminOrAutomation'],
  public: ['open']
}

// The 35B profiles left the shipped catalog (it is now the single smoke starter).
// Tests that exercise multi-profile behavior seed them as ordinary stored profiles.
export const LEGACY_MESH_DEFAULT: ModelProfile = {
  id: 'mesh-default-qwen36-35b',
  displayName: 'Qwen3.6 35B',
  publicAliases: ['codeflare-mesh', 'qwen3.6:35b-a3b', 'qwen3.6-coder'],
  upstreamModel: 'unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ3_S',
  sourceMode: 'meshllm-ref',
  contextWindow: 262144,
  runtime: 'meshllm',
  meshllm: { modelRef: 'unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ3_S', split: false, bindPort: 4300 },
  version: 1,
  rolloutPercent: 0,
  active: false,
  meshId: 'default'
}
export const LEGACY_MESH_SPLIT: ModelProfile = {
  ...LEGACY_MESH_DEFAULT,
  id: 'mesh-split-qwen36-35b',
  displayName: 'Qwen3.6 35B (multi-machine)',
  upstreamModel: 'hf://meshllm/Qwen3.6-35B-A3B-UD-Q4_K_XL-layers@9b24bdc3dfb174ad6848f3f71c34f5302fa4dcfd',
  meshllm: { modelRef: 'hf://meshllm/Qwen3.6-35B-A3B-UD-Q4_K_XL-layers@9b24bdc3dfb174ad6848f3f71c34f5302fa4dcfd', split: true, bindPort: 4310 }
}
export async function seedLegacyDefaults(store: MemoryStore): Promise<void> {
  await store.setProfile(LEGACY_MESH_DEFAULT)
  await store.setProfile(LEGACY_MESH_SPLIT)
}

export const QWEN_UPSTREAM = 'unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ3_S'
export const SMOKE_UPSTREAM = 'unsloth/Qwen2.5-Coder-1.5B-Instruct-GGUF:Q4_K_M'
export const MESH_STATE_KEY_B64 = `${'A'.repeat(43)}=`

export function legacyRuntimeProfile(input: { id: string; publicAliases: readonly string[]; version: number }): ModelProfile {
  return {
    id: input.id,
    displayName: input.id,
    publicAliases: input.publicAliases,
    upstreamModel: input.id,
    sourceMode: 'legacy-source',
    contextWindow: 262144,
    runtime: 'legacy-runtime',
    meshllm: { modelRef: input.id, split: false, bindPort: 4990 },
    version: input.version,
    rolloutPercent: 100,
    active: true
  } as unknown as ModelProfile
}

export function githubReleasesFetcher(tags: readonly string[]): typeof fetch {
  return (async () => Response.json(tags.map((tag) => ({ tag_name: tag })))) as typeof fetch
}

export function heartbeatBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    nodeId: 'node-a',
    displayName: 'Node A',
    meshIp: '100.64.1.10',
    inferencePort: 8080,
    localDashboardPort: 17777,
    status: 'online',
    publicModels: ['codeflare-mesh'],
    activeProfileIds: ['mesh-smoke-qwen25-1.5b'],
    capacity: 2,
    inFlight: 0,
    runtime: 'meshllm',
    metrics: { runtimeState: 'ready', activeRequests: 0, apiReady: true, readyModels: [SMOKE_UPSTREAM] },
    ...overrides
  })
}

export function valuesOf(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(valuesOf)
  if (value && typeof value === 'object') return Object.values(value).flatMap(valuesOf)
  return []
}

interface AdminUiTestConfig {
  readonly state: { view: string; phase: string; customDomain?: string; recovery?: boolean }
  readonly actions: typeof ADMIN_UI_ACTIONS
  readonly responsive: typeof ADMIN_UI_RESPONSIVE
  readonly views: typeof ADMIN_UI_VIEWS
  readonly nav: typeof ADMIN_UI_NAV
  readonly wizard: typeof ADMIN_UI_WIZARD
  readonly confirm: typeof ADMIN_UI_CONFIRM
  readonly setupLockedFeedback: typeof ADMIN_UI_SETUP_LOCKED_FEEDBACK
  readonly workerOrigin: string
}

export function adminUiConfig(html: string): AdminUiTestConfig {
  const match = html.match(/<script type="application\/json" id="admin-ui-config">([^<]+)<\/script>/)
  expect(match).not.toBeNull()
  expect(match![1]).not.toContain('&quot;')
  return JSON.parse(match![1]!) as AdminUiTestConfig
}

export function adminUiScript(html: string): string {
  const match = html.match(/<script>([\s\S]+)<\/script>\s*<\/body>/)
  expect(match).not.toBeNull()
  return match![1]!
}

export const CUSTOM_GGUF = 'unsloth/Qwen3-14B-GGUF:Q4_K_M'
export const addModel = (router: (request: Request) => Promise<Response>, modelRef: string, mode: string, token = 'admin-secret') =>
  router(new Request('https://router.test/admin/profiles/add', {
    method: 'POST',
    headers: { ...bearer(token), 'content-type': 'application/json' },
    body: JSON.stringify({ modelRef, mode })
  }))

export async function mintKey(router: (request: Request) => Promise<Response>): Promise<{ id: string; token: string; createdAt: number }> {
  const res = await router(new Request('https://router.test/api/v1/keys', { method: 'POST', headers: bearer('admin-secret') }))
  return await res.json() as { id: string; token: string; createdAt: number }
}

export const apiAddModel = (router: (request: Request) => Promise<Response>, token: string | undefined, modelRef: string, mode: string, runtime?: 'meshllm' | 'llamacpp') =>
  router(new Request('https://router.test/api/v1/models', {
    method: 'POST',
    headers: { ...(token ? bearer(token) : {}), 'content-type': 'application/json' },
    body: JSON.stringify({ modelRef, mode, ...(runtime ? { runtime } : {}) })
  }))

export const apiDeleteModel = (router: (request: Request) => Promise<Response>, token: string | undefined, id: string) =>
  router(new Request('https://router.test/api/v1/models/' + id, { method: 'DELETE', headers: token ? bearer(token) : {} }))

export const addApiModelId = async (router: (request: Request) => Promise<Response>, token: string, ref = 'unsloth/Qwen3-14B-GGUF:Q4_K_M') =>
  (await (await apiAddModel(router, token, ref, 'single')).json() as { model: { id: string } }).model.id
