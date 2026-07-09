import { bearerToken, verifyPlainOrHashed, verifyToken } from './auth'
import { InvalidJsonBodyError } from './errors'
import { decryptJson, encryptJson, importMeshStateKey, type EncryptedEnvelope } from './mesh-crypto'
import type { HeartbeatRequest, MeshBootstrap, ModelProfile, NodeRecord, RouterEnv, SplitReadinessReport, StageAssignment, Store } from './types'

export type MeshStateEnv = Pick<Partial<RouterEnv>, 'REGISTRY' | 'MESH_STATE_KEY' | 'ADMIN_TOKEN'>

const HEARTBEAT_INTERVAL_MS = 15_000
const SEED_TOKEN_DEADLINE_MS = 4 * HEARTBEAT_INTERVAL_MS
const SEED_FRESHNESS_MS = 45_000
const TOKEN_OFFLINE_TTL_MS = 24 * 60 * 60 * 1000
const MESH_STATE_KEY_MISSING = 'mesh_state_key_missing'
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' }

export interface MeshTokenEntry {
  readonly nodeId: string
  readonly token: string
  readonly updatedAt: number
}

export interface MeshStateRecord {
  readonly rotation: number
  readonly meshId: string | null
  readonly seedNodeId: string | null
  readonly seedElectedAt: number | null
  readonly tokens: readonly MeshTokenEntry[]
}

export interface MeshHealthEntry {
  profileId: string
  meshId?: string
  rotation: number
  seedNodeId?: string
  coordinatorNodeId?: string
  peerNodeIds: readonly string[]
  readyModels: readonly string[]
  stageAssignments?: readonly StageAssignment[]
  splitReadiness?: SplitReadinessReport
  failedNodeIds: readonly string[]
  /** Member nodes tainted deactivated (REQ-ADM-030): enrolled but running no model. */
  deactivatedNodeIds: readonly string[]
  /** The profile's own active state; an inactive profile is never "ready" however
   *  much stale mesh state it still carries (REQ-OBS-007). */
  active: boolean
  tokenCount: number
  secretAgeMs?: number
  lastError?: string
}

export async function handleMeshRotate(request: Request, store: Store, env: MeshStateEnv, now: number, preauthorizedActor?: string): Promise<Response> {
  if (!preauthorizedActor && !(await adminAuthorized(request, store, env, now))) return meshJson({ error: 'unauthorized' }, 401)
  const profileId = await rotateProfileId(request)
  if (!profileId) return meshJson({ error: 'invalid_rotate' }, 400)
  const key = await meshKeyFor(env)
  if (!key) return meshJson({ error: MESH_STATE_KEY_MISSING }, 500)
  const profile = (await store.listProfiles()).find((item) => item.id === profileId)
  if (!profile) return meshJson({ error: 'unknown_profile' }, 404)
  const stored = (await loadMeshState(store, key, profileId)) ?? emptyMeshState(0)
  const next = emptyMeshState(stored.rotation + 1)
  await saveMeshState(store, key, profileId, next)
  await appendMeshAudit(store, 'mesh_token_rotated', preauthorizedActor ?? 'admin', profileId, now, {
    profileId,
    rotation: next.rotation,
    ...(stored.meshId !== null ? { meshId: stored.meshId } : {})
  })
  return meshJson({ ok: true, profileId, rotation: next.rotation }, 200)
}

