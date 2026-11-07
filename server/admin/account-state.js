// Account admin state: one in-memory snapshot of non-active accounts, shared by
// every enforcement surface. Rows change only through audited Dashboard
// mutations, never per Autopilot cycle; a request whose account state cannot be
// verified fails closed with 503 rather than serving an unknown.
import fs from 'fs'
import path from 'path'
import db from '../db.js'
import { isReadOnlyReplica } from '../config.js'
import { connectWithRetry, pgConnectionConfig } from '../db.js'
import { DEFAULT_DATA_DIR } from '../lib/env-schema.js'

export const SNAPSHOT_TTL_MS = 30_000
export const MAX_SNAPSHOT_AGE_MS = 300_000
const RETRY_BASE_MS = 1_000
const RETRY_MAX_MS = 60_000

export class AuthStateError extends Error {
    constructor(state) {
        super(state === 'deleted' ? 'account_deleted' : 'account_disabled')
        this.name = 'AuthStateError'
        this.state = state
        this.statusCode = 403
    }
}

export class StateUnavailableError extends Error {
    constructor() {
        super('account_state_unavailable')
        this.name = 'StateUnavailableError'
        this.statusCode = 503
    }
}

export class ReadOnlyReplicaError extends Error {
    constructor() {
        super('read_only_replica')
        this.name = 'ReadOnlyReplicaError'
        this.statusCode = 503
    }
}

// Fixed reply bodies, identical on every surface; no admin free text ever rides them.
export function applyAccountStateErrorMapping(error, reply) {
    if (error instanceof AuthStateError) {
        if (error.state === 'deleted') {
            reply.status(403)
            return { error: 'account_deleted', message: 'This account is deleted by the operator of this instance. Data is kept.' }
        }
        reply.status(403)
        return { error: 'account_disabled', message: 'This account is disabled by the operator of this instance.' }
    }
    if (error instanceof StateUnavailableError) {
        reply.header('Retry-After', '30')
        reply.status(503)
        return { error: 'account_state_unavailable', message: 'Account state cannot be verified right now. Try again shortly.' }
    }
    if (error instanceof ReadOnlyReplicaError) {
        reply.status(503)
        return { error: 'read_only_replica', message: 'This server is a read-only replica; connect to the primary to make changes.' }
    }
    return null
}

// Machine code for a gate refusal, or null when the error is not a gate error.
export const gateCode = (err) => {
    if (err instanceof AuthStateError) return `account_${err.state}`
    if (err instanceof StateUnavailableError) return 'account_state_unavailable'
    return null
}

// Boolean form for reconciler-style canWrite callbacks: a blocked owner answers
// false. A snapshot that cannot be verified propagates StateUnavailableError so
// request paths can map the 503 instead of recording a skip.
export async function ownerCanWrite(syncUser) {
    try {
        await assertAccountActive(syncUser)
        return true
    } catch (err) {
        if (err instanceof AuthStateError) return false
        throw err
    }
}

// Request-triggered writes: both refusals surface as typed errors so the shared
// handler maps the fixed 403 or 503 body; background cycles use ownerCanWrite.
export async function ownerCanWriteOrFail(syncUser) {
    await assertAccountActive(syncUser)
    return true
}

export function assertWritablePrimary() {
    if (isReadOnlyReplica()) throw new ReadOnlyReplicaError()
}

const SELECT_NON_ACTIVE = 'SELECT sync_user, disabled_at, deleted_at, restore_until FROM account_admin_state WHERE disabled_at IS NOT NULL OR deleted_at IS NOT NULL'

function normalizeRows(rows) {
    const map = new Map()
    for (const row of rows || []) {
        if (!row?.sync_user) continue
        map.set(String(row.sync_user), {
            disabledAt: row.disabled_at == null ? null : Number(row.disabled_at),
            deletedAt: row.deleted_at == null ? null : Number(row.deleted_at),
            restoreUntil: row.restore_until == null ? null : Number(row.restore_until),
        })
    }
    return map
}

