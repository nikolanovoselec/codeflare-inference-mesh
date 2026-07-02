export interface GatewaySyncRequest {
  readonly accountId: string
  readonly gatewayId: string
  readonly workerUrl: string
  readonly providerName: string
  readonly routeName: string
  readonly publicModel: string
  readonly providerTokenInstructions: string
}

export interface GatewaySyncResult {
  readonly providerId: string
  readonly providerSlug: string
  readonly routeId: string
  readonly routeVersionId: string
  readonly deploymentId: string
  readonly gatewayId: string
  readonly routeName: string
  readonly publicModel: string
  readonly workerUrl: string
  readonly manualProviderKeyRequired: true
  readonly providerTokenInstructions: string
}

export interface CustomDomainProvisionRequest {
  readonly accountId: string
  readonly hostname: string
  readonly workerName: string
  readonly workerUrl: string
  readonly zoneId?: string
}

export interface CustomDomainProvisionResult {
  readonly hostname: string
  readonly zoneId: string
  readonly zoneName: string
  readonly dnsRecordId: string
  readonly dnsRecordType: 'A' | 'CNAME'
  readonly routeId: string
  readonly routePattern: string
  readonly workerName: string
  readonly status: 'provisioned'
}

interface ProviderRecord { readonly id: string; readonly slug?: string; readonly name?: string; readonly base_url?: string }
interface RouteRecord { readonly id: string; readonly name?: string; readonly enabled?: boolean }
interface VersionRecord { readonly id?: string; readonly version_id?: string; readonly data?: unknown; readonly elements?: unknown }
interface DeploymentRecord { readonly id?: string; readonly deployment_id?: string; readonly version_id?: string }
interface ZoneRecord { readonly id: string; readonly name: string }
interface DnsRecord { readonly id: string; readonly type: 'A' | 'CNAME'; readonly name: string; readonly content: string; readonly proxied?: boolean }
interface WorkerRouteRecord { readonly id: string; readonly pattern: string; readonly script?: string }

export class CloudflareGatewayClient {
  constructor(private readonly token: string, private readonly fetcher: typeof fetch = fetch) {}

  async provisionCustomDomain(input: CustomDomainProvisionRequest): Promise<CustomDomainProvisionResult> {
    const zone = await this.resolveZone(input.hostname, input.zoneId)
    const dns = await this.upsertDnsRecord(zone, input.hostname, input.workerUrl)
    const routePattern = `${input.hostname}/*`
    const route = await this.upsertWorkerRoute(zone.id, routePattern, input.workerName)
    return {
      hostname: input.hostname,
      zoneId: zone.id,
      zoneName: zone.name,
      dnsRecordId: dns.id,
      dnsRecordType: dns.type,
      routeId: route.id,
      routePattern,
      workerName: input.workerName,
      status: 'provisioned'
    }
  }

  async syncCustomProvider(input: GatewaySyncRequest): Promise<GatewaySyncResult> {
    const providerSlug = slugify(`${input.providerName}-${new URL(originOnly(input.workerUrl)).hostname}`)
    const providerBody = {
      name: input.providerName,
      slug: providerSlug,
      base_url: originOnly(input.workerUrl),
      description: 'Codeflare Inference Mesh OpenAI-compatible router',
      enable: true
    }
    const provider = await this.findBySlug(await this.listProviders(input.accountId), providerSlug)
      ?? await this.accountRequest<ProviderRecord>(input.accountId, '/ai-gateway/custom-providers', 'POST', providerBody)

    const route = await this.upsertGatewayRoute(input.accountId, input.gatewayId, input.routeName)
    const elements = routeGraph(`custom-${provider.slug ?? providerSlug}`, input.publicModel)
    const version = await this.findMatchingVersion(input.accountId, input.gatewayId, route.id, elements)
      ?? await this.accountRequest<VersionRecord>(input.accountId, `/ai-gateway/gateways/${input.gatewayId}/routes/${route.id}/versions`, 'POST', { elements })
    const routeVersionId = version.version_id ?? version.id ?? ''
    const deployment = await this.findDeployment(input.accountId, input.gatewayId, route.id, routeVersionId)
      ?? await this.accountRequest<DeploymentRecord>(input.accountId, `/ai-gateway/gateways/${input.gatewayId}/routes/${route.id}/deployments`, 'POST', { version_id: routeVersionId })
    return {
      providerId: provider.id,
      providerSlug: provider.slug ?? providerSlug,
      routeId: route.id,
      routeVersionId,
      deploymentId: deployment.deployment_id ?? deployment.id ?? '',
      gatewayId: input.gatewayId,
      routeName: input.routeName,
      publicModel: input.publicModel,
      workerUrl: originOnly(input.workerUrl),
      manualProviderKeyRequired: true,
      providerTokenInstructions: input.providerTokenInstructions
    }
  }

  private async listProviders(accountId: string): Promise<readonly ProviderRecord[]> {
    return listFrom(await this.accountRequest<unknown>(accountId, '/ai-gateway/custom-providers', 'GET'), 'providers')
  }

  private async upsertGatewayRoute(accountId: string, gatewayId: string, routeName: string): Promise<RouteRecord> {
    const routes = listFrom<RouteRecord>(await this.accountRequest<unknown>(accountId, `/ai-gateway/gateways/${gatewayId}/routes`, 'GET'), 'routes')
    const existing = routes.find((route) => route.name === routeName)
    if (!existing) return await this.accountRequest<RouteRecord>(accountId, `/ai-gateway/gateways/${gatewayId}/routes`, 'POST', { name: routeName, enabled: true })
    if (existing.enabled === false) return await this.accountRequest<RouteRecord>(accountId, `/ai-gateway/gateways/${gatewayId}/routes/${existing.id}`, 'PATCH', { name: routeName, enabled: true })
    return existing
  }