export async function applyHeartbeatMeshState(store: Store, env: MeshStateEnv, node: NodeRecord, heartbeat: HeartbeatRequest, now: number): Promise<void> {
  const key = await meshKeyFor(env)
  if (!key || node.status === 'revoked') return
  const profile = selectedMeshProfile(await store.listProfiles(), heartbeat.activeProfileIds)
  if (!profile) return
  const stored = (await loadMeshState(store, key, profile.id)) ?? emptyMeshState(0)
  const pruned = stored.tokens.length > 0
    ? pruneDeadTokens(stored, await store.listNodes(now), now)
    : { state: stored, removed: [] as readonly MeshTokenEntry[] }
  const swept = sweepMeshState(pruned.state, now)
  const reported = heartbeat.meshToken !== undefined ? upsertToken(swept, node.id, heartbeat.meshToken, now) : swept
  const next = captureMeshId(reported, node.id, heartbeat.meshId)
  if (next === stored) return
  await saveMeshState(store, key, profile.id, next)
  for (const entry of pruned.removed) {
    await appendMeshAudit(store, 'mesh_token_removed', 'system', entry.nodeId, now, {
      profileId: profile.id,
      nodeId: entry.nodeId,
      rotation: next.rotation,
      ...(stored.meshId !== null ? { meshId: stored.meshId } : {})
    })
  }
  if (swept !== pruned.state) {
    await appendMeshAudit(store, 'mesh_state_cleared', 'system', profile.id, now, {
      profileId: profile.id,
      rotation: next.rotation,
      ...clearedDetail(pruned.state)
    })
  }
  if (next !== swept) {
    await appendMeshAudit(store, 'mesh_state_stored', 'system', profile.id, now, {
      profileId: profile.id,
      nodeId: node.id,
      rotation: next.rotation,
      ...(next.meshId !== null ? { meshId: next.meshId } : {})
    })
  }
}

export async function meshBootstrapFor(store: Store, env: MeshStateEnv, node: NodeRecord, profile: ModelProfile, now: number): Promise<MeshBootstrap | undefined> {
  const key = await meshKeyFor(env)
  if (!key) return undefined
  if (node.status !== 'online' || node.runtime !== 'meshllm' || !profile.active || !node.activeProfileIds.includes(profile.id)) return undefined
  const state = sweepMeshState((await loadMeshState(store, key, profile.id)) ?? emptyMeshState(0), now)
  // Re-elect when this node has no seed and no OTHER node's token to join. A leftover
  // self-token (a seed that expired into a token island) must not block election, or the
  // node is handed its own token as a phantom join forever. REQ-RUN-008.
  const joinable = state.tokens.filter((entry) => entry.nodeId !== node.id)
  if (joinable.length === 0 && state.seedNodeId === null && isSeedEligible(node, profile, now)) {
    await runElection(store, env, profile.id, node.id, now)
    const elected = sweepMeshState((await loadMeshState(store, key, profile.id)) ?? emptyMeshState(state.rotation), now)
    return bootstrapFromState(elected, node.id)
  }
  return bootstrapFromState(state, node.id)
}

export async function meshHealth(store: Store, env: MeshStateEnv, profiles: readonly ModelProfile[], nodes: readonly NodeRecord[], now: number): Promise<readonly MeshHealthEntry[]> {
  const meshProfiles = profiles.filter((profile) => profile.runtime === 'meshllm')
  const key = await meshKeyFor(env)
  const entries: MeshHealthEntry[] = []
  for (const profile of meshProfiles) {
    if (!key) {
      entries.push({ profileId: profile.id, rotation: 0, peerNodeIds: [], readyModels: [], failedNodeIds: [], deactivatedNodeIds: [], active: profile.active, tokenCount: 0, lastError: MESH_STATE_KEY_MISSING })
      continue
    }
    const state = sweepMeshState((await loadMeshState(store, key, profile.id)) ?? emptyMeshState(0), now)
    entries.push(healthEntry(profile, state, nodes, now))
  }
  return entries
}

export async function removeNodeMeshTokens(store: Store, env: MeshStateEnv, nodeId: string, now: number): Promise<void> {
  const key = await meshKeyFor(env)
  if (!key) return
  for (const profile of await store.listProfiles()) {
    if (profile.runtime !== 'meshllm') continue
    const stored = await loadMeshState(store, key, profile.id)
    if (!stored) continue
    const removed = removeNodeFromState(stored, nodeId)
    if (removed === stored) continue
    const next = sweepMeshState(removed, now)
    await saveMeshState(store, key, profile.id, next)
    if (removed.tokens.length !== stored.tokens.length) {
      await appendMeshAudit(store, 'mesh_token_removed', 'admin', nodeId, now, {
        profileId: profile.id,
        nodeId,
        rotation: next.rotation,
        ...(stored.meshId !== null ? { meshId: stored.meshId } : {})
      })
    }
    if (next !== removed || stored.seedNodeId === nodeId) {
      await appendMeshAudit(store, 'mesh_state_cleared', 'admin', profile.id, now, {
        profileId: profile.id,
        rotation: next.rotation,
        ...clearedDetail(stored)
      })
    }
  }
}

