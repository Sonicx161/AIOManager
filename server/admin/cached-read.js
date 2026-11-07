import db from '../db.js'

export const STATEMENT_TIMEOUT_MS = 3000

// Single-flight TTL cache: concurrent callers share one computation, results live ttlMs.
// A failure is cached for failTtlMs (0 = retry on the next request), so a timing-out query
// is not re-run by every dashboard poll.
export function cachedRead(ttlMs, compute, { now = () => Date.now(), failTtlMs = 0 } = {}) {
    let value
    let at = 0
    let failure = null
    let inflight = null
    const get = () => {
        if (at && now() - at < ttlMs) return Promise.resolve(value)
        if (failure && now() - failure.at < failTtlMs) return Promise.reject(failure.err)
        if (!inflight) {
            inflight = Promise.resolve()
                .then(compute)
                .then((v) => { value = v; at = now(); failure = null; return v }, (err) => { failure = { err, at: now() }; throw err })
                .finally(() => { inflight = null })
        }
        return inflight
    }
    get.peekAt = () => at
    get.reset = () => { at = 0; value = undefined }
    return get
}

// Postgres reads run in one read-only transaction with a statement timeout. SQLite has no
// statement timeout; its reads are bounded by the TTL cache instead.
export async function adminRead(fn) {
    if (db.type !== 'postgres') return fn(db)
    return db.tx(async (tx) => {
        await tx.run('SET TRANSACTION READ ONLY', [])
        await tx.run(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`, [])
        return fn(tx)
    })
}
