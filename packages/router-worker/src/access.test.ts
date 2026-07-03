import { beforeEach, describe, expect, it } from 'vitest'
import {
  JWKS_CACHE_TTL_MS,
  JWKS_REFRESH_MIN_AGE_MS,
  extractAccessJwt,
  resetJwksCache,
  verifyAccessRequest,
  type AccessConfig
} from './access'

const NOW = 1_800_000_000_000
const TEAM_DOMAIN = 'example-team.cloudflareaccess.com'
const AUDIENCE = 'aud-abc123'
const CONFIG: AccessConfig = { teamDomain: TEAM_DOMAIN, audience: AUDIENCE }

interface SigningKey {
  readonly privateKey: CryptoKey
  readonly jwk: JsonWebKey & { kid: string }
}

async function generateSigningKey(kid: string): Promise<SigningKey> {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify']
  ) as CryptoKeyPair
  const exported = await crypto.subtle.exportKey('jwk', pair.publicKey) as JsonWebKey
  return { privateKey: pair.privateKey, jwk: { ...exported, kid } }
}

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function encodeSegment(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)))
}

async function signJwt(key: SigningKey, payload: Record<string, unknown>, header?: Record<string, unknown>): Promise<string> {
  const signingInput = `${encodeSegment({ alg: 'RS256', kid: key.jwk.kid, ...header })}.${encodeSegment(payload)}`
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key.privateKey, new TextEncoder().encode(signingInput))
  return `${signingInput}.${base64Url(new Uint8Array(signature))}`
}

function validPayload(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    aud: [AUDIENCE],
    iss: `https://${TEAM_DOMAIN}`,
    email: 'operator@example.com',
    iat: Math.floor(NOW / 1000) - 60,
    exp: Math.floor(NOW / 1000) + 3600,
    ...overrides
  }
}

function jwksFetcher(keys: readonly JsonWebKey[], calls: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = new Request(input).url
    calls.push(url)
    return Response.json({ keys })
  }) as typeof fetch
}

function headerRequest(jwt: string): Request {
  return new Request('https://mesh.example.com/admin/status', { headers: { 'cf-access-jwt-assertion': jwt } })
}

