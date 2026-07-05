import { fetchIdentityGroups, verifyAccessRequest } from './access'
import { CloudflareAccessClient, type AccessProvisionRequest, type AccessProvisionResult } from './access-provisioning'
import { adminUiHtml, type AdminUiState } from './admin-ui'
import { consoleMovedHtml } from './admin-ui-views'
import { desiredAgentVersion, handleAgentVersionSelect, handleAgentVersionsList } from './agent-versions'
import { approvedNodeHeaders, bearerToken, createTokenRecord, generateBearerToken, hashToken, redactSecrets, verifyPlainOrHashed, verifyToken } from './auth'
import { CloudflareGatewayClient, type CustomDomainProvisionRequest, type CustomDomainProvisionResult, type GatewayRecord, type GatewaySyncRequest, type GatewaySyncResult, type RouteRecord, type ZoneRecord } from './cloudflare-api'
import { installerCommand, installScript, SETUP_TOKEN_PLACEHOLDER, validateCustomDomain, type InstallerPlatform } from './installers'
import { applyHeartbeatMeshState, handleMeshRotate, meshBootstrapFor, meshHealth, removeNodeMeshTokens } from './mesh-state'
import { buildCustomProfile, DEFAULT_MODEL_PROFILES, isDefaultModelId, slugify, STABLE_PUBLIC_MODEL } from './profiles'
import { isRateLimited } from './rate-limit'
import { meshUrl } from './scheduler'
import { ACCESS_CONFIG_KEY, SETUP_REOPEN_CONSUMED_KEY, SETUP_REOPEN_SEEN_KEY, accessConfig, advancePhase, breakGlassActive, setupPhase } from './setup-state'
import { singleActiveActivation } from './store'
import type { ClaimRequest, CredentialKind, HeartbeatRequest, ModelProfile, NodeRecord, RouterEnv, Scheduler, Store, TokenRecord } from './types'

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' }
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
      if (request.method === 'GET' && url.pathname === '/health') return json({ ok: true, service: 'inference-mesh-router' }, 200, id)
      if (request.method === 'GET' && url.pathname === '/v1/models') return await handleModels(request, deps, id, now())
      if (request.method === 'POST' && url.pathname === '/v1/chat/completions') return await handleChat(request, deps, id, now())
      if (request.method === 'POST' && url.pathname === '/node/claim') return await handleNodeClaim(request, deps, id, now())
      if (request.method === 'POST' && url.pathname === '/node/heartbeat') return await handleNodeHeartbeat(request, deps, id, now())
      if (request.method === 'POST' && url.pathname === '/node/unregister') return await handleNodeUnregister(request, deps, id, now())
      if (url.pathname === '/admin/setup' && request.method === 'POST') return await handleFirstSetup(request, deps, id, now())
      if (url.pathname === '/admin/recovery/reset' && request.method === 'POST') return await handleAdminRecovery(request, deps, id, now())
      if (url.pathname === '/install.sh' && request.method === 'GET') return handleInstallScript(deps, url.searchParams.get('platform') === 'macos' ? 'macos' : 'linux')
      if (url.pathname === '/install.ps1' && request.method === 'GET') return handleInstallScript(deps, 'windows')
      if (url.pathname === '/admin/login' && request.method === 'POST') return await handleAdminLogin(request, deps, id, now())
      if (url.pathname === '/admin/status' && request.method === 'GET') return await handleAdminStatus(request, deps, id, now())
      if (url.pathname === '/admin/setup-tokens' && request.method === 'POST') return await handleSetupToken(request, deps, id, now())
      if (url.pathname.startsWith('/admin/installers/') && request.method === 'GET') return await handleInstaller(request, deps, url, id, now())
      if (url.pathname === '/admin/cloudflare/gateway/sync' && request.method === 'POST') return await handleGatewaySync(request, deps, id, now())
      if (url.pathname === '/admin/custom-domain/validate' && request.method === 'POST') return await handleCustomDomain(request, deps, id, now(), false)
      if (url.pathname === '/admin/setup/domain' && request.method === 'POST') return await handleCustomDomain(request, deps, id, now(), true)
      if (url.pathname === '/admin/setup/access' && request.method === 'POST') return await handleSetupAccess(request, deps, id, now())
      if (url.pathname === '/admin/setup/complete' && request.method === 'POST') return await handleSetupComplete(request, deps, id, now())
      if (url.pathname === '/admin/cloudflare/zones' && request.method === 'GET') return await handleZones(request, deps, id, now())
      if (url.pathname === '/admin/cloudflare/gateway/options' && request.method === 'GET') return await handleGatewayOptions(request, deps, url, id, now())
      if (url.pathname.match(/^\/admin\/nodes\/[^/]+\/revoke$/) && request.method === 'POST') return await handleNodeRevoke(request, deps, url, id, now())
      if (url.pathname.match(/^\/admin\/nodes\/[^/]+\/config$/) && request.method === 'POST') return await handleNodeConfig(request, deps, url, id, now())
      if (url.pathname === '/admin/profiles/rollout' && request.method === 'POST') return await handleProfileRollout(request, deps, id, now())
      if (url.pathname === '/admin/profiles/activate' && request.method === 'POST') return await handleProfileActivate(request, deps, id, now())
      if (url.pathname === '/admin/profiles/add' && request.method === 'POST') return await handleProfileAdd(request, deps, id, now())
      if (url.pathname === '/admin/profiles/config' && request.method === 'POST') return await handleProfileConfig(request, deps, id, now())
      if (url.pathname === '/admin/profiles/delete' && request.method === 'POST') return await handleProfileDelete(request, deps, id, now())
      if (url.pathname === '/admin/settings' && request.method === 'POST') return await handleAdminSettings(request, deps, id, now())
      if (url.pathname === '/admin/mesh/rotate' && request.method === 'POST') return await handleAdminMeshRotate(request, deps, id, now())
      if (url.pathname === '/admin/agent-versions' && request.method === 'GET') return await handleAdminAgentVersions(request, deps, id, now())
      if (url.pathname === '/admin/agent-version' && request.method === 'POST') return await handleAdminAgentVersionSelect(request, deps, id, now())
      if (url.pathname === '/admin/playground/chat' && request.method === 'POST') return await handlePlaygroundChat(request, deps, id, now())
      if (url.pathname === '/admin/whoami' && request.method === 'GET') return await handleWhoami(request, deps, id, now())
      if (url.pathname === '/api/v1/keys' && request.method === 'POST') return await handleApiKeyCreate(request, deps, id, now())
      if (url.pathname === '/api/v1/keys' && request.method === 'GET') return await handleApiKeyList(request, deps, id, now())
      if (url.pathname.match(/^\/api\/v1\/keys\/[^/]+\/rotate$/) && request.method === 'POST') return await handleApiKeyRotate(request, deps, url, id, now())
      if (url.pathname.match(/^\/api\/v1\/keys\/[^/]+$/) && request.method === 'DELETE') return await handleApiKeyRevoke(request, deps, url, id, now())
      if (url.pathname === '/api/v1/status' && request.method === 'GET') return await handleApiStatus(request, deps, id, now())
      if (url.pathname === '/api/v1/enrollment-tokens' && request.method === 'POST') return await handleApiEnrollmentToken(request, deps, id, now())
      if (url.pathname === '/api/v1/nodes' && request.method === 'GET') return await handleApiNodeList(request, deps, url, id, now())
      if (url.pathname.match(/^\/api\/v1\/nodes\/[^/]+$/) && request.method === 'GET') return await handleApiNodeGet(request, deps, url, id, now())
      if (url.pathname.match(/^\/api\/v1\/nodes\/[^/]+\/reconfigure$/) && request.method === 'POST') return await handleApiNodeReconfigure(request, deps, url, id, now())
      if (url.pathname.match(/^\/api\/v1\/nodes\/[^/]+$/) && request.method === 'DELETE') return await handleApiNodeDecommission(request, deps, url, id, now())
      if (url.pathname === '/api/v1/models' && request.method === 'GET') return await handleApiModelList(request, deps, id, now())
      if (url.pathname === '/api/v1/models' && request.method === 'POST') return await handleApiModelAdd(request, deps, id, now())
      if (url.pathname.match(/^\/api\/v1\/models\/[^/]+\/enable$/) && request.method === 'POST') return await handleApiModelEnable(request, deps, url, id, now())
      if (url.pathname.match(/^\/api\/v1\/models\/[^/]+\/disable$/) && request.method === 'POST') return await handleApiModelDisable(request, deps, url, id, now())
      if (url.pathname.match(/^\/api\/v1\/models\/[^/]+$/) && request.method === 'DELETE') return await handleApiModelDelete(request, deps, url, id, now())
      if (url.pathname.match(/^\/api\/v1\/models\/[^/]+$/) && request.method === 'POST') return await handleApiModelConfigure(request, deps, url, id, now())
      if (url.pathname === '/api/v1/agent-versions' && request.method === 'GET') return await handleApiAgentVersions(request, deps, id, now())
      if (url.pathname === '/api/v1/agent-version' && request.method === 'PUT') return await handleApiAgentVersionSet(request, deps, id, now())
      if (url.pathname === '/api/v1/events' && request.method === 'GET') return await handleApiEvents(request, deps, url, id, now())
      return json({ error: 'not_found', requestId: id }, 404, id)
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

