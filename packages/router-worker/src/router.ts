import { accessJwtSource, extractAccessJwt, fetchIdentityGroups, verifyAccessRequest } from './access'
import { CloudflareAccessClient, type AccessProvisionRequest, type AccessProvisionResult } from './access-provisioning'
import { adminUiHtml, type AdminUiState } from './admin-ui'
import { consoleMovedHtml } from './admin-ui-views'
import { desiredAgentVersion, handleAgentVersionSelect, handleAgentVersionsList } from './agent-versions'
import { approvedNodeHeaders, bearerToken, createTokenRecord, generateBearerToken, hashToken, redactSecrets, verifyPlainOrHashed, verifyToken } from './auth'
import { CloudflareGatewayClient, type CustomDomainProvisionRequest, type CustomDomainProvisionResult, type GatewayProvisionStatus, type GatewayRecord, type GatewaySyncRequest, type GatewaySyncResult, type RouteRecord, type ZoneRecord } from './cloudflare-api'
import { decideDirectSession, directSessionKey, type DirectSessionDecision, type DirectSessionDecisionRequest } from './direct-affinity'
import { InvalidJsonBodyError } from './errors'
import { installerCommand, installScript, SETUP_TOKEN_PLACEHOLDER, validateCustomDomain, type InstallerPlatform } from './installers'
import { applyHeartbeatMeshState, handleMeshRotate, meshBootstrapFor, meshHealth, removeNodeMeshTokens } from './mesh-state'
import { createMesh, deleteMesh, listMeshes, meshAliasFor, validateMeshName } from './meshes'
import { buildCustomProfile, buildDuplicateProfile, DEFAULT_MODEL_PROFILES, nodeMeshId, profileMeshId, slugify, STABLE_PUBLIC_MODEL } from './profiles'
import { isRateLimited } from './rate-limit'
import { desiredRuntimeVersions, handleRuntimeVersionsList, handleRuntimeVersionsSelect } from './runtime-versions'
import { eligibleDirectNodes, isSafeMeshTarget, meshUrl } from './scheduler'
import { ACCESS_CONFIG_KEY, SETUP_REOPEN_CONSUMED_KEY, SETUP_REOPEN_SEEN_KEY, accessConfig, advancePhase, breakGlassActive, setupPhase } from './setup-state'
import { singleActiveActivation } from './store'
import type { ClaimRequest, CredentialKind, HeartbeatRequest, LastSpeedTestSummary, LlamaCppProfileSettings, ModelProfile, NodeRecord, RouterEnv, RuntimeKind, Scheduler, Store, TokenRecord } from './types'

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' }
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024
const SETUP_TOKEN_TTL_MS = 24 * 60 * 60 * 1000
const LAST_SPEED_TEST_CONFIG_KEY = 'last_speed_test'

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
      if (url.pathname === '/admin/cloudflare/gateway/provision-status' && request.method === 'GET') return await handleGatewayProvisionStatus(request, deps, url, id, now())
      if (url.pathname.match(/^\/admin\/nodes\/[^/]+\/revoke$/) && request.method === 'POST') return await handleNodeRevoke(request, deps, url, id, now())
      if (url.pathname.match(/^\/admin\/nodes\/[^/]+\/deactivate$/) && request.method === 'POST') return await handleNodeDeactivate(request, deps, url, id, now())
      if (url.pathname.match(/^\/admin\/nodes\/[^/]+\/activate$/) && request.method === 'POST') return await handleNodeActivate(request, deps, url, id, now())
      if (url.pathname.match(/^\/admin\/nodes\/[^/]+\/reload$/) && request.method === 'POST') return await handleNodeReload(request, deps, url, id, now())
      if (url.pathname.match(/^\/admin\/nodes\/[^/]+\/config$/) && request.method === 'POST') return await handleNodeConfig(request, deps, url, id, now())
      if (url.pathname === '/admin/meshes' && request.method === 'GET') return await handleMeshList(request, deps, id, now())
      if (url.pathname === '/admin/meshes' && request.method === 'POST') return await handleMeshCreate(request, deps, id, now())
      if (url.pathname.match(/^\/admin\/meshes\/[^/]+$/) && request.method === 'DELETE') return await handleMeshDelete(request, deps, url, id, now())
      if (url.pathname === '/admin/profiles/rollout' && request.method === 'POST') return await handleProfileRollout(request, deps, id, now())
      if (url.pathname === '/admin/profiles/activate' && request.method === 'POST') return await handleProfileActivate(request, deps, id, now())
      if (url.pathname === '/admin/profiles/add' && request.method === 'POST') return await handleProfileAdd(request, deps, id, now())
      if (url.pathname === '/admin/profiles/config' && request.method === 'POST') return await handleProfileConfig(request, deps, id, now())
      if (url.pathname === '/admin/profiles/delete' && request.method === 'POST') return await handleProfileDelete(request, deps, id, now())
      if (url.pathname === '/admin/profiles/duplicate' && request.method === 'POST') return await handleProfileDuplicate(request, deps, id, now())
      if (url.pathname === '/admin/settings' && request.method === 'POST') return await handleAdminSettings(request, deps, id, now())
      if (url.pathname === '/admin/runtime-versions' && request.method === 'GET') return await handleAdminRuntimeVersions(request, deps, id, now())
      if (url.pathname === '/admin/runtime-versions' && request.method === 'POST') return await handleAdminRuntimeVersionSelect(request, deps, id, now())
      if (url.pathname === '/admin/mesh/rotate' && request.method === 'POST') return await handleAdminMeshRotate(request, deps, id, now())
      if (url.pathname === '/admin/agent-versions' && request.method === 'GET') return await handleAdminAgentVersions(request, deps, id, now())
      if (url.pathname === '/admin/agent-version' && request.method === 'POST') return await handleAdminAgentVersionSelect(request, deps, id, now())
      if (url.pathname === '/admin/playground/chat' && request.method === 'POST') return await handlePlaygroundChat(request, deps, id, now())
      if (url.pathname === '/admin/playground/direct-chat' && request.method === 'POST') return await handlePlaygroundDirect(request, deps, id, now())
      if (url.pathname === '/admin/playground/speed-test' && request.method === 'POST') return await handlePlaygroundSpeedTest(request, deps, id, now())
      if (url.pathname === '/admin/whoami' && request.method === 'GET') return await handleWhoami(request, deps, id, now())
      if (url.pathname === '/api/v1/keys' && request.method === 'POST') return await handleApiKeyCreate(request, deps, id, now())
      if (url.pathname === '/api/v1/keys' && request.method === 'GET') return await handleApiKeyList(request, deps, id, now())
      if (url.pathname.match(/^\/api\/v1\/keys\/[^/]+\/rotate$/) && request.method === 'POST') return await handleApiKeyRotate(request, deps, url, id, now())
      if (url.pathname.match(/^\/api\/v1\/keys\/[^/]+$/) && request.method === 'DELETE') return await handleApiKeyRevoke(request, deps, url, id, now())
      if (url.pathname === '/api/v1/status' && request.method === 'GET') return await handleApiStatus(request, deps, id, now())
      if (url.pathname === '/api/v1/speed-test' && request.method === 'POST') return await handleApiSpeedTest(request, deps, id, now())
      if (url.pathname === '/api/v1/gateway/sync' && request.method === 'POST') return await handleApiGatewaySync(request, deps, id, now())
      if (url.pathname === '/api/v1/enrollment-tokens' && request.method === 'POST') return await handleApiEnrollmentToken(request, deps, id, now())
      if (url.pathname === '/api/v1/nodes' && request.method === 'GET') return await handleApiNodeList(request, deps, url, id, now())
      if (url.pathname.match(/^\/api\/v1\/nodes\/[^/]+$/) && request.method === 'GET') return await handleApiNodeGet(request, deps, url, id, now())
      if (url.pathname.match(/^\/api\/v1\/nodes\/[^/]+\/reconfigure$/) && request.method === 'POST') return await handleApiNodeReconfigure(request, deps, url, id, now())
      if (url.pathname.match(/^\/api\/v1\/nodes\/[^/]+\/deactivate$/) && request.method === 'POST') return await handleApiNodeDeactivate(request, deps, url, id, now())
      if (url.pathname.match(/^\/api\/v1\/nodes\/[^/]+\/activate$/) && request.method === 'POST') return await handleApiNodeActivate(request, deps, url, id, now())
      if (url.pathname.match(/^\/api\/v1\/nodes\/[^/]+\/reload$/) && request.method === 'POST') return await handleApiNodeReload(request, deps, url, id, now())
      if (url.pathname.match(/^\/api\/v1\/nodes\/[^/]+$/) && request.method === 'DELETE') return await handleApiNodeDecommission(request, deps, url, id, now())
      if (url.pathname === '/api/v1/models' && request.method === 'GET') return await handleApiModelList(request, deps, id, now())
      if (url.pathname === '/api/v1/models' && request.method === 'POST') return await handleApiModelAdd(request, deps, id, now())
      if (url.pathname.match(/^\/api\/v1\/models\/[^/]+\/enable$/) && request.method === 'POST') return await handleApiModelEnable(request, deps, url, id, now())
      if (url.pathname.match(/^\/api\/v1\/models\/[^/]+\/disable$/) && request.method === 'POST') return await handleApiModelDisable(request, deps, url, id, now())
      if (url.pathname.match(/^\/api\/v1\/models\/[^/]+\/duplicate$/) && request.method === 'POST') return await handleApiModelDuplicate(request, deps, url, id, now())
      if (url.pathname.match(/^\/api\/v1\/models\/[^/]+$/) && request.method === 'DELETE') return await handleApiModelDelete(request, deps, url, id, now())
      if (url.pathname.match(/^\/api\/v1\/models\/[^/]+$/) && request.method === 'POST') return await handleApiModelConfigure(request, deps, url, id, now())
      if (url.pathname === '/api/v1/agent-versions' && request.method === 'GET') return await handleApiAgentVersions(request, deps, id, now())
      if (url.pathname === '/api/v1/agent-version' && request.method === 'PUT') return await handleApiAgentVersionSet(request, deps, id, now())
      if (url.pathname === '/api/v1/mesh/rotate' && request.method === 'POST') return await handleApiMeshRotate(request, deps, id, now())
      if (url.pathname === '/api/v1/settings' && request.method === 'GET') return await handleApiSettingsGet(request, deps, id, now())
      if (url.pathname === '/api/v1/settings' && request.method === 'PUT') return await handleApiSettingsSet(request, deps, id, now())
      if (url.pathname === '/api/v1/runtime-versions' && request.method === 'GET') return await handleApiRuntimeVersions(request, deps, id, now())
      if (url.pathname === '/api/v1/runtime-versions' && request.method === 'PUT') return await handleApiRuntimeVersionSet(request, deps, id, now())
      if (url.pathname === '/api/v1/meshes' && request.method === 'GET') return await handleApiMeshList(request, deps, id, now())
      if (url.pathname === '/api/v1/meshes' && request.method === 'POST') return await handleApiMeshCreate(request, deps, id, now())
      if (url.pathname.match(/^\/api\/v1\/meshes\/[^/]+$/) && request.method === 'DELETE') return await handleApiMeshDelete(request, deps, url, id, now())
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

