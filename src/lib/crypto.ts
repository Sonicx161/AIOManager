import { trace } from '@/lib/trace'
import { base64ToBytes, bytesToBase64 } from './base64'
export { bytesToBase64 } from './base64'

const PBKDF2_ITERATIONS = 600000
const SALT_LENGTH = 16
const IV_LENGTH = 12

const STORAGE_KEYS = {
  USER_SALT: 'aioman:user-salt',
  PASSWORD_HASH: 'aioman:password-hash',
  SESSION_KEY: 'aioman:session-key',
}

/**
 * Derive a secure authentication token for Cloud Sync.
 * This is a one-way hash (SHA-256) of the master password.
 * The server stores this hash, meaning it never sees the actual password.
 */
export async function deriveSyncToken(password: string, salt?: string): Promise<string> {
  const encoder = new TextEncoder()
  const strPassword = String(password)
  const pepper = salt ? `:sync-auth-token:${salt}` : ':sync-auth-token'
  const data = encoder.encode(strPassword + pepper)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
}

let pbkdf2Worker: Worker | null = null
let pbkdf2WorkerFailed = false
let pbkdf2RequestId = 0
// A healthy worker is however slow the device is; the hard timeout only exists to
// recover from a worker that will never answer. Before the first reply it waits
// far beyond any real 600k-iteration derivation, and once a reply has arrived it
// adapts to the observed derivation time, so a slow device is never terminated
// mid-derivation and redone on the main thread (the old fixed 5s cap did exactly
// that: two derivations per request plus full main-thread blocking).
const PBKDF2_WORKER_FIRST_TIMEOUT_MS = 30_000
let pbkdf2WorkerDelivered = false
let pbkdf2WorkerLastMs = 0
let pbkdf2FirstTimeoutMs = PBKDF2_WORKER_FIRST_TIMEOUT_MS

function pbkdf2WorkerTimeoutMs(): number {
    if (!pbkdf2WorkerDelivered) return pbkdf2FirstTimeoutMs
    return Math.max(pbkdf2FirstTimeoutMs, pbkdf2WorkerLastMs * 6)
}

/** Test-only knob: shrinks the first-request watchdog so orchestration tests run fast. */
export function setPbkdf2WorkerFirstTimeoutForTests(ms: number): void {
    pbkdf2FirstTimeoutMs = ms
}

interface Pbkdf2WorkerRequest {
  id: number
  password: string
  salt: Uint8Array
  iterations: number
  length: number
}

interface Pbkdf2WorkerResponse {
  id: number
  bits?: ArrayBuffer
  error?: string
}

function getPbkdf2Worker(): Worker | null {
  if (pbkdf2WorkerFailed) return null
  if (pbkdf2Worker) return pbkdf2Worker
  try {
    pbkdf2Worker = new Worker(new URL('../workers/pbkdf2-worker.ts', import.meta.url))
    return pbkdf2Worker
  } catch {
    pbkdf2WorkerFailed = true
    return null
  }
}

async function derivePbkdf2OnMain(
  password: string,
  salt: Uint8Array,
  iterations: number,
  length: number
): Promise<ArrayBuffer> {
  const encoder = new TextEncoder()
  const passwordBuffer = encoder.encode(String(password))
  const keyMaterial = await crypto.subtle.importKey('raw', passwordBuffer, 'PBKDF2', false, [
    'deriveBits',
  ])
  return crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: salt as BufferSource,
      iterations,
      hash: 'SHA-256',
    },
    keyMaterial,
    length
  )
}