async function handleModels(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  if (!(await authenticateKind(request, deps, 'provider', now, deps.env.ROUTER_PROVIDER_TOKEN))) return json({ error: 'unauthorized' }, 401, requestId)
  const profiles = await deps.store.listProfiles()
  return json({ object: 'list', data: profiles.filter((profile) => profile.active).flatMap((profile) => profile.publicAliases.map((id) => ({ id, object: 'model', owned_by: 'codeflare-inference-mesh' }))) }, 200, requestId)
}

async function handleChat(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  if (!(await authenticateKind(request, deps, 'provider', now, deps.env.ROUTER_PROVIDER_TOKEN))) return json({ error: 'unauthorized' }, 401, requestId)
  const maxBytes = Number(deps.env.MAX_REQUEST_BYTES ?? DEFAULT_MAX_BYTES)
  const contentLength = Number(request.headers.get('content-length') ?? '0')
  if (contentLength > maxBytes) return json({ error: 'request_too_large', requestId }, 413, requestId)
  const bodyText = await request.text()
  if (new TextEncoder().encode(bodyText).byteLength > maxBytes) return json({ error: 'request_too_large', requestId }, 413, requestId)
  const body = parseObject(bodyText)
  if (!body || typeof body.model !== 'string') return json({ error: 'invalid_json', requestId }, 400, requestId)

  const publicModel = body.model
  const sessionId = sessionIdFor(request, body, requestId)
  const result = await deps.scheduler.reserve({ publicModel, sessionId, now })
  if (!result.reservation || !result.node || !result.profile) return json({ error: result.reason ?? 'no-node', requestId }, result.reason === 'no-profile' ? 404 : 429, requestId)

  const upstreamToken = await resolveUpstreamToken(deps)
  if (!upstreamToken) {
    await deps.scheduler.release(result.reservation.reservationId, now)
    return json({ error: 'upstream_token_missing', requestId }, 503, requestId)
  }

  const rewritten = JSON.stringify({ ...body, model: result.reservation.upstreamModel })
  const currentNow = deps.now ?? Date.now
  let upstream: Response
  try {
    upstream = await deps.mesh.fetch(meshUrl(result.node, '/v1/chat/completions'), {
      method: 'POST',
      headers: approvedNodeHeaders(request.headers, upstreamToken, requestId),
      body: rewritten
    })
  } catch (error) {
    await deps.scheduler.recordFailure(result.reservation.reservationId, currentNow())
    throw error
  }
  const headers = responseMetadataHeaders(upstream.headers, requestId, sessionId, result.node.id)
  return releaseOnCompletion(
    upstream,
    headers,
    () => deps.scheduler.release(result.reservation!.reservationId, currentNow()),
    () => deps.scheduler.recordFailure(result.reservation!.reservationId, currentNow())
  )
}

