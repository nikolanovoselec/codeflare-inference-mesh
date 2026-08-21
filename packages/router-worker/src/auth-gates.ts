/**
 * The credential gates behind every route family, and the token checks they build on.
 *
 * `routes.ts` names which gate each route requires; this module implements them.
 * Keeping them together means the answer to "what does it take to call this?" lives
 * in two files rather than scattered across the first two lines of 76 handlers.
 */
import { accessJwtSource, extractAccessJwt, fetchIdentityGroups, verifyAccessRequest } from './access'
import { bearerToken, hashToken, verifyPlainOrHashed, verifyToken } from './auth'
import { accessConfig, breakGlassActive, setupPhase, SETUP_REOPEN_SEEN_KEY } from './setup-state'
import type { CredentialKind, RouterEnv, Store, StoredCustomDomain, TokenRecord } from './types'

/**
 * The slice of the router's dependencies the gates actually need. `RouterDeps`
 * satisfies this structurally, so callers pass their existing deps unchanged and
 * this module never imports the router.
 */
export interface AuthDeps {
  readonly store: Store
  readonly env: Partial<RouterEnv>
  readonly jwksFetcher?: typeof fetch
  readonly identityFetcher?: typeof fetch
}

export interface HostGate {
  readonly locked: boolean
  readonly hostname: string
  readonly recovery: boolean
}

/** REQ-ADM-014: after completion, only the custom domain serves the console and machine routes. */
export async function resolveHostGate(deps: AuthDeps, url: URL): Promise<HostGate> {
  const phase = await setupPhase(deps.store)
  if (phase !== 'complete') return { locked: false, hostname: '', recovery: false }
  const domain = await deps.store.getConfig<StoredCustomDomain>('custom_domain')
  if (domain?.status !== 'provisioned' || url.hostname === domain.hostname) return { locked: false, hostname: '', recovery: false }
  return { locked: true, hostname: domain.hostname, recovery: await breakGlassActive(deps.store, deps.env) }
}

/** REQ-ADM-013: audit recovery entry once per reopen-secret value. */
export async function recordBreakGlassEntry(deps: AuthDeps, requestId: string, now: number): Promise<void> {
  if (!deps.env.SETUP_REOPEN) return
  const digest = await hashToken(deps.env.SETUP_REOPEN)
  if ((await deps.store.getConfig<string>(SETUP_REOPEN_SEEN_KEY)) === digest) return
  await deps.store.putConfig(SETUP_REOPEN_SEEN_KEY, digest)
  await deps.store.appendAudit({ id: requestId, type: 'break_glass_entered', at: now, actor: 'recovery', detail: {} })
}

type ConsoleRole = 'admin' | 'user'

export interface RoleVerdict {
  readonly role: ConsoleRole
  readonly actor: string
}

/**
 * REQ-SEC-009 / REQ-SEC-010: resolve the caller's console role. During bootstrap
 * (no Access config) or break-glass the bearer bootstrap token is admin. Once
 * Access is configured, identity comes from the verified Access JWT plus a live
 * group lookup: an admin group/email match is admin (admin wins over user);
 * otherwise a user group/email match — or any verified identity when no user set
 * is configured — is a read-only user; anyone else is refused.
 */
async function resolveRole(request: Request, deps: AuthDeps, now: number): Promise<RoleVerdict | undefined> {
  const access = await accessConfig(deps.store)
  if (!access) {
    return (await authenticateKind(request, deps, 'admin', now, deps.env.ADMIN_TOKEN)) ? { role: 'admin', actor: 'admin' } : undefined
  }
  const verdict = await verifyAccessRequest(request, { teamDomain: access.teamDomain, audience: access.audience }, now, deps.jwksFetcher ?? fetch)
  if (verdict.outcome === 'absent' && await breakGlassActive(deps.store, deps.env)) {
    return (await authenticateKind(request, deps, 'admin', now, deps.env.ADMIN_TOKEN)) ? { role: 'admin', actor: 'admin' } : undefined
  }
  if (verdict.outcome !== 'verified') return undefined
  const email = verdict.email
  // Configured emails are lowercased at capture; match the JWT claim case-insensitively
  // so a mixed-case IdP email never locks out the admin it names.
  const emailKey = email.toLowerCase()
  const adminEmails = access.adminEmails ?? []
  const adminGroups = access.adminGroups ?? []
  const userEmails = access.userEmails ?? []
  const userGroups = access.userGroups ?? []
  const groups = await fetchIdentityGroups(request, access.teamDomain, deps.identityFetcher ?? deps.jwksFetcher ?? fetch)
  const inAny = (names: readonly string[]) => names.some((name) => groups.includes(name))
  if (adminEmails.includes(emailKey) || inAny(adminGroups)) return { role: 'admin', actor: email }
  const usersOpen = userEmails.length === 0 && userGroups.length === 0
  if (usersOpen || userEmails.includes(emailKey) || inAny(userGroups)) return { role: 'user', actor: email }
  return undefined
}

