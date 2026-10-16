import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { sourceFunction } from '../../test-support/source-harness.mjs'
import { reconcileTombstones } from './addon-tombstones.ts'

const source = fileURLToPath(new URL('../store/connectionStore.ts', import.meta.url))

test('re-enabling a stale connection preserves account deletion and restore records', async () => {
    const deletedAddons = { 'https://removed.example': 42 }
    const restoredAddons = { 'https://other.example': 21 }
    let account = {
        id: 'account', deletedAddons, restoredAddons,
        connections: [{ id: 'connection', enabled: false, connectionType: 'native' }],
    }
    const calls: string[] = []
    const toggle = sourceFunction(source, 'toggleConnection', {
        updateAccount: async (_id: string, update: (value: typeof account) => typeof account) => { account = update(account) },
        useAccountStore: { getState: () => ({ accounts: [account] }) },
        __import: async (specifier: string) => {
            if (specifier.includes('connection-discovery')) return { discoverFromConnections: async () => ({ discovered: [{ connectionId: 'connection', transportUrl: 'https://removed.example/manifest.json' }] }) }
            if (specifier.includes('addon-tombstones')) return { reconcileTombstones }
            if (specifier.includes('accountSync')) return { scheduleSyncAccount: () => calls.push('sync') }
            if (specifier.includes('accountAddonOps')) return { pushToConnections: async () => { calls.push('push') } }
            throw new Error(`Unexpected discovery or deletion override: ${specifier}`)
        },
    })
    await toggle('account', 'connection')
    await Promise.resolve()
    assert.equal(account.connections[0].enabled, true)
    assert.deepEqual(account.deletedAddons, deletedAddons)
    assert.deepEqual(account.restoredAddons, restoredAddons)
    assert.deepEqual(calls.sort(), ['push', 'sync'])
})

test('platform sync does not replace the server cloud timestamp baseline', async () => {
    const baseline = '2026-10-16T10:00:00.000Z'
    let cloudBaseline = baseline
    const calls: string[] = []
    const sync = sourceFunction(source, 'syncConnections', {
        get: () => ({ isSyncing: null, refreshConnectionStates: async () => { calls.push('refresh') } }),
        set: () => {},
        toast: () => assert.fail('sync should succeed'),
        __import: async (specifier: string) => {
            if (specifier.includes('accountStore')) return { useAccountStore: { getState: () => ({ syncAccount: async () => { calls.push('sync') } }) } }
            if (specifier.includes('syncStore')) return { useSyncStore: { setState: (state: { lastSyncedAt: string }) => { cloudBaseline = state.lastSyncedAt } } }
            throw new Error(`Unexpected import: ${specifier}`)
        },
    })
    await sync('account')
    assert.deepEqual(calls, ['sync', 'refresh'])
    assert.equal(cloudBaseline, baseline)
})
