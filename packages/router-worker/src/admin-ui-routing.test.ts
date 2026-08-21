/**
 * dashboard routing contracts.
 *
 * One slice of the console dashboard suite; shared fixtures live in
 * `./admin-ui-test-support`.
 */
import { adminUiHtml } from './admin-ui'
import { dashboardHarness, statusFetches, statusFixture } from './admin-ui-test-support'
import { descendants } from './admin-ui-harness'
import { describe, expect, it } from 'vitest'

describe('dashboard routing contracts', () => {
  const routingRespond = (provisioned: boolean) => (path: string) => {
    if (path.startsWith('/admin/cloudflare/gateway/options')) return Response.json({ gateways: [{ id: 'inference-mesh' }], routes: [], defaults: { gatewayId: 'inference-mesh', providerName: 'Codeflare Inference Mesh' } })
    if (path.startsWith('/admin/cloudflare/gateway/provision-status')) return Response.json({ gatewayId: 'inference-mesh', provisioned, routeEnabled: provisioned, ...(provisioned ? { routeId: 'r', providerId: 'p' } : {}) })
    return undefined
  }


  it('REQ-ADM-024 REQ-GWY-009 the gateway card lists every ensured mesh route', async () => {
    const gateway = {
      gatewayId: 'inference-mesh',
      routeName: 'codeflare-mesh',
      publicModel: 'codeflare-mesh',
      routes: [
        { routeName: 'codeflare-mesh', publicModel: 'codeflare-mesh', routeId: 'r1' },
        { routeName: 'codeflare-mesh-research', publicModel: 'codeflare-mesh-research', routeId: 'r2' }
      ]
    }
    const harness = await dashboardHarness({ status: statusFixture({ gateway }) })
    const sub = descendants(harness.byId('gateway-current')).find((node) => node.className === 'state-sub')
    expect(sub?.textContent).toBe('routes codeflare-mesh · codeflare-mesh-research')
  })


  it('REQ-ADM-024 shows the selected gateway route inside the AI Gateway card', async () => {
    // Provisioned per the live check but zero nodes online: the card is driven by provisioning
    // state (route + provider), not node or serving health, so it still reads connected.
    const harness = await dashboardHarness({ status: statusFixture({ nodes: [] }), respond: routingRespond(true) })
    await harness.click(harness.query('[data-nav="routing"]'))
    await harness.flush(20)
    const card = harness.byId('gateway-current')
    expect(descendants(card).find((node) => node.className === 'state-value')?.textContent).toBe('inference-mesh')
    expect(descendants(card).find((node) => node.className === 'state-sub')?.textContent).toBe('route codeflare-mesh')
    expect(descendants(card).find((node) => node.className === 'chip')?.textContent).toContain('connected')
  })


  it('REQ-ADM-024 marks the AI Gateway card as needing provisioning when the selected route is missing', async () => {
    const harness = await dashboardHarness({ respond: routingRespond(false) })
    await harness.click(harness.query('[data-nav="routing"]'))
    await harness.flush(20)
    const card = harness.byId('gateway-current')
    expect(descendants(card).find((node) => node.className === 'state-sub')?.textContent).toBe('route not provisioned')
    expect(descendants(card).find((node) => node.className === 'chip')?.dataset.tone).toBe('warn')
  })


  it('REQ-ADM-024 preserves the selected gateway across dashboard refreshes', async () => {
    const provisionChecks: string[] = []
    const harness = await dashboardHarness({
      respond: (path) => {
        if (path.startsWith('/admin/cloudflare/gateway/options')) return Response.json({ gateways: [{ id: 'codeflare-enterprise' }, { id: 'lab-gateway' }], routes: [], defaults: { gatewayId: 'codeflare-enterprise', providerName: 'Codeflare Inference Mesh' } })
        if (path.startsWith('/admin/cloudflare/gateway/provision-status')) {
          provisionChecks.push(new URL('https://router.test' + path).searchParams.get('gateway') || '')
          return Response.json({ gatewayId: provisionChecks.at(-1), provisioned: true, routeEnabled: true, routeName: 'codeflare-mesh', routeId: 'r', providerId: 'p' })
        }
        return undefined
      }
    })
    await harness.click(harness.query('[data-nav="routing"]'))
    await harness.flush(20)
    harness.byId('rt-gateway-select').value = 'lab-gateway'
    await harness.change(harness.byId('rt-gateway-select'))
    await harness.flush(20)
    await harness.clickAction('status-refresh')
    await harness.flush(20)

    expect(harness.byId('rt-gateway-select').value).toBe('lab-gateway')
    expect(descendants(harness.byId('gateway-current')).find((node) => node.className === 'state-value')?.textContent).toBe('lab-gateway')
    expect(provisionChecks).toContain('lab-gateway')
  })


  it('REQ-ADM-024 the Routing screen exposes a copy control for the minted provider key', async () => {
    const harness = await dashboardHarness({
      respond: (path, init) => path === '/admin/cloudflare/gateway/sync' && (init?.method || 'GET') === 'POST'
        ? Response.json({ providerToken: 'provider_minted_key', byokInstruction: 'paste it into the AI Gateway provider key field' })
        : undefined
    })
    await harness.clickAction('gateway-sync', { out: 'gateway-output', prefix: 'rt-' })
    await harness.flush(3)
    // The minted provider key surfaces as a token card with a copy control carrying the key value.
    const cards = harness.byId('gateway-output').children.filter((child) => child.dataset.tokenCard)
    expect(cards).toHaveLength(1)
    expect(cards[0]!.dataset.tokenCard).toBe('AI Gateway provider key')
    expect(cards[0]!.children.find((child) => child.dataset.copy)!.dataset.copy).toBe('provider_minted_key')
  })


  it('REQ-ADM-024 renders the AI Gateway paste instruction with the minted key', async () => {
    const harness = await dashboardHarness({
      respond: (path, init) => path === '/admin/cloudflare/gateway/sync' && (init?.method || 'GET') === 'POST'
        ? Response.json({ providerToken: 'provider_minted_key', byokInstruction: 'server-provided paste instruction' })
        : undefined
    })
    await harness.clickAction('gateway-sync', { out: 'gateway-output', prefix: 'rt-' })
    await harness.flush(3)
    // The server-provided BYOK instruction is rendered to the operator, not just carried in the response body.
    const warning = harness.byId('gateway-output').children.find((child) => child.dataset.tokenWarning)
    expect(warning).toBeDefined()
    expect(warning!.textContent).toBe('server-provided paste instruction')
  })


  it('REQ-ADM-024 keeps route status inside the Gateway card and labels the action clearly', () => {
    const html = adminUiHtml('https://router.test', { view: 'dashboard', phase: 'complete', customDomain: 'router.test', recovery: false })
    expect(html).not.toContain('id="rt-route-chip"')
    expect(html).toContain('data-action="gateway-sync"')
    expect(html).toContain('Provision Gateway')
  })


  it('REQ-ADM-024 reads the connected gateway as a state card', async () => {
    // The connected gateway renders as an ok-toned status card carrying the gateway id as its value.
    const harness = await dashboardHarness()
    const card = harness.byId('gateway-current')
    const value = descendants(card).find((node) => node.className === 'state-value')
    expect(value!.textContent).toBe('inference-mesh')
    expect(card.classList.contains('is-empty')).toBe(false)
    expect(card.classList.contains('is-ok')).toBe(true)
    expect(descendants(card).find((node) => node.className === 'chip')?.dataset.tone).toBe('ok')
    expect(descendants(card).find((node) => node.className === 'state-sub')?.textContent).toBe('route codeflare-mesh')
  })


  it('REQ-GWY-005 the gateway step renders a provider-name field and no route select', async () => {
    const harness = await dashboardHarness()
    expect(harness.html).toContain('id="rt-gateway-provider-name"')
    expect(harness.html).not.toContain('id="rt-route-select"')
  })


  it('REQ-ADM-025 renders an add-model form with a mode selector defaulting to single machine', async () => {
    const harness = await dashboardHarness()
    const html = harness.html
    expect(html).toContain('id="model-add-mode"')
    expect(html).toContain('id="model-add-ref"')
    // Single machine is the first (default-selected) option in the mode selector.
    const singleIndex = html.indexOf('value="single"')
    const splitIndex = html.indexOf('value="split"')
    expect(singleIndex).toBeGreaterThan(-1)
    expect(splitIndex).toBeGreaterThan(singleIndex)
  })


  it('REQ-ADM-025 links to the Unsloth GGUF catalog, the meshllm layer-package org, and the split-your-own guide', async () => {
    const harness = await dashboardHarness()
    const html = harness.html
    expect(html).toContain('href="https://huggingface.co/unsloth?search_models=GGUF"')
    expect(html).toContain('href="https://huggingface.co/meshllm"')
    expect(html).toContain('href="https://github.com/Mesh-LLM/hf-mesh-skippy-splitter"')
  })


  it('REQ-ADM-025 posts the model ref and mode and refreshes the model list', async () => {
    const harness = await dashboardHarness()
    harness.byId('model-add-ref').value = 'unsloth/Qwen3-14B-GGUF:Q4_K_M'
    harness.byId('model-add-mode').value = 'split'
    const statusBefore = statusFetches(harness)
    await harness.clickAction('model-add')
    await harness.flush(10)
    const addCall = harness.fetchCalls.find((call) => call.path === '/admin/profiles/add')
    expect(addCall).toBeDefined()
    expect(addCall?.init?.method).toBe('POST')
    expect(JSON.parse(String(addCall?.init?.body))).toEqual({ modelRef: 'unsloth/Qwen3-14B-GGUF:Q4_K_M', mode: 'split', runtime: 'meshllm' })
    // A successful add refreshes status so the new model appears in the list.
    expect(statusFetches(harness)).toBeGreaterThan(statusBefore)
  })


  it('REQ-ADM-025 does not submit an empty model ref', async () => {
    const harness = await dashboardHarness()
    harness.byId('model-add-ref').value = '   '
    await harness.clickAction('model-add')
    await harness.flush(10)
    expect(harness.fetchCalls.some((call) => call.path === '/admin/profiles/add')).toBe(false)
  })
})
