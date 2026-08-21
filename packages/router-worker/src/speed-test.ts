/**
 * Operator speed test: issue one streamed chat request through the real forward
 * path, measure it, and store the result per resolved profile so each mesh card
 * shows its own latest measurement.
 *
 * Prefers the runtime's own reported timings and token counts, falling back to
 * wall-clock rates and a character estimate when the runtime reports neither.
 */
import { cleanString, json } from './http'
import { routablePublicModel, runInference, type InferenceDeps } from './inference'
import { STABLE_PUBLIC_MODEL } from './profiles'
import type { LastSpeedTestSummary, Store } from './types'

/** The slice of the router's dependencies the speed test uses. RouterDeps satisfies it. */
export type SpeedTestDeps = InferenceDeps

const LAST_SPEED_TEST_CONFIG_KEY = 'last_speed_test'
const LAST_SPEED_TESTS_CONFIG_KEY = 'last_speed_tests'
export interface SpeedTestBody {
  readonly model?: unknown
  readonly promptTokens?: unknown
  readonly maxTokens?: unknown
}
interface SpeedTestMeasurement {
  readonly timingsMs: { readonly timeToFirstToken: number; readonly generation: number; readonly total: number }
  readonly tokens: { readonly prompt: number; readonly completion: number; readonly promptEstimated: boolean; readonly completionEstimated: boolean }
  readonly throughput: { readonly promptTokensPerSecond: number; readonly generationTokensPerSecond: number }
  readonly chunks: number
  readonly outputChars: number
  readonly usage: Record<string, unknown> | null
  readonly upstreamTimings: Record<string, unknown> | null
  /** The budget ran out before the upstream finished. The numbers describe a partial read. */
  readonly timedOut: boolean
}
/**
 * `persist` is false for a read-only console viewer: the measurement still runs and is
 * returned to the caller, but it does not overwrite the stored per-profile record every
 * mesh card reads. A viewer may look; only an admin or an automation key may change what
 * everyone else sees.
 */
