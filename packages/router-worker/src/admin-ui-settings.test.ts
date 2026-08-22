/**
 * settings, API keys and version control contracts.
 *
 * One slice of the console dashboard suite; shared fixtures live in
 * `./admin-ui-test-support`.
 */
import { ADMIN_UI_AGENT_VERSION, ADMIN_UI_RUNTIME_VERSION, adminUiHtml } from './admin-ui'
import { dashboardHarness, resetDashboardEnvironment, statusFixture } from './admin-ui-test-support'
import { descendants } from './admin-ui-harness'
import { afterEach, describe, expect, it } from 'vitest'

describe('settings, API keys and version control contracts', () => {
  afterEach(resetDashboardEnvironment)

  it('REQ-ADM-006 the custom domain card lives in Settings', () => {
    // The harness never trees static HTML, so placement pins on served source order:
    // the card renders exactly once, after the Settings section opens (Settings is the
    // final section, so a greater index means containment) and past the Routing section.
    const html = adminUiHtml('https://router.test', { view: 'dashboard', phase: 'complete', customDomain: 'router.test', recovery: false })
    const settingsAt = html.indexOf('id="settings"')
    const routingAt = html.indexOf('id="routing"')
    const domainAt = html.indexOf('id="custom-domain-current"')
    expect(html.match(/id="custom-domain-current"/g)!.length).toBe(1)
    expect(routingAt).toBeLessThan(settingsAt)
    expect(domainAt).toBeGreaterThan(settingsAt)
  })

  it('REQ-ADM-020 saves the offline-machine prune window from Settings', async () => {
    const harness = await dashboardHarness()
    const input = harness.byId('prune-seconds')
    input.value = '3600'
    await harness.clickAction('settings-save', { out: 'settings-output' })
    const call = harness.fetchCalls.find((entry) => entry.path === '/admin/settings')
    expect(call).toBeDefined()
    expect(call!.init?.method).toBe('POST')
    expect(JSON.parse(String(call!.init?.body))).toEqual({ offlinePruneSeconds: 3600 })
  })

  it('REQ-ADM-004 copies the install command when the command block is clicked', async () => {
    const harness = await dashboardHarness()
    const block = harness.byId('installer-output')
    block.dataset.output = 'installer-command'
    block.textContent = 'curl -fsSL https://mesh.example.com/install.sh | sh'
    await harness.click(block)
    expect(harness.copied).toContain('curl -fsSL https://mesh.example.com/install.sh | sh')
  })

  it('REQ-ADM-022 manages API keys from Settings: list renders, create reveals the secret once, rotate and revoke call the API', async () => {
    const harness = await dashboardHarness({ respond: (path, init) => {
      const method = (init && init.method) || 'GET'
      if (path === '/api/v1/keys' && method === 'GET') return Response.json({ keys: [{ id: 'automation_a', createdAt: 1_700_000_000_000 }] })
      if (path === '/api/v1/keys' && method === 'POST') return Response.json({ id: 'automation_new', token: 'automation_secret_xyz', createdAt: 1_700_000_100_000 }, { status: 201 })
      if (path === '/api/v1/keys/automation_a/rotate' && method === 'POST') return Response.json({ id: 'automation_rot', token: 'automation_secret_rot', rotatedFrom: 'automation_a', createdAt: 1_700_000_200_000 }, { status: 201 })
      if (path === '/api/v1/keys/automation_a' && method === 'DELETE') return Response.json({ ok: true, id: 'automation_a' })
      return undefined
    } })
    // Active keys render from GET /api/v1/keys.
    expect(harness.byId('api-key-list').children.find((row) => row.dataset.apiKeyRow === 'automation_a')).toBeDefined()
    // Creating a key reveals the secret exactly once in the output.
    await harness.clickAction('api-key-create', { out: 'api-key-output' })
    await harness.flush(3)
    expect(harness.byId('api-key-output').textContent).toBe('automation_secret_xyz')
    // Rotate posts to the key's rotate endpoint; revoke deletes the key.
    await harness.clickAction('api-key-rotate', { keyId: 'automation_a', out: 'api-key-output' })
    await harness.flush(3)
    expect(harness.fetchCalls.find((entry) => entry.path === '/api/v1/keys/automation_a/rotate')?.init?.method).toBe('POST')
    await harness.clickAction('api-key-revoke', { keyId: 'automation_a', out: 'api-key-output' })
    await harness.flush(3)
    expect(harness.fetchCalls.find((entry) => entry.path === '/api/v1/keys/automation_a' && entry.init?.method === 'DELETE')).toBeDefined()
  })

  it('REQ-ADM-033 renders and saves MeshLLM and llama.cpp runtime version controls from Settings', async () => {
    const harness = await dashboardHarness({ respond: (path, init) => {
      const method = (init && init.method) || 'GET'
      if (path === '/admin/runtime-versions' && method === 'GET') return Response.json({
        meshllm: { tags: ['v0.73.0', 'v0.72.2'], desired: 'v0.73.0', stale: false },
        llamacpp: { tags: ['b9912', 'b9900'], desired: 'b9900', stale: false }
      })
      if (path === '/admin/runtime-versions' && method === 'POST') return Response.json({ ok: true, desired: { meshllm: 'v0.72.2', llamacpp: 'b9912' } })
      return undefined
    } })

    expect(harness.byId(ADMIN_UI_RUNTIME_VERSION.meshllmSelectId).value).toBe('v0.73.0')
    expect(harness.byId(ADMIN_UI_RUNTIME_VERSION.llamacppSelectId).value).toBe('b9900')
    harness.byId(ADMIN_UI_RUNTIME_VERSION.meshllmSelectId).value = 'v0.72.2'
    harness.byId(ADMIN_UI_RUNTIME_VERSION.llamacppSelectId).value = 'b9912'
    await harness.clickAction('runtime-versions-set', { out: 'runtime-version-output' })
    await harness.flush(3)

    const call = harness.fetchCalls.find((entry) => entry.path === '/admin/runtime-versions' && entry.init?.method === 'POST')
    expect(call, 'saving runtime versions posts to the admin parity endpoint').toBeDefined()
    expect(JSON.parse(String(call?.init?.body))).toEqual({ meshllm: 'v0.72.2', llamacpp: 'b9912' })
  })

  it('REQ-RUN-025 renders and saves the vllm runtime version control from Settings', async () => {
    const harness = await dashboardHarness({ respond: (path, init) => {
      const method = (init && init.method) || 'GET'
      if (path === '/admin/runtime-versions' && method === 'GET') return Response.json({
        meshllm: { tags: ['v0.73.0'], desired: 'v0.73.0', stale: false },
        llamacpp: { tags: ['b9912'], desired: 'b9912', stale: false },
        vllm: { tags: ['v0.27.1', 'v0.27.0'], desired: 'v0.27.1', stale: false }
      })
      if (path === '/admin/runtime-versions' && method === 'POST') return Response.json({ ok: true, desired: { meshllm: 'v0.73.0', llamacpp: 'b9912', vllm: 'v0.27.0' } })
      return undefined
    } })

    expect(harness.byId(ADMIN_UI_RUNTIME_VERSION.vllmSelectId).value).toBe('v0.27.1')
    harness.byId(ADMIN_UI_RUNTIME_VERSION.vllmSelectId).value = 'v0.27.0'
    await harness.clickAction('runtime-versions-set', { out: 'runtime-version-output' })
    await harness.flush(3)

    const call = harness.fetchCalls.find((entry) => entry.path === '/admin/runtime-versions' && entry.init?.method === 'POST')
    expect(call, 'saving runtime versions posts the vllm selection too').toBeDefined()
    expect(JSON.parse(String(call?.init?.body))).toMatchObject({ vllm: 'v0.27.0' })
  })

  it('REQ-NODE-014 renders the MeshLLM binary source selector and switches source on change', async () => {
    const harness = await dashboardHarness({ respond: (path, init) => {
      const method = (init && init.method) || 'GET'
      if (path === '/admin/runtime-versions' && method === 'GET') return Response.json({
        meshllm: { tags: ['v0.73.1-codeflare.1'], desired: 'v0.73.1-codeflare.1', stale: false, source: 'fork', forkRepository: 'nikolanovoselec/mesh-llm', officialRepository: 'Mesh-LLM/mesh-llm' },
        llamacpp: { tags: ['b9912'], desired: 'b9912', stale: false }
      })
      if (path === '/admin/runtime-versions' && method === 'POST') return Response.json({ ok: true, source: 'official' })
      return undefined
    } })

    const select = harness.byId(ADMIN_UI_RUNTIME_VERSION.meshllmSourceSelectId)
    expect(select.dataset.sourceAvailable).toBe('true')
    expect(descendants(select).filter((el) => el.dataset.runtimeSourceOption).map((el) => el.dataset.runtimeSourceOption)).toEqual(['official', 'fork'])
    expect(select.value).toBe('fork')

    // Changing the source posts only the source and reloads the version list.
    select.value = 'official'
    await harness.change(select)
    await harness.flush(3)
    const call = harness.fetchCalls.find((entry) => entry.path === '/admin/runtime-versions' && entry.init?.method === 'POST')
    expect(call, 'switching source posts to the runtime-versions endpoint').toBeDefined()
    expect(JSON.parse(String(call?.init?.body))).toEqual({ meshllmSource: 'official' })
  })

  it('REQ-NODE-014 hides the binary source selector when no fork is configured', async () => {
    const harness = await dashboardHarness({ respond: (path, init) => {
      const method = (init && init.method) || 'GET'
      if (path === '/admin/runtime-versions' && method === 'GET') return Response.json({
        meshllm: { tags: ['v0.72.2'], desired: 'v0.72.2', stale: false, source: 'official', officialRepository: 'Mesh-LLM/mesh-llm' },
        llamacpp: { tags: ['b9912'], desired: 'b9912', stale: false }
      })
      return undefined
    } })

    const select = harness.byId(ADMIN_UI_RUNTIME_VERSION.meshllmSourceSelectId)
    expect(select.dataset.sourceAvailable).toBe('false')
    expect(select.hidden).toBe(true)
    expect(descendants(select).filter((el) => el.dataset.runtimeSourceOption)).toHaveLength(0)
  })

  it('REQ-ADM-023 loads and saves node name and VRAM settings from the node drawer', async () => {
    const nodes = [{ id: 'node-weak', displayName: 'Old weak node', status: 'online', agentVersion: 'v1.3.0', maxVramGbOverride: 4, metrics: { runtimeState: 'ready', readyModels: ['codeflare-mesh'], gpuMemoryTotalMiB: 8192, gpuMemoryUsedMiB: 4000, tokensPerSecond: 20, activeRequests: 0 } }]
    const harness = await dashboardHarness({ status: statusFixture({ nodes }) })
    await harness.clickAction('node-detail', { nodeId: 'node-weak' })
    // The drawer loads the persisted operator name and current override.
    expect(harness.byId('node-edit-name').value).toBe('Old weak node')
    expect(harness.byId('node-edit-vram').value).toBe('4')
    // Saving posts both operator-owned settings to the node config endpoint.
    harness.byId('node-edit-name').value = 'Mac mini'
    harness.byId('node-edit-vram').value = '2'
    await harness.clickAction('node-config-save', { nodeId: 'node-weak', out: 'node-output' })
    const call = harness.fetchCalls.find((entry) => entry.path === '/admin/nodes/node-weak/config')
    expect(JSON.parse(String(call?.init?.body))).toMatchObject({ displayName: 'Mac mini', maxVramGbOverride: 2 })
  })

  it('REQ-ADM-005 validating a custom domain sends the entered hostname', async () => {
    const harness = await dashboardHarness()
    harness.byId('custom-domain').value = 'mesh.example.com'
    await harness.clickAction('custom-domain-validate', { out: 'domain-output' })
    const call = harness.fetchCalls.find((entry) => entry.path === '/admin/custom-domain/validate')
    expect(call?.init?.method).toBe('POST')
    expect(JSON.parse(String(call?.init?.body))).toEqual({ hostname: 'mesh.example.com' })
  })

  it('REQ-ADM-008 saving the agent version posts the fleet-wide selection', async () => {
    const harness = await dashboardHarness()
    harness.byId(ADMIN_UI_AGENT_VERSION.selectId).value = 'v1.4.0'
    await harness.clickAction('agent-version-set', { out: 'agent-version-output' })
    const call = harness.fetchCalls.find((entry) => entry.path === '/admin/agent-version')
    expect(call?.init?.method).toBe('POST')
    expect(JSON.parse(String(call?.init?.body))).toEqual({ version: 'v1.4.0' })
  })

  it('REQ-ADM-033 refreshing runtime versions re-reads the version list and repopulates the output', async () => {
    const harness = await dashboardHarness()
    const reads = () => harness.fetchCalls.filter((entry) => entry.path === '/admin/runtime-versions' && (entry.init?.method ?? 'GET') === 'GET')
    const before = reads().length
    harness.byId('runtime-version-output').textContent = ''
    await harness.clickAction('runtime-versions-refresh', { out: 'runtime-version-output' })
    await harness.flush(3)
    expect(reads().length).toBe(before + 1)
    // Populated, not what it says: the wording is copy and the count is the contract.
    expect(harness.byId('runtime-version-output').textContent).not.toBe('')
  })

})
