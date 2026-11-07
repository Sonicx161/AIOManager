import { decrypt } from '../../crypto.js'
import { FALLBACK_KEYS } from '../../keys.js'

export function createRuleCache({ fastify, nowMs, RULE_CACHE_MAX_BYTES, RULE_CACHE_TTL_MS }) {
    const ruleFetchCache = new Map()
    let ruleFetchCacheBytes = 0
    const ruleCacheStats = { hits: 0, misses: 0, bytesSaved: 0, windowStart: nowMs() }

    // Entries never hold addon_list: the rule cycle keeps chain and state only, and loads the list when a
    // swap or enforcement needs it. A fixed overhead covers the object and the snapshot summary.
    const ENTRY_OVERHEAD_BYTES = 512
    const ruleCacheEntryBytes = (row) => {
        let bytes = ENTRY_OVERHEAD_BYTES
        for (const value of Object.values(row)) if (typeof value === 'string') bytes += Buffer.byteLength(value, 'utf8')
        return bytes
    }

    // platform is checked too: the boot-time platform backfill is the one writer that does not bump updated_at.
    const ruleCacheGet = (id, updatedAt, platform) => {
        if (RULE_CACHE_MAX_BYTES <= 0 || updatedAt == null) return null
        const hit = ruleFetchCache.get(id)
        if (!hit || hit.updatedAt !== updatedAt) return null
        if (platform !== undefined && (hit.row.platform ?? null) !== (platform ?? null)) return null
        if (hit.expires <= nowMs()) {
            ruleFetchCache.delete(id)
            ruleFetchCacheBytes -= hit.bytes
            return null
        }
        ruleFetchCache.delete(id)
        ruleFetchCache.set(id, hit)
        return hit
    }

    const ruleCacheSet = (id, updatedAt, fullRow) => {
        if (RULE_CACHE_MAX_BYTES <= 0 || updatedAt == null) return
        const existing = ruleFetchCache.get(id)
        if (existing) { ruleFetchCache.delete(id); ruleFetchCacheBytes -= existing.bytes }
        const { addon_list: _addonList, ...row } = fullRow
        const entry = { updatedAt, row, snapshot: null, bytes: ruleCacheEntryBytes(row), expires: nowMs() + RULE_CACHE_TTL_MS }
        ruleFetchCache.set(id, entry)
        ruleFetchCacheBytes += entry.bytes
        while (ruleFetchCacheBytes > RULE_CACHE_MAX_BYTES && ruleFetchCache.size > 0) {
            const oldest = ruleFetchCache.keys().next().value
            const o = ruleFetchCache.get(oldest)
            ruleFetchCache.delete(oldest)
            ruleFetchCacheBytes -= o.bytes
        }
    }

    // Chain-member summary of the stored addon_list for one row version (see chainMemberStates).
    const ruleSnapshotGet = (id, updatedAt) => {
        const hit = ruleFetchCache.get(id)
        return hit && hit.updatedAt === updatedAt ? hit.snapshot : null
    }
    const ruleSnapshotSet = (id, updatedAt, snapshot) => {
        const hit = ruleFetchCache.get(id)
        if (hit && hit.updatedAt === updatedAt) hit.snapshot = snapshot
    }

    // A rule whose enforcement failed retries next cycle with the same row version; holding that one list
    // (ciphertext, byte-bounded LRU) keeps the retry from re-reading it every cycle.
    const HELD_LIST_MAX_BYTES = 16 * 1024 * 1024
    const heldLists = new Map()
    let heldListBytes = 0
    const dropHeldList = (id) => {
        const held = heldLists.get(id)
        if (!held) return
        heldLists.delete(id)
        heldListBytes -= held.bytes
    }
    const ruleListGet = (id, updatedAt) => {
        const held = heldLists.get(id)
        if (!held) return null
        if (held.updatedAt !== updatedAt) { dropHeldList(id); return null }
        return held.raw
    }
    const ruleListHold = (id, updatedAt, raw) => {
        dropHeldList(id)
        if (typeof raw !== 'string' || updatedAt == null) return
        const bytes = Buffer.byteLength(raw, 'utf8')
        if (bytes > HELD_LIST_MAX_BYTES) return
        heldLists.set(id, { updatedAt, raw, bytes })
        heldListBytes += bytes
        while (heldListBytes > HELD_LIST_MAX_BYTES && heldLists.size > 0) dropHeldList(heldLists.keys().next().value)
    }

    // Steady-state rules re-decrypt the same version-immutable row fields on every
    // recheck (auth_key, priority_chain, active_url, custom_check_urls, webhook_url;
    // addon_list is decrypted uncached, only when it is loaded). The row cache above already trusts
    // (id, updated_at) as the version of exactly these fields, every writer bumps
    // updated_at, so the decrypted STRINGS are memoized under that version key and
    // re-validated against the exact ciphertext before reuse: a row edited without
    // bumping updated_at still misses. Only immutable strings are stored; parse and
    // every downstream derivation still run per cycle, so no shared mutable object
    // is introduced. Stabilization is deliberately NOT memoized: heartbeats update
    // it in autopilot_rule_stats without touching autopilot_rules.updated_at.
    // TTL and byte bounds are memory hygiene only, freshness is the version key
    // plus ciphertext identity, never the TTL.
    // Sized for public instances: about four small fields per rule, so 65,536 entries hold ~16,000 rules.
    const RULE_DECRYPT_CACHE_MAX_ENTRIES = 65536
    const RULE_DECRYPT_CACHE_MAX_BYTES = 64 * 1024 * 1024
    const ruleDecryptCache = new Map()
    let ruleDecryptCacheBytes = 0
    const ruleDecryptCacheStats = { hits: 0, misses: 0, bytesSaved: 0, evictions: 0, windowStart: nowMs() }

    const evictOldestRuleDecryptEntry = () => {
        const oldest = ruleDecryptCache.keys().next().value
        if (oldest === undefined) return
        ruleDecryptCacheBytes -= ruleDecryptCache.get(oldest).bytes
        ruleDecryptCache.delete(oldest)
        ruleDecryptCacheStats.evictions++
    }

    function decryptRuleField(row, field) {
        const ciphertext = row[field]
        // Legacy plaintext (no IV:cipher:tag shape) never enters the cache.
        if (typeof ciphertext !== 'string' || !ciphertext.includes(':') || ciphertext.startsWith('http')) return decrypt(ciphertext, FALLBACK_KEYS)
        const key = `${row.id}\u0000${row.updated_at ?? 'null'}\u0000${field}`
        const hit = ruleDecryptCache.get(key)
        if (hit) {
            if (hit.cipher === ciphertext && nowMs() - hit.at <= RULE_CACHE_TTL_MS) {
                ruleDecryptCache.delete(key)
                ruleDecryptCache.set(key, hit)
                ruleDecryptCacheStats.hits++
                ruleDecryptCacheStats.bytesSaved += hit.plainBytes
                return hit.plaintext
            }
            // Expired (hygiene) or the ciphertext drifted under the same version
            // key: drop the entry and re-decrypt from the row's current value.
            ruleDecryptCache.delete(key)
            ruleDecryptCacheBytes -= hit.bytes
        }
        const plaintext = decrypt(ciphertext, FALLBACK_KEYS)
        ruleDecryptCacheStats.misses++
        // Failed decrypts (null) are never memoized: serving a cached failure
        // until the row or the process changes could hide a recovery path.
        // Corrupt rows simply re-attempt (and re-fail) every recheck, exactly
        // like the uncached behavior; per-cycle failure recording at the call
        // sites keys off this return value and is unaffected.
        if (plaintext === null || plaintext === undefined) return plaintext
        // Bound the encoded payload bytes. JavaScript strings and Map metadata
        // also have heap overhead, separately limited by the entry count.
        const plainBytes = Buffer.byteLength(plaintext, 'utf8')
        const bytes = Buffer.byteLength(ciphertext, 'utf8') + plainBytes
        // A single entry larger than the whole budget is never stored (storing
        // it would either breach the cap or thrash insert/evict every call).
        if (bytes > RULE_DECRYPT_CACHE_MAX_BYTES) return plaintext
        ruleDecryptCache.set(key, { cipher: ciphertext, plaintext, plainBytes, bytes, at: nowMs() })
        ruleDecryptCacheBytes += bytes
        // Strict cumulative bound: evict oldest until within budget (size > 0
        // so the loop can never strand a lone entry above the cap).
        while (ruleDecryptCacheBytes > RULE_DECRYPT_CACHE_MAX_BYTES && ruleDecryptCache.size > 0) evictOldestRuleDecryptEntry()
        while (ruleDecryptCache.size > RULE_DECRYPT_CACHE_MAX_ENTRIES) evictOldestRuleDecryptEntry()
        return plaintext
    }

    // Owner-scoped drop (Dashboard repair). Rule ids arrive from an owner_sync_user
    // scoped SELECT and never leave the server. dry counts without deleting.
    const dropRuleCaches = (ruleIds, { dry = false } = {}) => {
        const ids = new Set(ruleIds || [])
        let rules = 0
        let ruleDecrypt = 0
        for (const id of ids) {
            const hit = ruleFetchCache.get(id)
            if (hit) {
                rules++
                if (!dry) {
                    ruleFetchCache.delete(id)
                    ruleFetchCacheBytes -= hit.bytes
                }
            }
            const held = heldLists.get(id)
            if (held) {
                rules++
                if (!dry) dropHeldList(id)
            }
        }
        for (const key of [...ruleDecryptCache.keys()]) {
            const id = key.split('\u0000')[0]
            if (!ids.has(id)) continue
            ruleDecrypt++
            if (!dry) {
                ruleDecryptCacheBytes -= ruleDecryptCache.get(key).bytes
                ruleDecryptCache.delete(key)
            }
        }
        return { rules, ruleDecrypt }
    }

    const logStatsWindows = () => {
        if (nowMs() - ruleCacheStats.windowStart >= 5 * 60 * 1000) {
            const total = ruleCacheStats.hits + ruleCacheStats.misses
            if (total > 0) {
                const hitPct = Math.round((ruleCacheStats.hits / total) * 100)
                fastify.log.info({ category: 'Autopilot' }, `Rule cache: ${ruleCacheStats.hits} hits / ${ruleCacheStats.misses} misses (${hitPct}% hit), ~${(ruleCacheStats.bytesSaved / 1048576).toFixed(1)}MB of rule row reads saved from the DB`)
            }
            ruleCacheStats.hits = 0
            ruleCacheStats.misses = 0
            ruleCacheStats.bytesSaved = 0
            ruleCacheStats.windowStart = nowMs()
        }

        if (nowMs() - ruleDecryptCacheStats.windowStart >= 5 * 60 * 1000) {
            const totalDecrypt = ruleDecryptCacheStats.hits + ruleDecryptCacheStats.misses
            if (totalDecrypt > 0) {
                const hitPct = Math.round((ruleDecryptCacheStats.hits / totalDecrypt) * 100)
                fastify.log.info({ category: 'Autopilot' }, `Rule decrypt cache: ${ruleDecryptCacheStats.hits} hits / ${ruleDecryptCacheStats.misses} misses (${hitPct}% hit), ~${(ruleDecryptCacheStats.bytesSaved / 1048576).toFixed(1)}MB of repeated AES-GCM decrypts avoided on steady rules`)
            }
            ruleDecryptCacheStats.hits = 0
            ruleDecryptCacheStats.misses = 0
            ruleDecryptCacheStats.bytesSaved = 0
            ruleDecryptCacheStats.evictions = 0
            ruleDecryptCacheStats.windowStart = nowMs()
        }
    }

    return {
        ruleCacheGet,
        ruleCacheSet,
        ruleCacheStats,
        ruleSnapshotGet,
        ruleSnapshotSet,
        ruleListGet,
        ruleListHold,
        ruleListRelease: dropHeldList,
        decryptRuleField,
        dropRuleCaches,
        logStatsWindows,
        getRuleCacheStats: () => ({ ...ruleCacheStats, entries: ruleFetchCache.size, bytes: ruleFetchCacheBytes, heldLists: heldLists.size, heldListBytes }),
        getRuleDecryptCacheStats: () => ({
            ...ruleDecryptCacheStats,
            entries: ruleDecryptCache.size,
            bytes: ruleDecryptCacheBytes,
        }),
    }
}
