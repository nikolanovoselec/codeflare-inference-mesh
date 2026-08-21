/** Machine groups: list, create, delete, and rotate the shared key. */
import { createMesh, deleteMesh, listMeshes, meshAliasFor, validateMeshName, type MeshRecord } from '../meshes'
import { handleMeshRotate } from '../mesh-state'
import { json, readJson } from '../http'
import type { ModelProfile, NodeRecord } from '../types'
import { nodeMeshId, profileMeshId } from '../profiles'
import type { RouterDeps } from '../deps'

// Mesh management cores shared by the admin console and the automation API
// (REQ-ADM-037 / REQ-API-011). A mesh is an operator-named machine group; its
// active model answers meshAliasFor(id). Deletion requires an empty mesh and
// leaves any gateway dynamic route in place (it resolves to no-profile), so
// delete never depends on Cloudflare API availability.
export async function meshListCore(deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  const [meshes, nodes, profiles] = await Promise.all([listMeshes(deps.store), deps.store.listNodes(now), deps.store.listProfiles()])
  return json({
    meshes: meshes.map((mesh) => ({
      ...meshSummary(mesh, nodes, profiles),
      ...(mesh.createdAt !== undefined ? { createdAt: mesh.createdAt } : {})
    }))
  }, 200, requestId)
}

export function meshSummary(mesh: MeshRecord, nodes: readonly NodeRecord[], profiles: readonly ModelProfile[]): { id: string; name: string; alias: string; machineCount: number; modelCount: number } {
  return {
    id: mesh.id,
    name: mesh.name,
    alias: meshAliasFor(mesh.id),
    machineCount: nodes.filter((node) => nodeMeshId(node) === mesh.id).length,
    modelCount: profiles.filter((profile) => profileMeshId(profile) === mesh.id).length
  }
}

export async function meshCreateCore(request: Request, deps: RouterDeps, actor: string, requestId: string, now: number): Promise<Response> {
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

export async function meshDeleteCore(deps: RouterDeps, meshId: string, actor: string, requestId: string, now: number): Promise<Response> {
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

/** Rotate the mesh pre-shared key. Same operation from the console and the API. */
export async function meshRotateCore(request: Request, deps: RouterDeps, now: number, actor: string): Promise<Response> {
  return await handleMeshRotate(request, deps.store, deps.env, now, actor)
}
