/** The fleet picture the console and the automation API both read, and the settings that shape it. */
import { desiredAgentVersion } from '../agent-versions'
import { desiredRuntimeVersions } from '../runtime-versions'
import { desiredRuntimeVersionsPayload } from './node-protocol'
import { json, readJson } from '../http'
import { listMeshes } from '../meshes'
import { meshHealth } from '../mesh-state'
import { meshSummary } from './meshes'
import type { ModelProfile, NodeRecord } from '../types'
import { newestSpeedTest, storedSpeedTests } from '../speed-test'
import { nodeMeshId, profileMeshId } from '../profiles'
import { redactSecrets } from '../auth'
import type { RouterDeps } from '../deps'
import { toApiModel } from './models'
import { type ConsoleRole } from '../auth-gates'

// DEFAULT_OFFLINE_PRUNE_SECONDS removes a node that has been offline this long (30 days).
// The operator can shorten it or disable pruning with 0 via the Settings surface.
const DEFAULT_OFFLINE_PRUNE_SECONDS = 2592000

async function offlinePruneSeconds(deps: RouterDeps): Promise<number> {
  const stored = await deps.store.getConfig<number>('offline_prune_seconds')
  return typeof stored === 'number' && Number.isInteger(stored) && stored >= 0 ? stored : DEFAULT_OFFLINE_PRUNE_SECONDS
}

// applyFleetSettings is the shared core for the console and automation settings writers, so
// the two surfaces validate and persist identically and can never diverge.
export async function applyFleetSettings(request: Request, deps: RouterDeps, actor: string, requestId: string, now: number): Promise<Response> {
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

export async function handleAdminStatus(deps: RouterDeps, requestId: string, now: number, role: ConsoleRole): Promise<Response> {
  const isAdmin = role === 'admin'
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
    viewerRole: role,
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

export async function handleApiStatus(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
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

/** Machine-facing node projection: identity, state, and metrics — never token verifiers or internal ports. */
export function toApiNode(node: NodeRecord, runtimeVersions?: { readonly meshllm: string; readonly llamacpp: string }) {
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

// Automation twins of the console operator settings (POST /admin/settings): read and write
// the fleet-tunable settings via the API, reusing the same shared validation core.
export async function handleApiSettingsGet(deps: RouterDeps, requestId: string): Promise<Response> {
  return json({ offlinePruneSeconds: await offlinePruneSeconds(deps), desiredRuntimeVersions: await desiredRuntimeVersions(deps.store) }, 200, requestId)
}
