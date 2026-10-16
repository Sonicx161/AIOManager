import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import db from '../db.js'
import { setupTestEnv, cleanupTestEnv, mockFetch, encryptForTest } from './helpers.js'
import { createReconciler, invalidateConnectionCache } from '../providers/reconciler.js'
import { registerProviderRoutes } from '../routes/providers.js'
import { hashSyncPassword } from '../lib/sync-password.js'

// Nuvio addon-list replay: OLD ADDONS MUST NEVER REPLACE the current canonical
// list during sync. The server reads the platform only to compare, then writes
// the canonical list; a stale read is cleaned, never adopted. Synthetic RPC
// doubles only — no live calls (safe-preload blocks unmocked network, and the
// double below throws on any unexpected outbound request).

const USER = 'nuvio-replay-owner'
const PW = 'pw-nuvio-replay'

const A = 'https://cdn-a.invalid/manifest.json'
const B = 'https://cdn-b.invalid/manifest.json'
const OLD1 = 'https://old-1.invalid/manifest.json'
const OLD2 = 'https://old-2.invalid/manifest.json'

function canonAddon(url) {
    return {
        transportUrl: url,
        manifest: { id: `id:${url}`, version: '1.0.0', name: url, types: ['movie'], resources: ['stream'], catalogs: [] },
        flags: { enabled: true },
    }
}

// Nuvio REST row shape (url + manifest). The reconciler accepts transportUrl||url.
function platformRow(url) {
    return {
        url,
        manifest: { id: `id:${url}`, version: '1.0.0', name: url, types: ['movie'], resources: ['stream'], catalogs: [] },
    }
}

function bundle(profileId, token) {
    return {
        accessToken: token,
        refreshToken: `${token}-refresh`,
        expiresAt: Date.now() + 86400000,
        profileId,
        baseUrl: 'https://nuvio.invalid',
        publishableKey: 'pk-test',
    }
}

