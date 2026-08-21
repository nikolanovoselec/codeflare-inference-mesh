/** The OpenAI-compatible data plane: the two routes real inference traffic arrives on. */
import { json, parseObject } from '../http'
import type { RouterDeps } from '../deps'
import { runInference } from '../inference'

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024

export async function handleModels(deps: RouterDeps, requestId: string): Promise<Response> {
  const profiles = await deps.store.listProfiles()
  return json({ object: 'list', data: profiles.filter((profile) => profile.active).flatMap((profile) => profile.publicAliases.map((id) => ({ id, object: 'model', owned_by: 'codeflare-inference-mesh' }))) }, 200, requestId)
}

export async function handleChat(request: Request, deps: RouterDeps, requestId: string, now: number): Promise<Response> {
  const parsedMaxBytes = Number(deps.env.MAX_REQUEST_BYTES ?? DEFAULT_MAX_BYTES)
  const maxBytes = Number.isFinite(parsedMaxBytes) ? parsedMaxBytes : DEFAULT_MAX_BYTES
  const contentLength = Number(request.headers.get('content-length') ?? '0')
  if (contentLength > maxBytes) return json({ error: 'request_too_large', requestId }, 413, requestId)
  const bodyText = await request.text()
  if (new TextEncoder().encode(bodyText).byteLength > maxBytes) return json({ error: 'request_too_large', requestId }, 413, requestId)
  const body = parseObject(bodyText)
  if (!body || typeof body.model !== 'string') return json({ error: 'invalid_json', requestId }, 400, requestId)
  return runInference(deps, { body, requestHeaders: request.headers, requestId, now })
}
