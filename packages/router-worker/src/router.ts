import { CloudflareAccessClient, type AccessProvisionRequest, type AccessProvisionResult } from './access-provisioning'
import { adminUiHtml, type AdminUiState } from './admin-ui'
import { consoleMovedHtml } from './admin-ui-views'
import { desiredAgentVersion, handleAgentVersionSelect, handleAgentVersionsList } from './agent-versions'
import { bearerToken, createTokenRecord, generateBearerToken, hashToken, redactSecrets, verifyPlainOrHashed } from './auth'
import { authenticateAnyStoredToken, authenticateKind, authenticateTokenByNode, recordBreakGlassEntry, requireAdmin, requireAutomation, requireKeyAdmin, requireUser, resolveHostGate } from './auth-gates'
import { CloudflareGatewayClient, type CustomDomainProvisionRequest, type CustomDomainProvisionResult, type GatewayProvisionStatus, type GatewayRecord, type GatewaySyncRequest, type GatewaySyncResult, type RouteRecord, type ZoneRecord } from './cloudflare-api'
import { InvalidJsonBodyError } from './errors'
import { cleanString, html, json, parseObject, rateLimited, readJson, readOptionalObject } from './http'
import { resolveUpstreamToken, runInference } from './inference'
import { newestSpeedTest, runSpeedTest, storedSpeedTests, type SpeedTestBody } from './speed-test'
import { installerCommand, installScript, SETUP_TOKEN_PLACEHOLDER, validateCustomDomain, type InstallerPlatform } from './installers'
import { applyHeartbeatMeshState, handleMeshRotate, meshBootstrapFor, meshHealth, removeNodeMeshTokens } from './mesh-state'
import { createMesh, deleteMesh, listMeshes, meshAliasFor, validateMeshName, type MeshRecord } from './meshes'
import { buildCustomProfile, buildDuplicateProfile, DEFAULT_MODEL_PROFILES, llamaCppQuantError, nodeMeshId, profileMeshId, STABLE_PUBLIC_MODEL } from './profiles'
import { applyNodeVramOverride, configureLlamaCppProfile, INVALID_MAX_VRAM, INVALID_NODE_NAME, nodeWithConfig, resolveCallNameAliases, resolveMaxVram, resolveMeshReassignment, resolveMeshllmTunables, resolveRuntime, type ModelConfigBody, type NodeConfigBody } from './profile-config'
import { isRateLimited } from './rate-limit'
import { matchRoute, type Route } from './routes'
import { activeMeshllmRepository, desiredRuntimeVersions, handleRuntimeVersionsList, handleRuntimeVersionsSelect } from './runtime-versions'
import { isSafeMeshTarget } from './scheduler'
import { ACCESS_CONFIG_KEY, SETUP_REOPEN_CONSUMED_KEY, advancePhase, breakGlassActive, setupPhase } from './setup-state'
import { singleActiveActivation } from './store'
import type { ClaimRequest, HeartbeatRequest, ModelProfile, NodeRecord, RouterEnv, Scheduler, Store, StoredCustomDomain } from './types'

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024
const SETUP_TOKEN_TTL_MS = 24 * 60 * 60 * 1000

export interface RouterDeps {
  readonly store: Store
  readonly scheduler: Scheduler
  readonly mesh: Fetcher
  readonly env: Partial<RouterEnv>
  readonly now?: () => number
  readonly requestId?: () => string
  readonly cloudflareClient?: {
    syncCustomProvider(input: GatewaySyncRequest): Promise<GatewaySyncResult>
    provisionCustomDomain(input: CustomDomainProvisionRequest): Promise<CustomDomainProvisionResult>
    listZones?(accountId: string): Promise<readonly ZoneRecord[]>
    listGateways?(accountId: string): Promise<readonly GatewayRecord[]>
    listRoutes?(accountId: string, gatewayId: string): Promise<readonly RouteRecord[]>
    provisionStatus?(accountId: string, gatewayId: string, routeName: string, providerName: string): Promise<GatewayProvisionStatus>
  }
  readonly accessClient?: { provisionAccess(input: AccessProvisionRequest): Promise<AccessProvisionResult> }
  readonly jwksFetcher?: typeof fetch
  readonly releasesFetcher?: typeof fetch
  readonly playgroundFetcher?: typeof fetch
  readonly identityFetcher?: typeof fetch
}

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
      return await route.handler({ request, deps, url, requestId: id, now: now() })
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

/** Everything a handler needs from the request, assembled once per dispatch. */
interface RouteContext {
  readonly request: Request
  readonly deps: RouterDeps
  readonly url: URL
  readonly requestId: string
  readonly now: number
}

/**
 * The router's full surface, in precedence order. First match wins, so this list
 * must stay ordered exactly as the `if` chain it replaced.
 *
 * `gate` names the credential class each handler enforces. The handler still
 * performs the check; the declaration exists so the auth matrix is readable in
 * one place and provable in one test. `router.test.ts` drives every non-open
 * route with no credential and asserts 401, so a handler that silently loses its
 * gate fails the suite rather than shipping an open endpoint.
 *
 * `/` and `/admin` are not listed: they are served before dispatch because the
 * custom-domain host gate rewrites them to a moved or recovery page first.
 */
