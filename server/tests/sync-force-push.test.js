import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import db from '../db.js'
import { setupTestEnv, cleanupTestEnv } from './helpers.js'
import { registerSyncRoutes } from '../routes/sync.js'
import { hashSyncPassword } from '../lib/sync-password.js'
import { decrypt } from '../crypto.js'
import { FALLBACK_KEYS } from '../keys.js'

// Miz-class sync trap regression: a device whose syncedAt predates the cloud row
// must get an explicit conflict (its push is dropped), and force must be the only
// way past the gate — so the escape hatch actually overrides it.

let app

before(async () => {
    app = await setupTestEnv()
    registerSyncRoutes(app)
    await app.ready()
})

after(() => {
    cleanupTestEnv()
})

const inject = (method, url, userId, password, payload) => app.inject({
    method,
    url,
    headers: { 'x-sync-user': userId, 'x-sync-password': password },
    ...(payload !== undefined ? { payload } : {}),
})

test('stale pushes conflict, newer devices write, and force overrides the gate', async () => {
    const userId = 'sync-force-user'
    const password = 'pw-force'
    const start = Date.now()
    await db.run(
        `INSERT INTO kv_store (key, value, password, updated_at, credential_epoch) VALUES ($1, $2, $3, $4, 1)`,
        [userId, 'seed', await hashSyncPassword(password), start - 120000]
    )

    const t1 = start - 60000
    const first = await inject('POST', `/api/sync/${userId}`, userId, password, {
        syncedAt: t1, data: { state: 'v1' }
    })
    assert.equal(first.statusCode, 200)
    assert.equal(first.json().conflict, undefined, 'first push writes the row')

    const other = await inject('POST', `/api/sync/${userId}`, userId, password, {
        syncedAt: Date.now(), data: { state: 'v2' }
    })
    assert.equal(other.statusCode, 200)
    assert.equal(other.json().conflict, undefined, 'newer device writes cleanly')

    const rowBefore = await db.get('SELECT value, updated_at FROM kv_store WHERE key = $1', [userId])
    const stale = await inject('POST', `/api/sync/${userId}`, userId, password, {
        syncedAt: t1, data: { state: 'v3-stale' }
    })
    assert.equal(stale.statusCode, 200)
    assert.equal(stale.json().conflict, true, 'a stale push is rejected as conflict')
    const rowAfterStale = await db.get('SELECT value, updated_at FROM kv_store WHERE key = $1', [userId])
    assert.deepEqual(rowAfterStale, rowBefore, 'a rejected push leaves the cloud row untouched')

    const forced = await inject('POST', `/api/sync/${userId}`, userId, password, {
        syncedAt: t1, force: true, data: { state: 'v3-forced' }
    })
    assert.equal(forced.statusCode, 200)
    assert.equal(forced.json().conflict, undefined, 'force bypasses the conflict gate')
    assert.equal(forced.json().success, true)
    const rowForced = await db.get('SELECT value FROM kv_store WHERE key = $1', [userId])
    const storedState = JSON.parse(decrypt(rowForced.value, FALLBACK_KEYS)).data.state
    assert.equal(storedState, 'v3-forced', 'the forced content is what the cloud holds')
})

test('pulls omit canonicalAddons: pushed for the server fold, never shipped back', async () => {
    const userId = 'canonical-strip-user'
    const password = 'pw-canonical'
    await db.run(
        `INSERT INTO kv_store (key, value, password, updated_at, credential_epoch) VALUES ($1, $2, $3, $4, 1)`,
        [userId, 'seed', await hashSyncPassword(password), Date.now()]
    )

    const pushed = {
        syncedAt: Date.now(),
        accounts: [{ id: 'acc-1', name: 'keeper' }],
        canonicalAddons: { 'acc-1': [{ url: 'https://heavy.example/manifest.json', id: 'x' }] },
    }
    const push = await inject('POST', `/api/sync/${userId}`, userId, password, pushed)
    assert.equal(push.statusCode, 200, push.body)

    const pull = await inject('GET', `/api/sync/${userId}`, userId, password)
    assert.equal(pull.statusCode, 200, pull.body)
    const body = pull.json()
    assert.equal(body.accounts?.length, 1, 'client-consumed slices must survive the pull')
    assert.equal(body.canonicalAddons, undefined, 'write-only slices must never ship back to clients')
})
test('avatarBlob rides the wire verbatim: stored on push, returned on pull', async () => {
    const userId = 'avatar-blob-user'
    const password = 'pw-avatar'
    await db.run(
        `INSERT INTO kv_store (key, value, password, updated_at, credential_epoch) VALUES ($1, $2, $3, $4, 1)`,
        [userId, 'seed', await hashSyncPassword(password), Date.now()]
    )

    const pushed = {
        syncedAt: Date.now(),
        accounts: [{ id: 'acc-1', name: 'keeper' }],
        data: 'v2.abc.def.encrypted-inner-state',
        avatarBlob: 'v2.salt.iv.ciphertext-avatar-blob',
    }
    const push = await inject('POST', `/api/sync/${userId}`, userId, password, pushed)
    assert.equal(push.statusCode, 200, push.body)

    const pull = await inject('GET', `/api/sync/${userId}`, userId, password)
    assert.equal(pull.statusCode, 200, pull.body)
    const body = pull.json()
    assert.equal(body.avatarBlob, 'v2.salt.iv.ciphertext-avatar-blob', 'the transport must carry the avatar blob byte-verbatim')
    assert.equal(body.data, 'v2.abc.def.encrypted-inner-state', 'inner state untouched')
})