// The forward path shared by the provider `/v1/chat/completions` route and the admin
// Playground's direct target. Mesh profiles keep the stateless mesh-llm entry selection;
// direct llama.cpp profiles require a stable `body.user` and use session affinity so a
// coding conversation stays on the same cache-warm node. REQ-SCH-002 / REQ-SCH-004.
async function runInference(deps: RouterDeps, input: { body: Record<string, unknown>; requestHeaders: Headers; requestId: string; now: number }): Promise<Response> {
  const publicModel = routablePublicModel(input.body.model as string)
  const profile = await deps.store.getProfileByPublicModel(publicModel)
  if (!profile) return json({ error: 'no-profile', requestId: input.requestId }, 404, input.requestId)
  const normalized = { ...input, body: { ...input.body, model: publicModel } }
  if (profile.runtime === 'llamacpp') return runDirectLlamaCppInference(deps, { ...normalized, body: directSessionBody(normalized.body, input.requestHeaders) }, publicModel, profile)
  return runMeshInference(deps, normalized)
}

function routablePublicModel(model: string): string {
  return model.startsWith('dynamic/') ? model.slice('dynamic/'.length) : model
}

async function runMeshInference(deps: RouterDeps, input: { body: Record<string, unknown>; requestHeaders: Headers; requestId: string; now: number }): Promise<Response> {
  const publicModel = input.body.model as string
  const selection = await deps.scheduler.selectEntryNode({ publicModel, now: input.now })
  if (!selection.node || !selection.profile) {
    if (selection.reason === 'no-profile') return json({ error: 'no-profile', requestId: input.requestId }, 404, input.requestId)
    return json({ error: 'no_healthy_node', requestId: input.requestId }, 503, input.requestId)
  }
  return forwardInference(deps, input, selection.node, selection.profile)
}