function derivePbkdf2ViaWorker(
  password: string,
  salt: Uint8Array,
  iterations: number,
  length: number
): Promise<ArrayBuffer> {
  const worker = getPbkdf2Worker()
  if (!worker) {
    trace('crypto', 'pbkdf2.path', { path: 'main', reason: 'no-worker' })
    return derivePbkdf2OnMain(password, salt, iterations, length)
  }
  const id = ++pbkdf2RequestId
  const requestStart = Date.now()
  return new Promise<ArrayBuffer>((resolve) => {
    let completed = false
    const cleanup = () => {
      worker.removeEventListener('message', onMessage)
      worker.removeEventListener('error', onError)
    }
    const doResolve = (value: PromiseLike<ArrayBuffer> | ArrayBuffer) => {
      if (!completed) {
        completed = true
        cleanup()
        clearTimeout(timer)
        resolve(value)
      }
    }
    const onMessage = (event: MessageEvent<Pbkdf2WorkerResponse>) => {
      const data = event.data
      if (!data || data.id !== id) return
      if (data.error || !data.bits) {
        trace('crypto', 'pbkdf2.path', { path: 'main', reason: 'worker-error' })
        doResolve(derivePbkdf2OnMain(password, salt, iterations, length))
      } else {
        pbkdf2WorkerDelivered = true
        pbkdf2WorkerLastMs = Date.now() - requestStart
        trace('crypto', 'pbkdf2.path', { path: 'worker' })
        doResolve(data.bits)
      }
    }
    const onError = () => {
      pbkdf2WorkerFailed = true
      trace('crypto', 'pbkdf2.path', { path: 'main', reason: 'worker-error' })
      doResolve(derivePbkdf2OnMain(password, salt, iterations, length))
    }
    worker.addEventListener('message', onMessage)
    worker.addEventListener('error', onError)
    const request: Pbkdf2WorkerRequest = { id, password, salt, iterations, length }
    worker.postMessage(request)
    // The fallback only starts after the worker is terminated, so one request never
    // runs two derivations concurrently; on timeout the worker is presumed dead.
    const timer = setTimeout(() => {
      pbkdf2WorkerFailed = true
      worker.terminate()
      trace('crypto', 'pbkdf2.path', { path: 'main', reason: 'worker-timeout' })
      doResolve(derivePbkdf2OnMain(password, salt, iterations, length))
    }, pbkdf2WorkerTimeoutMs())
  })
}

async function runPbkdf2(
  password: string,
  salt: Uint8Array,
  iterations: number,
  length: number
): Promise<ArrayBuffer> {
  try {
    return await derivePbkdf2ViaWorker(password, salt, iterations, length)
  } catch {
    return derivePbkdf2OnMain(password, salt, iterations, length)
  }
}

export async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const start = Date.now()
  trace('crypto', 'deriveKey.start', { iterations: PBKDF2_ITERATIONS })
  try {
    const bits = await runPbkdf2(String(password), salt, PBKDF2_ITERATIONS, 256)
    const key = await crypto.subtle.importKey(
      'raw',
      bits,
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    )
    trace('crypto', 'deriveKey.success', { timing: Date.now() - start })
    return key
  } catch (err) {
    trace('crypto', 'deriveKey.error', { timing: Date.now() - start, error: (err as Error)?.message })
    throw err
  }
}

export async function encrypt(data: string, key: CryptoKey): Promise<string> {
  const encoder = new TextEncoder()
  const dataBuffer = encoder.encode(String(data))

  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH))

  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, dataBuffer)

  const combined = new Uint8Array(iv.length + ciphertext.byteLength)
  combined.set(iv, 0)
  combined.set(new Uint8Array(ciphertext), iv.length)

  return bytesToBase64(combined)
}

export async function decrypt(encrypted: string, key: CryptoKey): Promise<string> {
  if (!encrypted) return ''
  const combined = base64ToBytes(encrypted)

  const iv = combined.slice(0, IV_LENGTH)
  const ciphertext = combined.slice(IV_LENGTH)

  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext)

  const decoder = new TextDecoder()
  return decoder.decode(decrypted)
}

export async function hashPassword(password: string, salt: Uint8Array): Promise<string> {
  const hashBits = await runPbkdf2(String(password), salt, PBKDF2_ITERATIONS, 256)

  const hashArray = new Uint8Array(hashBits)
  return btoa(String.fromCharCode(...hashArray))
}

// Password verification and AES key derivation share the same PBKDF2 result.
export async function deriveKeyAndHash(password: string, salt: Uint8Array): Promise<{ key: CryptoKey; hash: string }> {
  const bits = await runPbkdf2(String(password), salt, PBKDF2_ITERATIONS, 256)
  const hash = btoa(String.fromCharCode(...new Uint8Array(bits)))
  const key = await crypto.subtle.importKey('raw', bits, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
  return { key, hash }
}

// Return the derived key only when the local password hash matches.
export async function deriveVerifiedKey(password: string, salt: Uint8Array, storedHash: string): Promise<CryptoKey | null> {
  const { key, hash } = await deriveKeyAndHash(password, salt)
  return hash === storedHash ? key : null
}

export function generateSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(SALT_LENGTH))
}

