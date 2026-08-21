/**
 * dashboard throughput trace and playground contracts.
 *
 * One slice of the console dashboard suite; shared fixtures live in
 * `./admin-ui-test-support`.
 */
import { ADMIN_UI_NODES_TABLE, ADMIN_UI_PLAYGROUND, ADMIN_UI_TOKS_TRACE, adminUiHtml } from './admin-ui'
import { dashboardHarness, dashboardProfiles, statusFixture } from './admin-ui-test-support'
import { descendants } from './admin-ui-harness'
import { describe, expect, it } from 'vitest'

describe('dashboard throughput trace and playground contracts', () => {
  function toksStatus(total: number): Record<string, unknown> {
    return statusFixture({ nodes: [{ id: 'node-x', status: 'online', metrics: { runtimeState: 'running', tokensPerSecond: total, readyModels: [] } }] })
  }


  it('REQ-OBS-010 renders a smoothed rolling throughput trace from successive polls', async () => {
    let servedToks = 103.75
    const harness = await dashboardHarness({ respond: (path) => path === '/admin/status' ? Response.json(toksStatus(servedToks)) : undefined })
    const trace = harness.byId(ADMIN_UI_TOKS_TRACE.containerId)
    const bars = () => trace.children.filter((bar) => bar.dataset.sample !== undefined)

    expect(bars().map((bar) => bar.dataset.sample)).toEqual(['103.75'])
    expect(bars().map((bar) => bar.dataset.smoothed)).toEqual(['103.8'])
    bars().forEach((bar) => expect(bar.getAttribute('style')).toMatch(/height:\d+(\.\d+)?%/))

    servedToks = 42.5
    harness.runTimers()
    await harness.flush(10)
    expect(bars().map((bar) => bar.dataset.sample)).toEqual(['103.75', '42.5'])
    expect(bars().at(-1)!.dataset.smoothed).toBe('73.1')

    servedToks = 0
    harness.runTimers()
    await harness.flush(10)
    expect(bars().map((bar) => bar.dataset.sample)).toEqual(['103.75', '42.5', '0'])
    expect(bars().at(-1)!.dataset.smoothed).toBe('48.8')
  })


  it('REQ-OBS-010 renders no throughput bars while there is no real throughput', async () => {
    const harness = await dashboardHarness({ respond: (path) => path === '/admin/status' ? Response.json(toksStatus(0)) : undefined })
    const trace = harness.byId(ADMIN_UI_TOKS_TRACE.containerId)
    const bars = () => trace.children.filter((bar) => bar.dataset.sample !== undefined)
    expect(bars().length).toBe(0)
    harness.runTimers()
    await harness.flush(10)
    harness.runTimers()
    await harness.flush(10)
    expect(bars().length).toBe(0)
  })


  it('REQ-OBS-010 caps the throughput trace at the configured rolling window', async () => {
    const harness = await dashboardHarness()
    const trace = harness.byId(ADMIN_UI_TOKS_TRACE.containerId)
    for (let poll = 0; poll < 45; poll += 1) {
      harness.runTimers()
      await harness.flush(6)
    }
    const bars = trace.children.filter((bar) => bar.dataset.sample !== undefined)
    expect(bars.length).toBe(ADMIN_UI_TOKS_TRACE.window)
  })


  it('REQ-ADM-031 lists one playground option per model on, valued by callable name and labeled with the model name', async () => {
    const harness = await dashboardHarness()
    const select = harness.byId(ADMIN_UI_PLAYGROUND.selectId)
    // One option per model that is on. The value (and the option's data attribute) is the model's
    // own callable name — the alias the gateway resolves — not the shared codeflare-mesh alias.
    expect(select.children.map((option) => option.value)).toEqual(['qwen3.6:35b-a3b'])
    expect(select.children.map((option) => option.dataset.playgroundModelOption)).toEqual(['qwen3.6:35b-a3b'])
    // The label pairs both contract values (callable name and model name); format is not pinned.
    const label = select.children[0]!.textContent || ''
    expect(label).toContain('qwen3.6:35b-a3b')
    expect(label).toContain(dashboardProfiles[0]!.displayName)
  })


  it('REQ-ADM-016 streams the direct-target playground response incrementally as chunks arrive', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c } })
    // Default target is the direct router, so the send hits the direct-chat endpoint with an internal model.
    const harness = await dashboardHarness({
      respond: (path) => path === '/admin/playground/direct-chat' ? new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }) : undefined
    })
    harness.byId(ADMIN_UI_PLAYGROUND.promptId).value = 'hello mesh'
    const send = harness.clickAction(ADMIN_UI_PLAYGROUND.sendAction, { out: ADMIN_UI_PLAYGROUND.outputId })
    await harness.flush(10)

    controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'))
    await harness.flush(10)
    expect(harness.byId(ADMIN_UI_PLAYGROUND.outputId).textContent).toBe('Hello')

    controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":" mesh"}}]}\n\ndata: [DONE]\n\n'))
    controller.close()
    await harness.flush(10)
    await send

    expect(harness.byId(ADMIN_UI_PLAYGROUND.outputId).textContent).toBe('Hello mesh')
    const call = harness.fetchCalls.find((entry) => entry.path === '/admin/playground/direct-chat')
    expect(call?.init?.method).toBe('POST')
    const payload = JSON.parse(String(call?.init?.body)) as { model: string; messages: Array<{ role: string; content: string }>; user: string }
    expect(payload.model).toBe('qwen3.6:35b-a3b')
    expect(payload.messages).toEqual([{ role: 'user', content: 'hello mesh' }])
    expect(payload.user).toMatch(/^user:admin-playground\|session:/)
  })


  it('REQ-ADM-016 renders the tools input, max-token cap, and a stop control in the playground', () => {
    const html = adminUiHtml('https://router.test', { view: 'dashboard', phase: 'complete', customDomain: 'router.test', recovery: false })
    expect(html).toContain('id="' + ADMIN_UI_PLAYGROUND.toolsId + '"')
    expect(html).toContain('id="' + ADMIN_UI_PLAYGROUND.maxTokensId + '"')
    expect(html).toContain('data-action="' + ADMIN_UI_PLAYGROUND.stopAction + '"')
  })


  it('REQ-ADM-034 runs a direct router speed test from the playground', async () => {
    const result = {
      model: 'qwen3.6:35b-a3b',
      requestedPromptTokens: 2048,
      requestedMaxTokens: 160,
      tokens: { prompt: 2048, completion: 80, promptEstimated: false, completionEstimated: false },
      throughput: { promptTokensPerSecond: 1800.5, generationTokensPerSecond: 67.2 }
    }
    let lastSpeedTests: Record<string, unknown> | undefined
    const harness = await dashboardHarness({
      respond: (path) => {
        if (path === ADMIN_UI_PLAYGROUND.speedPath) {
          // The router stores the run keyed by the resolved profile id.
          lastSpeedTests = { 'mesh-default-qwen36-35b': { at: 1_700_000_300_000, requestId: 'speed-b', model: result.model, promptTokensPerSecond: 1800.5, generationTokensPerSecond: 67.2, requestedPromptTokens: 2048, requestedMaxTokens: 160, promptTokens: 2048, completionTokens: 80, promptTokensEstimated: false, completionTokensEstimated: false, timeToFirstTokenMs: 900, generationMs: 1200, totalMs: 2100 } }
          return Response.json(result)
        }
        if (path === '/admin/status') return Response.json(statusFixture(lastSpeedTests ? { lastSpeedTests } : { lastSpeedTests: undefined }))
        return undefined
      }
    })
    harness.byId(ADMIN_UI_PLAYGROUND.selectId).value = 'qwen3.6:35b-a3b'

    await harness.clickAction(ADMIN_UI_PLAYGROUND.speedAction, { out: ADMIN_UI_PLAYGROUND.speedOutputId })
    const call = harness.fetchCalls.find((entry) => entry.path === ADMIN_UI_PLAYGROUND.speedPath)
    const payload = JSON.parse(String(call?.init?.body)) as { model: string }
    const rendered = JSON.parse(harness.byId(ADMIN_UI_PLAYGROUND.speedOutputId).textContent) as typeof result

    expect(payload.model).toBe('qwen3.6:35b-a3b')
    expect(rendered.tokens).toEqual(result.tokens)
    expect(rendered.throughput).toEqual(result.throughput)
    // The refreshed status lands the measurement on the model's mesh card.
    const card = descendants(harness.byId('overview-mesh')).find((el) => el.getAttribute('data-mesh-status') === 'default')!
    expect(card.getAttribute('data-speed-prompt')).toBe('1801')
    expect(card.getAttribute('data-speed-gen')).toBe('67')
  })


  it('REQ-ADM-029 forwards tools and a max-token cap and surfaces tool calls on the dynamic route', async () => {
    const harness = await dashboardHarness({
      respond: (path) => path === '/admin/playground/direct-chat'
        ? new Response('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"get_weather","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })
        : undefined
    })
    harness.byId(ADMIN_UI_PLAYGROUND.promptId).value = 'call a tool'
    harness.byId(ADMIN_UI_PLAYGROUND.toolsId).value = '[{"type":"function","function":{"name":"get_weather","parameters":{}}}]'
    harness.byId(ADMIN_UI_PLAYGROUND.maxTokensId).value = '256'
    const send = harness.clickAction(ADMIN_UI_PLAYGROUND.sendAction, { out: ADMIN_UI_PLAYGROUND.outputId })
    await harness.flush(10)
    await send

    const call = harness.fetchCalls.find((entry) => entry.path === '/admin/playground/direct-chat')
    const body = JSON.parse(String(call?.init?.body))
    expect(body.tools).toEqual([{ type: 'function', function: { name: 'get_weather', parameters: {} } }])
    expect(body.maxTokens).toBe(256)
    expect(harness.byId(ADMIN_UI_PLAYGROUND.outputId).textContent).toContain('[tool calls] get_weather')
  })


  it('REQ-ADM-016 appends stream chunks to one text node so a mid-stream selection survives', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c } })
    const harness = await dashboardHarness({
      respond: (path) => path === '/admin/playground/direct-chat' ? new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }) : undefined
    })
    harness.byId(ADMIN_UI_PLAYGROUND.promptId).value = 'hi'
    const send = harness.clickAction(ADMIN_UI_PLAYGROUND.sendAction, { out: ADMIN_UI_PLAYGROUND.outputId })
    await harness.flush(10)

    controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n'))
    await harness.flush(10)
    const outputEl = harness.byId(ADMIN_UI_PLAYGROUND.outputId)
    const firstNode = outputEl.children.find((child) => child.nodeType === 3)
    expect(firstNode, 'the first chunk creates a text node').toBeDefined()

    controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n\n'))
    controller.close()
    await harness.flush(10)
    await send

    // The same text node grew in place instead of being replaced, so a selection inside
    // it would survive; assert one text-node child, still the original reference.
    const textNodes = outputEl.children.filter((child) => child.nodeType === 3)
    expect(textNodes).toHaveLength(1)
    expect(textNodes[0]).toBe(firstNode)
    expect(outputEl.textContent).toBe('Hello')
  })


  it('REQ-ADM-016 the stop control aborts an in-flight playground stream', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c } })
    let aborted = false
    const harness = await dashboardHarness({
      respond: (path, init) => {
        if (path !== '/admin/playground/direct-chat') return undefined
        // Faithfully model the browser: aborting the fetch signal errors the response
        // body, so the in-flight read rejects and the stream ends.
        init?.signal?.addEventListener('abort', () => {
          aborted = true
          try { controller.error(new DOMException('aborted', 'AbortError')) } catch { /* already closed */ }
        })
        return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }
    })
    harness.byId(ADMIN_UI_PLAYGROUND.promptId).value = 'hello mesh'
    const send = harness.clickAction(ADMIN_UI_PLAYGROUND.sendAction, { out: ADMIN_UI_PLAYGROUND.outputId })
    await harness.flush(10)

    controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n'))
    await harness.flush(10)
    expect(harness.byId(ADMIN_UI_PLAYGROUND.outputId).textContent).toBe('Hel')

    // Pressing Stop aborts the fetch signal, which ends the stream.
    await harness.clickAction(ADMIN_UI_PLAYGROUND.stopAction)
    await harness.flush(10)
    expect(aborted, 'stop aborts the in-flight fetch signal').toBe(true)

    // A chunk produced after Stop must not reach the output; the read loop has ended.
    try { controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n')) } catch { /* stream aborted */ }
    await harness.flush(10)
    await send
    expect(harness.byId(ADMIN_UI_PLAYGROUND.outputId).textContent).toBe('Hel')
  })


  it('REQ-ADM-016 the status poll preserves the chosen playground model', async () => {
    const profiles = [
      { id: 'model-a', displayName: 'Model A', publicAliases: ['codeflare-mesh', 'model-a'], active: true, rolloutPercent: 100, meshllm: { split: false } },
      { id: 'model-b', displayName: 'Model B', publicAliases: ['codeflare-mesh', 'model-b'], active: true, rolloutPercent: 100, meshllm: { split: false } }
    ]
    const harness = await dashboardHarness({ status: statusFixture({ profiles }) })
    expect(harness.byId(ADMIN_UI_PLAYGROUND.selectId).children.map((option) => option.value)).toEqual(['model-a', 'model-b'])
    // Operator picks the second model, then a periodic status poll re-renders the select.
    harness.byId(ADMIN_UI_PLAYGROUND.selectId).value = 'model-b'
    await harness.clickAction('status-refresh')
    expect(harness.byId(ADMIN_UI_PLAYGROUND.selectId).value).toBe('model-b')
  })


  it('REQ-ADM-031 a gateway target lists that gateway routes and sends the selected route to the gateway endpoint', async () => {
    const harness = await dashboardHarness({
      respond: (path) => {
        if (path.startsWith('/admin/cloudflare/gateway/options')) return Response.json({ gateways: [{ id: 'gw-a' }], routes: [{ id: 'r1', name: 'codeflare-mesh' }, { id: 'r2', name: 'custom-route' }], defaults: { gatewayId: 'gw-a', providerName: 'Codeflare Inference Mesh' } })
        if (path === '/admin/playground/chat') return new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })
        return undefined
      }
    })
    // Opening the Playground lists the direct router plus the discovered gateway as targets.
    await harness.click(harness.query('[data-nav="playground"]'))
    await harness.flush(10)
    const target = harness.byId(ADMIN_UI_PLAYGROUND.targetSelectId)
    expect(target.children.map((option) => option.value)).toEqual(['direct', 'gw-a'])

    // Switching to the gateway target fills the model/route select from that gateway's routes.
    target.value = 'gw-a'
    await harness.change(target)
    await harness.flush(10)
    expect(harness.byId(ADMIN_UI_PLAYGROUND.selectId).children.map((option) => option.value)).toEqual(['codeflare-mesh', 'custom-route'])

    harness.byId(ADMIN_UI_PLAYGROUND.selectId).value = 'custom-route'
    harness.byId(ADMIN_UI_PLAYGROUND.promptId).value = 'hi'
    const send = harness.clickAction(ADMIN_UI_PLAYGROUND.sendAction, { out: ADMIN_UI_PLAYGROUND.outputId })
    await harness.flush(10)
    await send
    const call = harness.fetchCalls.find((entry) => entry.path === '/admin/playground/chat')
    expect(call?.init?.method).toBe('POST')
    const body = JSON.parse(String(call?.init?.body)) as { gatewayId: string; route: string; messages: Array<{ role: string; content: string }>; user: string }
    expect(body.gatewayId).toBe('gw-a')
    expect(body.route).toBe('custom-route')
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }])
    expect(body.user).toMatch(/^user:admin-playground\|session:/)
  })


  it('REQ-ADM-016 appends a status-specific actionable hint when a playground request fails', async () => {
    const bareLen = (status: number) => ('Playground request failed (' + status + ').').length
    const outputFor = async (status: number): Promise<string> => {
      const harness = await dashboardHarness({ respond: (path) => path === '/admin/playground/direct-chat' ? new Response('{"error":"x"}', { status }) : undefined })
      harness.byId(ADMIN_UI_PLAYGROUND.promptId).value = 'hi'
      const send = harness.clickAction(ADMIN_UI_PLAYGROUND.sendAction, { out: ADMIN_UI_PLAYGROUND.outputId })
      await harness.flush(10)
      await send
      return harness.byId(ADMIN_UI_PLAYGROUND.outputId).textContent
    }
    const out400 = await outputFor(400)
    const out401 = await outputFor(401)
    const out409 = await outputFor(409)
    const out404 = await outputFor(404)
    const out502 = await outputFor(502)
    const out503 = await outputFor(503)
    // Behavioral contract (survives without pinning copy): each failure carries the status code plus a
    // hint beyond the bare line, and distinct statuses map to distinct hints. Gut playgroundHint -> all
    // collapse to the bare line and the length + inequality assertions fail.
    expect(out401).toContain('(401)')
    expect(out400.length).toBeGreaterThan(bareLen(400))
    expect(out401.length).toBeGreaterThan(bareLen(401))
    expect(out409.length).toBeGreaterThan(bareLen(409))
    expect(out400).not.toBe(out401)
    expect(out401).not.toBe(out409)
    // The thin-forwarder scheduler-miss statuses each carry their own actionable hint: 404 no-profile,
    // 502 node_unreachable, 503 no ready node. A scheduler miss no longer returns 429, so 429 maps to no
    // hint here (a rate-limit 429 from the top-level limiter is a separate path).
    expect(out404.length).toBeGreaterThan(bareLen(404))
    expect(out502.length).toBeGreaterThan(bareLen(502))
    expect(out503.length).toBeGreaterThan(bareLen(503))
    expect(out404).not.toBe(out502)
    expect(out502).not.toBe(out503)
  })


  it('REQ-ADM-005 surfaces the currently provisioned custom domain in Routing', async () => {
    const harness = await dashboardHarness()
    const card = harness.byId('custom-domain-current')
    const value = descendants(card).find((node) => node.className === 'state-value')
    const chip = descendants(card).find((node) => node.className === 'chip')
    // Contract values, not copy: the prominent readout carries the provisioned host as its value
    // and its status as a chip. Gutting the readout leaves the empty-state card (placeholder value,
    // no chip), so the host and the ok-toned status chip both disappear.
    expect(value!.textContent).toBe('router.test')
    expect(card.classList.contains('is-empty')).toBe(false)
    expect(chip, 'a provisioned domain shows a status chip').toBeDefined()
    expect(chip!.dataset.tone).toBe('ok')
    expect(card.classList.contains('is-ok')).toBe(true)
  })


  it('REQ-ADM-005 renders an empty-state card when no custom domain is recorded', async () => {
    const harness = await dashboardHarness({ status: statusFixture({ customDomain: undefined }) })
    const card = harness.byId('custom-domain-current')
    // No domain: the card is the empty state (placeholder value, no status chip).
    expect(card.classList.contains('is-empty')).toBe(true)
    const value = descendants(card).find((node) => node.className === 'state-value')
    expect(value!.textContent).toBe('Not set yet')
    expect(descendants(card).some((node) => node.className === 'chip')).toBe(false)
  })


  it('REQ-ADM-018 orders profile rows active-first regardless of source order', async () => {
    const profiles = [
      { id: 'standby-a', publicAliases: ['standby-a'], active: false, rolloutPercent: 100, meshllm: { split: false } },
      { id: 'serving-b', publicAliases: ['serving-b'], active: true, rolloutPercent: 100, meshllm: { split: false } },
      { id: 'standby-c', publicAliases: ['standby-c'], active: false, rolloutPercent: 100, meshllm: { split: false } }
    ]
    const harness = await dashboardHarness({ status: statusFixture({ profiles }) })
    const rows = harness.byId('profile-list').children.filter((row) => row.dataset.profileRow)
    // Active surfaces first; stable sort preserves source order within each group.
    expect(rows.map((row) => row.dataset.profileRow)).toEqual(['serving-b', 'standby-a', 'standby-c'])
  })


  it('REQ-ADM-018 shows each model as one card with its canonical name and an on/off toggle', async () => {
    const harness = await dashboardHarness()
    const rows = harness.byId('profile-list').children.filter((row) => row.dataset.profileRow)
    // Every model is visible, named by its display name (not its wiring id).
    const names = descendants(harness.byId('profile-list')).filter((node) => node.dataset.modelName).map((node) => node.textContent)
    for (const profile of dashboardProfiles) expect(names).toContain(profile.displayName)
    // The toggle reflects state via its data-on contract (not its copy): the active model is on, the other off.
    const toggle = (id: string) => descendants(rows.find((row) => row.dataset.profileRow === id)!).find((node) => node.dataset.action === 'model-toggle')!
    expect(toggle('mesh-default-qwen36-35b').dataset.on).toBe('true')
    expect(toggle('mesh-split-qwen36-35b').dataset.on).toBe('false')
  })


  it('REQ-ADM-018 badges each model with its serving mode instead of baking it into the name', async () => {
    const profiles = [
      { id: 'single-a', displayName: 'Single A', publicAliases: ['codeflare-mesh', 'single-a'], active: true, rolloutPercent: 100, meshllm: { split: false } },
      { id: 'split-b', displayName: 'Split B', publicAliases: ['codeflare-mesh', 'split-b'], active: false, rolloutPercent: 0, meshllm: { split: true } }
    ]
    const harness = await dashboardHarness({ status: statusFixture({ profiles }) })
    const rows = harness.byId('profile-list').children.filter((row) => row.dataset.profileRow)
    const badge = (id: string) => descendants(rows.find((row) => row.dataset.profileRow === id)!).find((node) => node.dataset.servingMode)!
    // Serving mode is carried by a pill attribute with the fixed tone vocabulary: singular = blue, sharded = orange.
    expect(badge('single-a').dataset.servingMode).toBe('single')
    expect(badge('split-b').dataset.servingMode).toBe('split')
    expect(badge('split-b').dataset.tone).toBe('orange')
    expect(badge('single-a').dataset.tone).toBe('blue')
  })


  it('REQ-ADM-018 REQ-RUN-016 serving counts bind to the adopted profile, not the shared model reference', async () => {
    const shared = 'unsloth/Qwen2.5-Coder-1.5B-Instruct-GGUF:Q4_K_M'
    const profiles = [
      { id: 'twin-llamacpp', displayName: 'Research Qwen', upstreamModel: shared, publicAliases: ['codeflare-mesh-research', 'twin'], meshId: 'research', active: true, rolloutPercent: 100, runtime: 'llamacpp', llamacpp: { modelRef: shared, bindPort: 4520 } },
      { id: 'twin-meshllm', displayName: 'Research Single Qwen', upstreamModel: shared, publicAliases: ['codeflare-mesh-research', 'twin-single'], meshId: 'research', active: false, rolloutPercent: 0, runtime: 'meshllm', meshllm: { split: false } }
    ]
    // One machine runs the llama.cpp twin; the switched-off meshllm twin references the
    // same model file but nobody has adopted it.
    const nodes = [{ id: 'mac', status: 'online', meshId: 'research', activeProfileIds: ['twin-llamacpp'], metrics: { runtimeKind: 'llamacpp', runtimeState: 'ready', activeRequests: 0, readyModels: [shared] } }]
    const harness = await dashboardHarness({ status: statusFixture({ profiles, nodes }) })
    const rowOf = (id: string) => harness.byId('profile-list').children.find((row) => row.dataset.profileRow === id)!
    expect(rowOf('twin-llamacpp').dataset.serving).toBe('1')
    expect(rowOf('twin-meshllm').dataset.serving).toBe('0')
  })


  it('REQ-RUN-021 a vllm model card carries its runtime pill attribute', async () => {
    // The runtime pill is a fixed vocabulary contract (data-runtime); a vllm
    // profile must render its own value, not fall back to a sibling runtime's.
    const meshes = [{ id: 'default', name: 'Default', alias: 'codeflare-mesh', machineCount: 1, modelCount: 1 }]
    const profiles = [
      { id: 'model-vllm', displayName: 'vLLM Model', upstreamModel: 'org/model', publicAliases: ['codeflare-mesh', 'org-model'], active: true, rolloutPercent: 100, runtime: 'vllm', vllm: { hfRepo: 'org/model', bindPort: 4400, contextWindow: 0 } }
    ]
    const nodes = [{ id: 'node-vllm', status: 'online', runtime: 'vllm', activeProfileIds: ['model-vllm'], metrics: { runtimeKind: 'vllm', runtimeState: 'ready', activeRequests: 0, readyModels: ['org/model'], platform: 'linux', cudaAvailable: true } }]
    const harness = await dashboardHarness({ status: statusFixture({ profiles, nodes, meshes }) })
    const row = descendants(harness.byId('overview-mesh')).find((el) => el.getAttribute('data-mesh-status') === 'default')!
    expect(descendants(row).find((el) => el.getAttribute('data-runtime') !== null)!.getAttribute('data-runtime')).toBe('vllm')
  })


  it('REQ-ADM-039 overview mesh status cards summarize each mesh: model, machines, serving, last speed test', async () => {
    const meshes = [
      { id: 'default', name: 'Default', alias: 'codeflare-mesh', machineCount: 1, modelCount: 1 },
      { id: 'ops', name: 'Ops', alias: 'codeflare-mesh-ops', machineCount: 1, modelCount: 1 },
      { id: 'empty', name: 'Empty', alias: 'codeflare-mesh-empty', machineCount: 0, modelCount: 0 },
      { id: 'research', name: 'Research', alias: 'codeflare-mesh-research', machineCount: 1, modelCount: 1 }
    ]
    const profiles = [
      { id: 'model-default', displayName: 'Default Model', upstreamModel: 'unsloth/Default-GGUF:Q4', publicAliases: ['codeflare-mesh', 'main'], active: true, rolloutPercent: 100, meshllm: { split: false } },
      { id: 'model-ops', displayName: 'Ops Model', upstreamModel: 'unsloth/Ops-GGUF:Q4', publicAliases: ['codeflare-mesh-ops', 'ops'], meshId: 'ops', active: true, rolloutPercent: 100, meshllm: { split: false } },
      { id: 'model-research', displayName: 'Research Model', upstreamModel: 'unsloth/Research-GGUF:Q4', publicAliases: ['codeflare-mesh-research', 'research'], meshId: 'research', active: true, rolloutPercent: 100, meshllm: { split: false } }
    ]
    const nodes = [
      { id: 'node-serving', status: 'online', activeProfileIds: ['model-default'], metrics: { runtimeState: 'ready', activeRequests: 0, readyModels: ['unsloth/Default-GGUF:Q4'], tokensPerSecond: 42 } },
      { id: 'node-ops', status: 'online', meshId: 'ops', activeProfileIds: [], metrics: { runtimeState: 'starting', activeRequests: 0 } },
      // Deactivated with stale adopted/ready state: the record still says it runs the
      // Research model, but a deactivated machine must never count as serving.
      { id: 'node-research', status: 'online', deactivated: true, meshId: 'research', activeProfileIds: ['model-research'], metrics: { runtimeState: 'ready', activeRequests: 0, readyModels: ['unsloth/Research-GGUF:Q4'] } }
    ]
    const lastSpeedTests = { 'model-default': { at: 1_700_000_100_000, requestId: 'speed-a', model: 'main', promptTokensPerSecond: 726.7, generationTokensPerSecond: 60.4 } }
    const harness = await dashboardHarness({ status: statusFixture({ profiles, nodes, meshes, lastSpeedTests }) })
    const row = (id: string) => descendants(harness.byId('overview-mesh')).find((el) => el.getAttribute('data-mesh-status') === id)!
    // Default: its model is adopted and ready on one machine, and its model has a
    // stored speed test.
    expect(row('default').getAttribute('data-machines')).toBe('1')
    expect(row('default').getAttribute('data-serving')).toBe('1')
    // Speed figures render as whole numbers with a spaced slash (726.7 / 60.4 stored).
    expect(row('default').getAttribute('data-speed-prompt')).toBe('727')
    expect(row('default').getAttribute('data-speed-gen')).toBe('60')
    const speedCell = descendants(row('default')).find((el) => el.className === 'mesh-stat mesh-stat-speed')!
    expect(descendants(speedCell).find((el) => el.className === 'metric-value')!.textContent).toBe('727 / 60')
    expect(row('default').getAttribute('data-state')).toBe('Serving')
    expect(row('default').getAttribute('data-state-tone')).toBe('ok')
    // The card merges the mesh identity (purple card title + route) with the model's own pills.
    const title = descendants(row('default')).find((el) => el.getAttribute('data-profile-mesh') !== null)!
    expect(title.className).toBe('mesh-card-name')
    expect(descendants(row('default')).find((el) => el.getAttribute('data-runtime') !== null)!.getAttribute('data-runtime')).toBe('meshllm')
    expect(descendants(row('default')).find((el) => el.getAttribute('data-serving-mode') !== null)!.getAttribute('data-serving-mode')).toBe('single')
    // The model block reads name, then the mono model file reference, then the pill row.
    const modelBlock = descendants(row('default')).find((el) => el.className === 'mesh-card-model')!
    expect(modelBlock.children.map((child) => child.className)).toEqual(['', 'mesh-card-file', 'mesh-card-pills'])
    expect(descendants(row('default')).find((el) => el.className === 'mesh-card-file')!.textContent).toBe('unsloth/Default-GGUF:Q4')
    // The serving-capacity track fills to the served fraction of the mesh's machines.
    expect(descendants(row('default')).find((el) => el.getAttribute('data-fill') !== null)!.getAttribute('data-fill')).toBe('100')
    expect(descendants(row('ops')).find((el) => el.getAttribute('data-fill') !== null)!.getAttribute('data-fill')).toBe('0')
    // Ops: model on but its machine has not adopted it yet — amber, zero serving, and no
    // speed test on record for its model.
    expect(row('ops').getAttribute('data-serving')).toBe('0')
    expect(row('ops').getAttribute('data-speed-gen')).toBeNull()
    expect(row('ops').getAttribute('data-state-tone')).toBe('warn')
    // Research: its only machine is deactivated but its record still carries adopted +
    // ready state — a deactivated (or offline) machine never counts as serving.
    expect(row('research').getAttribute('data-serving')).toBe('0')
    expect(row('research').getAttribute('data-state')).not.toBe('Serving')
    expect(row('research').getAttribute('data-state-tone')).toBe('warn')
    // An empty mesh with no model stays neutral — a group without a model is a choice, not an
    // alarm — and carries no model pills.
    expect(row('empty').getAttribute('data-state-tone')).toBe('idle')
    expect(descendants(row('empty')).find((el) => el.getAttribute('data-runtime') !== null)).toBeUndefined()
    // The card head pairs the mesh name with its callable route — the status word is gone;
    // the tone edge carries state, so no dot chip renders inside the card.
    const opsHead = descendants(row('ops')).find((el) => el.className === 'mesh-card-head')!
    expect(descendants(opsHead).find((el) => el.getAttribute('data-mesh-alias') !== null)!.getAttribute('data-mesh-alias')).toBe('codeflare-mesh-ops')
    expect(descendants(row('ops')).find((el) => el.className === 'dot')).toBeUndefined()
    // The activity feed is gone from the Overview: logs live in Settings only.
    expect(() => harness.byId('overview-audit')).toThrow()
  })


  it('REQ-ADM-039 mesh cards expose split state and surface degradation notes', async () => {
    const meshes = [
      { id: 'default', name: 'Default', alias: 'codeflare-mesh', machineCount: 2, modelCount: 1 },
      { id: 'solo', name: 'Solo', alias: 'codeflare-mesh-solo', machineCount: 2, modelCount: 1 },
      { id: 'quiet', name: 'Quiet', alias: 'codeflare-mesh-quiet', machineCount: 1, modelCount: 1 }
    ]
    const profiles = [
      { id: 'split-ok', displayName: 'Split OK', upstreamModel: 'meshllm/A-layers', publicAliases: ['codeflare-mesh'], active: true, rolloutPercent: 100, meshllm: { split: true } },
      { id: 'split-fb', displayName: 'Split FB', upstreamModel: 'meshllm/B-layers', publicAliases: ['codeflare-mesh-solo'], meshId: 'solo', active: true, rolloutPercent: 100, meshllm: { split: true } },
      { id: 'split-idle', displayName: 'Split idle', upstreamModel: 'meshllm/C-layers', publicAliases: ['codeflare-mesh-quiet'], meshId: 'quiet', active: true, rolloutPercent: 100, meshllm: { split: true } }
    ]
    const nodes = [
      { id: 'n-a1', status: 'online', activeProfileIds: ['split-ok'], metrics: { runtimeState: 'ready', activeRequests: 0, readyModels: ['meshllm/A-layers'] } },
      // A worker holding a stage counts as serving even while its own console idles in
      // standby (mesh-llm worker-side state): the stage corroborates the catalog claim.
      { id: 'n-a2', status: 'online', activeProfileIds: ['split-ok'], metrics: { runtimeState: 'starting', activeRequests: 0, readyModels: ['meshllm/A-layers'], stageCount: 2 } },
      { id: 'n-b1', status: 'online', meshId: 'solo', activeProfileIds: ['split-fb'], metrics: { runtimeState: 'ready', activeRequests: 0, readyModels: ['meshllm/B-layers'], runtimeDetail: 'prediction return sink unavailable' } },
      // Ghost: an api-client advertising the mesh catalog with no ready runtime and no
      // stage never counts as serving.
      { id: 'n-b2', status: 'online', meshId: 'solo', activeProfileIds: ['split-fb'], metrics: { runtimeState: 'starting', activeRequests: 0, readyModels: ['meshllm/B-layers'] } },
      { id: 'n-c1', status: 'online', meshId: 'quiet', activeProfileIds: ['split-idle'], metrics: { runtimeState: 'starting', activeRequests: 0 } }
    ]
    const meshHealth = [
      { profileId: 'split-ok', stageAssignments: [{ stageIndex: 0 }, { stageIndex: 1 }], splitReadiness: { verdict: 'ready' } },
      { profileId: 'split-fb', stageAssignments: [], splitReadiness: { verdict: 'waiting_for_peers' } },
      { profileId: 'split-idle', stageAssignments: [], splitReadiness: { verdict: 'waiting_for_peers' } }
    ]
    const harness = await dashboardHarness({ status: statusFixture({ profiles, nodes, meshes, meshHealth, lastSpeedTests: undefined }) })
    const row = (id: string) => descendants(harness.byId('overview-mesh')).find((el) => el.getAttribute('data-mesh-status') === id)!
    // A formed topology reads as split serving: ok tone, no note.
    expect(row('default').getAttribute('data-split-state')).toBe('split')
    expect(row('default').getAttribute('data-state-tone')).toBe('ok')
    expect(row('default').getAttribute('data-serving')).toBe('2')
    expect(descendants(row('default')).some((el) => el.getAttribute('data-mesh-note') !== null)).toBe(false)
    // Serving machines without a formed topology read as fallback, and the node's
    // runtime error rides the card verbatim; the ghost api-client is not serving.
    expect(row('solo').getAttribute('data-split-state')).toBe('fallback')
    expect(row('solo').getAttribute('data-state-tone')).toBe('warn')
    expect(row('solo').getAttribute('data-serving')).toBe('1')
    const soloNote = descendants(row('solo')).find((el) => el.getAttribute('data-mesh-note') !== null)!
    expect(soloNote.getAttribute('data-mesh-note')).toBe('error')
    expect(soloNote.textContent).toBe('prediction return sink unavailable')
    // Nothing serving on a split mesh surfaces the readiness verdict.
    expect(row('quiet').getAttribute('data-serving')).toBe('0')
    const quietNote = descendants(row('quiet')).find((el) => el.getAttribute('data-mesh-note') !== null)!
    expect(quietNote.getAttribute('data-mesh-note')).toBe('verdict')
  })


  it('REQ-ADM-015 tags each node cell with its column label for the stacked mobile layout', async () => {
    const harness = await dashboardHarness()
    const row = harness.byId(ADMIN_UI_NODES_TABLE.bodyId).children.find((child) => child.dataset.nodeRow)
    expect(row, 'a node row should render').toBeDefined()
    // Every cell carries a data-label so the mobile card layout prints "Label: value" without side-scroll.
    expect(row!.children.map((cell) => cell.dataset.label)).toEqual(['Machine', 'Status', 'Mesh', 'VRAM', 'Version'])
  })
})