async function runDirectLlamaCppInference(deps: RouterDeps, input: { body: Record<string, unknown>; requestHeaders: Headers; requestId: string; now: number }, publicModel: string, profile: ModelProfile): Promise<Response> {
  const session = parseDirectSession(input.body.user)
  if (!session) {
    await deps.store.appendAudit({ id: input.requestId, type: 'direct_session_rejected', at: input.now, actor: 'provider', target: profile.id, detail: { publicModel, reason: 'invalid_user' } })
    return json({ error: 'session_required', message: 'llamacpp profiles require body.user formatted as user:<id>|session:<id>', requestId: input.requestId }, 400, input.requestId)
  }
  const secret = directAffinitySecret(deps.env)
  if (!secret) return json({ error: 'session_affinity_key_missing', requestId: input.requestId }, 503, input.requestId)
  const userHash = `hmac-sha256:${await hmacHex(secret, session.userId)}`
  const sessionHash = `hmac-sha256:${await hmacHex(secret, session.sessionId)}`
  const affinityHash = `hmac-sha256:${await hmacHex(secret, `${session.userId}|${session.sessionId}`)}`
  const candidates = eligibleDirectNodes(await deps.store.listNodes(input.now), profile, publicModel, input.now, deps.env)
  const decision = await decideDirectSessionWithAffinity(deps, {
    affinityKey: directSessionKey(publicModel, profile.id, affinityHash),
    profileId: profile.id,
    publicModel,
    userHash,
    sessionHash,
    candidates,
    now: input.now
  })
  if (!decision.node || !decision.affinity) return json({ error: 'no_healthy_node', requestId: input.requestId }, 503, input.requestId)
  await deps.store.appendAudit({ id: input.requestId, type: `direct_session_${decision.affinity === 'failed_over' ? 'failed_over' : decision.affinity}`, at: input.now, actor: 'provider', target: profile.id, detail: { profileId: profile.id, publicModel, nodeId: decision.node.id, affinityKey: decision.session?.affinityKey ?? '', userHash, sessionHash, reason: decision.affinity === 'reused' ? 'healthy_pin' : decision.affinity === 'failed_over' ? 'node_unhealthy' : 'new' } })
  const response = await forwardInference(deps, input, decision.node, profile)
  response.headers.set('x-inference-mesh-affinity', decision.affinity)
  response.headers.set('x-inference-mesh-session-node', decision.node.id)
  return response
}

async function forwardInference(deps: RouterDeps, input: { body: Record<string, unknown>; requestHeaders: Headers; requestId: string }, node: NodeRecord, profile: ModelProfile): Promise<Response> {
  const upstreamToken = await resolveUpstreamToken(deps)
  if (!upstreamToken) return json({ error: 'upstream_token_missing', requestId: input.requestId }, 503, input.requestId)

  const rewritten = JSON.stringify({ ...input.body, model: profile.upstreamModel })
  let upstream: Response
  try {
    upstream = await deps.mesh.fetch(meshUrl(node, '/v1/chat/completions', deps.env), {
      method: 'POST',
      headers: approvedNodeHeaders(input.requestHeaders, upstreamToken, input.requestId),
      body: rewritten,
      redirect: 'manual'
    })
  } catch {
    return json({ error: 'node_unreachable', requestId: input.requestId }, 502, input.requestId)
  }
  if (upstream.status >= 300 && upstream.status < 400) return json({ error: 'node_redirect_rejected', requestId: input.requestId }, 502, input.requestId)
  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseMetadataHeaders(upstream.headers, input.requestId, node.id)
  })
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
    desiredRuntimeVersions: await desiredRuntimeVersions(deps.store),
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
  const runtimeVersions = await desiredRuntimeVersions(deps.store)
  // A deactivated node is tainted: it keeps heartbeating but must run no model, so it receives no
  // desired profiles and no mesh bootstrap and is told to stay down. REQ-ADM-030 / REQ-NODE-011.
  if (next.deactivated === true) {
    return json({
      ok: true,
      desiredProfiles: [],
      desiredRuntimeVersions: runtimeVersions,
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
    desiredRuntimeVersions: runtimeVersions,
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
  const lastSpeedTest = await deps.store.getConfig<LastSpeedTestSummary>(LAST_SPEED_TEST_CONFIG_KEY)
  const statusNodes = nodes.map((node) => ({ ...node, runtimeInstall: runtimeBinaryStatus(node, runtimeVersions) }))
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
        desiredRuntimeVersions: runtimeVersions,
        audit: await deps.store.listAudit(20)
      }
    : {}
  const redacted = redactSecrets({ nodes: statusNodes, profiles, profileReadiness: profileReadiness(profiles, nodes), ...(lastSpeedTest ? { lastSpeedTest } : {}), ...adminOnly, generatedAt: now }) as Record<string, unknown>
  // meshHealth is composed after redaction: its contract carries token presence/age/count
  // fields (never values), which the key-name redactor would otherwise blank out.
  // Machine groups are visible to both console roles (the nodes table and drawers
  // render group names); the shape carries no secret-like keys. REQ-ADM-037.
  const meshes = (await listMeshes(deps.store)).map((mesh) => ({
    id: mesh.id,
    name: mesh.name,
    alias: meshAliasFor(mesh.id),
    machineCount: nodes.filter((node) => nodeMeshId(node) === mesh.id).length,
    modelCount: profiles.filter((profile) => profileMeshId(profile) === mesh.id).length
  }))
  return json({
    ...redacted,
    viewerRole: viewer.role,
    meshes,
    meshHealth: await meshHealth(deps.store, deps.env, profiles, nodes, now),
    ...(desiredVersion !== undefined ? { desiredAgentVersion: desiredVersion } : {})
  }, 200, requestId)
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
      id: mesh.id,
      name: mesh.name,
      alias: meshAliasFor(mesh.id),
      machineCount: nodes.filter((node) => nodeMeshId(node) === mesh.id).length,
      modelCount: profiles.filter((profile) => profileMeshId(profile) === mesh.id).length,
      ...(mesh.createdAt !== undefined ? { createdAt: mesh.createdAt } : {})
    }))
  }, 200, requestId)
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
const INVALID_MAX_VRAM = Symbol('invalid_max_vram')
function resolveMaxVram(value: number | undefined): number | undefined | typeof INVALID_MAX_VRAM {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return INVALID_MAX_VRAM
  return value
}

function resolveRuntime(value: unknown): RuntimeKind | 'invalid_runtime' {
  if (value === undefined || value === null || value === '') return 'meshllm'
  return value === 'meshllm' || value === 'llamacpp' ? value : 'invalid_runtime'
}

// A model's own callable alias sits alongside its mesh's stable alias. Editing it must
// preserve that mesh alias — the old hardcoded [codeflare-mesh, alias] silently
// repatriated non-default-mesh profiles — and may not take the reserved stable alias
// of any mesh (codeflare-mesh or any codeflare-mesh-*). REQ-RUN-016.
function resolveCallNameAliases(existing: ModelProfile, rawCallName: unknown, profiles: readonly ModelProfile[]): readonly string[] | { readonly error: string; readonly status: number } {
  const alias = slugify(typeof rawCallName === 'string' ? rawCallName : '')
  if (!alias) return { error: 'invalid_call_name', status: 400 }
  if (alias === STABLE_PUBLIC_MODEL || alias.startsWith(`${STABLE_PUBLIC_MODEL}-`)) return { error: 'call_name_conflict', status: 409 }
  if (profiles.some((profile) => profile.id !== existing.id && profile.publicAliases.includes(alias))) return { error: 'call_name_conflict', status: 409 }
  return [meshAliasFor(profileMeshId(existing)), alias]
}

