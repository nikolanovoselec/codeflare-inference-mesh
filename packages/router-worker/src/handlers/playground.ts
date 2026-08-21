/** Running traffic through the mesh on purpose: the console playground and speed test. */
import { cleanString, json, readOptionalObject } from '../http'
import type { RouterDeps } from '../deps'
import { runInference } from '../inference'
import { runSpeedTest, type SpeedTestBody } from '../speed-test'
import { type ConsoleRole } from '../auth-gates'
import { type GatewaySettings, gatewaySettings } from './gateway'

/**
 * REQ-ADM-029: Playground "gateway" target — console proxy to the *selected* AI Gateway.
 * Forwards the chosen route as `dynamic/<route>` to that gateway's compat endpoint so an
 * operator can exercise any accessible gateway and any route on it (including hand-made
 * non-`codeflare-mesh` routes, not just the last sync), and streams the response back behind
 * fresh headers so no upstream gateway header reaches the browser.
 */
export async function handlePlaygroundChat(request: Request, deps: RouterDeps, requestId: string, role: ConsoleRole): Promise<Response> {
  const body = await readOptionalObject<{ gatewayId?: unknown; route?: unknown; user?: unknown; messages?: unknown; tools?: unknown; maxTokens?: unknown }>(request)
  const messages = Array.isArray(body?.messages) ? body!.messages : []
  const user = cleanString(body?.user)
  const tools = playgroundTools(body?.tools)
  const maxTokens = playgroundMaxTokens(body?.maxTokens)
  const storedSettings = await deps.store.getConfig<Partial<GatewaySettings>>('cloudflare_gateway_settings')
  const defaults = gatewaySettings({ env: deps.env, ...(storedSettings ? { stored: storedSettings } : {}) })
  const accountId = defaults.accountId
  // Non-admin console users are locked to the default gateway and route: a read-only
  // viewer must not be able to proxy inference through an arbitrary gateway on the
  // operator's account. Admins may target any gateway and route they select.
  const isAdmin = role === 'admin'
  const gatewayId = isAdmin ? (cleanString(body?.gatewayId) ?? defaults.gatewayId) : defaults.gatewayId
  const route = isAdmin ? (cleanString(body?.route) ?? defaults.routeName) : defaults.routeName
  if (!accountId || !gatewayId) return json({ error: 'gateway_not_configured', requestId }, 409, requestId)
  // The mesh gateway is an Authenticated Gateway, so requests must carry an AI Gateway Run token
  // in cf-aig-authorization or the gateway rejects them; fail fast with an actionable error.
  const gatewayToken = deps.env.CLOUDFLARE_API_TOKEN_RUNTIME
  if (!gatewayToken) return json({ error: 'gateway_auth_token_missing', requestId }, 503, requestId)
  const upstream = await (deps.playgroundFetcher ?? fetch)(`https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(accountId)}/${encodeURIComponent(gatewayId)}/compat/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'cf-aig-authorization': `Bearer ${gatewayToken}`
    },
    body: JSON.stringify({ model: `dynamic/${route}`, ...(user ? { user } : {}), stream: true, messages, ...(tools ? { tools } : {}), ...(maxTokens ? { max_tokens: maxTokens } : {}) })
  })
  const headers = new Headers({
    'content-type': upstream.headers.get('content-type') ?? 'text/event-stream',
    'cache-control': 'no-store',
    'x-inference-mesh-request-id': requestId
  })
  return new Response(upstream.body, { status: upstream.status, headers })
}

// Playground "direct" target: bypass the gateway and drive the router's own scheduler straight
// to a node, so an operator can verify inference even when no AI Gateway is reachable.
export async function handlePlaygroundDirect(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  const body = await readOptionalObject<{ model?: unknown; user?: unknown; messages?: unknown; tools?: unknown; maxTokens?: unknown }>(request)
  const model = cleanString(body?.model)
  if (!model) return json({ error: 'model_required', requestId }, 400, requestId)
  const user = cleanString(body?.user)
  const messages = Array.isArray(body?.messages) ? body!.messages : []
  const tools = playgroundTools(body?.tools)
  const maxTokens = playgroundMaxTokens(body?.maxTokens)
  return runInference(deps, { body: { model, ...(user ? { user } : {}), messages, stream: true, ...(tools ? { tools } : {}), ...(maxTokens ? { max_tokens: maxTokens } : {}) }, requestHeaders: request.headers, requestId, now })
}

// playgroundTools passes through an OpenAI-format tool-definitions array so an
// operator can reproduce an agentic (tool-calling) request on the real dynamic
// route; a non-array (or absent) value forwards no tools. playgroundMaxTokens
// accepts a positive integer generation cap so a runaway response is bounded.
function playgroundTools(value: unknown): unknown[] | undefined {
  return Array.isArray(value) && value.length > 0 ? value : undefined
}

function playgroundMaxTokens(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

/**
 * Run a measurement through the live path. `persist` decides whether the result becomes
 * the stored per-profile record the whole console reads: a read-only viewer gets its own
 * measurement back without overwriting what everyone else sees.
 */
export async function speedTestCore(request: Request, deps: RouterDeps, requestId: string, now: number, persist: boolean): Promise<Response> {
  const body = await readOptionalObject<SpeedTestBody>(request)
  return await runSpeedTest(deps, body, request.headers, requestId, now, persist)
}
