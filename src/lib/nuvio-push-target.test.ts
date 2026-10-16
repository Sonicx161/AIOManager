import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { sourceFunction } from '../../test-support/source-harness.mjs'

// Self-hosted Nuvio push 401s with no request reaching the user's own backend:
// the server-side push targets whatever baseUrl the encrypted credential bundle
// carries, and bundles stored without one silently fall back to the public
// api.nuvio.tv. A self-hosted token rejected there is an unexplainable 401.
// These locks pin the heal at every layer: store (never strip a known baseUrl),
// token vending (heal + refresh against the right backend), connection
// resolution (prefer baseUrl-bearing bundles among dupes), and diagnostics
// (401 names its target).

const here = dirname(fileURLToPath(import.meta.url))

function readSrc(rel: string): string {
    return readFileSync(join(here, '..', '..', rel), 'utf8')
}

test('token refresh heals a missing bundle baseUrl and persists before refreshing', () => {
    const src = readSrc(join('server', 'providers', 'token-refresh.js'))

    assert.match(src, /export function refreshNuvioToken\(connectionId, accountId, heal, syncUser\) \{/)

    const innerStart = src.indexOf('async function refreshNuvioTokenInner')
    const innerEnd = src.indexOf('\nexport function refreshRealStreamToken', innerStart)
    const inner = src.slice(innerStart, innerEnd)

    const healIdx = inner.indexOf('heal?.baseUrl')
    const bundleCheckIdx = inner.indexOf("JSON.parse(decrypt(cred.auth_key")
    const persistIdx = inner.indexOf('await persistRotatedToken(')
    const refreshIdx = inner.indexOf('driver.refreshAccessToken(')

    assert.ok(bundleCheckIdx > -1, 'bundle decrypt found')
    assert.ok(healIdx > bundleCheckIdx, 'heal applies after the bundle is decrypted')
    assert.ok(persistIdx > healIdx, 'healed bundle is persisted')
    assert.ok(refreshIdx > persistIdx, 'refresh runs against the healed baseUrl, not the public default')
})

test('the token route accepts and SSRF-checks a client-supplied baseUrl for the heal', () => {
    const src = readSrc(join('server', 'routes', 'providers.js'))

    const routeStart = src.indexOf("fastify.post('/api/providers/connections/:connectionId/token'")
    const routeEnd = src.indexOf('fastify.post(', routeStart + 10)
    const route = src.slice(routeStart, routeEnd)

    assert.match(route, /const \{ accountId, platform, baseUrl \} = request\.body \|\| \{}/)
    assert.match(route, /isSafeUrlResolved\(baseUrl\)/, 'client-supplied baseUrl must pass the SSRF gate before use')
    assert.match(route, /refreshNuvioToken\(connectionId, accountId, \{ baseUrl[^}]*\}, authUser\)/, 'the refresh is scoped to the caller')
})

test('storing a Nuvio bundle preserves the backend URL from an owner-scoped row', async () => {
    let query = ''
    let params: unknown[] = []
    const preserve = sourceFunction(join(here, '../../server/routes/providers.js'), 'preserveExistingNuvioBaseUrl', {
        db: { query: async (sql: string, values: unknown[]) => { query = sql; params = values; return [{ auth_key: JSON.stringify({ baseUrl: 'https://private.example', publishableKey: 'public-key' }) }] } },
        decrypt: (value: string) => value, FALLBACK_KEYS: [],
    })
    const healed = JSON.parse(await preserve('connection', 'owner', JSON.stringify({ accessToken: 'new-token' })))
    assert.equal(healed.baseUrl, 'https://private.example')
    assert.equal(healed.publishableKey, 'public-key')
    assert.equal(healed.accessToken, 'new-token')
    assert.match(query, /connection_id = \$1 AND sync_user = \$2 AND credential_type = 'nuvio'/)
    assert.deepEqual(params, ['connection', 'owner'])
    assert.deepEqual(await preserve('connection', 'owner', { baseUrl: 'https://explicit.example' }), { baseUrl: 'https://explicit.example' })
})

test('connection resolution prefers a Nuvio bundle carrying its backend URL', async () => {
    const rows = [
        { connection_id: 'new', credential_type: 'nuvio', auth_key: JSON.stringify({ accessToken: 'new-token' }) },
        { connection_id: 'older-custom', credential_type: 'nuvio', auth_key: JSON.stringify({ accessToken: 'custom-token', baseUrl: 'https://private.example' }) },
    ]
    const resolve = sourceFunction(join(here, '../../server/providers/reconciler.js'), 'resolveConnections', {
        db: { query: async () => rows }, decrypt: (value: string) => value, FALLBACK_KEYS: [],
        connectionCache: new Map(), storedConnections: new WeakMap(), connectionCacheGeneration: 0, CONNECTION_CACHE_TTL_MS: 30000,
        preferBaseUrled: (connections: Array<{ platform: string }>, platform: string) => connections.findIndex(c => c.platform === platform),
    })
    const connections = await resolve('account', 'owner')
    assert.equal(connections.length, 1)
    assert.equal(connections[0].id, 'older-custom')
    assert.equal(connections[0].credentials.baseUrl, 'https://private.example')
})

test('a nuvio 401 names the backend it actually hit', () => {
    const src = readSrc(join('server', 'providers', 'nuvio-driver.js'))

    assert.match(src, /usedDefaultBase/, 'driver records whether baseUrl came from the connection or the public default')
    assert.match(src, /target: \$\{baseUrl\}/, 'rpc errors include the resolved target')
    assert.match(src, /No custom Nuvio backend URL is stored/, 'default-fallback 401s say so')
})

test('the token client forwards the explicit optional backend URL without changing the connection id contract', async () => {
    const requests: Array<{ url: string; options: { body: string } }> = []
    const fetchToken = sourceFunction(join(here, '../api/connection.ts'), 'fetchConnectionToken', {
        useSyncStore: { getState: () => ({ serverUrl: 'https://sync.example' }) }, getSyncApiPath: (url: string) => `${url}/api`,
        getAuthHeaders: async () => ({ 'x-sync-id': 'owner' }),
        resilientFetch: async (url: string, options: { body: string }) => { requests.push({ url, options }); return Response.json({ accessToken: 'token', expiresAt: 123, profileId: null }) },
    })
    assert.equal((await fetchToken('account', 'connection', 'nuvio', 'https://private.example')).accessToken, 'token')
    assert.equal(requests[0].url, 'https://sync.example/api/providers/connections/connection/token')
    assert.deepEqual(JSON.parse(requests[0].options.body), { accountId: 'account', platform: 'nuvio', baseUrl: 'https://private.example' })
    await fetchToken('account', 'connection', 'nuvio')
    assert.deepEqual(JSON.parse(requests[1].options.body), { accountId: 'account', platform: 'nuvio' })
})
