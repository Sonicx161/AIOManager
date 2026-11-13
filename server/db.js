import Database from 'better-sqlite3'
import pg from 'pg'
import { AsyncLocalStorage } from 'node:async_hooks'
const { Pool, types } = pg

types.setTypeParser(types.builtins.INT8, (val) => parseInt(val, 10))

let _sqliteTxQueue = Promise.resolve()

const SQLITE_STMT_CACHE_MAX = 500

// Marks the async chain of a running SQLite transaction body with a per-run
// token. Plain writes from chains holding the active token (the body itself)
// run on the connection directly; anything else, including a chain that still
// carries a closed transaction's token, queues behind the open transaction.
const sqliteTxContext = new AsyncLocalStorage()

// Connection settings shared with the boot preload (lib/settings-boot.js).
export function pgConnectionConfig(env = process.env) {
    const connectionString = env.DATABASE_URL
    const isLocalDb = /localhost|127\.0\.0\.1|@db:|aiomanager-db/.test(String(connectionString || ''))
    const rejectUnauthorized = String(env.DB_SSL_REJECT_UNAUTHORIZED || 'false').toLowerCase() !== 'false'
    return {
        connectionString,
        isLocalDb,
        rejectUnauthorized,
        ssl: isLocalDb ? false : { rejectUnauthorized },
        connectionTimeoutMillis: parseInt(env.DB_CONNECTION_TIMEOUT, 10) || 10000,
        maxRetries: parseInt(env.DB_MAX_RETRIES, 10) || 5,
    }
}

// Exponential backoff (1 s, 2 s, 4 s, ...) up to maxRetries attempts; throws the last error.
export async function connectWithRetry(attempt, { maxRetries, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), onRetry = () => {} }) {
    let lastError = null
    for (let i = 1; i <= maxRetries; i++) {
        try {
            return await attempt()
        } catch (err) {
            lastError = err
            if (i < maxRetries) {
                const delay = Math.pow(2, i - 1) * 1000
                onRetry(i, maxRetries, err, delay)
                await sleep(delay)
            }
        }
    }
    throw lastError
}

class DB {
    constructor() {
        this.type = process.env.DB_TYPE || 'sqlite'
        this.client = null
        this.pool = null
        this.isHealthy = false
        this._stmtCache = new Map()
        this._sqliteTxOpen = false
        this._sqliteTxToken = null
    }

    _prepare(sql) {
        const sqliteSql = sql.replace(/\$\d+/g, '?')
        let stmt = this._stmtCache.get(sqliteSql)
        if (!stmt) {
            stmt = this.client.prepare(sqliteSql)
            this._stmtCache.set(sqliteSql, stmt)
            if (this._stmtCache.size > SQLITE_STMT_CACHE_MAX) {
                const oldest = this._stmtCache.keys().next().value
                if (oldest !== undefined) this._stmtCache.delete(oldest)
            }
        }
        return stmt
    }

    async init() {
        if (this.type === 'postgres') {
            if (this.pool) return

            console.log('[Database] Connecting to PostgreSQL...')
            const conn = pgConnectionConfig(process.env)
            const { connectionString, isLocalDb, rejectUnauthorized } = conn
            if (!connectionString) {
                throw new Error('[Database] DATABASE_URL is missing in .env but DB_TYPE is set to postgres')
            }

            if (!isLocalDb && !rejectUnauthorized) {
                console.warn('[Database] PostgreSQL SSL certificate verification is disabled by DB_SSL_REJECT_UNAUTHORIZED=false.')
            }

            this.pool = new Pool({
                connectionString,
                ssl: conn.ssl,
                max: parseInt(process.env.DB_POOL_SIZE, 10) || 20,
                idleTimeoutMillis: 30000,
                connectionTimeoutMillis: conn.connectionTimeoutMillis,
            })

            this.pool.on('error', (err) => {
                console.error('[Database] Unexpected pool error:', err.message)
                this.isHealthy = false
            })

            const maxRetries = conn.maxRetries
            try {
                await connectWithRetry(async () => {
                    const client = await this.pool.connect()
                    client.release()
                }, {
                    maxRetries,
                    onRetry: (attempt, max, err, delay) => {
                        console.warn(`[Database] Connection attempt ${attempt}/${max} failed: ${err.message}`)
                        console.log(`[Database] Retrying in ${delay / 1000}s...`)
                    },
                })
            } catch (lastError) {
                console.warn(`[Database] Connection attempt ${maxRetries}/${maxRetries} failed: ${lastError?.message}`)
                throw new Error(`[Database] Failed to connect after ${maxRetries} attempts: ${lastError?.message}`)
            }
            this.isHealthy = true
            console.log('[Database] Connected to PostgreSQL.')
            return
        } else {
            console.log('[Database] Using SQLite.')
            const dbPath = process.env.SQLITE_DB_PATH || 'data/aio.db'
            this.client = new Database(dbPath)
            this.dbPath = dbPath
            this.isHealthy = true
        }
    }

