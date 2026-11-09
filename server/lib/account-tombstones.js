import db from '../db.js'

// Accounts whose server state an owner deleted. Rule and credential writes for them are
// refused until an explicit restore, so a stale device cannot recreate the rows.
export const ACCOUNT_DELETED_ERROR = 'This account was deleted. Restore it before saving rules or sign-ins.'

const lockTails = new Map()

function acquireLocal(key) {
    const previous = lockTails.get(key) || Promise.resolve()
    let release
    const current = new Promise(resolve => { release = resolve })
    const tail = previous.then(() => current)
    lockTails.set(key, tail)
    return previous.then(() => () => {
        release()
        if (lockTails.get(key) === tail) lockTails.delete(key)
    })
}

const clientConn = (client) => {
    const conn = {
        type: 'postgres',
        query: (sql, params) => client.query(sql, params).then(r => r.rows),
        get: (sql, params) => client.query(sql, params).then(r => r.rows[0]),
        run: (sql, params) => client.query(sql, params).then(r => ({ changes: r.rowCount })),
        exec: (sql) => client.query(sql).then(() => {}),
        tx: async (fn) => {
            await client.query('BEGIN')
            try {
                const result = await fn(conn)
                await client.query('COMMIT')
                return result
            } catch (err) {
                await client.query('ROLLBACK').catch(() => {})
                throw err
            }
        },
    }
    return conn
}

// One serialized section per owner+account: a tombstone check and the write it guards,
// or a server-state deletion, never interleave. Postgres also takes session advisory
// locks so separate server processes serialize on the same keys. fn receives the
// connection to use for every guarded query: on Postgres it is the client holding the
// locks, so the section never needs a second pool connection.
export async function withAccountWriteLock(owner, accountIds, fn) {
    const keys = [...new Set((accountIds || []).filter(id => typeof id === 'string' && id))].sort().map(id => JSON.stringify([owner, id]))
    const releases = []
    let client = null
    try {
        for (const key of keys) releases.push(await acquireLocal(key))
        if (db.type === 'postgres' && keys.length > 0) {
            client = await db.pool.connect()
            for (const key of keys) await client.query('SELECT pg_advisory_lock(hashtext($1))', [key])
        }
        return await fn(client ? clientConn(client) : db)
    } finally {
        if (client) {
            let broken = false
            try { await client.query('SELECT pg_advisory_unlock_all()') } catch { broken = true }
            client.release(broken)
        }
        for (const release of releases.reverse()) release()
    }
}

export async function recordAccountTombstone(tx, owner, accountId, now = Date.now()) {
    await tx.run(
        `INSERT INTO account_server_tombstones (sync_user, account_id, deleted_at) VALUES ($1, $2, $3)
         ON CONFLICT (sync_user, account_id) DO UPDATE SET deleted_at = excluded.deleted_at`,
        [owner, accountId, now]
    )
}

// A deleted account's watch history: the bare scope and every `accountId::connectionId`
// scope. The prefix is compared literally and case-sensitively (LIKE would treat _ and %
// inside an imported id as wildcards, and is case-insensitive on SQLite). An imported id
// may itself contain '::', so scopes that belong to another known account of the same
// owner (`acct::other` and its own scopes) are left alone.
export async function deleteAccountActivity(tx, owner, accountId, liveAccountIds = []) {
    const scoped = `${accountId}::`
    const known = new Set([...liveAccountIds].map(String).filter(id => id !== accountId && id.startsWith(scoped)))
    const sources = [
        ['server_credentials', 'sync_user'],
        ['account_canonical_addons', 'sync_user'],
        ['autopilot_rules', 'owner_sync_user'],
        ['account_server_tombstones', 'sync_user'],
    ]
    for (const [table, ownerColumn] of sources) {
        const rows = await tx.query(
            `SELECT DISTINCT account_id FROM ${table} WHERE ${ownerColumn} = $1 AND substr(account_id, 1, length(CAST($2 AS TEXT))) = CAST($3 AS TEXT)`,
            [owner, scoped, scoped]
        )
        for (const r of rows) known.add(String(r.account_id))
    }
    const ownedByOther = (id) => [...known].some(other => id === other || id.startsWith(`${other}::`))
    for (const table of ['activity_events', 'activity_snapshots']) {
        await tx.run(`DELETE FROM ${table} WHERE sync_user = $1 AND account_id = $2`, [owner, accountId])
        const scopes = await tx.query(
            `SELECT DISTINCT account_id FROM ${table} WHERE sync_user = $1 AND substr(account_id, 1, length(CAST($2 AS TEXT))) = CAST($3 AS TEXT)`,
            [owner, scoped, scoped]
        )
        for (const r of scopes) {
            const id = String(r.account_id)
            if (ownedByOther(id)) continue
            await tx.run(`DELETE FROM ${table} WHERE sync_user = $1 AND account_id = $2`, [owner, id])
        }
    }
}

export async function liftAccountTombstone(owner, accountId) {
    const result = await db.run('DELETE FROM account_server_tombstones WHERE sync_user = $1 AND account_id = $2', [owner, accountId])
    return result?.changes || 0
}

export async function tombstonedAccountIds(owner, accountIds, conn = db) {
    const ids = [...new Set((accountIds || []).filter(id => typeof id === 'string' && id))]
    if (!owner || ids.length === 0) return new Set()
    const rows = await conn.query(
        `SELECT account_id FROM account_server_tombstones WHERE sync_user = $1 AND account_id IN (${ids.map((_, i) => `$${i + 2}`).join(',')})`,
        [owner, ...ids]
    )
    return new Set(rows.map(r => r.account_id))
}

export async function isAccountTombstoned(owner, accountId, conn = db) {
    return (await tombstonedAccountIds(owner, [accountId], conn)).has(accountId)
}