export async function runSpeedTest(deps: SpeedTestDeps, body: SpeedTestBody | undefined, requestHeaders: Headers, requestId: string, now: number, persist: boolean): Promise<Response> {
  const model = cleanString(body?.model) ?? STABLE_PUBLIC_MODEL
  const promptTokens = boundedInt(body?.promptTokens, 64, 8192, 2048)
  const maxTokens = boundedInt(body?.maxTokens, 16, 512, 160)
  const prompt = speedTestPrompt(promptTokens, requestId)
  const startedAt = Date.now()
  const upstream = await runInference(deps, {
    body: {
      model,
      user: `user:speed-test|session:${requestId}`,
      stream: true,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }]
    },
    requestHeaders,
    requestId,
    now
  })
  if (!upstream.ok || !upstream.body) {
    return new Response(upstream.body, { status: upstream.status, headers: upstream.headers })
  }
  const measured = await measureSpeedStream(upstream.body, startedAt, promptTokens)
  const nodeId = upstream.headers.get('x-inference-mesh-node') ?? upstream.headers.get('x-inference-mesh-session-node') ?? undefined
  const cacheTokens = timingNumber(measured.upstreamTimings ?? undefined, 'cache_n')
  const result = { model, ...(nodeId ? { nodeId } : {}), promptChars: prompt.length, requestedPromptTokens: promptTokens, requestedMaxTokens: maxTokens, ...(cacheTokens !== undefined ? { cacheTokens } : {}), ...measured }
  // Runs are stored per resolved profile id so each mesh card can show its own
  // profile's latest measurement — duplicated profiles share an upstreamModel, so
  // the id is the only collision-free key (a gateway-route run credits the profile
  // it resolved to).
  // A timed-out run is a partial read whose token counts are estimated from whatever arrived,
  // so it must not land on the mesh cards as though it were a completed measurement. The
  // caller still receives it, with timedOut set, so the operator can see what happened.
  if (persist && !measured.timedOut) {
    const speedProfile = await deps.store.getProfileByPublicModel(routablePublicModel(model))
    const priorSpeedTests = await deps.store.getConfig<Record<string, LastSpeedTestSummary>>(LAST_SPEED_TESTS_CONFIG_KEY) ?? {}
    await deps.store.putConfig(LAST_SPEED_TESTS_CONFIG_KEY, { ...priorSpeedTests, [speedProfile?.id ?? model]: speedTestSummary(result, now, requestId) })
  }
  return json(result, 200, requestId)
}
// The newest entry doubles as the single lastSpeedTest status field; a record stored
// before the per-model map existed surfaces as the seed entry.
export async function storedSpeedTests(store: Store): Promise<Record<string, LastSpeedTestSummary>> {
  const map = await store.getConfig<Record<string, LastSpeedTestSummary>>(LAST_SPEED_TESTS_CONFIG_KEY)
  if (map && Object.keys(map).length > 0) return map
  const legacy = await store.getConfig<LastSpeedTestSummary>(LAST_SPEED_TEST_CONFIG_KEY)
  if (!legacy) return {}
  // Re-key the pre-map record by its resolved profile id — the per-mesh card reads by
  // profile id — so an old single record still surfaces; fall back to the model string.
  const legacyProfile = await store.getProfileByPublicModel(routablePublicModel(legacy.model))
  return { [legacyProfile?.id ?? legacy.model]: legacy }
}
export function newestSpeedTest(map: Record<string, LastSpeedTestSummary>): LastSpeedTestSummary | undefined {
  return Object.values(map).reduce<LastSpeedTestSummary | undefined>((latest, entry) => !latest || entry.at > latest.at ? entry : latest, undefined)
}
function speedTestSummary(result: SpeedTestMeasurement & { readonly model: string; readonly nodeId?: string; readonly requestedPromptTokens: number; readonly requestedMaxTokens: number; readonly cacheTokens?: number }, now: number, requestId: string): LastSpeedTestSummary {
  return {
    at: now,
    requestId,
    model: result.model,
    ...(result.nodeId ? { nodeId: result.nodeId } : {}),
    requestedPromptTokens: result.requestedPromptTokens,
    requestedMaxTokens: result.requestedMaxTokens,
    promptTokens: result.tokens.prompt,
    completionTokens: result.tokens.completion,
    promptTokensEstimated: result.tokens.promptEstimated,
    completionTokensEstimated: result.tokens.completionEstimated,
    promptTokensPerSecond: result.throughput.promptTokensPerSecond,
    generationTokensPerSecond: result.throughput.generationTokensPerSecond,
    timeToFirstTokenMs: result.timingsMs.timeToFirstToken,
    generationMs: result.timingsMs.generation,
    totalMs: result.timingsMs.total,
    ...(result.cacheTokens !== undefined ? { cacheTokens: result.cacheTokens } : {})
  }
}
function boundedInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return fallback
  return Math.min(max, Math.max(min, value))
}
function speedTestPrompt(targetTokens: number, nonce: string): string {
  const unit = 'Measure inference speed with stable repeated technical text, preserving exact identifiers and dependency edges. '
  const approxChars = targetTokens * 4
  const prefix = `Speed test nonce ${nonce}. `
  return (prefix + unit.repeat(Math.max(1, Math.ceil(approxChars / unit.length)))).slice(0, approxChars) + '\nReturn a concise numbered list.'
}
/**
 * A speed test is bounded work, so the read is bounded too. Without a ceiling a node that
 * streams slowly, or never closes, pins the request until the platform subrequest timeout:
 * `maxTokens` caps generation upstream but nothing caps the wait here. On expiry the reader
 * is cancelled and the partial measurement is returned, which is still a useful answer.
 *
 * The deadline has to race the read, not sit above it. A silent upstream never returns from
 * `reader.read()`, so a check between chunks is unreachable in exactly the case it exists to
 * bound. The size cap is different: it can only be exceeded by a chunk that already arrived,
 * so checking it between reads is enough.
 */
const SPEED_TEST_DEADLINE_MS = 120_000
const SPEED_TEST_MAX_OUTPUT_CHARS = 2_000_000

type StreamChunk = ReadableStreamReadResult<Uint8Array> | 'deadline'

/**
 * Resolves with the next chunk, or `'deadline'` if the wait outlives the budget. The timer is
 * cleared when the read wins, so a normal stream does not leave one pending timer per chunk.
 */