// Applies a requested mesh reassignment to a profile before the rest of its config is
// resolved (REQ-RUN-016): the mesh's stable alias is swapped in, and the model arrives
// in its new group INACTIVE (rollout 0) so the operator activates it there explicitly.
// The caller's later version bump also protects the row from any default re-seed.
async function resolveMeshReassignment(deps: RouterDeps, existing: ModelProfile, rawMeshId: unknown): Promise<{ readonly profile: ModelProfile; readonly change?: { readonly from: string; readonly to: string } } | { readonly error: string }> {
  if (rawMeshId === undefined) return { profile: existing }
  if (typeof rawMeshId !== 'string' || !(await listMeshes(deps.store)).some((mesh) => mesh.id === rawMeshId)) return { error: 'unknown_mesh' }
  const from = profileMeshId(existing)
  if (rawMeshId === from) return { profile: existing }
  const ownAliases = existing.publicAliases.filter((alias) => alias !== meshAliasFor(from))
  return {
    profile: { ...existing, meshId: rawMeshId, publicAliases: [meshAliasFor(rawMeshId), ...ownAliases], active: false, rolloutPercent: 0 },
    change: { from, to: rawMeshId }
  }
}

interface LlamaCppConfigBody {
  readonly contextWindow?: unknown
  readonly parallel?: unknown
  readonly cachePrompt?: unknown
  readonly cacheReuse?: unknown
  readonly cacheTypeK?: unknown
  readonly cacheTypeV?: unknown
  readonly batch?: unknown
  readonly ubatch?: unknown
  readonly flashAttn?: unknown
  readonly kvUnified?: unknown
  readonly maxOutputTokens?: unknown
  readonly gpuLayers?: unknown
  readonly bindPort?: unknown
  readonly hfRepo?: unknown
  readonly hfFile?: unknown
  readonly quant?: unknown
  readonly reasoning?: unknown
}

function resolveLlamaCppSettings(existing: LlamaCppProfileSettings, value: unknown): { settings: LlamaCppProfileSettings } | { error: string } {
  if (value === undefined) return { settings: existing }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { error: 'invalid_llamacpp' }
  const body = value as LlamaCppConfigBody
  const next: Record<string, unknown> = { ...existing }
  const applyInt = (key: 'contextWindow' | 'cacheReuse' | 'bindPort', raw: unknown, min: number): string | null => {
    if (raw === undefined) return null
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < min) return `invalid_${key}`
    next[key] = raw
    return null
  }
  // parallel -1 = Auto (llama-server plans the slot count with unified KV);
  // otherwise a fixed slot count >= 1. 0 is invalid upstream and rejected here.
  const applyParallel = (raw: unknown): string | null => {
    if (raw === undefined) return null
    if (typeof raw !== 'number' || !Number.isInteger(raw) || (raw !== -1 && raw < 1)) return 'invalid_parallel'
    next.parallel = raw
    return null
  }
  const applyOptionalInt = (key: 'batch' | 'ubatch' | 'maxOutputTokens', raw: unknown, min: number): string | null => {
    if (raw === undefined) return null
    if (raw === null || raw === 0) { delete next[key]; return null }
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < min) return `invalid_${key}`
    next[key] = raw
    return null
  }
  const applyCacheType = (key: 'cacheTypeK' | 'cacheTypeV', raw: unknown): string | null => {
    if (raw === undefined) return null
    if (raw === null || raw === '') { delete next[key]; return null }
    if (typeof raw !== 'string' || !LLAMACPP_CACHE_TYPES.has(raw)) return `invalid_${key}`
    next[key] = raw
    return null
  }
  const applyGpuLayers = (raw: unknown): string | null => {
    if (raw === undefined) return null
    if (raw === null || raw === '') { delete next.gpuLayers; return null }
    if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0) { next.gpuLayers = String(raw); return null }
    if (typeof raw === 'string') {
      const trimmed = raw.trim().toLowerCase()
      if (trimmed === 'auto' || trimmed === 'all' || /^\d+$/.test(trimmed)) { next.gpuLayers = trimmed; return null }
    }
    return 'invalid_gpuLayers'
  }
  for (const err of [
    applyInt('contextWindow', body.contextWindow, 4096),
    applyParallel(body.parallel),
    applyInt('cacheReuse', body.cacheReuse, 0),
    applyInt('bindPort', body.bindPort, 1),
    applyOptionalInt('batch', body.batch, 1),
    applyOptionalInt('ubatch', body.ubatch, 1),
    applyOptionalInt('maxOutputTokens', body.maxOutputTokens, 1),
    applyCacheType('cacheTypeK', body.cacheTypeK),
    applyCacheType('cacheTypeV', body.cacheTypeV),
    applyGpuLayers(body.gpuLayers)
  ]) {
    if (err) return { error: err }
  }
  if (typeof next.bindPort === 'number' && (next.bindPort === 9337 || next.bindPort === 3131)) return { error: 'bind_port_conflict' }
  if (body.cachePrompt !== undefined) {
    if (typeof body.cachePrompt !== 'boolean') return { error: 'invalid_cachePrompt' }
    next.cachePrompt = body.cachePrompt
  }
  if (body.flashAttn !== undefined) {
    if (body.flashAttn === null) delete next.flashAttn
    else if (typeof body.flashAttn === 'boolean') next.flashAttn = body.flashAttn
    else return { error: 'invalid_flash_attn' }
  }
  if (body.kvUnified !== undefined) {
    if (body.kvUnified === null) delete next.kvUnified
    else if (typeof body.kvUnified === 'boolean') next.kvUnified = body.kvUnified
    else return { error: 'invalid_kv_unified' }
  }
  // llama-server force-enables unified KV under Auto slot planning, so an explicit
  // off with Auto parallel would silently lie; require a fixed slot count instead.
  if (next.parallel === -1 && next.kvUnified === false) return { error: 'kv_unified_auto_conflict' }
  for (const key of ['hfRepo', 'hfFile', 'quant'] as const) {
    const raw = body[key]
    if (raw === undefined) continue
    if (raw === null || raw === '') delete next[key]
    else if (typeof raw === 'string') next[key] = raw.trim()
    else return { error: `invalid_${key}` }
  }
  if (typeof next.hfRepo !== 'string' || next.hfRepo.length === 0) return { error: 'invalid_hfRepo' }
  if (body.reasoning !== undefined) {
    if (body.reasoning === null) delete next.reasoning
    else {
      const reasoning = resolveReasoning(existing.reasoning, body.reasoning)
      if ('error' in reasoning) return reasoning
      if (Object.keys(reasoning.value).length === 0) delete next.reasoning
      else next.reasoning = reasoning.value
    }
  }
  return { settings: next as unknown as LlamaCppProfileSettings }
}

