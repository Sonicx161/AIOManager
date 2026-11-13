import db from '../db.js'
import { decrypt } from '../crypto.js'
import { FALLBACK_KEYS } from '../keys.js'

const _keyCache = new Map()
const _KEY_CACHE_TTL = 60_000

export async function loadUserKey(userId, provider, binding = null) {
    const cacheKey = `${userId}:${provider}`
    const cached = _keyCache.get(cacheKey)
    if (cached) {
        if (cached.expiresAt > Date.now() && cached.binding === binding) return cached.value
        _keyCache.delete(cacheKey)
    }

    const row = await db.get(
        'SELECT encrypted_key, key_format FROM metadata_keys WHERE user_id = $1 AND provider = $2 LIMIT 1',
        [userId, provider]
    )
    if (row && row.encrypted_key) {
        const plaintext = decrypt(row.encrypted_key, FALLBACK_KEYS)
        if (plaintext) {
            let format = row.key_format
            if (format !== 'v3' && format !== 'v4') {
                if (plaintext.startsWith('eyJ')) format = 'v4'
                else if (/^[0-9a-fA-F]{32}$/.test(plaintext)) format = 'v3'
                else format = 'generic'
            }
            const result = { key: plaintext, format, source: 'user' }
            _keyCache.set(cacheKey, { value: result, binding, expiresAt: Date.now() + _KEY_CACHE_TTL })
            return result
        }
    }
    const nullResult = null
    _keyCache.set(cacheKey, { value: nullResult, binding, expiresAt: Date.now() + _KEY_CACHE_TTL })
    return null
}

export function setUserKey(userId, provider, value, binding = null) {
    const cacheKey = `${userId}:${provider}`
    _keyCache.set(cacheKey, { value, binding, expiresAt: Date.now() + _KEY_CACHE_TTL })
}

export function invalidateUserKey(userId, provider) {
    _keyCache.delete(`${userId}:${provider}`)
}
export function invalidateUserKeys(userId) {
    for (const key of _keyCache.keys()) {
        if (key.startsWith(`${userId}:`)) _keyCache.delete(key)
    }
}
