/** First-run setup, console sign-in, Access configuration, and the agent installers. */
import { ACCESS_CONFIG_KEY, SETUP_REOPEN_CONSUMED_KEY, advancePhase, breakGlassActive, setupPhase } from '../setup-state'
import { bearerToken, createTokenRecord, generateBearerToken, hashToken, verifyPlainOrHashed } from '../auth'
import { CloudflareAccessClient } from '../access-provisioning'
import { CloudflareGatewayClient } from '../cloudflare-api'
import { installerCommand, installScript, SETUP_TOKEN_PLACEHOLDER, validateCustomDomain, type InstallerPlatform } from '../installers'
import { json, readJson } from '../http'
import { publicWorkerOrigin } from '../worker-origin'
import type { RouterDeps } from '../deps'
import type { StoredCustomDomain } from '../types'
import { type AdminUiState } from '../admin-ui'
import { type ConsoleRole } from '../auth-gates'

export const SETUP_TOKEN_TTL_MS = 24 * 60 * 60 * 1000

/** Entry state for the shell: wizard until setup completes, dashboard afterwards. */
export async function adminUiState(deps: RouterDeps, recovery: boolean): Promise<AdminUiState> {
  const phase = await setupPhase(deps.store)
  const domain = await deps.store.getConfig<StoredCustomDomain>('custom_domain')
  return {
    view: phase === 'complete' && !recovery ? 'dashboard' : 'setup',
    phase,
    ...(domain?.status === 'provisioned' ? { customDomain: domain.hostname } : {}),
    recovery
  }
}

// The bootstrapOrAdmin gate has already decided whether this caller may claim: open while no
// active admin token exists, admin-only once one does.
export async function handleFirstSetup(deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  // Claim mints ONLY the bootstrap token. The machine credentials surface where
  // they are used: the provider token in the gateway-sync result, the setup token
  // inside the install command, and the upstream token lazily at node claim.
  const adminToken = generateBearerToken('admin')
  await deps.store.putToken(await createTokenRecord('admin', adminToken, now))
  await deps.store.putConfig('setup_state', { phase: 'claimed', claimedAt: now })
  await deps.store.appendAudit({ id: requestId, type: 'first_setup', at: now, actor: 'setup', detail: {} })
  return json({ adminToken }, 201, requestId)
}

export async function handleAdminRecovery(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  const recoveryToken = deps.env.ADMIN_RECOVERY_TOKEN
  if (!recoveryToken || !(await verifyPlainOrHashed(recoveryToken, bearerToken(request)))) return json({ error: 'unauthorized' }, 401, requestId)
  const existingAdmins = await deps.store.listTokens('admin')
  await Promise.all(existingAdmins.filter((token) => token.active).map((token) => deps.store.revokeToken('admin', token.id, now)))
  const adminToken = generateBearerToken('admin')
  await deps.store.putToken(await createTokenRecord('admin', adminToken, now))
  await deps.store.appendAudit({ id: requestId, type: 'admin_recovery_reset', at: now, actor: 'recovery', detail: { revoked: existingAdmins.filter((token) => token.active).length } })
  return json({ adminToken }, 201, requestId)
}

export async function handleAdminLogin(requestId: string): Promise<Response> {
  return json({ ok: true, session: 'bearer-token' }, 200, requestId)
}

export async function handleSetupToken(deps: RouterDeps, requestId: string, now: number, actor: string): Promise<Response> {
  const setupToken = generateBearerToken('setup')
  await deps.store.putToken(await createTokenRecord('setup', setupToken, now, undefined, now + SETUP_TOKEN_TTL_MS))
  await deps.store.appendAudit({ id: requestId, type: 'setup_token_created', at: now, actor, detail: {} })
  return json({ setupToken, expiresAt: now + SETUP_TOKEN_TTL_MS }, 201, requestId)
}

