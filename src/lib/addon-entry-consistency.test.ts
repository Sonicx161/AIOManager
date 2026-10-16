import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { sourceFunction } from '../../test-support/source-harness.mjs'
import { addTombstones, filterResurrected, mergeAddonDeletionState, restoreAddonDeletions } from './addon-tombstones.ts'
import { mergeAddons, normalizeAddonUrl } from './utils.ts'

const storePath = fileURLToPath(new URL('../store/accountStore.ts', import.meta.url))
const opsPath = fileURLToPath(new URL('../store/account/accountAddonOps.ts', import.meta.url))
const syncPath = fileURLToPath(new URL('../store/account/accountSync.ts', import.meta.url))
const removedUrl = 'https://removed.example/manifest.json'
const keptUrl = 'https://kept.example/manifest.json'
const addon = (transportUrl: string) => ({ transportUrl, manifest: { id: transportUrl, name: transportUrl, version: '1.0.0' } })
const mergeRemote = sourceFunction(syncPath, 'mergeRemoteIntoHub', {
    trace: () => {}, syncManager: { isPendingRemoval: () => false },
    sanitizeAddonManifest: (manifest: unknown) => manifest,
    mergeAddonDeletionState, filterResurrected, normalizeAddonUrl, mergeAddons,
})

test('credential re-auth preserves local addons and suppresses stale platform entries before publishing', async () => {
    const kept = addon(keptUrl)
    const account = {
        id: 'account', authKey: 'old', addons: [kept],
        deletedAddons: addTombstones({}, [removedUrl]), restoredAddons: {},
        profiles: [{ id: 'default', name: 'Main', addons: [kept] }],
    }
    let state = { accounts: [account], loadingAccounts: new Set<string>() }
    let publishedUrls: string[] = []
    const update = sourceFunction(storePath, 'updateAccount', {
        get: () => state,
        set: (value: Partial<typeof state>) => { state = { ...state, ...value } },
        acquireSyncMutex: async () => () => {},
        getAccountById: (accounts: typeof state.accounts, id: string) => accounts.find(a => a.id === id),
        getEncryptionKey: () => 'synthetic-key',
        encrypt: async () => 'encrypted-new-key',
        getStremioAuthKey: (a: typeof account) => a.authKey,
        authKeyCache: new Map(), upsertAuthKeyHash: async () => {},
        getAddons: async () => [addon(removedUrl)],
        mergeAddonDeletionState,
        sanitizeAddonManifest: (manifest: unknown) => manifest,
        persistAccounts: () => {}, scheduleSessionBoundAuthCheck: () => {}, trace: () => {},
        triggerSync: () => { publishedUrls = state.accounts[0].addons.map(a => a.transportUrl) },
        __import: async () => ({ mergeRemoteIntoHub: mergeRemote }),
    })
    await update('account', { authKey: 'new-synthetic-auth' })
    assert.deepEqual(publishedUrls, [keptUrl])
    assert.deepEqual(state.accounts[0].profiles[0].addons.map(a => a.transportUrl), [keptUrl])
    assert.deepEqual(state.accounts[0].deletedAddons, account.deletedAddons)
})

test('overwrite clone tombstones dropped URLs so a failed platform write cannot restore them', async () => {
    const account = { id: 'account', addons: [addon(removedUrl), addon(keptUrl)], deletedAddons: {}, restoredAddons: {} }
    let state = { accounts: [account] }
    const reorder = sourceFunction(opsPath, 'reorderAddons', {
        getStore: async () => ({ getState: () => state, setState: (value: Partial<typeof state>) => { state = { ...state, ...value } } }),
        setAccountLoading: () => {}, clearAccountLoading: () => {},
        acquireSyncMutex: async () => () => {},
        getAccountById: (accounts: typeof state.accounts, id: string) => accounts.find(a => a.id === id),
        normalizeAddonUrl, restoreAddonDeletions, addTombstones,
        updateActiveProfile: (value: typeof account) => value,
        persistAccounts: () => {},
        // The platform remains stale, as when a background delivery cannot reach it.
        backgroundSync: () => {},
    })
    await reorder('account', [addon(keptUrl)], { explicitInstallUrls: [keptUrl] })
    const merged = mergeRemote(state.accounts[0], account.addons)
    assert.deepEqual(merged.map((a: { transportUrl: string }) => a.transportUrl), [keptUrl])
    assert.ok(state.accounts[0].deletedAddons[normalizeAddonUrl(removedUrl) as keyof typeof account.deletedAddons])
})