export const ROUTES: readonly Route<RouteContext>[] = [
  { method: 'GET', path: '/health', gate: 'open', handler: async (c) => json({ ok: true, service: 'inference-mesh-router' }, 200, c.requestId) },
  { method: 'GET', path: '/v1/models', gate: 'provider', handler: (c) => handleModels(c.request, c.deps, c.requestId, c.now) },
  { method: 'POST', path: '/v1/chat/completions', gate: 'provider', handler: (c) => handleChat(c.request, c.deps, c.requestId, c.now) },
  { method: 'POST', path: '/node/claim', gate: 'setup', handler: (c) => handleNodeClaim(c.request, c.deps, c.requestId, c.now) },
  { method: 'POST', path: '/node/heartbeat', gate: 'node', handler: (c) => handleNodeHeartbeat(c.request, c.deps, c.requestId, c.now) },
  { method: 'POST', path: '/node/unregister', gate: 'node', handler: (c) => handleNodeUnregister(c.request, c.deps, c.requestId, c.now) },
  { method: 'POST', path: '/admin/setup', gate: 'bootstrapOrAdmin', handler: (c) => handleFirstSetup(c.request, c.deps, c.requestId, c.now) },
  { method: 'POST', path: '/admin/recovery/reset', gate: 'recovery', handler: (c) => handleAdminRecovery(c.request, c.deps, c.requestId, c.now) },
  { method: 'GET', path: '/install.sh', gate: 'open', handler: async (c) => handleInstallScript(c.deps, c.url.searchParams.get('platform') === 'macos' ? 'macos' : 'linux') },
  { method: 'GET', path: '/install.ps1', gate: 'open', handler: async (c) => handleInstallScript(c.deps, 'windows') },
  { method: 'POST', path: '/admin/login', gate: 'admin', handler: (c) => handleAdminLogin(c.request, c.deps, c.requestId, c.now) },
  { method: 'GET', path: '/admin/status', gate: 'user', handler: (c) => handleAdminStatus(c.request, c.deps, c.requestId, c.now) },
  { method: 'POST', path: '/admin/setup-tokens', gate: 'admin', handler: (c) => handleSetupToken(c.request, c.deps, c.requestId, c.now) },
  { method: 'GET', path: /^\/admin\/installers\//, gate: 'admin', handler: (c) => handleInstaller(c.request, c.deps, c.url, c.requestId, c.now) },
  { method: 'POST', path: '/admin/cloudflare/gateway/sync', gate: 'admin', handler: (c) => handleGatewaySync(c.request, c.deps, c.requestId, c.now) },
  { method: 'POST', path: '/admin/custom-domain/validate', gate: 'admin', handler: (c) => handleCustomDomain(c.request, c.deps, c.requestId, c.now, false) },
  { method: 'POST', path: '/admin/setup/domain', gate: 'admin', handler: (c) => handleCustomDomain(c.request, c.deps, c.requestId, c.now, true) },
  { method: 'POST', path: '/admin/setup/access', gate: 'admin', handler: (c) => handleSetupAccess(c.request, c.deps, c.requestId, c.now) },
  { method: 'POST', path: '/admin/setup/complete', gate: 'admin', handler: (c) => handleSetupComplete(c.request, c.deps, c.requestId, c.now) },
  { method: 'GET', path: '/admin/cloudflare/zones', gate: 'admin', handler: (c) => handleZones(c.request, c.deps, c.requestId, c.now) },
  { method: 'GET', path: '/admin/cloudflare/gateway/options', gate: 'admin', handler: (c) => handleGatewayOptions(c.request, c.deps, c.url, c.requestId, c.now) },
  { method: 'GET', path: '/admin/cloudflare/gateway/provision-status', gate: 'admin', handler: (c) => handleGatewayProvisionStatus(c.request, c.deps, c.url, c.requestId, c.now) },
  { method: 'POST', path: /^\/admin\/nodes\/[^/]+\/revoke$/, gate: 'admin', handler: (c) => handleNodeRevoke(c.request, c.deps, c.url, c.requestId, c.now) },
  { method: 'POST', path: /^\/admin\/nodes\/[^/]+\/deactivate$/, gate: 'admin', handler: (c) => handleNodeDeactivate(c.request, c.deps, c.url, c.requestId, c.now) },
  { method: 'POST', path: /^\/admin\/nodes\/[^/]+\/activate$/, gate: 'admin', handler: (c) => handleNodeActivate(c.request, c.deps, c.url, c.requestId, c.now) },
  { method: 'POST', path: /^\/admin\/nodes\/[^/]+\/reload$/, gate: 'admin', handler: (c) => handleNodeReload(c.request, c.deps, c.url, c.requestId, c.now) },
  { method: 'POST', path: /^\/admin\/nodes\/[^/]+\/config$/, gate: 'admin', handler: (c) => handleNodeConfig(c.request, c.deps, c.url, c.requestId, c.now) },
  { method: 'GET', path: '/admin/meshes', gate: 'user', handler: (c) => handleMeshList(c.request, c.deps, c.requestId, c.now) },
  { method: 'POST', path: '/admin/meshes', gate: 'admin', handler: (c) => handleMeshCreate(c.request, c.deps, c.requestId, c.now) },
  { method: 'DELETE', path: /^\/admin\/meshes\/[^/]+$/, gate: 'admin', handler: (c) => handleMeshDelete(c.request, c.deps, c.url, c.requestId, c.now) },
  { method: 'POST', path: '/admin/profiles/rollout', gate: 'admin', handler: (c) => handleProfileRollout(c.request, c.deps, c.requestId, c.now) },
  { method: 'POST', path: '/admin/profiles/activate', gate: 'admin', handler: (c) => handleProfileActivate(c.request, c.deps, c.requestId, c.now) },
  { method: 'POST', path: '/admin/profiles/add', gate: 'admin', handler: (c) => handleProfileAdd(c.request, c.deps, c.requestId, c.now) },
  { method: 'POST', path: '/admin/profiles/config', gate: 'admin', handler: (c) => handleProfileConfig(c.request, c.deps, c.requestId, c.now) },
  { method: 'POST', path: '/admin/profiles/delete', gate: 'admin', handler: (c) => handleProfileDelete(c.request, c.deps, c.requestId, c.now) },
  { method: 'POST', path: '/admin/profiles/duplicate', gate: 'admin', handler: (c) => handleProfileDuplicate(c.request, c.deps, c.requestId, c.now) },
  { method: 'POST', path: '/admin/settings', gate: 'admin', handler: (c) => handleAdminSettings(c.request, c.deps, c.requestId, c.now) },
  { method: 'GET', path: '/admin/runtime-versions', gate: 'admin', handler: (c) => handleAdminRuntimeVersions(c.request, c.deps, c.requestId, c.now) },
  { method: 'POST', path: '/admin/runtime-versions', gate: 'admin', handler: (c) => handleAdminRuntimeVersionSelect(c.request, c.deps, c.requestId, c.now) },
  { method: 'POST', path: '/admin/mesh/rotate', gate: 'admin', handler: (c) => handleAdminMeshRotate(c.request, c.deps, c.requestId, c.now) },
  { method: 'GET', path: '/admin/agent-versions', gate: 'admin', handler: (c) => handleAdminAgentVersions(c.request, c.deps, c.requestId, c.now) },
  { method: 'POST', path: '/admin/agent-version', gate: 'admin', handler: (c) => handleAdminAgentVersionSelect(c.request, c.deps, c.requestId, c.now) },
  { method: 'POST', path: '/admin/playground/chat', gate: 'user', handler: (c) => handlePlaygroundChat(c.request, c.deps, c.requestId, c.now) },
  { method: 'POST', path: '/admin/playground/direct-chat', gate: 'user', handler: (c) => handlePlaygroundDirect(c.request, c.deps, c.requestId, c.now) },
  { method: 'POST', path: '/admin/playground/speed-test', gate: 'user', handler: (c) => handlePlaygroundSpeedTest(c.request, c.deps, c.requestId, c.now) },
  { method: 'GET', path: '/admin/whoami', gate: 'user', handler: (c) => handleWhoami(c.request, c.deps, c.requestId, c.now) },
  { method: 'POST', path: '/api/v1/keys', gate: 'keyAdmin', handler: (c) => handleApiKeyCreate(c.request, c.deps, c.requestId, c.now) },
  { method: 'GET', path: '/api/v1/keys', gate: 'keyAdmin', handler: (c) => handleApiKeyList(c.request, c.deps, c.requestId, c.now) },
  { method: 'POST', path: /^\/api\/v1\/keys\/[^/]+\/rotate$/, gate: 'keyAdmin', handler: (c) => handleApiKeyRotate(c.request, c.deps, c.url, c.requestId, c.now) },
  { method: 'DELETE', path: /^\/api\/v1\/keys\/[^/]+$/, gate: 'keyAdmin', handler: (c) => handleApiKeyRevoke(c.request, c.deps, c.url, c.requestId, c.now) },
  { method: 'GET', path: '/api/v1/status', gate: 'automation', handler: (c) => handleApiStatus(c.request, c.deps, c.requestId, c.now) },
  { method: 'POST', path: '/api/v1/speed-test', gate: 'automation', handler: (c) => handleApiSpeedTest(c.request, c.deps, c.requestId, c.now) },
  { method: 'POST', path: '/api/v1/gateway/sync', gate: 'automation', handler: (c) => handleApiGatewaySync(c.request, c.deps, c.requestId, c.now) },
  { method: 'POST', path: '/api/v1/enrollment-tokens', gate: 'adminOrAutomation', handler: (c) => handleApiEnrollmentToken(c.request, c.deps, c.requestId, c.now) },
  { method: 'GET', path: '/api/v1/nodes', gate: 'automation', handler: (c) => handleApiNodeList(c.request, c.deps, c.url, c.requestId, c.now) },
  { method: 'GET', path: /^\/api\/v1\/nodes\/[^/]+$/, gate: 'automation', handler: (c) => handleApiNodeGet(c.request, c.deps, c.url, c.requestId, c.now) },
  { method: 'POST', path: /^\/api\/v1\/nodes\/[^/]+\/reconfigure$/, gate: 'automation', handler: (c) => handleApiNodeReconfigure(c.request, c.deps, c.url, c.requestId, c.now) },
  { method: 'POST', path: /^\/api\/v1\/nodes\/[^/]+\/deactivate$/, gate: 'automation', handler: (c) => handleApiNodeDeactivate(c.request, c.deps, c.url, c.requestId, c.now) },
  { method: 'POST', path: /^\/api\/v1\/nodes\/[^/]+\/activate$/, gate: 'automation', handler: (c) => handleApiNodeActivate(c.request, c.deps, c.url, c.requestId, c.now) },
  { method: 'POST', path: /^\/api\/v1\/nodes\/[^/]+\/reload$/, gate: 'automation', handler: (c) => handleApiNodeReload(c.request, c.deps, c.url, c.requestId, c.now) },
  { method: 'DELETE', path: /^\/api\/v1\/nodes\/[^/]+$/, gate: 'automation', handler: (c) => handleApiNodeDecommission(c.request, c.deps, c.url, c.requestId, c.now) },
  { method: 'GET', path: '/api/v1/models', gate: 'automation', handler: (c) => handleApiModelList(c.request, c.deps, c.requestId, c.now) },
  { method: 'POST', path: '/api/v1/models', gate: 'automation', handler: (c) => handleApiModelAdd(c.request, c.deps, c.requestId, c.now) },
  { method: 'POST', path: /^\/api\/v1\/models\/[^/]+\/enable$/, gate: 'automation', handler: (c) => handleApiModelEnable(c.request, c.deps, c.url, c.requestId, c.now) },
  { method: 'POST', path: /^\/api\/v1\/models\/[^/]+\/disable$/, gate: 'automation', handler: (c) => handleApiModelDisable(c.request, c.deps, c.url, c.requestId, c.now) },
  { method: 'POST', path: /^\/api\/v1\/models\/[^/]+\/duplicate$/, gate: 'automation', handler: (c) => handleApiModelDuplicate(c.request, c.deps, c.url, c.requestId, c.now) },
  { method: 'DELETE', path: /^\/api\/v1\/models\/[^/]+$/, gate: 'automation', handler: (c) => handleApiModelDelete(c.request, c.deps, c.url, c.requestId, c.now) },
  { method: 'POST', path: /^\/api\/v1\/models\/[^/]+$/, gate: 'automation', handler: (c) => handleApiModelConfigure(c.request, c.deps, c.url, c.requestId, c.now) },
  { method: 'GET', path: '/api/v1/agent-versions', gate: 'automation', handler: (c) => handleApiAgentVersions(c.request, c.deps, c.requestId, c.now) },
  { method: 'PUT', path: '/api/v1/agent-version', gate: 'automation', handler: (c) => handleApiAgentVersionSet(c.request, c.deps, c.requestId, c.now) },
  { method: 'POST', path: '/api/v1/mesh/rotate', gate: 'automation', handler: (c) => handleApiMeshRotate(c.request, c.deps, c.requestId, c.now) },
  { method: 'GET', path: '/api/v1/settings', gate: 'automation', handler: (c) => handleApiSettingsGet(c.request, c.deps, c.requestId, c.now) },
  { method: 'PUT', path: '/api/v1/settings', gate: 'automation', handler: (c) => handleApiSettingsSet(c.request, c.deps, c.requestId, c.now) },
  { method: 'GET', path: '/api/v1/runtime-versions', gate: 'automation', handler: (c) => handleApiRuntimeVersions(c.request, c.deps, c.requestId, c.now) },
  { method: 'PUT', path: '/api/v1/runtime-versions', gate: 'automation', handler: (c) => handleApiRuntimeVersionSet(c.request, c.deps, c.requestId, c.now) },
  { method: 'GET', path: '/api/v1/meshes', gate: 'automation', handler: (c) => handleApiMeshList(c.request, c.deps, c.requestId, c.now) },
  { method: 'POST', path: '/api/v1/meshes', gate: 'automation', handler: (c) => handleApiMeshCreate(c.request, c.deps, c.requestId, c.now) },
  { method: 'DELETE', path: /^\/api\/v1\/meshes\/[^/]+$/, gate: 'automation', handler: (c) => handleApiMeshDelete(c.request, c.deps, c.url, c.requestId, c.now) },
  { method: 'GET', path: '/api/v1/events', gate: 'automation', handler: (c) => handleApiEvents(c.request, c.deps, c.url, c.requestId, c.now) }
]

async function handleModels(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  if (!(await authenticateKind(request, deps, 'provider', now, deps.env.ROUTER_PROVIDER_TOKEN))) return json({ error: 'unauthorized' }, 401, requestId)
  const profiles = await deps.store.listProfiles()
  return json({ object: 'list', data: profiles.filter((profile) => profile.active).flatMap((profile) => profile.publicAliases.map((id) => ({ id, object: 'model', owned_by: 'codeflare-inference-mesh' }))) }, 200, requestId)
}

async function handleChat(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  if (!(await authenticateKind(request, deps, 'provider', now, deps.env.ROUTER_PROVIDER_TOKEN))) return json({ error: 'unauthorized' }, 401, requestId)
  const parsedMaxBytes = Number(deps.env.MAX_REQUEST_BYTES ?? DEFAULT_MAX_BYTES)
  const maxBytes = Number.isFinite(parsedMaxBytes) ? parsedMaxBytes : DEFAULT_MAX_BYTES
  const contentLength = Number(request.headers.get('content-length') ?? '0')
  if (contentLength > maxBytes) return json({ error: 'request_too_large', requestId }, 413, requestId)
  const bodyText = await request.text()
  if (new TextEncoder().encode(bodyText).byteLength > maxBytes) return json({ error: 'request_too_large', requestId }, 413, requestId)
  const body = parseObject(bodyText)
  if (!body || typeof body.model !== 'string') return json({ error: 'invalid_json', requestId }, 400, requestId)
  return runInference(deps, { body, requestHeaders: request.headers, requestId, now })
}






async function handleNodeClaim(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  const setupToken = await authenticateAnyStoredToken(request, deps.store, 'setup', now)
  if (!setupToken) return json({ error: 'unauthorized' }, 401, requestId)
  const body = await readJson<ClaimRequest>(request)
  const validation = validateClaim(body, deps.env)
  if (validation.length > 0) return json({ error: 'invalid_claim', fields: validation }, 400, requestId)
  const nodeToken = generateBearerToken('node')
  const upstreamToken = await getOrCreateUpstreamToken(deps)
  const nodeId = stableNodeId(body.displayName, body.meshIp)
  const nodeRecord = {
    id: nodeId,
    displayName: body.displayName,
    meshIp: body.meshIp,
    inferencePort: body.inferencePort,
    localDashboardPort: 17777,
    status: 'online' as const,
    publicModels: body.publicModels,
    activeProfileIds: body.activeProfileIds,
    capacity: body.capacity,
    inFlight: 0,
    lastSeenAt: now,
    runtime: 'meshllm' as const,
    nodeTokenVerifier: await hashToken(nodeToken),
    upstreamTokenVerifier: await hashToken(upstreamToken)
  }
  await deps.store.upsertNode(nodeRecord)
  await deps.store.putToken(await createTokenRecord('node', nodeToken, now, nodeId))
  await deps.store.revokeToken('setup', setupToken.id, now)
  await deps.store.appendAudit({ id: requestId, type: 'node_claimed', at: now, actor: 'setup', target: nodeId, detail: { displayName: body.displayName } })
  const meshProfile = await selectedMeshProfile(deps.store, nodeRecord, body.activeProfileIds)
  const meshBootstrap = meshProfile ? await meshBootstrapFor(deps.store, deps.env, nodeRecord, meshProfile, now) : undefined
  const desiredVersion = await desiredAgentVersion(deps.store)
  return json({
    nodeId,
    nodeToken,
    upstreamToken,
    // A node only ever receives its own machine group's profiles (REQ-SCH-006);
    // a fresh claim joins the default mesh.
    profiles: meshProfilesFor(await deps.store.listProfiles(), nodeRecord),
    desiredRuntimeVersions: await desiredRuntimeVersionsPayload(deps),
    ...(meshBootstrap !== undefined ? { meshBootstrap } : {}),
    ...(desiredVersion !== undefined ? { desiredAgentVersion: desiredVersion } : {})
  }, 201, requestId)
}

async function handleNodeHeartbeat(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  const body = await readJson<HeartbeatRequest>(request)
  const validation = validateHeartbeat(body, deps.env)
  if (validation.length > 0) return json({ error: 'invalid_heartbeat', fields: validation }, 400, requestId)
  const node = await deps.store.getNode(body.nodeId)
  if (!node) return json({ error: 'unknown_node' }, 404, requestId)
  if (node.status === 'revoked') return json({ error: 'node_revoked' }, 403, requestId)
  const presented = bearerToken(request)
  const tokenOk = node.nodeTokenVerifier ? await verifyPlainOrHashed(node.nodeTokenVerifier, presented) : Boolean(await authenticateTokenByNode(request, deps.store, 'node', body.nodeId, now))
  if (!tokenOk) return json({ error: 'unauthorized' }, 401, requestId)
  const next = {
    ...node,
    displayName: node.displayName || body.displayName,
    meshIp: body.meshIp,
    inferencePort: body.inferencePort,
    localDashboardPort: body.localDashboardPort,
    status: body.status,
    publicModels: body.publicModels,
    activeProfileIds: body.activeProfileIds,
    capacity: body.capacity,
    inFlight: node.inFlight,
    lastSeenAt: now,
    runtime: body.runtime,
    ...(body.runtimeModel !== undefined ? { runtimeModel: body.runtimeModel } : {}),
    ...(body.agentVersion !== undefined ? { agentVersion: body.agentVersion } : {}),
    ...(body.metrics !== undefined ? { metrics: body.metrics } : {}),
    // Retire the Force Reload directive once the node echoes back the nonce it applied. REQ-NODE-012.
    ...(body.reloadNonce !== undefined && body.reloadNonce !== '' && body.reloadNonce === node.reloadNonce ? { reloadNonce: '' } : {})
  }
  await deps.store.updateNodeHeartbeat(next)
  // A deactivated node runs no mesh-llm, so its now-dead invite token must not be re-added to mesh
  // state; skip mesh-state application while it is tainted. REQ-ADM-030 / REQ-NODE-011.
  if (next.deactivated !== true && next.runtime === 'meshllm') {
    await applyHeartbeatMeshState(deps.store, deps.env, next, body, now)
  }
  const desiredVersion = await desiredAgentVersion(deps.store)
  // A deactivated node is tainted: it keeps heartbeating but must run no model, so it receives no
  // desired profiles and no mesh bootstrap and is told to stay down. REQ-ADM-030 / REQ-NODE-011.
  if (next.deactivated === true) {
    return json({
      ok: true,
      desiredProfiles: [],
      desiredRuntimeVersions: await desiredRuntimeVersionsPayload(deps),
      deactivated: true,
      ...(desiredVersion !== undefined ? { desiredAgentVersion: desiredVersion } : {})
    }, 200, requestId)
  }
  const meshProfile = await selectedMeshProfile(deps.store, next, next.activeProfileIds)
  const meshBootstrap = meshProfile ? await meshBootstrapFor(deps.store, deps.env, next, meshProfile, now) : undefined
  // A per-node VRAM override caps this node's models below the model's global budget.
  // Distribution is mesh-scoped (REQ-SCH-006): the node receives only its group's profiles.
  const desiredProfiles = applyNodeVramOverride(meshProfilesFor(await deps.store.listProfiles(), next), next.maxVramGbOverride)
  return json({
    ok: true,
    desiredProfiles,
    desiredRuntimeVersions: await desiredRuntimeVersionsPayload(deps),
    ...(meshBootstrap !== undefined ? { meshBootstrap } : {}),
    ...(desiredVersion !== undefined ? { desiredAgentVersion: desiredVersion } : {}),
    ...(next.reloadNonce ? { reloadNonce: next.reloadNonce } : {})
  }, 200, requestId)
}

// Only profiles in the node's own machine group qualify (REQ-SCH-006): after a mesh
// reassignment the node still self-reports its old profile ids for a tick, and an
// ungated pick would hand it a bootstrap (and re-add its token) for the old mesh.
async function selectedMeshProfile(store: Store, node: NodeRecord, activeProfileIds: readonly string[]): Promise<ModelProfile | undefined> {
  const profiles = meshProfilesFor(await store.listProfiles(), node)
  for (const profileId of activeProfileIds) {
    const profile = profiles.find((item) => item.id === profileId)
    if (profile?.active && profile.runtime === 'meshllm') return profile
  }
  return undefined
}

function meshProfilesFor(profiles: readonly ModelProfile[], node: NodeRecord): readonly ModelProfile[] {
  return profiles.filter((profile) => profileMeshId(profile) === nodeMeshId(node))
}

// The desired-runtime-versions payload the fleet follows, carrying meshllmRepository
// only when the active binary source is the fork — an official choice drops the field
// so agents reset to upstream. REQ-NODE-014.
async function desiredRuntimeVersionsPayload(deps: RouterDeps): Promise<Record<string, unknown>> {
  const versions = await desiredRuntimeVersions(deps.store)
  const meshllmRepository = await activeMeshllmRepository(deps.env, deps.store)
  return { ...versions, ...(meshllmRepository ? { meshllmRepository } : {}) }
}

async function handleNodeUnregister(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  const body = await readJson<{ nodeId?: string }>(request)
  if (!body?.nodeId) return json({ error: 'invalid_unregister' }, 400, requestId)
  const node = await deps.store.getNode(body.nodeId)
  if (!node) return json({ error: 'unknown_node' }, 404, requestId)
  if (node.status === 'revoked') return json({ error: 'node_revoked' }, 403, requestId)
  const presented = bearerToken(request)
  const tokenOk = node.nodeTokenVerifier ? await verifyPlainOrHashed(node.nodeTokenVerifier, presented) : Boolean(await authenticateTokenByNode(request, deps.store, 'node', body.nodeId, now))
  if (!tokenOk) return json({ error: 'unauthorized' }, 401, requestId)
  await deps.store.upsertNode({ ...node, status: 'offline', inFlight: 0, lastSeenAt: now })
  await deps.store.appendAudit({ id: requestId, type: 'node_unregistered', at: now, actor: 'node', target: body.nodeId, detail: {} })
  return json({ ok: true }, 200, requestId)
}

/** Entry state for the shell: wizard until setup completes, dashboard afterwards. */
async function adminUiState(deps: RouterDeps, recovery: boolean): Promise<AdminUiState> {
  const phase = await setupPhase(deps.store)
  const domain = await deps.store.getConfig<StoredCustomDomain>('custom_domain')
  return {
    view: phase === 'complete' && !recovery ? 'dashboard' : 'setup',
    phase,
    ...(domain?.status === 'provisioned' ? { customDomain: domain.hostname } : {}),
    recovery
  }
}

async function handleFirstSetup(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  const existingAdmins = await deps.store.listTokens('admin')
  if (existingAdmins.some((token) => token.active) && !(await requireAdmin(request, deps, now))) return json({ error: 'unauthorized' }, 401, requestId)
  // Claim mints ONLY the bootstrap token. The machine credentials surface where
  // they are used: the provider token in the gateway-sync result, the setup token
  // inside the install command, and the upstream token lazily at node claim.
  const adminToken = generateBearerToken('admin')
  await deps.store.putToken(await createTokenRecord('admin', adminToken, now))
  await deps.store.putConfig('setup_state', { phase: 'claimed', claimedAt: now })
  await deps.store.appendAudit({ id: requestId, type: 'first_setup', at: now, actor: 'setup', detail: {} })
  return json({ adminToken }, 201, requestId)
}

async function handleAdminRecovery(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  const recoveryToken = deps.env.ADMIN_RECOVERY_TOKEN
  if (!recoveryToken || !(await verifyPlainOrHashed(recoveryToken, bearerToken(request)))) return json({ error: 'unauthorized' }, 401, requestId)
  const existingAdmins = await deps.store.listTokens('admin')
  await Promise.all(existingAdmins.filter((token) => token.active).map((token) => deps.store.revokeToken('admin', token.id, now)))
  const adminToken = generateBearerToken('admin')
  await deps.store.putToken(await createTokenRecord('admin', adminToken, now))
  await deps.store.appendAudit({ id: requestId, type: 'admin_recovery_reset', at: now, actor: 'recovery', detail: { revoked: existingAdmins.filter((token) => token.active).length } })
  return json({ adminToken }, 201, requestId)
}

async function handleAdminLogin(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  const actor = await requireAdmin(request, deps, now)
  if (!actor) return json({ error: 'unauthorized' }, 401, requestId)
  return json({ ok: true, session: 'bearer-token' }, 200, requestId)
}

// DEFAULT_OFFLINE_PRUNE_SECONDS removes a node that has been offline this long (30 days).
// The operator can shorten it or disable pruning with 0 via the Settings surface.
const DEFAULT_OFFLINE_PRUNE_SECONDS = 2592000

async function offlinePruneSeconds(deps: RouterDeps): Promise<number> {
  const stored = await deps.store.getConfig<number>('offline_prune_seconds')
  return typeof stored === 'number' && Number.isInteger(stored) && stored >= 0 ? stored : DEFAULT_OFFLINE_PRUNE_SECONDS
}

// handleAdminSettings persists operator-tunable fleet settings. offlinePruneSeconds
// must be a non-negative integer (0 disables offline-node pruning).
async function handleAdminSettings(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  const actor = await requireAdmin(request, deps, now)
  if (!actor) return json({ error: 'unauthorized' }, 401, requestId)
  return applyFleetSettings(request, deps, actor, requestId, now)
}

// applyFleetSettings is the shared core for the console and automation settings writers, so
// the two surfaces validate and persist identically and can never diverge.
async function applyFleetSettings(request: Request, deps: RouterDeps, actor: string, requestId: string, now: number): Promise<Response> {
  const body = await readJson<{ offlinePruneSeconds?: number }>(request)
  if (!body || typeof body.offlinePruneSeconds !== 'number' || !Number.isInteger(body.offlinePruneSeconds) || body.offlinePruneSeconds < 0) {
    return json({ error: 'invalid_settings', requestId }, 400, requestId)
  }
  await deps.store.putConfig('offline_prune_seconds', body.offlinePruneSeconds)
  await deps.store.appendAudit({ id: requestId, type: 'settings_updated', at: now, actor, detail: { offlinePruneSeconds: body.offlinePruneSeconds } })
  return json({ ok: true, offlinePruneSeconds: body.offlinePruneSeconds }, 200, requestId)
}

// pruneStaleNodes deletes nodes that have been offline longer than the configured
// window so a decommissioned machine drops out of the fleet and must re-enroll.
async function pruneStaleNodes(deps: RouterDeps, requestId: string, now: number): Promise<void> {
  const threshold = await offlinePruneSeconds(deps)
  if (threshold <= 0) return
  const nodes = await deps.store.listNodes(now)
  let index = 0
  for (const node of nodes) {
    if (node.status === 'offline' && now - node.lastSeenAt > threshold * 1000) {
      await deps.store.deleteNode(node.id)
      await deps.store.appendAudit({ id: `${requestId}-prune-${index}`, type: 'node_pruned', at: now, actor: 'system', target: node.id, detail: { offlineSeconds: Math.round((now - node.lastSeenAt) / 1000) } })
      index += 1
    }
  }
}

async function handleAdminStatus(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  const viewer = await requireUser(request, deps, now)
  if (!viewer) return json({ error: 'unauthorized' }, 401, requestId)
  const isAdmin = viewer.role === 'admin'
  // Prune stale nodes only on admin polls: a read-only user viewer must never
  // trigger fleet mutation (node deletion + audit writes) from a status read.
  if (isAdmin) await pruneStaleNodes(deps, requestId, now)
  const nodes = await deps.store.listNodes(now)
  const profiles = await deps.store.listProfiles()
  const desiredVersion = await desiredAgentVersion(deps.store)
  const runtimeVersions = await desiredRuntimeVersions(deps.store)
  const lastSpeedTests = await storedSpeedTests(deps.store)
  const lastSpeedTest = newestSpeedTest(lastSpeedTests)
  const statusNodes = nodes.map((node) => ({ ...node, displayStatus: nodeDisplayStatus(node), runtimeInstall: runtimeBinaryStatus(node, runtimeVersions) }))
  // The read-only user role sees the live operational picture (nodes, profiles,
  // mesh health, throughput) but never configuration state or the admin action log:
  // those carry gateway/domain internals and operator emails and stay admin-only,
  // matching the server-enforced surface for the user role (REQ-ADM-017).
  const adminOnly = isAdmin
    ? {
        setup: await deps.store.getConfig('setup_state'),
        gateway: await deps.store.getConfig('cloudflare_gateway'),
        customDomain: await deps.store.getConfig('custom_domain'),
        offlinePruneSeconds: await offlinePruneSeconds(deps),
        desiredRuntimeVersions: await desiredRuntimeVersionsPayload(deps),
        audit: await deps.store.listAudit(20)
      }
    : {}
  const redacted = redactSecrets({ nodes: statusNodes, profiles, profileReadiness: profileReadiness(profiles, nodes), ...(lastSpeedTest ? { lastSpeedTest, lastSpeedTests } : {}), ...adminOnly, generatedAt: now }) as Record<string, unknown>
  // meshHealth is composed after redaction: its contract carries token presence/age/count
  // fields (never values), which the key-name redactor would otherwise blank out.
  // Machine groups are visible to both console roles (the nodes table and drawers
  // render group names); the shape carries no secret-like keys. REQ-ADM-037.
  const meshes = (await listMeshes(deps.store)).map((mesh) => meshSummary(mesh, nodes, profiles))
  return json({
    ...redacted,
    viewerRole: viewer.role,
    meshes,
    meshHealth: await meshHealth(deps.store, deps.env, profiles, nodes, now),
    ...(desiredVersion !== undefined ? { desiredAgentVersion: desiredVersion } : {})
  }, 200, requestId)
}

// nodeDisplayStatus reduces a node's raw signals to the operator status vocabulary —
// Serving, Preparing, Disconnected, Offline, Error (plus the Deactivated/Removed/Draining
// lifecycle labels) — derived once here so the console and the automation API can never
// disagree about what a machine is doing (REQ-ADM-020 / REQ-API-004).
function nodeDisplayStatus(node: NodeRecord): string {
  if (node.status === 'offline') return 'Offline'
  if (node.status === 'revoked') return 'Removed'
  if (node.status === 'draining') return 'Draining'
  if (node.deactivated) return 'Deactivated'
  const metrics = node.metrics
  const runtimeState = metrics?.runtimeState ?? ''
  if (runtimeState === 'failed' || runtimeState === 'dependency-missing') return 'Error'
  // Ready models alone are not serving: an api-client mesh-llm still advertises the
  // mesh's models on its local catalog while holding no stage, so a ready/running
  // runtime or an actual split-stage assignment must corroborate the claim.
  const serving = ((metrics?.readyModels?.length ?? 0) > 0 && (runtimeState === 'ready' || runtimeState === 'running'))
    || ((metrics?.stageCount ?? 0) > 0 && metrics?.apiReady === true && metrics?.consoleReady === true)
  if (serving) return 'Serving'
  if (runtimeState === 'downloading' || runtimeState === 'starting' || runtimeState === 'loading' || metrics?.apiReady === true || metrics?.consoleReady === true) return 'Preparing'
  return 'Disconnected'
}

function runtimeBinaryStatus(node: NodeRecord, desired: { readonly meshllm: string; readonly llamacpp: string }) {
  const metrics = node.metrics ?? { runtimeState: 'unknown', activeRequests: 0 }
  const runtime = (metrics.runtimeKind === 'llamacpp' || node.runtime === 'llamacpp') ? 'llamacpp' : 'meshllm'
  const desiredVersion = runtime === 'llamacpp' ? desired.llamacpp : desired.meshllm
  const installedVersion = runtime === 'llamacpp' ? metrics.llamacppVersion : metrics.meshllmVersion
  // An install failure is what the agent reports as dependency-missing (its installer
  // wraps every failure into that state). Startup stderr chatter on a runtime that has
  // not reported its version yet is not an install failure — that node stays pending.
  const failed = metrics.runtimeState === 'dependency-missing'
  const state = metrics.runtimeState === 'downloading'
    ? 'installing'
    : (failed ? 'failed' : (installedVersion ? 'installed' : 'pending'))
  return {
    runtime,
    desiredVersion,
    installedVersion: installedVersion ?? null,
    state,
    error: failed ? (metrics.lastError || metrics.runtimeDetail || null) : null
  }
}

function profileReadiness(profiles: readonly ModelProfile[], nodes: readonly NodeRecord[]): Array<{ profileId: string; version: number; ready: number; downloading: number; failed: number }> {
  return profiles.map((profile) => {
    // Readiness counts only same-group machines (REQ-SCH-006): a reassigned node
    // still self-reporting the profile id must not count toward another mesh.
    const matching = nodes.filter((node) => nodeMeshId(node) === profileMeshId(profile) && node.activeProfileIds.includes(profile.id))
    const readyNodes = matching.filter((node) => nodeReadyForProfile(node, profile))
    const ready = readyNodes.length
    const readyIds = new Set(readyNodes.map((node) => node.id))
    const downloading = matching.filter((node) => !readyIds.has(node.id) && (node.metrics?.runtimeState === 'downloading' || node.metrics?.runtimeState === 'starting')).length
    const failed = matching.filter((node) => {
      const state = node.metrics?.runtimeState
      return state === 'failed' || state === 'dependency-missing' || state === 'stopped'
    }).length
    return { profileId: profile.id, version: profile.version, ready, downloading, failed }
  })
}

function nodeReadyForProfile(node: NodeRecord, profile: ModelProfile): boolean {
  if (node.status !== 'online' || node.deactivated === true) return false
  const runtimeState = node.metrics?.runtimeState
  if (runtimeState === 'failed' || runtimeState === 'dependency-missing' || runtimeState === 'stopped') return false
  const hasModel = node.metrics?.readyModels?.includes(profile.upstreamModel) === true
  if (!hasModel) return false
  return node.metrics?.apiReady === true || runtimeState === 'ready' || runtimeState === 'running' || profile.runtime === 'meshllm'
}

async function handleSetupToken(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  const actor = await requireAdmin(request, deps, now)
  if (!actor) return json({ error: 'unauthorized' }, 401, requestId)
  const setupToken = generateBearerToken('setup')
  await deps.store.putToken(await createTokenRecord('setup', setupToken, now, undefined, now + SETUP_TOKEN_TTL_MS))
  await deps.store.appendAudit({ id: requestId, type: 'setup_token_created', at: now, actor, detail: {} })
  return json({ setupToken, expiresAt: now + SETUP_TOKEN_TTL_MS }, 201, requestId)
}

async function handleInstaller(request: Request, deps: RouterDeps, url: URL, requestId: string, now: number): Promise<Response> {
  const actor = await requireAdmin(request, deps, now)
  if (!actor) return json({ error: 'unauthorized' }, 401, requestId)
  const platform = url.pathname.split('/').at(-1) as InstallerPlatform
  if (!['linux', 'macos', 'windows'].includes(platform)) return json({ error: 'unknown_platform' }, 404, requestId)
  const domain = await deps.store.getConfig<StoredCustomDomain>('custom_domain')
  const workerUrl = domain?.status === 'provisioned' ? `https://${domain.hostname}` : publicWorkerOrigin(deps.env.WORKER_BASE_URL, request.url)
  // Do not mint on GET: viewing the command must not create an orphan setup token. The command
  // carries a placeholder; the operator mints once via "Create setup token" and the client fills it.
  const command = installerCommand({ platform, workerUrl, setupToken: SETUP_TOKEN_PLACEHOLDER, repository: deps.env.GITHUB_REPOSITORY ?? 'nikolanovoselec/codeflare-inference-mesh' })
  return new Response(command, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8', 'x-inference-mesh-request-id': requestId } })
}

function handleInstallScript(deps: RouterDeps, platform: InstallerPlatform): Response {
  const repository = deps.env.GITHUB_REPOSITORY ?? 'nikolanovoselec/codeflare-inference-mesh'
  const releaseTag = deps.env.AGENT_RELEASE_TAG ?? 'latest'
  const contentType = platform === 'windows' ? 'text/plain; charset=utf-8' : 'text/x-shellscript; charset=utf-8'
  return new Response(installScript({ platform, repository, releaseTag }), { status: 200, headers: { 'content-type': contentType } })
}

async function handleGatewaySync(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  const actor = await requireAdmin(request, deps, now)
  if (!actor) return json({ error: 'unauthorized' }, 401, requestId)
  return await syncGatewayForActor(request, deps, requestId, now, actor)
}

async function handleApiGatewaySync(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  const automation = await requireAutomation(request, deps, now)
  if (!automation) return json({ error: 'unauthorized' }, 401, requestId)
  return await syncGatewayForActor(request, deps, requestId, now, `automation:${automation.id}`)
}

async function syncGatewayForActor(request: Request, deps: RouterDeps, requestId: string, now: number, actor: string): Promise<Response> {
  const body = await readOptionalObject<Partial<GatewaySettings>>(request)
  const storedSettings = await deps.store.getConfig<Partial<GatewaySettings>>('cloudflare_gateway_settings')
  const customDomain = await deps.store.getConfig<StoredCustomDomain>('custom_domain')
  const settings = gatewaySettings({
    env: deps.env,
    ...(body ? { body } : {}),
    ...(storedSettings ? { stored: storedSettings } : {})
  })
  const bodyWorkerUrl = cleanString(body?.workerUrl)
  const storedWorkerUrl = cleanString(storedSettings?.workerUrl)
  const storedWorkerUrlOverride = storedWorkerUrl && storedWorkerUrl !== usableWorkerBaseUrl(deps.env.WORKER_BASE_URL) ? storedWorkerUrl : undefined
  const workerUrlOverride = bodyWorkerUrl ?? storedWorkerUrlOverride
  const customDomainUrl = customDomain?.status === 'provisioned' ? `https://${customDomain.hostname}` : undefined
  const workerUrl = workerUrlOverride ?? customDomainUrl
  const token = deps.env.CLOUDFLARE_API_TOKEN_RUNTIME
  if (customDomain?.hostname && customDomain.status !== 'provisioned' && !workerUrlOverride) return json({ error: 'custom_domain_not_provisioned', hostname: customDomain.hostname }, 409, requestId)
  if (!workerUrl) return json({ error: 'custom_domain_required' }, 409, requestId)
  if (!settings.accountId || !settings.gatewayId || (!token && !deps.cloudflareClient)) return json({ error: 'cloudflare_runtime_config_missing' }, 503, requestId)
  const client = deps.cloudflareClient ?? new CloudflareGatewayClient(token!)
  let result: GatewaySyncResult
  try {
    // Every non-default machine group gets its own dynamic route named by its stable
    // alias, so clients reach that mesh's active model through the same gateway (REQ-GWY-009).
    const extraRoutes = (await listMeshes(deps.store))
      .filter((mesh) => mesh.id !== 'default')
      .map((mesh) => ({ routeName: meshAliasFor(mesh.id), publicModel: meshAliasFor(mesh.id) }))
    result = await client.syncCustomProvider({
      accountId: settings.accountId,
      gatewayId: settings.gatewayId,
      workerUrl,
      providerName: settings.providerName,
      routeName: settings.routeName,
      publicModel: settings.publicModel,
      ...(extraRoutes.length > 0 ? { extraRoutes } : {}),
      providerTokenInstructions: 'Paste the router provider token into the AI Gateway provider key field.'
    })
  } catch (error) {
    // Cloudflare rejected the sync (bad token, missing gateway, route conflict). The raw
    // cause goes to the audit for support; the operator gets an actionable, sanitized message.
    // A 4xx keeps the client from collapsing it to the generic 5xx "temporary error, retry".
    const reason = error instanceof Error ? error.message : String(error)
    await deps.store.appendAudit({ id: requestId, type: 'gateway_sync_failed', at: now, actor, detail: { reason } })
    return json({ error: 'The AI Gateway sync could not be completed. Confirm the gateway exists and the router Cloudflare token has AI Gateway access, then re-sync.' }, 424, requestId)
  }
  await deps.store.putConfig('cloudflare_gateway_settings', {
    accountId: settings.accountId,
    gatewayId: settings.gatewayId,
    providerName: settings.providerName,
    routeName: settings.routeName,
    publicModel: settings.publicModel,
    ...(workerUrlOverride ? { workerUrl: workerUrlOverride } : {})
  })
  await deps.store.putConfig('cloudflare_gateway', result)
  // The provider key surfaces here, where the operator uses it: it authenticates
  // the AI Gateway custom provider (BYOK). Minting rotates it — a re-sync issues a
  // fresh key and retires prior ones so only the latest key is live.
  const providerToken = generateBearerToken('provider')
  const priorProviders = await deps.store.listTokens('provider')
  await Promise.all(priorProviders.filter((token) => token.active).map((token) => deps.store.revokeToken('provider', token.id, now)))
  await deps.store.putToken(await createTokenRecord('provider', providerToken, now))
  await deps.store.appendAudit({ id: requestId, type: 'gateway_sync', at: now, actor, detail: { ...result } })
  return json({ ...result, providerToken, byokInstruction: `Paste this key into the AI Gateway provider "${result.providerSlug}".` }, 200, requestId)
}

async function handleCustomDomain(request: Request, deps: RouterDeps, requestId: string, now: number, advance: boolean): Promise<Response> {
  const actor = await requireAdmin(request, deps, now)
  if (!actor) return json({ error: 'unauthorized' }, 401, requestId)
  const body = await readJson<{ hostname: string; zoneId?: string }>(request)
  const hostname = typeof body?.hostname === 'string' ? body.hostname.trim().toLowerCase() : ''
  const zoneId = typeof body?.zoneId === 'string' ? body.zoneId.trim() : ''
  const zoneValid = zoneId === '' || /^[a-f0-9]{32}$/i.test(zoneId)
  const valid = Boolean(hostname && validateCustomDomain(hostname) && zoneValid)
  if (!valid) return json({ valid: false, hostname: body?.hostname }, 400, requestId)
  const accountId = deps.env.CLOUDFLARE_ACCOUNT_ID ?? deps.env.AI_GATEWAY_ACCOUNT_ID
  const workerName = deps.env.WORKER_NAME ?? 'codeflare-inference-mesh-router'
  const workerUrl = publicWorkerOrigin(deps.env.WORKER_BASE_URL, request.url)
  const token = deps.env.CLOUDFLARE_API_TOKEN_RUNTIME
  if (!accountId || !workerUrl || (!token && !deps.cloudflareClient)) return json({ error: 'cloudflare_runtime_config_missing' }, 503, requestId)
  const client = deps.cloudflareClient ?? new CloudflareGatewayClient(token!)
  const provisioned = await client.provisionCustomDomain({ accountId, hostname, workerName, workerUrl, ...(zoneId ? { zoneId } : {}) }).catch((error: unknown) => {
    if (String(error).includes('DNS record conflict')) return undefined
    throw error
  })
  if (!provisioned) return json({ error: 'dns_record_conflict', hostname }, 409, requestId)
  await deps.store.putConfig('custom_domain', provisioned)
  if (advance) await advancePhase(deps.store, 'domain_ready')
  await deps.store.appendAudit({ id: requestId, type: 'custom_domain_provisioned', at: now, actor, target: hostname, detail: { ...provisioned } })
  return json({ valid: true, ...provisioned }, 200, requestId)
}

// handleNodeRevoke removes a machine outright: it revokes the node's credentials
// and mesh tokens (so a still-running agent is rejected on its next heartbeat and
// cannot rejoin) and then deletes the node row so the machine disappears from the
// console immediately. The node_revoked audit event preserves the record; a real
// re-enrollment mints a fresh row.
async function handleNodeRevoke(request: Request, deps: RouterDeps, url: URL, requestId: string, now: number): Promise<Response> {
  const actor = await requireAdmin(request, deps, now)
  if (!actor) return json({ error: 'unauthorized' }, 401, requestId)
  const nodeId = decodeURIComponent(url.pathname.split('/')[3] ?? '')
  // Neutralize the node first so a failure mid-sequence fails closed: revokeNode marks it
  // revoked and strips its verifier, and the heartbeat/unregister handlers reject a revoked
  // node with 403 before any token check (the status gate is the primary stop). Then revoke
  // tokens, clear mesh tokens, and delete the row so the node also disappears from the console.
  await deps.store.revokeNode(nodeId, now)
  const nodeTokens = await deps.store.listTokens('node')
  await Promise.all(nodeTokens.filter((token) => token.nodeId === nodeId && token.active).map((token) => deps.store.revokeToken('node', token.id, now)))
  await removeNodeMeshTokens(deps.store, deps.env, nodeId, now)
  await deps.store.deleteNode(nodeId)
  await deps.store.appendAudit({ id: requestId, type: 'node_revoked', at: now, actor, target: nodeId, detail: {} })
  return json({ ok: true }, 200, requestId)
}

// Deactivate/activate taint a node without decommissioning it: a deactivated node stays enrolled and
// keeps heartbeating but runs no model and is excluded from selection (REQ-ADM-030). Both are reversible,
// so neither is destructive; revoke remains the one-way decommission.
async function handleNodeDeactivate(request: Request, deps: RouterDeps, url: URL, requestId: string, now: number): Promise<Response> {
  const actor = await requireAdmin(request, deps, now)
  if (!actor) return json({ error: 'unauthorized' }, 401, requestId)
  return setNodeDeactivated(deps, decodeURIComponent(url.pathname.split('/')[3] ?? ''), true, actor, requestId, now)
}

async function handleNodeActivate(request: Request, deps: RouterDeps, url: URL, requestId: string, now: number): Promise<Response> {
  const actor = await requireAdmin(request, deps, now)
  if (!actor) return json({ error: 'unauthorized' }, 401, requestId)
  return setNodeDeactivated(deps, decodeURIComponent(url.pathname.split('/')[3] ?? ''), false, actor, requestId, now)
}

async function setNodeDeactivated(deps: RouterDeps, nodeId: string, deactivated: boolean, actor: string, requestId: string, now: number): Promise<Response> {
  const node = await deps.store.getNode(nodeId)
  if (!node || node.status === 'revoked') return json({ error: 'unknown_node', requestId }, 404, requestId)
  await deps.store.upsertNode({ ...node, deactivated })
  // Deactivation stops mesh-llm, so drop the node's now-dead invite token from every mesh; on
  // reactivation the node re-adds its token through heartbeats once mesh-llm relaunches.
  if (deactivated) await removeNodeMeshTokens(deps.store, deps.env, nodeId, now)
  await deps.store.appendAudit({ id: requestId, type: deactivated ? 'node_deactivated' : 'node_activated', at: now, actor, target: nodeId, detail: {} })
  return json({ ok: true, deactivated }, 200, requestId)
}

async function handleNodeReload(request: Request, deps: RouterDeps, url: URL, requestId: string, now: number): Promise<Response> {
  const actor = await requireAdmin(request, deps, now)
  if (!actor) return json({ error: 'unauthorized' }, 401, requestId)
  return requestNodeReload(deps, decodeURIComponent(url.pathname.split('/').at(-2) ?? ''), actor, requestId, now)
}

async function handleApiNodeReload(request: Request, deps: RouterDeps, url: URL, requestId: string, now: number): Promise<Response> {
  const automation = await requireAutomation(request, deps, now)
  if (!automation) return json({ error: 'unauthorized' }, 401, requestId)
  return requestNodeReload(deps, decodeURIComponent(url.pathname.split('/').at(-2) ?? ''), `automation:${automation.id}`, requestId, now)
}

// Force Reload stamps a one-shot nonce on the node. The node applies it once (draining and
// restarting mesh-llm) and echoes it back on the next heartbeat, when the router retires it. It is
// reversible (a stale nonce is harmless) and never decommissions the node. REQ-NODE-012.
async function requestNodeReload(deps: RouterDeps, nodeId: string, actor: string, requestId: string, now: number): Promise<Response> {
  const node = await deps.store.getNode(nodeId)
  if (!node || node.status === 'revoked') return json({ error: 'unknown_node', requestId }, 404, requestId)
  const reloadNonce = String(now)
  await deps.store.upsertNode({ ...node, reloadNonce })
  await deps.store.appendAudit({ id: requestId, type: 'node_reload_requested', at: now, actor, target: nodeId, detail: { reloadNonce } })
  return json({ ok: true, reloadNonce }, 200, requestId)
}

// handleNodeConfig updates operator-owned node settings from the admin console. The display name
// is stored in the node JSON row and preserved across future heartbeats; blank/`null` VRAM override
// reverts to the model default while a non-negative number caps this node.
async function handleNodeConfig(request: Request, deps: RouterDeps, url: URL, requestId: string, now: number): Promise<Response> {
  const actor = await requireAdmin(request, deps, now)
  if (!actor) return json({ error: 'unauthorized' }, 401, requestId)
  const nodeId = decodeURIComponent(url.pathname.split('/').at(-2) ?? '')
  const node = await deps.store.getNode(nodeId)
  if (!node || node.status === 'revoked') return json({ error: 'unknown_node', requestId }, 404, requestId)
  const body = await readJson<NodeConfigBody>(request)
  const result = await reconfigureNode(deps, node, body, actor, requestId, now)
  if (result instanceof Response) return result
  return json({ ok: true, id: nodeId, displayName: result.displayName, maxVramGbOverride: result.maxVramGbOverride ?? null, meshId: nodeMeshId(result) }, 200, requestId)
}

// Shared node-reconfigure core (admin console + automation twin). A mesh reassignment
// is validated against the registry, drops the node's invite tokens from its old mesh's
// profiles (its running process is foreign there now — the next heartbeat's mesh gate
// keeps the token from being re-added), and is audited with the from/to groups.
async function reconfigureNode(deps: RouterDeps, node: NodeRecord, body: NodeConfigBody | undefined, actor: string, requestId: string, now: number): Promise<NodeRecord | Response> {
  let updated = nodeWithConfig(node, body)
  if (updated === INVALID_MAX_VRAM) return json({ error: 'invalid_max_vram', requestId }, 400, requestId)
  if (updated === INVALID_NODE_NAME) return json({ error: 'invalid_display_name', requestId }, 400, requestId)
  const fromMesh = nodeMeshId(node)
  let meshChanged = false
  if (body?.meshId !== undefined) {
    if (typeof body.meshId !== 'string' || !(await listMeshes(deps.store)).some((mesh) => mesh.id === body.meshId)) {
      return json({ error: 'unknown_mesh', requestId }, 400, requestId)
    }
    if (body.meshId !== fromMesh) {
      updated = { ...updated, meshId: body.meshId }
      meshChanged = true
    }
  }
  await deps.store.upsertNode(updated)
  if (meshChanged) {
    await removeNodeMeshTokens(deps.store, deps.env, node.id, now)
    await deps.store.appendAudit({ id: crypto.randomUUID(), type: 'node_mesh_assigned', at: now, actor, target: node.id, detail: { from: fromMesh, to: nodeMeshId(updated) } })
  }
  await deps.store.appendAudit({ id: requestId, type: 'node_reconfigured', at: now, actor, target: node.id, detail: { displayName: updated.displayName, maxVramGbOverride: updated.maxVramGbOverride ?? null, meshId: nodeMeshId(updated) } })
  return updated
}

// Mesh management cores shared by the admin console and the automation API
// (REQ-ADM-037 / REQ-API-011). A mesh is an operator-named machine group; its
// active model answers meshAliasFor(id). Deletion requires an empty mesh and
// leaves any gateway dynamic route in place (it resolves to no-profile), so
// delete never depends on Cloudflare API availability.
async function meshListCore(deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  const [meshes, nodes, profiles] = await Promise.all([listMeshes(deps.store), deps.store.listNodes(now), deps.store.listProfiles()])
  return json({
    meshes: meshes.map((mesh) => ({
      ...meshSummary(mesh, nodes, profiles),
      ...(mesh.createdAt !== undefined ? { createdAt: mesh.createdAt } : {})
    }))
  }, 200, requestId)
}

function meshSummary(mesh: MeshRecord, nodes: readonly NodeRecord[], profiles: readonly ModelProfile[]): { id: string; name: string; alias: string; machineCount: number; modelCount: number } {
  return {
    id: mesh.id,
    name: mesh.name,
    alias: meshAliasFor(mesh.id),
    machineCount: nodes.filter((node) => nodeMeshId(node) === mesh.id).length,
    modelCount: profiles.filter((profile) => profileMeshId(profile) === mesh.id).length
  }
}

async function meshCreateCore(request: Request, deps: RouterDeps, actor: string, requestId: string, now: number): Promise<Response> {
  const body = await readJson<{ name?: unknown }>(request)
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  const validated = name ? validateMeshName(name) : undefined
  if (!validated) return json({ error: 'invalid_mesh_name', requestId }, 400, requestId)
  // Duplicate-name first: recreating an existing mesh (whose alias a profile
  // legitimately owns) must read as mesh_exists, not a phantom alias conflict.
  if ((await listMeshes(deps.store)).some((mesh) => mesh.id === validated.id)) return json({ error: 'mesh_exists', requestId }, 409, requestId)
  // A pre-existing callable name equal to the would-be mesh alias would give the
  // alias two owners the moment a model is activated in the new mesh.
  const profiles = await deps.store.listProfiles()
  if (profiles.some((profile) => profile.publicAliases.includes(meshAliasFor(validated.id)))) return json({ error: 'mesh_alias_conflict', requestId }, 409, requestId)
  const created = await createMesh(deps.store, name, now)
  if (!created) return json({ error: 'mesh_exists', requestId }, 409, requestId)
  await deps.store.appendAudit({ id: requestId, type: 'mesh_created', at: now, actor, target: created.id, detail: { name: created.name, alias: meshAliasFor(created.id) } })
  return json({ ok: true, mesh: { id: created.id, name: created.name, alias: meshAliasFor(created.id) } }, 201, requestId)
}

async function meshDeleteCore(deps: RouterDeps, meshId: string, actor: string, requestId: string, now: number): Promise<Response> {
  if (meshId === 'default') return json({ error: 'mesh_undeletable', requestId }, 400, requestId)
  const meshes = await listMeshes(deps.store)
  if (!meshes.some((mesh) => mesh.id === meshId)) return json({ error: 'unknown_mesh', requestId }, 404, requestId)
  const [nodes, profiles] = await Promise.all([deps.store.listNodes(now), deps.store.listProfiles()])
  if (nodes.some((node) => nodeMeshId(node) === meshId) || profiles.some((profile) => profileMeshId(profile) === meshId)) {
    return json({ error: 'mesh_not_empty', requestId }, 409, requestId)
  }
  await deleteMesh(deps.store, meshId)
  await deps.store.appendAudit({ id: requestId, type: 'mesh_deleted', at: now, actor, target: meshId, detail: { routeName: meshAliasFor(meshId) } })
  return json({ ok: true }, 200, requestId)
}

async function handleMeshList(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  if (!(await requireUser(request, deps, now))) return json({ error: 'unauthorized' }, 401, requestId)
  return meshListCore(deps, requestId, now)
}

async function handleMeshCreate(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  const actor = await requireAdmin(request, deps, now)
  if (!actor) return json({ error: 'unauthorized' }, 401, requestId)
  return meshCreateCore(request, deps, actor, requestId, now)
}

async function handleMeshDelete(request: Request, deps: RouterDeps, url: URL, requestId: string, now: number): Promise<Response> {
  const actor = await requireAdmin(request, deps, now)
  if (!actor) return json({ error: 'unauthorized' }, 401, requestId)
  return meshDeleteCore(deps, decodeURIComponent(url.pathname.split('/').at(-1) ?? ''), actor, requestId, now)
}

async function handleApiMeshList(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  if (!(await requireAutomation(request, deps, now))) return json({ error: 'unauthorized' }, 401, requestId)
  return meshListCore(deps, requestId, now)
}

async function handleApiMeshCreate(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  const automation = await requireAutomation(request, deps, now)
  if (!automation) return json({ error: 'unauthorized' }, 401, requestId)
  return meshCreateCore(request, deps, `automation:${automation.id}`, requestId, now)
}

async function handleApiMeshDelete(request: Request, deps: RouterDeps, url: URL, requestId: string, now: number): Promise<Response> {
  const automation = await requireAutomation(request, deps, now)
  if (!automation) return json({ error: 'unauthorized' }, 401, requestId)
  return meshDeleteCore(deps, decodeURIComponent(url.pathname.split('/').at(-1) ?? ''), `automation:${automation.id}`, requestId, now)
}

async function handleProfileRollout(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  const actor = await requireAdmin(request, deps, now)
  if (!actor) return json({ error: 'unauthorized' }, 401, requestId)
  const body = await readJson<{ profileId: string; rolloutPercent: number }>(request)
  if (!body || typeof body.profileId !== 'string' || typeof body.rolloutPercent !== 'number') return json({ error: 'invalid_rollout' }, 400, requestId)
  if (body.rolloutPercent > 0) {
    // Alias-exclusive invariant: rollout activation must never leave an alias with two active owners.
    const activation = singleActiveActivation(await deps.store.listProfiles(), body.profileId)
    for (const profile of activation?.deactivated ?? []) await deps.store.setProfile(profile)
  }
  await deps.store.setActiveProfile(body.profileId, body.rolloutPercent)
  await deps.store.appendAudit({ id: requestId, type: 'profile_rollout', at: now, actor, target: body.profileId, detail: { rolloutPercent: body.rolloutPercent } })
  return json({ ok: true }, 200, requestId)
}

async function handleProfileActivate(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  const actor = await requireAdmin(request, deps, now)
  if (!actor) return json({ error: 'unauthorized' }, 401, requestId)
  const body = await readJson<{ profileId?: string }>(request)
  if (!body || typeof body.profileId !== 'string') return json({ error: 'invalid_activation', requestId }, 400, requestId)
  const activation = singleActiveActivation(await deps.store.listProfiles(), body.profileId)
  if (!activation) return json({ error: 'unknown_profile', requestId }, 404, requestId)
  for (const profile of activation.deactivated) await deps.store.setProfile(profile)
  await deps.store.setProfile(activation.activated)
  const deactivatedIds = activation.deactivated.map((profile) => profile.id)
  await deps.store.appendAudit({ id: requestId, type: 'profile_activated', at: now, actor, target: body.profileId, detail: { deactivated: deactivatedIds } })
  return json({ ok: true, activated: activation.activated.id, deactivated: deactivatedIds }, 200, requestId)
}

// A per-model VRAM budget in GB (0 = no cap; the node agent renders --max-vram
// only for a positive value). Returns undefined when the caller omits the field
// (leave the current setting), or INVALID_MAX_VRAM when it is present but not a
// finite number >= 0. Shared by the admin and automation model-config endpoints.
async function handleProfileConfig(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  const actor = await requireAdmin(request, deps, now)
  if (!actor) return json({ error: 'unauthorized' }, 401, requestId)
  const body = await readJson<ModelConfigBody>(request)
  if (!body || typeof body.profileId !== 'string') return json({ error: 'invalid_profile_config', requestId }, 400, requestId)
  const profiles = await deps.store.listProfiles()
  const found = profiles.find((profile) => profile.id === body.profileId)
  if (!found) return json({ error: 'unknown_profile', requestId }, 404, requestId)
  const reassignment = await resolveMeshReassignment(deps, found, body.meshId)
  if ('error' in reassignment) return json({ error: reassignment.error, requestId }, 400, requestId)
  const existing = reassignment.profile
  const runtime = resolveRuntime(body.runtime)
  if (runtime === 'invalid_runtime') return json({ error: 'invalid_runtime', requestId }, 400, requestId)
  if (body.llamacpp !== undefined && runtime !== 'llamacpp' && existing.runtime !== 'llamacpp') return json({ error: 'invalid_model_config', requestId }, 400, requestId)
  if (runtime === 'llamacpp' || existing.runtime === 'llamacpp') {
    const direct = configureLlamaCppProfile(existing, profiles, body)
    if ('error' in direct) return json({ error: direct.error, requestId }, direct.status, requestId)
    await deps.store.setProfile(direct.profile)
    if (reassignment.change) await deps.store.appendAudit({ id: crypto.randomUUID(), type: 'model_mesh_assigned', at: now, actor, target: direct.profile.id, detail: { ...reassignment.change } })
    await deps.store.appendAudit({ id: requestId, type: 'profile_configured', at: now, actor, target: direct.profile.id, detail: { contextWindow: direct.settings.contextWindow, modelRef: direct.settings.modelRef, runtime: 'llamacpp' } })
    return json({ ok: true, profileId: direct.profile.id, contextWindow: direct.settings.contextWindow, modelRef: direct.settings.modelRef, displayName: direct.profile.displayName, callableNames: direct.profile.publicAliases, runtime: 'llamacpp', model: toApiModel(direct.profile) }, 200, requestId)
  }
  const contextWindow = body.contextWindow ?? existing.contextWindow
  if (!Number.isInteger(contextWindow) || contextWindow < 0) return json({ error: 'invalid_context_window', requestId }, 400, requestId)
  const maxVram = resolveMaxVram(body.maxVramGb)
  if (maxVram === INVALID_MAX_VRAM) return json({ error: 'invalid_max_vram', requestId }, 400, requestId)
  if (existing.runtime !== 'meshllm' || !existing.meshllm) return json({ error: 'invalid_model_config', requestId }, 400, requestId)
  let meshllm = existing.meshllm
  let upstreamModel = existing.upstreamModel
  if (body.modelRef !== undefined) {
    const modelRef = typeof body.modelRef === 'string' ? body.modelRef.trim() : ''
    if (!modelRef) return json({ error: 'invalid_model_ref', requestId }, 400, requestId)
    meshllm = { ...meshllm, modelRef }
    upstreamModel = modelRef
  }
  if (maxVram !== undefined) meshllm = { ...meshllm, maxVramGb: maxVram }
  const tunables = resolveMeshllmTunables(meshllm, body)
  if ('error' in tunables) return json({ error: tunables.error, requestId }, 400, requestId)
  meshllm = tunables.meshllm
  // Optional rename. The display name is the human label shown in the console; the
  // call name is this model's own public alias, kept alongside the shared
  // codeflare-mesh alias. A call name must slugify to a non-empty token, cannot be
  // the reserved shared alias, and cannot collide with another model's alias.
  let displayName = existing.displayName
  if (body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) return json({ error: 'invalid_display_name', requestId }, 400, requestId)
    displayName = name
  }
  let publicAliases = existing.publicAliases
  if (body.callName !== undefined) {
    const resolved = resolveCallNameAliases(existing, body.callName, profiles)
    if (!Array.isArray(resolved)) return json({ error: (resolved as { error: string }).error, requestId }, (resolved as { status: number }).status, requestId)
    publicAliases = resolved
  }
  // Bump the version so a stored row edited by an operator is never mistaken for a
  // shipped default row by any future seeding logic.
  const updated: ModelProfile = { ...existing, contextWindow, upstreamModel, meshllm, displayName, publicAliases, version: existing.version + 1 }
  await deps.store.setProfile(updated)
  if (reassignment.change) await deps.store.appendAudit({ id: crypto.randomUUID(), type: 'model_mesh_assigned', at: now, actor, target: updated.id, detail: { ...reassignment.change } })
  await deps.store.appendAudit({ id: requestId, type: 'profile_configured', at: now, actor, target: updated.id, detail: { contextWindow, modelRef: meshllm.modelRef, maxVramGb: meshllm.maxVramGb ?? 0 } })
  return json({ ok: true, profileId: updated.id, contextWindow, modelRef: meshllm.modelRef, maxVramGb: meshllm.maxVramGb ?? 0, displayName: updated.displayName, callableNames: updated.publicAliases, meshId: profileMeshId(updated) }, 200, requestId)
}

// handleProfileAdd creates a new inactive model profile from an operator-supplied
// model reference, serving mode, and runtime, so a model beyond the seeded set joins
// the catalog for rollout and activation without redeploying the Worker. The reference
// is trimmed and must be non-empty; mode "split" builds a MeshLLM layer-package profile,
// while direct llama.cpp is allowed only for single-machine profiles. A reference whose
// derived id collides with an existing profile is refused rather than overwriting it.
async function handleProfileAdd(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  const actor = await requireAdmin(request, deps, now)
  if (!actor) return json({ error: 'unauthorized' }, 401, requestId)
  const body = await readJson<{ modelRef?: string; mode?: string; runtime?: unknown; name?: string; meshId?: unknown }>(request)
  const modelRef = typeof body?.modelRef === 'string' ? body.modelRef.trim() : ''
  if (!modelRef) return json({ error: 'invalid_model_ref', requestId }, 400, requestId)
  const split = body?.mode === 'split'
  const runtime = resolveRuntime(body?.runtime)
  if (runtime === 'invalid_runtime') return json({ error: 'invalid_runtime', requestId }, 400, requestId)
  if (split && runtime === 'llamacpp') return json({ error: 'split_requires_meshllm', requestId }, 400, requestId)
  const meshId = await resolveOnboardingMesh(deps, body?.meshId)
  if (meshId === undefined) return json({ error: 'unknown_mesh', requestId }, 400, requestId)
  const name = typeof body?.name === 'string' ? body.name : undefined
  const existing = await deps.store.listProfiles()
  const profile = buildCustomProfile({ modelRef, split, existing, name, runtime, meshId })
  // A quant tag that resolves no Hugging Face file (trailing dot, whitespace) is
  // refused before it can cost an outage; the node would only fail at load time.
  if (runtime === 'llamacpp') {
    const quantError = llamaCppQuantError(profile.llamacpp?.quant)
    if (quantError) return json({ error: quantError, requestId }, 400, requestId)
  }
  if (existing.some((candidate) => candidate.id === profile.id)) return json({ error: 'duplicate_profile', profileId: profile.id, requestId }, 409, requestId)
  await deps.store.setProfile(profile)
  await deps.store.appendAudit({ id: requestId, type: 'profile_added', at: now, actor, target: profile.id, detail: { modelRef, split, runtime, meshId } })
  return json({ ok: true, profileId: profile.id, displayName: profile.displayName, split, runtime, model: toApiModel(profile) }, 201, requestId)
}

// Resolves an optional onboarding mesh: absent means the default mesh; a present
// value must name an existing mesh (undefined result = unknown_mesh).
async function resolveOnboardingMesh(deps: RouterDeps, rawMeshId: unknown): Promise<string | undefined> {
  if (rawMeshId === undefined || rawMeshId === null || rawMeshId === '') return 'default'
  if (typeof rawMeshId !== 'string') return undefined
  return (await listMeshes(deps.store)).some((mesh) => mesh.id === rawMeshId) ? rawMeshId : undefined
}

async function handleAdminMeshRotate(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  const actor = await requireAdmin(request, deps, now)
  if (!actor) return json({ error: 'unauthorized' }, 401, requestId)
  return await handleMeshRotate(request, deps.store, deps.env, now, actor)
}

async function handleAdminAgentVersions(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  const actor = await requireAdmin(request, deps, now)
  if (!actor) return json({ error: 'unauthorized' }, 401, requestId)
  return await handleAgentVersionsList(request, deps.store, deps.env, deps.releasesFetcher)
}

async function handleAdminAgentVersionSelect(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  const actor = await requireAdmin(request, deps, now)
  if (!actor) return json({ error: 'unauthorized' }, 401, requestId)
  return await handleAgentVersionSelect(request, deps.store, deps.env, deps.releasesFetcher ?? globalThis.fetch, actor)
}

async function handleAdminRuntimeVersions(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  const actor = await requireAdmin(request, deps, now)
  if (!actor) return json({ error: 'unauthorized' }, 401, requestId)
  return await handleRuntimeVersionsList(request, deps.store, deps.releasesFetcher ?? globalThis.fetch, deps.env)
}

async function handleAdminRuntimeVersionSelect(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  const actor = await requireAdmin(request, deps, now)
  if (!actor) return json({ error: 'unauthorized' }, 401, requestId)
  return await handleRuntimeVersionsSelect(request, deps.store, deps.releasesFetcher ?? globalThis.fetch, actor, deps.env)
}

/** REQ-ADM-017: lets the console render the admin vs read-only user surface. */
async function handleWhoami(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  const viewer = await requireUser(request, deps, now)
  if (!viewer) return json({ error: 'unauthorized' }, 401, requestId)
  return json({ role: viewer.role, actor: viewer.actor }, 200, requestId)
}

/**
 * REQ-ADM-029: Playground "gateway" target — console proxy to the *selected* AI Gateway.
 * Forwards the chosen route as `dynamic/<route>` to that gateway's compat endpoint so an
 * operator can exercise any accessible gateway and any route on it (including hand-made
 * non-`codeflare-mesh` routes, not just the last sync), and streams the response back behind
 * fresh headers so no upstream gateway header reaches the browser.
 */
async function handlePlaygroundChat(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  const viewer = await requireUser(request, deps, now)
  if (!viewer) return json({ error: 'unauthorized' }, 401, requestId)
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
  const isAdmin = viewer.role === 'admin'
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
async function handlePlaygroundDirect(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  const viewer = await requireUser(request, deps, now)
  if (!viewer) return json({ error: 'unauthorized' }, 401, requestId)
  const body = await readOptionalObject<{ model?: unknown; user?: unknown; messages?: unknown; tools?: unknown; maxTokens?: unknown }>(request)
  const model = cleanString(body?.model)
  if (!model) return json({ error: 'model_required', requestId }, 400, requestId)
  const user = cleanString(body?.user)
  const messages = Array.isArray(body?.messages) ? body!.messages : []
  const tools = playgroundTools(body?.tools)
  const maxTokens = playgroundMaxTokens(body?.maxTokens)
  return runInference(deps, { body: { model, ...(user ? { user } : {}), messages, stream: true, ...(tools ? { tools } : {}), ...(maxTokens ? { max_tokens: maxTokens } : {}) }, requestHeaders: request.headers, requestId, now })
}

async function handlePlaygroundSpeedTest(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  const viewer = await requireUser(request, deps, now)
  if (!viewer) return json({ error: 'unauthorized' }, 401, requestId)
  const body = await readOptionalObject<SpeedTestBody>(request)
  // A read-only viewer gets its own measurement back but does not overwrite the stored
  // per-profile record the whole console reads.
  return await runSpeedTest(deps, body, request.headers, requestId, now, viewer.role === 'admin')
}

async function handleApiSpeedTest(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  if (!(await requireAutomation(request, deps, now))) return json({ error: 'unauthorized' }, 401, requestId)
  const body = await readOptionalObject<SpeedTestBody>(request)
  return await runSpeedTest(deps, body, request.headers, requestId, now, true)
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

interface GatewaySettings {
  readonly accountId: string
  readonly gatewayId: string
  readonly providerName: string
  readonly routeName: string
  readonly publicModel: string
  readonly workerUrl?: string
}

function gatewaySettings(input: { env: Partial<RouterEnv>; body?: Partial<GatewaySettings>; stored?: Partial<GatewaySettings> }): GatewaySettings {
  const source = { ...input.stored, ...input.body }
  return {
    accountId: cleanString(source.accountId) ?? input.env.CLOUDFLARE_ACCOUNT_ID ?? input.env.AI_GATEWAY_ACCOUNT_ID ?? '',
    gatewayId: cleanString(source.gatewayId) ?? input.env.AI_GATEWAY_ID ?? 'inference-mesh',
    providerName: cleanString(source.providerName) ?? input.env.AI_GATEWAY_PROVIDER_NAME ?? 'Codeflare Inference Mesh',
    // The route name and forwarded model are pinned to the one stable public model:
    // switching the underlying active model never touches the Gateway route or model.
    routeName: STABLE_PUBLIC_MODEL,
    publicModel: STABLE_PUBLIC_MODEL,
    ...(cleanString(source.workerUrl) ? { workerUrl: cleanString(source.workerUrl)! } : {})
  }
}


/**
 * Linear email-shape check (no regex backtracking): rejects whitespace, requires
 * exactly one '@' not in first position, and a dotted domain with characters on
 * both sides of the dot. Replaces an ambiguous regex flagged as polynomial ReDoS.
 */
function isEmailLike(value: string): boolean {
  if (/\s/.test(value)) return false
  const at = value.indexOf('@')
  if (at <= 0 || at !== value.lastIndexOf('@')) return false
  const domain = value.slice(at + 1)
  const dot = domain.indexOf('.')
  return dot > 0 && dot < domain.length - 1
}

function normalizeEmailList(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === 'string').map((item) => item.trim().toLowerCase()).filter(isEmailLike))]
    : []
}

