/**
 * The Worker's front door: cross-cutting concerns, then one dispatch over the route table.
 *
 * Handlers live in `./handlers/*`. This file owns what every request passes through
 * regardless of where it lands, and the table that says where it lands.
 */
import { adminUiHtml } from './admin-ui'
import { adminUiState, handleAdminLogin, handleAdminRecovery, handleCustomDomain, handleFirstSetup, handleInstaller, handleInstallScript, handleSetupAccess, handleSetupComplete, handleSetupToken, handleWhoami, handleZones } from './handlers/setup'
import { agentVersionSelect, agentVersionsList, runtimeVersionSelect, runtimeVersionsList } from './handlers/versions'
import { apiSetNodeDeactivated, handleApiNodeDecommission, handleApiNodeGet, handleApiNodeList, handleApiNodeReconfigure, handleNodeConfig, handleNodeRevoke, requestNodeReload, setNodeDeactivated } from './handlers/nodes'
import { applyFleetSettings, handleAdminStatus, handleApiSettingsGet, handleApiStatus } from './handlers/status'
import { consoleMovedHtml } from './admin-ui-views'
import { DEFAULT_MODEL_PROFILES } from './profiles'
import { duplicateProfileCore, handleApiModelAdd, handleApiModelConfigure, handleApiModelDelete, handleApiModelDisable, handleApiModelEnable, handleApiModelList, handleProfileActivate, handleProfileAdd, handleProfileConfig, handleProfileDelete, handleProfileDuplicate, handleProfileRollout } from './handlers/models'
import { handleApiEnrollmentToken, handleApiEvents, handleApiKeyCreate, handleApiKeyList, handleApiKeyRevoke, handleApiKeyRotate } from './handlers/keys'
import { handleChat, handleModels } from './handlers/inference'
import { handleGatewayOptions, handleGatewayProvisionStatus, syncGatewayForActor } from './handlers/gateway'
import { handleNodeClaim, handleNodeHeartbeat, handleNodeUnregister } from './handlers/node-protocol'
import { handlePlaygroundChat, handlePlaygroundDirect, speedTestCore } from './handlers/playground'
import { html, json, rateLimited } from './http'
import { InvalidJsonBodyError } from './errors'
import { isRateLimited } from './rate-limit'
import { matchRoute, type Route } from './routes'
import { meshCreateCore, meshDeleteCore, meshListCore, meshRotateCore } from './handlers/meshes'
import { recordBreakGlassEntry, resolveGate, resolveHostGate, type ConsoleRole } from './auth-gates'
import type { RouterDeps } from './deps'

export function createRouter(deps: RouterDeps): (request: Request) => Promise<Response> {
  const now = deps.now ?? Date.now
  const requestId = deps.requestId ?? (() => crypto.randomUUID())
  return async (request: Request): Promise<Response> => {
    const id = requestId()
    const url = new URL(request.url)
    try {
      // Rate-limit before any store or Cloudflare work so a flood cannot drive per-caller DB
      // load or large body reads. The AI Gateway (provider token) gets its own high-limit bucket;
      // token-less inference and other public hits fall to low IP-keyed buckets.
      if (await isRateLimited(request, url.pathname, deps.env)) return rateLimited(id)
      await deps.store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)
      const gate = await resolveHostGate(deps, url)
      if (gate.locked) {
        const uiPath = (request.method === 'GET' || request.method === 'HEAD') && (url.pathname === '/' || url.pathname === '/admin')
        if (uiPath) {
          if (!gate.recovery) return html(consoleMovedHtml(gate.hostname), id)
          await recordBreakGlassEntry(deps, id, now())
          return html(adminUiHtml(url.origin, await adminUiState(deps, true)), id)
        }
        const machinePath = url.pathname.startsWith('/v1/') || url.pathname.startsWith('/node/') || url.pathname.startsWith('/api/v1/')
        if (machinePath || (!gate.recovery && url.pathname.startsWith('/admin'))) {
          return json({ error: 'console_moved', customDomain: gate.hostname, requestId: id }, 410, id)
        }
      }
      if ((request.method === 'GET' || request.method === 'HEAD') && (url.pathname === '/' || url.pathname === '/admin')) return html(adminUiHtml(url.origin, await adminUiState(deps, false)), id)
      const route = matchRoute(ROUTES, request.method, url.pathname)
      if (!route) return json({ error: 'not_found', requestId: id }, 404, id)
      // The declared gate is enforced here, once, before any handler runs. A route cannot be
      // under-gated by a handler that forgot to check, and no handler pays for the check twice.
      const at = now()
      const outcome = await resolveGate(route.gate, request, deps, at)
      if (!outcome.ok) return json({ error: 'unauthorized' }, 401, id)
      return await route.handler({ request, deps, url, requestId: id, now: at, actor: outcome.actor, ...(outcome.role ? { role: outcome.role } : {}), ...(outcome.credentialId ? { credentialId: outcome.credentialId } : {}) })
    } catch (error) {
      // A malformed request BODY (readJson) is client error, not a router fault: answer 400
      // invalid_json (matching the chat endpoint's contract) instead of a 500. Scoped to the
      // request-body boundary so a server-side JSON.parse fault still hits the audited 500 below.
      if (error instanceof InvalidJsonBodyError) return json({ error: 'invalid_json', requestId: id }, 400, id)
      await deps.store.appendAudit({ id, type: 'router_error', at: now(), actor: 'system', detail: { error: String(error) } })
      return json({ error: 'internal_error', requestId: id }, 500, id)
    }
  }
}

