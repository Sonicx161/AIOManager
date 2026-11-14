import { AsyncLocalStorage } from 'node:async_hooks'
import { decrypt } from '../../crypto.js'
import { FALLBACK_KEYS } from '../../keys.js'

export function createRuleCache({ fastify, nowMs, RULE_CACHE_MAX_BYTES, RULE_CACHE_TTL_MS, READER_MAX_AGE_MS = 15 * 60 * 1000 }) {
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

    const floors = new Map()
    const FLOOR_LIMIT = 200000
    const FLOOR_MIN_AGE_MS = 60 * 60 * 1000
    const readers = new Map()
    const readerContext = new AsyncLocalStorage()
    let sequence = 0
    let overflow = null
    let invalidVersions = null
    let warnedOverflow = false
    let nextPruneAt = 0
    let protectedPruneAt = Infinity
    let lastReaderSweep = null
    const beginRead = () => {
        const now = nowMs()
        if (lastReaderSweep === null || now < lastReaderSweep || now - lastReaderSweep >= 60000) {
            revokeExpiredReaders()
            lastReaderSweep = now
        }
        const token = ++sequence
        readers.set(token, now)
        return token
    }
    const endRead = (token) => { if (readers.delete(token)) nextPruneAt = overflow ? 0 : Math.min(nextPruneAt, protectedPruneAt) }
    const withRead = (token, fn) => readerContext.run(token, fn)
    const revokeExpiredReaders = () => {
        const now = nowMs()
        for (const [token, started] of readers) {
            if (now - started >= READER_MAX_AGE_MS || now < started) endRead(token)
        }
    }
    const validRead = (token = readerContext.getStore()) => {
        const started = readers.get(token)
        if (started === undefined) return false
        const age = nowMs() - started
        if (age < 0 || age >= READER_MAX_AGE_MS) { endRead(token); return false }
        return true
    }
    const oldestReader = () => {
        revokeExpiredReaders()
        let oldest = Infinity
        for (const token of readers.keys()) oldest = Math.min(oldest, token)
        return oldest
    }
    const pruneFloors = () => {
        const now = nowMs()
        const oldest = oldestReader()
        if (now < nextPruneAt) return
        const cutoff = now - FLOOR_MIN_AGE_MS
        nextPruneAt = Infinity
        protectedPruneAt = Infinity
        for (const [id, floor] of floors) {
            if (floor.all === Infinity) continue
            if (floor.sequence >= oldest) {
                protectedPruneAt = Math.min(protectedPruneAt, floor.at + FLOOR_MIN_AGE_MS)
                continue
            }
            if (floor.at <= cutoff) floors.delete(id)
            else nextPruneAt = Math.min(nextPruneAt, floor.at + FLOOR_MIN_AGE_MS)
        }
        if (overflow) {
            if (overflow.sequence >= oldest) protectedPruneAt = Math.min(protectedPruneAt, overflow.at + FLOOR_MIN_AGE_MS)
            // Newer readers cannot hold a row read before any overflow retirement.
            else overflow = null
        }
    }
    const hashes = (id) => {
        let a = 2166136261, b = 0x9e3779b9
        for (const ch of String(id)) {
            a = Math.imul(a ^ ch.charCodeAt(0), 16777619)
            b = Math.imul(b ^ ch.charCodeAt(0), 2246822519)
        }
        return [a >>> 0, b >>> 0, (a + b) >>> 0]
    }
    // False positives only prevent caching; overflow entries must never be forgotten while readers can use them.
    const contains = (bits, id) => bits && hashes(id).every(hash => {
        const bit = hash % (bits.length * 8)
        return (bits[bit >>> 3] & (1 << (bit & 7))) !== 0
    })
    const mark = (bits, id) => {
        for (const hash of hashes(id)) {
            const bit = hash % (bits.length * 8)
            bits[bit >>> 3] |= 1 << (bit & 7)
        }
    }
    const blocked = (id, version, secrets = false, token = readerContext.getStore()) => {
        if (version == null || !Number.isSafeInteger(Number(version)) || (overflow && token <= overflow.sequence && contains(overflow.bits, id)) || contains(invalidVersions, id)) return true
        const floor = floors.get(id)
        const n = Number(version)
        return !!floor && ((floor.all != null && n <= floor.all) || (secrets && floor.secrets != null && n <= floor.secrets))
    }
    const raiseFloor = (id, kind, version) => {
        let floor = floors.get(id)
        if (!floor && floors.size >= FLOOR_LIMIT) {
            pruneFloors()
            floor = floors.get(id)
            if (!floor && floors.size >= FLOOR_LIMIT) {
                if (!overflow) overflow = { bits: new Uint8Array(1024 * 1024), at: 0, sequence: 0 }
                mark(overflow.bits, id)
                if (!Number.isSafeInteger(Number(version))) {
                    if (!invalidVersions) invalidVersions = new Uint8Array(1024 * 1024)
                    mark(invalidVersions, id)
                }
                overflow.at = nowMs()
                overflow.sequence = ++sequence
                nextPruneAt = Math.min(nextPruneAt, overflow.at + FLOOR_MIN_AGE_MS)
                if (!warnedOverflow) {
                    warnedOverflow = true
                    fastify.log.warn?.({ category: 'Autopilot' }, 'Rule cache retirement overflow is blocking affected cache entries.')
                }
                return
            }
        }
        if (!floor) floors.set(id, floor = { all: null, secrets: null, at: 0, sequence: 0 })
        const n = Number(version)
        if (!Number.isSafeInteger(n)) floor.all = Infinity
        else floor[kind] = floor[kind] == null ? n : Math.max(floor[kind], n)
        floor.at = nowMs()
        floor.sequence = ++sequence
        nextPruneAt = Math.min(nextPruneAt, floor.at + FLOOR_MIN_AGE_MS)
    }

    const ruleCacheSet = (id, updatedAt, fullRow, token) => {
        if (!validRead(token)) return
        if (RULE_CACHE_MAX_BYTES <= 0 || blocked(id, updatedAt, false, token)) return
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
    const ruleSnapshotSet = (id, updatedAt, snapshot, token) => {
        if (!validRead(token) || blocked(id, updatedAt, false, token)) return
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
    const ruleListHold = (id, updatedAt, raw, token) => {
        if (!validRead(token)) return
        if (typeof raw !== 'string' || blocked(id, updatedAt, false, token)) return
        dropHeldList(id)
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

    function decryptRuleField(row, field, token) {
        const ciphertext = row[field]
        // Legacy plaintext (no IV:cipher:tag shape) never enters the cache.
        if (typeof ciphertext !== 'string' || !ciphertext.includes(':') || ciphertext.startsWith('http')) return decrypt(ciphertext, FALLBACK_KEYS)
        if (!validRead(token) || blocked(row.id, row.updated_at, true, token)) return decrypt(ciphertext, FALLBACK_KEYS)
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
        if (plaintext === null || plaintext === undefined || blocked(row.id, row.updated_at, true, token)) return plaintext
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

    const dropRuleSecrets = (id) => {
        const prefix = `${id}\u0000`
        for (const [key, entry] of ruleDecryptCache) {
            if (!key.startsWith(prefix)) continue
            ruleDecryptCacheBytes -= entry.bytes
            ruleDecryptCache.delete(key)
        }
    }

    const retireRuleCaches = (rules) => {
        const rows = rules || []
        const ids = rows.map(row => typeof row === 'object' ? row.id : row)
        for (const row of rows) {
            const id = typeof row === 'object' ? row.id : row
            const version = typeof row === 'object' && row.updated_at != null ? Math.max(nowMs(), Number(row.updated_at)) : nowMs()
            raiseFloor(id, 'all', version)
        }
        return dropRuleCaches(ids)
    }

    const retireRuleSecrets = (id, savedUpdatedAt) => {
        raiseFloor(id, 'secrets', savedUpdatedAt == null ? nowMs() : Number(savedUpdatedAt) - 1)
        dropRuleSecrets(id)
    }

    const sweepExpired = () => {
        pruneFloors()
        const now = nowMs()
        for (const [id, hit] of ruleFetchCache) {
            if (hit.expires > now) continue
            ruleFetchCache.delete(id)
            ruleFetchCacheBytes -= hit.bytes
        }
        for (const [key, entry] of ruleDecryptCache) {
            if (now - entry.at <= RULE_CACHE_TTL_MS) continue
            ruleDecryptCacheBytes -= entry.bytes
            ruleDecryptCache.delete(key)
        }
    }

    const logStatsWindows = () => {
        if (nowMs() - ruleCacheStats.windowStart >= 5 * 60 * 1000) {
            sweepExpired()
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
        beginRead,
        endRead,
        withRead,
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
        retireRuleCaches,
        retireRuleSecrets,
        sweepExpired,
        logStatsWindows,
        getRuleCacheStats: () => ({ ...ruleCacheStats, entries: ruleFetchCache.size, bytes: ruleFetchCacheBytes, floors: floors.size, readers: readers.size, heldLists: heldLists.size, heldListBytes }),
        getRuleDecryptCacheStats: () => ({
            ...ruleDecryptCacheStats,
            entries: ruleDecryptCache.size,
            bytes: ruleDecryptCacheBytes,
        }),
    }
}