function normalizeGroupList(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter((item) => item.length > 0))]
    : []
}

function publicWorkerOrigin(configuredUrl: string | undefined, requestUrl: string): string {
  return usableWorkerBaseUrl(configuredUrl) ?? new URL(requestUrl).origin
}

function usableWorkerBaseUrl(value: string | undefined): string | undefined {
  const cleaned = cleanString(value)
  if (!cleaned || cleaned.includes('<your-subdomain>')) return undefined
  return cleaned
}












async function getOrCreateUpstreamToken(deps: RouterDeps): Promise<string> {
  const existing = await resolveUpstreamToken(deps)
  if (existing) return existing
  const token = generateBearerToken('upstream')
  await deps.store.putConfig('node_upstream_token', token)
  return token
}

async function handleSetupAccess(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  const actor = await requireAdmin(request, deps, now)
  if (!actor) return json({ error: 'unauthorized' }, 401, requestId)
  const body = await readJson<{ adminEmails?: unknown; adminGroups?: unknown; userEmails?: unknown; userGroups?: unknown; emails?: unknown }>(request)
  const adminEmails = normalizeEmailList(body?.adminEmails ?? body?.emails)
  const adminGroups = normalizeGroupList(body?.adminGroups)
  const userEmails = normalizeEmailList(body?.userEmails)
  const userGroups = normalizeGroupList(body?.userGroups)
  if (adminEmails.length === 0 && adminGroups.length === 0) return json({ error: 'admin_required', requestId }, 400, requestId)
  const domain = await deps.store.getConfig<StoredCustomDomain>('custom_domain')
  if (domain?.status !== 'provisioned') return json({ error: 'custom_domain_required', requestId }, 409, requestId)
  const accountId = deps.env.CLOUDFLARE_ACCOUNT_ID ?? deps.env.AI_GATEWAY_ACCOUNT_ID
  const workerName = deps.env.WORKER_NAME ?? 'codeflare-inference-mesh-router'
  const token = deps.env.CLOUDFLARE_API_TOKEN_RUNTIME
  if (!accountId || (!token && !deps.accessClient)) return json({ error: 'cloudflare_runtime_config_missing' }, 503, requestId)
  const client = deps.accessClient ?? new CloudflareAccessClient(token!)
  const result = await client.provisionAccess({ accountId, hostname: domain.hostname, workerName, adminEmails, adminGroups, userEmails, userGroups })
  await deps.store.putConfig(ACCESS_CONFIG_KEY, result)
  // Advancing only pre-completion keeps day-two role edits from resetting the phase.
  if ((await setupPhase(deps.store)) !== 'complete') await advancePhase(deps.store, 'access_ready')
  await deps.store.appendAudit({ id: requestId, type: 'access_provisioned', at: now, actor, target: domain.hostname, detail: { adminEmails, adminGroups, userEmails, userGroups, usersOpen: result.usersOpen, appId: result.appId, bypassAppId: result.bypassAppId } })
  return json({ ok: true, teamDomain: result.teamDomain, hostname: domain.hostname, consoleUrl: `https://${domain.hostname}/admin`, usersOpen: result.usersOpen }, 200, requestId)
}