/**
 * The decoded id segment of a path, counted from the end: 1 is the last segment
 * (`/meshes/{id}`), 2 the one before it (`/nodes/{id}/deactivate`).
 *
 * A route pattern matches any non-slash run, including one `decodeURIComponent` rejects
 * such as a bare `%`. That is a malformed id, not a router fault, so it passes through
 * undecoded and the handler answers not-found for it like any other unknown id.
 */
function idFromPath(url: URL, fromEnd: 1 | 2): string {
  const raw = url.pathname.split('/').at(-fromEnd) ?? ''
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/**
 * A value the row's handler needs and the row's gate is expected to have resolved.
 *
 * `role` and `credentialId` are optional on `GateOutcome` because only some gates produce
 * them, so nothing in the type system ties a row's gate to the fields its handler reads.
 * Failing closed here means changing a row's gate surfaces as an audited error rather than
 * passing `undefined` into a handler that would act on it, which for the enrollment token
 * would silently leave a single-use credential unspent.
 */
function required<T>(value: T | undefined, field: string, path: string): T {
  if (value === undefined) throw new Error(`route ${path} declares a gate that does not resolve ${field}`)
  return value
}

/**
 * Everything a handler needs from the request, assembled once per dispatch.
 *
 * `actor` is the caller's audited identity, already resolved and formatted by the route's
 * gate, so no handler re-derives it from a credential. `role` and `credentialId` are present
 * only for the gates that produce them; the routes that need them take them explicitly.
 */
interface RouteContext {
  readonly request: Request
  readonly deps: RouterDeps
  readonly url: URL
  readonly requestId: string
  readonly now: number
  readonly actor: string
  readonly role?: ConsoleRole
  readonly credentialId?: string
}

/**
 * The router's full surface, in precedence order. First match wins, so this list
 * must stay ordered exactly as the `if` chain it replaced.
 *
 * `gate` names the credential a route requires, and `createRouter` enforces it here
 * before the handler runs, so this column is the authority rather than a description
 * of what each handler happens to do. `router.test.ts` drives every non-open route
 * with no credential and asserts 401; because no handler checks for itself any more,
 * deleting a gate from a row fails the suite instead of shipping an open endpoint.
 *
 * `/` and `/admin` are not listed: they are served before dispatch because the
 * custom-domain host gate rewrites them to a moved or recovery page first.
 */
export const ROUTES: readonly Route<RouteContext>[] = [
  { method: 'GET', path: '/health', gate: 'open', handler: async (c) => json({ ok: true, service: 'inference-mesh-router' }, 200, c.requestId) },
  { method: 'GET', path: '/v1/models', gate: 'provider', handler: (c) => handleModels(c.deps, c.requestId) },
  { method: 'POST', path: '/v1/chat/completions', gate: 'provider', handler: (c) => handleChat(c.request, c.deps, c.requestId, c.now) },
  { method: 'POST', path: '/node/claim', gate: 'setup', handler: (c) => handleNodeClaim(c.request, c.deps, c.requestId, c.now, required(c.credentialId, 'credentialId', '/node/claim')) },
  { method: 'POST', path: '/node/heartbeat', gate: 'node', handler: (c) => handleNodeHeartbeat(c.request, c.deps, c.requestId, c.now) },
  { method: 'POST', path: '/node/unregister', gate: 'node', handler: (c) => handleNodeUnregister(c.request, c.deps, c.requestId, c.now) },
  { method: 'POST', path: '/admin/setup', gate: 'bootstrapOrAdmin', handler: (c) => handleFirstSetup(c.deps, c.requestId, c.now) },
  { method: 'POST', path: '/admin/recovery/reset', gate: 'recovery', handler: (c) => handleAdminRecovery(c.deps, c.requestId, c.now) },
  { method: 'GET', path: '/install.sh', gate: 'open', handler: async (c) => handleInstallScript(c.deps, c.url.searchParams.get('platform') === 'macos' ? 'macos' : 'linux') },
  { method: 'GET', path: '/install.ps1', gate: 'open', handler: async (c) => handleInstallScript(c.deps, 'windows') },
  { method: 'POST', path: '/admin/login', gate: 'admin', handler: (c) => handleAdminLogin(c.requestId) },
  { method: 'GET', path: '/admin/status', gate: 'user', handler: (c) => handleAdminStatus(c.deps, c.requestId, c.now, required(c.role, 'role', '/admin/status')) },
  { method: 'POST', path: '/admin/setup-tokens', gate: 'admin', handler: (c) => handleSetupToken(c.deps, c.requestId, c.now, c.actor) },
  { method: 'GET', path: /^\/admin\/installers\//, gate: 'admin', handler: (c) => handleInstaller(c.request, c.deps, c.url, c.requestId) },
  { method: 'POST', path: '/admin/cloudflare/gateway/sync', gate: 'admin', handler: (c) => syncGatewayForActor(c.request, c.deps, c.requestId, c.now, c.actor) },
  { method: 'POST', path: '/admin/custom-domain/validate', gate: 'admin', handler: (c) => handleCustomDomain(c.request, c.deps, c.requestId, c.now, false, c.actor) },
  { method: 'POST', path: '/admin/setup/domain', gate: 'admin', handler: (c) => handleCustomDomain(c.request, c.deps, c.requestId, c.now, true, c.actor) },
  { method: 'POST', path: '/admin/setup/access', gate: 'admin', handler: (c) => handleSetupAccess(c.request, c.deps, c.requestId, c.now, c.actor) },
  { method: 'POST', path: '/admin/setup/complete', gate: 'admin', handler: (c) => handleSetupComplete(c.deps, c.requestId, c.now, c.actor) },
  { method: 'GET', path: '/admin/cloudflare/zones', gate: 'admin', handler: (c) => handleZones(c.deps, c.requestId) },
  { method: 'GET', path: '/admin/cloudflare/gateway/options', gate: 'admin', handler: (c) => handleGatewayOptions(c.deps, c.url, c.requestId) },
  { method: 'GET', path: '/admin/cloudflare/gateway/provision-status', gate: 'admin', handler: (c) => handleGatewayProvisionStatus(c.deps, c.url, c.requestId) },
  { method: 'POST', path: /^\/admin\/nodes\/[^/]+\/revoke$/, gate: 'admin', handler: (c) => handleNodeRevoke(c.deps, c.url, c.requestId, c.now, c.actor) },
  { method: 'POST', path: /^\/admin\/nodes\/[^/]+\/deactivate$/, gate: 'admin', handler: (c) => setNodeDeactivated(c.deps, idFromPath(c.url, 2), true, c.actor, c.requestId, c.now) },
  { method: 'POST', path: /^\/admin\/nodes\/[^/]+\/activate$/, gate: 'admin', handler: (c) => setNodeDeactivated(c.deps, idFromPath(c.url, 2), false, c.actor, c.requestId, c.now) },
  { method: 'POST', path: /^\/admin\/nodes\/[^/]+\/reload$/, gate: 'admin', handler: (c) => requestNodeReload(c.deps, idFromPath(c.url, 2), c.actor, c.requestId, c.now) },
  { method: 'POST', path: /^\/admin\/nodes\/[^/]+\/config$/, gate: 'admin', handler: (c) => handleNodeConfig(c.request, c.deps, c.url, c.requestId, c.now, c.actor) },
  { method: 'GET', path: '/admin/meshes', gate: 'user', handler: (c) => meshListCore(c.deps, c.requestId, c.now) },
  { method: 'POST', path: '/admin/meshes', gate: 'admin', handler: (c) => meshCreateCore(c.request, c.deps, c.actor, c.requestId, c.now) },
  { method: 'DELETE', path: /^\/admin\/meshes\/[^/]+$/, gate: 'admin', handler: (c) => meshDeleteCore(c.deps, idFromPath(c.url, 1), c.actor, c.requestId, c.now) },
  { method: 'POST', path: '/admin/profiles/rollout', gate: 'admin', handler: (c) => handleProfileRollout(c.request, c.deps, c.requestId, c.now, c.actor) },
  { method: 'POST', path: '/admin/profiles/activate', gate: 'admin', handler: (c) => handleProfileActivate(c.request, c.deps, c.requestId, c.now, c.actor) },
  { method: 'POST', path: '/admin/profiles/add', gate: 'admin', handler: (c) => handleProfileAdd(c.request, c.deps, c.requestId, c.now, c.actor) },
  { method: 'POST', path: '/admin/profiles/config', gate: 'admin', handler: (c) => handleProfileConfig(c.request, c.deps, c.requestId, c.now, c.actor) },
  { method: 'POST', path: '/admin/profiles/delete', gate: 'admin', handler: (c) => handleProfileDelete(c.request, c.deps, c.requestId, c.now, c.actor) },
  { method: 'POST', path: '/admin/profiles/duplicate', gate: 'admin', handler: (c) => handleProfileDuplicate(c.request, c.deps, c.requestId, c.now, c.actor) },
  { method: 'POST', path: '/admin/settings', gate: 'admin', handler: (c) => applyFleetSettings(c.request, c.deps, c.actor, c.requestId, c.now) },
  { method: 'GET', path: '/admin/runtime-versions', gate: 'admin', handler: (c) => runtimeVersionsList(c.request, c.deps) },
  { method: 'POST', path: '/admin/runtime-versions', gate: 'admin', handler: (c) => runtimeVersionSelect(c.request, c.deps, c.actor) },
  { method: 'POST', path: '/admin/mesh/rotate', gate: 'admin', handler: (c) => meshRotateCore(c.request, c.deps, c.now, c.actor) },
  { method: 'GET', path: '/admin/agent-versions', gate: 'admin', handler: (c) => agentVersionsList(c.request, c.deps) },
  { method: 'POST', path: '/admin/agent-version', gate: 'admin', handler: (c) => agentVersionSelect(c.request, c.deps, c.actor) },
  { method: 'POST', path: '/admin/playground/chat', gate: 'user', handler: (c) => handlePlaygroundChat(c.request, c.deps, c.requestId, required(c.role, 'role', '/admin/playground/chat')) },
  { method: 'POST', path: '/admin/playground/direct-chat', gate: 'user', handler: (c) => handlePlaygroundDirect(c.request, c.deps, c.requestId, c.now) },
  { method: 'POST', path: '/admin/playground/speed-test', gate: 'user', handler: (c) => speedTestCore(c.request, c.deps, c.requestId, c.now, c.role === 'admin') },
  { method: 'GET', path: '/admin/whoami', gate: 'user', handler: (c) => handleWhoami(c.requestId, c.actor, required(c.role, 'role', '/admin/whoami')) },
  { method: 'POST', path: '/api/v1/keys', gate: 'keyAdmin', handler: (c) => handleApiKeyCreate(c.deps, c.requestId, c.now, c.actor) },
  { method: 'GET', path: '/api/v1/keys', gate: 'keyAdmin', handler: (c) => handleApiKeyList(c.deps, c.requestId) },
  { method: 'POST', path: /^\/api\/v1\/keys\/[^/]+\/rotate$/, gate: 'keyAdmin', handler: (c) => handleApiKeyRotate(c.deps, c.url, c.requestId, c.now, c.actor) },
  { method: 'DELETE', path: /^\/api\/v1\/keys\/[^/]+$/, gate: 'keyAdmin', handler: (c) => handleApiKeyRevoke(c.deps, c.url, c.requestId, c.now, c.actor) },
  { method: 'GET', path: '/api/v1/status', gate: 'automation', handler: (c) => handleApiStatus(c.request, c.deps, c.requestId, c.now) },
  { method: 'POST', path: '/api/v1/speed-test', gate: 'automation', handler: (c) => speedTestCore(c.request, c.deps, c.requestId, c.now, true) },
  { method: 'POST', path: '/api/v1/gateway/sync', gate: 'automation', handler: (c) => syncGatewayForActor(c.request, c.deps, c.requestId, c.now, c.actor) },
  { method: 'POST', path: '/api/v1/enrollment-tokens', gate: 'adminOrAutomation', handler: (c) => handleApiEnrollmentToken(c.deps, c.requestId, c.now, c.actor) },
  { method: 'GET', path: '/api/v1/nodes', gate: 'automation', handler: (c) => handleApiNodeList(c.deps, c.url, c.requestId, c.now) },
  { method: 'GET', path: /^\/api\/v1\/nodes\/[^/]+$/, gate: 'automation', handler: (c) => handleApiNodeGet(c.deps, c.url, c.requestId, c.now) },
  { method: 'POST', path: /^\/api\/v1\/nodes\/[^/]+\/reconfigure$/, gate: 'automation', handler: (c) => handleApiNodeReconfigure(c.request, c.deps, c.url, c.requestId, c.now, c.actor) },
  { method: 'POST', path: /^\/api\/v1\/nodes\/[^/]+\/deactivate$/, gate: 'automation', handler: (c) => apiSetNodeDeactivated(c.deps, idFromPath(c.url, 2), true, c.requestId, c.now, c.actor) },
  { method: 'POST', path: /^\/api\/v1\/nodes\/[^/]+\/activate$/, gate: 'automation', handler: (c) => apiSetNodeDeactivated(c.deps, idFromPath(c.url, 2), false, c.requestId, c.now, c.actor) },
  { method: 'POST', path: /^\/api\/v1\/nodes\/[^/]+\/reload$/, gate: 'automation', handler: (c) => requestNodeReload(c.deps, idFromPath(c.url, 2), c.actor, c.requestId, c.now) },
  { method: 'DELETE', path: /^\/api\/v1\/nodes\/[^/]+$/, gate: 'automation', handler: (c) => handleApiNodeDecommission(c.deps, c.url, c.requestId, c.now, c.actor) },
  { method: 'GET', path: '/api/v1/models', gate: 'automation', handler: (c) => handleApiModelList(c.deps, c.requestId) },
  { method: 'POST', path: '/api/v1/models', gate: 'automation', handler: (c) => handleApiModelAdd(c.request, c.deps, c.requestId, c.now, c.actor) },
  { method: 'POST', path: /^\/api\/v1\/models\/[^/]+\/enable$/, gate: 'automation', handler: (c) => handleApiModelEnable(c.deps, c.url, c.requestId, c.now, c.actor) },
  { method: 'POST', path: /^\/api\/v1\/models\/[^/]+\/disable$/, gate: 'automation', handler: (c) => handleApiModelDisable(c.deps, c.url, c.requestId, c.now, c.actor) },
  { method: 'POST', path: /^\/api\/v1\/models\/[^/]+\/duplicate$/, gate: 'automation', handler: (c) => duplicateProfileCore(c.deps, idFromPath(c.url, 2), c.actor, c.requestId, c.now) },
  { method: 'DELETE', path: /^\/api\/v1\/models\/[^/]+$/, gate: 'automation', handler: (c) => handleApiModelDelete(c.deps, c.url, c.requestId, c.now, c.actor) },
  { method: 'POST', path: /^\/api\/v1\/models\/[^/]+$/, gate: 'automation', handler: (c) => handleApiModelConfigure(c.request, c.deps, c.url, c.requestId, c.now, c.actor) },
  { method: 'GET', path: '/api/v1/agent-versions', gate: 'automation', handler: (c) => agentVersionsList(c.request, c.deps) },
  { method: 'PUT', path: '/api/v1/agent-version', gate: 'automation', handler: (c) => agentVersionSelect(c.request, c.deps, c.actor) },
  { method: 'POST', path: '/api/v1/mesh/rotate', gate: 'automation', handler: (c) => meshRotateCore(c.request, c.deps, c.now, c.actor) },
  { method: 'GET', path: '/api/v1/settings', gate: 'automation', handler: (c) => handleApiSettingsGet(c.deps, c.requestId) },
  { method: 'PUT', path: '/api/v1/settings', gate: 'automation', handler: (c) => applyFleetSettings(c.request, c.deps, c.actor, c.requestId, c.now) },
  { method: 'GET', path: '/api/v1/runtime-versions', gate: 'automation', handler: (c) => runtimeVersionsList(c.request, c.deps) },
  { method: 'PUT', path: '/api/v1/runtime-versions', gate: 'automation', handler: (c) => runtimeVersionSelect(c.request, c.deps, c.actor) },
  { method: 'GET', path: '/api/v1/meshes', gate: 'automation', handler: (c) => meshListCore(c.deps, c.requestId, c.now) },
  { method: 'POST', path: '/api/v1/meshes', gate: 'automation', handler: (c) => meshCreateCore(c.request, c.deps, c.actor, c.requestId, c.now) },
  { method: 'DELETE', path: /^\/api\/v1\/meshes\/[^/]+$/, gate: 'automation', handler: (c) => meshDeleteCore(c.deps, idFromPath(c.url, 1), c.actor, c.requestId, c.now) },
  { method: 'GET', path: '/api/v1/events', gate: 'automation', handler: (c) => handleApiEvents(c.deps, c.url, c.requestId) }
]

/** @specanchor Target for the spec and documentation source anchors; deliberately has no runtime importer. */
export const ROUTER_ANCHORS = {
  REQ_GWY_001: 'REQ-GWY-001',
  REQ_RTR_001: 'REQ-RTR-001',
  REQ_RTR_002: 'REQ-RTR-002',
  REQ_RTR_003: 'REQ-RTR-003',
  REQ_OBS_001: 'REQ-OBS-001',
  REQ_OBS_002: 'REQ-OBS-002',
  REQ_OBS_004: 'REQ-OBS-004',
  REQ_OBS_006: 'REQ-OBS-006',
  REQ_ADM_001: 'REQ-ADM-001',
  REQ_ADM_002: 'REQ-ADM-002',
  REQ_ADM_003: 'REQ-ADM-003',
  REQ_ADM_006: 'REQ-ADM-006',
  REQ_ADM_008: 'REQ-ADM-008',
  REQ_ADM_012: 'REQ-ADM-012',
  REQ_ADM_013: 'REQ-ADM-013',
  REQ_ADM_014: 'REQ-ADM-014',
  REQ_ADM_016: 'REQ-ADM-016',
  REQ_ADM_017: 'REQ-ADM-017',
  REQ_ADM_019: 'REQ-ADM-019',
  REQ_GWY_005: 'REQ-GWY-005',
  REQ_SEC_002: 'REQ-SEC-002',
  REQ_SEC_006: 'REQ-SEC-006',
  REQ_SEC_009: 'REQ-SEC-009',
  REQ_SEC_010: 'REQ-SEC-010',
  REQ_API_001: 'REQ-API-001',
  REQ_API_002: 'REQ-API-002',
  REQ_API_003: 'REQ-API-003',
  REQ_API_004: 'REQ-API-004',
  REQ_API_005: 'REQ-API-005',
  REQ_API_006: 'REQ-API-006'
} as const
