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
export interface GatewayRecord { readonly id: string; readonly authentication?: boolean }
export interface RouteRecord {
  readonly id: string
  readonly name?: string
  readonly enabled?: boolean
  readonly elements?: unknown
  readonly version?: { readonly version_id?: string }
  readonly deployment?: { readonly deployment_id?: string; readonly version_id?: string }
}
export interface ZoneRecord { readonly id: string; readonly name: string }
interface DnsRecord { readonly id: string; readonly type: string; readonly name: string; readonly content: string; readonly proxied?: boolean }
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
      dnsRecordType: dns.type as 'A' | 'CNAME',
      routeId: route.id,
      routePattern,
      workerName: input.workerName,
      status: 'provisioned'
    }
  }

  /** Gateways that exist on the account; drives selection in the admin UI. */
  async listGateways(accountId: string): Promise<readonly GatewayRecord[]> {
    return listFrom(await this.accountRequest<unknown>(accountId, '/ai-gateway/gateways', 'GET'), 'gateways')
  }

  /** Dynamic routes of one gateway; drives selection in the admin UI. */
  async listRoutes(accountId: string, gatewayId: string): Promise<readonly RouteRecord[]> {
    return listFrom(await this.accountRequest<unknown>(accountId, `/ai-gateway/gateways/${gatewayId}/routes`, 'GET'), 'routes')
  }

  /** Zones of the account; drives the domain-step selection in the admin UI. */
  async listZones(accountId: string): Promise<readonly ZoneRecord[]> {
    return listFrom(await this.globalRequest<unknown>(`/zones?account.id=${encodeURIComponent(accountId)}&per_page=50`, 'GET'), 'zones')
  }

  private async ensureGateway(accountId: string, gatewayId: string): Promise<void> {
    // authentication: true makes this an Authenticated Gateway. Without it the
    // gateway is open, and because it forwards using the stored BYOK provider key
    // any caller who knows the gateway URL reaches the router with valid
    // credentials attached. The gateway must therefore always be authenticated.
    const settings = {
      cache_invalidate_on_update: false,
      cache_ttl: 0,
      collect_logs: true,
      rate_limiting_interval: 0,
      rate_limiting_limit: 0,
      authentication: true
    }
    const existing = (await this.listGateways(accountId)).find((gateway) => gateway.id === gatewayId)
    if (!existing) {
      await this.accountRequest(accountId, '/ai-gateway/gateways', 'POST', { id: gatewayId, ...settings })
      return
    }
    // Reconcile a gateway created before authentication was enforced so it never
    // stays open; PUT requires the full settings body.
    if (existing.authentication !== true) {
      await this.accountRequest(accountId, `/ai-gateway/gateways/${gatewayId}`, 'PUT', settings)
    }
  }

  async syncCustomProvider(input: GatewaySyncRequest): Promise<GatewaySyncResult> {
    await this.ensureGateway(input.accountId, input.gatewayId)
    const providerSlug = slugify(`${input.providerName}-${new URL(originOnly(input.workerUrl)).hostname}`)
    const providerBody = {
      name: input.providerName,
      slug: providerSlug,
      base_url: originOnly(input.workerUrl),
      description: 'Codeflare Inference Mesh OpenAI-compatible router',
      enable: true
    }
    const provider = await this.upsertCustomProvider(input.accountId, providerSlug, providerBody)

    const elements = routeGraph(`custom-${provider.slug ?? providerSlug}`, input.publicModel)
    // The AI Gateway dynamic-routing API sets a route's elements inline on create/update and
    // produces the route's version and deployment in that same call, so there is no separate
    // version-create or deployment-create step; the route response carries both identifiers.
    const route = await this.upsertGatewayRoute(input.accountId, input.gatewayId, input.routeName, elements)
    return {
      providerId: provider.id,
      providerSlug: provider.slug ?? providerSlug,
      routeId: route.id,
      routeVersionId: route.version?.version_id ?? route.deployment?.version_id ?? '',
      deploymentId: route.deployment?.deployment_id ?? '',
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

  private async upsertCustomProvider(accountId: string, slug: string, body: { name: string; slug: string; base_url: string; description: string; enable: boolean }): Promise<ProviderRecord> {
    const existing = await this.findBySlug(await this.listProviders(accountId), slug)
    if (!existing) return await this.accountRequest<ProviderRecord>(accountId, '/ai-gateway/custom-providers', 'POST', body)
    if (existing.name === body.name && existing.base_url === body.base_url) return existing
    return await this.accountRequest<ProviderRecord>(accountId, `/ai-gateway/custom-providers/${existing.id}`, 'PATCH', body)
  }

  private async upsertGatewayRoute(accountId: string, gatewayId: string, routeName: string, elements: unknown): Promise<RouteRecord> {
    const routes = listFrom<RouteRecord>(await this.accountRequest<unknown>(accountId, `/ai-gateway/gateways/${gatewayId}/routes`, 'GET'), 'routes')
    const existing = routes.find((route) => route.name === routeName)
    // Send `enabled: true` so the route is live even if the create/update endpoint would
    // otherwise default a new route to disabled; the response's deployment confirms activation.
    const body = { name: routeName, enabled: true, elements }
    if (!existing) return await this.accountRequest<RouteRecord>(accountId, `/ai-gateway/gateways/${gatewayId}/routes`, 'POST', body)
    const current = await this.accountRequest<RouteRecord>(accountId, `/ai-gateway/gateways/${gatewayId}/routes/${existing.id}`, 'GET')
    // Reuse only when the route is already live with matching elements; a disabled route is
    // re-upserted so sync always leaves it serving, even if it was disabled out of band.
    if (current.enabled !== false && stableJson(current.elements) === stableJson(elements)) return current
    return await this.accountRequest<RouteRecord>(accountId, `/ai-gateway/gateways/${gatewayId}/routes/${existing.id}`, 'PATCH', body)
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
    const records = listFrom<DnsRecord>(await this.globalRequest<unknown>(`/zones/${zone.id}/dns_records?name=${encodeURIComponent(hostname)}`, 'GET'), 'dns_records')
    const record = dnsRecordBody(zone, hostname, workerUrl)
    const existing = records.find((item) => item.type === record.type && item.content === record.content && item.proxied === true)
    if (existing) return existing
    const conflicting = records.some((item) => item.type === 'A' || item.type === 'CNAME' || record.type === 'CNAME')
    if (conflicting) throw new Error(`DNS record conflict for ${hostname}`)
    return await this.globalRequest<DnsRecord>(`/zones/${zone.id}/dns_records`, 'POST', record)
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
    // Free-call the fetcher: invoking the global fetch as a method (this.fetcher(...)) throws
    // "illegal invocation" on Workers because fetch must keep its native receiver.
    const fetcher = this.fetcher
    const response = await fetcher(url, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {})
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    })
    const payload = await response.json() as ApiEnvelope<T>
    if (!response.ok || payload.success === false) throw new Error(`Cloudflare API failed: ${response.status}${formatCloudflareApiErrors(payload.errors)}`)
    return (payload.result ?? payload.route ?? payload.data) as T
  }
}

interface ApiEnvelope<T> {
  readonly success: boolean
  // AI Gateway's dynamic-routing endpoints break the usual `result` envelope: listing
  // routes returns `{ data: { routes: [...] } }` and PATCHing a route returns `{ route: {...} }`,
  // while every other endpoint (gateways, custom-providers, route create/get) uses `result`.
  // apiRequest unwraps whichever key is present so route reconciliation stays idempotent.
  readonly result?: T
  readonly route?: T
  readonly data?: T
  readonly errors?: readonly CloudflareApiError[]
}

export interface CloudflareApiError {
  readonly code?: number
  readonly message?: string
}

/** Render Cloudflare's `errors` array into a diagnosable suffix so a failed
 *  setup call surfaces the real cause (e.g. `400: 2003 model id ...`) in the
 *  audit log instead of an opaque status. Never contains secret material. */
export function formatCloudflareApiErrors(errors?: readonly CloudflareApiError[]): string {
  if (!Array.isArray(errors) || errors.length === 0) return ''
  const rendered = errors
    .map((error) => [error.code, error.message].filter((value) => value != null && value !== '').join(' '))
    .filter((value) => value !== '')
  return rendered.length === 0 ? '' : ': ' + rendered.join('; ')
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
