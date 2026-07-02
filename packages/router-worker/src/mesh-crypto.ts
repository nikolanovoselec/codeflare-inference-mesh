const AES_GCM = 'AES-GCM'
const IV_BYTES = 12

export interface EncryptedEnvelope {
  readonly iv: string
  readonly ciphertext: string
}

export async function importMeshStateKey(base64: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey('raw', fromBase64(base64), { name: AES_GCM }, false, ['encrypt', 'decrypt'])
}

export async function encryptJson(key: CryptoKey, value: unknown): Promise<EncryptedEnvelope> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const plaintext = new TextEncoder().encode(JSON.stringify(value))
  const ciphertext = await crypto.subtle.encrypt({ name: AES_GCM, iv }, key, plaintext)
  return { iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(ciphertext)) }
}

export async function decryptJson<T>(key: CryptoKey, envelope: EncryptedEnvelope): Promise<T> {
  const plaintext = await crypto.subtle.decrypt({ name: AES_GCM, iv: fromBase64(envelope.iv) }, key, fromBase64(envelope.ciphertext))
  return JSON.parse(new TextDecoder().decode(plaintext)) as T
}

function toBase64(data: Uint8Array): string {
  let text = ''
  for (const byte of data) text += String.fromCharCode(byte)
  return btoa(text)
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const raw = atob(text)
  const data = new Uint8Array(raw.length)
  for (let index = 0; index < raw.length; index += 1) data[index] = raw.charCodeAt(index)
  return data
}

export const MESH_CRYPTO_ANCHORS = {
  REQ_SEC_006: 'REQ-SEC-006'
} as const
