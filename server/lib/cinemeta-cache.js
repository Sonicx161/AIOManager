import zlib from 'node:zlib'
import { Worker } from 'node:worker_threads'

export const CINEMETA_HIT_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const CINEMETA_MISS_TTL_MS = 24 * 60 * 60 * 1000
export const CINEMETA_DEFAULT_MAX_ROWS = 300000

const MAX_PAYLOAD_BYTES = 256 * 1024
const READ_BUCKETS = [1, 2, 4, 8, 16, 32, 64, 100]
const PRUNE_TARGET_RATIO = 0.95
const DB_RETRY_MS = 60 * 1000
const REFRESH_BACKOFF_MS = 60 * 60 * 1000
const REFRESH_BACKOFF_MAX = 5000
const LOG_INTERVAL_MS = 60 * 1000
const WRITE_DELAY_MS = 150
const WRITE_CHUNK_ROWS = 25
const WRITE_YIELD_MS = 10
const WRITE_PENDING_MAX = 20000
const WRITE_CORRECTIONS_MAX = 200
const WRITE_RETRY_MS = 1000

const SCALAR_KEYS = ['id', 'type', 'name', 'poster', 'background', 'logo', 'description', 'genre', 'runtime', 'imdbRating', 'released', 'releaseInfo', 'year', 'status', 'language', 'moviedb_id']
const VERBATIM_ARRAY_KEYS = ['genres', 'trailers', 'reviews', 'production_companies']

const isObject = (value) => value !== null && typeof value === 'object'

const pickKeys = (source, keys) => {
    const out = {}
    for (const key of keys) {
        if (source[key] !== undefined) out[key] = source[key]
    }
    return out
}

const projectList = (list, keys) => list.filter(isObject).map((item) => pickKeys(item, keys))

// Keeps exactly the fields the client mapping reads from a Cinemeta meta document, so
// the stored and served document maps to the same client meta as the full upstream one.
export function slimCinemetaMeta(raw) {
    if (!isObject(raw) || Array.isArray(raw)) return null
    const out = {}
    for (const key of SCALAR_KEYS) {
        const value = raw[key]
        if (typeof value === 'string' || typeof value === 'number') out[key] = value
    }
    for (const key of VERBATIM_ARRAY_KEYS) {
        if (Array.isArray(raw[key])) out[key] = raw[key]
    }
    if (Array.isArray(raw.credits_cast)) out.credits_cast = projectList(raw.credits_cast, ['name', 'character', 'profile_path'])
    if (Array.isArray(raw.credits_crew)) out.credits_crew = projectList(raw.credits_crew, ['name', 'job', 'role', 'profile_path'])
    if (Array.isArray(raw.related)) out.related = projectList(raw.related, ['id', 'name', 'type', 'poster'])
    if (typeof raw.director === 'string') out.director = raw.director
    else if (Array.isArray(raw.director)) {
        out.director = raw.director.map((item) => (isObject(item) ? pickKeys(item, ['name', 'profile_path']) : item))
    }
    return out
}

// A usable document has a title and, when it names an id, the id that was asked for.
export const isUsableCinemetaMeta = (meta, id) => {
    if (!isObject(meta) || Array.isArray(meta)) return false
    if (typeof meta.name !== 'string' || meta.name.trim() === '') return false
    if (meta.id !== undefined && meta.id !== id) return false
    return true
}

const encodePayload = (meta) => {
    const json = JSON.stringify(meta)
    if (Buffer.byteLength(json) > MAX_PAYLOAD_BYTES) return null
    return zlib.deflateSync(Buffer.from(json))
}

const decodePayload = (payload) => {
    try {
        const meta = JSON.parse(zlib.inflateSync(payload).toString('utf8'))
        return isObject(meta) ? meta : null
    } catch {
        return null
    }
}

const placeholders = (start, count) => Array.from({ length: count }, (_, i) => `$${start + i}`).join(', ')

const bucketFor = (count) => READ_BUCKETS.find((size) => size >= count) ?? count