async function handleSetupComplete(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  const actor = await requireAdmin(request, deps, now)
  if (!actor) return json({ error: 'unauthorized' }, 401, requestId)
  const phase = await setupPhase(deps.store)
  if (phase !== 'access_ready' && phase !== 'complete') return json({ error: 'setup_incomplete', phase, requestId }, 409, requestId)
  await advancePhase(deps.store, 'complete', { completedAt: now })
  if (deps.env.SETUP_REOPEN && await breakGlassActive(deps.store, deps.env)) {
    await deps.store.putConfig(SETUP_REOPEN_CONSUMED_KEY, await hashToken(deps.env.SETUP_REOPEN))
    await deps.store.appendAudit({ id: requestId, type: 'break_glass_completed', at: now, actor, detail: {} })
  }
  await deps.store.appendAudit({ id: requestId, type: 'setup_completed', at: now, actor, detail: {} })
  const domain = await deps.store.getConfig<StoredCustomDomain>('custom_domain')
  return json({ ok: true, ...(domain?.hostname ? { customDomain: domain.hostname } : {}) }, 200, requestId)
}

async function handleZones(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  const actor = await requireAdmin(request, deps, now)
  if (!actor) return json({ error: 'unauthorized' }, 401, requestId)
  const accountId = deps.env.CLOUDFLARE_ACCOUNT_ID ?? deps.env.AI_GATEWAY_ACCOUNT_ID
  const token = deps.env.CLOUDFLARE_API_TOKEN_RUNTIME
  if (!accountId || (!token && !deps.cloudflareClient?.listZones)) return json({ error: 'cloudflare_runtime_config_missing' }, 503, requestId)
  const client = deps.cloudflareClient ?? new CloudflareGatewayClient(token!)
  if (!client.listZones) return json({ error: 'cloudflare_runtime_config_missing' }, 503, requestId)
  return json({ zones: await client.listZones(accountId) }, 200, requestId)
}

