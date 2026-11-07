import { createHash } from 'node:crypto'

// In-memory only. GET pulls serve the last good read for up to CANONICAL_MAX_STALE_MS and
// revalidate in the background past CANONICAL_TTL_MS. Mutations never read from here.
export const CANONICAL_TTL_MS = 30_000
export const CANONICAL_MAX_STALE_MS = 10 * 60_000
const CANONICAL_CACHE_MAX = 2500
const AUTH_KEY_INDEX_MAX = 5000
const KEYS_PER_AUTH_KEY_MAX = 16

const canonicalCache = new Map()
const canonicalInFlight = new Map()
const keysByAuthHash = new Map()

const cacheKey = (accountId, syncUser) => `${syncUser || ''}:${accountId}`
const hashAuthKey = (authKey) => createHash('sha256').update(String(authKey)).digest('hex')

function invalidateKey(key) {
    canonicalCache.delete(key)
    // Dropping the in-flight read makes the next GET start a fresh one, and the
    // identity check below stops the old read from caching pre-write data.
    canonicalInFlight.delete(key)
}

export function invalidateCanonicalAddons(accountId, syncUser) {
    invalidateKey(cacheKey(accountId, syncUser))
}

// Owner-scoped clear (Dashboard repair): keys are `${syncUser}:${accountId}`, so a
// non-empty owner prefix never crosses tenants. Also drops the owner's in-flight reads.
export function invalidateCanonicalForOwner(syncUser) {
    if (!syncUser) return 0
    const prefix = `${syncUser}:`
    // The union of cached and in-flight keys: an in-flight read whose entry is
    // dropped here fails the identity check in refresh() and cannot repopulate.
    const keys = new Set()
    for (const key of canonicalCache.keys()) if (key.startsWith(prefix)) keys.add(key)
    for (const key of canonicalInFlight.keys()) if (key.startsWith(prefix)) keys.add(key)
    for (const key of keys) invalidateKey(key)
    return keys.size
}

export function canonicalCacheCountForOwner(syncUser) {
    if (!syncUser) return 0
    const prefix = `${syncUser}:`
    const keys = new Set()
    for (const key of canonicalCache.keys()) if (key.startsWith(prefix)) keys.add(key)
    for (const key of canonicalInFlight.keys()) if (key.startsWith(prefix)) keys.add(key)
    return keys.size
}

export function rememberCanonicalAuthKey(authKey, accountId, syncUser) {
    if (!authKey) return
    const hash = hashAuthKey(authKey)
    const keys = keysByAuthHash.get(hash) || new Set()
    keysByAuthHash.delete(hash)
    if (keys.size < KEYS_PER_AUTH_KEY_MAX) keys.add(cacheKey(accountId, syncUser))
    keysByAuthHash.set(hash, keys)
    if (keysByAuthHash.size > AUTH_KEY_INDEX_MAX) {
        const oldest = keysByAuthHash.keys().next().value
        if (oldest !== undefined) keysByAuthHash.delete(oldest)
    }
}

export function invalidateCanonicalByAuthKey(authKey) {
    if (!authKey) return 0
    const keys = keysByAuthHash.get(hashAuthKey(authKey))
    if (!keys) return 0
    for (const key of keys) invalidateKey(key)
    return keys.size
}

function refresh(key, load) {
    const existing = canonicalInFlight.get(key)
    if (existing) return existing
    let p
    p = Promise.resolve().then(load).then(value => {
        if (canonicalInFlight.get(key) === p) {
            canonicalCache.delete(key)
            canonicalCache.set(key, { value, at: Date.now() })
            if (canonicalCache.size > CANONICAL_CACHE_MAX) {
                const oldest = canonicalCache.keys().next().value
                if (oldest !== undefined) canonicalCache.delete(oldest)
            }
        }
        return value
    }).finally(() => {
        if (canonicalInFlight.get(key) === p) canonicalInFlight.delete(key)
    })
    canonicalInFlight.set(key, p)
    return p
}

export async function readCanonicalCached(accountId, syncUser, load) {
    const key = cacheKey(accountId, syncUser)
    const entry = canonicalCache.get(key)
    const age = entry ? Date.now() - entry.at : Infinity
    if (entry && age < CANONICAL_TTL_MS) {
        canonicalCache.delete(key)
        canonicalCache.set(key, entry)
        return entry.value
    }
    if (entry && age < CANONICAL_MAX_STALE_MS) {
        refresh(key, load).catch(() => {})
        return entry.value
    }
    if (entry) canonicalCache.delete(key)
    return refresh(key, load)
}

export function _resetCanonicalCacheForTests() {
    canonicalCache.clear()
    canonicalInFlight.clear()
    keysByAuthHash.clear()
}

export function _ageCanonicalEntryForTests(accountId, syncUser, ms) {
    const entry = canonicalCache.get(cacheKey(accountId, syncUser))
    if (entry) entry.at -= ms
}