async function handleNodeClaim(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  const setupToken = await authenticateAnyStoredToken(request, deps.store, 'setup', now)
  if (!setupToken) return json({ error: 'unauthorized' }, 401, requestId)
  const body = await readJson<ClaimRequest>(request)
  const validation = validateClaim(body)
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
  const meshProfile = await selectedMeshProfile(deps.store, body.activeProfileIds)
  const meshBootstrap = meshProfile ? await meshBootstrapFor(deps.store, deps.env, nodeRecord, meshProfile, now) : undefined
  const desiredVersion = await desiredAgentVersion(deps.store)
  return json({
    nodeId,
    nodeToken,
    upstreamToken,
    profiles: await deps.store.listProfiles(),
    ...(meshBootstrap !== undefined ? { meshBootstrap } : {}),
    ...(desiredVersion !== undefined ? { desiredAgentVersion: desiredVersion } : {})
  }, 201, requestId)
}

async function handleNodeHeartbeat(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  const body = await readJson<HeartbeatRequest>(request)
  if (!body?.nodeId) return json({ error: 'invalid_heartbeat' }, 400, requestId)
  const node = await deps.store.getNode(body.nodeId)
  if (!node) return json({ error: 'unknown_node' }, 404, requestId)
  if (node.status === 'revoked') return json({ error: 'node_revoked' }, 403, requestId)
  const presented = bearerToken(request)
  const tokenOk = node.nodeTokenVerifier ? await verifyPlainOrHashed(node.nodeTokenVerifier, presented) : Boolean(await authenticateTokenByNode(request, deps.store, 'node', body.nodeId, now))
  if (!tokenOk) return json({ error: 'unauthorized' }, 401, requestId)
  const next = {
    ...node,
    displayName: body.displayName,
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
    ...(body.metrics !== undefined ? { metrics: body.metrics } : {})
  }
  await deps.store.updateNodeHeartbeat(next)
  await applyHeartbeatMeshState(deps.store, deps.env, next, body, now)
  const meshProfile = await selectedMeshProfile(deps.store, next.activeProfileIds)
  const meshBootstrap = meshProfile ? await meshBootstrapFor(deps.store, deps.env, next, meshProfile, now) : undefined
  const desiredVersion = await desiredAgentVersion(deps.store)
  // A per-node VRAM override caps this node's models below the model's global budget.
  const desiredProfiles = applyNodeVramOverride(await deps.store.listProfiles(), next.maxVramGbOverride)
  return json({
    ok: true,
    desiredProfiles,
    ...(meshBootstrap !== undefined ? { meshBootstrap } : {}),
    ...(desiredVersion !== undefined ? { desiredAgentVersion: desiredVersion } : {})
  }, 200, requestId)
}

async function selectedMeshProfile(store: Store, activeProfileIds: readonly string[]): Promise<ModelProfile | undefined> {
  const profiles = await store.listProfiles()
  for (const profileId of activeProfileIds) {
    const profile = profiles.find((item) => item.id === profileId)
    if (profile?.active) return profile
  }
  return undefined
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
        audit: await deps.store.listAudit(20)
      }
    : {}
  const redacted = redactSecrets({ nodes, profiles, profileReadiness: profileReadiness(profiles, nodes), ...adminOnly, generatedAt: now }) as Record<string, unknown>
  // meshHealth is composed after redaction: its contract carries token presence/age/count
  // fields (never values), which the key-name redactor would otherwise blank out.
  return json({
    ...redacted,
    viewerRole: viewer.role,
    meshHealth: await meshHealth(deps.store, deps.env, profiles, nodes, now),
    ...(desiredVersion !== undefined ? { desiredAgentVersion: desiredVersion } : {})
  }, 200, requestId)
}

function profileReadiness(profiles: readonly ModelProfile[], nodes: readonly NodeRecord[]): Array<{ profileId: string; version: number; ready: number; downloading: number; failed: number }> {
  return profiles.map((profile) => {
    const matching = nodes.filter((node) => node.activeProfileIds.includes(profile.id))
    const ready = matching.filter((node) => nodeReadyForProfile(node, profile)).length
    const downloading = matching.filter((node) => node.metrics?.runtimeState === 'downloading' || node.metrics?.runtimeState === 'starting').length
    const failed = matching.filter((node) => {
      const state = node.metrics?.runtimeState
      return state === 'failed' || state === 'dependency-missing' || state === 'stopped'
    }).length
    return { profileId: profile.id, version: profile.version, ready, downloading, failed }
  })
}