describe('access JWT verification contracts', () => {
  beforeEach(() => {
    resetJwksCache()
  })

  it('REQ-SEC-009 verifies a valid Access JWT from the assertion header and reports the email', async () => {
    const key = await generateSigningKey('key-1')
    const jwt = await signJwt(key, validPayload())
    const verdict = await verifyAccessRequest(headerRequest(jwt), CONFIG, NOW, jwksFetcher([key.jwk]))
    expect(verdict).toEqual({ outcome: 'verified', email: 'operator@example.com' })
  })

  it('REQ-SEC-009 accepts the Access JWT from the CF_Authorization cookie when the header is absent', async () => {
    const key = await generateSigningKey('key-1')
    const jwt = await signJwt(key, validPayload())
    const request = new Request('https://mesh.example.com/admin/status', {
      headers: { cookie: `other=1; CF_Authorization=${jwt}; theme=dark` }
    })
    expect(extractAccessJwt(request)).toBe(jwt)
    const verdict = await verifyAccessRequest(request, CONFIG, NOW, jwksFetcher([key.jwk]))
    expect(verdict).toEqual({ outcome: 'verified', email: 'operator@example.com' })
  })

  it('REQ-SEC-009 rejects a JWT whose audience does not include the configured audience', async () => {
    const key = await generateSigningKey('key-1')
    const jwt = await signJwt(key, validPayload({ aud: ['other-aud'] }))
    const verdict = await verifyAccessRequest(headerRequest(jwt), CONFIG, NOW, jwksFetcher([key.jwk]))
    expect(verdict).toEqual({ outcome: 'invalid' })
  })

  it('REQ-SEC-009 rejects a JWT issued by a different team domain', async () => {
    const key = await generateSigningKey('key-1')
    const jwt = await signJwt(key, validPayload({ iss: 'https://attacker.cloudflareaccess.com' }))
    const verdict = await verifyAccessRequest(headerRequest(jwt), CONFIG, NOW, jwksFetcher([key.jwk]))
    expect(verdict).toEqual({ outcome: 'invalid' })
  })

  it('REQ-SEC-009 rejects expired and not-yet-valid JWTs', async () => {
    const key = await generateSigningKey('key-1')
    const expired = await signJwt(key, validPayload({ exp: Math.floor(NOW / 1000) - 10 }))
    expect(await verifyAccessRequest(headerRequest(expired), CONFIG, NOW, jwksFetcher([key.jwk]))).toEqual({ outcome: 'invalid' })
    const future = await signJwt(key, validPayload({ nbf: Math.floor(NOW / 1000) + 600 }))
    expect(await verifyAccessRequest(headerRequest(future), CONFIG, NOW, jwksFetcher([key.jwk]))).toEqual({ outcome: 'invalid' })
  })

  it('REQ-SEC-009 rejects a JWT signed by a key outside the published set', async () => {
    const trusted = await generateSigningKey('key-1')
    const rogue = await generateSigningKey('key-1')
    const jwt = await signJwt(rogue, validPayload())
    const verdict = await verifyAccessRequest(headerRequest(jwt), CONFIG, NOW, jwksFetcher([trusted.jwk]))
    expect(verdict).toEqual({ outcome: 'invalid' })
  })

  it('REQ-SEC-009 distinguishes a present-but-invalid JWT from an absent one', async () => {
    const key = await generateSigningKey('key-1')
    const absent = await verifyAccessRequest(new Request('https://mesh.example.com/admin/status'), CONFIG, NOW, jwksFetcher([key.jwk]))
    expect(absent).toEqual({ outcome: 'absent' })
    const garbled = await verifyAccessRequest(headerRequest('not-a-jwt'), CONFIG, NOW, jwksFetcher([key.jwk]))
    expect(garbled).toEqual({ outcome: 'invalid' })
  })

  it('REQ-SEC-009 caches the published keys between verifications instead of fetching per request', async () => {
    const key = await generateSigningKey('key-1')
    const calls: string[] = []
    const fetcher = jwksFetcher([key.jwk], calls)
    const jwt = await signJwt(key, validPayload())
    await verifyAccessRequest(headerRequest(jwt), CONFIG, NOW, fetcher)
    await verifyAccessRequest(headerRequest(jwt), CONFIG, NOW + 1000, fetcher)
    expect(calls).toEqual([`https://${TEAM_DOMAIN}/cdn-cgi/access/certs`])
  })

  it('REQ-SEC-009 refetches the published keys on an unknown key id once the cache is stale enough', async () => {
    const oldKey = await generateSigningKey('key-old')
    const newKey = await generateSigningKey('key-new')
    const calls: string[] = []
    let served: readonly JsonWebKey[] = [oldKey.jwk]
    const fetcher = (async (input: RequestInfo | URL) => {
      calls.push(new Request(input).url)
      return Response.json({ keys: served })
    }) as typeof fetch
    const oldJwt = await signJwt(oldKey, validPayload())
    expect(await verifyAccessRequest(headerRequest(oldJwt), CONFIG, NOW, fetcher)).toEqual({ outcome: 'verified', email: 'operator@example.com' })

    served = [oldKey.jwk, newKey.jwk]
    const newJwt = await signJwt(newKey, validPayload({ iat: Math.floor(NOW / 1000) }))
    const beforeThreshold = await verifyAccessRequest(headerRequest(newJwt), CONFIG, NOW + JWKS_REFRESH_MIN_AGE_MS - 1000, fetcher)
    expect(beforeThreshold).toEqual({ outcome: 'invalid' })
    expect(calls).toHaveLength(1)

    const afterThreshold = await verifyAccessRequest(headerRequest(newJwt), CONFIG, NOW + JWKS_REFRESH_MIN_AGE_MS + 1000, fetcher)
    expect(afterThreshold).toEqual({ outcome: 'verified', email: 'operator@example.com' })
    expect(calls).toHaveLength(2)
  })

  it('REQ-SEC-009 expires the key cache after its TTL', async () => {
    const key = await generateSigningKey('key-1')
    const calls: string[] = []
    const fetcher = jwksFetcher([key.jwk], calls)
    const jwt = await signJwt(key, validPayload())
    await verifyAccessRequest(headerRequest(jwt), CONFIG, NOW, fetcher)
    const later = await signJwt(key, validPayload({ exp: Math.floor((NOW + JWKS_CACHE_TTL_MS) / 1000) + 3600 }))
    await verifyAccessRequest(headerRequest(later), CONFIG, NOW + JWKS_CACHE_TTL_MS + 1000, fetcher)
    expect(calls).toHaveLength(2)
  })
})
