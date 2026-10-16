import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { setupTestEnv, cleanupTestEnv, encryptForTest } from './helpers.js'
import db from '../db.js'
import { decrypt } from '../crypto.js'
import { FALLBACK_KEYS } from '../keys.js'
import { setCachedAuth } from '../state.js'
import { registerProviderRoutes } from '../routes/providers.js'

let app
before(async () => {
    app = await setupTestEnv()
    registerProviderRoutes(app, {})
    await app.ready()
})
after(async () => {
    await app?.close()
    cleanupTestEnv()
})
beforeEach(async () => {
    await db.run('DELETE FROM server_credentials')
    setCachedAuth('sync:owner-a', 'synthetic-a')
    setCachedAuth('sync:owner-b', 'synthetic-b')
})

async function stored(id, owner, bundle, updatedAt = 1) {
    await db.run(`INSERT INTO server_credentials
        (id, sync_user, account_id, connection_id, credential_type, auth_key, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, owner, id, 'shared-connection', 'nuvio', encryptForTest(JSON.stringify(bundle)), updatedAt])
}
async function post(bundle, accountId = 'new-b') {
    return app.inject({ method: 'POST', url: '/api/providers/connections/shared-connection/credentials',
        headers: { 'x-sync-user': 'owner-b', 'x-sync-password': 'synthetic-b' },
        payload: { accountId, credentialType: 'nuvio', credential: bundle } })
}
async function read(id = 'new-b') {
    const row = await db.get('SELECT auth_key FROM server_credentials WHERE id = $1', [`nuvio:${id}:shared-connection`])
    return JSON.parse(decrypt(row.auth_key, FALLBACK_KEYS))
}

test('credential route cannot copy another owner’s backend for a shared connection id', async () => {
    await stored('a', 'owner-a', { baseUrl: 'https://a.example', publishableKey: 'a-key' }, 100)
    assert.equal((await post({ accessToken: 'new-b-token' })).statusCode, 200)
    assert.deepEqual(await read(), { accessToken: 'new-b-token' })
})

test('route preserves only its owner’s backend and key while retaining incoming tokens', async () => {
    await stored('a', 'owner-a', { baseUrl: 'https://a.example', publishableKey: 'a-key' }, 100)
    await stored('b', 'owner-b', { baseUrl: 'https://b.example', publishableKey: 'b-key' }, 50)
    assert.equal((await post({ accessToken: 'fresh', refreshToken: 'rotated' })).statusCode, 200)
    assert.deepEqual(await read(), { accessToken: 'fresh', refreshToken: 'rotated', baseUrl: 'https://b.example', publishableKey: 'b-key' })
})

test('unreadable or URL-less newer rows do not hide the owner’s usable backend', async () => {
    await stored('older', 'owner-b', { baseUrl: 'https://older.example', publishableKey: 'old-key' }, 1)
    await stored('newer', 'owner-b', { accessToken: 'no-url' }, 2)
    await db.run(`INSERT INTO server_credentials (id, sync_user, connection_id, credential_type, auth_key, updated_at)
        VALUES ('bad', 'owner-b', 'shared-connection', 'nuvio', 'unreadable', 3)`)
    assert.equal((await post({ accessToken: 'fresh', publishableKey: 'explicit-key' })).statusCode, 200)
    assert.deepEqual(await read(), { accessToken: 'fresh', publishableKey: 'explicit-key', baseUrl: 'https://older.example' })
})

test('explicit backend wins and foreign row ids remain forbidden', async () => {
    await stored('a', 'owner-a', { baseUrl: 'https://a.example' }, 100)
    assert.equal((await post({ accessToken: 'fresh', baseUrl: 'https://explicit.example' })).statusCode, 200)
    assert.equal((await read()).baseUrl, 'https://explicit.example')
    await db.run('UPDATE server_credentials SET sync_user = $1 WHERE id = $2', ['owner-a', 'nuvio:new-b:shared-connection'])
    assert.equal((await post({ accessToken: 'attempt' })).statusCode, 403)
    assert.equal((await read()).accessToken, 'fresh')
})
