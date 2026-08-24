process.env.ENCRYPTION_KEY = 'test-encryption-key-32bytes-long!!'
process.env.ACTIVITY_MAX_ACCOUNTS_PER_CYCLE = '50'

import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'

import db from '../db.js'
import { setupTestEnv, cleanupTestEnv } from './helpers.js'
import { getAccountsForCycle } from '../activity/engine.js'

const PAGE = 50

// The engine's rotation cursor is module state and carries across tests. Each case
// below measures a full pass over the table as it stands, which holds from any start.

// updated_at ascends with the index, so under `ORDER BY updated_at DESC` account 0
// sits last and account N-1 first.
async function seed(count) {
    await db.run('DELETE FROM server_credentials')
    for (let i = 0; i < count; i++) {
        await db.run(
            `INSERT INTO server_credentials (id, sync_user, account_id, account_name, auth_key, credential_type, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [`cred-${String(i).padStart(4, '0')}`, 'user', `acct-${i}`, `name-${i}`, 'key', 'stremio', 1_000_000 + i]
        )
    }
}

async function collect(cycles, onCycle = null) {
    const seen = new Set()
    for (let cycle = 0; cycle < cycles; cycle++) {
        for (const row of await getAccountsForCycle()) seen.add(row.account_id)
        if (onCycle) await onCycle(cycle)
    }
    return seen
}

// What routes/activity.js writes when a client pushes a changed authKey.
function reLogin(accountId) {
    return db.run('UPDATE server_credentials SET updated_at = $1 WHERE account_id = $2', [Date.now(), accountId])
}

function missing(seen, count) {
    const missed = []
    for (let i = 0; i < count; i++) if (!seen.has(`acct-${i}`)) missed.push(`acct-${i}`)
    return missed
}

before(async () => { await setupTestEnv() })
after(() => cleanupTestEnv())

test('every account is reached in ceil(count / page) cycles', async () => {
    for (const count of [1, 7, 49, 50, 51, 120, 200]) {
        await seed(count)
        const cycles = Math.ceil(count / PAGE)
        assert.deepEqual(missing(await collect(cycles), count), [], `${count} accounts in ${cycles} cycles`)
    }
})

test('an account that re-logs in mid-rotation is still scanned', async () => {
    const count = 200
    for (const target of [199, 150, 100, 50, 10, 0]) {
        await seed(count)
        const seen = await collect(Math.ceil(count / PAGE), cycle => (cycle === 0 ? reLogin(`acct-${target}`) : null))
        assert.deepEqual(missing(seen, count), [], `acct-${target} re-logged in during the rotation`)
    }
})

test('an account registering mid-rotation does not displace an existing one', async () => {
    const count = 200
    await seed(count)
    // The table holds count + 1 rows once the registration lands, so a full pass is one cycle longer.
    const seen = await collect(Math.ceil((count + 1) / PAGE), cycle => (cycle === 0
        ? db.run(
            `INSERT INTO server_credentials (id, sync_user, account_id, account_name, auth_key, credential_type, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            ['cred-new', 'user', 'acct-new', 'name-new', 'key', 'stremio', Date.now()])
        : null))
    assert.deepEqual(missing(seen, count), [])
})

test('a deletion mid-rotation does not strand the accounts behind it', async () => {
    await seed(200)
    const seen = await collect(4, cycle => (cycle === 1
        ? db.run("DELETE FROM server_credentials WHERE account_id IN ('acct-150', 'acct-151', 'acct-152')")
        : null))
    const remaining = (await db.query('SELECT account_id FROM server_credentials')).map(row => row.account_id)
    assert.deepEqual(remaining.filter(id => !seen.has(id)), [])
})

test('a cycle never hands back the same account twice', async () => {
    await seed(30)
    for (let cycle = 0; cycle < 3; cycle++) {
        const ids = (await getAccountsForCycle()).map(row => row.account_id)
        assert.equal(new Set(ids).size, ids.length)
    }
})

test('an empty credential table yields an empty cycle', async () => {
    await db.run('DELETE FROM server_credentials')
    assert.deepEqual(await getAccountsForCycle(), [])
})
