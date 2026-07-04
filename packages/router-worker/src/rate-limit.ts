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

/**
 * Classify a request into a rate-limit bucket by path. Every route resolves to a bucket:
 * unlisted routes fall back to the generous `public` bucket, so no endpoint is left unprotected.
 */
export function classifyRoute(pathname: string): RateBucket {
  if (pathname === '/v1/chat/completions' || pathname === '/v1/models') return 'inference'
  if (pathname === '/node/heartbeat') return 'heartbeat'
  if (pathname === '/node/claim' || pathname === '/node/unregister') return 'enroll'
  if (pathname === '/admin/login' || pathname === '/admin/setup' || pathname === '/admin/recovery/reset' || pathname === '/admin/setup-tokens') return 'auth'
  return 'public'
}

/**
 * Key a request within its bucket. Authenticated buckets key by bearer token so one caller's
 * flood cannot spend another's budget; unauthenticated buckets key by client IP — the only
 * stable signal before a credential exists, and the correct anti-brute-force axis.
 */
export function rateKey(bucket: RateBucket, request: Request): string {
  if (TOKEN_KEYED.has(bucket)) {
    const auth = request.headers.get('authorization')
    if (auth && auth.toLowerCase().startsWith('bearer ')) return 'tok:' + auth.slice(7)
  }
  return 'ip:' + (request.headers.get('cf-connecting-ip') || 'unknown')
}

/**
 * True when the request is over its bucket's limit. Fails open when the binding is absent
 * (unit tests, or a misconfigured deploy) or the limiter itself faults, so a limiter outage
 * never takes the whole router down — availability over strictness for a self-hosted control plane.
 */
export async function isRateLimited(request: Request, pathname: string, env: Partial<RouterEnv>): Promise<boolean> {
  const bucket = classifyRoute(pathname)
  const limiter = env[BUCKET_BINDING[bucket]] as RateLimiter | undefined
  if (!limiter) return false
  try {
    const { success } = await limiter.limit({ key: rateKey(bucket, request) })
    return !success
  } catch {
    return false
  }
}