export const buildRows = (entries, stamp) => {
    const rows = []
    for (const entry of entries) {
        if (entry.status === 404) rows.push([entry.id, entry.type, 404, null, stamp])
        else if (entry.status === 200 && entry.meta) {
            const payload = encodePayload(entry.meta)
            if (payload) rows.push([entry.id, entry.type, 200, payload, stamp])
        }
    }
    return rows
}

// Runs inside a transaction on either connection: upserts the rows, then prunes oldest-first past maxRows.
export const writeRowsInTx = async (t, rows, { rowEstimate, maxRows }) => {
    for (let offset = 0; offset < rows.length; offset += 100) {
        const chunk = rows.slice(offset, offset + 100)
        const values = chunk.map((_, i) => `(${placeholders(i * 5 + 1, 5)})`).join(', ')
        await t.run(
            `INSERT INTO cinemeta_meta_cache (imdb_id, media_type, status, payload, fetched_at) VALUES ${values} ` +
            'ON CONFLICT (imdb_id, media_type) DO UPDATE SET status = excluded.status, payload = excluded.payload, fetched_at = excluded.fetched_at',
            chunk.flat()
        )
    }
    const estimate = (rowEstimate ?? 0) + rows.length
    if (rowEstimate !== null && estimate <= maxRows) return { total: estimate, pruned: 0 }
    const counted = await t.get('SELECT COUNT(*) AS n FROM cinemeta_meta_cache')
    let total = Number(counted?.n ?? 0)
    let pruned = 0
    if (total > maxRows) {
        pruned = total - Math.floor(maxRows * PRUNE_TARGET_RATIO)
        await t.run(
            'DELETE FROM cinemeta_meta_cache WHERE (imdb_id, media_type) IN (SELECT imdb_id, media_type FROM cinemeta_meta_cache ORDER BY fetched_at ASC LIMIT $1)',
            [pruned]
        )
        total -= pruned
    }
    return { total, pruned }
}

const WRITER_TIMEOUT_MS = 30 * 1000

// SQLite commits are synchronous, so a file database writes through its own connection on a
// worker thread: a slow fsync or checkpoint there no longer stalls the HTTP event loop.
const createWriterThread = (dbPath) => {
    let worker = null
    let seq = 0
    const waiting = new Map()
    const fail = (error) => {
        for (const { reject, timer } of waiting.values()) { clearTimeout(timer); reject(error) }
        waiting.clear()
        worker = null
    }
    const ensure = () => {
        if (worker) return worker
        const w = new Worker(new URL('./cinemeta-write-worker.js', import.meta.url), { workerData: { dbPath } })
        w.on('message', ({ id, error, result }) => {
            const pending = waiting.get(id)
            if (!pending) return
            waiting.delete(id)
            clearTimeout(pending.timer)
            if (error) pending.reject(new Error(error))
            else pending.resolve(result)
        })
        w.on('error', (error) => { if (worker === w) fail(error) })
        w.on('exit', () => { if (worker === w) fail(new Error('cinemeta writer exited')) })
        w.unref()
        worker = w
        return w
    }
    return {
        run: (payload) => new Promise((resolve, reject) => {
            const id = ++seq
            const timer = setTimeout(() => { waiting.delete(id); reject(new Error('cinemeta writer timed out')) }, WRITER_TIMEOUT_MS)
            waiting.set(id, { resolve, reject, timer })
            try { ensure().postMessage({ id, ...payload }) } catch (error) { clearTimeout(timer); waiting.delete(id); reject(error) }
        }),
    }
}

const usesFileSqlite = (database) => database?.type === 'sqlite' && typeof database.dbPath === 'string'
    && database.dbPath !== '' && database.dbPath !== ':memory:' && !database.dbPath.startsWith('file::memory:')

