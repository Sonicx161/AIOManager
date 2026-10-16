// Cloud sync consistency: server-authoritative baselines + post-conflict merge.
// Real production units (readServerSyncTimestamp, shouldMirrorAccountPull) plus
// wiring locks over src/store/syncStore.ts. The HTTP boundary against the real
// server (revision vs clock guard, 304, conflict row stability, malformed input)
// lives in server/tests/cloud-sync-consistency.test.js. No fakes here.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
    readServerSyncTimestamp,
    shouldMirrorAccountPull,
} from './pull-restore.ts'

const here = dirname(fileURLToPath(import.meta.url))
const readSrc = (rel: string): string => readFileSync(join(here, '..', rel), 'utf8')

test('readServerSyncTimestamp accepts server ISO stamps and rejects malformed input', () => {
    assert.equal(readServerSyncTimestamp('2026-10-16T10:00:00.000Z'), '2026-10-16T10:00:00.000Z')
    assert.equal(readServerSyncTimestamp('2026-10-16T10:00:00.123Z'), '2026-10-16T10:00:00.123Z')
    assert.equal(readServerSyncTimestamp(null), null)
    assert.equal(readServerSyncTimestamp(undefined), null)
    assert.equal(readServerSyncTimestamp(12345), null)
    assert.equal(readServerSyncTimestamp(''), null)
    assert.equal(readServerSyncTimestamp('not-a-timestamp'), null)
    assert.equal(readServerSyncTimestamp('garbage'), null)
})

test('shouldMirrorAccountPull: post-conflict pulls merge even when the cloud is newer', () => {
    // Normal pulls: newer cloud mirrors, otherwise merge.
    assert.equal(shouldMirrorAccountPull({ isRemoteNewer: true, hasRemoteData: true, postConflict: false }), true)
    assert.equal(shouldMirrorAccountPull({ isRemoteNewer: false, hasRemoteData: true, postConflict: false }), false)
    // Empty cloud never mirrors (seed path owns that case).
    assert.equal(shouldMirrorAccountPull({ isRemoteNewer: true, hasRemoteData: false, postConflict: false }), false)
    assert.equal(shouldMirrorAccountPull({ isRemoteNewer: true, hasRemoteData: false, postConflict: true }), false)
    // THE interaction: a rejected push's local work never reached the server,
    // so the refresh merges instead of replacing it with the winner's state.
    assert.equal(shouldMirrorAccountPull({ isRemoteNewer: true, hasRemoteData: true, postConflict: true }), false)
    assert.equal(shouldMirrorAccountPull({ isRemoteNewer: false, hasRemoteData: true, postConflict: true }), false)
})

test('push adopts the server stamp, sends the revision base, and arms post-conflict merge', () => {
    const src = readSrc('store/syncStore.ts')
    assert.match(src, /readServerSyncTimestamp\(resData\.syncedAt\)/, 'push success adopts the server stamp')
    assert.match(src, /baseContentHash: get\(\)\.lastSyncedCloudEtag/, 'push sends the revision base')
    assert.match(src, /postConflictMergeFor = auth\.id/, 'push conflict arms the merge for the next pull')
    assert.ok(!src.includes('another device synced more recently'), 'conflict copy asserts no unverified device')
    assert.match(src, /title: 'Cloud changed'/, 'conflict toast uses the truthful title')
})

test('post-conflict pulls merge accounts and library, then republish; explicit mirror stays wholesale', () => {
    const src = readSrc('store/syncStore.ts')
    assert.match(
        src,
        /shouldMirrorAccountPull\(\{ isRemoteNewer, hasRemoteData, postConflict: postConflictPull \}\)/,
        'accounts decision delegates to the real rule with the armed flag',
    )
    assert.match(src, /Merge \(post-conflict: preserve unsynced local changes\)/, 'post-conflict accounts merge')
    assert.match(
        src,
        /importLibrary\(syncData, postConflictPull \? true : false, true, true, ownership\)/,
        'post-conflict library merges instead of replacing saved addons',
    )
    assert.match(
        src,
        /if \(postConflictPull\) \{\s*postConflictMergeFor = null/,
        'the arm is consumed once by the owning pull',
    )
    assert.match(src, /if \(ownership\.current\(\)\) get\(\)\.syncToRemote\(true\)/, 'merged post-conflict state republishes')
    assert.match(src, /const sendPullEtag = postConflictMergeFor !== id &&/, 'a conflict refresh requires the full payload')
    // Explicit mirror remains intentional replacement.
    assert.match(src, /await useAccountStore\.getState\(\)\.importAccounts\(data, true, 'mirror'/, 'explicit mirror replaces accounts')
    assert.match(src, /await useAddonStore\.getState\(\)\.importLibrary\(data, false, true, true, ownership\)/, 'explicit mirror replaces the library')
})

test('pull and mirror install server timestamps without fabricating local clocks', () => {
    const src = readSrc('store/syncStore.ts')
    assert.match(src, /responseSyncedAt = readServerSyncTimestamp\(raw\.syncedAt\)/, 'pull captures the outer server stamp')
    assert.match(src, /const responseSyncedAt = readServerSyncTimestamp\(raw\.syncedAt\)/, 'mirror captures the server stamp')
    assert.match(src, /responseSyncedAt \?\? get\(\)\.lastSyncedAt/, 'missing stamps keep the previous baseline')
    assert.ok(!src.includes('lastSyncedAt: new Date().toISOString(), needsReauth: false'), 'push no longer stamps the local clock')
})
