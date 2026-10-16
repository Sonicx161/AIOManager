import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import db from '../db.js'
import { setupTestEnv, cleanupTestEnv, mockFetch, encryptForTest } from './helpers.js'
import { registerProviderRoutes } from '../routes/providers.js'
import { hashSyncPassword } from '../lib/sync-password.js'
import { decrypt } from '../crypto.js'
import { FALLBACK_KEYS } from '../keys.js'

// Credential custody scoping: connection_id alone must never select, copy, or overwrite
// another sync user's stored Nuvio/RealStream bundle, and a healed baseUrl must be
// verified before it is trusted.

let app

before(async () => {
    app = await setupTestEnv()
    registerProviderRoutes(app, {})
    await app.ready()
    for (const user of ['victim-user', 'attacker-user', 'owner-user']) {
        await db.run(
            `INSERT INTO kv_store (key, value, password, updated_at, credential_epoch) VALUES ($1, 'seed', $2, $3, 1)`,
            [user, await hashSyncPassword(`pw-${user}`), Date.now()]
        )
    }
})

after(() => { cleanupTestEnv() })

const inject = (method, url, user, payload) => app.inject({
    method,
    url,
    headers: { 'x-sync-user': user, 'x-sync-password': `pw-${user}` },
    ...(payload !== undefined ? { payload } : {}),
})

