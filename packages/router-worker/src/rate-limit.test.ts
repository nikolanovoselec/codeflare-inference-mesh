import { describe, expect, it } from 'vitest'
import { classifyRoute, isRateLimited, rateKey, type RateBucket } from './rate-limit'

function req(headers: Record<string, string> = {}): Request {
  return new Request('https://router.test/', { headers })
}

describe('rate-limit classification', () => {
  it('REQ-SEC-011 maps each public endpoint to its bucket, defaulting unlisted routes to public', () => {
    const cases: Array<[string, RateBucket]> = [
      ['/v1/chat/completions', 'inference'],
      ['/v1/models', 'inference'],
      ['/node/heartbeat', 'heartbeat'],
      ['/node/claim', 'enroll'],
      ['/node/unregister', 'enroll'],
      ['/admin/login', 'auth'],
      ['/admin/setup', 'auth'],
      ['/admin/recovery/reset', 'auth'],
      ['/admin/setup-tokens', 'auth'],
      ['/health', 'public'],
      ['/install.sh', 'public'],
      ['/admin/status', 'public']
    ]
    for (const [path, bucket] of cases) expect(classifyRoute(path), path).toBe(bucket)
  })

  it('REQ-SEC-011 keys authenticated buckets by token and unauthenticated buckets by IP', () => {
    const withToken = req({ authorization: 'Bearer node-secret', 'cf-connecting-ip': '9.9.9.9' })
    // Token-keyed buckets isolate per caller credential.
    expect(rateKey('inference', withToken)).toBe('tok:node-secret')
    expect(rateKey('heartbeat', withToken)).toBe('tok:node-secret')
    // IP-keyed buckets ignore the token (anti-brute-force axis).
    expect(rateKey('enroll', withToken)).toBe('ip:9.9.9.9')
    expect(rateKey('auth', withToken)).toBe('ip:9.9.9.9')
    expect(rateKey('public', withToken)).toBe('ip:9.9.9.9')
    // Token-keyed buckets fall back to IP when there is no bearer token.
    expect(rateKey('inference', req({ 'cf-connecting-ip': '1.2.3.4' }))).toBe('ip:1.2.3.4')
  })
})

describe('rate-limit enforcement', () => {
  it('REQ-SEC-011 fails open when no binding is configured', async () => {
    expect(await isRateLimited(req(), '/v1/chat/completions', {})).toBe(false)
  })

  it('REQ-SEC-011 blocks with the bucket key when the limiter reports the limit exceeded', async () => {
    const calls: string[] = []
    const limiter = { limit: async (input: { key: string }) => { calls.push(input.key); return { success: false } } }
    const limited = await isRateLimited(req({ authorization: 'Bearer prov-x' }), '/v1/models', { RL_INFERENCE: limiter })
    expect(limited).toBe(true)
    expect(calls).toEqual(['tok:prov-x'])
  })

  it('REQ-SEC-011 allows under the limit and fails open on a limiter fault', async () => {
    const ok = { limit: async () => ({ success: true }) }
    expect(await isRateLimited(req({ 'cf-connecting-ip': '5.5.5.5' }), '/node/claim', { RL_ENROLL: ok })).toBe(false)
    const faulty = { limit: async () => { throw new Error('limiter down') } }
    expect(await isRateLimited(req(), '/node/heartbeat', { RL_HEARTBEAT: faulty })).toBe(false)
  })
})