async function handleGatewayOptions(request: Request, deps: RouterDeps, url: URL, requestId: string, now: number): Promise<Response> {
  const actor = await requireAdmin(request, deps, now)
  if (!actor) return json({ error: 'unauthorized' }, 401, requestId)
  const storedSettings = await deps.store.getConfig<Partial<GatewaySettings>>('cloudflare_gateway_settings')
  const defaults = gatewaySettings({ env: deps.env, ...(storedSettings ? { stored: storedSettings } : {}) })
  const accountId = defaults.accountId
  const token = deps.env.CLOUDFLARE_API_TOKEN_RUNTIME
  if (!accountId || (!token && !deps.cloudflareClient?.listGateways)) return json({ error: 'cloudflare_runtime_config_missing' }, 503, requestId)
  const client = deps.cloudflareClient ?? new CloudflareGatewayClient(token!)
  if (!client.listGateways || !client.listRoutes) return json({ error: 'cloudflare_runtime_config_missing' }, 503, requestId)
  const gateways = await client.listGateways(accountId)
  const selectedGateway = cleanString(url.searchParams.get('gateway')) ?? defaults.gatewayId
  const routes = gateways.some((gateway) => gateway.id === selectedGateway) ? await client.listRoutes(accountId, selectedGateway) : []
  return json({ gateways, routes, defaults }, 200, requestId)
}

