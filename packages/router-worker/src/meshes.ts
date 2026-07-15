import { STABLE_PUBLIC_MODEL } from './profiles'
import type { Store } from './types'

export const MESHES_CONFIG_KEY = 'meshes'
export const DEFAULT_MESH_ID = 'default'

/**
 * A mesh is an operator-named machine group: every node and every model profile
 * belongs to exactly one. Distinct from the mesh-llm runtime mesh (per-profile
 * network) and from Cloudflare Mesh/WARP transport. REQ-SCH-006.
 */
export interface MeshRecord {
  readonly id: string
  readonly name: string
  readonly createdAt?: number
}

interface StoredMesh {
  readonly name: string
  readonly createdAt: number
}

// Mesh names are letters-only so the derived id doubles as a callable-alias and
// gateway-route fragment with no escaping anywhere. Display form is normalized
// to First-upper-rest-lower regardless of input casing.
export function validateMeshName(raw: string): { id: string; name: string } | undefined {
  if (!/^[A-Za-z]{1,32}$/.test(raw)) return undefined
  const id = raw.toLowerCase()
  return { id, name: id.charAt(0).toUpperCase() + id.slice(1) }
}

// The default mesh is computed, never stored: it always exists, cannot drift,
// and cannot be deleted. Its active model answers the stable public alias.
export function meshAliasFor(meshId: string | undefined): string {
  return meshId === undefined || meshId === DEFAULT_MESH_ID ? STABLE_PUBLIC_MODEL : `${STABLE_PUBLIC_MODEL}-${meshId}`
}

export async function listMeshes(store: Store): Promise<readonly MeshRecord[]> {
  const stored = (await store.getConfig<readonly StoredMesh[]>(MESHES_CONFIG_KEY)) ?? []
  return [{ id: DEFAULT_MESH_ID, name: 'Default' }, ...stored.map((mesh) => ({ ...mesh, id: mesh.name.toLowerCase() }))]
}

export async function createMesh(store: Store, rawName: string, now: number): Promise<MeshRecord | undefined> {
  const validated = validateMeshName(rawName)
  if (!validated) return undefined
  const existing = await listMeshes(store)
  if (existing.some((mesh) => mesh.id === validated.id)) return undefined
  const stored = (await store.getConfig<readonly StoredMesh[]>(MESHES_CONFIG_KEY)) ?? []
  await store.putConfig(MESHES_CONFIG_KEY, [...stored, { name: validated.name, createdAt: now }])
  return { ...validated, createdAt: now }
}

export async function deleteMesh(store: Store, meshId: string): Promise<boolean> {
  if (meshId === DEFAULT_MESH_ID) return false
  const stored = (await store.getConfig<readonly StoredMesh[]>(MESHES_CONFIG_KEY)) ?? []
  const kept = stored.filter((mesh) => mesh.name.toLowerCase() !== meshId)
  if (kept.length === stored.length) return false
  await store.putConfig(MESHES_CONFIG_KEY, kept)
  return true
}

export const MESHES_ANCHORS = {
  REQ_SCH_006: 'REQ-SCH-006',
  REQ_RUN_016: 'REQ-RUN-016'
} as const
