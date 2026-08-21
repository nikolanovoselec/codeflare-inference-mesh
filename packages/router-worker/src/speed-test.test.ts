import { describe, expect, it } from 'vitest'
import { measureSpeedStream } from './speed-test'

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
})
