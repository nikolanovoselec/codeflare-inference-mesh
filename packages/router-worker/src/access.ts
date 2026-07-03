const ASSERTION_HEADER = 'cf-access-jwt-assertion'
const ACCESS_COOKIE = 'CF_Authorization'
const CLOCK_SKEW_SECONDS = 60

export const JWKS_CACHE_TTL_MS = 60 * 60 * 1000
export const JWKS_REFRESH_MIN_AGE_MS = 30 * 1000

export interface AccessConfig {
  readonly teamDomain: string
  readonly audience: string
}

export type AccessVerification =
  | { readonly outcome: 'verified'; readonly email: string }
  | { readonly outcome: 'invalid' }
  | { readonly outcome: 'absent' }

interface AccessJwk extends JsonWebKey {
  readonly kid?: string
}

interface JwksCacheEntry {
  readonly teamDomain: string
  readonly keys: readonly AccessJwk[]
  readonly fetchedAt: number
}

let jwksCache: JwksCacheEntry | null = null

export function resetJwksCache(): void {
  jwksCache = null
}

export function extractAccessJwt(request: Request): string | null {
  const header = request.headers.get(ASSERTION_HEADER)
  if (header) return header
  const cookies = request.headers.get('cookie')
  if (!cookies) return null
  for (const pair of cookies.split(';')) {
    const separator = pair.indexOf('=')
    if (separator < 0) continue
    if (pair.slice(0, separator).trim() === ACCESS_COOKIE) return pair.slice(separator + 1).trim()
  }
  return null
}

export async function verifyAccessRequest(
  request: Request,
  config: AccessConfig,
  now: number,
  fetcher: typeof fetch = fetch
): Promise<AccessVerification> {
  const jwt = extractAccessJwt(request)
  if (!jwt) return { outcome: 'absent' }
  const email = await verifyAccessJwt(jwt, config, now, fetcher)
  return email ? { outcome: 'verified', email } : { outcome: 'invalid' }
}

/**
 * REQ-SEC-010: resolve the caller's Cloudflare Access group memberships via a
 * live get-identity call, so group removal revokes a role on the next request.
 * Ported from codeflare's resolveUserAccessGroup, including the SSRF guard that
 * the team domain is a *.cloudflareaccess.com host before it is interpolated
 * into the outbound URL. Returns [] on any failure (fail-closed).
 */
export async function fetchIdentityGroups(request: Request, teamDomain: string, fetcher: typeof fetch = fetch): Promise<readonly string[]> {
  const token = extractAccessJwt(request)
  if (!token) return []
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/i.test(teamDomain)) return []
  try {
    const response = await fetcher(`https://${teamDomain}/cdn-cgi/access/get-identity`, {
      method: 'GET',
      headers: { cookie: `${ACCESS_COOKIE}=${token}` }
    })
    if (!response.ok) return []
    const identity = await response.json() as { groups?: unknown }
    const groups = Array.isArray(identity.groups) ? identity.groups : []
    return groups
      .map((group) => typeof group === 'string' ? group : group && typeof group === 'object' ? String((group as { name?: unknown; id?: unknown }).name ?? (group as { id?: unknown }).id ?? '') : '')
      .filter((name) => name.length > 0)
  } catch {
    return []
  }
}

async function verifyAccessJwt(jwt: string, config: AccessConfig, now: number, fetcher: typeof fetch): Promise<string | null> {
  const segments = jwt.split('.')
  if (segments.length !== 3) return null
  const header = decodeSegment(segments[0]!) as { alg?: string; kid?: string } | null
  const payload = decodeSegment(segments[1]!) as Record<string, unknown> | null
  if (!header || !payload || header.alg !== 'RS256') return null

  const jwk = await findKey(config.teamDomain, header.kid, now, fetcher)
  if (!jwk) return null
  const verified = await verifySignature(jwk, `${segments[0]}.${segments[1]}`, segments[2]!)
  if (!verified) return null

  return claimsValid(payload, config, now) ? String(payload.email) : null
}

function claimsValid(payload: Record<string, unknown>, config: AccessConfig, now: number): boolean {
  const nowSeconds = Math.floor(now / 1000)
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
  if (!audiences.includes(config.audience)) return false
  if (payload.iss !== `https://${config.teamDomain}`) return false
  if (typeof payload.exp !== 'number' || payload.exp <= nowSeconds) return false
  if (typeof payload.iat === 'number' && payload.iat > nowSeconds + CLOCK_SKEW_SECONDS) return false
  if (typeof payload.nbf === 'number' && payload.nbf > nowSeconds + CLOCK_SKEW_SECONDS) return false
  return typeof payload.email === 'string' && payload.email.length > 0
}

async function findKey(teamDomain: string, kid: string | undefined, now: number, fetcher: typeof fetch): Promise<AccessJwk | null> {
  const cached = await loadKeys(teamDomain, now, fetcher, false)
  const match = cached.find((key) => key.kid === kid)
  if (match) return match
  const refreshed = await loadKeys(teamDomain, now, fetcher, true)
  return refreshed.find((key) => key.kid === kid) ?? null
}

async function loadKeys(teamDomain: string, now: number, fetcher: typeof fetch, forceRefresh: boolean): Promise<readonly AccessJwk[]> {
  const cacheUsable = jwksCache !== null
    && jwksCache.teamDomain === teamDomain
    && now - jwksCache.fetchedAt < JWKS_CACHE_TTL_MS
    && (!forceRefresh || now - jwksCache.fetchedAt < JWKS_REFRESH_MIN_AGE_MS)
  if (cacheUsable && jwksCache) return jwksCache.keys
  const response = await fetcher(`https://${teamDomain}/cdn-cgi/access/certs`)
  if (!response.ok) return jwksCache?.teamDomain === teamDomain ? jwksCache.keys : []
  const body = await response.json() as { keys?: readonly AccessJwk[] }
  const keys = Array.isArray(body.keys) ? body.keys : []
  jwksCache = { teamDomain, keys, fetchedAt: now }
  return keys
}

async function verifySignature(jwk: AccessJwk, signingInput: string, signature: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify']
    )
    return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, base64UrlToBytes(signature), new TextEncoder().encode(signingInput))
  } catch {
    return false
  }
}

function decodeSegment(segment: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment)))
  } catch {
    return null
  }
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

export const ACCESS_ANCHORS = {
  REQ_SEC_009: 'REQ-SEC-009'
} as const