export async function electSeedIfAbsent(store: Store, env: MeshStateEnv, profileId: string, nodeId: string, now: number): Promise<{ seedNodeId: string | null; rotation: number }> {
  const key = await meshKeyFor(env)
  if (!key) return { seedNodeId: null, rotation: 0 }
  const stored = (await loadMeshState(store, key, profileId)) ?? emptyMeshState(0)
  const swept = sweepMeshState(stored, now)
  // A leftover token that belongs to this node is a stale self-island, not a joinable
  // peer, so it must not block election. Only a live seed or another node's token defers
  // election here. REQ-RUN-008.
  const joinable = swept.tokens.filter((entry) => entry.nodeId !== nodeId)
  if (swept.seedNodeId !== null || joinable.length > 0) {
    await persistSweep(store, key, profileId, stored, swept, now)
    return { seedNodeId: swept.seedNodeId, rotation: swept.rotation }
  }
  const node = await store.getNode(nodeId)
  const profile = (await store.listProfiles()).find((item) => item.id === profileId)
  if (!node || !profile || !isSeedEligible(node, profile, now)) {
    await persistSweep(store, key, profileId, stored, swept, now)
    return { seedNodeId: null, rotation: swept.rotation }
  }
  // Elect this node as seed. Its own leftover token stays: a seed is never handed its own
  // token as a join, so it creates its mesh and re-reports a fresh token and mesh id that
  // overwrite any stale ones. Clearing the token here would drop a token a healthy node just
  // reported in the same heartbeat, before it is recorded as seed. REQ-RUN-008.
  const next: MeshStateRecord = { ...swept, seedNodeId: nodeId, seedElectedAt: now }
  await saveMeshState(store, key, profileId, next)
  if (swept !== stored) {
    await appendMeshAudit(store, 'mesh_state_cleared', 'system', profileId, now, {
      profileId,
      rotation: swept.rotation,
      ...clearedDetail(stored)
    })
  }
  await appendMeshAudit(store, 'mesh_state_stored', 'system', profileId, now, {
    profileId,
    nodeId,
    rotation: next.rotation,
    ...(next.meshId !== null ? { meshId: next.meshId } : {})
  })
  return { seedNodeId: nodeId, rotation: next.rotation }
}

function bootstrapFromState(state: MeshStateRecord, nodeId: string): MeshBootstrap {
  // The elected seed always creates its own mesh, even after its invite token lands in
  // state.tokens. Checking tokens first would tell the seed to join its own mesh, flipping
  // its role every heartbeat and making the agent SIGTERM a healthy runtime. REQ-RUN-008.
  if (state.seedNodeId === nodeId) return { action: 'create', rotation: state.rotation }
  // A node only ever joins on tokens from OTHER nodes. Never hand a node its own token: a
  // seed that expired into a leftover token island would otherwise loop the node joining a
  // mesh only it can see, restarting it every heartbeat. Non-seed peers join once a real
  // peer token exists; otherwise they wait for election. REQ-RUN-008.
  const joinTokens = state.tokens.filter((entry) => entry.nodeId !== nodeId).map((entry) => entry.token)
  if (joinTokens.length > 0) {
    return {
      action: 'join',
      rotation: state.rotation,
      ...(state.meshId !== null ? { meshId: state.meshId } : {}),
      joinTokens
    }
  }
  return { action: 'wait', rotation: state.rotation }
}

function emptyMeshState(rotation: number): MeshStateRecord {
  return { rotation, meshId: null, seedNodeId: null, seedElectedAt: null, tokens: [] }
}