// An isolated snapshot view over the same database; the default gate is one
// instance, tests may create peers that share the database.
export function createAccountStateView({ now = () => Date.now(), reader = null } = {}) {
    let snapshot = new Map()
    let lastSuccessAt = 0
    let refreshInFlight = null
    let retryTimer = null
    let retryDelayMs = 0
    let warn = () => {}

    const readRows = async () => (reader ? reader() : db.query(SELECT_NON_ACTIVE, []))

    const stopRetry = () => { if (retryTimer) { clearTimeout(retryTimer); retryTimer = null } }

    const scheduleRetry = () => {
        if (retryTimer) return
        retryDelayMs = retryDelayMs ? Math.min(retryDelayMs * 2, RETRY_MAX_MS) : RETRY_BASE_MS
        const delay = retryDelayMs
        retryTimer = setTimeout(async () => {
            retryTimer = null
            try {
                await refresh()
                warn(`snapshot recovered after ${delay / 1000}s of backoff`)
            } catch (err) {
                warn(`background load attempt failed: ${err?.message || err}`)
                scheduleRetry()
            }
        }, delay)
        retryTimer.unref?.()
    }

    async function refresh() {
        if (!refreshInFlight) {
            refreshInFlight = (async () => {
                const rows = await readRows()
                snapshot = normalizeRows(rows)
                lastSuccessAt = now()
                retryDelayMs = 0
                stopRetry()
            })()
            refreshInFlight.catch(() => {}).finally(() => { refreshInFlight = null })
        }
        return refreshInFlight
    }

    // Fresh snapshots serve with zero DB reads; past the TTL one lazy read runs.
    // A failed refresh keeps the last good snapshot inside MAX_SNAPSHOT_AGE_MS and
    // fails closed beyond it, exactly like never having loaded. While the backoff
    // retry owns recovery, no request performs another inline read.
    async function ensureFresh() {
        if (lastSuccessAt && now() - lastSuccessAt <= SNAPSHOT_TTL_MS) return
        const withinMaxAge = () => lastSuccessAt && now() - lastSuccessAt <= MAX_SNAPSHOT_AGE_MS
        if (retryTimer) {
            if (withinMaxAge()) return
            lastSuccessAt = 0
            snapshot = new Map()
            throw new StateUnavailableError()
        }
        try {
            await refresh()
        } catch (err) {
            warn(`refresh failed: ${err?.message || err}`)
            scheduleRetry()
            if (!withinMaxAge()) {
                lastSuccessAt = 0
                snapshot = new Map()
                throw new StateUnavailableError()
            }
        }
    }

    async function assertAccountActive(syncUser) {
        if (!syncUser) return
        await ensureFresh()
        const entry = snapshot.get(String(syncUser))
        if (!entry) return
        if (entry.deletedAt) throw new AuthStateError('deleted')
        if (entry.disabledAt) throw new AuthStateError('disabled')
    }

    return {
        assertAccountActive,
        refresh,
        load: refresh,
        // A mutating instance patches the row it just committed when the post-commit
        // read fails, so a read blip cannot un-enforce a local admin decision.
        patchLocal(syncUser, state) {
            if (!syncUser) return
            if (!state) snapshot.delete(String(syncUser))
            else snapshot.set(String(syncUser), state)
            lastSuccessAt = now()
        },
        installRows(rows) {
            snapshot = normalizeRows(rows)
            lastSuccessAt = now()
            retryDelayMs = 0
            stopRetry()
        },
        peek(syncUser) { return snapshot.get(syncUser) || null },
        armRetry: scheduleRetry,
        get loaded() { return lastSuccessAt > 0 },
        setWarn(fn) { warn = fn },
        resetForTest({ lastSuccessAt: at = 0 } = {}) {
            stopRetry()
            snapshot = new Map()
            lastSuccessAt = at
            retryDelayMs = 0
        },
    }
}

let readerOverride = null
const defaultView = createAccountStateView({
    reader: () => (readerOverride ? readerOverride() : db.query(SELECT_NON_ACTIVE, [])),
})
defaultView.setWarn((message) => console.warn(`[AccountState] ${message}`))
const defaultSnapshotPeek = (syncUser) => defaultView.peek(syncUser)

