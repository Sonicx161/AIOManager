import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { shouldSendPullEtag } from './pull-restore.ts'

const here = dirname(fileURLToPath(import.meta.url))

function readSrc(rel: string): string {
    return readFileSync(join(here, '..', rel), 'utf8')
}

// Rotation -> local clear -> fresh sign-in: the tab that rotated the password
// signed out (the workspace index and blobs were wiped), then signed back in
// with the new password. The cloud still holds the note the workspace itself
// pushed, so the server answers 304 to the stale etag unless the pull refuses
// the shortcut for an empty local store.
test('fresh sign-in after a local wipe refuses the unchanged shortcut when the cloud had notes', () => {
    assert.equal(shouldSendPullEtag({
        storedEtag: '"same-content-we-pushed"',
        sessionUnlocked: true,
        lastSyncedNotesCount: 1,
        localNotesEmpty: true,
    }), false, 'empty local store plus a note-bearing last pull must force the full apply')
})

test('the shortcut survives for workspaces whose local state is intact', () => {
    assert.equal(shouldSendPullEtag({
        storedEtag: '"same-content-we-pushed"',
        sessionUnlocked: true,
        lastSyncedNotesCount: 1,
        localNotesEmpty: false,
        lastAppliedAccountCount: 1,
        lastAppliedAddonCount: 1,
        localAccountCount: 1,
        localAddonCount: 1,
    }), true)
})

test('a cloud that never had notes never triggers the force-apply re-fetch', () => {
    assert.equal(shouldSendPullEtag({
        storedEtag: '"same-content-we-pushed"',
        sessionUnlocked: true,
        lastSyncedNotesCount: 0,
        localNotesEmpty: true,
        lastAppliedAccountCount: 0,
        lastAppliedAddonCount: 0,
    }), true, 'genuinely empty cloud: the 304 stays cheap')
    assert.equal(shouldSendPullEtag({
        storedEtag: '"same-content-we-pushed"',
        sessionUnlocked: true,
        lastSyncedNotesCount: null,
        localNotesEmpty: true,
        lastAppliedAccountCount: 0,
        lastAppliedAddonCount: 0,
    }), true)
})

test('unknown cloud slice counts and evicted account or addon slices require a full pull', () => {
    const inputs = { storedEtag: '"etag"', sessionUnlocked: true, lastSyncedNotesCount: 0, localNotesEmpty: true, lastAppliedAccountCount: 1, lastAppliedAddonCount: 1, localAccountCount: 1, localAddonCount: 1 }
    assert.equal(shouldSendPullEtag(inputs), true)
    assert.equal(shouldSendPullEtag({ ...inputs, lastAppliedAccountCount: null }), false)
    assert.equal(shouldSendPullEtag({ ...inputs, lastAppliedAddonCount: null }), false)
    assert.equal(shouldSendPullEtag({ ...inputs, localAccountCount: 0 }), false)
    assert.equal(shouldSendPullEtag({ ...inputs, localAddonCount: 0 }), false)
    assert.equal(shouldSendPullEtag({ ...inputs, lastSyncedNotesCount: 1 }), false)
})

test('no etag or locked session still skips the header entirely', () => {
    assert.equal(shouldSendPullEtag({
        storedEtag: null,
        sessionUnlocked: true,
        lastSyncedNotesCount: 3,
        localNotesEmpty: true,
    }), false)
    assert.equal(shouldSendPullEtag({
        storedEtag: '"x"',
        sessionUnlocked: false,
        lastSyncedNotesCount: 3,
        localNotesEmpty: true,
    }), false)
})

test('the pull path wires the empty-local force-apply into the etag header', () => {
    const src = readSrc('store/syncStore.ts')
    assert.match(src, /shouldSendPullEtag\(\{[\s\S]*?lastSyncedNotesCount: get\(\)\.lastSyncedNotesCount,[\s\S]*?localNotesEmpty,/)
    assert.match(src, /if \(sendPullEtag && storedEtag\) pullHeaders\['If-None-Match'\] = storedEtag/)
    assert.match(src, /isLocalNotesStoreEmpty\(\)/)
    // The 304 early return stays in place; the force-apply prevents reaching it stranded.
    assert.match(src, /if \(res\.status === 304\) \{/)
})

test('the login pull records how many notes the applied cloud state carried', () => {
    const src = readSrc('store/syncStore.ts')
    assert.match(src, /syncRuntime\.lastPulledNotes = secondary\.notes as import\('\.\/notesStore'\)\.Note\[\][\s\S]*?set\(\{ lastSyncedNotesCount: secondary\.notes\.length \}\)/)
    assert.match(src, /lastSyncedNotesCount: state\.lastSyncedNotesCount/, 'the count is persisted so a reload keeps the rescue signal')
})

test('sign-out clears the in-memory notes index claims its wipe just invalidated', () => {
    const syncSrc = readSrc('store/syncStore.ts')
    const wipeAt = syncSrc.indexOf('await wipeAllData()')
    const resetAt = syncSrc.indexOf('useNotesStore.getState().resetLocal()')
    assert.ok(wipeAt !== -1, 'logout wipes the workspace store')
    assert.ok(resetAt !== -1, 'logout resets the notes store memory')
    assert.ok(resetAt > wipeAt, 'the reset follows the wipe so stale metas cannot mask the re-import')
    assert.match(syncSrc, /lastSyncedNotesCount: null/, 'logout drops the notes-count expectation')

    const notesSrc = readSrc('store/notesStore.ts')
    assert.match(notesSrc, /resetLocal: \(\) => \{[\s\S]*?pendingPersist = null[\s\S]*?noteCache\.clear\(\)[\s\S]*?set\(\{ notes: \[\], trash: \[\], activeNote: null, saveFailed: false \}\)/)
    assert.match(notesSrc, /export async function isLocalNotesStoreEmpty[\s\S]*?localforage\.getItem<NoteMeta\[\]>\(NOTES_INDEX_KEY\)/)
})