function seedExpired(state: MeshStateRecord, now: number): boolean {
  if (state.seedNodeId === null || state.seedElectedAt === null) return false
  if (state.tokens.some((entry) => entry.nodeId === state.seedNodeId)) return false
  return now - state.seedElectedAt > SEED_TOKEN_DEADLINE_MS
}

function sweepMeshState(state: MeshStateRecord, now: number): MeshStateRecord {
  // An expired seed (elected but silent past the token deadline) means the mesh never
  // formed. Clear the whole rotation, not just the seed, so no stale meshId or token island
  // survives for the router to replay as a phantom join; the next eligible heartbeat
  // re-elects. Rotation is preserved so the mesh name keeps advancing. REQ-RUN-008.
  if (seedExpired(state, now)) return emptyMeshState(state.rotation)
  if (state.tokens.length === 0 && state.seedNodeId === null && state.meshId !== null) return emptyMeshState(state.rotation)
  return state
}

function upsertToken(state: MeshStateRecord, nodeId: string, token: string, now: number): MeshStateRecord {
  const existing = state.tokens.find((entry) => entry.nodeId === nodeId)
  if (existing?.token === token) return state
  const others = state.tokens.filter((entry) => entry.nodeId !== nodeId)
  return { ...state, tokens: [...others, { nodeId, token, updatedAt: now }] }
}

function captureMeshId(state: MeshStateRecord, reporterNodeId: string, meshId: string | undefined): MeshStateRecord {
  if (meshId === undefined || state.meshId === meshId) return state
  if (state.meshId !== null && state.seedNodeId !== reporterNodeId) return state
  return { ...state, meshId }
}

function pruneDeadTokens(state: MeshStateRecord, nodes: readonly NodeRecord[], now: number): { state: MeshStateRecord; removed: readonly MeshTokenEntry[] } {
  const nodesById = new Map(nodes.map((node) => [node.id, node]))
  const removed = state.tokens.filter((entry) => !tokenNodeAlive(nodesById.get(entry.nodeId), now))
  if (removed.length === 0) return { state, removed }
  const kept = state.tokens.filter((entry) => tokenNodeAlive(nodesById.get(entry.nodeId), now))
  return { state: { ...state, tokens: kept }, removed }
}

function tokenNodeAlive(node: NodeRecord | undefined, now: number): boolean {
  return node !== undefined && node.status !== 'revoked' && now - node.lastSeenAt <= TOKEN_OFFLINE_TTL_MS
}

function removeNodeFromState(state: MeshStateRecord, nodeId: string): MeshStateRecord {
  const tokens = state.tokens.filter((entry) => entry.nodeId !== nodeId)
  const wasSeed = state.seedNodeId === nodeId
  if (tokens.length === state.tokens.length && !wasSeed) return state
  return { ...state, tokens, ...(wasSeed ? { seedNodeId: null, seedElectedAt: null } : {}) }
}

function isSeedEligible(node: NodeRecord, profile: ModelProfile, now: number): boolean {
  return node.status === 'online'
    && now - node.lastSeenAt <= SEED_FRESHNESS_MS
    && node.runtime === 'meshllm'
    && profile.active
    && node.activeProfileIds.includes(profile.id)
}

function selectedMeshProfile(profiles: readonly ModelProfile[], activeProfileIds: readonly string[]): ModelProfile | undefined {
  for (const profileId of activeProfileIds) {
    const profile = profiles.find((item) => item.id === profileId)
    if (profile && profile.active && profile.runtime === 'meshllm') return profile
  }
  return undefined
}

