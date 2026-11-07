// Byte-capped in-memory cache for GET /api/sync/:id 200 responses.
//
// Every non-304 pull otherwise pays a full AES-256-GCM decrypt + JSON.parse of the
// stored blob plus a framework re-serialization of the stripped object (audit S1).
// The stored content for an account is exactly identified by its kv_store
// content_hash (the POST path never rewrites a row under an unchanged hash), so a
// response serialized once for (accountId, contentHash) stays byte-identical for as
// long as that hash is current. This cache holds those pre-serialized strings and
// is invalidated on every content-changing push, restore and delete.
//
// Boundaries (deliberate):
//  - Lookup happens only after the route's own auth succeeded; a cached response is
//    never served to a caller the decrypt path would have rejected.
//  - Only object payloads parsed from a successful decrypt are stored. Parse
//    failures, non-object/array payloads and rows without content_hash are not
//    cached, so those paths keep their per-request behavior (including warns).
//  - Two caps bound memory: SYNC_RESPONSE_CACHE_MAX_BYTES (total, default 32 MB)
//    and SYNC_RESPONSE_CACHE_MAX_ITEM_BYTES (per response, default 8 MB). Setting
//    the total cap to 0 disables the cache entirely (ops rollback without a
//    deploy). Entries are LRU-evicted by accounted bytes, never by count.

const numEnv = (v, fallback) => {
    const n = Number.parseInt(v ?? '', 10)
    return Number.isFinite(n) && n >= 0 ? n : fallback
}

const MAX_TOTAL_BYTES = numEnv(process.env.SYNC_RESPONSE_CACHE_MAX_BYTES, 32 * 1024 * 1024)
const MAX_ITEM_BYTES = numEnv(process.env.SYNC_RESPONSE_CACHE_MAX_ITEM_BYTES, 8 * 1024 * 1024)

/** @type {Map<string, {contentHash: string, serialized: string, bytes: number}>} */
const entries = new Map()
let totalBytes = 0
const stats = { hits: 0, misses: 0, stores: 0, evictions: 0, itemSkips: 0, invalidations: 0 }

export function syncResponseCacheEnabled() {
    return MAX_TOTAL_BYTES > 0
}

export function getSyncResponseCache(accountId, contentHash) {
    if (!syncResponseCacheEnabled() || !accountId || !contentHash) return null
    const entry = entries.get(accountId)
    if (!entry || entry.contentHash !== contentHash) {
        stats.misses++
        return null
    }
    // LRU refresh: re-insertion moves the account to the hot end.
    entries.delete(accountId)
    entries.set(accountId, entry)
    stats.hits++
    return entry
}

export function setSyncResponseCache(accountId, contentHash, serialized) {
    if (!syncResponseCacheEnabled() || !accountId || !contentHash || typeof serialized !== 'string') return
    const bytes = Buffer.byteLength(serialized, 'utf8')
    if (bytes > MAX_ITEM_BYTES || bytes > MAX_TOTAL_BYTES) {
        stats.itemSkips++
        return
    }
    const previous = entries.get(accountId)
    if (previous) {
        entries.delete(accountId)
        totalBytes -= previous.bytes
    }
    entries.set(accountId, { contentHash, serialized, bytes })
    totalBytes += bytes
    stats.stores++
    while (totalBytes > MAX_TOTAL_BYTES && entries.size > 1) {
        const oldestKey = entries.keys().next().value
        const oldest = entries.get(oldestKey)
        entries.delete(oldestKey)
        totalBytes -= oldest.bytes
        stats.evictions++
    }
}

export function invalidateSyncResponseCache(accountId) {
    if (!accountId) return 0
    const previous = entries.get(accountId)
    if (previous) {
        totalBytes -= previous.bytes
        stats.invalidations++
    }
    entries.delete(accountId)
    return previous ? 1 : 0
}

// Presence check without touching LRU order or stats (dry-run planning).
export function peekSyncResponseCache(accountId) {
    return entries.has(accountId)
}

export function syncResponseCacheStats() {
    return { ...stats, entries: entries.size, totalBytes, maxTotalBytes: MAX_TOTAL_BYTES, maxItemBytes: MAX_ITEM_BYTES }
}

