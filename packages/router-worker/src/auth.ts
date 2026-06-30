import type { CredentialKind, TokenRecord } from './types'

const TOKEN_BYTES = 32
const HASH_PREFIX = 'sha256:'

export function createTokenId(kind: CredentialKind, now: number): string {
  return `${kind}_${now}_${randomHex(6)}`
}

export function generateBearerToken(prefix: string): string {
  return `${prefix}_${randomHex(TOKEN_BYTES)}`
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return `${HASH_PREFIX}${toHex(new Uint8Array(digest))}`
}

export async function createTokenRecord(kind: CredentialKind, token: string, now: number, nodeId?: string, expiresAt?: number): Promise<TokenRecord> {
  return {
    id: createTokenId(kind, now),
    kind,
    verifier: await hashToken(token),
    active: true,
    createdAt: now,
    ...(nodeId !== undefined ? { nodeId } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {})
  }
}

export async function verifyToken(token: string | undefined, record: TokenRecord | undefined, now: number): Promise<boolean> {
  if (!token || !record || !record.active) return false
  if (record.expiresAt !== undefined && record.expiresAt <= now) return false
  const verifier = await hashToken(token)
  return timingSafeEqualText(verifier, record.verifier)
}

export async function verifyPlainOrHashed(secret: string | undefined, presented: string | undefined): Promise<boolean> {
  if (!secret || !presented) return false
  if (secret.startsWith(HASH_PREFIX)) {
    return timingSafeEqualText(await hashToken(presented), secret)
  }
  return timingSafeEqualText(secret, presented)
}

export function bearerToken(request: Request): string | undefined {
  const value = request.headers.get('authorization')
  if (!value) return undefined
  const match = /^Bearer\s+(.+)$/i.exec(value.trim())
  return match?.[1]
}

export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => {
    if (/token|secret|authorization|key|verifier/i.test(key)) return [key, '[redacted]']
    return [key, redactSecrets(item)]
  }))
}

export function approvedNodeHeaders(input: Headers, upstreamToken: string, requestId: string): Headers {
  const output = new Headers()
  const contentType = input.get('content-type')
  const accept = input.get('accept')
  if (contentType) output.set('content-type', contentType)
  if (accept) output.set('accept', accept)
  output.set('authorization', `Bearer ${upstreamToken}`)
  output.set('x-inference-mesh-request-id', requestId)
  return output
}

export function approvedRuntimeHeaders(input: Headers): Headers {
  const output = new Headers()
  for (const name of ['content-type', 'accept', 'x-inference-mesh-request-id', 'x-inference-mesh-session']) {
    const value = input.get(name)
    if (value) output.set(name, value)
  }
  return output
}

export function timingSafeEqualText(left: string, right: string): boolean {
  const max = Math.max(left.length, right.length)
  let diff = left.length ^ right.length
  for (let index = 0; index < max; index += 1) {
    diff |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0)
  }
  return diff === 0
}

function randomHex(bytes: number): string {
  const data = new Uint8Array(bytes)
  crypto.getRandomValues(data)
  return toHex(data)
}

function toHex(data: Uint8Array): string {
  return [...data].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export const AUTH_ANCHORS = {
  REQ_GWY_002: 'REQ-GWY-002',
  REQ_GWY_004: 'REQ-GWY-004',
  REQ_SEC_001: 'REQ-SEC-001',
  REQ_SEC_002: 'REQ-SEC-002',
  REQ_SEC_003: 'REQ-SEC-003'
} as const
