import { describe, expect, it } from 'vitest'
import { classifyRoute, isRateLimited, rateKey, type RateBucket } from './rate-limit'

function req(headers: Record<string, string> = {}): Request {
  return new Request('https://router.test/', { headers })
}

describe('rate-limit classification', () => {
  it('REQ-SEC-011 maps each public endpoint to its bucket, defaulting unlisted routes to public', () => {
    const cases: Array<[string, boolean, RateBucket]> = [
      // Inference splits by credential: the AI Gateway carries a token, anonymous hits do not.
      ['/v1/chat/completions', true, 'inference'],
      ['/v1/chat/completions', false, 'public'],
      ['/v1/models', true, 'inference'],
      ['/v1/models', false, 'public'],
      ['/node/heartbeat', true, 'heartbeat'],
      ['/node/claim', false, 'enroll'],
      ['/node/unregister', false, 'enroll'],
      ['/admin/login', false, 'auth'],
      ['/admin/setup', false, 'auth'],
      ['/admin/recovery/reset', false, 'auth'],
      ['/admin/setup-tokens', false, 'auth'],
      ['/health', false, 'public'],
      ['/install.sh', false, 'public'],
      ['/admin/status', false, 'public']
    ]
    for (const [path, hasBearer, bucket] of cases) expect(classifyRoute(path, hasBearer), path).toBe(bucket)
  })

  it('REQ-SEC-011 keys authenticated buckets by a hashed token and unauthenticated buckets by IP', async () => {
    const withToken = req({ authorization: 'Bearer node-secret', 'cf-connecting-ip': '9.9.9.9' })
    const key = await rateKey('inference', withToken)
    // The raw secret never appears in the key material; the token is hashed.
    expect(key.startsWith('tok:')).toBe(true)
    expect(key).not.toContain('node-secret')
    // Deterministic and IP-independent for token buckets: same token → same key.
    expect(await rateKey('inference', req({ authorization: 'Bearer node-secret', 'cf-connecting-ip': '1.1.1.1' }))).toBe(key)
    // Different token → different bucket key.
    expect(await rateKey('inference', req({ authorization: 'Bearer other' }))).not.toBe(key)
    // IP-keyed buckets ignore the token.
    expect(await rateKey('enroll', withToken)).toBe('ip:9.9.9.9')
    expect(await rateKey('auth', withToken)).toBe('ip:9.9.9.9')
    expect(await rateKey('public', withToken)).toBe('ip:9.9.9.9')
    // Token buckets fall back to IP when there is no bearer token.
    expect(await rateKey('inference', req({ 'cf-connecting-ip': '1.2.3.4' }))).toBe('ip:1.2.3.4')
  })
})

describe('rate-limit enforcement', () => {
  it('REQ-SEC-011 fails open when no binding is configured', async () => {
    expect(await isRateLimited(req({ authorization: 'Bearer x' }), '/v1/chat/completions', {})).toBe(false)
  })

  it('REQ-SEC-011 blocks with a hashed token key when the limiter reports the limit exceeded', async () => {
    const calls: string[] = []
    const limiter = { limit: async (input: { key: string }) => { calls.push(input.key); return { success: false } } }
    const limited = await isRateLimited(req({ authorization: 'Bearer prov-x' }), '/v1/models', { RL_INFERENCE: limiter })
    expect(limited).toBe(true)
    expect(calls[0]!.startsWith('tok:')).toBe(true)
    expect(calls[0]).not.toContain('prov-x')
  })

  it('REQ-SEC-011 sends the AI Gateway to the high inference bucket and anonymous inference to the low public bucket', async () => {
    const inference: string[] = []
    const publicCalls: string[] = []
    const env = {
      RL_INFERENCE: { limit: async (input: { key: string }) => { inference.push(input.key); return { success: true } } },
      RL_PUBLIC: { limit: async (input: { key: string }) => { publicCalls.push(input.key); return { success: true } } }
    }
    await isRateLimited(req({ authorization: 'Bearer gateway-token' }), '/v1/chat/completions', env)
    await isRateLimited(req({ 'cf-connecting-ip': '2.2.2.2' }), '/v1/chat/completions', env)
    // Credentialed inference (the gateway) is metered on RL_INFERENCE; anonymous inference on RL_PUBLIC.
    expect(inference).toHaveLength(1)
    expect(inference[0]!.startsWith('tok:')).toBe(true)
    expect(publicCalls).toEqual(['ip:2.2.2.2'])
  })

  it('REQ-SEC-011 allows under the limit and fails open on a limiter fault', async () => {
    const ok = { limit: async () => ({ success: true }) }
    expect(await isRateLimited(req({ 'cf-connecting-ip': '5.5.5.5' }), '/node/claim', { RL_ENROLL: ok })).toBe(false)
    const faulty = { limit: async () => { throw new Error('limiter down') } }
    expect(await isRateLimited(req({ authorization: 'Bearer n' }), '/node/heartbeat', { RL_HEARTBEAT: faulty })).toBe(false)
  })
})
