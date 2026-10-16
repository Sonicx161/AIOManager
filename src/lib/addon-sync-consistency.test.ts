import test from 'node:test'
import assert from 'node:assert/strict'
import {
    addTombstones,
    filterResurrected,
    filterResurrectedAuto,
    mergeTombstones,
    mergeAddonDeletionState,
    restoreAddonDeletions,
} from './addon-tombstones.ts'

const URL_A = 'https://stale.example.com/manifest.json'
const KEY_A = 'https://stale.example.com'
const URL_B = 'https://other.example.com/manifest.json'
const NOW = 1_700_000_000_000
const TTL_21D = 21 * 24 * 60 * 60 * 1000

test('repeated stale Stremio snapshots stay suppressed across 5 refreshes + persisted reload', () => {
    // Marker state round-trips through JSON persistence (the restart path),
    // never carried as the same live object.
    let persisted = JSON.stringify({ tombstones: addTombstones({}, [URL_A], NOW), sightings: {} })
    for (let i = 1; i <= 5; i++) {
        const { tombstones, sightings } = JSON.parse(persisted)
        const r = filterResurrectedAuto([{ transportUrl: URL_A }], [], tombstones, sightings, NOW + i * 1000)
        assert.equal(r.kept.length, 0, `refresh ${i} must suppress`)
        assert.equal(r.adopted.length, 0, `refresh ${i} must not adopt`)
        persisted = JSON.stringify({ tombstones, sightings: r.nextSightings })
    }
    // Simulated restart: reload the persisted marker state, then sync once more.
    const { tombstones, sightings } = JSON.parse(persisted)
    const afterRestart = filterResurrectedAuto([{ transportUrl: URL_A }], [], tombstones, sightings, NOW + 60_000)
    assert.equal(afterRestart.kept.length, 0, 'post-restart must still suppress')
})

test('deletion older than 21d still suppresses a stale replay (no expiry)', () => {
    const old = NOW - TTL_21D - 1000
    const tombstones = addTombstones({}, [URL_A], old)
    const kept = filterResurrected([{ transportUrl: URL_A }], [], tombstones, NOW)
    assert.equal(kept.length, 0, 'stale replay past 21d must stay suppressed')
})

test('same URL in two accounts: sightings from A do not adopt in B', () => {
    const tombstones = addTombstones({}, [URL_A], NOW)
    let shared: Record<string, number> = {}
    for (let i = 0; i < 2; i++) {
        const r = filterResurrectedAuto([{ transportUrl: URL_A }], [], tombstones, shared, NOW + i)
        shared = r.nextSightings
    }
    const b = filterResurrectedAuto([{ transportUrl: URL_A }], [], tombstones, shared, NOW + 9)
    assert.equal(b.kept.length, 0, 'account B must not adopt from account A sightings')
    assert.equal(b.adopted.length, 0)
})

test('explicit reinstall acknowledges the exact deletion; a later remote delete wins', () => {
    const deletedV1 = addTombstones({}, [URL_A], 1000)
    const { deletedAddons: afterReinstall, restoredAddons } = restoreAddonDeletions(deletedV1, {}, [{ transportUrl: URL_A }])
    assert.deepEqual(afterReinstall, {}, 'explicit install clears the observed deletion')
    assert.ok(restoredAddons[KEY_A] >= 1000, 'restore records the overridden version')
    // Another client deletes after the reinstall with a later timestamp.
    const remoteDeleteV2 = addTombstones({}, [URL_A], 2000, restoredAddons)
    const merged = mergeAddonDeletionState(afterReinstall, remoteDeleteV2, restoredAddons, {})
    assert.ok(merged.deletedAddons[KEY_A] !== undefined, 'later delete beats the earlier restore')
    const kept = filterResurrected([{ transportUrl: URL_A }], [], merged.deletedAddons, 2500)
    assert.equal(kept.length, 0, 'stale remote copy stays suppressed after the winning delete')
})

test('delete after reinstall advances past the restore even when the clock moves backwards', () => {
    const deletedV1 = addTombstones({}, [URL_A], 1000)
    const { restoredAddons } = restoreAddonDeletions(deletedV1, {}, [{ transportUrl: URL_A }])
    const freshDelete = addTombstones({}, [URL_A], 900, restoredAddons)
    assert.ok(freshDelete[KEY_A] > (restoredAddons[KEY_A] ?? 0), 'fresh delete must beat the restore')
    const merged = mergeAddonDeletionState(freshDelete, {}, restoredAddons, {})
    assert.ok(merged.deletedAddons[KEY_A] !== undefined)
})

test('fixed merge takes only explicit restoredAddons, so a fresh delete survives with no restore', () => {
    const fresh = addTombstones({}, [URL_A], NOW)
    const merged = mergeAddonDeletionState(fresh, {}, {}, {})
    assert.ok(merged.deletedAddons[KEY_A] !== undefined, 'fresh delete survives without any restore')
    const kept = filterResurrected([{ transportUrl: URL_A }], [], merged.deletedAddons, NOW + 500)
    assert.equal(kept.length, 0)
})

test('bulk/profile reorder without explicit install intent does not clear deletions', () => {
    const tombstones = addTombstones({}, [URL_A], NOW)
    const { deletedAddons: afterReorder } = restoreAddonDeletions(tombstones, {}, [])
    assert.ok(afterReorder[KEY_A] !== undefined, 'plain reorder/clone must not acknowledge a delete')
    const { deletedAddons: afterExplicit } = restoreAddonDeletions(tombstones, {}, [{ transportUrl: URL_A }])
    assert.equal(afterExplicit[KEY_A], undefined, 'explicit clone source URL does acknowledge')
})

test('mergeTombstones latest-delete-wins across two devices', () => {
    const a = addTombstones({}, [URL_A], 1000)
    const b = addTombstones({}, [URL_A, URL_B], 2000)
    const merged = mergeTombstones(a, b, 2500)
    assert.equal(merged[KEY_A], 2000)
    assert.ok(merged['https://other.example.com'] !== undefined)
})