async function handleInstaller(request: Request, deps: RouterDeps, url: URL, requestId: string): Promise<Response> {
  const platform = url.pathname.split('/').at(-1) as InstallerPlatform
  if (!['linux', 'macos', 'windows'].includes(platform)) return json({ error: 'unknown_platform' }, 404, requestId)
  const domain = await deps.store.getConfig<StoredCustomDomain>('custom_domain')
  const workerUrl = domain?.status === 'provisioned' ? `https://${domain.hostname}` : publicWorkerOrigin(deps.env.WORKER_BASE_URL, request.url)
  // Do not mint on GET: viewing the command must not create an orphan setup token. The command
  // carries a placeholder; the operator mints once via "Create setup token" and the client fills it.
  const command = installerCommand({ platform, workerUrl, setupToken: SETUP_TOKEN_PLACEHOLDER, repository: deps.env.GITHUB_REPOSITORY ?? 'nikolanovoselec/codeflare-inference-mesh' })
  return new Response(command, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8', 'x-inference-mesh-request-id': requestId } })
}

export function handleInstallScript(deps: RouterDeps, platform: InstallerPlatform): Response {
  const repository = deps.env.GITHUB_REPOSITORY ?? 'nikolanovoselec/codeflare-inference-mesh'
  const releaseTag = deps.env.AGENT_RELEASE_TAG ?? 'latest'
  const contentType = platform === 'windows' ? 'text/plain; charset=utf-8' : 'text/x-shellscript; charset=utf-8'
  return new Response(installScript({ platform, repository, releaseTag }), { status: 200, headers: { 'content-type': contentType } })
}

export async function handleCustomDomain(request: Request, deps: RouterDeps, requestId: string, now: number, advance: boolean, actor: string): Promise<Response> {
  const body = await readJson<{ hostname: string; zoneId?: string }>(request)
  const hostname = typeof body?.hostname === 'string' ? body.hostname.trim().toLowerCase() : ''
  const zoneId = typeof body?.zoneId === 'string' ? body.zoneId.trim() : ''
  const zoneValid = zoneId === '' || /^[a-f0-9]{32}$/i.test(zoneId)
  const valid = Boolean(hostname && validateCustomDomain(hostname) && zoneValid)
  if (!valid) return json({ valid: false, hostname: body?.hostname }, 400, requestId)
  const accountId = deps.env.CLOUDFLARE_ACCOUNT_ID ?? deps.env.AI_GATEWAY_ACCOUNT_ID
  const workerName = deps.env.WORKER_NAME ?? 'codeflare-inference-mesh-router'
  const workerUrl = publicWorkerOrigin(deps.env.WORKER_BASE_URL, request.url)
  const token = deps.env.CLOUDFLARE_API_TOKEN_RUNTIME
  if (!accountId || !workerUrl || (!token && !deps.cloudflareClient)) return json({ error: 'cloudflare_runtime_config_missing' }, 503, requestId)
  const client = deps.cloudflareClient ?? new CloudflareGatewayClient(token!)
  const provisioned = await client.provisionCustomDomain({ accountId, hostname, workerName, workerUrl, ...(zoneId ? { zoneId } : {}) }).catch((error: unknown) => {
    if (String(error).includes('DNS record conflict')) return undefined
    throw error
  })
  if (!provisioned) return json({ error: 'dns_record_conflict', hostname }, 409, requestId)
  await deps.store.putConfig('custom_domain', provisioned)
  if (advance) await advancePhase(deps.store, 'domain_ready')
  await deps.store.appendAudit({ id: requestId, type: 'custom_domain_provisioned', at: now, actor, target: hostname, detail: { ...provisioned } })
  return json({ valid: true, ...provisioned }, 200, requestId)
}

/** REQ-ADM-017: lets the console render the admin vs read-only user surface. */
export async function handleWhoami(requestId: string, actor: string, role: ConsoleRole): Promise<Response> {
  return json({ role: role, actor: actor }, 200, requestId)
}

/**
 * Linear email-shape check (no regex backtracking): rejects whitespace, requires
 * exactly one '@' not in first position, and a dotted domain with characters on
 * both sides of the dot. Replaces an ambiguous regex flagged as polynomial ReDoS.
 */
function isEmailLike(value: string): boolean {
  if (/\s/.test(value)) return false
  const at = value.indexOf('@')
  if (at <= 0 || at !== value.lastIndexOf('@')) return false
  const domain = value.slice(at + 1)
  const dot = domain.indexOf('.')
  return dot > 0 && dot < domain.length - 1
}

function normalizeEmailList(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === 'string').map((item) => item.trim().toLowerCase()).filter(isEmailLike))]
    : []
}