function healthEntry(profile: ModelProfile, state: MeshStateRecord, nodes: readonly NodeRecord[], now: number): MeshHealthEntry {
  const members = nodes.filter((node) => node.activeProfileIds.includes(profile.id))
  const byFreshness = (left: NodeRecord, right: NodeRecord): number => right.lastSeenAt - left.lastSeenAt
  const explicitCoordinator = members.filter((node) => node.metrics?.meshRole === 'coordinator').sort(byFreshness)[0]
  const lastErrorNode = members.filter((node) => node.metrics?.lastError !== undefined).sort(byFreshness)[0]
  const splitReadinessNode = members.filter((node) => node.metrics?.splitReadiness !== undefined).sort(byFreshness)[0]
  const readyModels = [...new Set(members.flatMap((node) => node.metrics?.readyModels ?? []))]
  const stageAssignments = meshStageAssignments(members)
  const splitReadiness = splitReadinessNode?.metrics?.splitReadiness
  const displaySplitReadiness = splitReadiness ? splitReadinessWithDisplayNames(splitReadiness, stageAssignments, members) : undefined
  const stageZero = stageAssignments.find((stage) => stage.stageIndex === 0)
  const coordinatorNodeId = explicitCoordinator?.id ?? stageZero?.reportedByNodeId ?? stageZero?.nodeId
  const failedNodeIds = members
    .filter((node) => ['failed', 'dependency-missing', 'stopped'].includes(node.metrics?.runtimeState ?? ''))
    .map((node) => node.id)
  const deactivatedNodeIds = members.filter((node) => node.deactivated === true).map((node) => node.id)
  const oldestTokenAt = state.tokens.length > 0 ? Math.min(...state.tokens.map((entry) => entry.updatedAt)) : undefined
  return {
    profileId: profile.id,
    rotation: state.rotation,
    peerNodeIds: state.tokens.map((entry) => entry.nodeId),
    readyModels,
    ...(stageAssignments.length > 0 ? { stageAssignments } : {}),
    ...(displaySplitReadiness !== undefined ? { splitReadiness: displaySplitReadiness } : {}),
    failedNodeIds,
    deactivatedNodeIds,
    active: profile.active,
    tokenCount: state.tokens.length,
    ...(state.meshId !== null ? { meshId: state.meshId } : {}),
    ...(state.seedNodeId !== null ? { seedNodeId: state.seedNodeId } : {}),
    ...(coordinatorNodeId !== undefined && coordinatorNodeId !== '' ? { coordinatorNodeId } : {}),
    ...(oldestTokenAt !== undefined ? { secretAgeMs: now - oldestTokenAt } : {}),
    ...(lastErrorNode?.metrics?.lastError !== undefined ? { lastError: lastErrorNode.metrics.lastError } : {})
  }
}

function meshStageAssignments(nodes: readonly NodeRecord[]): readonly StageAssignment[] {
  const byKey = new Map<string, StageAssignment>()
  for (const node of nodes) {
    for (const stage of node.metrics?.stageAssignments ?? []) {
      const key = `${stage.stageId ?? ''}:${stage.stageIndex}:${stage.nodeId ?? ''}:${stage.layerStart}:${stage.layerEnd}`
      if (!byKey.has(key)) byKey.set(key, { ...stage, reportedByNodeId: node.id })
    }
  }
  return [...byKey.values()].sort((left, right) => left.stageIndex - right.stageIndex)
}

function splitReadinessWithDisplayNames(report: SplitReadinessReport, stages: readonly StageAssignment[], nodes: readonly NodeRecord[]): SplitReadinessReport {
  const nodesById = new Map(nodes.map((node) => [node.id, node]))
  const nodeForParticipant = (meshNodeId: string | undefined): NodeRecord | undefined => {
    if (!meshNodeId) return undefined
    const direct = nodes.find((node) => {
      const nodeMeshId = node.metrics?.meshNodeId ?? ''
      return nodeMeshId !== '' && (nodeMeshId === meshNodeId || nodeMeshId.startsWith(meshNodeId) || meshNodeId.startsWith(nodeMeshId))
    })
    if (direct) return direct
    const stage = stages.find((item) => {
      const stageNode = item.nodeId ?? ''
      return stageNode !== '' && (stageNode === meshNodeId || stageNode.startsWith(meshNodeId) || meshNodeId.startsWith(stageNode))
    })
    return stage?.reportedByNodeId ? nodesById.get(stage.reportedByNodeId) : undefined
  }
  return {
    ...report,
    participants: report.participants?.map((participant) => {
      const node = nodeForParticipant(participant.nodeId ?? participant.shortNodeId)
      return node ? { ...participant, routerNodeId: node.id, displayName: node.displayName } : participant
    })
  }
}