export function createCinemetaStore({ database, maxRows = CINEMETA_DEFAULT_MAX_ROWS, readOnly = () => false, now = Date.now, log = null, writerThread = true }) {
    const writer = writerThread && process.env.CINEMETA_WRITER_THREAD === 'on' && usesFileSqlite(database) ? createWriterThread(database.dbPath) : null
    const enabled = () => maxRows > 0
    let disabledUntil = 0
    let rowEstimate = null
    let lastLoggedAt = 0
    const counters = { reads: 0, readErrors: 0, writes: 0, writeErrors: 0, rowsWritten: 0, pruned: 0 }

    const warn = (message) => {
        const at = now()
        if (!log || at - lastLoggedAt < LOG_INTERVAL_MS) return
        lastLoggedAt = at
        log.warn({ category: 'Cinemeta' }, message)
    }

    // Returns a Map keyed "type:id" of { status, meta, fetchedAt }, or null when the table is unusable.
    async function read(ids) {
        if (!enabled() || ids.length === 0 || now() < disabledUntil) return null
        const unique = [...new Set(ids)]
        const out = new Map()
        try {
            for (let offset = 0; offset < unique.length; offset += READ_BUCKETS[READ_BUCKETS.length - 1]) {
                const chunk = unique.slice(offset, offset + READ_BUCKETS[READ_BUCKETS.length - 1])
                const padded = chunk.concat(Array(bucketFor(chunk.length) - chunk.length).fill(chunk[0]))
                const rows = await database.query(
                    `SELECT imdb_id, media_type, status, payload, fetched_at FROM cinemeta_meta_cache WHERE imdb_id IN (${placeholders(1, padded.length)})`,
                    padded
                )
                for (const row of rows) {
                    if (row.status === 404) {
                        out.set(`${row.media_type}:${row.imdb_id}`, { status: 404, meta: null, fetchedAt: Number(row.fetched_at) })
                    } else if (row.status === 200 && row.payload) {
                        const meta = decodePayload(row.payload)
                        if (meta && isUsableCinemetaMeta(meta, row.imdb_id)) out.set(`${row.media_type}:${row.imdb_id}`, { status: 200, meta, fetchedAt: Number(row.fetched_at) })
                    }
                }
            }
            counters.reads++
            return out
        } catch (error) {
            counters.readErrors++
            disabledUntil = now() + DB_RETRY_MS
            warn(`Cinemeta cache read failed, serving from upstream: ${error.message}`)
            return null
        }
    }

    // entries: [{ id, type, status: 200 | 404, meta }]; one transaction, then oldest-first pruning past maxRows.
    async function write(entries) {
        if (!enabled() || readOnly() || entries.length === 0 || now() < disabledUntil) return false
        const stamp = now()
        try {
            let written = null
            if (writer) {
                try {
                    written = await writer.run({ entries, stamp, rowEstimate, maxRows })
                } catch (error) {
                    warn(`Cinemeta writer thread failed, writing inline: ${error.message}`)
                }
            }
            if (!written) {
                const rows = buildRows(entries, stamp)
                if (rows.length === 0) return false
                let outcome = null
                await database.tx(async (t) => { outcome = await writeRowsInTx(t, rows, { rowEstimate, maxRows }) }, { immediate: true })
                written = { rows: rows.length, ...outcome }
            }
            if (written.rows === 0) return false
            counters.pruned += written.pruned
            rowEstimate = written.total
            counters.writes++
            counters.rowsWritten += written.rows
            return true
        } catch (error) {
            counters.writeErrors++
            rowEstimate = null
            warn(`Cinemeta cache write failed: ${error.message}`)
            return false
        }
    }

    const stats = () => ({ ...counters, rows: rowEstimate, maxRows, persistent: enabled(), readOnly: readOnly(), writerThread: Boolean(writer) })
    return { enabled, read, write, stats }
}

const createLru = (max) => {
    const map = new Map()
    return {
        get size() { return map.size },
        get(key, at) {
            const hit = map.get(key)
            if (!hit) return undefined
            if (at >= hit.expiresAt) { map.delete(key); return undefined }
            map.delete(key)
            map.set(key, hit)
            return hit
        },
        set(key, value, { fetchedAt, expiresAt }) {
            map.delete(key)
            map.set(key, { value, fetchedAt, expiresAt })
            while (map.size > max) {
                const oldest = map.keys().next()
                if (oldest.done) break
                map.delete(oldest.value)
            }
        },
        delete(key) { map.delete(key) },
    }
}

