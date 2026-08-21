/** Operating individual agents: revoke, deactivate, reload, reconfigure, decommission. */
import { desiredRuntimeVersions } from '../runtime-versions'
import { INVALID_MAX_VRAM, INVALID_NODE_NAME, nodeWithConfig, type NodeConfigBody } from '../profile-config'
import { json, readJson } from '../http'
import { listMeshes } from '../meshes'
import { nodeMeshId } from '../profiles'
import type { NodeRecord } from '../types'
import { removeNodeMeshTokens } from '../mesh-state'
import type { RouterDeps } from '../deps'
import { toApiNode } from './status'

// handleNodeRevoke removes a machine outright: it revokes the node's credentials
// and mesh tokens (so a still-running agent is rejected on its next heartbeat and
// cannot rejoin) and then deletes the node row so the machine disappears from the
// console immediately. The node_revoked audit event preserves the record; a real
// re-enrollment mints a fresh row.
export async function handleNodeRevoke(deps: RouterDeps, url: URL, requestId: string, now: number, actor: string): Promise<Response> {
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

export async function setNodeDeactivated(deps: RouterDeps, nodeId: string, deactivated: boolean, actor: string, requestId: string, now: number): Promise<Response> {
  const node = await deps.store.getNode(nodeId)
  if (!node || node.status === 'revoked') return json({ error: 'unknown_node', requestId }, 404, requestId)
  await deps.store.upsertNode({ ...node, deactivated })
  // Deactivation stops mesh-llm, so drop the node's now-dead invite token from every mesh; on
  // reactivation the node re-adds its token through heartbeats once mesh-llm relaunches.
  if (deactivated) await removeNodeMeshTokens(deps.store, deps.env, nodeId, now)
  await deps.store.appendAudit({ id: requestId, type: deactivated ? 'node_deactivated' : 'node_activated', at: now, actor, target: nodeId, detail: {} })
  return json({ ok: true, deactivated }, 200, requestId)
}

// Force Reload stamps a one-shot nonce on the node. The node applies it once (draining and
// restarting mesh-llm) and echoes it back on the next heartbeat, when the router retires it. It is
// reversible (a stale nonce is harmless) and never decommissions the node. REQ-NODE-012.
export async function requestNodeReload(deps: RouterDeps, nodeId: string, actor: string, requestId: string, now: number): Promise<Response> {
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
export async function handleNodeConfig(request: Request, deps: RouterDeps, url: URL, requestId: string, now: number, actor: string): Promise<Response> {
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

export async function handleApiNodeList(deps: RouterDeps, url: URL, requestId: string, now: number): Promise<Response> {
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

export async function handleApiNodeGet(deps: RouterDeps, url: URL, requestId: string, now: number): Promise<Response> {
  const nodeId = decodeURIComponent(url.pathname.split('/')[4] ?? '')
  const node = (await deps.store.listNodes(now)).find((candidate) => candidate.id === nodeId)
  if (!node) return json({ error: 'not_found', requestId }, 404, requestId)
  return json({ node: toApiNode(node, await desiredRuntimeVersions(deps.store)) }, 200, requestId)
}

/** Decommission a node: revoke it and its node/mesh tokens so it must re-enroll. */
// handleApiNodeReconfigure updates a node's operator-owned settings for an automation caller,
// mirroring the admin console control so MDM/fleet tooling can rename or cap weaker nodes.
export async function handleApiNodeReconfigure(request: Request, deps: RouterDeps, url: URL, requestId: string, now: number, actor: string): Promise<Response> {
  const nodeId = decodeURIComponent(url.pathname.split('/').at(-2) ?? '')
  const node = await deps.store.getNode(nodeId)
  if (!node || node.status === 'revoked') return json({ error: 'unknown_node', requestId }, 404, requestId)
  const body = await readJson<NodeConfigBody>(request)
  const result = await reconfigureNode(deps, node, body, actor, requestId, now)
  if (result instanceof Response) return result
  return json({ ok: true, node: toApiNode(result, await desiredRuntimeVersions(deps.store)) }, 200, requestId)
}

export async function handleApiNodeDecommission(deps: RouterDeps, url: URL, requestId: string, now: number, actor: string): Promise<Response> {
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
  await deps.store.appendAudit({ id: requestId, type: 'node_revoked', at: now, actor: actor, target: nodeId, detail: {} })
  return json({ ok: true, id: nodeId }, 200, requestId)
}

// The automation twin of setNodeDeactivated. Same state change, different response contract:
// this one returns the machine-facing node projection the /api/v1 surface promises.
export async function apiSetNodeDeactivated(deps: RouterDeps, nodeId: string, deactivated: boolean, requestId: string, now: number, actor: string): Promise<Response> {
  const node = await deps.store.getNode(nodeId)
  if (!node || node.status === 'revoked') return json({ error: 'unknown_node', requestId }, 404, requestId)
  const updated = { ...node, deactivated }
  await deps.store.upsertNode(updated)
  if (deactivated) await removeNodeMeshTokens(deps.store, deps.env, nodeId, now)
  await deps.store.appendAudit({ id: requestId, type: deactivated ? 'node_deactivated' : 'node_activated', at: now, actor: actor, target: nodeId, detail: {} })
  return json({ ok: true, node: toApiNode(updated, await desiredRuntimeVersions(deps.store)) }, 200, requestId)
}