export function loadSalt(): Uint8Array | null {
  try {
    const saltBase64 = localStorage.getItem(STORAGE_KEYS.USER_SALT)
    if (!saltBase64) return null
    return Uint8Array.from(atob(saltBase64), (c) => c.charCodeAt(0))
  } catch {
    return null
  }
}

export function saveSalt(salt: Uint8Array): boolean {
  try {
    const saltBase64 = btoa(String.fromCharCode(...salt))
    localStorage.setItem(STORAGE_KEYS.USER_SALT, saltBase64)
    return true
  } catch {
    console.warn('Your session may not persist across page reloads.')
    return false
  }
}

export function loadPasswordHash(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEYS.PASSWORD_HASH)
  } catch {
    return null
  }
}

export function savePasswordHash(hash: string): boolean {
  try {
    localStorage.setItem(STORAGE_KEYS.PASSWORD_HASH, hash)
    return true
  } catch {
    console.warn('Your session may not persist across page reloads.')
    return false
  }
}

export function isPasswordSetup(): boolean {
  return !!(loadSalt() && loadPasswordHash())
}

export async function saveSessionKey(key: CryptoKey): Promise<void> {
  try {
    const keyBuffer = await crypto.subtle.exportKey('raw', key)
    const keyArray = new Uint8Array(keyBuffer)

    const keyBase64 = btoa(String.fromCharCode(...keyArray))
    sessionStorage.setItem(STORAGE_KEYS.SESSION_KEY, keyBase64)
  } catch (error) {
    if (import.meta.env.DEV) console.error('Failed to save session key:', error)
    throw error
  }
}

export async function loadSessionKey(): Promise<CryptoKey | null> {
  try {
    const keyBase64 = sessionStorage.getItem(STORAGE_KEYS.SESSION_KEY)
    if (!keyBase64) return null

    const keyArray = Uint8Array.from(atob(keyBase64), (c) => c.charCodeAt(0))

    const key = await crypto.subtle.importKey(
      'raw',
      keyArray,
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    )

    return key
  } catch (error) {
    if (import.meta.env.DEV) console.error('Failed to load session key:', error)
    return null
  }
}

export function clearSessionKey(): void {
  sessionStorage.removeItem(STORAGE_KEYS.SESSION_KEY)
}

export interface LocalAuthSecretsSnapshot {
  passwordHash: string | null
  userSalt: string | null
  sessionKey: string | null
}

export function clearLocalAuthSecrets(): LocalAuthSecretsSnapshot {
  const snapshot: LocalAuthSecretsSnapshot = {
    passwordHash: null,
    userSalt: null,
    sessionKey: null,
  }
  try {
    snapshot.passwordHash = localStorage.getItem(STORAGE_KEYS.PASSWORD_HASH)
    snapshot.userSalt = localStorage.getItem(STORAGE_KEYS.USER_SALT)
    snapshot.sessionKey = sessionStorage.getItem(STORAGE_KEYS.SESSION_KEY)
    localStorage.removeItem(STORAGE_KEYS.PASSWORD_HASH)
    localStorage.removeItem(STORAGE_KEYS.USER_SALT)
    sessionStorage.removeItem(STORAGE_KEYS.SESSION_KEY)
  } catch {
    // Storage may be blocked; caller can still continue with cloud login.
  }
  return snapshot
}

export function restoreLocalAuthSecrets(snapshot: LocalAuthSecretsSnapshot): void {
  try {
    if (snapshot.passwordHash) localStorage.setItem(STORAGE_KEYS.PASSWORD_HASH, snapshot.passwordHash)
    else localStorage.removeItem(STORAGE_KEYS.PASSWORD_HASH)
    if (snapshot.userSalt) localStorage.setItem(STORAGE_KEYS.USER_SALT, snapshot.userSalt)
    else localStorage.removeItem(STORAGE_KEYS.USER_SALT)
    if (snapshot.sessionKey) sessionStorage.setItem(STORAGE_KEYS.SESSION_KEY, snapshot.sessionKey)
    else sessionStorage.removeItem(STORAGE_KEYS.SESSION_KEY)
  } catch {
    // Best-effort rollback for recovery flows.
  }
}

const SYNC_KEY_SALT = new TextEncoder().encode('aiomanager-sync-key-v2')