type NodeConfigBody = { readonly maxVramGbOverride?: number | null; readonly displayName?: unknown; readonly name?: unknown; readonly meshId?: unknown }
const INVALID_NODE_NAME = Symbol('invalid_node_name')

function normalizeNodeDisplayName(value: unknown): string | undefined | typeof INVALID_NODE_NAME {
  if (value === undefined) return undefined
  if (typeof value !== 'string') return INVALID_NODE_NAME
  const trimmed = value.trim()
  return trimmed.length > 0 && trimmed.length <= 80 ? trimmed : INVALID_NODE_NAME
}

// A node's VRAM override replaces the model's global maxVramGb for that node. `null` clears the
// override (revert to the model default); a finite number >= 0 sets it (0 = uncapped on this node).
function nodeWithVramOverride(node: NodeRecord, value: number | null | undefined): NodeRecord | typeof INVALID_MAX_VRAM {
  if (value === undefined) return node
  if (value === null) {
    const { maxVramGbOverride, ...rest } = node
    void maxVramGbOverride
    return rest
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return INVALID_MAX_VRAM
  return { ...node, maxVramGbOverride: value }
}

function nodeWithConfig(node: NodeRecord, body: NodeConfigBody | undefined): NodeRecord | typeof INVALID_MAX_VRAM | typeof INVALID_NODE_NAME {
  let updated: NodeRecord | typeof INVALID_MAX_VRAM = nodeWithVramOverride(node, body?.maxVramGbOverride)
  if (updated === INVALID_MAX_VRAM) return updated
  const nextName = normalizeNodeDisplayName(body?.displayName ?? body?.name)
  if (nextName === INVALID_NODE_NAME) return nextName
  if (nextName !== undefined) updated = { ...updated, displayName: nextName }
  return updated
}

// Apply a node's VRAM override to the profile set it will run, so the agent renders --max-vram
// at the node's ceiling instead of the model's global budget.
function applyNodeVramOverride(profiles: readonly ModelProfile[], override: number | undefined): readonly ModelProfile[] {
  if (override === undefined) return profiles
  return profiles.map((profile) => profile.runtime === 'meshllm' && profile.meshllm ? { ...profile, meshllm: { ...profile.meshllm, maxVramGb: override } } : profile)
}

const MESHLLM_CACHE_TYPES = new Set(['f16', 'q8_0', 'q4_0'])
const LLAMACPP_CACHE_TYPES = new Set(['f32', 'f16', 'bf16', 'q8_0', 'q4_0', 'q4_1', 'iq4_nl', 'q5_0', 'q5_1'])

interface MeshllmTunablesBody {
  parallel?: unknown
  cacheTypeK?: unknown
  cacheTypeV?: unknown
  batch?: unknown
  ubatch?: unknown
  flashAttn?: unknown
  maxOutputTokens?: unknown
  reasoning?: unknown
  prefixCache?: unknown
}

// resolveReasoning layers a reasoning update onto the existing block, per sub-field,
// exactly like the scalar tunables: a present valid value sets it, an explicit null /
// "" / 0 clears it (removed, never undefined), and an absent field is preserved. This
// keeps partial updates (one sub-field) from dropping the others while still allowing
// each sub-field to be cleared back to Auto.
function resolveReasoning(existing: { enabled?: boolean; format?: string; budget?: number } | undefined, value: unknown): { value: { enabled?: boolean; format?: string; budget?: number } } | { error: string } {
  if (typeof value !== 'object' || value === null) return { error: 'invalid_reasoning' }
  const input = value as { enabled?: unknown; format?: unknown; budget?: unknown }
  const next: { enabled?: boolean; format?: string; budget?: number } = { ...(existing ?? {}) }
  if (input.enabled !== undefined) {
    if (input.enabled === null) delete next.enabled
    else if (typeof input.enabled === 'boolean') next.enabled = input.enabled
    else return { error: 'invalid_reasoning' }
  }
  if (input.format !== undefined) {
    if (input.format === null || input.format === '') delete next.format
    else if (typeof input.format === 'string') next.format = input.format
    else return { error: 'invalid_reasoning' }
  }
  if (input.budget !== undefined) {
    if (input.budget === null || input.budget === 0) delete next.budget
    else if (typeof input.budget === 'number' && Number.isInteger(input.budget) && input.budget >= 1) next.budget = input.budget
    else return { error: 'invalid_reasoning' }
  }
  return { value: next }
}

// resolvePrefixCache layers a prefix-cache update onto the existing block per
// sub-field, like resolveReasoning: a present valid value sets it, null / 0 / ""
// clears it (removed, never undefined), an absent field is preserved. maxEntries is
// bounded to [1, 128] so an operator cannot re-introduce the pool-overrun the low
// default avoids (REQ-RUN-002 / REQ-RUN-003).
type PrefixCacheBlock = { enabled?: boolean; maxEntries?: number; payloadMode?: string; sharedStrideTokens?: number; sharedRecordLimit?: number }
const MESHLLM_PAYLOAD_MODES = new Set(['resident-kv', 'kv-recurrent', 'full-state'])
function resolvePrefixCache(existing: PrefixCacheBlock | undefined, value: unknown): { value: PrefixCacheBlock } | { error: string } {
  if (typeof value !== 'object' || value === null) return { error: 'invalid_prefix_cache' }
  const input = value as { enabled?: unknown; maxEntries?: unknown; payloadMode?: unknown; sharedStrideTokens?: unknown; sharedRecordLimit?: unknown }
  const next: PrefixCacheBlock = { ...(existing ?? {}) }
  const applyInt = (key: 'maxEntries' | 'sharedStrideTokens' | 'sharedRecordLimit', v: unknown, max: number): boolean => {
    if (v === undefined) return true
    if (v === null || v === 0) { delete next[key]; return true }
    if (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= max) { next[key] = v; return true }
    return false
  }
  if (input.enabled !== undefined) {
    if (input.enabled === null) delete next.enabled
    else if (typeof input.enabled === 'boolean') next.enabled = input.enabled
    else return { error: 'invalid_prefix_cache' }
  }
  if (input.payloadMode !== undefined) {
    if (input.payloadMode === null || input.payloadMode === '') delete next.payloadMode
    else if (typeof input.payloadMode === 'string' && MESHLLM_PAYLOAD_MODES.has(input.payloadMode)) next.payloadMode = input.payloadMode
    else return { error: 'invalid_prefix_cache' }
  }
  // max_entries capped at 128 (mesh-llm's uncertified fallback overruns the KV pool there).
  if (!applyInt('maxEntries', input.maxEntries, 128)) return { error: 'invalid_prefix_cache' }
  if (!applyInt('sharedStrideTokens', input.sharedStrideTokens, 4096)) return { error: 'invalid_prefix_cache' }
  if (!applyInt('sharedRecordLimit', input.sharedRecordLimit, 64)) return { error: 'invalid_prefix_cache' }
  return { value: next }
}

// resolveMeshllmTunables layers the per-model mesh-llm runtime tunables from a
// config request onto the existing settings, immutably (REQ-RUN-002 / REQ-ADM-021).
// A field changes only when present in the body: a positive integer, an allowed
// cache type, or a boolean sets it; null / 0 / "" clears it back to Auto by removing
// the key (never assigning undefined, which JSON.stringify would silently strip from
// the stored blob). An invalid value yields an error code the caller returns as 400.
type ModelConfigBody = { profileId?: string; contextWindow?: number; modelRef?: string; maxVramGb?: number; name?: string; callName?: string; runtime?: unknown; llamacpp?: unknown; meshId?: unknown } & MeshllmTunablesBody

function resolveMeshllmTunables(existing: NonNullable<ModelProfile['meshllm']>, body: MeshllmTunablesBody): { meshllm: NonNullable<ModelProfile['meshllm']> } | { error: string } {
  const next: Record<string, unknown> = { ...existing }
  const applyInt = (key: string, value: unknown, min: number): string | null => {
    if (value === undefined) return null
    if (value === null || value === 0) { delete next[key]; return null }
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min) return `invalid_${key}`
    next[key] = value
    return null
  }
  const applyCacheType = (key: string, value: unknown): string | null => {
    if (value === undefined) return null
    if (value === null || value === '') { delete next[key]; return null }
    if (typeof value !== 'string' || !MESHLLM_CACHE_TYPES.has(value)) return `invalid_${key}`
    next[key] = value
    return null
  }
  for (const err of [
    applyInt('parallel', body.parallel, 1),
    applyInt('batch', body.batch, 1),
    applyInt('ubatch', body.ubatch, 1),
    applyInt('maxOutputTokens', body.maxOutputTokens, 1),
    applyCacheType('cacheTypeK', body.cacheTypeK),
    applyCacheType('cacheTypeV', body.cacheTypeV)
  ]) {
    if (err) return { error: err }
  }
  if (body.flashAttn !== undefined) {
    if (body.flashAttn === null) delete next.flashAttn
    else if (typeof body.flashAttn === 'boolean') next.flashAttn = body.flashAttn
    else return { error: 'invalid_flash_attn' }
  }
  if (body.reasoning !== undefined) {
    if (body.reasoning === null) delete next.reasoning
    else {
      const reasoning = resolveReasoning(existing.reasoning, body.reasoning)
      if ('error' in reasoning) return reasoning
      // An all-empty result clears the block rather than storing {}.
      if (Object.keys(reasoning.value).length === 0) delete next.reasoning
      else next.reasoning = reasoning.value
    }
  }
  if (body.prefixCache !== undefined) {
    if (body.prefixCache === null) delete next.prefixCache
    else {
      const prefixCache = resolvePrefixCache(existing.prefixCache, body.prefixCache)
      if ('error' in prefixCache) return prefixCache
      if (Object.keys(prefixCache.value).length === 0) delete next.prefixCache
      else next.prefixCache = prefixCache.value
    }
  }
  return { meshllm: next as unknown as NonNullable<ModelProfile['meshllm']> }
}

