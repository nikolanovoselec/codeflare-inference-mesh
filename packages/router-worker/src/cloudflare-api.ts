export interface GatewaySyncRequest {
  readonly accountId: string
  readonly gatewayId: string
  readonly workerUrl: string
  readonly providerName: string
  readonly routeName: string
  readonly providerTokenInstructions: string
}

export interface GatewaySyncResult {
  readonly providerId: string
  readonly routeId: string
  readonly routeVersionId: string
  readonly deploymentId: string
  readonly manualProviderKeyRequired: true
  readonly providerTokenInstructions: string
}

export class CloudflareGatewayClient {
  constructor(private readonly token: string, private readonly fetcher: typeof fetch = fetch) {}

  async syncCustomProvider(input: GatewaySyncRequest): Promise<GatewaySyncResult> {
    const providerSlug = slugify(input.providerName)
    const provider = await this.request<{ id: string; slug?: string }>(input.accountId, '/ai-gateway/custom-providers', 'POST', {
      name: input.providerName,
      slug: providerSlug,
      base_url: originOnly(input.workerUrl),
      description: 'Codeflare Inference Mesh OpenAI-compatible router',
      enable: true
    })
    const route = await this.request<{ id: string }>(input.accountId, `/ai-gateway/gateways/${input.gatewayId}/routes`, 'POST', {
      name: input.routeName,
      enabled: true
    })
    const version = await this.request<{ id: string; version_id?: string }>(input.accountId, `/ai-gateway/gateways/${input.gatewayId}/routes/${route.id}/versions`, 'POST', {
      elements: routeGraph(`custom-${provider.slug ?? providerSlug}`, 'mesh-default')
    })
    const routeVersionId = version.version_id ?? version.id
    const deployment = await this.request<{ id: string; deployment_id?: string }>(input.accountId, `/ai-gateway/gateways/${input.gatewayId}/routes/${route.id}/deployments`, 'POST', {
      version_id: routeVersionId
    })
    return {
      providerId: provider.id,
      routeId: route.id,
      routeVersionId,
      deploymentId: deployment.deployment_id ?? deployment.id,
      manualProviderKeyRequired: true,
      providerTokenInstructions: input.providerTokenInstructions
    }
  }

  private async request<T>(accountId: string, path: string, method: string, body: unknown): Promise<T> {
    const response = await this.fetcher(`https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(body)
    })
    const payload = await response.json() as ApiEnvelope<T>
    if (!response.ok || payload.success === false) {
      throw new Error(`Cloudflare API failed: ${response.status}`)
    }
    return payload.result
  }
}

interface ApiEnvelope<T> {
  readonly success: boolean
  readonly result: T
}

function originOnly(workerUrl: string): string {
  const url = new URL(workerUrl)
  if (url.protocol !== 'https:') throw new Error('Cloudflare custom providers require https base_url')
  return url.origin
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'codeflare-inference-mesh'
}

function routeGraph(provider: string, model: string) {
  return [
    { id: 'start', type: 'start', outputs: { next: { elementId: 'model' } } },
    {
      id: 'model',
      type: 'model',
      properties: { provider, model, retries: 1, timeout: 120000 },
      outputs: { success: { elementId: 'end' }, fallback: { elementId: 'end' } }
    },
    { id: 'end', type: 'end', outputs: {} }
  ]
}

export const CLOUDFLARE_API_ANCHORS = {
  REQ_GWY_003: 'REQ-GWY-003',
  REQ_ADM_005: 'REQ-ADM-005'
} as const
