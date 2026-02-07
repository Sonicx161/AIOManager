/**
 * Cryptographic utilities using Web Crypto API
 * Provides AES-256-GCM encryption with PBKDF2-SHA256 key derivation
 */

const PBKDF2_ITERATIONS = 600000
const SALT_LENGTH = 16
const IV_LENGTH = 12

const STORAGE_KEYS = {
  USER_SALT: 'stremio-manager:user-salt',
  PASSWORD_HASH: 'stremio-manager:password-hash',
  SESSION_KEY: 'stremio-manager:session-key',
}

/**
 * Derive a secure authentication token for Cloud Sync.
 * This is a one-way hash (SHA-256) of the master password.
 * The server stores this hash, meaning it never sees the actual password.
 */
export async function deriveSyncToken(password: string): Promise<string> {
  const encoder = new TextEncoder()
  // Ensure password is a string
  const strPassword = String(password)
  // We use a fixed "pepper" to ensure sync tokens are different from other hashes
  const data = encoder.encode(strPassword + ':sync-auth-token')
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Derive a CryptoKey from password and salt using PBKDF2-SHA256
 */
export async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const encoder = new TextEncoder()
  // Ensure password is a string
  const strPassword = String(password)
  const passwordBuffer = encoder.encode(strPassword)

  // Import password as key material
  const keyMaterial = await crypto.subtle.importKey('raw', passwordBuffer, 'PBKDF2', false, [
    'deriveBits',
    'deriveKey',
  ])

  // Derive AES-GCM key (extractable so we can save to sessionStorage)
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    true, // extractable
    ['encrypt', 'decrypt']
  )
}

/**
 * Encrypt data using AES-256-GCM
 * Returns base64-encoded string: IV + ciphertext
 */
export async function encrypt(data: string, key: CryptoKey): Promise<string> {
  const encoder = new TextEncoder()
  const dataBuffer = encoder.encode(String(data))

  // Generate random IV
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH))

  // Encrypt
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, dataBuffer)

  // Combine IV + ciphertext
  const combined = new Uint8Array(iv.length + ciphertext.byteLength)
  combined.set(iv, 0)
  combined.set(new Uint8Array(ciphertext), iv.length)

  // Return base64
  return btoa(String.fromCharCode(...combined))
}

/**
 * Decrypt data using AES-256-GCM
 * Expects base64-encoded string: IV + ciphertext
 */
export async function decrypt(encrypted: string, key: CryptoKey): Promise<string> {
  // Decode base64
  const combined = Uint8Array.from(atob(encrypted), (c) => c.charCodeAt(0))

  // Extract IV and ciphertext
  const iv = combined.slice(0, IV_LENGTH)
  const ciphertext = combined.slice(IV_LENGTH)

  // Decrypt
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext)

  // Convert to string
  const decoder = new TextDecoder()
  return decoder.decode(decrypted)
}

/**
 * Hash password for verification using PBKDF2-SHA256
 * Returns base64-encoded hash
 */
export async function hashPassword(password: string, salt: Uint8Array): Promise<string> {
  const encoder = new TextEncoder()
  // Ensure password is a string
  const strPassword = String(password)
  const passwordBuffer = encoder.encode(strPassword)

  // Import password as key material
  const keyMaterial = await crypto.subtle.importKey('raw', passwordBuffer, 'PBKDF2', false, [
    'deriveBits',
  ])

  // Derive hash bits
  const hashBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: salt as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    256
  )

  // Return base64
  const hashArray = new Uint8Array(hashBits)
  return btoa(String.fromCharCode(...hashArray))
}

/**
 * Generate a random salt
 */
export function generateSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(SALT_LENGTH))
}

/**
 * Load salt from localStorage
 */
export function loadSalt(): Uint8Array | null {
  const saltBase64 = localStorage.getItem(STORAGE_KEYS.USER_SALT)
  if (!saltBase64) return null

  return Uint8Array.from(atob(saltBase64), (c) => c.charCodeAt(0))
}

/**
 * Save salt to localStorage
 */
export function saveSalt(salt: Uint8Array): void {
  const saltBase64 = btoa(String.fromCharCode(...salt))
  localStorage.setItem(STORAGE_KEYS.USER_SALT, saltBase64)
}

/**
 * Load password hash from localStorage
 */
export function loadPasswordHash(): string | null {
  return localStorage.getItem(STORAGE_KEYS.PASSWORD_HASH)
}

/**
 * Save password hash to localStorage
 */
export function savePasswordHash(hash: string): void {
  localStorage.setItem(STORAGE_KEYS.PASSWORD_HASH, hash)
}

/**
 * Check if master password is set up
 */
export function isPasswordSetup(): boolean {
  return !!(loadSalt() && loadPasswordHash())
}

/**
 * Export encryption key to sessionStorage
 * Allows key to persist across page refreshes but clears when tab closes
 */
export async function saveSessionKey(key: CryptoKey): Promise<void> {
  try {
    // Export key to raw format
    const keyBuffer = await crypto.subtle.exportKey('raw', key)
    const keyArray = new Uint8Array(keyBuffer)

    // Convert to base64 for storage
    const keyBase64 = btoa(String.fromCharCode(...keyArray))
    sessionStorage.setItem(STORAGE_KEYS.SESSION_KEY, keyBase64)
  } catch (error) {
    console.error('Failed to save session key:', error)
    throw error
  }
}

/**
 * Load encryption key from sessionStorage
 * Returns null if no session key exists
 */
export async function loadSessionKey(): Promise<CryptoKey | null> {
  try {
    const keyBase64 = sessionStorage.getItem(STORAGE_KEYS.SESSION_KEY)
    if (!keyBase64) return null

    // Decode from base64
    const keyArray = Uint8Array.from(atob(keyBase64), (c) => c.charCodeAt(0))

    // Import as CryptoKey
    const key = await crypto.subtle.importKey(
      'raw',
      keyArray,
      { name: 'AES-GCM', length: 256 },
      true, // extractable
      ['encrypt', 'decrypt']
    )

    return key
  } catch (error) {
    console.error('Failed to load session key:', error)
    return null
  }
}

/**
 * Clear session key from sessionStorage
 */
export function clearSessionKey(): void {
  sessionStorage.removeItem(STORAGE_KEYS.SESSION_KEY)
}
