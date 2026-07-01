import { adminUiHtml } from './admin-ui'
import { approvedNodeHeaders, bearerToken, createTokenRecord, generateBearerToken, hashToken, redactSecrets, verifyPlainOrHashed, verifyToken } from './auth'
import { CloudflareGatewayClient, type GatewaySyncRequest, type GatewaySyncResult } from './cloudflare-api'
import { installerCommand, installScript, validateCustomDomain, type InstallerPlatform } from './installers'
import { DEFAULT_MODEL_PROFILES } from './profiles'
import { meshUrl } from './scheduler'
import type { ClaimRequest, CredentialKind, HeartbeatRequest, ModelProfile, RouterEnv, Scheduler, Store, TokenRecord } from './types'

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
  readonly cloudflareClient?: { syncCustomProvider(input: GatewaySyncRequest): Promise<GatewaySyncResult> }
}

export function createRouter(deps: RouterDeps): (request: Request) => Promise<Response> {
  const now = deps.now ?? Date.now
  const requestId = deps.requestId ?? (() => crypto.randomUUID())
  return async (request: Request): Promise<Response> => {
    const id = requestId()
    const url = new URL(request.url)
    try {
      await deps.store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)
      if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/admin')) return html(adminUiHtml(url.origin), id)
      if (request.method === 'GET' && url.pathname === '/health') return json({ ok: true, service: 'inference-mesh-router' }, 200, id)
      if (request.method === 'GET' && url.pathname === '/v1/models') return await handleModels(request, deps, id, now())
      if (request.method === 'POST' && url.pathname === '/v1/chat/completions') return await handleChat(request, deps, id, now())
      if (request.method === 'POST' && url.pathname === '/node/claim') return await handleNodeClaim(request, deps, id, now())
      if (request.method === 'POST' && url.pathname === '/node/heartbeat') return await handleNodeHeartbeat(request, deps, id, now())
      if (request.method === 'POST' && url.pathname === '/node/unregister') return await handleNodeUnregister(request, deps, id, now())
      if (url.pathname === '/admin/setup' && request.method === 'POST') return await handleFirstSetup(request, deps, id, now())
      if (url.pathname === '/install.sh' && request.method === 'GET') return handleInstallScript(deps, url.searchParams.get('platform') === 'macos' ? 'macos' : 'linux')
      if (url.pathname === '/install.ps1' && request.method === 'GET') return handleInstallScript(deps, 'windows')
      if (url.pathname === '/admin/login' && request.method === 'POST') return await handleAdminLogin(request, deps, id, now())
      if (url.pathname === '/admin/status' && request.method === 'GET') return await handleAdminStatus(request, deps, id, now())
      if (url.pathname === '/admin/setup-tokens' && request.method === 'POST') return await handleSetupToken(request, deps, id, now())
      if (url.pathname.startsWith('/admin/installers/') && request.method === 'GET') return await handleInstaller(request, deps, url, id, now())
      if (url.pathname === '/admin/cloudflare/gateway/sync' && request.method === 'POST') return await handleGatewaySync(request, deps, id, now())
      if (url.pathname === '/admin/custom-domain/validate' && request.method === 'POST') return await handleCustomDomain(request, deps, id, now())
      if (url.pathname.match(/^\/admin\/nodes\/[^/]+\/revoke$/) && request.method === 'POST') return await handleNodeRevoke(request, deps, url, id, now())
      if (url.pathname === '/admin/profiles/rollout' && request.method === 'POST') return await handleProfileRollout(request, deps, id, now())
      return json({ error: 'not_found', requestId: id }, 404, id)
    } catch (error) {
      await deps.store.appendAudit({ id, type: 'router_error', at: now(), actor: 'system', detail: { error: String(error) } })
      return json({ error: 'internal_error', requestId: id }, 500, id)
    }
  }
}

