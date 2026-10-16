import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mergeNotesTrash, filterNotesByTrash } from './notes-tombstones.ts'

const here = dirname(fileURLToPath(import.meta.url))

function readSrc(rel: string): string {
    return readFileSync(join(here, '..', rel), 'utf8')
}

const note = (id: string, updatedAt: string) => ({
    id,
    title: id,
    content: `content of ${id}`,
    tags: [] as string[],
    pinned: false,
    createdAt: updatedAt,
    updatedAt,
})

test('mergeNotesTrash is max-wins per id regardless of merge order', () => {
    const stale = [note('a', '2026-08-30T10:00:00Z')]
    const fresh = [note('a', '2026-08-31T10:00:00Z')]
    assert.deepEqual(mergeNotesTrash(fresh, stale), fresh)
    assert.deepEqual(mergeNotesTrash(stale, fresh), fresh)
})

test('a stale device pushing without pulling cannot wipe a deletion tombstone', () => {
    const macTrash = [note('a', '2026-08-31T10:00:00Z')]
    const phoneTrash: ReturnType<typeof note>[] = []
    const mergedTrash = mergeNotesTrash(phoneTrash, macTrash)
    assert.equal(mergedTrash.length, 1, 'tombstone survives the stale push')

    // The stale note must also be filtered out of the pushed `notes` list
    const phoneStaleNote = note('a', '2026-08-30T08:00:00Z')
    assert.equal(filterNotesByTrash([phoneStaleNote], mergedTrash).length, 0, 'stale note does not ride the push')
})

test('a note restored after its deletion is not filtered by an older tombstone', () => {
    const tombstone = [note('a', '2026-08-31T10:00:00Z')]
    const restored = [note('a', '2026-08-31T12:00:00Z')]
    assert.equal(filterNotesByTrash(restored, tombstone).length, 1, 'restore bumps updatedAt past the tombstone')
})

test('unrelated notes are untouched by the merge', () => {
    const localNotes = [note('a', '2026-08-30T10:00:00Z')]
    const localTrash = [note('b', '2026-08-30T10:00:00Z')]
    const pulledTrash = [note('b', '2026-08-31T10:00:00Z')]
    const merged = mergeNotesTrash(localTrash, pulledTrash)
    assert.equal(merged.length, 1)
    assert.equal(filterNotesByTrash(localNotes, merged).length, 1, 'note a is not trashed by note b tombstone')
})

test('the push serialisation merges local tombstones with the last-pulled cloud sets', () => {
    const src = readSrc('store/syncStore.ts')
    assert.match(src, /mergeNotesTrash\(notesState\.trash, syncRuntime\.lastPulledNotesTrash/)
    assert.match(src, /mergeTombstones\(vaultState\.tombstones, syncRuntime\.lastPulledVaultTombstones/)
    // The empty-store guard substitutes the last-pulled notes when the local store
    // has not imported yet; the tombstone merge itself still wraps the selection.
    assert.match(src, /filterNotesByTrash\(localNotes\.length === 0 && \(syncRuntime\.lastPulledNotes\?\.length \?\? 0\) > 0 \? syncRuntime\.lastPulledNotes! : localNotes, mergedNotesTrash\)/)
    assert.match(src, /syncRuntime\.lastPulledNotesTrash = (syncData|secondary)\.notesTrash/)
    assert.match(src, /syncRuntime\.lastPulledVaultTombstones = \((syncData|secondary)\.vaultTombstones/)
})

test('both pull paths capture the last-pulled sets', () => {
    const src = readSrc('store/syncStore.ts')
    const captureCount = (src.match(/syncRuntime\.lastPulledNotesTrash = data\.notesTrash/g) || []).length
    assert.equal(captureCount, 1, 'force-mirror path captures the pulled notes trash')
    const vaultCaptures = (src.match(/syncRuntime\.lastPulledVaultTombstones = \(/g) || []).length
    assert.equal(vaultCaptures, 2, 'login pull and force-mirror both capture vault tombstones')
})