async function seedCredential({ id, user, account, connectionId, type, bundle }) {
    await db.run(
        `INSERT INTO server_credentials (id, sync_user, account_id, auth_key, connection_id, credential_type, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, user, account, encryptForTest(JSON.stringify(bundle)), connectionId, type, Date.now()]
    )
}

async function readRow(where, params) {
    return db.get(`SELECT id, auth_key FROM server_credentials WHERE ${where}`, params)
}

function parseBundle(row) {
    return row?.auth_key ? JSON.parse(decrypt(row.auth_key, FALLBACK_KEYS)) : null
}

const grantResponse = { status: 200, body: { access_token: 'new-access', refresh_token: 'new-refresh', expires_at: Math.floor(Date.now() / 1000) + 3600 } }

test('PUT credentials: a baseUrl-less re-auth cannot read another user\'s stored instance URL', async () => {
    const conn = 'leak-conn'
    await seedCredential({
        id: 'nuvio:victimAcct:leak-conn', user: 'victim-user', account: 'victimAcct', connectionId: conn, type: 'nuvio',
        bundle: { accessToken: 'vt', refreshToken: 'vrt', baseUrl: 'https://victim.nuvio.example', publishableKey: 'vpk' },
    })

    const res = await inject('POST', `/api/providers/connections/${conn}/credentials`, 'attacker-user', {
        accountId: 'attackerAcct', credentialType: 'nuvio', credential: { accessToken: 'at', refreshToken: 'art' },
    })
    assert.equal(res.statusCode, 200, `attacker PUT succeeds on its own row: ${res.body}`)

    const attackerRow = await readRow('sync_user = $1 AND connection_id = $2', ['attacker-user', conn])
    const attackerBundle = parseBundle(attackerRow)
    assert.ok(attackerBundle, 'attacker row was stored')
    assert.ok(!attackerBundle.baseUrl, 'attacker bundle must not inherit the victim baseUrl')
    assert.ok(!attackerBundle.publishableKey, 'attacker bundle must not inherit the victim publishableKey')

    const victimRow = await readRow('sync_user = $1 AND connection_id = $2', ['victim-user', conn])
    const victimBundle = parseBundle(victimRow)
    assert.equal(victimBundle.baseUrl, 'https://victim.nuvio.example', 'victim row untouched')
})

test('PUT credentials: preserve still carries the owner\'s own baseUrl on re-auth', async () => {
    const conn = 'preserve-conn'
    await seedCredential({
        id: 'nuvio:victimAcct:preserve-conn', user: 'victim-user', account: 'victimAcct', connectionId: conn, type: 'nuvio',
        bundle: { accessToken: 'old', refreshToken: 'old-rt', baseUrl: 'https://self.nuvio.example', publishableKey: 'spk' },
    })

    const res = await inject('POST', `/api/providers/connections/${conn}/credentials`, 'victim-user', {
        accountId: 'victimAcct', credentialType: 'nuvio', credential: { accessToken: 'new', refreshToken: 'new-rt' },
    })
    assert.equal(res.statusCode, 200)

    const row = await readRow('sync_user = $1 AND connection_id = $2', ['victim-user', conn])
    const bundle = parseBundle(row)
    assert.equal(bundle.accessToken, 'new', 'new tokens land')
    assert.equal(bundle.baseUrl, 'https://self.nuvio.example', 'stored instance URL survives a URL-less re-auth')
})

test('token route: another user\'s heal cannot touch the victim bundle or exfil its refresh token', async () => {
    const conn = 'poison-conn'
    const victimBundle = { accessToken: 'vt3', refreshToken: 'vrt3-VICTIM-SECRET', expiresAt: Date.now() - 1000 }
    await seedCredential({
        id: 'nuvio:victimAcct:poison-conn', user: 'victim-user', account: 'victimAcct', connectionId: conn, type: 'nuvio', bundle: victimBundle,
    })
    await seedCredential({
        id: 'nuvio:attackerAcct:poison-conn', user: 'attacker-user', account: 'attackerAcct', connectionId: conn, type: 'nuvio',
        bundle: { accessToken: 'at3', refreshToken: 'art3', expiresAt: Date.now() - 1000 },
    })

    const victimRowBefore = await readRow('sync_user = $1 AND connection_id = $2', ['victim-user', conn])

    const fetchMock = mockFetch(() => grantResponse)
    try {
        const res = await inject('POST', `/api/providers/connections/${conn}/token`, 'attacker-user', {
            accountId: 'attackerAcct', platform: 'nuvio', baseUrl: 'https://evil.example',
        })
        assert.equal(res.statusCode, 200, `attacker refreshes its own row: ${res.body}`)

        const victimRowAfter = await readRow('sync_user = $1 AND connection_id = $2', ['victim-user', conn])
        assert.equal(victimRowAfter.auth_key, victimRowBefore.auth_key, 'victim bundle byte-identical after the attacker call')

        const victimTokenSent = fetchMock.calls.filter(c => c.body?.refresh_token === 'vrt3-VICTIM-SECRET')
        assert.equal(victimTokenSent.length, 0, 'the victim refresh token must never leave the server')
    } finally {
        fetchMock.restore()
    }
})

test('token route: an owner-supplied URL heals a missing backend and targets that backend', async () => {
    const conn = 'probe-conn'
    await seedCredential({
        id: 'nuvio:ownerAcct:probe-conn', user: 'owner-user', account: 'ownerAcct', connectionId: conn, type: 'nuvio',
        bundle: { accessToken: 'ot', refreshToken: 'ort', expiresAt: Date.now() - 1000 },
    })

    const fetchMock = mockFetch(() => grantResponse)
    try {
        const res = await inject('POST', `/api/providers/connections/${conn}/token`, 'owner-user', {
            accountId: 'ownerAcct', platform: 'nuvio', baseUrl: 'https://probe-fail.example',
        })
        assert.equal(res.statusCode, 200, `refresh works against the supplied backend: ${res.body}`)

        const row = await readRow('sync_user = $1 AND connection_id = $2', ['owner-user', conn])
        const bundle = parseBundle(row)
        assert.equal(bundle.baseUrl, 'https://probe-fail.example', 'a missing URL is filled from the authenticated owner request')

        const refreshCalls = fetchMock.calls.filter(c => c.url.includes('grant_type=refresh_token'))
        assert.ok(refreshCalls.length > 0, 'a refresh happened')
        assert.ok(refreshCalls[0].url.startsWith('https://probe-fail.example'), 'refresh targets the owner-supplied instance')
    } finally {
        fetchMock.restore()
    }
})

test('token route: a suggested heal URL does not overwrite an explicitly stored backend', async () => {
    const conn = 'revive-conn'
    await seedCredential({
        id: 'nuvio:ownerAcct:revive-conn', user: 'owner-user', account: 'ownerAcct', connectionId: conn, type: 'nuvio',
        bundle: { accessToken: 'ot5', refreshToken: 'ort5', baseUrl: 'https://stored.example', expiresAt: Date.now() - 1000 },
    })

    const fetchMock = mockFetch(() => grantResponse)
    try {
        const res = await inject('POST', `/api/providers/connections/${conn}/token`, 'owner-user', {
            accountId: 'ownerAcct', platform: 'nuvio', baseUrl: 'https://live.example',
        })
        assert.equal(res.statusCode, 200, `refresh works against the stored backend: ${res.body}`)

        const row = await readRow('sync_user = $1 AND connection_id = $2', ['owner-user', conn])
        assert.equal(parseBundle(row).baseUrl, 'https://stored.example', 'a nonempty stored URL remains authoritative')

        const refreshCalls = fetchMock.calls.filter(c => c.url.includes('grant_type=refresh_token'))
        assert.ok(refreshCalls[0].url.startsWith('https://stored.example'), 'refresh targets the stored backend')
    } finally {
        fetchMock.restore()
    }
})

test('realstream token route: ignores a supplied baseUrl and always targets the hosted default', async () => {
    const conn = 'rs-conn'
    await seedCredential({
        id: 'realstream:ownerAcct:rs-conn', user: 'owner-user', account: 'ownerAcct', connectionId: conn, type: 'realstream',
        bundle: { accessToken: 'rst', userId: 'u1', expiresAt: Date.now() - 1000 },
    })

    const fetchMock = mockFetch(() => {
        return { status: 200, body: { token: 'rs-new-access', record: { id: 'u1' } } }
    })
    try {
        const res = await inject('POST', `/api/providers/connections/${conn}/token`, 'owner-user', {
            accountId: 'ownerAcct', platform: 'realstream', baseUrl: 'https://rs-selfhost.example',
        })
        assert.equal(res.statusCode, 200, `realstream refresh succeeds on the hosted default: ${res.body}`)

        const row = await readRow('sync_user = $1 AND connection_id = $2', ['owner-user', conn])
        assert.equal(parseBundle(row).baseUrl, undefined, 'no baseUrl is persisted for realstream')

        const selfHostedCalls = fetchMock.calls.filter(c => c.url.includes('rs-selfhost.example'))
        assert.equal(selfHostedCalls.length, 0, 'the supplied baseUrl is never contacted')
        const hostedCalls = fetchMock.calls.filter(c => c.url.startsWith('https://realbase.fortheweak.cloud'))
        assert.ok(hostedCalls.length > 0, 'refresh targeted the hosted default')
    } finally {
        fetchMock.restore()
    }
})