async function handleModels(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  if (!(await authenticateKind(request, deps, 'provider', now, deps.env.ROUTER_PROVIDER_TOKEN))) return json({ error: 'unauthorized' }, 401, requestId)
  const profiles = await deps.store.listProfiles()
  return json({ object: 'list', data: profiles.flatMap((profile) => profile.publicAliases.map((id) => ({ id, object: 'model', owned_by: 'codeflare-inference-mesh' }))) }, 200, requestId)
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
  if (!result.reservation || !result.node || !result.profile) return json({ error: result.reason ?? 'busy', requestId }, result.reason === 'no-profile' ? 404 : 429, requestId)

  const upstreamToken = await resolveUpstreamToken(deps)
  if (!upstreamToken) {
    await deps.scheduler.release(result.reservation.reservationId, now)
    return json({ error: 'upstream_token_missing', requestId }, 503, requestId)
  }

  const rewritten = JSON.stringify({ ...body, model: result.reservation.upstreamModel })
  let upstream: Response
  try {
    upstream = await deps.mesh.fetch(meshUrl(result.node, '/v1/chat/completions'), {
      method: 'POST',
      headers: approvedNodeHeaders(request.headers, upstreamToken, requestId),
      body: rewritten
    })
  } catch (error) {
    await deps.scheduler.release(result.reservation.reservationId, now)
    throw error
  }
  const headers = responseMetadataHeaders(upstream.headers, requestId, sessionId, result.node.id)
  return releaseOnCompletion(upstream, headers, () => deps.scheduler.release(result.reservation!.reservationId, now))
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
    runtime: 'llama.cpp' as const,
    nodeTokenVerifier: await hashToken(nodeToken),
    upstreamTokenVerifier: await hashToken(upstreamToken)
  }
  await deps.store.upsertNode(nodeRecord)
  await deps.store.putToken(await createTokenRecord('node', nodeToken, now, nodeId))
  await deps.store.revokeToken('setup', setupToken.id, now)
  await deps.store.appendAudit({ id: requestId, type: 'node_claimed', at: now, actor: 'setup', target: nodeId, detail: { displayName: body.displayName } })
  return json({ nodeId, nodeToken, upstreamToken, profiles: await deps.store.listProfiles() }, 201, requestId)
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
    ...(body.metrics !== undefined ? { metrics: body.metrics } : {})
  }
  await deps.store.updateNodeHeartbeat(next)
  return json({ ok: true, desiredProfiles: await deps.store.listProfiles() }, 200, requestId)
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

async function handleFirstSetup(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  const existingAdmins = await deps.store.listTokens('admin')
  if (existingAdmins.some((token) => token.active) && !(await authenticateKind(request, deps, 'admin', now, deps.env.ADMIN_TOKEN))) return json({ error: 'unauthorized' }, 401, requestId)
  const adminToken = generateBearerToken('admin')
  const providerToken = generateBearerToken('provider')
  const setupToken = generateBearerToken('setup')
  const upstreamToken = await getOrCreateUpstreamToken(deps)
  await deps.store.putToken(await createTokenRecord('admin', adminToken, now))
  await deps.store.putToken(await createTokenRecord('provider', providerToken, now))
  await deps.store.putToken(await createTokenRecord('setup', setupToken, now, undefined, now + SETUP_TOKEN_TTL_MS))
  await deps.store.putToken(await createTokenRecord('upstream', upstreamToken, now))
  await deps.store.putConfig('setup_state', { completedAt: now })
  await deps.store.appendAudit({ id: requestId, type: 'first_setup', at: now, actor: 'setup', detail: { provider: true, setup: true } })
  return json({ adminToken, providerToken, setupToken, upstreamToken, byokInstruction: 'Paste providerToken as the AI Gateway custom provider API key.' }, 201, requestId)
}

async function handleAdminLogin(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  if (!(await authenticateKind(request, deps, 'admin', now, deps.env.ADMIN_TOKEN))) return json({ error: 'unauthorized' }, 401, requestId)
  return json({ ok: true, session: 'bearer-token' }, 200, requestId)
}

