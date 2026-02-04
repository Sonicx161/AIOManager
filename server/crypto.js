import crypto from 'crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12
const AUTH_TAG_LENGTH = 16

/**
 * Encrypt data using AES-256-GCM
 * @param {string} text - Plaintext to encrypt
 * @param {string} secret - 32-byte secret key (hex encoded or string)
 * @returns {string} - Combined base64 string: IV + Ciphertext + AuthTag
 */
export function encrypt(text, secret) {
    if (!secret) throw new Error('Encryption secret is required')
    if (text === null || text === undefined) return null

    // Ensure secret is 32 bytes
    const key = crypto.createHash('sha256').update(String(secret)).digest()
    const iv = crypto.randomBytes(IV_LENGTH)
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv)

    let encrypted = cipher.update(text, 'utf8', 'base64')
    encrypted += cipher.final('base64')

    const authTag = cipher.getAuthTag().toString('base64')

    // Format: IV:Ciphertext:AuthTag
    return `${iv.toString('base64')}:${encrypted}:${authTag}`
}

/**
 * Decrypt data using AES-256-GCM
 * @param {string} encryptedData - Combined base64 string: IV:Ciphertext:AuthTag
 * @param {string|string[]} secrets - Single key or array of keys to try
 * @returns {string} - Decrypted plaintext or null if decryption failed
 */
export function decrypt(encryptedData, secrets) {
    if (!secrets) throw new Error('Encryption secret is required')

    // Improved fallback: If it doesn't look like our Base64:Base64:Base64 format, or if it looks like a URL, it's plaintext
    if (!encryptedData || typeof encryptedData !== 'string' || !encryptedData.includes(':')) return encryptedData
    if (encryptedData.startsWith('http')) return encryptedData // Definite URL fallback

    const parts = encryptedData.split(':')
    if (parts.length !== 3) return encryptedData // Must have IV:Cipher:Tag

    const candidates = Array.isArray(secrets) ? secrets : [secrets]

    for (const secret of candidates) {
        try {
            const [ivBase64, ciphertextBase64, authTagBase64] = encryptedData.split(':')
            if (!ivBase64 || !ciphertextBase64 || !authTagBase64) continue

            const key = crypto.createHash('sha256').update(String(secret)).digest()
            const iv = Buffer.from(ivBase64, 'base64')
            const ciphertext = Buffer.from(ciphertextBase64, 'base64')
            const authTag = Buffer.from(authTagBase64, 'base64')

            const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
            decipher.setAuthTag(authTag)

            let decrypted = decipher.update(ciphertext, 'base64', 'utf8')
            decrypted += decipher.final('utf8')

            return decrypted
        } catch (err) {
            // Log if it's the last attempt or just ignore and try next
            continue
        }
    }

    // If we've tried all keys and failed
    console.warn('[Crypto] Decryption failed for all candidate keys. Data may be corrupted or key lost.')
    return null
}

/**
 * Generate a random 32-byte key (hex encoded)
 * @returns {string}
 */
export function generateRandomKey() {
    return crypto.randomBytes(32).toString('hex')
}
