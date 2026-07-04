import type { RateLimiter, RouterEnv } from './types'

/**
 * Rate-limit buckets. Each maps to a distinct Cloudflare [[ratelimits]] binding with its own
 * namespace and limit, so a flood on one class of endpoint cannot exhaust another's budget.
 */
export type RateBucket = 'inference' | 'heartbeat' | 'enroll' | 'auth' | 'public'

const BUCKET_BINDING: Record<RateBucket, keyof RouterEnv> = {
  inference: 'RL_INFERENCE',
  heartbeat: 'RL_HEARTBEAT',
  enroll: 'RL_ENROLL',
  auth: 'RL_AUTH',
  public: 'RL_PUBLIC'
}

/** Buckets keyed by the caller's bearer credential; every other bucket keys by client IP. */
const TOKEN_KEYED: ReadonlySet<RateBucket> = new Set<RateBucket>(['inference', 'heartbeat'])

function bearerToken(request: Request): string | undefined {
  const auth = request.headers.get('authorization')
  return auth && auth.toLowerCase().startsWith('bearer ') ? auth.slice(7) : undefined
}

/**
 * Classify a request into a rate-limit bucket. Inference is split by credential: the AI Gateway
 * forwards `/v1` traffic carrying the provider token from a shared Cloudflare IP, so only
 * token-carrying inference reaches the high `inference` bucket; token-less `/v1` hits are anonymous
 * abuse (they fail auth anyway) and fall to the low `public` bucket. Unlisted routes also default
 * to `public`, so no endpoint is left unprotected.
 */
export function classifyRoute(pathname: string, hasBearer: boolean): RateBucket {
  if (pathname === '/v1/chat/completions' || pathname === '/v1/models') return hasBearer ? 'inference' : 'public'
  if (pathname === '/node/heartbeat') return 'heartbeat'
  if (pathname === '/node/claim' || pathname === '/node/unregister') return 'enroll'
  if (pathname === '/admin/login' || pathname === '/admin/setup' || pathname === '/admin/recovery/reset' || pathname === '/admin/setup-tokens') return 'auth'
  return 'public'
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 32)
}

/**
 * Key a request within its bucket. Token-keyed buckets key by a hash of the caller's bearer
 * credential (never the raw secret) so one caller's flood cannot spend another's budget;
 * unauthenticated buckets key by client IP — the only stable signal before a credential exists.
 */
export async function rateKey(bucket: RateBucket, request: Request): Promise<string> {
  if (TOKEN_KEYED.has(bucket)) {
    const token = bearerToken(request)
    if (token) return 'tok:' + await sha256Hex(token)
  }
  return 'ip:' + (request.headers.get('cf-connecting-ip') || 'unknown')
}

/**
 * True when the request is over its bucket's limit. Fails open when the binding is absent
 * (unit tests, or a misconfigured deploy) or the limiter itself faults, so a limiter outage
 * never takes the whole router down — availability over strictness for a self-hosted control plane.
 */
export async function isRateLimited(request: Request, pathname: string, env: Partial<RouterEnv>): Promise<boolean> {
  const bucket = classifyRoute(pathname, bearerToken(request) !== undefined)
  const limiter = env[BUCKET_BINDING[bucket]] as RateLimiter | undefined
  if (!limiter) return false
  try {
    const { success } = await limiter.limit({ key: await rateKey(bucket, request) })
    return !success
  } catch {
    return false
  }
}
