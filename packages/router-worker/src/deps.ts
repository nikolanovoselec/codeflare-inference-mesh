/**
 * Everything the router needs from its environment, in one place.
 *
 * This lives apart from `router.ts` so every handler module can name it without
 * importing the router itself, which would make the dependency graph a cycle.
 */
import type { RouterEnv, Scheduler, Store } from './types'
import { type AccessProvisionRequest, type AccessProvisionResult } from './access-provisioning'
import { type CustomDomainProvisionRequest, type CustomDomainProvisionResult, type GatewayProvisionStatus, type GatewayRecord, type GatewaySyncRequest, type GatewaySyncResult, type RouteRecord, type ZoneRecord } from './cloudflare-api'

export interface RouterDeps {
  readonly store: Store
  readonly scheduler: Scheduler
  readonly mesh: Fetcher
  readonly env: Partial<RouterEnv>
  readonly now?: () => number
  readonly requestId?: () => string
  readonly cloudflareClient?: {
    syncCustomProvider(input: GatewaySyncRequest): Promise<GatewaySyncResult>
    provisionCustomDomain(input: CustomDomainProvisionRequest): Promise<CustomDomainProvisionResult>
    listZones?(accountId: string): Promise<readonly ZoneRecord[]>
    listGateways?(accountId: string): Promise<readonly GatewayRecord[]>
    listRoutes?(accountId: string, gatewayId: string): Promise<readonly RouteRecord[]>
    provisionStatus?(accountId: string, gatewayId: string, routeName: string, providerName: string): Promise<GatewayProvisionStatus>
  }
  readonly accessClient?: { provisionAccess(input: AccessProvisionRequest): Promise<AccessProvisionResult> }
  readonly jwksFetcher?: typeof fetch
  readonly releasesFetcher?: typeof fetch
  readonly playgroundFetcher?: typeof fetch
  readonly identityFetcher?: typeof fetch
}
