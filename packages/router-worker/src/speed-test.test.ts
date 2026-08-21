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
    // Bounded by the deadline, not by the caller giving up.
    expect(measured.timingsMs.total).toBeLessThan(5_000)
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
    // It stops near the cap rather than draining an endless producer.
    expect(enqueued).toBeLessThan(20)
  })
})
