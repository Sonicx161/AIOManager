import test from 'node:test'
import assert from 'node:assert/strict'
import { saveSessionSyncToken, getSessionSyncCredential, clearSessionSyncToken, resolveSessionWireToken } from './session-sync-token.ts'

// Tests run in a Node worker; install an explicit browser-storage seam first.
Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, writable: true, value: undefined })

test('session credentials survive same-tab reads, stay owner-scoped, and clear on sign-out', async t => {
    const data = new Map<string, string>()
    t.mock.property(globalThis, 'sessionStorage', { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value), removeItem: (key: string) => data.delete(key) })
    assert.equal(saveSessionSyncToken('owner', 'wire-token', 'sync-key'), true)
    assert.deepEqual(getSessionSyncCredential('owner'), { token: 'wire-token', syncKey: 'sync-key' })
    assert.equal(getSessionSyncCredential('other'), null)
    let derived = false
    assert.equal(await resolveSessionWireToken('owner', '', async () => { derived = true; return 'wrong' }), 'wire-token')
    assert.equal(derived, false)
    clearSessionSyncToken()
    assert.equal(getSessionSyncCredential('owner'), null)
    assert.equal(await resolveSessionWireToken('owner', 'password', async p => `derived-${p}`), 'derived-password')
})

test('session persistence rejects incomplete and corrupted credentials', t => {
    const data = new Map<string, string>()
    t.mock.property(globalThis, 'sessionStorage', { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value), removeItem: (key: string) => data.delete(key) })
    assert.equal(saveSessionSyncToken('owner', 'token', ''), false)
    for (const value of ['{bad', '{}', JSON.stringify({ id: 'owner', token: 'token' })]) {
        data.set('aiom-session-sync-token', value)
        assert.equal(getSessionSyncCredential('owner'), null)
    }
})