function configureLlamaCppProfile(existing: ModelProfile, profiles: readonly ModelProfile[], body: ModelConfigBody): { profile: ModelProfile; settings: LlamaCppProfileSettings } | { error: string; status: number } {
  if (existing.meshllm?.split) return { error: 'split_requires_meshllm', status: 400 }
  const modelRef = body.modelRef !== undefined ? (typeof body.modelRef === 'string' ? body.modelRef.trim() : '') : (existing.llamacpp?.modelRef ?? existing.meshllm?.modelRef ?? existing.upstreamModel)
  if (!modelRef) return { error: 'invalid_model_ref', status: 400 }
  const generated = buildCustomProfile({ modelRef, split: false, runtime: 'llamacpp', existing: profiles }).llamacpp!
  const existingDirect = existing.runtime === 'llamacpp' ? existing.llamacpp : undefined
  const baseSource = existingDirect ?? generated
  const base: LlamaCppProfileSettings = {
    ...baseSource,
    bindPort: baseSource.bindPort ?? generated.bindPort,
    contextWindow: baseSource.contextWindow ?? generated.contextWindow,
    parallel: baseSource.parallel ?? generated.parallel,
    cachePrompt: baseSource.cachePrompt ?? generated.cachePrompt,
    cacheReuse: baseSource.cacheReuse ?? generated.cacheReuse
  }
  const settingsResult = resolveLlamaCppSettings(base, body.llamacpp)
  if ('error' in settingsResult) return { error: settingsResult.error, status: 400 }
  let settings = settingsResult.settings
  const contextWindow = body.contextWindow ?? settings.contextWindow
  if (!Number.isInteger(contextWindow) || contextWindow < 4096) return { error: 'invalid_context_window', status: 400 }
  settings = { ...settings, contextWindow, alias: modelRef, modelRef }
  let displayName = existing.displayName
  if (body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) return { error: 'invalid_display_name', status: 400 }
    displayName = name
  }
  let publicAliases = existing.publicAliases
  if (body.callName !== undefined) {
    const resolved = resolveCallNameAliases(existing, body.callName, profiles)
    if (!Array.isArray(resolved)) return resolved as { error: string; status: number }
    publicAliases = resolved
  }
  const { meshllm: _meshllm, ...withoutMesh } = existing
  void _meshllm
  return {
    settings,
    profile: {
      ...withoutMesh,
      displayName,
      publicAliases,
      upstreamModel: settings.alias,
      sourceMode: 'llamacpp-hf',
      contextWindow,
      runtime: 'llamacpp',
      llamacpp: settings,
      version: existing.version + 1
    }
  }
}

// handleProfileConfig persists a profile's serving settings — the context window,
// the model ref, the per-model VRAM budget, and the mesh-llm runtime tunables —
// through the validated store path so the active column and the profile_json blob
// stay consistent. contextWindow must be a non-negative integer (0 = Auto, so
// mesh-llm sizes it); a supplied modelRef is trimmed, must be non-empty, and updates
// both the mesh runtime ref and the gateway upstream model together.
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
  return await handleRuntimeVersionsList(request, deps.store, deps.releasesFetcher ?? globalThis.fetch)
}

async function handleAdminRuntimeVersionSelect(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  const actor = await requireAdmin(request, deps, now)
  if (!actor) return json({ error: 'unauthorized' }, 401, requestId)
  return await handleRuntimeVersionsSelect(request, deps.store, deps.releasesFetcher ?? globalThis.fetch, actor)
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
  return await runSpeedTest(deps, body, request.headers, requestId, now)
}

async function handleApiSpeedTest(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  if (!(await requireAutomation(request, deps, now))) return json({ error: 'unauthorized' }, 401, requestId)
  const body = await readOptionalObject<SpeedTestBody>(request)
  return await runSpeedTest(deps, body, request.headers, requestId, now)
}

