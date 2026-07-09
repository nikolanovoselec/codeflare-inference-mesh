import { describe, expect, it } from 'vitest'
import { decryptJson, encryptJson, importMeshStateKey, type EncryptedEnvelope } from './mesh-crypto'
import { applyHeartbeatMeshState, electSeedIfAbsent, handleMeshRotate, meshBootstrapFor, meshHealth, removeNodeMeshTokens, type MeshStateRecord } from './mesh-state'
import { MemoryStore, nodeFixture } from './test-helpers'
import type { HeartbeatRequest, ModelProfile, NodeRecord, RouterEnv } from './types'

const NOW = 1_700_000_000_000
const MESH_STATE_KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8='
const PROFILE_ID = 'mesh-default-qwen36-35b'
const UPSTREAM_MODEL = 'unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ3_S'
const STATE_CONFIG_KEY = `mesh_state:${PROFILE_ID}`

function meshProfile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: PROFILE_ID,
    displayName: 'Mesh Test Model',
    publicAliases: ['codeflare-mesh'],
    upstreamModel: UPSTREAM_MODEL,
    sourceMode: 'meshllm-ref',
    contextWindow: 262144,
    runtime: 'meshllm',
    meshllm: { modelRef: UPSTREAM_MODEL, split: false, bindPort: 4300 },
    version: 1,
    rolloutPercent: 100,
    active: true,
    ...overrides
  }
}

function meshEnv(overrides: Partial<RouterEnv> = {}): RouterEnv {
  return { MESH_STATE_KEY, ADMIN_TOKEN: 'admin-secret', ...overrides } as RouterEnv
}

function keylessEnv(): RouterEnv {
  return { ADMIN_TOKEN: 'admin-secret' } as RouterEnv
}

function meshNode(id: string, overrides: Partial<NodeRecord> = {}): NodeRecord {
  // Mesh-state fixtures serve PROFILE_ID (the 35B upstream), so the node must report
  // that model — not nodeFixture's smoke-1.5B default — for meshHealth's readyModels.
  return nodeFixture({
    id,
    displayName: `Node ${id}`,
    activeProfileIds: [PROFILE_ID],
    runtimeModel: UPSTREAM_MODEL,
    metrics: { runtimeState: 'ready', loadedModel: UPSTREAM_MODEL, activeRequests: 0, apiReady: true, readyModels: [UPSTREAM_MODEL] },
    ...overrides
  })
}

function heartbeatFor(node: NodeRecord, overrides: Partial<HeartbeatRequest> = {}): HeartbeatRequest {
  return {
    nodeId: node.id,
    displayName: node.displayName,
    meshIp: node.meshIp,
    inferencePort: node.inferencePort,
    localDashboardPort: node.localDashboardPort,
    status: node.status,
    publicModels: node.publicModels,
    activeProfileIds: node.activeProfileIds,
    capacity: node.capacity,
    inFlight: node.inFlight,
    runtime: 'meshllm',
    ...overrides
  }
}

async function meshFixture(...nodes: readonly NodeRecord[]): Promise<{ store: MemoryStore; env: RouterEnv; profile: ModelProfile }> {
  const store = new MemoryStore()
  const profile = meshProfile()
  await store.setProfile(profile)
  for (const node of nodes) await store.upsertNode(node)
  return { store, env: meshEnv(), profile }
}

async function reportToken(store: MemoryStore, env: RouterEnv, node: NodeRecord, token: string, meshId: string, at: number): Promise<NodeRecord> {
  const fresh = { ...node, lastSeenAt: at }
  await store.upsertNode(fresh)
  await applyHeartbeatMeshState(store, env, fresh, heartbeatFor(fresh, { meshToken: token, meshId }), at)
  return fresh
}

async function storedState(store: MemoryStore, profileId = PROFILE_ID): Promise<MeshStateRecord> {
  const envelope = await store.getConfig<EncryptedEnvelope>(`mesh_state:${profileId}`)
  expect(envelope).toBeDefined()
  return await decryptJson<MeshStateRecord>(await importMeshStateKey(MESH_STATE_KEY), envelope!)
}

// Write raw mesh state directly, bypassing the state machine. Used to reproduce a stale
// island the old sweep could leave (seed cleared, mesh id + tokens retained) so the heal
// path can be tested; the current code never writes such a state itself.
async function seedRawState(store: MemoryStore, state: MeshStateRecord): Promise<void> {
  await store.putConfig(STATE_CONFIG_KEY, await encryptJson(await importMeshStateKey(MESH_STATE_KEY), state))
}