async function handleAdminStatus(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  if (!(await authenticateKind(request, deps, 'admin', now, deps.env.ADMIN_TOKEN))) return json({ error: 'unauthorized' }, 401, requestId)
  const nodes = await deps.store.listNodes(now)
  const profiles = await deps.store.listProfiles()
  return json(redactSecrets({ nodes, profiles, audit: await deps.store.listAudit(20), generatedAt: now }), 200, requestId)
}

async function handleSetupToken(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  if (!(await authenticateKind(request, deps, 'admin', now, deps.env.ADMIN_TOKEN))) return json({ error: 'unauthorized' }, 401, requestId)
  const setupToken = generateBearerToken('setup')
  await deps.store.putToken(await createTokenRecord('setup', setupToken, now, undefined, now + SETUP_TOKEN_TTL_MS))
  await deps.store.appendAudit({ id: requestId, type: 'setup_token_created', at: now, actor: 'admin', detail: {} })
  return json({ setupToken, expiresAt: now + SETUP_TOKEN_TTL_MS }, 201, requestId)
}

async function handleInstaller(request: Request, deps: RouterDeps, url: URL, requestId: string, now: number): Promise<Response> {
  if (!(await authenticateKind(request, deps, 'admin', now, deps.env.ADMIN_TOKEN))) return json({ error: 'unauthorized' }, 401, requestId)
  const platform = url.pathname.split('/').at(-1) as InstallerPlatform
  if (!['linux', 'macos', 'windows'].includes(platform)) return json({ error: 'unknown_platform' }, 404, requestId)
  const setupToken = generateBearerToken('setup')
  await deps.store.putToken(await createTokenRecord('setup', setupToken, now, undefined, now + SETUP_TOKEN_TTL_MS))
  const command = installerCommand({ platform, workerUrl: deps.env.WORKER_BASE_URL ?? url.origin, setupToken, repository: deps.env.GITHUB_REPOSITORY ?? 'nikolanovoselec/codeflare-inference-mesh' })
  return new Response(command, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8', 'x-inference-mesh-request-id': requestId } })
}

function handleInstallScript(deps: RouterDeps, platform: InstallerPlatform): Response {
  const repository = deps.env.GITHUB_REPOSITORY ?? 'nikolanovoselec/codeflare-inference-mesh'
  const releaseTag = deps.env.AGENT_RELEASE_TAG ?? 'latest'
  const contentType = platform === 'windows' ? 'text/plain; charset=utf-8' : 'text/x-shellscript; charset=utf-8'
  return new Response(installScript({ platform, repository, releaseTag }), { status: 200, headers: { 'content-type': contentType } })
}

async function handleGatewaySync(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  if (!(await authenticateKind(request, deps, 'admin', now, deps.env.ADMIN_TOKEN))) return json({ error: 'unauthorized' }, 401, requestId)
  const accountId = deps.env.CLOUDFLARE_ACCOUNT_ID ?? deps.env.AI_GATEWAY_ACCOUNT_ID
  const gatewayId = deps.env.AI_GATEWAY_ID ?? 'inference-mesh'
  const customDomain = await deps.store.getConfig<{ hostname: string; zoneId: string }>('custom_domain')
  const workerUrl = customDomain?.hostname ? `https://${customDomain.hostname}` : deps.env.WORKER_BASE_URL
  const token = deps.env.CLOUDFLARE_API_TOKEN_RUNTIME
  if (!accountId || !workerUrl || (!token && !deps.cloudflareClient)) return json({ error: 'cloudflare_runtime_config_missing' }, 503, requestId)
  const client = deps.cloudflareClient ?? new CloudflareGatewayClient(token!)
  const result = await client.syncCustomProvider({ accountId, gatewayId, workerUrl, providerName: 'codeflare-inference-mesh', routeName: 'mesh-default', providerTokenInstructions: 'Paste the router provider token into the AI Gateway provider key field.' })
  await deps.store.putConfig('cloudflare_gateway', result)
  await deps.store.appendAudit({ id: requestId, type: 'gateway_sync', at: now, actor: 'admin', detail: { ...result } })
  return json(result, 200, requestId)
}

async function handleCustomDomain(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  if (!(await authenticateKind(request, deps, 'admin', now, deps.env.ADMIN_TOKEN))) return json({ error: 'unauthorized' }, 401, requestId)
  const body = await readJson<{ hostname: string; zoneId: string }>(request)
  const hostname = typeof body?.hostname === 'string' ? body.hostname.trim() : ''
  const zoneId = typeof body?.zoneId === 'string' ? body.zoneId.trim() : ''
  const valid = Boolean(hostname && validateCustomDomain(hostname) && /^[a-f0-9]{32}$/i.test(zoneId))
  if (!valid) return json({ valid: false, hostname: body?.hostname }, 400, requestId)
  const result = { valid: true, hostname, zoneId }
  await deps.store.putConfig('custom_domain', { hostname, zoneId })
  await deps.store.appendAudit({ id: requestId, type: 'custom_domain_validated', at: now, actor: 'admin', target: hostname, detail: { zoneId } })
  return json(result, 200, requestId)
}

async function handleNodeRevoke(request: Request, deps: RouterDeps, url: URL, requestId: string, now: number): Promise<Response> {
  if (!(await authenticateKind(request, deps, 'admin', now, deps.env.ADMIN_TOKEN))) return json({ error: 'unauthorized' }, 401, requestId)
  const nodeId = decodeURIComponent(url.pathname.split('/')[3] ?? '')
  await deps.store.revokeNode(nodeId, now)
  const nodeTokens = await deps.store.listTokens('node')
  await Promise.all(nodeTokens.filter((token) => token.nodeId === nodeId && token.active).map((token) => deps.store.revokeToken('node', token.id, now)))
  await deps.store.appendAudit({ id: requestId, type: 'node_revoked', at: now, actor: 'admin', target: nodeId, detail: {} })
  return json({ ok: true }, 200, requestId)
}

async function handleProfileRollout(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  if (!(await authenticateKind(request, deps, 'admin', now, deps.env.ADMIN_TOKEN))) return json({ error: 'unauthorized' }, 401, requestId)
  const body = await readJson<{ profileId: string; rolloutPercent: number }>(request)
  if (!body || typeof body.profileId !== 'string' || typeof body.rolloutPercent !== 'number') return json({ error: 'invalid_rollout' }, 400, requestId)
  await deps.store.setActiveProfile(body.profileId, body.rolloutPercent)
  await deps.store.appendAudit({ id: requestId, type: 'profile_rollout', at: now, actor: 'admin', target: body.profileId, detail: { rolloutPercent: body.rolloutPercent } })
  return json({ ok: true }, 200, requestId)
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

function html(body: string, requestId: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'x-inference-mesh-request-id': requestId } })
}

async function readJson<T>(request: Request): Promise<T> {
  return await request.json() as T
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

function releaseOnCompletion(response: Response, headers: Headers, release: () => Promise<void>): Response {
  if (!response.body) {
    void release()
    return new Response(null, { status: response.status, headers })
  }
  const reader = response.body.getReader()
  const stream = new ReadableStream({
    async pull(controller) {
      const chunk = await reader.read()
      if (chunk.done) {
        controller.close()
        await release()
        return
      }
      controller.enqueue(chunk.value)
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
  REQ_ADM_001: 'REQ-ADM-001',
  REQ_ADM_002: 'REQ-ADM-002',
  REQ_ADM_003: 'REQ-ADM-003',
  REQ_ADM_006: 'REQ-ADM-006',
  REQ_SEC_002: 'REQ-SEC-002'
} as const
