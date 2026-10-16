import test from 'node:test'
import assert from 'node:assert/strict'
import { decodeWatchedBitfield, encodeWatchedBitfield } from './watched-bitfield.ts'
import { sortMetaVideos, resolveWatchedEpisodes, type MetaVideo } from './watched-episodes.ts'
import { planEpisodeBitfieldDelete } from './episode-bitfield-delete.ts'
import type { LibraryItem } from '../types/activity.ts'


// W1 regression suite: the watched bitfield must round-trip through OUR encode the same
// way stremio-core's writer does — anchor id and declared length derived from the same max
// set bit, indices mapped against the (season, episode, released)-sorted video list, and
// an anchor that does NOT sit at the highest set bit is a valid state, not a mismatch.

const famVideos = (n: number): MetaVideo[] => Array.from({ length: n }, (_, i) => ({
    id: `ttFAM:1:${i + 1}`,
    season: 1,
    episode: i + 1,
    released: `2021-01-${String((i % 28) + 1).padStart(2, '0')}`,
}))

// Swap the anchor prefix of an encoded string, simulating stremio-core's fallback writer
// (last_index_of(true).unwrap_or(0)) which can anchor below the highest set bit.
function reanchor(encoded: string, anchorId: string): string {
    const base64 = encoded.slice(encoded.lastIndexOf(':') + 1)
    const withoutB64 = encoded.slice(0, encoded.lastIndexOf(':'))
    const length = withoutB64.slice(withoutB64.lastIndexOf(':') + 1)
    return `${anchorId}:${length}:${base64}`
}

const mkRow = (watched: string): LibraryItem => ({
    _id: 'ttFAM',
    name: 'For All Mankind',
    type: 'series',
    state: { watched, video_id: 'ttFAM:1:3' },
})

test('encode/decode round-trip: anchor id and length derive from the same max set bit', async () => {
    const videos = famVideos(10)

    const encoded = await encodeWatchedBitfield([1, 2, 9], videos)
    const decoded = await decodeWatchedBitfield(encoded)
    assert.ok(decoded)
    assert.deepEqual(decoded.watchedIndices, [1, 2, 9])
    assert.equal(decoded.videoId, videos[9].id, 'anchor repoints to the new highest set bit')
    assert.equal(decoded.length, 10, 'length is max(indices) + 1, not the old bitfield length')

    // Clearing the highest bit shrinks the anchor AND the declared length together.
    const shrunk = await decodeWatchedBitfield(await encodeWatchedBitfield([0, 1], videos))
    assert.ok(shrunk)
    assert.deepEqual(shrunk.watchedIndices, [0, 1])
    assert.equal(shrunk.videoId, videos[1].id)
    assert.equal(shrunk.length, 2)
})

test('plan rewrites a bitfield whose anchor is NOT at the highest set bit (For All Mankind shape)', async () => {
    const videos = famVideos(10)
    // Eps 1-4 and 10 watched, but the string anchors on ep 3 — valid per stremio-core's writer.
    const watched = reanchor(await encodeWatchedBitfield([0, 1, 2, 3, 9], videos), videos[2].id)

    const plan = await planEpisodeBitfieldDelete({
        itemId: 'ttFAM',
        row: mkRow(watched),
        videos,
        target: { uniqueItemId: videos[0].id, season: 1, episode: 1 },
    })

    assert.equal(plan.kind, 'rewrite', 'mid-list anchor must not be treated as an anchor-mismatch')
    if (plan.kind !== 'rewrite') return
    const decoded = await decodeWatchedBitfield(plan.rewritten.state?.watched)
    assert.ok(decoded)
    assert.deepEqual(decoded.watchedIndices, [1, 2, 3, 9])
    assert.equal(decoded.videoId, videos[9].id, 'rewrite re-anchors at the surviving highest bit')
    assert.equal(decoded.length, 10)
    assert.equal(plan.rewritten.state?.video_id, videos[9].id)
    assert.equal(plan.rewritten.state?.timesWatched, 4)
})

