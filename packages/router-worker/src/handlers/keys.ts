/** Automation credentials and the operational event feed they poll. */
import { createTokenRecord, generateBearerToken } from '../auth'
import { json } from '../http'
import type { RouterDeps } from '../deps'
import { SETUP_TOKEN_TTL_MS } from './setup'

export async function handleApiKeyCreate(deps: RouterDeps, requestId: string, now: number, actor: string): Promise<Response> {
  const token = generateBearerToken('automation')
  const record = await createTokenRecord('automation', token, now)
  await deps.store.putToken(record)
  await deps.store.appendAudit({ id: requestId, type: 'automation_key_created', at: now, actor, detail: { keyId: record.id } })
  return json({ id: record.id, token, createdAt: record.createdAt }, 201, requestId)
}

export async function handleApiKeyList(deps: RouterDeps, requestId: string): Promise<Response> {
  const keys = (await deps.store.listTokens('automation'))
    .filter((token) => token.active)
    .map((token) => ({ id: token.id, createdAt: token.createdAt }))
  return json({ keys }, 200, requestId)
}

export async function handleApiKeyRevoke(deps: RouterDeps, url: URL, requestId: string, now: number, actor: string): Promise<Response> {
  const keyId = decodeURIComponent(url.pathname.split('/').pop() ?? '')
  const existing = await deps.store.getToken('automation', keyId)
  if (!existing) return json({ error: 'not_found', requestId }, 404, requestId)
  await deps.store.revokeToken('automation', keyId, now)
  await deps.store.appendAudit({ id: requestId, type: 'automation_key_revoked', at: now, actor, detail: { keyId } })
  return json({ ok: true, id: keyId }, 200, requestId)
}

// handleApiKeyRotate retires a key and issues a fresh secret in one step so the previous
// secret stops authenticating immediately; the new secret is returned exactly once.
export async function handleApiKeyRotate(deps: RouterDeps, url: URL, requestId: string, now: number, actor: string): Promise<Response> {
  const keyId = decodeURIComponent(url.pathname.split('/').at(-2) ?? '')
  const existing = await deps.store.getToken('automation', keyId)
  if (!existing) return json({ error: 'not_found', requestId }, 404, requestId)
  await deps.store.revokeToken('automation', keyId, now)
  const token = generateBearerToken('automation')
  const record = await createTokenRecord('automation', token, now)
  await deps.store.putToken(record)
  await deps.store.appendAudit({ id: requestId, type: 'automation_key_rotated', at: now, actor, detail: { previousKeyId: keyId, keyId: record.id } })
  return json({ id: record.id, token, createdAt: record.createdAt, rotatedFrom: keyId }, 201, requestId)
}

/** Mint a setup (enrollment) token programmatically. Accepts an automation key or an admin credential. */
export async function handleApiEnrollmentToken(deps: RouterDeps, requestId: string, now: number, actor: string): Promise<Response> {
  const setupToken = generateBearerToken('setup')
  await deps.store.putToken(await createTokenRecord('setup', setupToken, now, undefined, now + SETUP_TOKEN_TTL_MS))
  await deps.store.appendAudit({ id: requestId, type: 'setup_token_created', at: now, actor, detail: {} })
  return json({ setupToken, expiresAt: now + SETUP_TOKEN_TTL_MS }, 201, requestId)
}

/** Poll operational events oldest-first, filtered by since/type, paginated by an `at` cursor. */
export async function handleApiEvents(deps: RouterDeps, url: URL, requestId: string): Promise<Response> {
  const raw = url.searchParams.get('since') ?? '0'
  const i = raw.indexOf(':')
  const atStr = i >= 0 ? raw.slice(0, i) : raw
  const sinceId = i >= 0 ? raw.slice(i + 1) : ''
  const sinceParam = Number(atStr)
  const sinceMs = Number.isFinite(sinceParam) && sinceParam >= 0 ? sinceParam : 0
  const typeParam = url.searchParams.get('type')
  const types = typeParam ? typeParam.split(',').map((entry) => entry.trim()).filter(Boolean) : undefined
  const limitParam = Number(url.searchParams.get('limit') ?? '100')
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(Math.floor(limitParam), 1000) : 100
  const events = await deps.store.listEventsSince(sinceMs, sinceId, types, limit)
  const last = events.length > 0 ? events[events.length - 1]! : undefined
  const nextCursor = events.length === limit && last ? `${last.at}:${last.id}` : null
  return json({ events, nextCursor }, 200, requestId)
}
