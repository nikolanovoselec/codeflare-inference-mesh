/** Provisioning and inspecting the AI Gateway custom provider that fronts this router. */
import { cleanString, json, readOptionalObject } from '../http'
import { CloudflareGatewayClient, type GatewaySyncResult } from '../cloudflare-api'
import { createTokenRecord, generateBearerToken } from '../auth'
import { listMeshes, meshAliasFor } from '../meshes'
import type { RouterDeps } from '../deps'
import type { RouterEnv, StoredCustomDomain } from '../types'
import { STABLE_PUBLIC_MODEL } from '../profiles'
import { usableWorkerBaseUrl } from '../worker-origin'

export async function syncGatewayForActor(request: Request, deps: RouterDeps, requestId: string, now: number, actor: string): Promise<Response> {
  const body = await readOptionalObject<Partial<GatewaySettings>>(request)
  const storedSettings = await deps.store.getConfig<Partial<GatewaySettings>>('cloudflare_gateway_settings')
  const customDomain = await deps.store.getConfig<StoredCustomDomain>('custom_domain')
  const settings = gatewaySettings({
    env: deps.env,
    ...(body ? { body } : {}),
    ...(storedSettings ? { stored: storedSettings } : {})
  })
  const bodyWorkerUrl = cleanString(body?.workerUrl)
  const storedWorkerUrl = cleanString(storedSettings?.workerUrl)
  const storedWorkerUrlOverride = storedWorkerUrl && storedWorkerUrl !== usableWorkerBaseUrl(deps.env.WORKER_BASE_URL) ? storedWorkerUrl : undefined
  const workerUrlOverride = bodyWorkerUrl ?? storedWorkerUrlOverride
  const customDomainUrl = customDomain?.status === 'provisioned' ? `https://${customDomain.hostname}` : undefined
  const workerUrl = workerUrlOverride ?? customDomainUrl
  const token = deps.env.CLOUDFLARE_API_TOKEN_RUNTIME
  if (customDomain?.hostname && customDomain.status !== 'provisioned' && !workerUrlOverride) return json({ error: 'custom_domain_not_provisioned', hostname: customDomain.hostname }, 409, requestId)
  if (!workerUrl) return json({ error: 'custom_domain_required' }, 409, requestId)
  if (!settings.accountId || !settings.gatewayId || (!token && !deps.cloudflareClient)) return json({ error: 'cloudflare_runtime_config_missing' }, 503, requestId)
  const client = deps.cloudflareClient ?? new CloudflareGatewayClient(token!)
  let result: GatewaySyncResult
  try {
    // Every non-default machine group gets its own dynamic route named by its stable
    // alias, so clients reach that mesh's active model through the same gateway (REQ-GWY-009).
    const extraRoutes = (await listMeshes(deps.store))
      .filter((mesh) => mesh.id !== 'default')
      .map((mesh) => ({ routeName: meshAliasFor(mesh.id), publicModel: meshAliasFor(mesh.id) }))
    result = await client.syncCustomProvider({
      accountId: settings.accountId,
      gatewayId: settings.gatewayId,
      workerUrl,
      providerName: settings.providerName,
      routeName: settings.routeName,
      publicModel: settings.publicModel,
      ...(extraRoutes.length > 0 ? { extraRoutes } : {}),
      providerTokenInstructions: 'Paste the router provider token into the AI Gateway provider key field.'
    })
  } catch (error) {
    // Cloudflare rejected the sync (bad token, missing gateway, route conflict). The raw
    // cause goes to the audit for support; the operator gets an actionable, sanitized message.
    // A 4xx keeps the client from collapsing it to the generic 5xx "temporary error, retry".
    const reason = error instanceof Error ? error.message : String(error)
    await deps.store.appendAudit({ id: requestId, type: 'gateway_sync_failed', at: now, actor, detail: { reason } })
    return json({ error: 'The AI Gateway sync could not be completed. Confirm the gateway exists and the router Cloudflare token has AI Gateway access, then re-sync.' }, 424, requestId)
  }
  await deps.store.putConfig('cloudflare_gateway_settings', {
    accountId: settings.accountId,
    gatewayId: settings.gatewayId,
    providerName: settings.providerName,
    routeName: settings.routeName,
    publicModel: settings.publicModel,
    ...(workerUrlOverride ? { workerUrl: workerUrlOverride } : {})
  })
  await deps.store.putConfig('cloudflare_gateway', result)
  // The provider key surfaces here, where the operator uses it: it authenticates
  // the AI Gateway custom provider (BYOK). Minting rotates it — a re-sync issues a
  // fresh key and retires prior ones so only the latest key is live.
  const providerToken = generateBearerToken('provider')
  const priorProviders = await deps.store.listTokens('provider')
  await Promise.all(priorProviders.filter((token) => token.active).map((token) => deps.store.revokeToken('provider', token.id, now)))
  await deps.store.putToken(await createTokenRecord('provider', providerToken, now))
  await deps.store.appendAudit({ id: requestId, type: 'gateway_sync', at: now, actor, detail: { ...result } })
  return json({ ...result, providerToken, byokInstruction: `Paste this key into the AI Gateway provider "${result.providerSlug}".` }, 200, requestId)
}

