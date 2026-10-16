import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { sourceFunction } from '../../test-support/source-harness.mjs'
import { readServerSyncTimestamp } from './pull-restore.ts'

const source = fileURLToPath(new URL('../store/syncStore.ts', import.meta.url))

test('registration installs server time and revision before the first cloud push', async () => {
    const serverTime = '2026-10-16T10:00:00.000Z'
    const serverRevision = 'registration-revision'
    let state: Record<string, unknown> = {}
    let firstPush: Record<string, unknown> | undefined
    const register = sourceFunction(source, 'register', {
        get: () => ({ ...state, serverUrl: '', syncToRemote: async () => { firstPush = { ...state } } }),
        set: (update: Record<string, unknown>) => { state = { ...state, ...update } },
        getSyncApiPath: () => 'https://cloud.example/api',
        resilientFetch: async () => ({ ok: true, json: async () => ({ syncedAt: serverTime, contentHash: serverRevision }) }),
        readServerSyncTimestamp,
        deriveSyncToken: async () => 'synthetic-token',
        useAuthStore: { getState: () => ({ setupMasterPassword: async () => {} }) },
        setActiveWorkspace: () => {},
        writeIdentityProfile: () => {},
        saveSessionSyncToken: () => {},
        localStorage: { setItem: () => {} },
        toast: () => {},
        __env: { DEV: false },
        __import: async (specifier: string) => {
            assert.equal(specifier, '@/lib/crypto')
            return { generateSalt: () => new Uint8Array(16), exportSyncKeyRaw: async () => new Uint8Array(32) }
        },
    })
    // The server stamp is deliberately unrelated to the local wall clock.
    await register('synthetic-password', 'Test')
    assert.ok(firstPush)
    assert.equal(firstPush.lastSyncedAt, serverTime)
    assert.equal(firstPush.lastSyncedCloudEtag, serverRevision)
    assert.equal(firstPush.isInitialSyncCompleted, true)
})
