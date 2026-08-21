/**
 * mesh console contracts.
 *
 * One slice of the console dashboard suite; shared fixtures live in
 * `./admin-ui-test-support`.
 */
import { ADMIN_UI_DRAWER, ADMIN_UI_MESHES, ADMIN_UI_NODES_TABLE, ADMIN_UI_PLAYGROUND, ADMIN_UI_TOPOLOGY } from './admin-ui'
import { adminUiCss } from './admin-ui-css'
import { dashboardHarness, statusFixture, tableRows } from './admin-ui-test-support'
import { descendants, type StubElement } from './admin-ui-harness'
import { describe, expect, it } from 'vitest'

describe('mesh console contracts', () => {
  const consoleMeshes = [
    { id: 'default', name: 'Default', alias: 'codeflare-mesh', machineCount: 1, modelCount: 1 },
    { id: 'development', name: 'Development', alias: 'codeflare-mesh-development', machineCount: 0, modelCount: 0 },
    { id: 'ops', name: 'Ops', alias: 'codeflare-mesh-ops', machineCount: 2, modelCount: 1 }
  ]

  it('REQ-ADM-037 nodes table renders a mesh column resolved to group names', async () => {
    expect(ADMIN_UI_NODES_TABLE.columns).toContain('mesh')
    const nodes = [
      { id: 'node-big', status: 'online', meshId: 'development', metrics: { runtimeState: 'ready', activeRequests: 0 } },
      { id: 'node-small', status: 'online', metrics: { runtimeState: 'ready', activeRequests: 0 } }
    ]
    const harness = await dashboardHarness({ status: statusFixture({ nodes, meshes: consoleMeshes }) })
    const meshCell = (nodeId: string) => tableRows(harness).find((row) => row.dataset.nodeRow === nodeId)!.children.find((td) => td.getAttribute('data-cell') === 'mesh')!
    expect(meshCell('node-big').getAttribute('data-value')).toBe('development')
    expect(meshCell('node-big').textContent).toBe('Development')
    // Legacy rows without a stored meshId render as members of the default group.
    expect(meshCell('node-small').getAttribute('data-value')).toBe('default')
    expect(meshCell('node-small').textContent).toBe('Default')
  })

  it('REQ-ADM-037 meshes card lists groups, gates Delete to empty non-default meshes, and posts create/delete', async () => {
    const harness = await dashboardHarness({ status: statusFixture({ meshes: consoleMeshes }), respond: (path, init) => {
      const method = (init && init.method) || 'GET'
      if (path === '/admin/meshes' && method === 'POST') return Response.json({ ok: true, mesh: { id: 'noobs', name: 'Noobs' } }, { status: 201 })
      if (path === '/admin/meshes/development' && method === 'DELETE') return Response.json({ ok: true })
      return undefined
    } })
    const rows = harness.byId(ADMIN_UI_MESHES.listId).children.filter((row) => row.dataset.meshRow)
    expect(rows.map((row) => row.dataset.meshRow)).toEqual(['default', 'development', 'ops'])
    const aliasOf = (row: StubElement) => descendants(row).find((el) => el.getAttribute('data-mesh-alias') !== null)?.getAttribute('data-mesh-alias')
    expect(aliasOf(rows[1]!)).toBe('codeflare-mesh-development')
    // Counts are structured per row (machines and models separately), not one prose blob.
    const countsOf = (row: StubElement) => descendants(row).find((el) => el.getAttribute('data-mesh-machines') !== null)
    expect(countsOf(rows[2]!)?.getAttribute('data-mesh-machines')).toBe('2')
    expect(countsOf(rows[2]!)?.getAttribute('data-mesh-models')).toBe('1')
    // Served hints render entities exactly once — a double-escaped &amp;lt; would show raw markup.
    expect(harness.html).not.toContain('&amp;lt;')
    const deleteOf = (row: StubElement) => descendants(row).find((el) => el.dataset.action === 'mesh-delete')
    expect(deleteOf(rows[0]!), 'the default mesh never offers Delete').toBeUndefined()
    expect(deleteOf(rows[2]!), 'an occupied mesh offers no Delete').toBeUndefined()
    const del = deleteOf(rows[1]!)
    expect(del).toBeDefined()
    expect(del!.dataset.meshId).toBe('development')
    expect(del!.dataset.confirm, 'mesh delete arms before submitting').toBeTruthy()

    harness.byId(ADMIN_UI_MESHES.nameInputId).value = ' Noobs '
    ;(harness.byId('mesh-add-details') as StubElement & { open?: boolean }).open = true
    await harness.clickAction('mesh-create', { out: ADMIN_UI_MESHES.outputId })
    await harness.flush(5)
    const createCall = harness.fetchCalls.find((call) => call.path === '/admin/meshes' && call.init?.method === 'POST')
    expect(JSON.parse(String(createCall?.init?.body))).toEqual({ name: 'Noobs' })
    expect(harness.byId(ADMIN_UI_MESHES.nameInputId).value, 'a successful create clears the input').toBe('')
    expect((harness.byId('mesh-add-details') as StubElement & { open?: boolean }).open, 'a successful create collapses the disclosure').toBe(false)

    await harness.clickAction('mesh-delete', { meshId: 'development', out: ADMIN_UI_MESHES.outputId })
    await harness.flush(5)
    expect(harness.fetchCalls.some((call) => call.path === '/admin/meshes/development' && call.init?.method === 'DELETE')).toBe(true)
  })

  it('REQ-ADM-023 node drawer saves the mesh selection only when changed', async () => {
    const nodes = [{ id: 'node-weak', displayName: 'Weak', status: 'online', metrics: { runtimeState: 'ready', activeRequests: 0 } }]
    const harness = await dashboardHarness({ status: statusFixture({ nodes, meshes: consoleMeshes }) })
    await harness.clickAction('node-detail', { nodeId: 'node-weak' })
    const select = harness.byId('node-edit-mesh')
    expect(select.children.map((option) => option.value)).toEqual(['default', 'development', 'ops'])
    expect(select.value).toBe('default')
    expect(select.dataset.original).toBe('default')

    await harness.clickAction('node-config-save', { nodeId: 'node-weak', out: 'node-output' })
    const unchanged = harness.fetchCalls.find((call) => call.path === '/admin/nodes/node-weak/config')
    expect(JSON.parse(String(unchanged?.init?.body))).not.toHaveProperty('meshId')

    select.value = 'development'
    await harness.clickAction('node-config-save', { nodeId: 'node-weak', out: 'node-output' })
    const calls = harness.fetchCalls.filter((call) => call.path === '/admin/nodes/node-weak/config')
    expect(JSON.parse(String(calls[calls.length - 1]?.init?.body)).meshId).toBe('development')
  })

  it('REQ-ADM-038 model drawer saves the mesh selection only when changed', async () => {
    const profiles = [{ id: 'custom-tune', displayName: 'Tune', publicAliases: ['codeflare-mesh-development', 'tune'], meshId: 'development', active: false, rolloutPercent: 0, contextWindow: 32768, meshllm: { split: false, modelRef: 'unsloth/x' } }]
    const harness = await dashboardHarness({ status: statusFixture({ profiles, meshes: consoleMeshes }) })
    await harness.clickAction('model-detail', { profileId: 'custom-tune' })
    const select = harness.byId('model-edit-mesh')
    expect(select.value).toBe('development')
    expect(select.dataset.original).toBe('development')
    // The alias field carries the model's OWN alias, never its mesh's stable route name.
    expect(harness.byId('model-edit-callname').value).toBe('tune')

    await harness.clickAction('model-save', { profileId: 'custom-tune', runtime: 'meshllm', out: 'model-edit-output' })
    const unchanged = harness.fetchCalls.find((call) => call.path === '/admin/profiles/config')
    expect(JSON.parse(String(unchanged?.init?.body))).not.toHaveProperty('meshId')

    select.value = 'ops'
    await harness.clickAction('model-save', { profileId: 'custom-tune', runtime: 'meshllm', out: 'model-edit-output' })
    const calls = harness.fetchCalls.filter((call) => call.path === '/admin/profiles/config')
    expect(JSON.parse(String(calls[calls.length - 1]?.init?.body)).meshId).toBe('ops')
  })

  it('REQ-RUN-017 model drawer duplicates a model through the duplicate endpoint', async () => {
    const profiles = [{ id: 'custom-live', displayName: 'Live', publicAliases: ['codeflare-mesh', 'live'], active: true, rolloutPercent: 100, contextWindow: 32768, meshllm: { split: false, modelRef: 'unsloth/x' } }]
    const harness = await dashboardHarness({ status: statusFixture({ profiles }), respond: (path, init) => {
      if (path === '/admin/profiles/duplicate' && (init?.method || 'GET') === 'POST') return Response.json({ ok: true, profileId: 'custom-live-copy' }, { status: 201 })
      return undefined
    } })
    await harness.clickAction('model-detail', { profileId: 'custom-live' })
    // Duplicate applies to any model — including the active one Delete hides for.
    const dup = descendants(harness.byId(ADMIN_UI_DRAWER.bodyId)).find((el) => el.dataset.action === 'model-duplicate')
    expect(dup).toBeDefined()
    expect(dup!.dataset.profileId).toBe('custom-live')
    await harness.clickAction('model-duplicate', { profileId: 'custom-live', out: 'model-edit-output' })
    await harness.flush(5)
    const call = harness.fetchCalls.find((entry) => entry.path === '/admin/profiles/duplicate')
    expect(call?.init?.method).toBe('POST')
    expect(JSON.parse(String(call?.init?.body))).toEqual({ profileId: 'custom-live' })
    expect(harness.byId(ADMIN_UI_DRAWER.containerId).hidden, 'drawer closes so the refreshed list shows the copy').toBe(true)
  })

  it('REQ-ADM-025 REQ-ADM-037 the add-model form and add-mesh input sit behind native disclosure buttons', async () => {
    const harness = await dashboardHarness()
    const html = harness.html
    // Both affordances are <details>/<summary> — present in markup, revealed by a click,
    // never gated on a script state. The mesh disclosure sits in the Meshes header row.
    for (const id of ['model-add-details', 'mesh-add-details']) {
      const at = html.indexOf(`<details class="disclosure" id="${id}">`)
      expect(at, `${id} must be a native disclosure`).toBeGreaterThan(-1)
      expect(html.indexOf('<summary', at)).toBeGreaterThan(at)
    }
    // Each disclosure sits at the right end of its card header: the first card head is
    // Models (carrying + Model), the second is Meshes (carrying + Mesh).
    const modelsHeadAt = html.indexOf('class="card-head"')
    expect(modelsHeadAt).toBeGreaterThan(-1)
    const meshHeadAt = html.indexOf('class="card-head"', modelsHeadAt + 1)
    expect(meshHeadAt).toBeGreaterThan(modelsHeadAt)
    const modelDetailsAt = html.indexOf('id="model-add-details"')
    expect(modelDetailsAt).toBeGreaterThan(modelsHeadAt)
    expect(modelDetailsAt).toBeLessThan(meshHeadAt)
    expect(html.indexOf('id="mesh-add-details"', meshHeadAt)).toBeGreaterThan(meshHeadAt)
    // The add-model form fields live inside the disclosure body.
    expect(html.indexOf('id="model-add-ref"', modelDetailsAt)).toBeGreaterThan(modelDetailsAt)
    // Mesh rows right-align the route chip.
    const css = adminUiCss()
    expect(css).toContain('.mesh-row-head .endpoint-chip{margin-left:auto}')
  })

  it('REQ-ADM-036 one token pair sizes every console button with only the email-chip and mobile exceptions', () => {
    const css = adminUiCss()
    // One reusable button size: the base .btn rule carries the size tokens, and no other
    // rule resizes buttons — except the email-chip inline micro control and the mobile
    // touch-target floor.
    expect(css).toMatch(/\.btn\{[^}]*min-height:var\(--btn-h\)[^}]*padding:var\(--btn-pad\)[^}]*\}/)
    const btnSizingSelectors = css
      .split('\n')
      .filter((line) => {
        const brace = line.indexOf('{')
        return brace > 0 && line.slice(0, brace).includes('.btn') && line.slice(brace).includes('min-height')
      })
      .map((line) => line.slice(0, line.indexOf('{')))
    expect(btnSizingSelectors).toEqual(['.btn', '.email-chip .btn', '.btn,input,select'])
  })

  it('REQ-ADM-039 the overview carries no activity feed while settings does', async () => {
    const harness = await dashboardHarness()
    const html = harness.html
    const overviewAt = html.indexOf('<section class="panel section-panel" id="overview"')
    const settingsAt = html.indexOf('<section class="panel section-panel" id="settings"')
    expect(overviewAt).toBeGreaterThan(-1)
    expect(settingsAt).toBeGreaterThan(overviewAt)
    // The audit feed mounts exactly once, inside Settings — never on the Overview.
    const auditAt = html.indexOf('id="audit-log"')
    expect(auditAt).toBeGreaterThan(settingsAt)
    expect(html.indexOf('id="audit-log"', auditAt + 1)).toBe(-1)
  })

  it('REQ-ADM-025 renders the model sources panel with CSS-keyed contextual switching', async () => {
    const harness = await dashboardHarness()
    const html = harness.html
    const panelAt = html.indexOf('id="model-add-sources"')
    expect(panelAt).toBeGreaterThan(-1)
    expect(html).toContain('data-model-sources="single"')
    // A copyable reference-format example is structural: a code element inside the panel.
    expect(html.slice(panelAt)).toMatch(/<code>[^<]+<\/code>/)
    expect(html).toContain('data-command-row="model-source-gguf"')
    expect(html).toContain('data-command-row="model-source-layers"')
    expect(html).toContain('data-command-row="model-source-split-guide"')
    // Context switching is CSS keyed off the dataset — content is never gated on a JS reveal.
    const css = adminUiCss()
    expect(css).toContain('.model-sources[data-model-sources="single"] .command-row[data-command-row="model-source-layers"]')
    expect(css).toContain('.model-sources[data-model-sources="split"] .command-row[data-command-row="model-source-gguf"]')

    const mode = harness.byId('model-add-mode')
    const sources = harness.byId('model-add-sources')
    mode.dataset.modelAddMode = 'true'
    mode.value = 'split'
    await harness.change(mode)
    expect(sources.dataset.modelSources).toBe('split')
    mode.value = 'single'
    await harness.change(mode)
    expect(sources.dataset.modelSources).toBe('single')
  })

  it('REQ-ADM-038 the models list shows each profile mesh without opening the drawer', async () => {
    const profiles = [
      { id: 'model-default', displayName: 'Default Model', publicAliases: ['codeflare-mesh', 'main'], active: true, rolloutPercent: 100, meshllm: { split: false } },
      { id: 'model-dev', displayName: 'Dev Model', publicAliases: ['codeflare-mesh-development', 'dev-coder'], meshId: 'development', active: false, rolloutPercent: 0, meshllm: { split: false } }
    ]
    const harness = await dashboardHarness({ status: statusFixture({ profiles, meshes: consoleMeshes }) })
    const rowBadge = (id: string) => {
      const row = harness.byId('profile-list').children.find((candidate) => candidate.dataset.profileRow === id)
      return descendants(row!).find((el) => el.getAttribute('data-profile-mesh') !== null)
    }
    expect(rowBadge('model-dev')?.getAttribute('data-profile-mesh')).toBe('development')
    expect(rowBadge('model-dev')?.textContent).toBe('Development')
    // A legacy row without a stored mesh reads as a Default member.
    expect(rowBadge('model-default')?.getAttribute('data-profile-mesh')).toBe('default')
  })

  it('REQ-ADM-018 REQ-ADM-038 model rows and the drawer lead with the runtime, serving-mode, and mesh pills', async () => {
    const profiles = [
      { id: 'direct-a', displayName: 'Direct A', publicAliases: ['codeflare-mesh', 'direct-a'], active: true, rolloutPercent: 100, runtime: 'llamacpp', llamacpp: { modelRef: 'unsloth/Qwen3-14B-GGUF:Q4_K_M', bindPort: 4500 } },
      { id: 'shard-b', displayName: 'Shard B', publicAliases: ['codeflare-mesh-development', 'shard-b'], meshId: 'development', active: false, rolloutPercent: 0, runtime: 'meshllm', meshllm: { split: true } }
    ]
    const harness = await dashboardHarness({ status: statusFixture({ profiles, meshes: consoleMeshes }) })
    const pill = (id: string, attr: string) => {
      const row = harness.byId('profile-list').children.find((candidate) => candidate.dataset.profileRow === id)
      return descendants(row!).find((el) => el.getAttribute(attr) !== null)!
    }
    // Provider pill: llama.cpp = red, meshllm = green.
    expect(pill('direct-a', 'data-runtime').getAttribute('data-runtime')).toBe('llamacpp')
    expect(pill('direct-a', 'data-runtime').dataset.tone).toBe('red')
    expect(pill('shard-b', 'data-runtime').getAttribute('data-runtime')).toBe('meshllm')
    expect(pill('shard-b', 'data-runtime').dataset.tone).toBe('green')
    // Serving-mode pill combines with the provider pill: a sharded meshllm model reads green + orange.
    expect(pill('shard-b', 'data-serving-mode').dataset.tone).toBe('orange')
    expect(pill('direct-a', 'data-serving-mode').dataset.tone).toBe('blue')
    // Mesh pill is always purple.
    expect(pill('shard-b', 'data-profile-mesh').dataset.tone).toBe('purple')
    expect(pill('direct-a', 'data-profile-mesh').getAttribute('data-profile-mesh')).toBe('default')

    // The Manage overlay leads with the same pill row, so provider, mode, and mesh are visible there too.
    await harness.clickAction('model-detail', { profileId: 'shard-b' })
    const drawerPills = descendants(harness.byId(ADMIN_UI_DRAWER.bodyId)).find((node) => node.getAttribute('data-drawer-pills') === 'shard-b')!
    const drawerPill = (attr: string) => descendants(drawerPills).find((el) => el.getAttribute(attr) !== null)!
    expect(drawerPill('data-runtime').getAttribute('data-runtime')).toBe('meshllm')
    expect(drawerPill('data-serving-mode').getAttribute('data-serving-mode')).toBe('split')
    expect(drawerPill('data-profile-mesh').getAttribute('data-profile-mesh')).toBe('development')
  })

  it('REQ-ADM-015 overview topology filters machines to the selected mesh and survives the poll', async () => {
    const nodes = [
      { id: 'node-default', status: 'online', metrics: { runtimeState: 'ready', activeRequests: 0 } },
      { id: 'node-dev', status: 'online', meshId: 'development', metrics: { runtimeState: 'ready', activeRequests: 0 } }
    ]
    const harness = await dashboardHarness({ status: statusFixture({ nodes, meshes: consoleMeshes }) })
    const select = harness.byId(ADMIN_UI_TOPOLOGY.meshSelectId)
    expect(select.children.map((option) => option.value)).toEqual(['all', 'default', 'development', 'ops'])
    const topoIds = () => harness.byId(ADMIN_UI_TOPOLOGY.listId).children.map((el) => el.dataset.nodeId)
    expect(topoIds()).toEqual(['node-default', 'node-dev'])

    select.dataset.topoMeshSelect = 'true'
    select.value = 'development'
    await harness.change(select)
    expect(topoIds()).toEqual(['node-dev'])
    expect(harness.byId(ADMIN_UI_TOPOLOGY.captionId).dataset.nodes).toBe('1')

    // The selection survives the periodic status rebuild instead of snapping back to all.
    harness.runTimers()
    await harness.flush(10)
    expect(select.value).toBe('development')
    expect(topoIds()).toEqual(['node-dev'])
  })

  it("REQ-ADM-031 direct playground lists every mesh's active model by its own alias", async () => {
    const profiles = [
      { id: 'model-default', displayName: 'Default Model', publicAliases: ['codeflare-mesh', 'main'], active: true, rolloutPercent: 100, meshllm: { split: false } },
      { id: 'model-dev', displayName: 'Dev Model', publicAliases: ['codeflare-mesh-development', 'dev-coder'], meshId: 'development', active: true, rolloutPercent: 100, meshllm: { split: false } },
      { id: 'model-off', displayName: 'Off Model', publicAliases: ['codeflare-mesh-ops', 'off-model'], meshId: 'ops', active: false, rolloutPercent: 0, meshllm: { split: false } }
    ]
    const harness = await dashboardHarness({ status: statusFixture({ profiles, meshes: consoleMeshes }) })
    const select = harness.byId(ADMIN_UI_PLAYGROUND.selectId)
    expect(select.children.map((option) => option.value)).toEqual(['main', 'dev-coder'])
  })

  it('REQ-ADM-025 resetting the sharing key names the model whose drawer asked for it', async () => {
    // Two models, so a handler that hardcoded one profile id, or read it from whichever
    // drawer happened to be open, cannot pass.
    const harness = await dashboardHarness()
    await harness.clickAction('mesh-rotate', { profileId: 'mesh-default-qwen36-35b', out: 'mesh-rotate-output' })
    await harness.clickAction('mesh-rotate', { profileId: 'mesh-split-qwen36-35b', out: 'mesh-rotate-output' })
    const rotations = harness.fetchCalls.filter((entry) => entry.path === '/admin/mesh/rotate')
    expect(rotations.map((entry) => entry.init?.method)).toEqual(['POST', 'POST'])
    expect(rotations.map((entry) => JSON.parse(String(entry.init?.body)).profileId))
      .toEqual(['mesh-default-qwen36-35b', 'mesh-split-qwen36-35b'])
  })

})
