// Shared GetUser cache for Stremio logins (stremio-12): 60 s TTL plus
// single-flight, keyed per auth key. The raw auth key is never used as a cache
// key, never logged and never shared between logins; only its SHA-256 digest
// is. Failures are not cached. Cleared on vault lock and logout with the rest
// of the display read cache.
import { cachedRead, clearDisplayReadCache } from './display-read-cache.ts'

const USER_TTL_MS = 60 * 1000
const KEY_PREFIX = 'stremio:user:'

export interface CachedStremioUser {
    email: string
    _id: string
    premium_expire?: unknown
    premiumPrefs?: {
        userProfiles?: Record<string, { id: string; name: string; avatar?: string }>
    }
}

async function authKeyDigest(authKey: string): Promise<string> {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(authKey))
    return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('')
}

export function getUserCached(authKey: string, load: (authKey: string) => Promise<CachedStremioUser>): Promise<CachedStremioUser> {
    if (!authKey) return load(authKey)
    return authKeyDigest(authKey).then(digest => cachedRead(`${KEY_PREFIX}${digest}`, () => load(authKey), { ttlMs: USER_TTL_MS }))
}

export function clearStremioUserCache() {
    clearDisplayReadCache(KEY_PREFIX)
}
