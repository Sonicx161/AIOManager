import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
    filterResurrected,
    addTombstones,
    mergeTombstones,
    mergeAddonDeletionState,
    markResurrectionAdopted,
    isResurrectionAdopted,
} from './addon-tombstones.ts'
import { threeWayMergeCanonical } from './canonical-merge.ts'
import { mergeAddons } from './utils.ts'
import { sourceFunction } from '../../test-support/source-harness.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const accountCanonicalPath = join(here, '..', 'store', 'account', 'accountCanonical.ts')

const URL_DELETED = 'https://stale-nuvio.example.com/manifest.json'
const KEY_DELETED = 'https://stale-nuvio.example.com'
const URL_KEPT = 'https://kept.example.com/manifest.json'
const URL_NEW = 'https://new-nuvio.example.com/manifest.json'
const NOW = 1_700_000_000_000
const TTL_21D = 21 * 24 * 60 * 60 * 1000

function addon(url: string) {
    return { transportUrl: url, manifest: { id: url, name: url, version: '1.0.0', resources: ['stream'] } }
}

test('stale Nuvio snapshot does not replace the current addon list (ADDON LIST, not credentials)', () => {
    const tombstones = addTombstones({}, [URL_DELETED], NOW)
    const local = [addon(URL_KEPT)]
    // Stale connection serves the deleted addon plus the kept one (old list replacement attempt).
    const staleRemote = [addon(URL_DELETED), addon(URL_KEPT)]
    const survivingRemote = filterResurrected(staleRemote, [], tombstones, NOW)
    assert.deepEqual(survivingRemote.map(a => a.transportUrl), [URL_KEPT])
    const merged = mergeAddons(local as never[], survivingRemote as never[], { keepMissingLocal: true }) as Array<{ transportUrl: string }>
    assert.ok(merged.some(a => a.transportUrl === URL_KEPT), 'intentional addon survives')
    assert.ok(!merged.some(a => a.transportUrl === URL_DELETED), 'deleted addon is not resurrected')
})

test('missing-base fold without tombstone filtering resurrects (original mechanism, real merge fn)', () => {
    // This is exactly what the original accountCanonical caller did:
    // threeWayMergeCanonical(base=null, local, remote) with no tombstone filter.
    // It folds every remote entry in as an inbound add.
    const local = [addon(URL_KEPT)]
    const remote = [addon(URL_DELETED), addon(URL_KEPT)]
    const { addons: merged } = threeWayMergeCanonical(null, local, remote)
    assert.ok(merged.some(a => (a.transportUrl ?? (a as Record<string, unknown>).url) === URL_DELETED),
        'unfiltered missing-base fold takes the stale entry (the reported replacement)')
})

test('missing-base stale Nuvio fold via the real reconcileInboundCanonical boundary stays suppressed', async () => {
    // Full caller with dependency doubles: fold-virgin hub (no recorded base),
    // local has the kept addon, canonical remote serves the stale deleted addon.
    // Exercises the REAL production reconcileInboundCanonical selected from
    // src/store/account/accountCanonical.ts, not a re-implementation.
    const tombstones = addTombstones({}, [URL_DELETED], NOW)
    const localAddons = [addon(URL_KEPT)]
    const remoteAddons = [addon(URL_DELETED), addon(URL_KEPT)]
    const accountId = 'acc-nuvio-fold'

    let stored = [{
        id: accountId,
        addons: localAddons,
        deletedAddons: tombstones,
        restoredAddons: {},
        profiles: undefined,
        activeProfileId: undefined,
    }]
    const reconcileInboundCanonical = sourceFunction(accountCanonicalPath, 'reconcileInboundCanonical', {
        getStore: async () => ({
            getState: () => ({ accounts: stored }),
            setState: (partial: Record<string, unknown>) => {
                if (Array.isArray((partial as { accounts?: unknown }).accounts)) {
                    stored = (partial as { accounts: typeof stored }).accounts
                }
            },
        }),
        fetchCanonical: async () => ({
            canonical: { [accountId]: { addons: remoteAddons, updatedAt: 1 } },
            serverStremioCredentialedAccounts: [],
        }),
        learnServerCredentialedAccounts: () => {},
        serverHasStremioCredential: () => false,
        getAccountById: (accounts: Array<{ id: string }>, id: string) => accounts.find(a => a.id === id),
        getStremioAuthKey: () => '',
        getCanonicalBase: () => null,
        markFoldedHub: () => {},
        persistAccounts: () => {},
        syncMutexes: new Map(),
        threeWayMergeCanonical,
        filterResurrected,
        mergeAddonDeletionState,
        __env: { DEV: false },
        __import: async (spec: string) => {
            if (spec.includes('syncStore')) {
                return { useSyncStore: { getState: () => ({ serverStremioCredentialedAccounts: [] }) } }
            }
            return { pushToConnections: async () => {} }
        },
    })

    const ownership = { assert: () => {}, current: () => false }
    await reconcileInboundCanonical(ownership)
    const urls = (stored[0].addons as Array<{ transportUrl: string }>).map(a => a.transportUrl)
    assert.ok(urls.includes(URL_KEPT), 'intentional addon survives the fold')
    assert.ok(!urls.includes(URL_DELETED), 'tombstoned stale entry is not folded in')
})

