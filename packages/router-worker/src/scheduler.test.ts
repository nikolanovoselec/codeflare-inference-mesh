import { describe, expect, it } from 'vitest'
import { DEFAULT_MODEL_PROFILES } from './profiles'
import { eligibleNodes, isEligible, selectNode, StoreScheduler } from './scheduler'
import { MemoryStore, nodeFixture } from './test-helpers'
import type { ModelProfile, NodeMetrics } from './types'

const NOW = 1_700_000_000_000
const SMOKE = DEFAULT_MODEL_PROFILES.find((profile) => profile.id === 'mesh-smoke-qwen25-1.5b') as ModelProfile
const READY: NodeMetrics = { runtimeState: 'ready', activeRequests: 0, apiReady: true, readyModels: [SMOKE.upstreamModel] }

function seededStore(): MemoryStore {
  const store = new MemoryStore()
  // The default seed makes the smoke profile the single active owner of codeflare-mesh.
  void store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)
  return store
}

describe('scheduler entry-node selection', () => {
  it('REQ-SCH-003 keeps a saturated ready node eligible now that no capacity gate exists', () => {
    // SchedulerNoCapacityGateTestAnchor
    // inFlight above capacity and a high active-request count used to disqualify the node;
    // mesh-llm owns concurrency now, so the router must still consider it eligible.
    const saturated = nodeFixture({ capacity: 1, inFlight: 9, metrics: { ...READY, activeRequests: 99 } })
    expect(isEligible(saturated, SMOKE, NOW)).toBe(true)
  })

  it('REQ-SCH-003 still excludes offline, stale, non-ready, and unsafe nodes', () => {
    expect(isEligible(nodeFixture({ status: 'offline' }), SMOKE, NOW)).toBe(false)
    expect(isEligible(nodeFixture({ lastSeenAt: NOW - 60_000 }), SMOKE, NOW)).toBe(false)
    expect(isEligible(nodeFixture({ metrics: { ...READY, runtimeState: 'starting' } }), SMOKE, NOW)).toBe(false)
    expect(isEligible(nodeFixture({ metrics: { ...READY, apiReady: false } }), SMOKE, NOW)).toBe(false)
    expect(isEligible(nodeFixture({ meshIp: '8.8.8.8' }), SMOKE, NOW)).toBe(false)
  })

  it('REQ-SCH-002 selectNode picks the least-loaded ready node by active requests', () => {
    // SchedulerLeastLoadedTestAnchor
    const busy = nodeFixture({ id: 'busy', metrics: { ...READY, activeRequests: 10 } })
    const idle = nodeFixture({ id: 'idle', meshIp: '100.64.1.11', metrics: { ...READY, activeRequests: 2 } })
    expect(selectNode([busy, idle])?.id).toBe('idle')
    expect(selectNode([idle, busy])?.id).toBe('idle')
  })

  it('REQ-SCH-002 selectNode breaks active-request ties toward the freshest heartbeat', () => {
    const older = nodeFixture({ id: 'older', lastSeenAt: NOW - 1000, metrics: { ...READY, activeRequests: 0 } })
    const newer = nodeFixture({ id: 'newer', meshIp: '100.64.1.11', lastSeenAt: NOW, metrics: { ...READY, activeRequests: 0 } })
    expect(selectNode([older, newer])?.id).toBe('newer')
  })

  it('REQ-SCH-005 selectEntryNode returns no-profile when the public model has no active profile', async () => {
    const selection = await new StoreScheduler(new MemoryStore()).selectEntryNode({ publicModel: 'codeflare-mesh', now: NOW })
    expect(selection.reason).toBe('no-profile')
    expect(selection.node).toBeUndefined()
  })

  it('REQ-SCH-005 selectEntryNode returns no-node when no eligible node is ready', async () => {
    const store = seededStore()
    await store.upsertNode(nodeFixture({ metrics: { ...READY, runtimeState: 'starting' } }))
    const selection = await new StoreScheduler(store).selectEntryNode({ publicModel: 'codeflare-mesh', now: NOW })
    expect(selection.reason).toBe('no-node')
    expect(selection.node).toBeUndefined()
  })

  it('REQ-SCH-002 selectEntryNode selects a node regardless of load and never wedges', async () => {
    // SchedulerLoadIndependentSelectionTestAnchor
    // The reservation-era gate returned no-node once inFlight reached capacity; back-to-back
    // selects against a busy node must both succeed so a client never sees a spurious 429.
    const store = seededStore()
    await store.upsertNode(nodeFixture({ capacity: 1, inFlight: 4, metrics: { ...READY, activeRequests: 40 } }))
    const scheduler = new StoreScheduler(store)

    const first = await scheduler.selectEntryNode({ publicModel: 'codeflare-mesh', now: NOW })
    const second = await scheduler.selectEntryNode({ publicModel: 'codeflare-mesh', now: NOW + 1 })

    expect(first.node?.id).toBe('node-a')
    expect(second.node?.id).toBe('node-a')
    expect(first.profile?.upstreamModel).toBe(SMOKE.upstreamModel)
    // Selection is read-only: it must not mutate the node's in-flight count.
    expect((await store.getNode('node-a'))?.inFlight).toBe(4)
  })

  it('REQ-SCH-002 selectEntryNode spreads to the least-loaded eligible node', async () => {
    const store = seededStore()
    await store.upsertNode(nodeFixture({ id: 'node-a', metrics: { ...READY, activeRequests: 7 } }))
    await store.upsertNode(nodeFixture({ id: 'node-b', meshIp: '100.64.1.11', metrics: { ...READY, activeRequests: 1 } }))

    const selection = await new StoreScheduler(store).selectEntryNode({ publicModel: 'codeflare-mesh', now: NOW })
    expect(selection.node?.id).toBe('node-b')
    expect(eligibleNodes([...store.nodes.values()], SMOKE, NOW)).toHaveLength(2)
  })

  it('REQ-ADM-030 isEligible excludes a deactivated node even when it is otherwise ready', () => {
    // SchedulerDeactivatedExcludedTestAnchor
    expect(isEligible(nodeFixture({ deactivated: true }), SMOKE, NOW)).toBe(false)
    // A node with the flag explicitly cleared stays eligible.
    expect(isEligible(nodeFixture({ deactivated: false }), SMOKE, NOW)).toBe(true)
  })

  it('REQ-ADM-030 selectEntryNode returns no-node when the only ready node is deactivated', async () => {
    const store = seededStore()
    await store.upsertNode(nodeFixture({ deactivated: true }))
    const selection = await new StoreScheduler(store).selectEntryNode({ publicModel: 'codeflare-mesh', now: NOW })
    expect(selection.reason).toBe('no-node')
    expect(selection.node).toBeUndefined()
  })
})
