import { describe, expect, it } from 'vitest'
import { createMesh, deleteMesh, listMeshes, meshAliasFor, validateMeshName } from './meshes'
import { MemoryStore } from './test-helpers'

describe('meshes', () => {
  it('REQ-SCH-006 validates and normalizes mesh names', () => {
    expect(validateMeshName('')).toBeUndefined()
    expect(validateMeshName('Dev Ops')).toBeUndefined()
    expect(validateMeshName('noobs!')).toBeUndefined()
    expect(validateMeshName('n00bs')).toBeUndefined()
    expect(validateMeshName('x'.repeat(33))).toBeUndefined()
    expect(validateMeshName('dEvElOpMeNt')).toEqual({ id: 'development', name: 'Development' })
    expect(validateMeshName('NOOBS')).toEqual({ id: 'noobs', name: 'Noobs' })
    expect(validateMeshName('x'.repeat(32))).toBeDefined()
  })

  it('REQ-SCH-006 lists the implicit Default mesh first and persists created meshes', async () => {
    const store = new MemoryStore()
    expect(await listMeshes(store)).toEqual([{ id: 'default', name: 'Default' }])

    const created = await createMesh(store, 'Development', 1000)
    expect(created).toMatchObject({ id: 'development', name: 'Development' })
    const listed = await listMeshes(store)
    expect(listed.map((mesh) => mesh.id)).toEqual(['default', 'development'])
    expect(listed[1]).toMatchObject({ id: 'development', name: 'Development', createdAt: 1000 })

    expect(await createMesh(store, 'development', 2000)).toBeUndefined()
    expect(await createMesh(store, 'Default', 2000)).toBeUndefined()

    expect(await deleteMesh(store, 'development')).toBe(true)
    expect(await listMeshes(store)).toEqual([{ id: 'default', name: 'Default' }])
    expect(await deleteMesh(store, 'development')).toBe(false)
    expect(await deleteMesh(store, 'default')).toBe(false)
  })

  it('REQ-RUN-016 meshAliasFor pins default and derives per-mesh aliases', () => {
    expect(meshAliasFor('default')).toBe('codeflare-mesh')
    expect(meshAliasFor('development')).toBe('codeflare-mesh-development')
    expect(meshAliasFor(undefined)).toBe('codeflare-mesh')
  })
})
