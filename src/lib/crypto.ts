/**
 * AES-256-GCM encryption for at-rest secrets (BYOK keys).
 *
 * Master key from env BYOK_MASTER_KEY (must be 32 bytes hex = 64 chars).
 * Generate one: openssl rand -hex 32
 *
 * Format of stored ciphertext: <iv-hex>:<authTag-hex>:<ciphertext-hex>
 * Versioned with prefix "v1:" for forward compat.
 */
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto'

const ALGO = 'aes-256-gcm'
const VERSION = 'v1'

function getMasterKey(): Buffer {
  const raw = process.env.BYOK_MASTER_KEY || ''
  if (raw.length === 64 && /^[0-9a-fA-F]+$/.test(raw)) {
    return Buffer.from(raw, 'hex')
  }
  // Fallback for development · derive from app secret (NOT for production)
  console.warn('[crypto] BYOK_MASTER_KEY not set or invalid · using derived dev key. SET FOR PRODUCTION.')
  const seed = process.env.BETTER_AUTH_SECRET || 'entix-dev-key-do-not-use-in-prod'
  return createHash('sha256').update(seed).digest()
}

export function encryptSecret(plaintext: string): string {
  const key = getMasterKey()
  const iv = randomBytes(12)
  const cipher = createCipheriv(ALGO, key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return `${VERSION}:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`
}

export function decryptSecret(payload: string): string {
  const parts = payload.split(':')
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('invalid_ciphertext_format')
  }
  const [, ivHex, authTagHex, dataHex] = parts
  const key = getMasterKey()
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivHex, 'hex'))
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'))
  const decrypted = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()])
  return decrypted.toString('utf8')
}

export function maskKey(plaintext: string): string {
  if (!plaintext) return ''
  const tail = plaintext.slice(-4)
  return `sk-...${tail}`
}