async function seedNuvio({ id, account, connectionId, profileId, token }) {
    await db.run(
        `INSERT INTO server_credentials (id, sync_user, account_id, auth_key, connection_id, credential_type, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, USER, account, encryptForTest(JSON.stringify(bundle(profileId, token))), connectionId, 'nuvio', Date.now()]
    )
}

// Synthetic Nuvio backend. platformByProfile: profile index -> REST addon rows.
// Any fetch outside this contract throws so a live call can never pass silently.
function nuvioDouble({ platformByProfile = {}, profiles = [], failReadProfiles = [], pushes = [], reads = [], profilePulls = [] } = {}) {
    return mockFetch((call) => {
        const url = call.url
        if (url.includes('/rest/v1/rpc/sync_pull_profiles')) {
            profilePulls.push(url)
            return profiles
        }
        if (url.includes('/rest/v1/rpc/sync_push_addons')) {
            pushes.push(call.body)
            return []
        }
        if (url.includes('/rest/v1/plugins') || url.includes('/rpc/sync_push_plugins')) return []
        if (url.includes('/rest/v1/addons')) {
            reads.push(url)
            const m = url.match(/profile_id=eq\.(\d+)/)
            const idx = m ? Number(m[1]) : 1
            if (failReadProfiles.includes(idx)) return new Response('boom', { status: 500 })
            return platformByProfile[idx] ?? []
        }
        throw new Error(`unexpected Nuvio fetch during replay (no live calls allowed): ${url}`)
    })
}

let app
let reconciler

before(async () => {
    app = await setupTestEnv()
    await db.run(
        `INSERT INTO kv_store (key, value, password, updated_at, credential_epoch) VALUES ($1, 'seed', $2, $3, 1)`,
        [USER, await hashSyncPassword(PW), Date.now()]
    )
    reconciler = createReconciler(app)
    registerProviderRoutes(app, reconciler)
    await app.ready()
})

after(async () => {
    await app?.close()
    cleanupTestEnv()
})

beforeEach(async () => {
    await db.run('DELETE FROM server_credentials')
    invalidateConnectionCache(USER)
})

const syncPost = (accountId, payload) => app.inject({
    method: 'POST',
    url: `/api/providers/sync/${accountId}`,
    headers: { 'x-sync-user': USER, 'x-sync-password': PW },
    payload,
})

test('stale Nuvio list is cleaned to canonical and never adopted', async () => {
    await seedNuvio({ id: 'nuvio:acct-1:conn-1', account: 'acct-1', connectionId: 'conn-1', profileId: 1, token: 'tok-1' })
    const canonical = [canonAddon(A), canonAddon(B)]
    const pushes = []
    const reads = []
    const mock = nuvioDouble({ platformByProfile: { 1: [platformRow(OLD1), platformRow(OLD2)] }, pushes, reads })
    try {
        const connections = await reconciler.resolveConnections('acct-1', USER)
        assert.equal(connections.length, 1)
        const result = await reconciler.reconcileAccount('acct-1', null, connections, canonical, {})
        assert.equal(result.changes.length, 1)
        assert.equal(result.changes[0].platform, 'nuvio')
        assert.deepEqual(result.canonical, canonical, 'canonical returned untouched, never replaced by the stale read')
        assert.equal(pushes.length, 1, 'exactly one corrective write')
        assert.deepEqual(pushes[0].p_addons.map((a) => a.url), [A, B], 'the write carries the canonical list, not the stale remote list')
        assert.equal(pushes[0].p_profile_id, 1)
        assert.ok(reads.some((u) => u.includes('profile_id=eq.1')), 'the stale list was observed via a profile-1 read')
    } finally {
        mock.restore()
    }
})

test('a platform already matching canonical causes no write', async () => {
    await seedNuvio({ id: 'nuvio:acct-2:conn-1', account: 'acct-2', connectionId: 'conn-1', profileId: 1, token: 'tok-2' })
    const canonical = [canonAddon(A), canonAddon(B)]
    const pushes = []
    const mock = nuvioDouble({ platformByProfile: { 1: [platformRow(A), platformRow(B)] }, pushes })
    try {
        const connections = await reconciler.resolveConnections('acct-2', USER)
        const result = await reconciler.reconcileAccount('acct-2', null, connections, canonical, {})
        assert.deepEqual(result.changes, [])
        assert.equal(pushes.length, 0, 'in-sync remote must not be rewritten')
    } finally {
        mock.restore()
    }
})

test('repeated stale results never replace canonical', async () => {
    await seedNuvio({ id: 'nuvio:acct-3:conn-1', account: 'acct-3', connectionId: 'conn-1', profileId: 1, token: 'tok-3' })
    const canonical = [canonAddon(A), canonAddon(B)]
    const pushes = []
    const mock = nuvioDouble({ platformByProfile: { 1: [platformRow(OLD1)] }, pushes })
    try {
        for (let i = 0; i < 3; i++) {
            const connections = await reconciler.resolveConnections('acct-3', USER)
            const result = await reconciler.reconcileAccount('acct-3', null, connections, canonical, {})
            assert.deepEqual(result.canonical, canonical, `pass ${i + 1}: canonical never replaced`)
            assert.deepEqual(pushes[i].p_addons.map((a) => a.url), [A, B], `pass ${i + 1}: stale list cleaned again`)
        }
        assert.equal(pushes.length, 3)
    } finally {
        mock.restore()
    }
})

test('empty canonical without allowCollectionShrink never wipes the platform', async () => {
    await seedNuvio({ id: 'nuvio:acct-4:conn-1', account: 'acct-4', connectionId: 'conn-1', profileId: 1, token: 'tok-4' })
    const pushes = []
    const reads = []
    const mock = nuvioDouble({ platformByProfile: { 1: [platformRow(A)] }, pushes, reads })
    try {
        const connections = await reconciler.resolveConnections('acct-4', USER)
        const result = await reconciler.reconcileAccount('acct-4', null, connections, [], {})
        assert.deepEqual(result.changes, [])
        assert.equal(pushes.length, 0, 'no delete may go out without the deliberate-delete flag')
    } finally {
        mock.restore()
    }
})

test('empty canonical with allowCollectionShrink performs the deliberate delete', async () => {
    await seedNuvio({ id: 'nuvio:acct-5:conn-1', account: 'acct-5', connectionId: 'conn-1', profileId: 1, token: 'tok-5' })
    const pushes = []
    const mock = nuvioDouble({ platformByProfile: { 1: [platformRow(A)] }, pushes })
    try {
        const connections = await reconciler.resolveConnections('acct-5', USER)
        const result = await reconciler.reconcileAccount('acct-5', null, connections, [], { allowCollectionShrink: true })
        assert.equal(result.changes.length, 1)
        assert.equal(pushes.length, 1)
        assert.deepEqual(pushes[0].p_addons, [], 'the deliberate delete pushes an empty list')
    } finally {
        mock.restore()
    }
})

test('a failed platform read still enforces canonical instead of adopting anything', async () => {
    await seedNuvio({ id: 'nuvio:acct-6:conn-1', account: 'acct-6', connectionId: 'conn-1', profileId: 1, token: 'tok-6' })
    const canonical = [canonAddon(A)]
    const pushes = []
    const mock = nuvioDouble({ failReadProfiles: [1], pushes })
    try {
        const connections = await reconciler.resolveConnections('acct-6', USER)
        const result = await reconciler.reconcileAccount('acct-6', null, connections, canonical, {})
        assert.equal(pushes.length, 1, 'unreadable remote assumes needs-write, never needs-adopt')
        assert.deepEqual(pushes[0].p_addons.map((a) => a.url), [A])
        assert.deepEqual(result.canonical, canonical)
    } finally {
        mock.restore()
    }
})

test('writes target each connection profile (profile 1 vs profile 2)', async () => {
    await seedNuvio({ id: 'nuvio:acct-a:conn-a', account: 'acct-a', connectionId: 'conn-a', profileId: 1, token: 'tok-a' })
    await seedNuvio({ id: 'nuvio:acct-b:conn-b', account: 'acct-b', connectionId: 'conn-b', profileId: 2, token: 'tok-b' })
    const canonical = [canonAddon(A), canonAddon(B)]
    const pushes = []
    const reads = []
    const mock = nuvioDouble({ platformByProfile: { 1: [platformRow(OLD1)], 2: [platformRow(OLD2)] }, pushes, reads })
    try {
        for (const accountId of ['acct-a', 'acct-b']) {
            const connections = await reconciler.resolveConnections(accountId, USER)
            assert.equal(connections.length, 1)
            await reconciler.reconcileAccount(accountId, null, connections, canonical, {})
        }
        assert.equal(pushes.length, 2)
        assert.deepEqual(pushes.map((p) => p.p_profile_id).sort(), [1, 2], 'each write lands on its own connection profile')
        for (const p of pushes) assert.deepEqual(p.p_addons.map((a) => a.url), [A, B])
        assert.ok(reads.some((u) => u.includes('profile_id=eq.1')), 'profile 1 was read')
        assert.ok(reads.some((u) => u.includes('profile_id=eq.2')), 'profile 2 was read')
    } finally {
        mock.restore()
    }
})

test('a string profile id resolves via the profiles RPC and never silently falls back', async () => {
    await seedNuvio({ id: 'nuvio:acct-7:conn-1', account: 'acct-7', connectionId: 'conn-1', profileId: 'member-2', token: 'tok-7' })
    const canonical = [canonAddon(A)]
    const pushes = []
    const profilePulls = []
    const mock = nuvioDouble({
        platformByProfile: { 2: [platformRow(OLD1)] },
        profiles: [{ id: 'member-1', profile_index: 1 }, { id: 'member-2', profile_index: 2 }],
        pushes,
        profilePulls,
    })
    try {
        const connections = await reconciler.resolveConnections('acct-7', USER)
        const result = await reconciler.reconcileAccount('acct-7', null, connections, canonical, {})
        assert.ok(profilePulls.length > 0, 'string id triggered a profile resolution RPC')
        assert.equal(pushes.length, 1)
        assert.equal(pushes[0].p_profile_id, 2, 'resolved to member-2, not the primary fallback')
        assert.deepEqual(result.canonical, canonical)
    } finally {
        mock.restore()
    }
})

test('an unresolvable string profile refuses the write instead of hitting the primary', async () => {
    await seedNuvio({ id: 'nuvio:acct-8:conn-1', account: 'acct-8', connectionId: 'conn-1', profileId: 'ghost', token: 'tok-8' })
    const pushes = []
    const mock = nuvioDouble({
        platformByProfile: { 1: [platformRow(OLD1)] },
        profiles: [{ id: 'member-1', profile_index: 1 }],
        pushes,
    })
    try {
        const connections = await reconciler.resolveConnections('acct-8', USER)
        const result = await reconciler.reconcileAccount('acct-8', null, connections, [canonAddon(A)], {})
        assert.equal(pushes.length, 0, 'strict write refuses rather than falling back to the primary profile')
        assert.deepEqual(result.changes, [])
    } finally {
        mock.restore()
    }
})

test('sync route cleans a stale Nuvio list to the client canonical, repeatedly', async () => {
    await seedNuvio({ id: 'nuvio:route-acct:conn-1', account: 'route-acct', connectionId: 'conn-1', profileId: 1, token: 'tok-r' })
    const canonical = [canonAddon(A), canonAddon(B)]
    const pushes = []
    const mock = nuvioDouble({ platformByProfile: { 1: [platformRow(OLD1), platformRow(OLD2)] }, pushes })
    try {
        for (let i = 0; i < 2; i++) {
            const res = await syncPost('route-acct', { addons: canonical })
            assert.equal(res.statusCode, 200, res.body)
            assert.equal(res.json().synced, true)
            assert.equal(res.json().changes.length, 1, `pass ${i + 1}: stale remote triggers one restore`)
        }
        assert.equal(pushes.length, 2)
        for (const p of pushes) assert.deepEqual(p.p_addons.map((a) => a.url), [A, B])
    } finally {
        mock.restore()
    }
})

test('sync route refuses to wipe on empty without the flag, and wipes with it', async () => {
    await seedNuvio({ id: 'nuvio:wipe-acct:conn-1', account: 'wipe-acct', connectionId: 'conn-1', profileId: 1, token: 'tok-w' })
    const pushes = []
    const mock = nuvioDouble({ platformByProfile: { 1: [platformRow(A)] }, pushes })
    try {
        const guarded = await syncPost('wipe-acct', { addons: [] })
        assert.equal(guarded.statusCode, 200)
        assert.deepEqual(guarded.json().changes, [])
        assert.equal(pushes.length, 0, 'empty body without the flag must not wipe')
        const deliberate = await syncPost('wipe-acct', { addons: [], allowCollectionShrink: true })
        assert.equal(deliberate.statusCode, 200)
        assert.equal(pushes.length, 1, 'explicit deliberate delete goes out')
        assert.deepEqual(pushes[0].p_addons, [])
    } finally {
        mock.restore()
    }
})

test('a connection/profile switch retargets the next sync write', async () => {
    await seedNuvio({ id: 'nuvio:switch-acct:conn-1', account: 'switch-acct', connectionId: 'conn-1', profileId: 1, token: 'tok-s' })
    const canonical = [canonAddon(A)]
    const pushes = []
    const reads = []
    const mock = nuvioDouble({ platformByProfile: { 1: [platformRow(OLD1)], 2: [platformRow(OLD2)] }, pushes, reads })
    try {
        const first = await syncPost('switch-acct', { addons: canonical })
        assert.equal(first.statusCode, 200)
        assert.equal(pushes[0].p_profile_id, 1, 'before the switch the write targets profile 1')

        await db.run(`UPDATE server_credentials SET auth_key = $1 WHERE id = $2`, [
            encryptForTest(JSON.stringify(bundle(2, 'tok-s'))),
            'nuvio:switch-acct:conn-1',
        ])
        invalidateConnectionCache(USER)

        const second = await syncPost('switch-acct', { addons: canonical })
        assert.equal(second.statusCode, 200)
        assert.equal(pushes[1].p_profile_id, 2, 'after the switch the write targets profile 2')
        assert.deepEqual(pushes[1].p_addons.map((a) => a.url), [A])
        assert.ok(reads.some((u) => u.includes('profile_id=eq.2')), 'the new profile was read before writing')
    } finally {
        mock.restore()
    }
})
