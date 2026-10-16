// Cloud sync consistency: revision base vs wall-clock conflict guard.
// Exercises the actual registerSyncRoutes push/pull handlers over HTTP with an
// in-memory SQLite fixture. No real .env/DB/provider calls.
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import db from '../db.js'
import { setupTestEnv, cleanupTestEnv } from './helpers.js'
import { registerSyncRoutes } from '../routes/sync.js'
import { hashSyncPassword } from '../lib/sync-password.js'
import { decrypt } from '../crypto.js'
import { FALLBACK_KEYS } from '../keys.js'

function storedState(row) {
    return JSON.parse(decrypt(row.value, FALLBACK_KEYS)).data.state
}

let app

before(async () => {
    app = await setupTestEnv()
    registerSyncRoutes(app)
    await app.ready()
})

after(() => {
    cleanupTestEnv()
})

const inject = (method, url, userId, password, payload, headers = {}) => app.inject({
    method,
    url,
    headers: { 'x-sync-user': userId, 'x-sync-password': password, ...headers },
    ...(payload !== undefined ? { payload } : {}),
})

async function seedUser(userId, password) {
    await db.run(
        'INSERT INTO kv_store (key, value, password, updated_at, credential_epoch) VALUES ($1, $2, $3, $4, 1)',
        [userId, 'seed', await hashSyncPassword(password), Date.now() - 120000],
    )
}

test('revision base immunizes a skewed device clock; legacy clock-only push still conflicts', async () => {
    const userId = 'cloud-skew-user'
    const password = 'pw-cloud-skew'
    await seedUser(userId, password)

    // Seed the revision.
    const v1 = await inject('POST', `/api/sync/${userId}`, userId, password, {
        syncedAt: new Date().toISOString(), data: { state: 'v1' },
    })
    assert.equal(v1.statusCode, 200)
    const base = v1.json().contentHash
    assert.ok(typeof base === 'string' && base.length > 0, 'push response carries the revision base')

    // Same device, wall clock 10s behind the server write it just made.
    const slowBaseline = new Date(Date.now() - 10_000).toISOString()
    const modern = await inject('POST', `/api/sync/${userId}`, userId, password, {
        syncedAt: slowBaseline, baseContentHash: base, data: { state: 'v2-skewed-clock' },
    })
    assert.equal(modern.statusCode, 200)
    assert.equal(modern.json().conflict, undefined, 'correct revision base succeeds despite skewed clock')

    // Legacy client without a revision base and the same slow clock conflicts:
    // this is the pre-fix single-device self-conflict mechanism, preserved as fallback.
    const legacy = await inject('POST', `/api/sync/${userId}`, userId, password, {
        syncedAt: slowBaseline, data: { state: 'v3-legacy-slow' },
    })
    assert.equal(legacy.statusCode, 200)
    assert.equal(legacy.json().conflict, true, 'clock-only guard still trips on a slow baseline')
    const row = await db.get('SELECT value FROM kv_store WHERE key = $1', [userId])
    assert.equal(storedState(row), 'v2-skewed-clock', 'rejected legacy push leaves the cloud row untouched')
})

test('stale revision conflicts within the clock tolerance; force still bypasses', async () => {
    const userId = 'cloud-revision-user'
    const password = 'pw-cloud-revision'
    await seedUser(userId, password)

    const v1 = await inject('POST', `/api/sync/${userId}`, userId, password, {
        syncedAt: new Date().toISOString(), data: { state: 'v1' },
    })
    const base1 = v1.json().contentHash

    // Device A advances the revision.
    const aWrite = await inject('POST', `/api/sync/${userId}`, userId, password, {
        syncedAt: new Date().toISOString(), baseContentHash: base1, data: { state: 'v2-by-A' },
    })
    assert.equal(aWrite.json().conflict, undefined)

    // Device B still holds the stale revision: conflict even though far less
    // than 5s elapsed (the clock-only guard would miss this rapid write).
    const bStale = await inject('POST', `/api/sync/${userId}`, userId, password, {
        syncedAt: new Date().toISOString(), baseContentHash: base1, data: { state: 'v2-by-B' },
    })
    assert.equal(bStale.statusCode, 200)
    assert.equal(bStale.json().conflict, true, 'stale revision conflicts on a real later write')
    const rowBefore = await db.get('SELECT value, updated_at FROM kv_store WHERE key = $1', [userId])
    assert.equal(storedState(rowBefore), 'v2-by-A', 'winner state intact after the rejected push')

    // Explicit force bypasses both guards (user action, unchanged).
    const forced = await inject('POST', `/api/sync/${userId}`, userId, password, {
        syncedAt: new Date().toISOString(), baseContentHash: base1, force: true, data: { state: 'v2-forced' },
    })
    assert.equal(forced.json().conflict, undefined)
    const rowForced = await db.get('SELECT value FROM kv_store WHERE key = $1', [userId])
    assert.equal(storedState(rowForced), 'v2-forced')
})