    async healthCheck() {
        try {
            if (this.type === 'postgres') {
                if (!this.pool) return false
                const client = await this.pool.connect()
                try {
                    await client.query('SELECT 1')
                    this.isHealthy = true
                    return true
                } finally {
                    client.release()
                }
            } else {
                if (!this.client) return false
                this.client.prepare('SELECT 1').get()
                this.isHealthy = true
                return true
            }
        } catch (err) {
            console.error('[Database] Health check failed:', err.message)
            this.isHealthy = false
            return false
        }
    }

    async query(sql, params = []) {
        if (this.type === 'postgres') {
            const res = await this.pool.query(sql, params)
            return res.rows
        } else {
            return this._prepare(sql).all(params)
        }
    }

    async get(sql, params = []) {
        if (this.type === 'postgres') {
            const res = await this.pool.query(sql, params)
            return res.rows[0]
        } else {
            return this._prepare(sql).get(params)
        }
    }

    async run(sql, params = []) {
        if (this.type === 'postgres') {
            const res = await this.pool.query(sql, params)
            return { changes: res.rowCount }
        } else {
            // One connection is shared by every request: while a transaction body
            // is open, another chain's write would land inside it and be rolled
            // back with it after that chain was already told it succeeded, so it
            // waits for the transaction to close instead. Only the chain holding
            // the active token runs directly; a closed transaction's stale token
            // queues like any other foreign write.
            if (this._sqliteTxOpen && sqliteTxContext.getStore() !== this._sqliteTxToken) {
                const queued = _sqliteTxQueue.then(() => this._prepare(sql).run(params))
                _sqliteTxQueue = queued.catch(() => {})
                const info = await queued
                return { changes: info.changes }
            }
            const info = this._prepare(sql).run(params)
            return { changes: info.changes }
        }
    }

    // opts.immediate gives sqlite BEGIN IMMEDIATE (an exclusive write section from the
    // first statement); opts.isolation opens postgres at a raised isolation level, used
    // by the bulk delete confirm with SERIALIZABLE plus a bounded retry.
    async tx(fn, { immediate = false, isolation = null } = {}) {
        if (this.type === 'postgres') {
            const client = await this.pool.connect()
            try {
                await client.query(isolation ? `BEGIN ISOLATION LEVEL ${isolation}` : 'BEGIN')
                const result = await fn({
                    query: (sql, params) => client.query(sql, params).then(r => r.rows),
                    get: (sql, params) => client.query(sql, params).then(r => r.rows[0]),
                    run: (sql, params) => client.query(sql, params).then(r => ({ changes: r.rowCount })),
                })
                await client.query('COMMIT')
                return result
            } catch (err) {
                await client.query('ROLLBACK').catch(() => {})
                throw err
            } finally {
                client.release()
            }
        } else {
            const run = async () => {
                this.client.exec(immediate ? 'BEGIN IMMEDIATE' : 'BEGIN')
                const token = {}
                this._sqliteTxToken = token
                this._sqliteTxOpen = true
                try {
                    const sqliteFns = {
                        query: (sql, params = []) => this._prepare(sql).all(params),
                        get: (sql, params = []) => this._prepare(sql).get(params),
                        run: (sql, params = []) => ({ changes: this._prepare(sql).run(params).changes }),
                    }
                    const result = await sqliteTxContext.run(token, () => fn(sqliteFns))
                    this.client.exec('COMMIT')
                    return result
                } catch (err) {
                    try { this.client.exec('ROLLBACK') } catch {}
                    throw err
                } finally {
                    this._sqliteTxOpen = false
                    if (this._sqliteTxToken === token) this._sqliteTxToken = null
                }
            }
            const next = _sqliteTxQueue.then(run, run)
            _sqliteTxQueue = next.catch(() => {})
            return next
        }
    }

    async exec(sql) {
        if (this.type === 'postgres') {
            await this.pool.query(sql)
        } else {
            if (this._sqliteTxOpen && sqliteTxContext.getStore() !== this._sqliteTxToken) {
                const queued = _sqliteTxQueue.then(() => this.client.exec(sql))
                _sqliteTxQueue = queued.catch(() => {})
                await queued
                return
            }
            this.client.exec(sql)
        }
    }

    async pragma(sql) {
        if (this.type === 'sqlite') {
            return this.client.pragma(sql)
        }
        return null
    }

    async close() {
        if (this.type === 'postgres') {
            if (this.pool) {
                await this.pool.end()
                this.pool = null
            }
        } else {
            if (this.client) {
                this.client.close()
                this.client = null
            }
            this._stmtCache.clear()
            this._sqliteTxOpen = false
            this._sqliteTxToken = null
        }
        this.isHealthy = false
    }
}

const db = new DB()
export default db