function normalizeGroupList(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter((item) => item.length > 0))]
    : []
}

export async function handleSetupAccess(request: Request, deps: RouterDeps, requestId: string, now: number, actor: string): Promise<Response> {
  const body = await readJson<{ adminEmails?: unknown; adminGroups?: unknown; userEmails?: unknown; userGroups?: unknown; emails?: unknown }>(request)
  const adminEmails = normalizeEmailList(body?.adminEmails ?? body?.emails)
  const adminGroups = normalizeGroupList(body?.adminGroups)
  const userEmails = normalizeEmailList(body?.userEmails)
  const userGroups = normalizeGroupList(body?.userGroups)
  if (adminEmails.length === 0 && adminGroups.length === 0) return json({ error: 'admin_required', requestId }, 400, requestId)
  const domain = await deps.store.getConfig<StoredCustomDomain>('custom_domain')
  if (domain?.status !== 'provisioned') return json({ error: 'custom_domain_required', requestId }, 409, requestId)
  const accountId = deps.env.CLOUDFLARE_ACCOUNT_ID ?? deps.env.AI_GATEWAY_ACCOUNT_ID
  const workerName = deps.env.WORKER_NAME ?? 'codeflare-inference-mesh-router'
  const token = deps.env.CLOUDFLARE_API_TOKEN_RUNTIME
  if (!accountId || (!token && !deps.accessClient)) return json({ error: 'cloudflare_runtime_config_missing' }, 503, requestId)
  const client = deps.accessClient ?? new CloudflareAccessClient(token!)
  const result = await client.provisionAccess({ accountId, hostname: domain.hostname, workerName, adminEmails, adminGroups, userEmails, userGroups })
  await deps.store.putConfig(ACCESS_CONFIG_KEY, result)
  // Advancing only pre-completion keeps day-two role edits from resetting the phase.
  if ((await setupPhase(deps.store)) !== 'complete') await advancePhase(deps.store, 'access_ready')
  await deps.store.appendAudit({ id: requestId, type: 'access_provisioned', at: now, actor, target: domain.hostname, detail: { adminEmails, adminGroups, userEmails, userGroups, usersOpen: result.usersOpen, appId: result.appId, bypassAppId: result.bypassAppId } })
  return json({ ok: true, teamDomain: result.teamDomain, hostname: domain.hostname, consoleUrl: `https://${domain.hostname}/admin`, usersOpen: result.usersOpen }, 200, requestId)
}

export async function handleSetupComplete(deps: RouterDeps, requestId: string, now: number, actor: string): Promise<Response> {
  const phase = await setupPhase(deps.store)
  if (phase !== 'access_ready' && phase !== 'complete') return json({ error: 'setup_incomplete', phase, requestId }, 409, requestId)
  await advancePhase(deps.store, 'complete', { completedAt: now })
  if (deps.env.SETUP_REOPEN && await breakGlassActive(deps.store, deps.env)) {
    await deps.store.putConfig(SETUP_REOPEN_CONSUMED_KEY, await hashToken(deps.env.SETUP_REOPEN))
    await deps.store.appendAudit({ id: requestId, type: 'break_glass_completed', at: now, actor, detail: {} })
  }
  await deps.store.appendAudit({ id: requestId, type: 'setup_completed', at: now, actor, detail: {} })
  const domain = await deps.store.getConfig<StoredCustomDomain>('custom_domain')
  return json({ ok: true, ...(domain?.hostname ? { customDomain: domain.hostname } : {}) }, 200, requestId)
}

export async function handleZones(deps: RouterDeps, requestId: string): Promise<Response> {
  const accountId = deps.env.CLOUDFLARE_ACCOUNT_ID ?? deps.env.AI_GATEWAY_ACCOUNT_ID
  const token = deps.env.CLOUDFLARE_API_TOKEN_RUNTIME
  if (!accountId || (!token && !deps.cloudflareClient?.listZones)) return json({ error: 'cloudflare_runtime_config_missing' }, 503, requestId)
  const client = deps.cloudflareClient ?? new CloudflareGatewayClient(token!)
  if (!client.listZones) return json({ error: 'cloudflare_runtime_config_missing' }, 503, requestId)
  return json({ zones: await client.listZones(accountId) }, 200, requestId)
}