// Live-verify whether the *selected* gateway carries the mesh route + canonical provider,
// so the Routing chip reflects that gateway's true state rather than the last-synced one.
async function handleGatewayProvisionStatus(request: Request, deps: RouterDeps, url: URL, requestId: string, now: number): Promise<Response> {
  const actor = await requireAdmin(request, deps, now)
  if (!actor) return json({ error: 'unauthorized' }, 401, requestId)
  const storedSettings = await deps.store.getConfig<Partial<GatewaySettings>>('cloudflare_gateway_settings')
  const defaults = gatewaySettings({ env: deps.env, ...(storedSettings ? { stored: storedSettings } : {}) })
  const accountId = defaults.accountId
  const gatewayId = cleanString(url.searchParams.get('gateway')) ?? defaults.gatewayId
  const token = deps.env.CLOUDFLARE_API_TOKEN_RUNTIME
  if (!accountId || (!token && !deps.cloudflareClient?.provisionStatus)) return json({ error: 'cloudflare_runtime_config_missing' }, 503, requestId)
  const client = deps.cloudflareClient ?? new CloudflareGatewayClient(token!)
  if (!client.provisionStatus) return json({ error: 'cloudflare_runtime_config_missing' }, 503, requestId)
  const status = await client.provisionStatus(accountId, gatewayId, defaults.routeName, defaults.providerName)
  return json({ gatewayId, ...status }, 200, requestId)
}

async function handleApiKeyCreate(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  const actor = await requireKeyAdmin(request, deps, now)
  if (!actor) return json({ error: 'unauthorized' }, 401, requestId)
  const token = generateBearerToken('automation')
  const record = await createTokenRecord('automation', token, now)
  await deps.store.putToken(record)
  await deps.store.appendAudit({ id: requestId, type: 'automation_key_created', at: now, actor, detail: { keyId: record.id } })
  return json({ id: record.id, token, createdAt: record.createdAt }, 201, requestId)
}

async function handleApiKeyList(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  const actor = await requireKeyAdmin(request, deps, now)
  if (!actor) return json({ error: 'unauthorized' }, 401, requestId)
  const keys = (await deps.store.listTokens('automation'))
    .filter((token) => token.active)
    .map((token) => ({ id: token.id, createdAt: token.createdAt }))
  return json({ keys }, 200, requestId)
}

async function handleApiKeyRevoke(request: Request, deps: RouterDeps, url: URL, requestId: string, now: number): Promise<Response> {
  const actor = await requireKeyAdmin(request, deps, now)
  if (!actor) return json({ error: 'unauthorized' }, 401, requestId)
  const keyId = decodeURIComponent(url.pathname.split('/').pop() ?? '')
  const existing = await deps.store.getToken('automation', keyId)
  if (!existing) return json({ error: 'not_found', requestId }, 404, requestId)
  await deps.store.revokeToken('automation', keyId, now)
  await deps.store.appendAudit({ id: requestId, type: 'automation_key_revoked', at: now, actor, detail: { keyId } })
  return json({ ok: true, id: keyId }, 200, requestId)
}

// handleApiKeyRotate retires a key and issues a fresh secret in one step so the previous
// secret stops authenticating immediately; the new secret is returned exactly once.
async function handleApiKeyRotate(request: Request, deps: RouterDeps, url: URL, requestId: string, now: number): Promise<Response> {
  const actor = await requireKeyAdmin(request, deps, now)
  if (!actor) return json({ error: 'unauthorized' }, 401, requestId)
  const keyId = decodeURIComponent(url.pathname.split('/').at(-2) ?? '')
  const existing = await deps.store.getToken('automation', keyId)
  if (!existing) return json({ error: 'not_found', requestId }, 404, requestId)
  await deps.store.revokeToken('automation', keyId, now)
  const token = generateBearerToken('automation')
  const record = await createTokenRecord('automation', token, now)
  await deps.store.putToken(record)
  await deps.store.appendAudit({ id: requestId, type: 'automation_key_rotated', at: now, actor, detail: { previousKeyId: keyId, keyId: record.id } })
  return json({ id: record.id, token, createdAt: record.createdAt, rotatedFrom: keyId }, 201, requestId)
}

async function handleApiStatus(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  if (!(await requireAutomation(request, deps, now))) return json({ error: 'unauthorized' }, 401, requestId)
  const url = new URL(request.url)
  const detailed = url.searchParams.get('detail') === 'full' || url.searchParams.get('include') === 'details'
  const nodes = await deps.store.listNodes(now)
  const profiles = await deps.store.listProfiles()
  const desiredVersion = await desiredAgentVersion(deps.store)
  const runtimeVersions = await desiredRuntimeVersions(deps.store)
  const lastSpeedTests = await storedSpeedTests(deps.store)
  const lastSpeedTest = newestSpeedTest(lastSpeedTests)
  const runtimeInstalls = nodes.map((node) => ({ nodeId: node.id, ...runtimeBinaryStatus(node, runtimeVersions) }))
  return json({
    generatedAt: now,
    nodes: { total: nodes.length, online: nodes.filter((node) => node.status === 'online').length },
    models: { total: profiles.length, active: profiles.filter((profile) => profile.active).length },
    runtimeVersions,
    ...(lastSpeedTest ? { lastSpeedTest, lastSpeedTests } : {}),
    runtimeInstalls,
    ...(detailed ? {
      details: {
        nodes: nodes.map((node) => toApiNode(node, runtimeVersions)),
        profiles: profiles.map(toApiModel),
        profileReadiness: profileReadiness(profiles, nodes),
        meshHealth: await meshHealth(deps.store, deps.env, profiles, nodes, now)
      }
    } : {}),
    ...(desiredVersion !== undefined ? { agentVersion: desiredVersion } : {})
  }, 200, requestId)
}