  private async findMatchingVersion(accountId: string, gatewayId: string, routeId: string, elements: unknown): Promise<VersionRecord | undefined> {
    const versions = listFrom<VersionRecord>(await this.accountRequest<unknown>(accountId, `/ai-gateway/gateways/${gatewayId}/routes/${routeId}/versions`, 'GET'), 'versions')
    const wanted = stableJson(elements)
    return versions.find((version) => stableJson(version.elements ?? (version.data as { elements?: unknown } | undefined)?.elements ?? version.data) === wanted)
  }

  private async findDeployment(accountId: string, gatewayId: string, routeId: string, versionId: string): Promise<DeploymentRecord | undefined> {
    const deployments = listFrom<DeploymentRecord>(await this.accountRequest<unknown>(accountId, `/ai-gateway/gateways/${gatewayId}/routes/${routeId}/deployments`, 'GET'), 'deployments')
    return deployments.find((deployment) => deployment.version_id === versionId)
  }

  private findBySlug(records: readonly ProviderRecord[], slug: string): ProviderRecord | undefined {
    return records.find((record) => record.slug === slug)
  }

  private async resolveZone(hostname: string, zoneId?: string): Promise<ZoneRecord> {
    if (zoneId) return await this.globalRequest<ZoneRecord>(`/zones/${zoneId}`, 'GET')
    const labels = hostname.split('.')
    for (let index = 0; index < labels.length - 1; index += 1) {
      const name = labels.slice(index).join('.')
      const zones = listFrom<ZoneRecord>(await this.globalRequest<unknown>(`/zones?name=${encodeURIComponent(name)}`, 'GET'), 'zones')
      const zone = zones.find((item) => hostname === item.name || hostname.endsWith(`.${item.name}`))
      if (zone) return zone
    }
    throw new Error(`Cloudflare zone not found for ${hostname}`)
  }

  private async upsertDnsRecord(zone: ZoneRecord, hostname: string, workerUrl: string): Promise<DnsRecord> {
    const existing = listFrom<DnsRecord>(await this.globalRequest<unknown>(`/zones/${zone.id}/dns_records?name=${encodeURIComponent(hostname)}`, 'GET'), 'dns_records')[0]
    const record = dnsRecordBody(zone, hostname, workerUrl)
    if (!existing) return await this.globalRequest<DnsRecord>(`/zones/${zone.id}/dns_records`, 'POST', record)
    if (existing.type === record.type && existing.content === record.content && existing.proxied === true) return existing
    return await this.globalRequest<DnsRecord>(`/zones/${zone.id}/dns_records/${existing.id}`, 'PUT', record)
  }

  private async upsertWorkerRoute(zoneId: string, pattern: string, workerName: string): Promise<WorkerRouteRecord> {
    const routes = listFrom<WorkerRouteRecord>(await this.globalRequest<unknown>(`/zones/${zoneId}/workers/routes`, 'GET'), 'routes')
    const existing = routes.find((route) => route.pattern === pattern)
    const body = { pattern, script: workerName }
    if (!existing) return await this.globalRequest<WorkerRouteRecord>(`/zones/${zoneId}/workers/routes`, 'POST', body)
    if (existing.script === workerName) return existing
    return await this.globalRequest<WorkerRouteRecord>(`/zones/${zoneId}/workers/routes/${existing.id}`, 'PUT', body)
  }

  private async accountRequest<T>(accountId: string, path: string, method: string, body?: unknown): Promise<T> {
    return await this.apiRequest<T>(`https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`, method, body)
  }

  private async globalRequest<T>(path: string, method: string, body?: unknown): Promise<T> {
    return await this.apiRequest<T>(`https://api.cloudflare.com/client/v4${path}`, method, body)
  }

  private async apiRequest<T>(url: string, method: string, body?: unknown): Promise<T> {
    const response = await this.fetcher(url, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {})
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    })
    const payload = await response.json() as ApiEnvelope<T>
    if (!response.ok || payload.success === false) throw new Error(`Cloudflare API failed: ${response.status}`)
    return payload.result
  }
}

interface ApiEnvelope<T> {
  readonly success: boolean
  readonly result: T
}

function dnsRecordBody(zone: ZoneRecord, hostname: string, workerUrl: string): { type: 'A' | 'CNAME'; name: string; content: string; proxied: true; ttl: 1 } {
  if (hostname === zone.name) return { type: 'A', name: hostname, content: '192.0.2.0', proxied: true, ttl: 1 }
  return { type: 'CNAME', name: hostname, content: new URL(originOnly(workerUrl)).hostname, proxied: true, ttl: 1 }
}

function listFrom<T>(value: unknown, key: string): readonly T[] {
  if (Array.isArray(value)) return value as readonly T[]
  if (!value || typeof value !== 'object') return []
  const record = value as Record<string, unknown>
  if (Array.isArray(record[key])) return record[key] as readonly T[]
  const data = record.data
  if (data && typeof data === 'object') {
    const dataRecord = data as Record<string, unknown>
    if (Array.isArray(dataRecord[key])) return dataRecord[key] as readonly T[]
  }
  if (Array.isArray(record.result)) return record.result as readonly T[]
  return []
}

function originOnly(workerUrl: string): string {
  const url = new URL(workerUrl)
  if (url.protocol !== 'https:') throw new Error('Cloudflare custom providers require https base_url')
  return url.origin
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'codeflare-inference-mesh'
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value))
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (!value || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, sortJson(record[key])]))
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
