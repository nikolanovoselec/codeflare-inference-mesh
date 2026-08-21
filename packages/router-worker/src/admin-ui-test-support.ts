/**
 * Fixtures shared by the console dashboard suites.
 *
 * These were the header of one 2223-line test file; each suite now states what it uses.
 */
import { ADMIN_UI_NODES_TABLE, adminUiHtml } from './admin-ui'
import { adminUiHarness, descendants, type AdminUiHarness, type StubElement } from './admin-ui-harness'
import { expect, vi } from 'vitest'


// DashboardUiTestAnchor

export const dashboardNodes = [
  {
    id: 'node-big',
    status: 'online',
    agentVersion: 'v1.3.0',
    // Serving requires adoption + readiness: agents always report the profile ids they run
    // (activeProfileIds) alongside readyModels, which carries upstream model refs (what the
    // runtime loaded), exactly as the scheduler and the serving-count match on.
    activeProfileIds: ['mesh-default-qwen36-35b'],
    metrics: { runtimeState: 'running', readyModels: ['unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ3_S', 'unsloth/Qwen2.5-Coder-1.5B-Instruct-GGUF:Q4_K_M'], gpuMemoryTotalMiB: 24_576, gpuMemoryUsedMiB: 20_000, tokensPerSecond: 42.5, activeRequests: 1 }
  },
  {
    id: 'node-small',
    status: 'online',
    agentVersion: 'v1.2.0',
    activeProfileIds: ['mesh-default-qwen36-35b'],
    metrics: { runtimeState: 'ready', readyModels: ['unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ3_S'], gpuMemoryTotalMiB: 8_192, gpuMemoryUsedMiB: 4_000, tokensPerSecond: 61.25, activeRequests: 0 }
  },
  {
    id: 'node-down',
    status: 'offline',
    metrics: { runtimeState: 'failed', activeRequests: 0 }
  }
]

export const dashboardProfiles = [
  { id: 'mesh-default-qwen36-35b', displayName: 'Qwen3.6 35B', publicAliases: ['codeflare-mesh', 'qwen3.6:35b-a3b'], upstreamModel: 'unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ3_S', active: true, rolloutPercent: 100, meshllm: { split: false } },
  { id: 'mesh-split-qwen36-35b', displayName: 'Qwen3.6 35B (multi-machine)', publicAliases: ['mesh-split'], upstreamModel: 'unsloth/Qwen3.6-35B-A3B-UD-Q4_K_XL-layers', active: false, rolloutPercent: 100, meshllm: { split: true } }
]

export function statusFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    nodes: dashboardNodes,
    profiles: dashboardProfiles,
    profileReadiness: [],
    audit: [],
    generatedAt: 1_700_000_200_000,
    lastSpeedTests: { 'mesh-default-qwen36-35b': { at: 1_700_000_100_000, requestId: 'speed-a', model: 'codeflare-mesh', nodeId: 'node-big', requestedPromptTokens: 2048, requestedMaxTokens: 160, promptTokens: 2048, completionTokens: 80, promptTokensEstimated: false, completionTokensEstimated: false, promptTokensPerSecond: 1800.5, generationTokensPerSecond: 67.2, timeToFirstTokenMs: 900, generationMs: 1200, totalMs: 2100, cacheTokens: 0 } },
    meshes: [{ id: 'default', name: 'Default', alias: 'codeflare-mesh', machineCount: 3, modelCount: 2 }],
    gateway: { gatewayId: 'inference-mesh', routeName: 'codeflare-mesh', publicModel: 'codeflare-mesh' },
    customDomain: { hostname: 'router.test', status: 'provisioned' },
    desiredAgentVersion: 'v1.3.0',
    desiredRuntimeVersions: { meshllm: 'v0.72.2', llamacpp: 'b9912' },
    meshHealth: [],
    ...overrides
  }
}

export interface DashboardOptions {
  readonly status?: Record<string, unknown>
  readonly failStatusAfterBoot?: boolean
  readonly respond?: (path: string, init?: RequestInit) => Response | undefined
}

export async function dashboardHarness(options: DashboardOptions = {}): Promise<AdminUiHarness> {
  const status = options.status ?? statusFixture()
  let statusCalls = 0
  const html = adminUiHtml('https://router.test', { view: 'dashboard', phase: 'complete', customDomain: 'router.test', recovery: false })
  const harness = adminUiHarness(html, async (path, init) => {
    if (options.respond) { const custom = options.respond(path, init); if (custom) return custom }
    if (path === '/admin/status') {
      statusCalls += 1
      if (options.failStatusAfterBoot && statusCalls > 1) return new Response('down', { status: 503 })
      return Response.json(status)
    }
    if (path === '/admin/agent-versions') return Response.json({ tags: [], stale: false })
    if (path === '/admin/runtime-versions') return Response.json({ meshllm: { tags: [], desired: 'v0.72.2', stale: false }, llamacpp: { tags: [], desired: 'b9912', stale: false } })
    return new Response('command', { status: 200, headers: { 'content-type': 'text/plain' } })
  }, { sessionToken: 'admin-secret' })
  harness.run()
  await harness.flush(10)
  expect(harness.body.dataset.view).toBe('dashboard')
  return harness
}

export function statusFetches(harness: AdminUiHarness): number {
  return harness.fetchCalls.filter((call) => call.path === '/admin/status').length
}

export function tableRows(harness: AdminUiHarness): StubElement[] {
  return harness.byId(ADMIN_UI_NODES_TABLE.bodyId).children.filter((row) => row.dataset.nodeRow)
}

export function rowOrder(harness: AdminUiHarness): string[] {
  return tableRows(harness).map((row) => row.dataset.nodeRow!)
}

/**
 * The rendered value of one drawer field. A field is `<strong>label</strong><code>value</code>`,
 * so this reads the value cell itself. Pinning that with toBe catches a value rendered into the
 * wrong field, or extra text alongside it, which substring-scanning the whole drawer cannot.
 */
export function fieldValue(field: StubElement): string {
  return descendants(field).find((node) => node.tagName === 'code')!.textContent
}

/**
 * Undo whatever a test did to the shared environment: fake timers, mocks, and the
 * matchMedia stub. This ran after every test in the overview suite before that suite
 * was split, so each suite that came out of it still runs it.
 */
export function resetDashboardEnvironment(): void {
  try { vi.clearAllTimers() } catch { /* fake timers were not enabled */ }
  vi.useRealTimers()
  vi.restoreAllMocks()
  delete (globalThis as { matchMedia?: unknown }).matchMedia
}