test('deletion older than 21d still blocks a stale canonical fold', () => {
    const old = NOW - TTL_21D - 1000
    const tombstones = addTombstones({}, [URL_DELETED], old)
    const deletionState = mergeAddonDeletionState(tombstones, undefined, undefined, undefined)
    const survivingRemote = filterResurrected([addon(URL_DELETED)], [], deletionState.deletedAddons, NOW)
    assert.equal(survivingRemote.length, 0, 'expired-by-old-clock delete still wins')
})

test('legacy URL-global adopted marker resurrects under original import wiring, fixed wiring suppresses', () => {
    // Legacy storage is URL-global and persisted; round-trip it through JSON the
    // way a restart reloads localStorage content.
    const backing = new Map<string, string>()
    // @ts-expect-error node has no localStorage; scoped shim for the legacy marker path only
    globalThis.localStorage = {
        getItem: (k: string) => (backing.has(k) ? backing.get(k)! : null),
        setItem: (k: string, v: string) => { backing.set(k, String(v)) },
        removeItem: (k: string) => { backing.delete(k) },
        clear: () => backing.clear(),
    }
    try {
        markResurrectionAdopted(KEY_DELETED)
        const reloaded = JSON.stringify(Object.fromEntries(backing))
        backing.clear()
        for (const [k, v] of Object.entries(JSON.parse(reloaded))) backing.set(k, v as string)
        assert.equal(isResurrectionAdopted(KEY_DELETED), true, 'legacy marker survives the reload')

        // ORIGINAL cloud-import wiring (accountImportExport.ts before fix), executed
        // with the real production functions: union tombstones, then delete every
        // adopted key. A fresh delete issued after the adoption is wiped, so the
        // stale remote copy passes the non-auto filter: resurrection.
        const freshDelete = addTombstones({}, [URL_DELETED], NOW)
        const legacyTombstones = mergeTombstones(freshDelete, undefined, NOW)
        for (const adoptedKey of Object.keys(legacyTombstones)) {
            if (isResurrectionAdopted(adoptedKey)) delete legacyTombstones[adoptedKey]
        }
        const legacyKept = filterResurrected([addon(URL_DELETED)], [], legacyTombstones, NOW + 500)
        assert.equal(legacyKept.length, 1, 'original adopted-clear wiring resurrects the re-deleted addon')

        // FIXED wiring on the same persisted state: explicit restoredAddons only,
        // legacy adopted markers are never consulted.
        const fixedState = mergeAddonDeletionState(freshDelete, undefined, {}, {})
        assert.ok(fixedState.deletedAddons[KEY_DELETED] !== undefined, 'fresh delete survives under fixed merge')
        const fixedKept = filterResurrected([addon(URL_DELETED)], [], fixedState.deletedAddons, NOW + 500)
        assert.equal(fixedKept.length, 0, 'fixed wiring keeps the re-deleted addon suppressed')
    } finally {
        // @ts-expect-error cleanup scoped shim
        delete globalThis.localStorage
    }
})

test('suppressed stale discovery propagates deletions without destroying intentional addons', () => {
    const tombstones = addTombstones({}, [URL_DELETED], NOW)
    const existing = [addon(URL_KEPT)]
    const rawDiscovered = [addon(URL_DELETED), addon(URL_NEW)]
    const discovered = filterResurrected(rawDiscovered, existing, tombstones, NOW)
    assert.deepEqual(discovered.map(a => a.transportUrl), [URL_NEW])
    const merged = mergeAddons(existing as never[], discovered as never[], { keepMissingLocal: true }) as Array<{ transportUrl: string }>
    assert.ok(merged.some(a => a.transportUrl === URL_KEPT), 'existing intentional addon kept')
    assert.ok(merged.some(a => a.transportUrl === URL_NEW), 'genuinely new connection addon adopted')
    assert.ok(!merged.some(a => a.transportUrl === URL_DELETED), 'tombstoned discovery suppressed')
    // Tombstone-only discovery: caller must propagate the deletion back to the connection.
    const tombstoneOnly = filterResurrected([addon(URL_DELETED)], existing, tombstones, NOW)
    assert.equal(tombstoneOnly.length, 0)
})
