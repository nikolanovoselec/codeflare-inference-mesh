import { describe, expect, it } from 'vitest'
import { DEFAULT_MODEL_PROFILES } from './profiles'
import { StoreScheduler } from './scheduler'
import { measureSpeedStream, runSpeedTest } from './speed-test'
import { MemoryStore, nodeFixture } from './test-helpers'
import type { LastSpeedTestSummary } from './types'

function sseChunk(text: string): Uint8Array {
  return new TextEncoder().encode(`data: {"choices":[{"delta":{"content":${JSON.stringify(text)}}}]}\n\n`)
}

describe('speed test stream measurement', () => {
  it('REQ-ADM-034 returns a bounded partial measurement when the upstream stops sending', async () => {
    // The case a between-chunks check cannot catch: one chunk arrives, then the upstream goes
    // quiet without closing, so the next read never resolves. The deadline has to race it.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(sseChunk('hello'))
        // deliberately never closed
      }
    })

    const measured = await measureSpeedStream(stream, Date.now(), 128, 50, 1_000_000)

    expect(measured.chunks).toBe(1)
    expect(measured.outputChars).toBe(5)
    // Bounded by the 50ms budget, not merely by the test runner giving up.
    expect(measured.timingsMs.total).toBeLessThan(500)
    // Marked, so the caller does not store a partial read as a completed measurement.
    expect(measured.timedOut).toBe(true)
  })

  it('REQ-ADM-034 stops reading once the output cap is exceeded', async () => {
    let enqueued = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        enqueued += 1
        controller.enqueue(sseChunk('x'.repeat(50)))
      }
    })

    const measured = await measureSpeedStream(stream, Date.now(), 128, 60_000, 200)

    expect(measured.outputChars).toBeGreaterThan(200)
    // A 200-char cap at 50 chars per chunk implies about five reads, not an endless drain.
    expect(enqueued).toBeLessThan(10)
    // The ceiling is not a timeout: this run stopped on size, so it stays storable.
    expect(measured.timedOut).toBe(false)
  })

  it('REQ-ADM-034 does not store a timed-out run even for a persisting caller', async () => {
    // The composition the flag tests above cannot reach: measureSpeedStream setting timedOut
    // is one half, the persist guard reading it is the other. This drives both through
    // runSpeedTest, so dropping or inverting `!measured.timedOut` fails here.
    const store = new MemoryStore()
    await store.seedDefaultProfiles(DEFAULT_MODEL_PROFILES)
    await store.upsertNode(nodeFixture())
    const prior: LastSpeedTestSummary = { at: 1_600_000_000_000, requestId: 'earlier', model: 'codeflare-mesh', requestedPromptTokens: 2048, requestedMaxTokens: 160, promptTokens: 2048, completionTokens: 80, promptTokensEstimated: false, completionTokensEstimated: false, promptTokensPerSecond: 1800.5, generationTokensPerSecond: 67.2, timeToFirstTokenMs: 900, generationMs: 1200, totalMs: 2100 }
    await store.putConfig('last_speed_tests', { 'mesh-smoke-qwen25-1.5b': prior })

    // Sends one chunk and then goes quiet without closing, so the deadline is what ends it.
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(sseChunk('partial')) }
    })
    const mesh = {
      fetch: async () => new Response(stalled, { headers: { 'content-type': 'text/event-stream' } }),
      connect() { throw new Error('connect is not used by speed-test forwarding') }
    } as Fetcher
    const deps = { store, scheduler: new StoreScheduler(store), mesh, env: { NODE_UPSTREAM_TOKEN: 'upstream-secret' } }

    const response = await runSpeedTest(deps, { model: 'codeflare-mesh', promptTokens: 64, maxTokens: 16 }, new Headers(), 'request-a', 1_700_000_000_000, true, 50)
    const measured = await response.json() as { timedOut: boolean }

    expect(response.status).toBe(200)
    // The caller is told what happened...
    expect(measured.timedOut).toBe(true)
    // ...and the shared record every mesh card reads is untouched, despite persist being true.
    expect(await store.getConfig<Record<string, LastSpeedTestSummary>>('last_speed_tests')).toEqual({ 'mesh-smoke-qwen25-1.5b': prior })
  })
})