const syncKeyCache = new Map<string, CryptoKey>()
// Distinct password/salt combos alternate more easily than 2 (per-account sync keys,
// blob re-decodes); derived CryptoKey objects are tiny in-memory handles, and logout
// still clears the cache wholesale, so a wider bound only avoids 135ms+ re-derivations.
const SYNC_KEY_CACHE_MAX = 8

async function syncKeyCacheKey(password: string, salt: Uint8Array): Promise<string> {
  let saltKey = ''
  for (let i = 0; i < salt.length; i++) saltKey += String.fromCharCode(salt[i])
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${String(password)}|${btoa(saltKey)}`))
  return 'k:' + Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')
}

function cacheSyncKey(cacheKey: string, key: CryptoKey): void {
  if (syncKeyCache.has(cacheKey)) syncKeyCache.delete(cacheKey)
  syncKeyCache.set(cacheKey, key)
  while (syncKeyCache.size > SYNC_KEY_CACHE_MAX) {
    const oldest = syncKeyCache.keys().next().value
    if (oldest === undefined) break
    syncKeyCache.delete(oldest)
  }
}

export function clearSyncKeyCache(): void {
  syncKeyCache.clear()
}

// Migration target: src/lib/crypto-envelope.ts defines the versioned v2 envelope
// ('v2.<salt>.<iv>.<ct>', self-contained salt/IV) whose decryptEnvelope dual-reads both
// legacy shapes below. syncStore should move to encryptEnvelope/decryptEnvelope in a
// later release (after the pilot soaks); this module stays untouched for legacy reads.

export async function deriveSyncEncryptionKey(password: string, salt?: Uint8Array): Promise<CryptoKey> {
  const effectiveSalt = salt ?? SYNC_KEY_SALT
  const cacheKey = await syncKeyCacheKey(password, effectiveSalt)
  const cached = syncKeyCache.get(cacheKey)
  if (cached) return cached
  const bits = await runPbkdf2(String(password), effectiveSalt, PBKDF2_ITERATIONS, 256)
  const key = await crypto.subtle.importKey(
    'raw',
    bits,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
  cacheSyncKey(cacheKey, key)
  return key
}

export async function exportSyncKeyRaw(password: string, salt?: Uint8Array): Promise<Uint8Array> {
  const effectiveSalt = salt ?? SYNC_KEY_SALT
  const bits = await runPbkdf2(String(password), effectiveSalt, PBKDF2_ITERATIONS, 256)
  return new Uint8Array(bits)
}

export async function importSyncKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    raw as BufferSource,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

export async function encryptSyncPayloadWithKey(plaintext: string, key: CryptoKey): Promise<string> {
  return encrypt(plaintext, key)
}

export async function decryptSyncPayloadWithKey(ciphertext: string, key: CryptoKey): Promise<string> {
  const result = await decrypt(ciphertext, key)
  if (!result) throw new Error('Decryption failed')
  return result
}

export async function encryptSyncPayload(plaintext: string, password: string, salt?: Uint8Array): Promise<string> {
  const start = Date.now()
  trace('crypto', 'encryptSyncPayload.start', { bytes: plaintext.length })
  try {
    const key = await deriveSyncEncryptionKey(password, salt)
    const result = await encrypt(plaintext, key)
    trace('crypto', 'encryptSyncPayload.success', { bytes: plaintext.length, timing: Date.now() - start })
    return result
  } catch (err) {
    trace('crypto', 'encryptSyncPayload.error', { bytes: plaintext.length, timing: Date.now() - start, error: (err as Error)?.message })
    throw err
  }
}

export async function decryptSyncPayload(ciphertext: string, password: string, salt?: Uint8Array): Promise<string> {
  const start = Date.now()
  trace('crypto', 'decryptSyncPayload.start', {})
  try {
    const key = await deriveSyncEncryptionKey(password, salt)
    try {
      const result = await decrypt(ciphertext, key)
      trace('crypto', 'decryptSyncPayload.success', { path: 'gcm', timing: Date.now() - start })
      return result
    } catch {
      const { AES, enc } = await import('crypto-js')
      const bytes = AES.decrypt(ciphertext, password)
      const decrypted = bytes.toString(enc.Utf8)
      if (!decrypted) throw new Error('Decryption failed')
      trace('crypto', 'decryptSyncPayload.success', { path: 'legacy-fallback', timing: Date.now() - start })
      return decrypted
    }
  } catch (err) {
    trace('crypto', 'decryptSyncPayload.error', { timing: Date.now() - start, error: (err as Error)?.message })
    throw err
  }
}
