/** The machine protocol: how an agent claims a slot, reports in, and leaves. */
import { activeMeshllmRepository, desiredRuntimeVersions } from '../runtime-versions'
import { applyHeartbeatMeshState, meshBootstrapFor } from '../mesh-state'
import { applyNodeVramOverride } from '../profile-config'
import { authenticateTokenByNode } from '../auth-gates'
import { bearerToken, createTokenRecord, generateBearerToken, hashToken, verifyPlainOrHashed } from '../auth'
import type { ClaimRequest, HeartbeatRequest, ModelProfile, NodeRecord, RouterEnv, Store } from '../types'
import { desiredAgentVersion } from '../agent-versions'
import { isSafeMeshTarget } from '../scheduler'
import { json, readJson } from '../http'
import { nodeMeshId, profileMeshId } from '../profiles'
import { resolveUpstreamToken } from '../inference'
import type { RouterDeps } from '../deps'

/**
 * Enrol an agent. `setupTokenId` is the enrollment token the route's gate already verified;
 * claiming spends it, so it is revoked below rather than re-verified here.
 */
export async function handleNodeClaim(request: Request, deps: RouterDeps, requestId: string, now: number, setupTokenId: string): Promise<Response> {
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
  await deps.store.revokeToken('setup', setupTokenId, now)
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

export async function handleNodeHeartbeat(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
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
export async function desiredRuntimeVersionsPayload(deps: RouterDeps): Promise<Record<string, unknown>> {
  const versions = await desiredRuntimeVersions(deps.store)
  const meshllmRepository = await activeMeshllmRepository(deps.env, deps.store)
  return { ...versions, ...(meshllmRepository ? { meshllmRepository } : {}) }
}

export async function handleNodeUnregister(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
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

async function getOrCreateUpstreamToken(deps: RouterDeps): Promise<string> {
  const existing = await resolveUpstreamToken(deps)
  if (existing) return existing
  const token = generateBearerToken('upstream')
  await deps.store.putConfig('node_upstream_token', token)
  return token
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