export function createCinemetaCache({
    store,
    fetchUpstream,
    now = Date.now,
    hitTtlMs = CINEMETA_HIT_TTL_MS,
    missTtlMs = CINEMETA_MISS_TTL_MS,
    memoryMax = 2000,
    memoryTtlMs = 24 * 60 * 60 * 1000,
    memoryNegativeTtlMs = 5 * 60 * 1000,
    concurrency = 8,
    refreshConcurrency = 2,
    refreshQueueMax = 200,
    readOnly = () => false,
    deferWrites = true,
    writeDelayMs = WRITE_DELAY_MS,
    writeChunk = WRITE_CHUNK_ROWS,
    writeYieldMs = WRITE_YIELD_MS,
}) {
    const positive = createLru(memoryMax)
    const negative = createLru(memoryMax)
    const inflight = new Map()
    const refreshBackoff = new Map()
    const refreshQueue = []
    const refreshQueued = new Set()
    let refreshActive = 0
    const refreshWaiters = []
    const counters = { memoryHits: 0, storeHits: 0, staleServed: 0, upstream: 0, refreshes: 0, refreshFailures: 0 }

    const keyOf = (type, id) => `${type}:${id}`

    // Persistence is best-effort and off the request path: rows are coalesced across batches
    // and written in small transactions with a pause between them, so a slow commit never
    // holds a request and never queues a large write ahead of other database work.
    const pendingWrites = new Map()
    // A refresh 404 that replaces a known positive is corrective: losing it like a cold fill
    // would resurrect the removed title from the old durable row. Corrective 404s get their
    // own bounded queue that cap eviction never drops and a failed chunk write is retried.
    const pendingCorrections = new Map()
    // Keys whose correction has not landed yet stay blocked from local re-admission, so a
    // failed or evicted correction cannot resurrect the old positive in this process. Once
    // this protection set itself overflows and must forget a key, that key's invalidation
    // can no longer be tracked: positiveBypass is latched and durable positive rows are no
    // longer admitted at all (treated as misses and refetched), so forgetting a key cannot
    // resurrect anything. The latch never clears in this process, because the forgotten
    // keys are unknown.
    let positiveBypass = false
    // After a restart a lost correction can serve the stale positive again: this cache is
    // stale-while-revalidate with eventual recovery. The stale serve schedules a refresh
    // whose 404 corrects the row, so recovery is eventual, not immediate, and queue
    // saturation or persistence loss can prolong the stale serving. This is not a
    // guarantee of at most one stale response.
    const lostCorrections = new Set()
    let writeTimer = null
    let flushing = null

    const capCorrections = () => {
        while (pendingCorrections.size > WRITE_CORRECTIONS_MAX) {
            const oldest = pendingCorrections.keys().next().value
            pendingCorrections.delete(oldest)
            lostCorrections.add(oldest)
        }
        while (lostCorrections.size > WRITE_CORRECTIONS_MAX) {
            // The oldest key's protection is dropped while its old durable positive may
            // still be readable: latch the conservative bypass so the forgotten
            // invalidation cannot resurrect that positive.
            positiveBypass = true
            lostCorrections.delete(lostCorrections.keys().next().value)
        }
    }

    const drainPending = async () => {
        for (;;) {
            if (pendingCorrections.size === 0 && pendingWrites.size === 0) return
            const chunk = []
            const corrections = []
            for (const [key, entry] of pendingCorrections) {
                pendingCorrections.delete(key)
                pendingWrites.delete(key)
                chunk.push(entry)
                corrections.push([key, entry])
                if (chunk.length >= writeChunk) break
            }
            for (const [key, entry] of pendingWrites) {
                pendingWrites.delete(key)
                chunk.push(entry)
                if (chunk.length >= writeChunk) break
            }
            let ok = false
            try { ok = await store.write(chunk) } catch { /* best-effort */ }
            if (ok) {
                for (const [key] of corrections) lostCorrections.delete(key)
            } else if (readOnly() || !store.enabled()) {
                // Durable writes are turned off: drop the queued corrections but keep the
                // keys blocked from local re-admission, since a replica may still read the row.
                for (const [key] of corrections) { pendingCorrections.delete(key); lostCorrections.add(key) }
                capCorrections()
            } else {
                // The chunk write failed: cold fills stay discardable, but a lost corrective
                // 404 would resurrect the old positive, so requeue it (bounded) and pause
                // before the next attempt.
                for (const [key, entry] of corrections) {
                    pendingCorrections.delete(key)
                    pendingCorrections.set(key, entry)
                    lostCorrections.add(key)
                }
                capCorrections()
                if (pendingCorrections.size > 0) await new Promise((resolve) => setTimeout(resolve, WRITE_RETRY_MS))
            }
            if (pendingCorrections.size > 0 || pendingWrites.size > 0) await new Promise((resolve) => setTimeout(resolve, writeYieldMs))
        }
    }

    const flush = () => {
        if (writeTimer) { clearTimeout(writeTimer); writeTimer = null }
        if (!flushing) {
            flushing = drainPending().finally(() => {
                flushing = null
                if (pendingCorrections.size > 0 || pendingWrites.size > 0) scheduleFlush()
            })
        }
        return flushing
    }

    const scheduleFlush = () => {
        if (writeTimer || flushing) return
        writeTimer = setTimeout(() => { writeTimer = null; void flush() }, writeDelayMs)
        writeTimer.unref?.()
    }

    const persist = (entries, { corrective = false } = {}) => {
        if (!deferWrites) return store.write(entries)
        if (readOnly() || !store.enabled()) return undefined
        for (const entry of entries) {
            const key = keyOf(entry.type, entry.id)
            if (corrective) {
                pendingCorrections.delete(key)
                pendingCorrections.set(key, entry)
                lostCorrections.delete(key)
                capCorrections()
            } else {
                pendingWrites.delete(key)
                pendingWrites.set(key, entry)
            }
        }
        while (pendingWrites.size > WRITE_PENDING_MAX) pendingWrites.delete(pendingWrites.keys().next().value)
        scheduleFlush()
        return undefined
    }

    const fetchEntry = (type, id) => {
        const key = keyOf(type, id)
        const pending = inflight.get(key)
        if (pending) return pending
        counters.upstream++
        const promise = (async () => {
            const result = await Promise.resolve(fetchUpstream(type, id)).catch(() => ({ status: 0, meta: null }))
            if (result.status === 200) {
                const meta = slimCinemetaMeta(result.meta)
                if (!meta || !isUsableCinemetaMeta(meta, id)) return { status: 502, meta: null }
                negative.delete(key)
                pendingCorrections.delete(key)
                lostCorrections.delete(key)
                positive.set(key, meta, { fetchedAt: now(), expiresAt: now() + memoryTtlMs })
                return { status: 200, meta }
            }
            if (result.status === 404) {
                positive.delete(key)
                negative.set(key, true, { fetchedAt: now(), expiresAt: now() + memoryNegativeTtlMs })
                return { status: 404, meta: null }
            }
            return { status: result.status || 0, meta: null }
        })().finally(() => inflight.delete(key))
        inflight.set(key, promise)
        return promise
    }

    const settleRefreshWaiters = () => {
        if (refreshActive === 0 && refreshQueue.length === 0) refreshWaiters.splice(0).forEach((resolve) => resolve())
    }

    const rememberBackoff = (key) => {
        refreshBackoff.delete(key)
        refreshBackoff.set(key, now())
        while (refreshBackoff.size > REFRESH_BACKOFF_MAX) refreshBackoff.delete(refreshBackoff.keys().next().value)
    }

    const pumpRefresh = () => {
        while (refreshActive < refreshConcurrency && refreshQueue.length > 0) {
            const { type, id } = refreshQueue.shift()
            const key = keyOf(type, id)
            refreshActive++
            void (async () => {
                try {
                    const result = await fetchEntry(type, id)
                    if (result.status === 200) {
                        counters.refreshes++
                        await persist([{ id, type, status: 200, meta: result.meta }])
                    } else if (result.status === 404) {
                        counters.refreshes++
                        await persist([{ id, type, status: 404, meta: null }], { corrective: true })
                    } else {
                        counters.refreshFailures++
                        rememberBackoff(key)
                    }
                } catch {
                    counters.refreshFailures++
                    rememberBackoff(key)
                } finally {
                    refreshQueued.delete(key)
                    refreshActive--
                    pumpRefresh()
                    settleRefreshWaiters()
                }
            })()
        }
    }

    const scheduleRefresh = (type, id) => {
        if (readOnly() || !store.enabled()) return
        const key = keyOf(type, id)
        if (refreshQueued.has(key) || refreshQueue.length >= refreshQueueMax) return
        const failedAt = refreshBackoff.get(key)
        if (failedAt !== undefined && now() - failedAt < REFRESH_BACKOFF_MS) return
        refreshQueued.add(key)
        refreshQueue.push({ type, id })
        pumpRefresh()
    }

    // entries are deduplicated { id, type }; results align with them as { status, meta }.
    async function resolve(entries, { signal } = {}) {
        const results = new Array(entries.length).fill(null)
        const needStore = []
        const at = now()
        entries.forEach((entry, index) => {
            const key = keyOf(entry.type, entry.id)
            const held = positive.get(key, at)
            if (held) {
                results[index] = { status: 200, meta: held.value }
                if (at - held.fetchedAt >= hitTtlMs) {
                    counters.staleServed++
                    scheduleRefresh(entry.type, entry.id)
                } else counters.memoryHits++
                return
            }
            if (negative.get(key, at)) { counters.memoryHits++; results[index] = { status: 404, meta: null }; return }
            needStore.push(index)
        })

        const needUpstream = []
        if (needStore.length > 0) {
            const rows = await store.read(needStore.map((index) => entries[index].id))
            for (const index of needStore) {
                const { id, type } = entries[index]
                const key = keyOf(type, id)
                const row = rows?.get(key)
                if (row) {
                    const age = at - row.fetchedAt
                    if (row.status === 200 && !positiveBypass && !lostCorrections.has(key)) {
                        positive.set(key, row.meta, { fetchedAt: row.fetchedAt, expiresAt: at + memoryTtlMs })
                        results[index] = { status: 200, meta: row.meta }
                        if (age >= hitTtlMs) {
                            counters.staleServed++
                            scheduleRefresh(type, id)
                        } else counters.storeHits++
                        continue
                    }
                    if (row.status === 404 && age < missTtlMs) {
                        negative.set(key, true, { fetchedAt: row.fetchedAt, expiresAt: Math.min(at + memoryNegativeTtlMs, row.fetchedAt + missTtlMs) })
                        results[index] = { status: 404, meta: null }
                        counters.storeHits++
                        continue
                    }
                }
                needUpstream.push(index)
            }
        }

        if (needUpstream.length > 0) {
            const fetched = []
            let next = 0
            const workers = Array.from({ length: Math.min(concurrency, needUpstream.length) }, async () => {
                while (next < needUpstream.length) {
                    if (signal?.aborted) return
                    const index = needUpstream[next++]
                    const { id, type } = entries[index]
                    const result = await fetchEntry(type, id)
                    results[index] = result
                    if (result.status === 200 || result.status === 404) fetched.push({ id, type, status: result.status, meta: result.meta })
                }
            })
            try {
                await Promise.all(workers)
            } finally {
                if (fetched.length > 0) await persist(fetched)
            }
        }
        return results.map((result) => result || { status: 0, meta: null })
    }

    const idle = async () => {
        if (refreshActive !== 0 || refreshQueue.length !== 0) await new Promise((resolve) => refreshWaiters.push(resolve))
        await flush()
    }

    const stats = () => ({
        ...counters,
        hits: counters.memoryHits + counters.storeHits + counters.staleServed,
        misses: counters.upstream,
        stores: store.stats().rowsWritten,
        evictions: store.stats().pruned,
        entries: positive.size,
        negative: negative.size,
        inflight: inflight.size,
        refreshQueued: refreshQueue.length,
        pendingWrites: pendingWrites.size,
        positiveBypass,
        store: store.stats(),
    })

    return { resolve, stats, idle, flush }
}