test('conditional pull returns 304 and a conflict never bumps the row', async () => {
    const userId = 'cloud-304-user'
    const password = 'pw-cloud-304'
    await seedUser(userId, password)

    const v1 = await inject('POST', `/api/sync/${userId}`, userId, password, {
        syncedAt: new Date().toISOString(), data: { state: 'v1' },
    })
    const etag = v1.json().contentHash

    const notModified = await inject('GET', `/api/sync/${userId}`, userId, password, undefined, {
        'if-none-match': etag,
    })
    assert.equal(notModified.statusCode, 304, 'matching revision short-circuits the pull')

    const rowBefore = await db.get('SELECT value, updated_at FROM kv_store WHERE key = $1', [userId])
    const rejected = await inject('POST', `/api/sync/${userId}`, userId, password, {
        syncedAt: new Date(Date.now() - 60_000).toISOString(), data: { state: 'stale' },
    })
    assert.equal(rejected.json().conflict, true)
    const rowAfter = await db.get('SELECT value, updated_at FROM kv_store WHERE key = $1', [userId])
    assert.deepEqual(rowAfter, rowBefore, 'conflict path never bumps updated_at, so the deferred pull heals cleanly')

    const full = await inject('GET', `/api/sync/${userId}`, userId, password)
    assert.equal(full.statusCode, 200)
    assert.ok(full.body.includes('v1'), 'post-conflict pull still serves the winner state')
})

test('malformed client baselines fall back safely without crashing', async () => {
    const userId = 'cloud-malformed-user'
    const password = 'pw-cloud-malformed'
    await seedUser(userId, password)

    const v1 = await inject('POST', `/api/sync/${userId}`, userId, password, {
        syncedAt: new Date().toISOString(), data: { state: 'v1' },
    })
    const base = v1.json().contentHash

    // Garbage clock with a correct revision: revision path ignores the clock.
    const withBase = await inject('POST', `/api/sync/${userId}`, userId, password, {
        syncedAt: 'garbage', baseContentHash: base, data: { state: 'v2' },
    })
    assert.equal(withBase.statusCode, 200)
    assert.equal(withBase.json().conflict, undefined)

    // Garbage clock with no revision: unparseable baseline degrades to 0, which
    // the guard treats as unknown (no false conflict, no crash).
    const withoutBase = await inject('POST', `/api/sync/${userId}`, userId, password, {
        syncedAt: 'garbage', data: { state: 'v3' },
    })
    assert.equal(withoutBase.statusCode, 200)
    assert.equal(withoutBase.json().conflict, undefined)
})

test('push responses carry a server timestamp the client can adopt as its baseline', async () => {
    const userId = 'cloud-stamp-user'
    const password = 'pw-cloud-stamp'
    await seedUser(userId, password)

    const push = await inject('POST', `/api/sync/${userId}`, userId, password, {
        syncedAt: new Date(Date.now() - 10_000).toISOString(), data: { state: 'v1' },
    })
    const body = push.json()
    assert.ok(Number.isFinite(Date.parse(body.syncedAt)), 'response syncedAt is a valid server timestamp')
    assert.ok(typeof body.contentHash === 'string', 'response carries the revision for the next base')
})

test('a rejected stale save cannot replace the winning API key registry', async () => {
    const userId = 'cloud-key-registry-user'
    const password = 'pw-cloud-registry'
    await seedUser(userId, password)
    const initial = await inject('POST', `/api/sync/${userId}`, userId, password, { data: { state: 'initial' } })
    const winner = await inject('POST', `/api/sync/${userId}`, userId, password, {
        baseContentHash: initial.json().contentHash,
        accounts: [{ id: 'winner-account' }],
        apiKeys: { 'winner-account': 'synthetic-winner-api-key' },
        data: { state: 'winner' },
    })
    assert.equal(winner.json().conflict, undefined)
    const before = await db.query('SELECT * FROM account_api_keys WHERE sync_user = $1', [userId])
    assert.equal(before.length, 1)
    const loser = await inject('POST', `/api/sync/${userId}`, userId, password, {
        baseContentHash: initial.json().contentHash,
        accounts: [], apiKeys: {}, data: { state: 'loser' },
    })
    assert.equal(loser.json().conflict, true)
    assert.deepEqual(await db.query('SELECT * FROM account_api_keys WHERE sync_user = $1', [userId]), before)
})

test('overlapping writes from one revision produce one winner and one conflict', async () => {
    const userId = 'cloud-overlap-user'
    const password = 'pw-cloud-overlap'
    await seedUser(userId, password)
    const initial = await inject('POST', `/api/sync/${userId}`, userId, password, { data: { state: 'initial' } })
    const baseContentHash = initial.json().contentHash
    const replies = await Promise.all(['A', 'B'].map(state => inject('POST', `/api/sync/${userId}`, userId, password, {
        baseContentHash, data: { state },
    })))
    assert.ok(replies.every(reply => reply.statusCode === 200))
    assert.equal(replies.filter(reply => reply.json().conflict === true).length, 1)
    const winnerIndex = replies.findIndex(reply => reply.json().conflict !== true)
    const row = await db.get('SELECT value FROM kv_store WHERE key = $1', [userId])
    assert.equal(storedState(row), ['A', 'B'][winnerIndex])
})
