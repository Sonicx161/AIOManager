import pg from 'pg'
import Database from 'better-sqlite3'
import db, { pgConnectionConfig } from '../db.js'

const LOCK_KEYS = [0x41494f4d, 1]
const memorySlots = new WeakMap()
const RETRY_MS = 30 * 1000
const APPLICATION_NAME = 'aiomanager-autopilot-lock'

const isPoolerConnection = connectionString => {
    try {
        const url = new URL(connectionString)
        const host = url.hostname.toLowerCase()
        return url.port === '6543' || /pgbouncer|pooler/i.test(host)
    } catch {
        return false
    }
}

export function createWorkerLock({ log, now = () => Date.now(), clientFactory = config => new pg.Client(config), connectionConfig = pgConnectionConfig } = {}) {
    let state = 'idle'
    let pgClient = null
    let sqliteHandle = null
    let memoryClient = null
    const self = {}
    let pending = null
    let lastTry = -Infinity
    let wasStandby = false
    let lockDisabled = false
    const say = (level, message, fields = {}) => log?.[level]?.({ category: 'Autopilot', ...fields }, message)
    const closePgClient = async client => {
        if (!client) return
        client.removeAllListeners?.('end')
        client.removeAllListeners?.('error')
        client.on?.('error', () => {})
        await Promise.resolve(client.end?.()).catch(() => {})
    }
    const lose = (client, message) => {
        if (pgClient !== client) return
        pgClient = null
        state = 'standby'
        wasStandby = true
        say('warn', message)
        void closePgClient(client)
    }
    const disableLock = message => {
        if (!lockDisabled) say('warn', message)
        lockDisabled = true
        state = 'unlocked'
    }
    const lost = client => {
        lose(client, 'Autopilot worker lock connection lost. Standing by until the lock is free again.')
    }
    const acquirePg = async () => {
        const conn = connectionConfig()
        if (isPoolerConnection(conn.connectionString)) {
            disableLock('Autopilot worker lock disabled: DATABASE_URL uses a transaction-mode pooler; running as the worker.')
            return { unlocked: true }
        }
        const client = clientFactory({ connectionString: conn.connectionString, ssl: conn.ssl, connectionTimeoutMillis: conn.connectionTimeoutMillis, keepAlive: true, application_name: APPLICATION_NAME })
        client.on('error', () => lost(client))
        client.on('end', () => lost(client))
        try {
            await client.connect()
            const firstPid = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0]?.pid)
            const secondPid = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0]?.pid)
            if (!firstPid || firstPid !== secondPid) {
                await closePgClient(client)
                disableLock('Autopilot worker lock disabled: PostgreSQL session backend changed between checks; running as the worker.')
                return { unlocked: true }
            }
            const res = await client.query('SELECT pg_try_advisory_lock($1, $2) AS ok', LOCK_KEYS)
            if (res.rows[0]?.ok === true) { pgClient = client; return { acquired: true, pid: firstPid } }
            const holder = await client.query(`
                SELECT l.pid, a.application_name
                FROM pg_locks l
                LEFT JOIN pg_stat_activity a ON a.pid = l.pid
                WHERE l.locktype = 'advisory' AND l.classid = $1 AND l.objid = $2 AND l.granted
                ORDER BY l.pid
                LIMIT 1
            `, LOCK_KEYS)
            await closePgClient(client)
            return { acquired: false, holder: holder.rows[0] || null }
        } catch (err) {
            say('warn', `Autopilot worker lock check failed: ${err.message}`)
        }
        await closePgClient(client)
        return { acquired: false, holder: null }
    }
    const acquireSqlite = () => {
        const dbPath = db.dbPath
        if (!dbPath || dbPath === ':memory:') {
            if (!db.client) return true
            const holder = memorySlots.get(db.client)
            if (holder && holder !== self) return false
            memorySlots.set(db.client, self)
            memoryClient = db.client
            return true
        }
        let handle = null
        try {
            handle = new Database(`${dbPath}.autopilot.lock`, { timeout: 0 })
            handle.exec('BEGIN EXCLUSIVE')
            sqliteHandle = handle
            return true
        } catch (err) {
            try { handle?.close() } catch {}
            if (!/SQLITE_BUSY|database is locked/i.test(`${err.code || ''} ${err.message || ''}`)) say('warn', `Autopilot worker lock check failed: ${err.message}`)
            return false
        }
    }
    const tryAcquire = async () => {
        const result = db.type === 'postgres' ? await acquirePg() : { acquired: acquireSqlite() }
        if (result.unlocked) return true
        const got = result.acquired
        if (got) {
            state = 'holder'
            say('info', wasStandby ? 'Autopilot worker lock acquired: this copy takes over as the worker.' : 'Autopilot worker lock acquired.', result.pid ? { backendPid: result.pid, applicationName: APPLICATION_NAME, state: 'holder' } : { state: 'holder' })
            wasStandby = false
        } else {
            if (state !== 'standby') {
                const holder = result.holder
                const holderText = holder
                    ? ` Holder backend pid=${holder.pid} application_name=${holder.application_name || '(unknown)'}.`
                    : ' Holder backend details are unavailable.'
                say('warn', `Another AIOManager copy is the Autopilot worker for this database. This copy is on standby: no cycles and no enforcement writes until the lock is free.${holderText}`, {
                    state: 'standby',
                    holderBackendPid: holder?.pid ?? null,
                    holderApplicationName: holder?.application_name ?? null,
                })
            }
            state = 'standby'
            wasStandby = true
        }
        return got
    }
    const ensure = async () => {
        if (state === 'holder' || state === 'unlocked') return true
        if (pending) return pending
        if (state === 'standby' && now() - lastTry < RETRY_MS) return false
        lastTry = now()
        pending = tryAcquire().finally(() => { pending = null })
        return pending
    }
    const fence = async () => {
        if (state === 'unlocked') return true
        if (state !== 'holder') return false
        if (db.type === 'postgres') {
            const client = pgClient
            if (!client) return false
            try {
                const result = await client.query(`
                    SELECT EXISTS (
                        SELECT 1
                        FROM pg_locks
                        WHERE locktype = 'advisory'
                          AND pid = pg_backend_pid()
                          AND classid = $1
                          AND objid = $2
                          AND granted
                    ) AS held
                `, LOCK_KEYS)
                if (result.rows[0]?.held === true) return true
                lose(client, 'Autopilot worker lock ownership was lost. Standing by until the lock is free again.')
                return false
            } catch {
                lose(client, 'Autopilot worker lock fence failed. Standing by until the lock is free again.')
                return false
            }
        }
        try {
            if (sqliteHandle) {
                sqliteHandle.prepare('SELECT 1').get()
                return true
            }
            if (memoryClient) return memorySlots.get(memoryClient) === self
        } catch {}
        state = 'standby'
        wasStandby = true
        say('warn', 'Autopilot worker lock fence failed. Standing by until the lock is free again.')
        return false
    }
    const release = async () => {
        const client = pgClient
        pgClient = null
        if (client) {
            await closePgClient(client)
        }
        if (sqliteHandle) {
            try { sqliteHandle.exec('ROLLBACK'); sqliteHandle.close() } catch {}
            sqliteHandle = null
        }
        if (memoryClient && memorySlots.get(memoryClient) === self) memorySlots.delete(memoryClient)
        memoryClient = null
        state = 'idle'
    }
    return { ensure, fence, release, isStandby: () => state === 'standby', state: () => state }
}