function rotateRequest(body: unknown, token = 'admin-secret'): Request {
  return new Request('https://router.example/admin/mesh/rotate', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
}

function auditTypes(store: MemoryStore): readonly string[] {
  return store.audit.map((event) => event.type)
}

describe('mesh state core', () => {
  it('REQ-RUN-008 elects the first seed-eligible heartbeater with a store-if-absent write', async () => {
    const { store, env, profile } = await meshFixture(meshNode('node-a'), meshNode('node-b'))

    const winner = await meshBootstrapFor(store, env, meshNode('node-a'), profile, NOW)
    const loser = await meshBootstrapFor(store, env, meshNode('node-b'), profile, NOW)

    expect(winner).toEqual({ action: 'create', rotation: 0 })
    expect(loser).toEqual({ action: 'wait', rotation: 0 })

    const state = await storedState(store)
    expect(state.seedNodeId).toBe('node-a')
    expect(state.seedElectedAt).toBe(NOW)
    expect(state.tokens).toEqual([])

    const retry = await electSeedIfAbsent(store, env, PROFILE_ID, 'node-b', NOW)
    expect(retry).toEqual({ seedNodeId: 'node-a', rotation: 0 })
    expect((await storedState(store)).seedNodeId).toBe('node-a')
    expect(store.audit.filter((event) => event.type === 'mesh_state_stored')).toHaveLength(1)

    const staleFixture = await meshFixture(meshNode('node-stale', { lastSeenAt: NOW - 60_000 }))
    const staleBootstrap = await meshBootstrapFor(staleFixture.store, staleFixture.env, meshNode('node-stale', { lastSeenAt: NOW - 60_000 }), staleFixture.profile, NOW)
    expect(staleBootstrap).toEqual({ action: 'wait', rotation: 0 })
    expect(staleFixture.store.config.has(STATE_CONFIG_KEY)).toBe(false)
  })

  it('REQ-OBS-007 reflects the profile active state and deactivated member nodes in the health entry', async () => {
    const { store, env, profile } = await meshFixture(meshNode('node-a', { deactivated: true }))
    const entries = await meshHealth(store, env, [profile], await store.listNodes(NOW), NOW)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.active).toBe(true)
    expect(entries[0]!.deactivatedNodeIds).toEqual(['node-a'])

    const off = await meshHealth(store, env, [meshProfile({ active: false })], await store.listNodes(NOW), NOW)
    expect(off[0]!.active).toBe(false)
  })

  it('REQ-RUN-008 returns create to the seed and wait then join with live tokens to peers', async () => {
    const nodeA = meshNode('node-a')
    const nodeB = meshNode('node-b')
    const { store, env, profile } = await meshFixture(nodeA, nodeB)

    expect(await meshBootstrapFor(store, env, nodeA, profile, NOW)).toEqual({ action: 'create', rotation: 0 })
    expect(await meshBootstrapFor(store, env, nodeB, profile, NOW)).toEqual({ action: 'wait', rotation: 0 })

    const freshA = await reportToken(store, env, nodeA, 'invite-token-node-a', 'mesh-1', NOW + 15_000)
    const freshB = { ...nodeB, lastSeenAt: NOW + 15_000 }
    await store.upsertNode(freshB)
    expect(await meshBootstrapFor(store, env, freshB, profile, NOW + 15_000)).toEqual({
      action: 'join',
      rotation: 0,
      meshId: 'mesh-1',
      joinTokens: ['invite-token-node-a']
    })

    await reportToken(store, env, freshB, 'invite-token-node-b', 'mesh-1', NOW + 30_000)
    const seedBootstrap = await meshBootstrapFor(store, env, { ...freshA, lastSeenAt: NOW + 30_000 }, profile, NOW + 30_000)
    expect(seedBootstrap).toEqual({ action: 'create', rotation: 0 })

    await store.upsertNode({ ...freshA, lastSeenAt: NOW + 30_000, metrics: { ...freshA.metrics!, meshRole: 'coordinator' } })
    const entries = await meshHealth(store, env, [profile], await store.listNodes(NOW + 30_000), NOW + 30_000)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toEqual({
      profileId: PROFILE_ID,
      meshId: 'mesh-1',
      rotation: 0,
      seedNodeId: 'node-a',
      coordinatorNodeId: 'node-a',
      peerNodeIds: ['node-a', 'node-b'],
      readyModels: [UPSTREAM_MODEL],
      failedNodeIds: [],
      deactivatedNodeIds: [],
      active: true,
      tokenCount: 2,
      secretAgeMs: 15_000
    })
    expect(JSON.stringify(entries)).not.toContain('invite-token')
  })

  it('REQ-RUN-008 answers create to the seed even after its invite token lands', async () => {
    const nodeA = meshNode('node-a')
    const { store, env, profile } = await meshFixture(nodeA)

    expect(await meshBootstrapFor(store, env, nodeA, profile, NOW)).toEqual({ action: 'create', rotation: 0 })

    const stillLaunching = { ...nodeA, lastSeenAt: NOW + 15_000 }
    await store.upsertNode(stillLaunching)
    await applyHeartbeatMeshState(store, env, stillLaunching, heartbeatFor(stillLaunching), NOW + 15_000)
    expect(await meshBootstrapFor(store, env, stillLaunching, profile, NOW + 15_000)).toEqual({ action: 'create', rotation: 0 })

    const reporting = await reportToken(store, env, stillLaunching, 'invite-token-node-a', 'mesh-1', NOW + 30_000)
    expect(await meshBootstrapFor(store, env, reporting, profile, NOW + 30_000)).toEqual({ action: 'create', rotation: 0 })

    const steady = await reportToken(store, env, reporting, 'invite-token-node-a', 'mesh-1', NOW + 45_000)
    expect(await meshBootstrapFor(store, env, steady, profile, NOW + 45_000)).toEqual({ action: 'create', rotation: 0 })
  })

  it('REQ-RUN-008 upserts reported invite tokens into the profile token set', async () => {
    const nodeA = meshNode('node-a')
    const { store, env } = await meshFixture(nodeA)

    await reportToken(store, env, nodeA, 'invite-token-one', 'mesh-1', NOW)
    expect((await storedState(store)).tokens).toEqual([{ nodeId: 'node-a', token: 'invite-token-one', updatedAt: NOW }])
    expect(store.audit.filter((event) => event.type === 'mesh_state_stored')).toHaveLength(1)

    await reportToken(store, env, nodeA, 'invite-token-one', 'mesh-1', NOW + 15_000)
    expect((await storedState(store)).tokens).toEqual([{ nodeId: 'node-a', token: 'invite-token-one', updatedAt: NOW }])
    expect(store.audit.filter((event) => event.type === 'mesh_state_stored')).toHaveLength(1)

    await reportToken(store, env, nodeA, 'invite-token-two', 'mesh-1', NOW + 30_000)
    expect((await storedState(store)).tokens).toEqual([{ nodeId: 'node-a', token: 'invite-token-two', updatedAt: NOW + 30_000 }])
    expect(store.audit.filter((event) => event.type === 'mesh_state_stored')).toHaveLength(2)
  })

  it('REQ-RUN-008 clears a seed that reports no token within four heartbeat intervals and re-elects', async () => {
    const nodeA = meshNode('node-a')
    const nodeB = meshNode('node-b')
    const { store, env, profile } = await meshFixture(nodeA, nodeB)

    expect(await meshBootstrapFor(store, env, nodeA, profile, NOW)).toEqual({ action: 'create', rotation: 0 })

    const withinWindow = { ...nodeB, lastSeenAt: NOW + 59_000 }
    await store.upsertNode(withinWindow)
    expect(await meshBootstrapFor(store, env, withinWindow, profile, NOW + 59_000)).toEqual({ action: 'wait', rotation: 0 })
    expect((await storedState(store)).seedNodeId).toBe('node-a')

    const afterDeadline = { ...nodeB, lastSeenAt: NOW + 61_000 }
    await store.upsertNode(afterDeadline)
    expect(await meshBootstrapFor(store, env, afterDeadline, profile, NOW + 61_000)).toEqual({ action: 'create', rotation: 0 })

    const state = await storedState(store)
    expect(state.seedNodeId).toBe('node-b')
    expect(state.seedElectedAt).toBe(NOW + 61_000)
    expect(auditTypes(store)).toContain('mesh_state_cleared')
  })

  it('REQ-RUN-008 prunes revoked and stale tokens and re-elects when the set empties', async () => {
    const nodeA = meshNode('node-a')
    const nodeB = meshNode('node-b')
    const { store, env, profile } = await meshFixture(nodeA, nodeB)

    const rotated = await handleMeshRotate(rotateRequest({ profileId: PROFILE_ID }), store, env, NOW)
    expect(rotated.status).toBe(200)

    expect(await meshBootstrapFor(store, env, nodeA, profile, NOW)).toEqual({ action: 'create', rotation: 1 })
    await reportToken(store, env, nodeA, 'invite-token-node-a', 'mesh-2', NOW + 15_000)
    await reportToken(store, env, nodeB, 'invite-token-node-b', 'mesh-2', NOW + 30_000)
    expect((await storedState(store)).tokens).toHaveLength(2)

    const later = NOW + 26 * 60 * 60 * 1000
    await store.revokeNode('node-b', later)
    const nodeC = meshNode('node-c', { lastSeenAt: later })
    await store.upsertNode(nodeC)
    await applyHeartbeatMeshState(store, env, nodeC, heartbeatFor(nodeC), later)

    const cleared = await storedState(store)
    expect(cleared).toEqual({ rotation: 1, meshId: null, seedNodeId: null, seedElectedAt: null, tokens: [] })

    const removedTargets = store.audit.filter((event) => event.type === 'mesh_token_removed').map((event) => event.target)
    expect(removedTargets).toContain('node-a')
    expect(removedTargets).toContain('node-b')
    expect(auditTypes(store)).toContain('mesh_state_cleared')

    expect(await meshBootstrapFor(store, env, nodeC, profile, later)).toEqual({ action: 'create', rotation: 1 })
    expect((await storedState(store)).seedNodeId).toBe('node-c')
  })

  it('REQ-RUN-008 re-elects a node holding only its own token instead of joining it to itself', async () => {
    const nodeA = meshNode('node-a')
    const { store, env, profile } = await meshFixture(nodeA)
    await seedRawState(store, {
      rotation: 2,
      meshId: 'mesh-stale',
      seedNodeId: null,
      seedElectedAt: null,
      tokens: [{ nodeId: 'node-a', token: 'invite-token-node-a', updatedAt: NOW }]
    })

    // The node is re-elected to create its own mesh (a create bootstrap carries no joinTokens),
    // never handed its own token as a join target. Its token stays until it re-reports a fresh
    // one after the create restart.
    expect(await meshBootstrapFor(store, env, nodeA, profile, NOW + 15_000)).toEqual({ action: 'create', rotation: 2 })
    expect((await storedState(store)).seedNodeId).toBe('node-a')
  })

  it('REQ-RUN-008 seed expiry clears the whole rotation including stale mesh id and foreign tokens', async () => {
    const nodeA = meshNode('node-a')
    const { store, env, profile } = await meshFixture(nodeA)
    await seedRawState(store, {
      rotation: 3,
      meshId: 'mesh-ghost',
      seedNodeId: 'ghost-seed',
      seedElectedAt: NOW,
      tokens: [{ nodeId: 'ghost-peer', token: 'ghost-token', updatedAt: NOW }]
    })

    const afterDeadline = { ...nodeA, lastSeenAt: NOW + 61_000 }
    await store.upsertNode(afterDeadline)
    expect(await meshBootstrapFor(store, env, afterDeadline, profile, NOW + 61_000)).toEqual({ action: 'create', rotation: 3 })

    const state = await storedState(store)
    expect(state.seedNodeId).toBe('node-a')
    expect(state.meshId).toBeNull()
    expect(state.tokens).toEqual([])
    expect(auditTypes(store)).toContain('mesh_state_cleared')
  })

  it('REQ-SEC-001 delivers mesh bootstrap only in node-token-authenticated heartbeat responses', async () => {
    const nodeA = meshNode('node-a')
    const { store, env, profile } = await meshFixture(nodeA)
    await meshBootstrapFor(store, env, nodeA, profile, NOW)
    await reportToken(store, env, nodeA, 'invite-token-node-a', 'mesh-1', NOW)

    expect(await meshBootstrapFor(store, env, meshNode('node-b', { status: 'offline' }), profile, NOW)).toBeUndefined()
    expect(await meshBootstrapFor(store, env, meshNode('node-c', { status: 'draining' }), profile, NOW)).toBeUndefined()

    await store.upsertNode(meshNode('node-d'))
    await store.revokeNode('node-d', NOW)
    const revoked = await store.getNode('node-d')
    expect(await meshBootstrapFor(store, env, revoked!, profile, NOW)).toBeUndefined()

    const online = meshNode('node-e')
    await store.upsertNode(online)
    expect(await meshBootstrapFor(store, env, online, profile, NOW)).toEqual({
      action: 'join',
      rotation: 0,
      meshId: 'mesh-1',
      joinTokens: ['invite-token-node-a']
    })
  })

  it('REQ-SEC-006 stores mesh state as round-tripping ciphertext and never plaintext tokens', async () => {
    const nodeA = meshNode('node-a')
    const { store, env, profile } = await meshFixture(nodeA)
    await meshBootstrapFor(store, env, nodeA, profile, NOW)
    await reportToken(store, env, nodeA, 'invite-token-node-a', 'mesh-1', NOW + 15_000)

    const envelope = store.config.get(STATE_CONFIG_KEY) as EncryptedEnvelope
    expect(Object.keys(envelope).sort()).toEqual(['ciphertext', 'iv'])
    expect(typeof envelope.iv).toBe('string')
    expect(typeof envelope.ciphertext).toBe('string')

    const rawText = JSON.stringify(envelope)
    expect(rawText).not.toContain('invite-token-node-a')
    expect(rawText).not.toContain('mesh-1')
    expect(rawText).not.toContain('node-a')

    const key = await importMeshStateKey(MESH_STATE_KEY)
    const state = await decryptJson<MeshStateRecord>(key, envelope)
    expect(state.meshId).toBe('mesh-1')
    expect(state.seedNodeId).toBe('node-a')
    expect(state.tokens).toEqual([{ nodeId: 'node-a', token: 'invite-token-node-a', updatedAt: NOW + 15_000 }])

    const otherKey = await importMeshStateKey(btoa(String.fromCharCode(...new Uint8Array(32).fill(9))))
    let rejected = false
    try {
      await decryptJson(otherKey, envelope)
    } catch {
      rejected = true
    }
    expect(rejected).toBe(true)
  })

  it('REQ-SEC-006 fails closed on missing MESH_STATE_KEY for mesh endpoints only', async () => {
    const nodeA = meshNode('node-a')
    const store = new MemoryStore()
    const profile = meshProfile()
    await store.setProfile(profile)
    await store.upsertNode(nodeA)
    const env = keylessEnv()

    const response = await handleMeshRotate(rotateRequest({ profileId: PROFILE_ID }), store, env, NOW)
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'mesh_state_key_missing' })

    expect(await meshBootstrapFor(store, env, nodeA, profile, NOW)).toBeUndefined()

    await applyHeartbeatMeshState(store, env, nodeA, heartbeatFor(nodeA, { meshToken: 'invite-token-node-a', meshId: 'mesh-1' }), NOW)
    expect(store.config.size).toBe(0)

    await removeNodeMeshTokens(store, env, 'node-a', NOW)
    expect(store.config.size).toBe(0)

    const entries = await meshHealth(store, env, [profile], [nodeA], NOW)
    expect(entries).toEqual([{ profileId: PROFILE_ID, rotation: 0, peerNodeIds: [], readyModels: [], failedNodeIds: [], deactivatedNodeIds: [], active: true, tokenCount: 0, lastError: 'mesh_state_key_missing' }])

    const keyed = await handleMeshRotate(rotateRequest({ profileId: PROFILE_ID }), store, meshEnv(), NOW)
    expect(keyed.status).toBe(200)
  })

  it('REQ-OBS-007 carries split readiness blockers and machine names into mesh health', async () => {
    const report = {
      modelRef: UPSTREAM_MODEL,
      verdict: 'insufficient_capacity',
      capacityAdvice: { state: 'insufficient_capacity', reason: 'participant_split_capacity_insufficient', requiredBytes: 18_000_000_000, aggregateCapacityBytes: 16_000_000_000, shortfallBytes: 2_000_000_000, eligibleNodeCount: 2, splitCapable: true },
      participants: [{ shortNodeId: 'mesh-mac', vramBytes: 4_000_000_000 }, { shortNodeId: 'mesh-battle', vramBytes: 12_000_000_000 }],
      blockers: [{ reason: 'split_capacity_shortfall', recommendation: 'Increase available VRAM.' }]
    }
    const nodeA = meshNode('node-a', { displayName: 'battlestation', lastSeenAt: NOW, metrics: { runtimeState: 'starting', activeRequests: 0, meshNodeId: 'mesh-battlestation', splitReadiness: report } })
    const nodeB = meshNode('node-b', { displayName: 'Mac', lastSeenAt: NOW, metrics: { runtimeState: 'ready', activeRequests: 0, meshNodeId: 'mesh-mac' } })
    const nodeC = meshNode('node-c', { displayName: 'battlestation', lastSeenAt: NOW, metrics: { runtimeState: 'ready', activeRequests: 0, meshNodeId: 'mesh-battle' } })
    const { store, env, profile } = await meshFixture(nodeA, nodeB, nodeC)
    await reportToken(store, env, nodeA, 'invite-token-node-a', 'mesh-1', NOW)

    const entries = await meshHealth(store, env, [profile], [nodeA, nodeB, nodeC], NOW)
    expect(entries[0]?.splitReadiness?.blockers?.[0]?.reason).toBe('split_capacity_shortfall')
    expect(entries[0]?.splitReadiness?.capacityAdvice?.shortfallBytes).toBe(2_000_000_000)
    expect(entries[0]?.splitReadiness?.participants?.map((item) => item.displayName)).toEqual(['Mac', 'battlestation'])
  })

  it('REQ-OBS-011 aggregates full stage ownership and prefers ready duplicate reports', async () => {
    const nodeA = meshNode('linux-node', { displayName: 'Arch Linux', lastSeenAt: NOW, metrics: { runtimeState: 'ready', activeRequests: 0, meshNodeId: 'mesh-linux', stageAssignments: [{ stageIndex: 0, nodeId: 'mesh-linux', layerStart: 0, layerEnd: 26, state: 'ready' }] } })
    const nodeB = meshNode('mac-node', { displayName: 'Macbook Air', lastSeenAt: NOW, metrics: { runtimeState: 'ready', activeRequests: 0, meshNodeId: 'mesh-mac', stageAssignments: [{ stageIndex: 1, nodeId: 'mesh-mac', layerStart: 27, layerEnd: 28, state: 'failed' }, { stageIndex: 1, nodeId: 'mesh-mac', layerStart: 27, layerEnd: 28, state: 'ready' }] } })
    const { store, env, profile } = await meshFixture(nodeA, nodeB)
    await reportToken(store, env, nodeA, 'invite-token-node-a', 'mesh-1', NOW)

    const [entry] = await meshHealth(store, env, [profile], [nodeA, nodeB], NOW)
    expect(entry).toBeDefined()
    expect(entry!.stageAssignments).toEqual([
      expect.objectContaining({ stageIndex: 0, nodeId: 'mesh-linux', layerStart: 0, layerEnd: 26, state: 'ready', reportedByNodeId: 'linux-node' }),
      expect.objectContaining({ stageIndex: 1, nodeId: 'mesh-mac', layerStart: 27, layerEnd: 28, state: 'ready', reportedByNodeId: 'mac-node' })
    ])
  })

  it('REQ-SEC-006 distributes join tokens only to live non-revoked nodes', async () => {
    const nodeA = meshNode('node-a')
    const { store, env, profile } = await meshFixture(nodeA)
    await meshBootstrapFor(store, env, nodeA, profile, NOW)
    await reportToken(store, env, nodeA, 'invite-token-node-a', 'mesh-1', NOW)

    const assigned = meshNode('node-b')
    await store.upsertNode(assigned)
    const bootstrap = await meshBootstrapFor(store, env, assigned, profile, NOW)
    expect(bootstrap?.action).toBe('join')
    expect(bootstrap?.joinTokens).toEqual(['invite-token-node-a'])

    const unassigned = meshNode('node-c', { activeProfileIds: ['other-profile'] })
    expect(await meshBootstrapFor(store, env, unassigned, profile, NOW)).toBeUndefined()

    expect(await meshBootstrapFor(store, env, meshNode('node-d', { status: 'offline' }), profile, NOW)).toBeUndefined()

    await store.upsertNode(meshNode('node-e'))
    await store.revokeNode('node-e', NOW)
    expect(await meshBootstrapFor(store, env, (await store.getNode('node-e'))!, profile, NOW)).toBeUndefined()

    expect(await meshBootstrapFor(store, env, nodeA, meshProfile({ active: false }), NOW)).toBeUndefined()
  })

  it('REQ-SEC-006 rotate increments the counter, clears state, and audits', async () => {
    const nodeA = meshNode('node-a')
    const { store, env, profile } = await meshFixture(nodeA)
    await meshBootstrapFor(store, env, nodeA, profile, NOW)
    await reportToken(store, env, nodeA, 'invite-token-node-a', 'mesh-1', NOW + 15_000)

    expect((await handleMeshRotate(rotateRequest({ profileId: PROFILE_ID }, 'wrong-token'), store, env, NOW + 30_000)).status).toBe(401)
    expect((await handleMeshRotate(rotateRequest({}), store, env, NOW + 30_000)).status).toBe(400)
    expect((await handleMeshRotate(rotateRequest({ profileId: 'missing-profile' }), store, env, NOW + 30_000)).status).toBe(404)

    const response = await handleMeshRotate(rotateRequest({ profileId: PROFILE_ID }), store, env, NOW + 30_000)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, profileId: PROFILE_ID, rotation: 1 })

    const state = await storedState(store)
    expect(state).toEqual({ rotation: 1, meshId: null, seedNodeId: null, seedElectedAt: null, tokens: [] })

    const rotatedEvents = store.audit.filter((event) => event.type === 'mesh_token_rotated')
    expect(rotatedEvents).toHaveLength(1)
    expect(rotatedEvents[0]!.target).toBe(PROFILE_ID)
    expect(rotatedEvents[0]!.detail).toEqual({ profileId: PROFILE_ID, rotation: 1, meshId: 'mesh-1' })
    expect(JSON.stringify(store.audit)).not.toContain('invite-token')
  })

  it('REQ-SEC-006 post-rotation heartbeats carry the new rotation and bootstrap', async () => {
    const nodeA = meshNode('node-a')
    const nodeB = meshNode('node-b')
    const { store, env, profile } = await meshFixture(nodeA, nodeB)
    await meshBootstrapFor(store, env, nodeA, profile, NOW)
    await reportToken(store, env, nodeA, 'invite-token-node-a', 'mesh-1', NOW + 15_000)

    const rotated = await handleMeshRotate(rotateRequest({ profileId: PROFILE_ID }), store, env, NOW + 30_000)
    expect(rotated.status).toBe(200)

    const freshA = { ...nodeA, lastSeenAt: NOW + 45_000 }
    const freshB = { ...nodeB, lastSeenAt: NOW + 45_000 }
    await store.upsertNode(freshA)
    await store.upsertNode(freshB)
    expect(await meshBootstrapFor(store, env, freshA, profile, NOW + 45_000)).toEqual({ action: 'create', rotation: 1 })
    expect(await meshBootstrapFor(store, env, freshB, profile, NOW + 45_000)).toEqual({ action: 'wait', rotation: 1 })

    await reportToken(store, env, freshA, 'invite-token-node-a-r1', 'mesh-2', NOW + 60_000)
    expect(await meshBootstrapFor(store, env, { ...freshB, lastSeenAt: NOW + 60_000 }, profile, NOW + 60_000)).toEqual({
      action: 'join',
      rotation: 1,
      meshId: 'mesh-2',
      joinTokens: ['invite-token-node-a-r1']
    })
  })

  it('REQ-SEC-007 revoke removes the node token entry and audits', async () => {
    const nodeA = meshNode('node-a')
    const nodeB = meshNode('node-b')
    const { store, env, profile } = await meshFixture(nodeA, nodeB)
    await meshBootstrapFor(store, env, nodeA, profile, NOW)
    await reportToken(store, env, nodeA, 'invite-token-node-a', 'mesh-1', NOW)
    await reportToken(store, env, nodeB, 'invite-token-node-b', 'mesh-1', NOW)

    await removeNodeMeshTokens(store, env, 'node-b', NOW + 15_000)
    const afterPeerRemoval = await storedState(store)
    expect(afterPeerRemoval.tokens).toEqual([{ nodeId: 'node-a', token: 'invite-token-node-a', updatedAt: NOW }])
    expect(afterPeerRemoval.seedNodeId).toBe('node-a')

    const removedEvents = store.audit.filter((event) => event.type === 'mesh_token_removed')
    expect(removedEvents).toHaveLength(1)
    expect(removedEvents[0]!.target).toBe('node-b')
    expect(removedEvents[0]!.detail).toEqual({ profileId: PROFILE_ID, nodeId: 'node-b', rotation: 0, meshId: 'mesh-1' })
    expect(JSON.stringify(store.audit)).not.toContain('invite-token')

    await removeNodeMeshTokens(store, env, 'node-a', NOW + 30_000)
    const afterSeedRemoval = await storedState(store)
    expect(afterSeedRemoval).toEqual({ rotation: 0, meshId: null, seedNodeId: null, seedElectedAt: null, tokens: [] })
    expect(auditTypes(store)).toContain('mesh_state_cleared')
  })

  it('REQ-SEC-007 readmits a revoked node only after re-enrollment', async () => {
    const nodeA = meshNode('node-a')
    const nodeB = meshNode('node-b')
    const { store, env, profile } = await meshFixture(nodeA, nodeB)
    await meshBootstrapFor(store, env, nodeA, profile, NOW)
    await reportToken(store, env, nodeA, 'invite-token-node-a', 'mesh-1', NOW)
    await reportToken(store, env, nodeB, 'invite-token-node-b', 'mesh-1', NOW)

    await store.revokeNode('node-a', NOW + 15_000)
    await removeNodeMeshTokens(store, env, 'node-a', NOW + 15_000)
    const revoked = (await store.getNode('node-a'))!
    expect(await meshBootstrapFor(store, env, revoked, profile, NOW + 15_000)).toBeUndefined()

    await applyHeartbeatMeshState(store, env, revoked, heartbeatFor(revoked, { meshToken: 'invite-token-node-a', meshId: 'mesh-1' }), NOW + 30_000)
    expect((await storedState(store)).tokens).toEqual([{ nodeId: 'node-b', token: 'invite-token-node-b', updatedAt: NOW }])

    const reenrolled = meshNode('node-a', { lastSeenAt: NOW + 45_000 })
    await store.upsertNode(reenrolled)
    expect(await meshBootstrapFor(store, env, reenrolled, profile, NOW + 45_000)).toEqual({
      action: 'join',
      rotation: 0,
      meshId: 'mesh-1',
      joinTokens: ['invite-token-node-b']
    })
  })

  it('REQ-OBS-006 records mesh lifecycle audit events without token material', async () => {
    const nodeA = meshNode('node-a')
    const nodeB = meshNode('node-b')
    const { store, env, profile } = await meshFixture(nodeA, nodeB)

    await meshBootstrapFor(store, env, nodeA, profile, NOW)
    await reportToken(store, env, nodeA, 'invite-token-node-a', 'mesh-1', NOW + 15_000)
    await handleMeshRotate(rotateRequest({ profileId: PROFILE_ID }), store, env, NOW + 30_000)
    await meshBootstrapFor(store, env, { ...nodeA, lastSeenAt: NOW + 45_000 }, profile, NOW + 45_000)
    await reportToken(store, env, nodeA, 'invite-token-node-a-r1', 'mesh-2', NOW + 60_000)
    await reportToken(store, env, nodeB, 'invite-token-node-b-r1', 'mesh-2', NOW + 60_000)
    await removeNodeMeshTokens(store, env, 'node-b', NOW + 75_000)
    await removeNodeMeshTokens(store, env, 'node-a', NOW + 90_000)

    const types = auditTypes(store)
    expect(types).toContain('mesh_state_stored')
    expect(types).toContain('mesh_token_rotated')
    expect(types).toContain('mesh_token_removed')
    expect(types).toContain('mesh_state_cleared')

    const meshEvents = store.audit.filter((event) => event.type.startsWith('mesh_'))
    expect(meshEvents.length).toBeGreaterThanOrEqual(4)
    for (const event of meshEvents) {
      expect(event.detail.profileId).toBe(PROFILE_ID)
      expect(typeof event.detail.rotation).toBe('number')
    }
    const storedEvents = store.audit.filter((event) => event.type === 'mesh_state_stored')
    for (const event of storedEvents) {
      expect(typeof event.detail.nodeId).toBe('string')
    }
    expect(JSON.stringify(store.audit)).not.toContain('invite-token')
  })

  it('REQ-SCH-001 stores mesh state as AES-GCM ciphertext and round-trips it from D1', async () => {
    const nodeA = meshNode('node-a')
    const { store, env, profile } = await meshFixture(nodeA)
    await meshBootstrapFor(store, env, nodeA, profile, NOW)
    await reportToken(store, env, nodeA, 'invite-token-node-a', 'mesh-1', NOW + 15_000)

    expect([...store.config.keys()]).toEqual([STATE_CONFIG_KEY])

    const key = await importMeshStateKey(MESH_STATE_KEY)
    const persisted = store.config.get(STATE_CONFIG_KEY) as EncryptedEnvelope
    const state = await decryptJson<MeshStateRecord>(key, persisted)
    expect(state).toEqual({
      rotation: 0,
      meshId: 'mesh-1',
      seedNodeId: 'node-a',
      seedElectedAt: NOW,
      tokens: [{ nodeId: 'node-a', token: 'invite-token-node-a', updatedAt: NOW + 15_000 }]
    })

    const reEncrypted = await encryptJson(key, state)
    expect(Object.keys(reEncrypted).sort()).toEqual(['ciphertext', 'iv'])
    expect(reEncrypted.ciphertext).not.toBe(persisted.ciphertext)
    expect(await decryptJson<MeshStateRecord>(key, reEncrypted)).toEqual(state)
    expect(JSON.stringify(reEncrypted)).not.toContain('invite-token-node-a')
  })
})
