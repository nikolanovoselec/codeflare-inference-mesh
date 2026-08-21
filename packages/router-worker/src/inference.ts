/**
 * The data plane: choosing a node for a chat request, rewriting the body to the
 * node's upstream model, and forwarding it over the Workers VPC binding.
 *
 * Includes the direct-session helpers, because cache-warm affinity for direct
 * llama.cpp profiles is part of choosing the node rather than a separate concern.
 * The router holds no reservation: mesh-llm owns concurrency and KV-aware routing.
 */
import { approvedNodeHeaders } from './auth'
import { decideDirectSession, directSessionKey, type DirectSessionDecision, type DirectSessionDecisionRequest } from './direct-affinity'
import { json, responseMetadataHeaders } from './http'
import { eligibleDirectNodes, meshUrl } from './scheduler'
import { DIRECT_RUNTIMES } from './types'
import type { ModelProfile, NodeRecord, RouterEnv, Scheduler, Store } from './types'

/** The slice of the router's dependencies the data plane uses. RouterDeps satisfies it. */
export interface InferenceDeps {
  readonly store: Store
  readonly scheduler: Scheduler
  readonly mesh: Fetcher
  readonly env: Partial<RouterEnv>
}

// The forward path shared by the provider `/v1/chat/completions` route and the admin
// Playground's direct target. Mesh profiles keep the stateless mesh-llm entry selection;
// direct llama.cpp profiles require a stable `body.user` and use session affinity so a
// coding conversation stays on the same cache-warm node. REQ-SCH-002 / REQ-SCH-004.
export async function runInference(deps: InferenceDeps, input: { body: Record<string, unknown>; requestHeaders: Headers; requestId: string; now: number }): Promise<Response> {
  const publicModel = routablePublicModel(input.body.model as string)
  const profile = await deps.store.getProfileByPublicModel(publicModel)
  if (!profile) return json({ error: 'no-profile', requestId: input.requestId }, 404, input.requestId)
  const normalized = { ...input, body: { ...input.body, model: publicModel } }
  if (DIRECT_RUNTIMES.has(profile.runtime)) return runDirectInference(deps, { ...normalized, body: directSessionBody(normalized.body, input.requestHeaders) }, publicModel, profile)
  return runMeshInference(deps, normalized)
}
export function routablePublicModel(model: string): string {
  return model.startsWith('dynamic/') ? model.slice('dynamic/'.length) : model
}
async function runMeshInference(deps: InferenceDeps, input: { body: Record<string, unknown>; requestHeaders: Headers; requestId: string; now: number }): Promise<Response> {
  const publicModel = input.body.model as string
  const selection = await deps.scheduler.selectEntryNode({ publicModel, now: input.now })
  if (!selection.node || !selection.profile) {
    if (selection.reason === 'no-profile') return json({ error: 'no-profile', requestId: input.requestId }, 404, input.requestId)
    return json({ error: 'no_healthy_node', requestId: input.requestId }, 503, input.requestId)
  }
  return forwardInference(deps, input, selection.node, selection.profile)
}
async function runDirectInference(deps: InferenceDeps, input: { body: Record<string, unknown>; requestHeaders: Headers; requestId: string; now: number }, publicModel: string, profile: ModelProfile): Promise<Response> {
  const session = parseDirectSession(input.body.user)
  if (!session) {
    await deps.store.appendAudit({ id: input.requestId, type: 'direct_session_rejected', at: input.now, actor: 'provider', target: profile.id, detail: { publicModel, reason: 'invalid_user' } })
    return json({ error: 'session_required', message: 'llamacpp profiles require body.user formatted as user:<id>|session:<id>', requestId: input.requestId }, 400, input.requestId)
  }
  const secret = directAffinitySecret(deps.env)
  if (!secret) return json({ error: 'session_affinity_key_missing', requestId: input.requestId }, 503, input.requestId)
  const userHash = `hmac-sha256:${await hmacHex(secret, session.userId)}`
  const sessionHash = `hmac-sha256:${await hmacHex(secret, session.sessionId)}`
  const affinityHash = `hmac-sha256:${await hmacHex(secret, `${session.userId}|${session.sessionId}`)}`
  const candidates = eligibleDirectNodes(await deps.store.listNodes(input.now), profile, publicModel, input.now, deps.env)
  const decision = await decideDirectSessionWithAffinity(deps, {
    affinityKey: directSessionKey(publicModel, profile.id, affinityHash),
    profileId: profile.id,
    publicModel,
    userHash,
    sessionHash,
    candidates,
    now: input.now
  })
  if (!decision.node || !decision.affinity) return json({ error: 'no_healthy_node', requestId: input.requestId }, 503, input.requestId)
  await deps.store.appendAudit({ id: input.requestId, type: `direct_session_${decision.affinity === 'failed_over' ? 'failed_over' : decision.affinity}`, at: input.now, actor: 'provider', target: profile.id, detail: { profileId: profile.id, publicModel, nodeId: decision.node.id, affinityKey: decision.session?.affinityKey ?? '', userHash, sessionHash, reason: decision.affinity === 'reused' ? 'healthy_pin' : decision.affinity === 'failed_over' ? 'node_unhealthy' : 'new' } })
  const response = await forwardInference(deps, input, decision.node, profile)
  response.headers.set('x-inference-mesh-affinity', decision.affinity)
  response.headers.set('x-inference-mesh-session-node', decision.node.id)
  return response
}
async function forwardInference(deps: InferenceDeps, input: { body: Record<string, unknown>; requestHeaders: Headers; requestId: string }, node: NodeRecord, profile: ModelProfile): Promise<Response> {
  const upstreamToken = await resolveUpstreamToken(deps)
  if (!upstreamToken) return json({ error: 'upstream_token_missing', requestId: input.requestId }, 503, input.requestId)

  const rewritten = JSON.stringify({ ...input.body, model: profile.upstreamModel })
  let upstream: Response
  try {
    upstream = await deps.mesh.fetch(meshUrl(node, '/v1/chat/completions', deps.env), {
      method: 'POST',
      headers: approvedNodeHeaders(input.requestHeaders, upstreamToken, input.requestId),
      body: rewritten,
      redirect: 'manual'
    })
  } catch {
    return json({ error: 'node_unreachable', requestId: input.requestId }, 502, input.requestId)
  }
  if (upstream.status >= 300 && upstream.status < 400) return json({ error: 'node_redirect_rejected', requestId: input.requestId }, 502, input.requestId)
  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseMetadataHeaders(upstream.headers, input.requestId, node.id)
  })
}
export async function resolveUpstreamToken(deps: InferenceDeps): Promise<string | undefined> {
  return deps.env.NODE_UPSTREAM_TOKEN ?? await deps.store.getConfig<string>('node_upstream_token')
}
function parseDirectSession(value: unknown): { readonly userId: string; readonly sessionId: string } | undefined {
  if (typeof value !== 'string') return undefined
  const match = /^user:([^|\r\n]{1,256})\|session:([^|\r\n]{1,256})$/.exec(value)
  return match ? { userId: match[1]!, sessionId: match[2]! } : undefined
}
function directSessionBody(body: Record<string, unknown>, headers: Headers): Record<string, unknown> {
  if (parseDirectSession(body.user)) return body
  const fallback = gatewayMetadataDirectSession(headers, body.metadata) ?? providerDefaultDirectSession(headers)
  return fallback ? { ...body, user: fallback } : body
}
function gatewayMetadataDirectSession(headers: Headers, bodyMetadata: unknown): string | undefined {
  const metadata = parseGatewayMetadata(headers.get('cf-aig-metadata')) ?? parseGatewayMetadataObject(bodyMetadata)
  const user = directSessionPart(metadata?.user)
  if (!user) return undefined
  const session = directSessionPart(metadata?.session) ?? user
  return `user:${user}|session:${session}`
}
function parseGatewayMetadata(value: string | null): Record<string, unknown> | undefined {
  if (!value) return undefined
  try {
    return parseGatewayMetadataObject(JSON.parse(value) as unknown)
  } catch {
    return undefined
  }
}
function parseGatewayMetadataObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
function directSessionPart(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return undefined
  const cleaned = String(value).trim().replace(/[|\r\n]/g, '-').slice(0, 256)
  return cleaned || undefined
}
function providerDefaultDirectSession(headers: Headers): string | undefined {
  return headers.get('authorization') ? 'user:ai-gateway|session:provider-default' : undefined
}
function directAffinitySecret(env: Partial<RouterEnv>): string | undefined {
  return env.SESSION_AFFINITY_KEY ?? env.ADMIN_TOKEN
}
async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value))
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
async function decideDirectSessionWithAffinity(deps: InferenceDeps, request: DirectSessionDecisionRequest): Promise<DirectSessionDecision> {
  if (!deps.env.SESSION_AFFINITY) return decideDirectSession(deps.store, request)
  const id = deps.env.SESSION_AFFINITY.idFromName(request.affinityKey)
  const response = await deps.env.SESSION_AFFINITY.get(id).fetch('https://session-affinity.local/direct-session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request)
  })
  return await response.json() as DirectSessionDecision
}
