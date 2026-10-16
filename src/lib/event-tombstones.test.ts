import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { isIdentityDeleted, mergeDeletedEventMaps } from './event-tombstones.ts'
import { sourceFunction } from '../../test-support/source-harness.mjs'


// W3: deletion durability. Tombstones are per episode identity and gate on the deletion
// moment (replayed old events stay hidden, a genuinely newer watch supersedes), the push
// serialisation merges local tombstones into the last-pulled cloud map instead of replacing
// it, and reset() must never wipe tombstones.

const here = dirname(fileURLToPath(import.meta.url))

function readSrc(rel: string): string {
    return readFileSync(join(here, '..', rel), 'utf8')
}

test('a tombstone hides events up to its deletion; a genuinely newer watch supersedes it', () => {
    const tombstones = { 'acct-1:tt123:s1:e5': 1_000 }
    assert.equal(isIdentityDeleted('acct-1:tt123:s1:e5', tombstones), true, 'no timestamp counts as stale')
    assert.equal(isIdentityDeleted('acct-1:tt123:s1:e5', tombstones, 1_000), true, 'an event at the deletion moment stays hidden')
    assert.equal(isIdentityDeleted('acct-1:tt123:s1:e5', tombstones, 999), true, 'a replayed older event stays hidden')
    assert.equal(isIdentityDeleted('acct-1:tt123:s1:e5', tombstones, 1_001), false, 'a newer watch supersedes the deletion')
    assert.equal(isIdentityDeleted('acct-1:tt123:s1:e6', tombstones, 5_000), false, 'sibling episodes are untouched')
    assert.equal(isIdentityDeleted('acct-2:tt123:s1:e5', tombstones, 5_000), false, 'other accounts are untouched')
    assert.equal(isIdentityDeleted('acct-1:tt123:s1:e5', {}), false)
})

test('mergeDeletedEventMaps is max-wins per key in both directions', () => {
    const local = { a: 100, b: 300 }
    const cloud = { b: 200, c: 400 }
    assert.deepEqual(mergeDeletedEventMaps(local, cloud), { a: 100, b: 300, c: 400 })

    // A staler local map must never overwrite fresher cloud deletes.
    const staleLocal = { a: 100 }
    const freshCloud = { a: 999, z: 50 }
    assert.deepEqual(mergeDeletedEventMaps(staleLocal, freshCloud), { a: 999, z: 50 })

    assert.deepEqual(mergeDeletedEventMaps({}, {}), {})
})

test('the store gates tombstones on the event timestamp and guards backfill timestamps', () => {
    const src = readSrc('store/watchEventStore.ts')
    assert.match(src, /import \{ isIdentityDeleted \} from '@\/lib\/event-tombstones'/)
    assert.match(src, /return isIdentityDeleted\(watchEventIdentityKey\(e\), deleted, e\.event_ts\)/)
    assert.match(src, /lastWatchedTs === undefined && isIdentityDeleted/, 'backfill skips tombstoned identities without a real Stremio date')
})

test('removeEvents tombstones selected identities and deletes their known server event ids', async () => {
    let state = { events: [{ id: 'evt-target', key: 'acct:item' }, { id: 'evt-other', key: 'acct:other' }], deletedEventKeys: {} as Record<string, number> }
    let removed: string[] = []
    let persisted: Record<string, number> = {}
    const remove = sourceFunction(join(here, '..', 'store/watchEventStore.ts'), 'removeEvents', {
        get: () => state,
        set: (patch: Partial<typeof state>) => { state = { ...state, ...patch } },
        getEpisodeIdentity: (itemId: string) => itemId,
        watchEventIdentityKey: (event: { key: string }) => event.key,
        capDeletedEvents: (deleted: Record<string, number>) => deleted,
        filterTombstonedEvents: (events: typeof state.events, deleted: Record<string, number>) => events.filter(e => !deleted[e.key]),
        persistWatchEvents: () => {},
        persistDeletedEvents: (deleted: Record<string, number>) => { persisted = deleted },
        __import: async () => ({ deleteServerActivityEvents: async (ids: string[]) => { removed = ids } }),
    })
    remove([{ accountId: 'acct', itemId: 'item', type: 'movie' }])
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(removed, ['evt-target'])
    assert.deepEqual(state.events.map(e => e.id), ['evt-other'])
    assert.ok(persisted['acct:item'] > 0)
    remove([])
    assert.deepEqual(removed, ['evt-target'])
})

test('reset() preserves tombstones — only watch data is cleared', () => {
    const src = readSrc('store/watchEventStore.ts')
    const resetStart = src.indexOf('reset: () => {')
    const resetEnd = src.indexOf('mergeServerEvents:', resetStart)
    const reset = src.slice(resetStart, resetEnd)
    assert.ok(reset.length > 0, 'reset body found')
    assert.ok(!/deletedEventKeys:\s*\{\}/.test(reset), 'reset must not clear deletedEventKeys')
    assert.ok(!reset.includes('localforage.removeItem(DELETED_EVENTS_KEY)'), 'reset must not wipe the persisted tombstones')
    assert.match(reset, /deletedEventKeys: deleted/, 'the existing tombstones are carried through')
})

test('the push serialisation merges tombstones into the last-pulled cloud map', () => {
    const src = readSrc('store/syncStore.ts')
    assert.match(src, /deletedWatchEvents: mergeDeletedEventMaps\(watchExport\.deletedEvents, syncRuntime\.lastPulledDeletedWatchEvents \?\? \{\}\)/)
    // Both pull paths remember the cloud map the push will merge into.
    const pullSites = src.match(/syncRuntime\.lastPulledDeletedWatchEvents = remoteDeleted/g) || []
    assert.equal(pullSites.length, 2, 'the sync pull and the restore/mirror pull both cache the cloud map')
})
