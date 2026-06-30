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
    const provider = await this.request<{ id: string }>(input.accountId, `/ai-gateway/gateways/${input.gatewayId}/custom-providers`, 'POST', {
      name: input.providerName,
      endpoint: `${input.workerUrl.replace(/\/$/, '')}/v1/chat/completions`,
      api_format: 'openai-chat-completions'
    })
    const route = await this.request<{ id: string }>(input.accountId, `/ai-gateway/gateways/${input.gatewayId}/routes`, 'POST', {
      name: input.routeName,
      enabled: true,
      strategy: 'dynamic'
    })
    const version = await this.request<{ id: string }>(input.accountId, `/ai-gateway/gateways/${input.gatewayId}/routes/${route.id}/versions`, 'POST', {
      providers: [{ id: provider.id, weight: 1 }]
    })
    const deployment = await this.request<{ id: string }>(input.accountId, `/ai-gateway/gateways/${input.gatewayId}/routes/${route.id}/deployments`, 'POST', {
      version_id: version.id
    })
    return {
      providerId: provider.id,
      routeId: route.id,
      routeVersionId: version.id,
      deploymentId: deployment.id,
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

export const CLOUDFLARE_API_ANCHORS = {
  REQ_GWY_003: 'REQ-GWY-003',
  REQ_ADM_005: 'REQ-ADM-005'
} as const