interface SpeedTestBody {
  readonly model?: unknown
  readonly promptTokens?: unknown
  readonly maxTokens?: unknown
}

interface SpeedTestMeasurement {
  readonly timingsMs: { readonly timeToFirstToken: number; readonly generation: number; readonly total: number }
  readonly tokens: { readonly prompt: number; readonly completion: number; readonly promptEstimated: boolean; readonly completionEstimated: boolean }
  readonly throughput: { readonly promptTokensPerSecond: number; readonly generationTokensPerSecond: number }
  readonly chunks: number
  readonly outputChars: number
  readonly usage: Record<string, unknown> | null
  readonly upstreamTimings: Record<string, unknown> | null
}

async function runSpeedTest(deps: RouterDeps, body: SpeedTestBody | undefined, requestHeaders: Headers, requestId: string, now: number): Promise<Response> {
  const model = cleanString(body?.model) ?? STABLE_PUBLIC_MODEL
  const promptTokens = boundedInt(body?.promptTokens, 64, 8192, 2048)
  const maxTokens = boundedInt(body?.maxTokens, 16, 512, 160)
  const prompt = speedTestPrompt(promptTokens, requestId)
  const startedAt = Date.now()
  const upstream = await runInference(deps, {
    body: {
      model,
      user: `user:speed-test|session:${requestId}`,
      stream: true,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }]
    },
    requestHeaders,
    requestId,
    now
  })
  if (!upstream.ok || !upstream.body) {
    return new Response(upstream.body, { status: upstream.status, headers: upstream.headers })
  }
  const measured = await measureSpeedStream(upstream.body, startedAt, promptTokens)
  const nodeId = upstream.headers.get('x-inference-mesh-node') ?? upstream.headers.get('x-inference-mesh-session-node') ?? undefined
  const cacheTokens = timingNumber(measured.upstreamTimings ?? undefined, 'cache_n')
  const result = { model, ...(nodeId ? { nodeId } : {}), promptChars: prompt.length, requestedPromptTokens: promptTokens, requestedMaxTokens: maxTokens, ...(cacheTokens !== undefined ? { cacheTokens } : {}), ...measured }
  await deps.store.putConfig(LAST_SPEED_TEST_CONFIG_KEY, speedTestSummary(result, now, requestId))
  return json(result, 200, requestId)
}

function speedTestSummary(result: SpeedTestMeasurement & { readonly model: string; readonly nodeId?: string; readonly requestedPromptTokens: number; readonly requestedMaxTokens: number; readonly cacheTokens?: number }, now: number, requestId: string): LastSpeedTestSummary {
  return {
    at: now,
    requestId,
    model: result.model,
    ...(result.nodeId ? { nodeId: result.nodeId } : {}),
    requestedPromptTokens: result.requestedPromptTokens,
    requestedMaxTokens: result.requestedMaxTokens,
    promptTokens: result.tokens.prompt,
    completionTokens: result.tokens.completion,
    promptTokensEstimated: result.tokens.promptEstimated,
    completionTokensEstimated: result.tokens.completionEstimated,
    promptTokensPerSecond: result.throughput.promptTokensPerSecond,
    generationTokensPerSecond: result.throughput.generationTokensPerSecond,
    timeToFirstTokenMs: result.timingsMs.timeToFirstToken,
    generationMs: result.timingsMs.generation,
    totalMs: result.timingsMs.total,
    ...(result.cacheTokens !== undefined ? { cacheTokens: result.cacheTokens } : {})
  }
}

function boundedInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

function speedTestPrompt(targetTokens: number, nonce: string): string {
  const unit = 'Measure inference speed with stable repeated technical text, preserving exact identifiers and dependency edges. '
  const approxChars = targetTokens * 4
  const prefix = `Speed test nonce ${nonce}. `
  return (prefix + unit.repeat(Math.max(1, Math.ceil(approxChars / unit.length)))).slice(0, approxChars) + '\nReturn a concise numbered list.'
}

async function measureSpeedStream(body: ReadableStream<Uint8Array>, startedAt: number, fallbackPromptTokens: number): Promise<SpeedTestMeasurement> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffered = ''
  let firstTokenAt = 0
  let completedAt = startedAt
  let outputChars = 0
  let chunks = 0
  let usage: Record<string, unknown> | undefined
  let upstreamTimings: Record<string, unknown> | undefined
  while (true) {
    const chunk = await reader.read()
    completedAt = Date.now()
    if (chunk.done) break
    buffered += decoder.decode(chunk.value, { stream: true })
    const lines = buffered.split('\n')
    buffered = lines.pop() ?? ''
    for (const raw of lines) {
      const line = raw.trim()
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (!data || data === '[DONE]') continue
      try {
        const parsed = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string; reasoning_content?: string } }>; usage?: Record<string, unknown>; timings?: Record<string, unknown> }
        if (parsed.usage) usage = parsed.usage
        if (parsed.timings) upstreamTimings = parsed.timings
        const content = parsed.choices?.map((choice) => choice.delta?.content ?? choice.delta?.reasoning_content ?? '').join('') ?? ''
        if (content) {
          if (firstTokenAt === 0) firstTokenAt = Date.now()
          chunks += 1
          outputChars += content.length
        }
      } catch {
        // Ignore keep-alives and non-OpenAI SSE lines.
      }
    }
  }
  const reportedPromptTokens = usageNumber(usage, 'prompt_tokens')
  const timingPromptTokens = timingNumber(upstreamTimings, 'prompt_n') ?? timingNumber(upstreamTimings, 'prompt_tokens')
  const promptTokens = reportedPromptTokens ?? timingPromptTokens ?? fallbackPromptTokens
  const reportedCompletionTokens = usageNumber(usage, 'completion_tokens')
  const timingCompletionTokens = timingNumber(upstreamTimings, 'predicted_n') ?? timingNumber(upstreamTimings, 'completion_tokens')
  const completionTokens = reportedCompletionTokens ?? timingCompletionTokens ?? Math.max(1, Math.round(outputChars / 4))
  const ttftMs = firstTokenAt > 0 ? firstTokenAt - startedAt : completedAt - startedAt
  const generationMs = firstTokenAt > 0 ? Math.max(1, completedAt - firstTokenAt) : Math.max(1, completedAt - startedAt)
  const promptTps = timingNumber(upstreamTimings, 'prompt_per_second') ?? rateFromTiming(promptTokens, timingNumber(upstreamTimings, 'prompt_ms')) ?? rate(promptTokens, ttftMs)
  const generationTps = timingNumber(upstreamTimings, 'predicted_per_second') ?? rateFromTiming(completionTokens, timingNumber(upstreamTimings, 'predicted_ms')) ?? rate(completionTokens, generationMs)
  return {
    timingsMs: { timeToFirstToken: ttftMs, generation: generationMs, total: completedAt - startedAt },
    tokens: { prompt: promptTokens, completion: completionTokens, promptEstimated: reportedPromptTokens == null && timingPromptTokens == null, completionEstimated: reportedCompletionTokens == null && timingCompletionTokens == null },
    throughput: {
      promptTokensPerSecond: promptTps,
      generationTokensPerSecond: generationTps
    },
    chunks,
    outputChars,
    usage: usage ?? null,
    upstreamTimings: upstreamTimings ?? null
  }
}