function nodeReadyForProfile(node: NodeRecord, profile: ModelProfile): boolean {
  const runtimeState = node.metrics?.runtimeState
  if (runtimeState !== 'ready' && runtimeState !== 'running') return false
  if (node.metrics?.apiReady !== true) return false
  return node.metrics?.readyModels?.includes(profile.upstreamModel) === true
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
    result = await client.syncCustomProvider({
      accountId: settings.accountId,
      gatewayId: settings.gatewayId,
      workerUrl,
      providerName: settings.providerName,
      routeName: settings.routeName,
      publicModel: settings.publicModel,
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

// handleNodeConfig sets or clears a node's per-node VRAM override from the admin console
// (blank/`null` reverts to the model's global budget; a non-negative number caps this node).
async function handleNodeConfig(request: Request, deps: RouterDeps, url: URL, requestId: string, now: number): Promise<Response> {
  const actor = await requireAdmin(request, deps, now)
  if (!actor) return json({ error: 'unauthorized' }, 401, requestId)
  const nodeId = decodeURIComponent(url.pathname.split('/').at(-2) ?? '')
  const node = await deps.store.getNode(nodeId)
  if (!node || node.status === 'revoked') return json({ error: 'unknown_node', requestId }, 404, requestId)
  const body = await readJson<{ maxVramGbOverride?: number | null }>(request)
  const updated = nodeWithVramOverride(node, body?.maxVramGbOverride)
  if (updated === INVALID_MAX_VRAM) return json({ error: 'invalid_max_vram', requestId }, 400, requestId)
  await deps.store.upsertNode(updated)
  await deps.store.appendAudit({ id: requestId, type: 'node_reconfigured', at: now, actor, target: nodeId, detail: { maxVramGbOverride: updated.maxVramGbOverride ?? null } })
  return json({ ok: true, id: nodeId, maxVramGbOverride: updated.maxVramGbOverride ?? null }, 200, requestId)
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
const INVALID_MAX_VRAM = Symbol('invalid_max_vram')
function resolveMaxVram(value: number | undefined): number | undefined | typeof INVALID_MAX_VRAM {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return INVALID_MAX_VRAM
  return value
}

// A node's VRAM override replaces the model's global maxVramGb for that node. `null` clears the
// override (revert to the model default); a finite number >= 0 sets it (0 = uncapped on this node).
function nodeWithVramOverride(node: NodeRecord, value: number | null | undefined): NodeRecord | typeof INVALID_MAX_VRAM {
  if (value === null) {
    const { maxVramGbOverride, ...rest } = node
    void maxVramGbOverride
    return rest
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return INVALID_MAX_VRAM
  return { ...node, maxVramGbOverride: value }
}

// Apply a node's VRAM override to the profile set it will run, so the agent renders --max-vram
// at the node's ceiling instead of the model's global budget.
function applyNodeVramOverride(profiles: readonly ModelProfile[], override: number | undefined): readonly ModelProfile[] {
  if (override === undefined) return profiles
  return profiles.map((profile) => ({ ...profile, meshllm: { ...profile.meshllm, maxVramGb: override } }))
}

// handleProfileConfig persists a profile's serving settings — the context window,
// the model ref, and the per-model VRAM budget — through the validated store path
// so the active column and the profile_json blob stay consistent. contextWindow
// must be a positive integer; a supplied modelRef is trimmed, must be non-empty,
// and updates both the mesh runtime ref and the gateway upstream model together.
async function handleProfileConfig(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  const actor = await requireAdmin(request, deps, now)
  if (!actor) return json({ error: 'unauthorized' }, 401, requestId)
  const body = await readJson<{ profileId?: string; contextWindow?: number; modelRef?: string; maxVramGb?: number; name?: string; callName?: string }>(request)
  if (!body || typeof body.profileId !== 'string') return json({ error: 'invalid_profile_config', requestId }, 400, requestId)
  const profiles = await deps.store.listProfiles()
  const existing = profiles.find((profile) => profile.id === body.profileId)
  if (!existing) return json({ error: 'unknown_profile', requestId }, 404, requestId)
  const contextWindow = body.contextWindow ?? existing.contextWindow
  if (!Number.isInteger(contextWindow) || contextWindow <= 0) return json({ error: 'invalid_context_window', requestId }, 400, requestId)
  const maxVram = resolveMaxVram(body.maxVramGb)
  if (maxVram === INVALID_MAX_VRAM) return json({ error: 'invalid_max_vram', requestId }, 400, requestId)
  let meshllm = existing.meshllm
  let upstreamModel = existing.upstreamModel
  if (body.modelRef !== undefined) {
    const modelRef = typeof body.modelRef === 'string' ? body.modelRef.trim() : ''
    if (!modelRef) return json({ error: 'invalid_model_ref', requestId }, 400, requestId)
    meshllm = { ...meshllm, modelRef }
    upstreamModel = modelRef
  }
  if (maxVram !== undefined) meshllm = { ...meshllm, maxVramGb: maxVram }
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
    const alias = slugify(typeof body.callName === 'string' ? body.callName : '')
    if (!alias) return json({ error: 'invalid_call_name', requestId }, 400, requestId)
    if (alias === STABLE_PUBLIC_MODEL) return json({ error: 'call_name_conflict', requestId }, 409, requestId)
    if (profiles.some((profile) => profile.id !== existing.id && profile.publicAliases.includes(alias))) return json({ error: 'call_name_conflict', requestId }, 409, requestId)
    publicAliases = [STABLE_PUBLIC_MODEL, alias]
  }
  // Bump the version so a later deploy's default re-seed (shouldRefreshDefaultProfile
  // refreshes only when stored version <= shipped version) does not overwrite this edit.
  const updated: ModelProfile = { ...existing, contextWindow, upstreamModel, meshllm, displayName, publicAliases, version: existing.version + 1 }
  await deps.store.setProfile(updated)
  await deps.store.appendAudit({ id: requestId, type: 'profile_configured', at: now, actor, target: updated.id, detail: { contextWindow, modelRef: updated.meshllm.modelRef, maxVramGb: updated.meshllm.maxVramGb ?? 0 } })
  return json({ ok: true, profileId: updated.id, contextWindow, modelRef: updated.meshllm.modelRef, maxVramGb: updated.meshllm.maxVramGb ?? 0, displayName: updated.displayName, callableNames: updated.publicAliases }, 200, requestId)
}

// handleProfileAdd creates a new inactive model profile from an operator-supplied
// mesh-llm-compatible reference and serving mode, so a model beyond the seeded set
// joins the catalog for rollout and activation without redeploying the Worker. The
// reference is trimmed and must be non-empty; mode "split" builds a layer-package
// (multi-machine) profile, anything else a single-machine profile. A reference whose
// derived id collides with an existing profile is refused rather than overwriting it.
async function handleProfileAdd(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  const actor = await requireAdmin(request, deps, now)
  if (!actor) return json({ error: 'unauthorized' }, 401, requestId)
  const body = await readJson<{ modelRef?: string; mode?: string; name?: string }>(request)
  const modelRef = typeof body?.modelRef === 'string' ? body.modelRef.trim() : ''
  if (!modelRef) return json({ error: 'invalid_model_ref', requestId }, 400, requestId)
  const split = body?.mode === 'split'
  const name = typeof body?.name === 'string' ? body.name : undefined
  const existing = await deps.store.listProfiles()
  const profile = buildCustomProfile({ modelRef, split, existing, name })
  if (existing.some((candidate) => candidate.id === profile.id)) return json({ error: 'duplicate_profile', profileId: profile.id, requestId }, 409, requestId)
  await deps.store.setProfile(profile)
  await deps.store.appendAudit({ id: requestId, type: 'profile_added', at: now, actor, target: profile.id, detail: { modelRef, split } })
  return json({ ok: true, profileId: profile.id, displayName: profile.displayName, split }, 201, requestId)
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

/**
 * REQ-ADM-016: admin-only proxy to the connected AI Gateway. Forwards through
 * the dynamic route (or the custom provider for non-route aliases) and streams
 * the response back behind fresh headers so no upstream gateway header reaches
 * the browser.
 */
/** REQ-ADM-017: lets the console render the admin vs read-only user surface. */
async function handleWhoami(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  const viewer = await requireUser(request, deps, now)
  if (!viewer) return json({ error: 'unauthorized' }, 401, requestId)
  return json({ role: viewer.role, actor: viewer.actor }, 200, requestId)
}

async function handlePlaygroundChat(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  const viewer = await requireUser(request, deps, now)
  if (!viewer) return json({ error: 'unauthorized' }, 401, requestId)
  const body = await readOptionalObject<{ model?: unknown; messages?: unknown }>(request)
  const messages = Array.isArray(body?.messages) ? body!.messages : []
  const gateway = await deps.store.getConfig<GatewaySyncResult>('cloudflare_gateway')
  const storedSettings = await deps.store.getConfig<Partial<GatewaySettings>>('cloudflare_gateway_settings')
  const accountId = cleanString(storedSettings?.accountId) ?? deps.env.CLOUDFLARE_ACCOUNT_ID ?? deps.env.AI_GATEWAY_ACCOUNT_ID
  if (!gateway?.gatewayId || !gateway.routeName || !accountId) return json({ error: 'gateway_not_configured', requestId }, 409, requestId)
  const selected = cleanString(body?.model) ?? gateway.publicModel
  const wireModel = selected === gateway.publicModel ? `dynamic/${gateway.routeName}` : `${gateway.providerSlug}/${selected}`
  // The mesh gateway is an Authenticated Gateway, so provider-native requests must
  // carry an AI Gateway Run token in cf-aig-authorization or the gateway rejects
  // them; fail fast with an actionable error instead of an opaque upstream 401.
  const gatewayToken = deps.env.CLOUDFLARE_API_TOKEN_RUNTIME
  if (!gatewayToken) return json({ error: 'gateway_auth_token_missing', requestId }, 503, requestId)
  const upstream = await (deps.playgroundFetcher ?? fetch)(`https://gateway.ai.cloudflare.com/v1/${accountId}/${gateway.gatewayId}/compat/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'cf-aig-authorization': `Bearer ${gatewayToken}`
    },
    body: JSON.stringify({ model: wireModel, stream: true, messages })
  })
  const headers = new Headers({
    'content-type': upstream.headers.get('content-type') ?? 'text/event-stream',
    'cache-control': 'no-store',
    'x-inference-mesh-request-id': requestId
  })
  return new Response(upstream.body, { status: upstream.status, headers })
}

interface GatewaySettings {
  readonly accountId: string
  readonly gatewayId: string
  readonly providerName: string
  readonly routeName: string
  readonly publicModel: string
  readonly workerUrl?: string
}

interface StoredCustomDomain extends CustomDomainProvisionResult {
  readonly valid?: boolean
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

function cleanString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
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

async function resolveUpstreamToken(deps: RouterDeps): Promise<string | undefined> {
  return deps.env.NODE_UPSTREAM_TOKEN ?? await deps.store.getConfig<string>('node_upstream_token')
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

interface HostGate {
  readonly locked: boolean
  readonly hostname: string
  readonly recovery: boolean
}

/** REQ-ADM-014: after completion, only the custom domain serves the console and machine routes. */
async function resolveHostGate(deps: RouterDeps, url: URL): Promise<HostGate> {
  const phase = await setupPhase(deps.store)
  if (phase !== 'complete') return { locked: false, hostname: '', recovery: false }
  const domain = await deps.store.getConfig<StoredCustomDomain>('custom_domain')
  if (domain?.status !== 'provisioned' || url.hostname === domain.hostname) return { locked: false, hostname: '', recovery: false }
  return { locked: true, hostname: domain.hostname, recovery: await breakGlassActive(deps.store, deps.env) }
}

/** REQ-ADM-013: audit recovery entry once per reopen-secret value. */
async function recordBreakGlassEntry(deps: RouterDeps, requestId: string, now: number): Promise<void> {
  if (!deps.env.SETUP_REOPEN) return
  const digest = await hashToken(deps.env.SETUP_REOPEN)
  if ((await deps.store.getConfig<string>(SETUP_REOPEN_SEEN_KEY)) === digest) return
  await deps.store.putConfig(SETUP_REOPEN_SEEN_KEY, digest)
  await deps.store.appendAudit({ id: requestId, type: 'break_glass_entered', at: now, actor: 'recovery', detail: {} })
}

type ConsoleRole = 'admin' | 'user'

interface RoleVerdict {
  readonly role: ConsoleRole
  readonly actor: string
}

/**
 * REQ-SEC-009 / REQ-SEC-010: resolve the caller's console role. During bootstrap
 * (no Access config) or break-glass the bearer bootstrap token is admin. Once
 * Access is configured, identity comes from the verified Access JWT plus a live
 * group lookup: an admin group/email match is admin (admin wins over user);
 * otherwise a user group/email match — or any verified identity when no user set
 * is configured — is a read-only user; anyone else is refused.
 */
async function resolveRole(request: Request, deps: RouterDeps, now: number): Promise<RoleVerdict | undefined> {
  const access = await accessConfig(deps.store)
  if (!access) {
    return (await authenticateKind(request, deps, 'admin', now, deps.env.ADMIN_TOKEN)) ? { role: 'admin', actor: 'admin' } : undefined
  }
  const verdict = await verifyAccessRequest(request, { teamDomain: access.teamDomain, audience: access.audience }, now, deps.jwksFetcher ?? fetch)
  if (verdict.outcome === 'absent' && await breakGlassActive(deps.store, deps.env)) {
    return (await authenticateKind(request, deps, 'admin', now, deps.env.ADMIN_TOKEN)) ? { role: 'admin', actor: 'admin' } : undefined
  }
  if (verdict.outcome !== 'verified') return undefined
  const email = verdict.email
  // Configured emails are lowercased at capture; match the JWT claim case-insensitively
  // so a mixed-case IdP email never locks out the admin it names.
  const emailKey = email.toLowerCase()
  const adminEmails = access.adminEmails ?? []
  const adminGroups = access.adminGroups ?? []
  const userEmails = access.userEmails ?? []
  const userGroups = access.userGroups ?? []
  const groups = await fetchIdentityGroups(request, access.teamDomain, deps.identityFetcher ?? deps.jwksFetcher ?? fetch)
  const inAny = (names: readonly string[]) => names.length > 0 && names.some((name) => groups.includes(name))
  if (adminEmails.includes(emailKey) || inAny(adminGroups)) return { role: 'admin', actor: email }
  const usersOpen = userEmails.length === 0 && userGroups.length === 0
  if (usersOpen || userEmails.includes(emailKey) || inAny(userGroups)) return { role: 'user', actor: email }
  return undefined
}

/** Admin-only gate: config writes require the admin role. */
async function requireAdmin(request: Request, deps: RouterDeps, now: number): Promise<string | undefined> {
  const verdict = await resolveRole(request, deps, now)
  return verdict?.role === 'admin' ? verdict.actor : undefined
}

/** Reader gate: any verified console role (admin or user) may read status + use the playground. */
async function requireUser(request: Request, deps: RouterDeps, now: number): Promise<RoleVerdict | undefined> {
  return await resolveRole(request, deps, now)
}

/**
 * Machine gate for the `/api/v1` control plane. Authenticates a scoped, revocable
 * automation key presented as a bearer token — no Cloudflare Access session — so
 * fleet managers and MDM can orchestrate the mesh programmatically. Returns the
 * matched token record, or undefined when the key is missing, unknown, revoked, or expired.
 */
async function requireAutomation(request: Request, deps: RouterDeps, now: number): Promise<TokenRecord | undefined> {
  return await authenticateAnyStoredToken(request, deps.store, 'automation', now)
}

async function handleApiKeyCreate(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  const actor = await requireAdmin(request, deps, now)
  if (!actor) return json({ error: 'unauthorized' }, 401, requestId)
  const token = generateBearerToken('automation')
  const record = await createTokenRecord('automation', token, now)
  await deps.store.putToken(record)
  await deps.store.appendAudit({ id: requestId, type: 'automation_key_created', at: now, actor, detail: { keyId: record.id } })
  return json({ id: record.id, token, createdAt: record.createdAt }, 201, requestId)
}

async function handleApiKeyList(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  const actor = await requireAdmin(request, deps, now)
  if (!actor) return json({ error: 'unauthorized' }, 401, requestId)
  const keys = (await deps.store.listTokens('automation'))
    .filter((token) => token.active)
    .map((token) => ({ id: token.id, createdAt: token.createdAt }))
  return json({ keys }, 200, requestId)
}

async function handleApiKeyRevoke(request: Request, deps: RouterDeps, url: URL, requestId: string, now: number): Promise<Response> {
  const actor = await requireAdmin(request, deps, now)
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
  const actor = await requireAdmin(request, deps, now)
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
  const nodes = await deps.store.listNodes(now)
  const profiles = await deps.store.listProfiles()
  const desiredVersion = await desiredAgentVersion(deps.store)
  return json({
    generatedAt: now,
    nodes: { total: nodes.length, online: nodes.filter((node) => node.status === 'online').length },
    models: { total: profiles.length, active: profiles.filter((profile) => profile.active).length },
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
function toApiNode(node: NodeRecord) {
  return {
    id: node.id,
    displayName: node.displayName,
    status: node.status,
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
    maxVramGbOverride: node.maxVramGbOverride ?? null
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
  return json({ nodes: page.map(toApiNode), nextCursor }, 200, requestId)
}

async function handleApiNodeGet(request: Request, deps: RouterDeps, url: URL, requestId: string, now: number): Promise<Response> {
  if (!(await requireAutomation(request, deps, now))) return json({ error: 'unauthorized' }, 401, requestId)
  const nodeId = decodeURIComponent(url.pathname.split('/')[4] ?? '')
  const node = (await deps.store.listNodes(now)).find((candidate) => candidate.id === nodeId)
  if (!node) return json({ error: 'not_found', requestId }, 404, requestId)
  return json({ node: toApiNode(node) }, 200, requestId)
}

/** Decommission a node: revoke it and its node/mesh tokens so it must re-enroll. */
// handleApiNodeReconfigure sets or clears a node's per-node VRAM override for an automation caller,
// mirroring the admin console control so MDM/fleet tooling can cap weaker nodes.
async function handleApiNodeReconfigure(request: Request, deps: RouterDeps, url: URL, requestId: string, now: number): Promise<Response> {
  const automation = await requireAutomation(request, deps, now)
  if (!automation) return json({ error: 'unauthorized' }, 401, requestId)
  const nodeId = decodeURIComponent(url.pathname.split('/').at(-2) ?? '')
  const node = await deps.store.getNode(nodeId)
  if (!node || node.status === 'revoked') return json({ error: 'unknown_node', requestId }, 404, requestId)
  const body = await readJson<{ maxVramGbOverride?: number | null }>(request)
  const updated = nodeWithVramOverride(node, body?.maxVramGbOverride)
  if (updated === INVALID_MAX_VRAM) return json({ error: 'invalid_max_vram', requestId }, 400, requestId)
  await deps.store.upsertNode(updated)
  await deps.store.appendAudit({ id: requestId, type: 'node_reconfigured', at: now, actor: `automation:${automation.id}`, target: nodeId, detail: { maxVramGbOverride: updated.maxVramGbOverride ?? null } })
  return json({ ok: true, node: toApiNode(updated) }, 200, requestId)
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

/** Machine-facing model projection: identity, the names callers use, and rollout state. */
function toApiModel(profile: ModelProfile) {
  return {
    id: profile.id,
    displayName: profile.displayName,
    callableNames: profile.publicAliases,
    active: profile.active,
    rolloutPercent: profile.rolloutPercent,
    contextWindow: profile.contextWindow,
    modelRef: profile.meshllm.modelRef,
    split: profile.meshllm.split,
    maxVramGb: profile.meshllm.maxVramGb ?? 0
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
  const body = await readJson<{ modelRef?: string; mode?: string; name?: string }>(request)
  const modelRef = typeof body?.modelRef === 'string' ? body.modelRef.trim() : ''
  if (!modelRef) return json({ error: 'invalid_model_ref', requestId }, 400, requestId)
  const split = body?.mode === 'split'
  const name = typeof body?.name === 'string' ? body.name : undefined
  const existing = await deps.store.listProfiles()
  const profile = buildCustomProfile({ modelRef, split, existing, name })
  if (existing.some((candidate) => candidate.id === profile.id)) return json({ error: 'duplicate_profile', profileId: profile.id, requestId }, 409, requestId)
  await deps.store.setProfile(profile)
  await deps.store.appendAudit({ id: requestId, type: 'profile_added', at: now, actor: `automation:${automation.id}`, target: profile.id, detail: { modelRef, split } })
  return json({ ok: true, model: toApiModel(profile) }, 201, requestId)
}

// classifyModelDeletion is the single deletion rule the console and API both obey so
// they never diverge: a model can be removed only when it is a custom (non-default)
// profile that is switched off. A default profile re-seeds on boot, and deleting the
// active model would 404 the stable codeflare-mesh route, so both are refused.
function classifyModelDeletion(profiles: readonly ModelProfile[], profileId: string): { profile: ModelProfile } | { error: string; status: number } {
  const profile = profiles.find((candidate) => candidate.id === profileId)
  if (!profile) return { error: 'unknown_profile', status: 404 }
  if (isDefaultModelId(profileId)) return { error: 'model_builtin', status: 409 }
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

async function handleApiModelConfigure(request: Request, deps: RouterDeps, url: URL, requestId: string, now: number): Promise<Response> {
  const automation = await requireAutomation(request, deps, now)
  if (!automation) return json({ error: 'unauthorized' }, 401, requestId)
  const profileId = decodeURIComponent(url.pathname.split('/')[4] ?? '')
  const body = await readJson<{ contextWindow?: number; modelRef?: string; maxVramGb?: number; name?: string; callName?: string }>(request)
  if (!body) return json({ error: 'invalid_model_config', requestId }, 400, requestId)
  const profiles = await deps.store.listProfiles()
  const existing = profiles.find((profile) => profile.id === profileId)
  if (!existing) return json({ error: 'unknown_profile', requestId }, 404, requestId)
  const contextWindow = body.contextWindow ?? existing.contextWindow
  if (!Number.isInteger(contextWindow) || contextWindow <= 0) return json({ error: 'invalid_context_window', requestId }, 400, requestId)
  const maxVram = resolveMaxVram(body.maxVramGb)
  if (maxVram === INVALID_MAX_VRAM) return json({ error: 'invalid_max_vram', requestId }, 400, requestId)
  let meshllm = existing.meshllm
  let upstreamModel = existing.upstreamModel
  if (body.modelRef !== undefined) {
    const modelRef = typeof body.modelRef === 'string' ? body.modelRef.trim() : ''
    if (!modelRef) return json({ error: 'invalid_model_ref', requestId }, 400, requestId)
    meshllm = { ...meshllm, modelRef }
    upstreamModel = modelRef
  }
  if (maxVram !== undefined) meshllm = { ...meshllm, maxVramGb: maxVram }
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
    const alias = slugify(typeof body.callName === 'string' ? body.callName : '')
    if (!alias) return json({ error: 'invalid_call_name', requestId }, 400, requestId)
    if (alias === STABLE_PUBLIC_MODEL) return json({ error: 'call_name_conflict', requestId }, 409, requestId)
    if (profiles.some((profile) => profile.id !== existing.id && profile.publicAliases.includes(alias))) return json({ error: 'call_name_conflict', requestId }, 409, requestId)
    publicAliases = [STABLE_PUBLIC_MODEL, alias]
  }
  const updated: ModelProfile = { ...existing, contextWindow, upstreamModel, meshllm, displayName, publicAliases, version: existing.version + 1 }
  await deps.store.setProfile(updated)
  await deps.store.appendAudit({ id: requestId, type: 'profile_configured', at: now, actor: `automation:${automation.id}`, target: updated.id, detail: { contextWindow, modelRef: updated.meshllm.modelRef } })
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

async function authenticateKind(request: Request, deps: RouterDeps, kind: CredentialKind, now: number, envSecret?: string): Promise<boolean> {
  const presented = bearerToken(request)
  if (await verifyPlainOrHashed(envSecret, presented)) return true
  return Boolean(await authenticateAnyStoredToken(request, deps.store, kind, now))
}

async function authenticateAnyStoredToken(request: Request, store: Store, kind: CredentialKind, now: number): Promise<TokenRecord | undefined> {
  const presented = bearerToken(request)
  const tokens = await store.listTokens(kind)
  for (const token of tokens) {
    if (await verifyToken(presented, token, now)) return token
  }
  return undefined
}

async function authenticateTokenByNode(request: Request, store: Store, kind: CredentialKind, nodeId: string, now: number): Promise<TokenRecord | undefined> {
  const presented = bearerToken(request)
  const tokens = await store.listTokens(kind)
  for (const token of tokens) {
    if (token.nodeId === nodeId && await verifyToken(presented, token, now)) return token
  }
  return undefined
}

function json(body: unknown, status: number, requestId: string): Response {
  return Response.json(body, { status, headers: { ...JSON_HEADERS, 'x-inference-mesh-request-id': requestId } })
}

function rateLimited(requestId: string): Response {
  return Response.json({ error: 'rate_limited', requestId }, { status: 429, headers: { ...JSON_HEADERS, 'x-inference-mesh-request-id': requestId, 'retry-after': '60' } })
}

function html(body: string, requestId: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      'content-security-policy': "frame-ancestors 'none'",
      'content-type': 'text/html; charset=utf-8',
      'x-frame-options': 'DENY',
      'x-inference-mesh-request-id': requestId
    }
  })
}

// Thrown only when a request BODY fails to parse as JSON, so the top-level catch can answer
// 400 invalid_json for that client error without also swallowing server-side JSON.parse faults
// (stored-record reads, decrypt) — those must still surface as an audited 500.
class InvalidJsonBodyError extends Error {}

async function readJson<T>(request: Request): Promise<T> {
  try {
    return await request.json() as T
  } catch {
    throw new InvalidJsonBodyError()
  }
}

async function readOptionalObject<T>(request: Request): Promise<T | undefined> {
  const text = await request.text()
  return text ? parseObject(text) as T | undefined : undefined
}

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

function sessionIdFor(request: Request, body: Record<string, unknown>, requestId: string): string {
  const header = request.headers.get('x-inference-mesh-session')
  if (header) return header
  const metadata = body.metadata
  if (metadata && typeof metadata === 'object') {
    const record = metadata as Record<string, unknown>
    if (typeof record.sessionId === 'string') return record.sessionId
  }
  return `req-${requestId}`
}

function responseMetadataHeaders(upstream: Headers, requestId: string, sessionId: string, nodeId: string): Headers {
  const headers = new Headers(upstream)
  headers.set('x-inference-mesh-request-id', requestId)
  headers.set('x-inference-mesh-session', sessionId)
  headers.set('x-inference-mesh-node', nodeId)
  return headers
}

function releaseOnCompletion(response: Response, headers: Headers, release: () => Promise<void>, recordFailure: () => Promise<void>): Response {
  if (!response.body) {
    void release()
    return new Response(null, { status: response.status, headers })
  }
  const reader = response.body.getReader()
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const chunk = await reader.read()
        if (chunk.done) {
          controller.close()
          await release()
          return
        }
        controller.enqueue(chunk.value)
      } catch (error) {
        await recordFailure()
        throw error
      }
    },
    async cancel(reason) {
      await reader.cancel(reason)
      await release()
    }
  })
  return new Response(stream, { status: response.status, headers })
}

function validateClaim(body: ClaimRequest | undefined): string[] {
  if (!body) return ['displayName', 'meshIp', 'inferencePort', 'publicModels', 'activeProfileIds', 'capacity']
  const errors: string[] = []
  if (!body.displayName) errors.push('displayName')
  if (!body.meshIp) errors.push('meshIp')
  if (!Number.isInteger(body.inferencePort)) errors.push('inferencePort')
  if (!Array.isArray(body.publicModels)) errors.push('publicModels')
  if (!Array.isArray(body.activeProfileIds)) errors.push('activeProfileIds')
  if (!Number.isInteger(body.capacity) || body.capacity < 1) errors.push('capacity')
  return errors
}

function stableNodeId(displayName: string, meshIp: string): string {
  return `${displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${meshIp.replace(/\./g, '-')}`
}

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