/** Admin-only gate: config writes require the admin role. */
export async function requireAdmin(request: Request, deps: AuthDeps, now: number): Promise<string | undefined> {
  if (isMutatingMethod(request.method) && usesAccessJwt(request) && !hasSameOriginSignal(request)) return undefined
  const verdict = await resolveRole(request, deps, now)
  return verdict?.role === 'admin' ? verdict.actor : undefined
}

/** Reader gate: any verified console role (admin or user) may read status + use the playground. */
export async function requireUser(request: Request, deps: AuthDeps, now: number): Promise<RoleVerdict | undefined> {
  if (isMutatingMethod(request.method) && usesAccessJwt(request) && !hasSameOriginSignal(request)) return undefined
  return await resolveRole(request, deps, now)
}

function usesAccessJwt(request: Request): boolean {
  return accessJwtSource(request) !== null
}

function isMutatingMethod(method: string): boolean {
  return !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())
}

function hasSameOriginSignal(request: Request): boolean {
  const requestOrigin = new URL(request.url).origin
  const origin = request.headers.get('origin')
  if (origin) return origin === requestOrigin
  const referer = request.headers.get('referer')
  if (referer) {
    try {
      return new URL(referer).origin === requestOrigin
    } catch {
      return false
    }
  }
  const fetchSite = request.headers.get('sec-fetch-site')
  return fetchSite === 'same-origin' || fetchSite === 'none'
}

/**
 * Machine gate for the `/api/v1` control plane. Authenticates a scoped, revocable
 * automation key presented as a bearer token — no Cloudflare Access session — so
 * fleet managers and MDM can orchestrate the mesh programmatically. Returns the
 * matched token record, or undefined when the key is missing, unknown, revoked, or expired.
 */
export async function requireAutomation(request: Request, deps: AuthDeps, now: number): Promise<TokenRecord | undefined> {
  return await authenticateAnyStoredToken(request, deps.store, 'automation', now)
}

export async function requireKeyAdmin(request: Request, deps: AuthDeps, now: number): Promise<string | undefined> {
  const actor = await requireAdmin(request, deps, now)
  if (actor) return actor
  if ((await accessConfig(deps.store)) && extractAccessJwt(request)) return undefined
  return (await authenticateKind(request, deps, 'admin', now, deps.env.ADMIN_TOKEN)) ? 'admin-api' : undefined
}

export async function authenticateKind(request: Request, deps: AuthDeps, kind: CredentialKind, now: number, envSecret?: string): Promise<boolean> {
  const presented = bearerToken(request)
  if (await verifyPlainOrHashed(envSecret, presented)) return true
  return Boolean(await authenticateAnyStoredToken(request, deps.store, kind, now))
}

export async function authenticateAnyStoredToken(request: Request, store: Store, kind: CredentialKind, now: number): Promise<TokenRecord | undefined> {
  const presented = bearerToken(request)
  const tokens = await store.listTokens(kind)
  for (const token of tokens) {
    if (await verifyToken(presented, token, now)) return token
  }
  return undefined
}

export async function authenticateTokenByNode(request: Request, store: Store, kind: CredentialKind, nodeId: string, now: number): Promise<TokenRecord | undefined> {
  const presented = bearerToken(request)
  const tokens = await store.listTokens(kind)
  for (const token of tokens) {
    if (token.nodeId === nodeId && await verifyToken(presented, token, now)) return token
  }
  return undefined
}

/** @specanchor Target for the spec and documentation source anchors; deliberately has no runtime importer. */
export const AUTH_GATES_ANCHORS = {
  REQ_RTR_001: 'REQ-RTR-001',
  REQ_SEC_001: 'REQ-SEC-001',
  REQ_SEC_009: 'REQ-SEC-009',
  REQ_SEC_010: 'REQ-SEC-010',
  REQ_ADM_013: 'REQ-ADM-013',
  REQ_ADM_014: 'REQ-ADM-014'
} as const