function rate(tokens: number, ms: number): number {
  return Math.round((tokens / Math.max(0.001, ms / 1000)) * 10) / 10
}

function rateFromTiming(tokens: number, ms: number | undefined): number | undefined {
  return ms && ms > 0 ? rate(tokens, ms) : undefined
}

function timingNumber(timings: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = timings?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function usageNumber(usage: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = usage?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
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

function parseDirectSession(value: unknown): { readonly userId: string; readonly sessionId: string } | undefined {
  if (typeof value !== 'string') return undefined
  const match = /^user:([^|\r\n]{1,256})\|session:([^|\r\n]{1,256})$/.exec(value)
  return match ? { userId: match[1]!, sessionId: match[2]! } : undefined
}

function directSessionBody(body: Record<string, unknown>, headers: Headers): Record<string, unknown> {
  if (parseDirectSession(body.user)) return body
  const fallback = gatewayMetadataDirectSession(headers, body.metadata) ?? providerDefaultDirectSession(headers)
  return fallback ? { ...body, user: fallback } : body
}

function gatewayMetadataDirectSession(headers: Headers, bodyMetadata: unknown): string | undefined {
  const metadata = parseGatewayMetadata(headers.get('cf-aig-metadata')) ?? parseGatewayMetadataObject(bodyMetadata)
  const user = directSessionPart(metadata?.user)
  if (!user) return undefined
  const session = directSessionPart(metadata?.session) ?? user
  return `user:${user}|session:${session}`
}

function parseGatewayMetadata(value: string | null): Record<string, unknown> | undefined {
  if (!value) return undefined
  try {
    return parseGatewayMetadataObject(JSON.parse(value) as unknown)
  } catch {
    return undefined
  }
}

function parseGatewayMetadataObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function directSessionPart(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return undefined
  const cleaned = String(value).trim().replace(/[|\r\n]/g, '-').slice(0, 256)
  return cleaned || undefined
}

function providerDefaultDirectSession(headers: Headers): string | undefined {
  return headers.get('authorization') ? 'user:ai-gateway|session:provider-default' : undefined
}

function directAffinitySecret(env: Partial<RouterEnv>): string | undefined {
  return env.SESSION_AFFINITY_KEY ?? env.ADMIN_TOKEN
}

async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value))
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function decideDirectSessionWithAffinity(deps: RouterDeps, request: DirectSessionDecisionRequest): Promise<DirectSessionDecision> {
  if (!deps.env.SESSION_AFFINITY) return decideDirectSession(deps.store, request)
  const id = deps.env.SESSION_AFFINITY.idFromName(request.affinityKey)
  const response = await deps.env.SESSION_AFFINITY.get(id).fetch('https://session-affinity.local/direct-session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request)
  })
  return await response.json() as DirectSessionDecision
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
  if (isMutatingMethod(request.method) && usesAccessJwt(request) && !hasSameOriginSignal(request)) return undefined
  const verdict = await resolveRole(request, deps, now)
  return verdict?.role === 'admin' ? verdict.actor : undefined
}

/** Reader gate: any verified console role (admin or user) may read status + use the playground. */
async function requireUser(request: Request, deps: RouterDeps, now: number): Promise<RoleVerdict | undefined> {
  if (isMutatingMethod(request.method) && usesAccessJwt(request) && !hasSameOriginSignal(request)) return undefined
  return await resolveRole(request, deps, now)
}

function usesAccessJwt(request: Request): boolean {
  return accessJwtSource(request) !== null
}

function isMutatingMethod(method: string): boolean {
  return !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())
}

function hasSameOriginSignal(request: Request): boolean {
  const requestOrigin = new URL(request.url).origin
  const origin = request.headers.get('origin')
  if (origin) return origin === requestOrigin
  const referer = request.headers.get('referer')
  if (referer) {
    try {
      return new URL(referer).origin === requestOrigin
    } catch {
      return false
    }
  }
  const fetchSite = request.headers.get('sec-fetch-site')
  return fetchSite === 'same-origin' || fetchSite === 'none'
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

async function requireKeyAdmin(request: Request, deps: RouterDeps, now: number): Promise<string | undefined> {
  const actor = await requireAdmin(request, deps, now)
  if (actor) return actor
  if ((await accessConfig(deps.store)) && extractAccessJwt(request)) return undefined
  return (await authenticateKind(request, deps, 'admin', now, deps.env.ADMIN_TOKEN)) ? 'admin-api' : undefined
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
  const lastSpeedTest = await deps.store.getConfig<LastSpeedTestSummary>(LAST_SPEED_TEST_CONFIG_KEY)
  const runtimeInstalls = nodes.map((node) => ({ nodeId: node.id, ...runtimeBinaryStatus(node, runtimeVersions) }))
  return json({
    generatedAt: now,
    nodes: { total: nodes.length, online: nodes.filter((node) => node.status === 'online').length },
    models: { total: profiles.length, active: profiles.filter((profile) => profile.active).length },
    runtimeVersions,
    ...(lastSpeedTest ? { lastSpeedTest } : {}),
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
      prefixCache: m.prefixCache ?? null
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
  return await handleRuntimeVersionsList(request, deps.store, deps.releasesFetcher ?? globalThis.fetch)
}

async function handleApiRuntimeVersionSet(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  const automation = await requireAutomation(request, deps, now)
  if (!automation) return json({ error: 'unauthorized' }, 401, requestId)
  return await handleRuntimeVersionsSelect(request, deps.store, deps.releasesFetcher ?? globalThis.fetch, `automation:${automation.id}`)
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

async function readJson<T>(request: Request): Promise<T> {
  try {
    return await request.json() as T
  } catch {
    throw new InvalidJsonBodyError()
  }
}

async function readOptionalObject<T>(request: Request): Promise<T | undefined> {
  const text = await request.text()
  if (!text) return undefined
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    // An absent body is fine (returns undefined above → the route uses its defaults), but a
    // present-but-unparseable body is a client mistake: reject it as 400 invalid_json rather
    // than silently discarding it and applying defaults the caller never intended.
    throw new InvalidJsonBodyError()
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as T : undefined
}

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

function responseMetadataHeaders(upstream: Headers, requestId: string, nodeId: string): Headers {
  const headers = new Headers(upstream)
  headers.set('x-inference-mesh-request-id', requestId)
  headers.set('x-inference-mesh-node', nodeId)
  return headers
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
    if (raw !== undefined && (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0)) return false
  }
  return true
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