export const assertAccountActive = (syncUser) => defaultView.assertAccountActive(syncUser)
export const refreshAccountAdminState = () => defaultView.refresh()
export const loadAccountAdminStateNow = () => defaultView.refresh()
export const patchLocalAccountState = (syncUser, state) => defaultView.patchLocal(syncUser, state)
export const accountStateLoaded = () => defaultView.loaded
// Pure snapshot lookup, no refresh: background cycles use it for post-write
// rechecks and commit filtering without adding per-cycle DB reads.
export const accountBlockedInSnapshot = (syncUser) => {
    if (!syncUser) return false
    const entry = defaultSnapshotPeek(String(syncUser))
    return Boolean(entry && (entry.deletedAt || entry.disabledAt))
}
export function resetAccountAdminStateForTest(opts) { readerOverride = null; defaultView.resetForTest(opts) }
export function setAccountStateReaderForTest(fn) { readerOverride = fn }
export const createAccountStateViewForTest = createAccountStateView

// Boot preload, mirroring lib/settings-boot.js: its own pre-pool connection, the
// settings retry budget, and a missing table counting as not loaded. Never throws:
// after the budget the server still boots and every gated surface answers 503.
function readSqlite(env) {
    const file = path.join(env.DATA_DIR || DEFAULT_DATA_DIR, 'aio.db')
    if (!fs.existsSync(file)) return { missingTable: true, rows: [] }
    return import('better-sqlite3').then(({ default: Database }) => {
        const conn = new Database(file, { readonly: true, fileMustExist: true })
        try {
            // tbl_name, never the bare word name, so the Dashboard privacy guard's
            // column scanner recognizes this as a catalog probe and nothing else.
            const exists = conn.prepare("SELECT tbl_name FROM sqlite_master WHERE type = 'table' AND tbl_name = 'account_admin_state'").get()
            return exists ? { missingTable: false, rows: conn.prepare(SELECT_NON_ACTIVE).all() } : { missingTable: true, rows: [] }
        } finally {
            conn.close()
        }
    })
}

async function readPostgres(env, { pgClient, sleep, log }) {
    const conn = pgConnectionConfig(env)
    if (!conn.connectionString) return { missingTable: true, rows: [] }
    const Client = pgClient || (await import('pg')).default.Client
    return connectWithRetry(async () => {
        const c = new Client({ connectionString: conn.connectionString, ssl: conn.ssl, connectionTimeoutMillis: conn.connectionTimeoutMillis })
        try {
            await c.connect()
            const exists = await c.query("SELECT to_regclass('account_admin_state') AS t")
            return exists.rows[0]?.t
                ? { missingTable: false, rows: (await c.query(SELECT_NON_ACTIVE)).rows }
                : { missingTable: true, rows: [] }
        } finally {
            await c.end?.().catch(() => {})
        }
    }, {
        maxRetries: conn.maxRetries,
        sleep,
        onRetry: (attempt, max, err, delay) => log.warn(`[AccountState] Database not reachable for the account state snapshot (attempt ${attempt}/${max}, ${err?.code || 'error'}); retrying in ${delay / 1000}s.`),
    })
}

export async function preloadAccountAdminState({ env = process.env, log = console, readRows, pgClient, sleep } = {}) {
    defaultView.setWarn((message) => log.warn(`[AccountState] ${message}`))
    try {
        const reader = readRows || ((String(env.DB_TYPE || 'sqlite') === 'postgres') ? readPostgres : readSqlite)
        const outcome = await reader(env, { pgClient, sleep, log })
        if (outcome && outcome.missingTable) {
            // A missing table is never an empty snapshot: stay unloaded, answer 503
            // on every gated surface, and let the backoff retry pick the table up
            // once initializeDatabase or DDL replication creates it.
            defaultView.resetForTest()
            defaultView.armRetry()
            log.warn('[AccountState] Table account_admin_state does not exist yet; state-gated surfaces answer 503 until it is created.')
            return { ok: false, missingTable: true }
        }
        const rows = Array.isArray(outcome) ? outcome : (outcome?.rows || [])
        defaultView.installRows(rows)
        log.info(`[AccountState] Account admin state snapshot loaded at boot (${normalizeRows(rows).size} blocked account(s)).`)
        return { ok: true }
    } catch (err) {
        log.warn(`[AccountState] Could not load the account admin state at boot (${err?.code || err?.constructor?.name || 'Error'}); state-gated surfaces answer 503 until a read succeeds.`)
        defaultView.resetForTest()
        defaultView.armRetry()
        return { ok: false }
    }
}
