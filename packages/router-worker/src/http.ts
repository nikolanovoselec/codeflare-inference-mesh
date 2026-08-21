/**
 * Response builders and request-body readers shared by every route handler.
 *
 * Leaf module: it depends only on the error type, so any handler module can
 * import it without a cycle. `json` alone had well over two hundred call sites
 * inside the old single-file router, which is why these primitives move first.
 */
import { InvalidJsonBodyError } from './errors'

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' }

export function json(body: unknown, status: number, requestId: string): Response {
  return Response.json(body, { status, headers: { ...JSON_HEADERS, 'x-inference-mesh-request-id': requestId } })
}

export function rateLimited(requestId: string): Response {
  return Response.json({ error: 'rate_limited', requestId }, { status: 429, headers: { ...JSON_HEADERS, 'x-inference-mesh-request-id': requestId, 'retry-after': '60' } })
}

export function html(body: string, requestId: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      'content-security-policy': "frame-ancestors 'none'",
      'content-type': 'text/html; charset=utf-8',
      'x-frame-options': 'DENY',
      'x-inference-mesh-request-id': requestId
    }
  })
}

export async function readJson<T>(request: Request): Promise<T> {
  try {
    return await request.json() as T
  } catch {
    throw new InvalidJsonBodyError()
  }
}

export async function readOptionalObject<T>(request: Request): Promise<T | undefined> {
  const text = await request.text()
  if (!text) return undefined
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    // An absent body is fine (returns undefined above → the route uses its defaults), but a
    // present-but-unparseable body is a client mistake: reject it as 400 invalid_json rather
    // than silently discarding it and applying defaults the caller never intended.
    throw new InvalidJsonBodyError()
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as T : undefined
}

export function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

export function responseMetadataHeaders(upstream: Headers, requestId: string, nodeId: string): Headers {
  const headers = new Headers(upstream)
  headers.set('x-inference-mesh-request-id', requestId)
  headers.set('x-inference-mesh-node', nodeId)
  return headers
}

/** A trimmed non-empty string, or undefined. Reads optional body and query fields. */
export function cleanString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