/** Mint a setup (enrollment) token programmatically. Accepts an automation key or an admin credential. */
async function handleApiEnrollmentToken(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  const automation = await requireAutomation(request, deps, now)
  const adminActor = automation ? undefined : await requireAdmin(request, deps, now)
  if (!automation && !adminActor) return json({ error: 'unauthorized' }, 401, requestId)
  const actor = automation ? `automation:${automation.id}` : adminActor!
  const setupToken = generateBearerToken('setup')
  await deps.store.putToken(await createTokenRecord('setup', setupToken, now, undefined, now + SETUP_TOKEN_TTL_MS))
  await deps.store.appendAudit({ id: requestId, type: 'setup_token_created', at: now, actor, detail: {} })
  return json({ setupToken, expiresAt: now + SETUP_TOKEN_TTL_MS }, 201, requestId)
}

/** Machine-facing node projection: identity, state, and metrics — never token verifiers or internal ports. */
function toApiNode(node: NodeRecord, runtimeVersions?: { readonly meshllm: string; readonly llamacpp: string }) {
  return {
    id: node.id,
    displayName: node.displayName,
    status: node.status,
    displayStatus: nodeDisplayStatus(node),
    meshIp: node.meshIp,
    publicModels: node.publicModels,
    activeProfileIds: node.activeProfileIds,
    capacity: node.capacity,
    inFlight: node.inFlight,
    lastSeenAt: node.lastSeenAt,
    runtime: node.runtime,
    ...(node.runtimeModel !== undefined ? { runtimeModel: node.runtimeModel } : {}),
    ...(node.agentVersion !== undefined ? { agentVersion: node.agentVersion } : {}),
    ...(node.metrics !== undefined ? { metrics: node.metrics } : {}),
    ...(runtimeVersions !== undefined ? { runtimeInstall: runtimeBinaryStatus(node, runtimeVersions) } : {}),
    maxVramGbOverride: node.maxVramGbOverride ?? null,
    meshId: nodeMeshId(node),
    deactivated: node.deactivated === true
  }
}

async function handleApiNodeList(request: Request, deps: RouterDeps, url: URL, requestId: string, now: number): Promise<Response> {
  if (!(await requireAutomation(request, deps, now))) return json({ error: 'unauthorized' }, 401, requestId)
  const statusFilter = url.searchParams.get('status') ?? undefined
  const query = (url.searchParams.get('q') ?? '').trim().toLowerCase()
  const limitParam = Number(url.searchParams.get('limit') ?? '100')
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(Math.floor(limitParam), 1000) : 100
  const cursor = url.searchParams.get('cursor') ?? ''
  let nodes = [...await deps.store.listNodes(now)].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  if (statusFilter) nodes = nodes.filter((node) => node.status === statusFilter)
  if (query.length > 0) nodes = nodes.filter((node) => node.id.toLowerCase().includes(query) || node.displayName.toLowerCase().includes(query))
  if (cursor) nodes = nodes.filter((node) => node.id > cursor)
  const page = nodes.slice(0, limit)
  const nextCursor = nodes.length > limit ? page[page.length - 1]!.id : null
  const runtimeVersions = await desiredRuntimeVersions(deps.store)
  return json({ nodes: page.map((node) => toApiNode(node, runtimeVersions)), nextCursor }, 200, requestId)
}

async function handleApiNodeGet(request: Request, deps: RouterDeps, url: URL, requestId: string, now: number): Promise<Response> {
  if (!(await requireAutomation(request, deps, now))) return json({ error: 'unauthorized' }, 401, requestId)
  const nodeId = decodeURIComponent(url.pathname.split('/')[4] ?? '')
  const node = (await deps.store.listNodes(now)).find((candidate) => candidate.id === nodeId)
  if (!node) return json({ error: 'not_found', requestId }, 404, requestId)
  return json({ node: toApiNode(node, await desiredRuntimeVersions(deps.store)) }, 200, requestId)
}

/** Decommission a node: revoke it and its node/mesh tokens so it must re-enroll. */
// handleApiNodeReconfigure updates a node's operator-owned settings for an automation caller,
// mirroring the admin console control so MDM/fleet tooling can rename or cap weaker nodes.
async function handleApiNodeReconfigure(request: Request, deps: RouterDeps, url: URL, requestId: string, now: number): Promise<Response> {
  const automation = await requireAutomation(request, deps, now)
  if (!automation) return json({ error: 'unauthorized' }, 401, requestId)
  const nodeId = decodeURIComponent(url.pathname.split('/').at(-2) ?? '')
  const node = await deps.store.getNode(nodeId)
  if (!node || node.status === 'revoked') return json({ error: 'unknown_node', requestId }, 404, requestId)
  const body = await readJson<NodeConfigBody>(request)
  const result = await reconfigureNode(deps, node, body, `automation:${automation.id}`, requestId, now)
  if (result instanceof Response) return result
  return json({ ok: true, node: toApiNode(result, await desiredRuntimeVersions(deps.store)) }, 200, requestId)
}

async function handleApiNodeDecommission(request: Request, deps: RouterDeps, url: URL, requestId: string, now: number): Promise<Response> {
  const automation = await requireAutomation(request, deps, now)
  if (!automation) return json({ error: 'unauthorized' }, 401, requestId)
  const nodeId = decodeURIComponent(url.pathname.split('/')[4] ?? '')
  // getNode (not listNodes) so decommission can still reach — and reap — a node whose row is
  // already a revoked tombstone: listNodes now hides revoked nodes, but the delete must remain
  // reachable so a lingering tombstone from a mid-revoke failure can be cleaned up idempotently.
  const node = await deps.store.getNode(nodeId)
  if (!node) return json({ error: 'not_found', requestId }, 404, requestId)
  // Neutralize the credential first (fail-closed), then revoke tokens, clear mesh tokens,
  // and delete the node record so it also disappears from the fleet.
  await deps.store.revokeNode(nodeId, now)
  const nodeTokens = await deps.store.listTokens('node')
  await Promise.all(nodeTokens.filter((token) => token.nodeId === nodeId && token.active).map((token) => deps.store.revokeToken('node', token.id, now)))
  await removeNodeMeshTokens(deps.store, deps.env, nodeId, now)
  await deps.store.deleteNode(nodeId)
  await deps.store.appendAudit({ id: requestId, type: 'node_revoked', at: now, actor: `automation:${automation.id}`, target: nodeId, detail: {} })
  return json({ ok: true, id: nodeId }, 200, requestId)
}

// Automation twins of the console deactivate/activate: taint or clear a node's taint via the API.
async function handleApiNodeDeactivate(request: Request, deps: RouterDeps, url: URL, requestId: string, now: number): Promise<Response> {
  return apiSetNodeDeactivated(request, deps, url, true, requestId, now)
}

async function handleApiNodeActivate(request: Request, deps: RouterDeps, url: URL, requestId: string, now: number): Promise<Response> {
  return apiSetNodeDeactivated(request, deps, url, false, requestId, now)
}

async function apiSetNodeDeactivated(request: Request, deps: RouterDeps, url: URL, deactivated: boolean, requestId: string, now: number): Promise<Response> {
  const automation = await requireAutomation(request, deps, now)
  if (!automation) return json({ error: 'unauthorized' }, 401, requestId)
  const nodeId = decodeURIComponent(url.pathname.split('/').at(-2) ?? '')
  const node = await deps.store.getNode(nodeId)
  if (!node || node.status === 'revoked') return json({ error: 'unknown_node', requestId }, 404, requestId)
  const updated = { ...node, deactivated }
  await deps.store.upsertNode(updated)
  if (deactivated) await removeNodeMeshTokens(deps.store, deps.env, nodeId, now)
  await deps.store.appendAudit({ id: requestId, type: deactivated ? 'node_deactivated' : 'node_activated', at: now, actor: `automation:${automation.id}`, target: nodeId, detail: {} })
  return json({ ok: true, node: toApiNode(updated, await desiredRuntimeVersions(deps.store)) }, 200, requestId)
}

// Automation twin of the console mesh secret rotation (POST /admin/mesh/rotate): rotate
// the mesh join secret via the API, reusing the same shared rotation core.
async function handleApiMeshRotate(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  const automation = await requireAutomation(request, deps, now)
  if (!automation) return json({ error: 'unauthorized' }, 401, requestId)
  return await handleMeshRotate(request, deps.store, deps.env, now, `automation:${automation.id}`)
}

// Automation twins of the console operator settings (POST /admin/settings): read and write
// the fleet-tunable settings via the API, reusing the same shared validation core.
async function handleApiSettingsGet(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  const automation = await requireAutomation(request, deps, now)
  if (!automation) return json({ error: 'unauthorized' }, 401, requestId)
  return json({ offlinePruneSeconds: await offlinePruneSeconds(deps), desiredRuntimeVersions: await desiredRuntimeVersions(deps.store) }, 200, requestId)
}

async function handleApiSettingsSet(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  const automation = await requireAutomation(request, deps, now)
  if (!automation) return json({ error: 'unauthorized' }, 401, requestId)
  return applyFleetSettings(request, deps, `automation:${automation.id}`, requestId, now)
}

/** Machine-facing model projection: identity, the names callers use, and rollout state. */
function toApiModel(profile: ModelProfile) {
  const m = profile.meshllm
  const l = profile.llamacpp
  return {
    id: profile.id,
    displayName: profile.displayName,
    callableNames: profile.publicAliases,
    active: profile.active,
    rolloutPercent: profile.rolloutPercent,
    contextWindow: profile.contextWindow,
    runtime: profile.runtime,
    modelRef: l?.modelRef ?? m?.modelRef ?? profile.upstreamModel,
    split: m?.split ?? false,
    meshId: profileMeshId(profile),
    maxVramGb: m?.maxVramGb ?? 0,
    tunables: m ? {
      parallel: m.parallel ?? null,
      cacheTypeK: m.cacheTypeK ?? null,
      cacheTypeV: m.cacheTypeV ?? null,
      batch: m.batch ?? null,
      ubatch: m.ubatch ?? null,
      flashAttn: m.flashAttn ?? null,
      maxOutputTokens: m.maxOutputTokens ?? null,
      reasoning: m.reasoning ?? null,
      prefixCache: m.prefixCache ?? null,
      toolEmulation: m.toolEmulation ?? null,
      wireDtype: m.wireDtype ?? null,
      prefillChunking: m.prefillChunking ?? null,
      prefillChunkSize: m.prefillChunkSize ?? null
    } : null,
    ...(l ? { llamacpp: l } : {})
  }
}

async function handleApiModelList(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  if (!(await requireAutomation(request, deps, now))) return json({ error: 'unauthorized' }, 401, requestId)
  const profiles = await deps.store.listProfiles()
  return json({ models: profiles.map(toApiModel) }, 200, requestId)
}

// handleApiModelAdd is the automation-facing twin of handleProfileAdd: a fleet
// manager adds a model to the catalog with an automation key instead of an Access
// session, wrapping the same buildCustomProfile lever so the API and console never
// diverge. The new model is inactive and reaches production only through the enable path.
async function handleApiModelAdd(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  const automation = await requireAutomation(request, deps, now)
  if (!automation) return json({ error: 'unauthorized' }, 401, requestId)
  const body = await readJson<{ modelRef?: string; mode?: string; runtime?: unknown; name?: string; meshId?: unknown }>(request)
  const modelRef = typeof body?.modelRef === 'string' ? body.modelRef.trim() : ''
  if (!modelRef) return json({ error: 'invalid_model_ref', requestId }, 400, requestId)
  const split = body?.mode === 'split'
  const runtime = resolveRuntime(body?.runtime)
  if (runtime === 'invalid_runtime') return json({ error: 'invalid_runtime', requestId }, 400, requestId)
  if (split && runtime === 'llamacpp') return json({ error: 'split_requires_meshllm', requestId }, 400, requestId)
  const meshId = await resolveOnboardingMesh(deps, body?.meshId)
  if (meshId === undefined) return json({ error: 'unknown_mesh', requestId }, 400, requestId)
  const name = typeof body?.name === 'string' ? body.name : undefined
  const existing = await deps.store.listProfiles()
  const profile = buildCustomProfile({ modelRef, split, existing, name, runtime, meshId })
  // Same quant-tag validation as the console add path: the automation API and the
  // console share buildCustomProfile and must share the door too.
  if (runtime === 'llamacpp') {
    const quantError = llamaCppQuantError(profile.llamacpp?.quant)
    if (quantError) return json({ error: quantError, requestId }, 400, requestId)
  }
  if (existing.some((candidate) => candidate.id === profile.id)) return json({ error: 'duplicate_profile', profileId: profile.id, requestId }, 409, requestId)
  await deps.store.setProfile(profile)
  await deps.store.appendAudit({ id: requestId, type: 'profile_added', at: now, actor: `automation:${automation.id}`, target: profile.id, detail: { modelRef, split, runtime } })
  return json({ ok: true, model: toApiModel(profile) }, 201, requestId)
}

// classifyModelDeletion is the single deletion rule the console and API both obey so
// they never diverge: any switched-off model can be removed, including the seed-once
// starter (REQ-RUN-012). Deleting the active model would 404 its mesh's stable route,
// so that alone is refused.
function classifyModelDeletion(profiles: readonly ModelProfile[], profileId: string): { profile: ModelProfile } | { error: string; status: number } {
  const profile = profiles.find((candidate) => candidate.id === profileId)
  if (!profile) return { error: 'unknown_profile', status: 404 }
  if (profile.active) return { error: 'model_active', status: 409 }
  return { profile }
}

async function handleApiModelDelete(request: Request, deps: RouterDeps, url: URL, requestId: string, now: number): Promise<Response> {
  const automation = await requireAutomation(request, deps, now)
  if (!automation) return json({ error: 'unauthorized' }, 401, requestId)
  const profileId = decodeURIComponent(url.pathname.split('/').pop() ?? '')
  const outcome = classifyModelDeletion(await deps.store.listProfiles(), profileId)
  if ('error' in outcome) return json({ error: outcome.error, requestId }, outcome.status, requestId)
  await deps.store.deleteProfile(profileId)
  await deps.store.appendAudit({ id: requestId, type: 'profile_deleted', at: now, actor: `automation:${automation.id}`, target: profileId, detail: {} })
  return json({ ok: true, id: profileId }, 200, requestId)
}

// handleProfileDelete is the Access-session twin of handleApiModelDelete: the console
// removes a custom, switched-off model through the same shared deletion rules.
async function handleProfileDelete(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  const actor = await requireAdmin(request, deps, now)
  if (!actor) return json({ error: 'unauthorized' }, 401, requestId)
  const body = await readJson<{ profileId?: string }>(request)
  const profileId = typeof body?.profileId === 'string' ? body.profileId.trim() : ''
  const outcome = classifyModelDeletion(await deps.store.listProfiles(), profileId)
  if ('error' in outcome) return json({ error: outcome.error, requestId }, outcome.status, requestId)
  await deps.store.deleteProfile(profileId)
  await deps.store.appendAudit({ id: requestId, type: 'profile_deleted', at: now, actor, target: profileId, detail: {} })
  return json({ ok: true, profileId }, 200, requestId)
}

// Duplication clones a profile into an inactive same-mesh sibling with a derived
// call name so the operator tunes a variant without touching the original (REQ-RUN-017).
async function duplicateProfileCore(deps: RouterDeps, profileId: string, actor: string, requestId: string, now: number): Promise<Response> {
  const profiles = await deps.store.listProfiles()
  const source = profiles.find((profile) => profile.id === profileId)
  if (!source) return json({ error: 'unknown_profile', requestId }, 404, requestId)
  const copy = buildDuplicateProfile(source, profiles)
  await deps.store.setProfile(copy)
  await deps.store.appendAudit({ id: requestId, type: 'model_duplicated', at: now, actor, target: copy.id, detail: { from: source.id } })
  return json({ ok: true, profileId: copy.id, model: toApiModel(copy) }, 201, requestId)
}

