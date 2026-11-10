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
// Pre-compressed variants (per content_hash + encoding) are built off the request
// path so the hottest pull serves gzip/brotli bytes without re-compressing the same
// payload on every request. A variant is served only when the route negotiated that
// exact encoding, the payload clears the compression threshold, and the variant is
// strictly smaller than the identity bytes.
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
//    deploy). Entries are LRU-evicted by accounted bytes, never by count; variant
//    bytes are accounted in the same totals.

import zlib from 'node:zlib'

const numEnv = (v, fallback) => {
    const n = Number.parseInt(v ?? '', 10)
    return Number.isFinite(n) && n >= 0 ? n : fallback
}

const MAX_TOTAL_BYTES = numEnv(process.env.SYNC_RESPONSE_CACHE_MAX_BYTES, 32 * 1024 * 1024)
const MAX_ITEM_BYTES = numEnv(process.env.SYNC_RESPONSE_CACHE_MAX_ITEM_BYTES, 8 * 1024 * 1024)
const COMPRESS_THRESHOLD_BYTES = 1024

/** @type {Map<string, {contentHash: string, serialized: string, bytes: number, variants: Map<string, {data: Buffer, bytes: number}>}>} */
const entries = new Map()
let totalBytes = 0
const stats = { hits: 0, misses: 0, stores: 0, evictions: 0, itemSkips: 0, invalidations: 0, variantHits: 0, variantSkips: 0 }

function entryBytes(entry) {
    let n = entry.bytes
    for (const v of entry.variants.values()) n += v.bytes
    return n
}

function evictOverflow() {
    while (totalBytes > MAX_TOTAL_BYTES && entries.size > 1) {
        const oldestKey = entries.keys().next().value
        const oldest = entries.get(oldestKey)
        entries.delete(oldestKey)
        totalBytes -= entryBytes(oldest)
        stats.evictions++
    }
}

export function syncResponseCacheEnabled() {
    return MAX_TOTAL_BYTES > 0
}

// Mirrors @fastify/compress's alias handling and never picks an encoding the client
// rated q=0; the framework stays the decision maker for identity and other codecs.
function parseAcceptEncoding(header) {
    if (!header || typeof header !== 'string') return new Map()
    const parsed = new Map()
    for (const part of header.toLowerCase().replace(/\*|x-gzip/g, 'gzip').split(',')) {
        const [token, ...params] = part.trim().split(';')
        if (!token) continue
        let q = 1
        for (const p of params) {
            const m = p.trim().match(/^q=([0-9.]+)$/)
            if (m) {
                const v = Number.parseFloat(m[1])
                if (Number.isFinite(v)) q = v
            }
        }
        parsed.set(token.trim(), q)
    }
    return parsed
}

export function negotiateSyncResponseEncoding(request) {
    const accepted = parseAcceptEncoding(request.headers['accept-encoding'])
    if (accepted.size === 0) return null
    for (const encoding of ['br', 'gzip']) {
        if ((accepted.get(encoding) ?? 0) > 0) return encoding
    }
    return null
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

// Returns the pre-compressed bytes for an exact encoding, or null when not ready
// (the route then falls back to per-request compression).
export function getSyncResponseCacheVariant(accountId, contentHash, encoding) {
    const entry = getSyncResponseCache(accountId, contentHash)
    if (!entry) return null
    const variant = entry.variants.get(encoding)
    if (!variant) {
        if (!entry.variants.has(encoding)) stats.variantSkips++
        return null
    }
    stats.variantHits++
    return variant.data
}

// A replaced entry's stale in-flight build attaches only when its contentHash still
// matches, so a superseded hash can never decorate a newer entry.
function buildVariant(accountId, contentHash, encoding, serialized) {
    const done = (err, data) => {
        const entry = entries.get(accountId)
        if (err || !entry || entry.contentHash !== contentHash) return
        if (!(data instanceof Buffer) || data.length === 0) return
        if (data.length >= entry.bytes || data.length > MAX_ITEM_BYTES) return
        entry.variants.set(encoding, { data, bytes: data.length })
        totalBytes += data.length
        evictOverflow()
    }
    if (encoding === 'gzip') zlib.gzip(serialized, { level: 6 }, done)
    else zlib.brotliCompress(serialized, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } }, done)
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
        totalBytes -= entryBytes(previous)
    }
    const entry = { contentHash, serialized, bytes, variants: new Map() }
    entries.set(accountId, entry)
    totalBytes += bytes
    stats.stores++
    evictOverflow()
    if (bytes < COMPRESS_THRESHOLD_BYTES) return
    buildVariant(accountId, contentHash, 'gzip', serialized)
    buildVariant(accountId, contentHash, 'br', serialized)
}

export function invalidateSyncResponseCache(accountId) {
    if (!accountId) return 0
    const previous = entries.get(accountId)
    if (previous) {
        totalBytes -= entryBytes(previous)
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
