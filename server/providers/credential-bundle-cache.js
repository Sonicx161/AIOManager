// Short-lived owner-scoped cache of decrypted connection credential bundles.
//
// The token route re-read and re-decrypted the AES-256-GCM bundle on every call even
// when nothing was rotated; this cache holds the parsed bundle briefly so a valid vend
// skips both reads. Purging is wired into reconciler's invalidateConnectionCache,
// which every credential write already calls (credential sync, re-auth, profile
// switch, rotated token persistence), so a changed credential is never served stale.
// The route's ownership check stays uncached. A read that started before an
// invalidation never repopulates the cache with the bundle it read.

const TTL_MS = 30 * 1000
const MAX_ENTRIES = 500

/** @type {Map<string, {bundle: object, at: number, syncUser: string}>} */
const entries = new Map()
let generation = 0

export function credentialBundleGeneration() {
    return generation
}

function cacheKey(credentialType, connectionId, accountId, syncUser) {
    return JSON.stringify([credentialType, connectionId, accountId ?? null, syncUser ?? null])
}

export function getCachedCredentialBundle(credentialType, connectionId, accountId, syncUser) {
    const key = cacheKey(credentialType, connectionId, accountId, syncUser)
    const hit = entries.get(key)
    if (!hit) return null
    if (Date.now() - hit.at >= TTL_MS) {
        entries.delete(key)
        return null
    }
    // LRU refresh.
    entries.delete(key)
    entries.set(key, hit)
    return hit.bundle
}

export function setCachedCredentialBundle(credentialType, connectionId, accountId, syncUser, bundle, readGeneration) {
    if (!syncUser || !bundle || typeof bundle !== 'object') return
    if (readGeneration !== generation) return
    if (entries.size >= MAX_ENTRIES) entries.clear()
    entries.set(cacheKey(credentialType, connectionId, accountId, syncUser), { bundle, at: Date.now(), syncUser })
}

export function invalidateCredentialBundleCache(syncUser = null) {
    generation++
    if (!syncUser) {
        entries.clear()
        return
    }
    for (const [key, entry] of entries) {
        if (entry.syncUser === syncUser) entries.delete(key)
    }
}