test('plan still fails closed when the anchor id is not in the video list at all', async () => {
    const videos = famVideos(10)
    const watched = reanchor(await encodeWatchedBitfield([0, 1, 2], videos), 'kitsu:46873:1:3')

    const plan = await planEpisodeBitfieldDelete({
        itemId: 'ttFAM',
        row: mkRow(watched),
        videos,
        target: { season: 1, episode: 1 },
    })
    assert.deepEqual(plan, { kind: 'fail', reason: 'anchor-mismatch' })
})

test('sort: raw Cinemeta order becomes stremio-core (season, episode, released) order', () => {
    const raw: MetaVideo[] = [
        { id: 's2e1', season: 2, episode: 1, released: '2022-02-11' },
        { id: 's1e2', season: 1, episode: 2, released: '2019-11-08' },
        { id: 's1e1', season: 1, episode: 1, released: '2019-11-01' },
        { id: 'special', season: 0, episode: 1, released: '2019-10-25' },
        { id: 's1e3', season: 1, episode: 3, released: '2019-11-15' },
    ]
    assert.deepEqual(
        sortMetaVideos(raw).map(v => v.id),
        ['special', 's1e1', 's1e2', 's1e3', 's2e1'],
    )

    // Missing season/episode numbers sort as 0; released breaks ties between undated slots.
    const undated: MetaVideo[] = [
        { id: 'later', season: 1, episode: null, released: '2021-01-02' },
        { id: 'earlier', season: 1, episode: null, released: '2021-01-01' },
    ]
    assert.deepEqual(sortMetaVideos(undated).map(v => v.id), ['earlier', 'later'])

    // The input list is never mutated in place.
    assert.deepEqual(raw.map(v => v.id), ['s2e1', 's1e2', 's1e1', 'special', 's1e3'])
})

test('offset application: specials shift bit indices onto the right episodes (SVU shape)', () => {
    const videos = sortMetaVideos([
        { id: 'ttSVU:1:1', season: 1, episode: 1 },
        { id: 'ttSVU:0:1', season: 0, episode: 1 },
        { id: 'ttSVU:1:2', season: 1, episode: 2 },
        { id: 'ttSVU:1:3', season: 1, episode: 3 },
    ])
    assert.equal(videos[0].id, 'ttSVU:0:1', 'the special sorts first, offsetting every later episode')

    const episodes = resolveWatchedEpisodes(
        { videoId: videos[3].id, length: 4, watchedIndices: [0, 3] },
        videos,
    )
    assert.ok(episodes)
    assert.deepEqual(episodes, [
        { index: 0, videoId: 'ttSVU:0:1', season: 0, episode: 1 },
        { index: 3, videoId: 'ttSVU:1:3', season: 1, episode: 3 },
    ])
})

test('offset application through the plan: a specials-shifted bitfield deletes the right episode', async () => {
    const videos = sortMetaVideos([
        { id: 'ttX:1:1', season: 1, episode: 1 },
        { id: 'ttX:0:1', season: 0, episode: 1 },
        { id: 'ttX:1:2', season: 1, episode: 2 },
    ])
    const watched = await encodeWatchedBitfield([0, 2], videos)

    const plan = await planEpisodeBitfieldDelete({
        itemId: 'ttX',
        row: { ...mkRow(watched), _id: 'ttX', state: { watched, video_id: videos[2].id } },
        videos,
        target: { uniqueItemId: 'ttX:1:2', season: 1, episode: 2 },
    })
    assert.equal(plan.kind, 'rewrite')
    if (plan.kind !== 'rewrite') return
    const decoded = await decodeWatchedBitfield(plan.rewritten.state?.watched)
    assert.ok(decoded)
    assert.deepEqual(decoded.watchedIndices, [0], 'the special survives, the s1e2 bit is cleared')
    assert.equal(decoded.videoId, videos[0].id)
})