async function handleProfileDuplicate(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  const actor = await requireAdmin(request, deps, now)
  if (!actor) return json({ error: 'unauthorized' }, 401, requestId)
  const body = await readJson<{ profileId?: unknown }>(request)
  if (!body || typeof body.profileId !== 'string') return json({ error: 'invalid_profile_config', requestId }, 400, requestId)
  return duplicateProfileCore(deps, body.profileId, actor, requestId, now)
}

async function handleApiModelDuplicate(request: Request, deps: RouterDeps, url: URL, requestId: string, now: number): Promise<Response> {
  const automation = await requireAutomation(request, deps, now)
  if (!automation) return json({ error: 'unauthorized' }, 401, requestId)
  return duplicateProfileCore(deps, decodeURIComponent(url.pathname.split('/').at(-2) ?? ''), `automation:${automation.id}`, requestId, now)
}

async function handleApiModelConfigure(request: Request, deps: RouterDeps, url: URL, requestId: string, now: number): Promise<Response> {
  const automation = await requireAutomation(request, deps, now)
  if (!automation) return json({ error: 'unauthorized' }, 401, requestId)
  const profileId = decodeURIComponent(url.pathname.split('/')[4] ?? '')
  const body = await readJson<ModelConfigBody>(request)
  if (!body) return json({ error: 'invalid_model_config', requestId }, 400, requestId)
  const profiles = await deps.store.listProfiles()
  const found = profiles.find((profile) => profile.id === profileId)
  if (!found) return json({ error: 'unknown_profile', requestId }, 404, requestId)
  const reassignment = await resolveMeshReassignment(deps, found, body.meshId)
  if ('error' in reassignment) return json({ error: reassignment.error, requestId }, 400, requestId)
  const existing = reassignment.profile
  const runtime = resolveRuntime(body.runtime)
  if (runtime === 'invalid_runtime') return json({ error: 'invalid_runtime', requestId }, 400, requestId)
  if (body.llamacpp !== undefined && runtime !== 'llamacpp' && existing.runtime !== 'llamacpp') return json({ error: 'invalid_model_config', requestId }, 400, requestId)
  if (runtime === 'llamacpp' || existing.runtime === 'llamacpp') {
    const direct = configureLlamaCppProfile(existing, profiles, body)
    if ('error' in direct) return json({ error: direct.error, requestId }, direct.status, requestId)
    await deps.store.setProfile(direct.profile)
    if (reassignment.change) await deps.store.appendAudit({ id: crypto.randomUUID(), type: 'model_mesh_assigned', at: now, actor: `automation:${automation.id}`, target: direct.profile.id, detail: { ...reassignment.change } })
    await deps.store.appendAudit({ id: requestId, type: 'profile_configured', at: now, actor: `automation:${automation.id}`, target: direct.profile.id, detail: { contextWindow: direct.settings.contextWindow, modelRef: direct.settings.modelRef, runtime: 'llamacpp' } })
    return json({ ok: true, model: toApiModel(direct.profile) }, 200, requestId)
  }
  const contextWindow = body.contextWindow ?? existing.contextWindow
  if (!Number.isInteger(contextWindow) || contextWindow < 0) return json({ error: 'invalid_context_window', requestId }, 400, requestId)
  const maxVram = resolveMaxVram(body.maxVramGb)
  if (maxVram === INVALID_MAX_VRAM) return json({ error: 'invalid_max_vram', requestId }, 400, requestId)
  if (existing.runtime !== 'meshllm' || !existing.meshllm) return json({ error: 'invalid_model_config', requestId }, 400, requestId)
  let meshllm = existing.meshllm
  let upstreamModel = existing.upstreamModel
  if (body.modelRef !== undefined) {
    const modelRef = typeof body.modelRef === 'string' ? body.modelRef.trim() : ''
    if (!modelRef) return json({ error: 'invalid_model_ref', requestId }, 400, requestId)
    meshllm = { ...meshllm, modelRef }
    upstreamModel = modelRef
  }
  if (maxVram !== undefined) meshllm = { ...meshllm, maxVramGb: maxVram }
  const tunables = resolveMeshllmTunables(meshllm, body)
  if ('error' in tunables) return json({ error: tunables.error, requestId }, 400, requestId)
  meshllm = tunables.meshllm
  // Rename parity with the console: name sets the display name; callName sets this
  // model's own public alias (kept alongside the shared codeflare-mesh alias), with
  // the same non-empty / not-reserved / no-collision rules.
  let displayName = existing.displayName
  if (body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) return json({ error: 'invalid_display_name', requestId }, 400, requestId)
    displayName = name
  }
  let publicAliases = existing.publicAliases
  if (body.callName !== undefined) {
    const resolved = resolveCallNameAliases(existing, body.callName, profiles)
    if (!Array.isArray(resolved)) return json({ error: (resolved as { error: string }).error, requestId }, (resolved as { status: number }).status, requestId)
    publicAliases = resolved
  }
  const updated: ModelProfile = { ...existing, contextWindow, upstreamModel, meshllm, displayName, publicAliases, version: existing.version + 1 }
  await deps.store.setProfile(updated)
  if (reassignment.change) await deps.store.appendAudit({ id: crypto.randomUUID(), type: 'model_mesh_assigned', at: now, actor: `automation:${automation.id}`, target: updated.id, detail: { ...reassignment.change } })
  await deps.store.appendAudit({ id: requestId, type: 'profile_configured', at: now, actor: `automation:${automation.id}`, target: updated.id, detail: { contextWindow, modelRef: meshllm.modelRef } })
  return json({ ok: true, model: toApiModel(updated) }, 200, requestId)
}

async function handleApiModelEnable(request: Request, deps: RouterDeps, url: URL, requestId: string, now: number): Promise<Response> {
  const automation = await requireAutomation(request, deps, now)
  if (!automation) return json({ error: 'unauthorized' }, 401, requestId)
  const profileId = decodeURIComponent(url.pathname.split('/')[4] ?? '')
  const activation = singleActiveActivation(await deps.store.listProfiles(), profileId)
  if (!activation) return json({ error: 'unknown_profile', requestId }, 404, requestId)
  for (const profile of activation.deactivated) await deps.store.setProfile(profile)
  await deps.store.setProfile(activation.activated)
  const deactivatedIds = activation.deactivated.map((profile) => profile.id)
  await deps.store.appendAudit({ id: requestId, type: 'profile_activated', at: now, actor: `automation:${automation.id}`, target: profileId, detail: { deactivated: deactivatedIds } })
  return json({ ok: true, activated: activation.activated.id, deactivated: deactivatedIds }, 200, requestId)
}

async function handleApiModelDisable(request: Request, deps: RouterDeps, url: URL, requestId: string, now: number): Promise<Response> {
  const automation = await requireAutomation(request, deps, now)
  if (!automation) return json({ error: 'unauthorized' }, 401, requestId)
  const profileId = decodeURIComponent(url.pathname.split('/')[4] ?? '')
  const existing = (await deps.store.listProfiles()).find((profile) => profile.id === profileId)
  if (!existing) return json({ error: 'unknown_profile', requestId }, 404, requestId)
  await deps.store.setActiveProfile(profileId, 0)
  await deps.store.appendAudit({ id: requestId, type: 'profile_rollout', at: now, actor: `automation:${automation.id}`, target: profileId, detail: { rolloutPercent: 0 } })
  return json({ ok: true, id: profileId }, 200, requestId)
}

async function handleApiAgentVersions(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  if (!(await requireAutomation(request, deps, now))) return json({ error: 'unauthorized' }, 401, requestId)
  return await handleAgentVersionsList(request, deps.store, deps.env, deps.releasesFetcher)
}

async function handleApiAgentVersionSet(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  const automation = await requireAutomation(request, deps, now)
  if (!automation) return json({ error: 'unauthorized' }, 401, requestId)
  return await handleAgentVersionSelect(request, deps.store, deps.env, deps.releasesFetcher ?? globalThis.fetch, `automation:${automation.id}`)
}

async function handleApiRuntimeVersions(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  if (!(await requireAutomation(request, deps, now))) return json({ error: 'unauthorized' }, 401, requestId)
  return await handleRuntimeVersionsList(request, deps.store, deps.releasesFetcher ?? globalThis.fetch, deps.env)
}

async function handleApiRuntimeVersionSet(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  const automation = await requireAutomation(request, deps, now)
  if (!automation) return json({ error: 'unauthorized' }, 401, requestId)
  return await handleRuntimeVersionsSelect(request, deps.store, deps.releasesFetcher ?? globalThis.fetch, `automation:${automation.id}`, deps.env)
}

/** Poll operational events oldest-first, filtered by since/type, paginated by an `at` cursor. */
async function handleApiEvents(request: Request, deps: RouterDeps, url: URL, requestId: string, now: number): Promise<Response> {
  if (!(await requireAutomation(request, deps, now))) return json({ error: 'unauthorized' }, 401, requestId)
  const raw = url.searchParams.get('since') ?? '0'
  const i = raw.indexOf(':')
  const atStr = i >= 0 ? raw.slice(0, i) : raw
  const sinceId = i >= 0 ? raw.slice(i + 1) : ''
  const sinceParam = Number(atStr)
  const sinceMs = Number.isFinite(sinceParam) && sinceParam >= 0 ? sinceParam : 0
  const typeParam = url.searchParams.get('type')
  const types = typeParam ? typeParam.split(',').map((entry) => entry.trim()).filter(Boolean) : undefined
  const limitParam = Number(url.searchParams.get('limit') ?? '100')
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(Math.floor(limitParam), 1000) : 100
  const events = await deps.store.listEventsSince(sinceMs, sinceId, types, limit)
  const last = events.length > 0 ? events[events.length - 1]! : undefined
  const nextCursor = events.length === limit && last ? `${last.at}:${last.id}` : null
  return json({ events, nextCursor }, 200, requestId)
}

function validateClaim(body: ClaimRequest | undefined, env: Pick<RouterEnv, 'MESH_ALLOWED_CIDRS' | 'MESH_ALLOWED_PORTS'> = {}): string[] {
  if (!body) return ['displayName', 'meshIp', 'inferencePort', 'publicModels', 'activeProfileIds', 'capacity']
  const errors: string[] = []
  if (typeof body.displayName !== 'string' || body.displayName.length === 0) errors.push('displayName')
  if (typeof body.meshIp !== 'string' || body.meshIp.length === 0) errors.push('meshIp')
  if (!Number.isInteger(body.inferencePort)) errors.push('inferencePort')
  if (typeof body.meshIp === 'string' && body.meshIp && Number.isInteger(body.inferencePort) && !isSafeMeshTarget(body.meshIp, body.inferencePort, env)) errors.push('meshTarget')
  if (!Array.isArray(body.publicModels) || !body.publicModels.every((item) => typeof item === 'string' && item.length > 0)) errors.push('publicModels')
  if (!Array.isArray(body.activeProfileIds) || !body.activeProfileIds.every((item) => typeof item === 'string' && item.length > 0)) errors.push('activeProfileIds')
  if (!Number.isInteger(body.capacity) || body.capacity < 1) errors.push('capacity')
  return errors
}

function validateHeartbeat(body: HeartbeatRequest | undefined, env: Pick<RouterEnv, 'MESH_ALLOWED_CIDRS' | 'MESH_ALLOWED_PORTS'> = {}): string[] {
  if (!body) return ['nodeId']
  const errors: string[] = []
  if (typeof body.nodeId !== 'string' || body.nodeId.length === 0) errors.push('nodeId')
  if (typeof body.displayName !== 'string' || body.displayName.length === 0) errors.push('displayName')
  if (typeof body.meshIp !== 'string' || body.meshIp.length === 0) errors.push('meshIp')
  if (!Number.isInteger(body.inferencePort)) errors.push('inferencePort')
  if (typeof body.meshIp === 'string' && body.meshIp && Number.isInteger(body.inferencePort) && !isSafeMeshTarget(body.meshIp, body.inferencePort, env)) errors.push('meshTarget')
  if (!Number.isInteger(body.localDashboardPort) || body.localDashboardPort < 1 || body.localDashboardPort > 65535) errors.push('localDashboardPort')
  if (!['online', 'offline', 'draining'].includes(body.status)) errors.push('status')
  if (!Array.isArray(body.publicModels) || !body.publicModels.every((item) => typeof item === 'string' && item.length > 0)) errors.push('publicModels')
  if (!Array.isArray(body.activeProfileIds) || !body.activeProfileIds.every((item) => typeof item === 'string' && item.length > 0)) errors.push('activeProfileIds')
  if (!Number.isInteger(body.capacity) || body.capacity < 1) errors.push('capacity')
  if (!Number.isInteger(body.inFlight) || body.inFlight < 0) errors.push('inFlight')
  if (!['meshllm', 'llamacpp'].includes(body.runtime)) errors.push('runtime')
  if (body.runtimeModel !== undefined && typeof body.runtimeModel !== 'string') errors.push('runtimeModel')
  if (body.agentVersion !== undefined && typeof body.agentVersion !== 'string') errors.push('agentVersion')
  if (body.reloadNonce !== undefined && typeof body.reloadNonce !== 'string') errors.push('reloadNonce')
  if (body.metrics !== undefined && !validNodeMetrics(body.metrics)) errors.push('metrics')
  return errors
}

function validNodeMetrics(metrics: unknown): boolean {
  if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)) return false
  const value = metrics as Record<string, unknown>
  if (typeof value.runtimeState !== 'string' || value.runtimeState.length === 0) return false
  if (typeof value.activeRequests !== 'number' || !Number.isInteger(value.activeRequests) || value.activeRequests < 0) return false
  if (value.runtimeKind !== undefined && !['meshllm', 'llamacpp'].includes(String(value.runtimeKind))) return false
  if (value.apiReady !== undefined && typeof value.apiReady !== 'boolean') return false
  if (value.consoleReady !== undefined && typeof value.consoleReady !== 'boolean') return false
  if (value.readyModels !== undefined && (!Array.isArray(value.readyModels) || !value.readyModels.every((item) => typeof item === 'string'))) return false
  for (const key of ['gpuMemoryUsedMiB', 'gpuMemoryTotalMiB', 'activeRequests', 'tokensPerSecond', 'promptTokensPerSecond', 'generationTokensPerSecond', 'peerCount', 'stageCount', 'meshMaxVramGb', 'ctxSize', 'parallel', 'cacheReuse', 'slotCount', 'activeSlots', 'cachedTokensLast']) {
    const raw = value[key]
    // parallel -1 is the profile editor's own Auto slot-planning sentinel (REQ-RUN-013); a node
    // echoing it back is valid telemetry, and rejecting it froze Auto-parallel nodes into a
    // phantom Offline (every heartbeat 400'd while llama-server ran fine locally).
    if (raw !== undefined && (typeof raw !== 'number' || !Number.isFinite(raw) || (raw < 0 && !(key === 'parallel' && raw === -1)))) return false
  }
  return true
}

function stableNodeId(displayName: string, meshIp: string): string {
  return `${displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${meshIp.replace(/\./g, '-')}`
}

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