export interface GatewaySettings {
  readonly accountId: string
  readonly gatewayId: string
  readonly providerName: string
  readonly routeName: string
  readonly publicModel: string
  readonly workerUrl?: string
}

export function gatewaySettings(input: { env: Partial<RouterEnv>; body?: Partial<GatewaySettings>; stored?: Partial<GatewaySettings> }): GatewaySettings {
  const source = { ...input.stored, ...input.body }
  return {
    accountId: cleanString(source.accountId) ?? input.env.CLOUDFLARE_ACCOUNT_ID ?? input.env.AI_GATEWAY_ACCOUNT_ID ?? '',
    gatewayId: cleanString(source.gatewayId) ?? input.env.AI_GATEWAY_ID ?? 'inference-mesh',
    providerName: cleanString(source.providerName) ?? input.env.AI_GATEWAY_PROVIDER_NAME ?? 'Codeflare Inference Mesh',
    // The route name and forwarded model are pinned to the one stable public model:
    // switching the underlying active model never touches the Gateway route or model.
    routeName: STABLE_PUBLIC_MODEL,
    publicModel: STABLE_PUBLIC_MODEL,
    ...(cleanString(source.workerUrl) ? { workerUrl: cleanString(source.workerUrl)! } : {})
  }
}

export async function handleGatewayOptions(deps: RouterDeps, url: URL, requestId: string): Promise<Response> {
  const storedSettings = await deps.store.getConfig<Partial<GatewaySettings>>('cloudflare_gateway_settings')
  const defaults = gatewaySettings({ env: deps.env, ...(storedSettings ? { stored: storedSettings } : {}) })
  const accountId = defaults.accountId
  const token = deps.env.CLOUDFLARE_API_TOKEN_RUNTIME
  if (!accountId || (!token && !deps.cloudflareClient?.listGateways)) return json({ error: 'cloudflare_runtime_config_missing' }, 503, requestId)
  const client = deps.cloudflareClient ?? new CloudflareGatewayClient(token!)
  if (!client.listGateways || !client.listRoutes) return json({ error: 'cloudflare_runtime_config_missing' }, 503, requestId)
  const gateways = await client.listGateways(accountId)
  const selectedGateway = cleanString(url.searchParams.get('gateway')) ?? defaults.gatewayId
  const routes = gateways.some((gateway) => gateway.id === selectedGateway) ? await client.listRoutes(accountId, selectedGateway) : []
  return json({ gateways, routes, defaults }, 200, requestId)
}

// Live-verify whether the *selected* gateway carries the mesh route + canonical provider,
// so the Routing chip reflects that gateway's true state rather than the last-synced one.
export async function handleGatewayProvisionStatus(deps: RouterDeps, url: URL, requestId: string): Promise<Response> {
  const storedSettings = await deps.store.getConfig<Partial<GatewaySettings>>('cloudflare_gateway_settings')
  const defaults = gatewaySettings({ env: deps.env, ...(storedSettings ? { stored: storedSettings } : {}) })
  const accountId = defaults.accountId
  const gatewayId = cleanString(url.searchParams.get('gateway')) ?? defaults.gatewayId
  const token = deps.env.CLOUDFLARE_API_TOKEN_RUNTIME
  if (!accountId || (!token && !deps.cloudflareClient?.provisionStatus)) return json({ error: 'cloudflare_runtime_config_missing' }, 503, requestId)
  const client = deps.cloudflareClient ?? new CloudflareGatewayClient(token!)
  if (!client.provisionStatus) return json({ error: 'cloudflare_runtime_config_missing' }, 503, requestId)
  const status = await client.provisionStatus(accountId, gatewayId, defaults.routeName, defaults.providerName)
  return json({ gatewayId, ...status }, 200, requestId)
}