function readWithinDeadline(reader: ReadableStreamDefaultReader<Uint8Array>, deadlineAt: number): Promise<StreamChunk> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<StreamChunk>((resolve) => {
    timer = setTimeout(() => resolve('deadline'), Math.max(0, deadlineAt - Date.now()))
  })
  return Promise.race<StreamChunk>([reader.read(), expiry]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

export async function measureSpeedStream(
  body: ReadableStream<Uint8Array>,
  startedAt: number,
  fallbackPromptTokens: number,
  deadlineMs: number = SPEED_TEST_DEADLINE_MS,
  maxOutputChars: number = SPEED_TEST_MAX_OUTPUT_CHARS
): Promise<SpeedTestMeasurement> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffered = ''
  let firstTokenAt = 0
  let completedAt = startedAt
  let outputChars = 0
  let chunks = 0
  let usage: Record<string, unknown> | undefined
  let upstreamTimings: Record<string, unknown> | undefined
  // Measured from startedAt, which is stamped before the upstream call, so the budget bounds
  // the whole request rather than restarting once the body arrives.
  const deadlineAt = startedAt + deadlineMs
  let timedOut = false
  while (true) {
    if (outputChars > maxOutputChars) {
      await reader.cancel().catch(() => undefined)
      completedAt = Date.now()
      break
    }
    const chunk = await readWithinDeadline(reader, deadlineAt)
    completedAt = Date.now()
    if (chunk === 'deadline') {
      timedOut = true
      await reader.cancel().catch(() => undefined)
      break
    }
    if (chunk.done) break
    buffered += decoder.decode(chunk.value, { stream: true })
    const lines = buffered.split('\n')
    buffered = lines.pop() ?? ''
    for (const raw of lines) {
      const line = raw.trim()
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (!data || data === '[DONE]') continue
      try {
        const parsed = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string; reasoning_content?: string } }>; usage?: Record<string, unknown>; timings?: Record<string, unknown> }
        if (parsed.usage) usage = parsed.usage
        if (parsed.timings) upstreamTimings = parsed.timings
        const content = parsed.choices?.map((choice) => choice.delta?.content ?? choice.delta?.reasoning_content ?? '').join('') ?? ''
        if (content) {
          if (firstTokenAt === 0) firstTokenAt = Date.now()
          chunks += 1
          outputChars += content.length
        }
      } catch {
        // Ignore keep-alives and non-OpenAI SSE lines.
      }
    }
  }
  const reportedPromptTokens = usageNumber(usage, 'prompt_tokens')
  const timingPromptTokens = timingNumber(upstreamTimings, 'prompt_n') ?? timingNumber(upstreamTimings, 'prompt_tokens')
  const promptTokens = reportedPromptTokens ?? timingPromptTokens ?? fallbackPromptTokens
  const reportedCompletionTokens = usageNumber(usage, 'completion_tokens')
  const timingCompletionTokens = timingNumber(upstreamTimings, 'predicted_n') ?? timingNumber(upstreamTimings, 'completion_tokens')
  const completionTokens = reportedCompletionTokens ?? timingCompletionTokens ?? Math.max(1, Math.round(outputChars / 4))
  const ttftMs = firstTokenAt > 0 ? firstTokenAt - startedAt : completedAt - startedAt
  const generationMs = firstTokenAt > 0 ? Math.max(1, completedAt - firstTokenAt) : Math.max(1, completedAt - startedAt)
  const promptTps = timingNumber(upstreamTimings, 'prompt_per_second') ?? rateFromTiming(promptTokens, timingNumber(upstreamTimings, 'prompt_ms')) ?? rate(promptTokens, ttftMs)
  const generationTps = timingNumber(upstreamTimings, 'predicted_per_second') ?? rateFromTiming(completionTokens, timingNumber(upstreamTimings, 'predicted_ms')) ?? rate(completionTokens, generationMs)
  return {
    timingsMs: { timeToFirstToken: ttftMs, generation: generationMs, total: completedAt - startedAt },
    tokens: { prompt: promptTokens, completion: completionTokens, promptEstimated: reportedPromptTokens == null && timingPromptTokens == null, completionEstimated: reportedCompletionTokens == null && timingCompletionTokens == null },
    throughput: {
      promptTokensPerSecond: promptTps,
      generationTokensPerSecond: generationTps
    },
    chunks,
    outputChars,
    usage: usage ?? null,
    upstreamTimings: upstreamTimings ?? null,
    timedOut
  }
}
function rate(tokens: number, ms: number): number {
  return Math.round((tokens / Math.max(0.001, ms / 1000)) * 10) / 10
}
function rateFromTiming(tokens: number, ms: number | undefined): number | undefined {
  return ms && ms > 0 ? rate(tokens, ms) : undefined
}
function timingNumber(timings: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = timings?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
function usageNumber(usage: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = usage?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