async function runElection(store: Store, env: MeshStateEnv, profileId: string, nodeId: string, now: number): Promise<void> {
  const registry: DurableObjectNamespace | undefined = env.REGISTRY
  if (!registry) {
    await electSeedIfAbsent(store, env, profileId, nodeId, now)
    return
  }
  const stub = registry.get(registry.idFromName('global'))
  await stub.fetch('https://registry/mesh-election', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ profileId, nodeId, now })
  })
}

async function persistSweep(store: Store, key: CryptoKey, profileId: string, stored: MeshStateRecord, swept: MeshStateRecord, now: number): Promise<void> {
  if (swept === stored) return
  await saveMeshState(store, key, profileId, swept)
  await appendMeshAudit(store, 'mesh_state_cleared', 'system', profileId, now, {
    profileId,
    rotation: swept.rotation,
    ...clearedDetail(stored)
  })
}

function clearedDetail(previous: MeshStateRecord): Record<string, unknown> {
  return {
    ...(previous.seedNodeId !== null ? { nodeId: previous.seedNodeId } : {}),
    ...(previous.meshId !== null ? { meshId: previous.meshId } : {})
  }
}

function meshStateConfigKey(profileId: string): string {
  return `mesh_state:${profileId}`
}

async function loadMeshState(store: Store, key: CryptoKey, profileId: string): Promise<MeshStateRecord | undefined> {
  const envelope = await store.getConfig<EncryptedEnvelope>(meshStateConfigKey(profileId))
  return envelope ? await decryptJson<MeshStateRecord>(key, envelope) : undefined
}

async function saveMeshState(store: Store, key: CryptoKey, profileId: string, state: MeshStateRecord): Promise<void> {
  await store.putConfig(meshStateConfigKey(profileId), await encryptJson(key, state))
}

async function meshKeyFor(env: MeshStateEnv): Promise<CryptoKey | undefined> {
  return env.MESH_STATE_KEY ? await importMeshStateKey(env.MESH_STATE_KEY) : undefined
}

async function appendMeshAudit(store: Store, type: string, actor: string, target: string, at: number, detail: Record<string, unknown>): Promise<void> {
  await store.appendAudit({ id: crypto.randomUUID(), type, at, actor, target, detail })
}

async function adminAuthorized(request: Request, store: Store, env: MeshStateEnv, now: number): Promise<boolean> {
  const presented = bearerToken(request)
  if (await verifyPlainOrHashed(env.ADMIN_TOKEN, presented)) return true
  for (const token of await store.listTokens('admin')) {
    if (await verifyToken(presented, token, now)) return true
  }
  return false
}

async function rotateProfileId(request: Request): Promise<string | undefined> {
  const text = await request.text()
  if (!text) return undefined
  let body: { profileId?: unknown }
  try {
    body = JSON.parse(text) as { profileId?: unknown }
  } catch {
    // Absent body → undefined (caller decides how to scope the rotation); a present-but-malformed
    // body is a client mistake, so surface it as 400 invalid_json rather than silently rotating a
    // default scope the operator never asked for.
    throw new InvalidJsonBodyError()
  }
  return typeof body?.profileId === 'string' && body.profileId !== '' ? body.profileId : undefined
}

function meshJson(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: JSON_HEADERS })
}

export const MESH_STATE_ANCHORS = {
  REQ_RUN_006: 'REQ-RUN-006',
  REQ_SEC_001: 'REQ-SEC-001',
  REQ_SEC_006: 'REQ-SEC-006',
  REQ_OBS_006: 'REQ-OBS-006',
  REQ_SCH_001: 'REQ-SCH-001'
} as const
