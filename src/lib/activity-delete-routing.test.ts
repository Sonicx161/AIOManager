import test from 'node:test'
import assert from 'node:assert/strict'
import { isEpisodeScopedDelete, isBareAnchoredEpisode } from './activity-delete-routing.ts'
import type { LibraryItem } from '../types/activity.ts'


// W2: Activity delete routing. A movie row with season 0 / episode 0 failed the old
// `season == null || episode == null` gate, fell into the per-episode bitfield planner,
// and died at 'no-bitfield' leaving the movie undeletable. Routing now decides by type
// FIRST, and a part-watched first episode (video_id set, no bitfield) goes whole-row.

test('a movie with season 0 / episode 0 routes to the whole-item delete path', () => {
    assert.equal(isEpisodeScopedDelete({ type: 'movie', season: 0, episode: 0 }), false)
    assert.equal(isEpisodeScopedDelete({ type: 'movie', season: undefined, episode: undefined }), false)
    assert.equal(isEpisodeScopedDelete({ type: 'channel' }), false, 'non-series types have no episode concept')
})

test('series-like items with real coordinates keep the per-episode path', () => {
    assert.equal(isEpisodeScopedDelete({ type: 'series', season: 1, episode: 5 }), true)
    assert.equal(isEpisodeScopedDelete({ type: 'anime', season: 2, episode: 0 }), true)
    assert.equal(isEpisodeScopedDelete({ type: 'episode', season: 1, episode: 1 }), true)
    assert.equal(isEpisodeScopedDelete({ type: 'series', season: null, episode: null }), false, 'no coordinates')
    assert.equal(isEpisodeScopedDelete({ type: 'series', season: 1 }), false, 'episode missing')
})

test('a part-watched first episode (video_id set, no bitfield) is a whole-row delete', () => {
    const row: LibraryItem = {
        _id: 'ttMOVIE',
        type: 'series',
        state: { video_id: 'ttMOVIE:1:1', watched: '', timeOffset: 300_000 },
    }
    assert.equal(isBareAnchoredEpisode(row, 'ttMOVIE:1:1'), true)
    assert.equal(isBareAnchoredEpisode({ ...row, state: { ...row.state, watched: undefined } }, 'ttMOVIE:1:1'), true)
})

test('rows with bitfield state, a different anchor, or no anchor stay surgical', () => {
    assert.equal(
        isBareAnchoredEpisode({ _id: 'ttS', type: 'series', state: { video_id: 'ttS:1:1', watched: 'ttS:1:3:3:eJwDAAAAAAE' } }, 'ttS:1:1'),
        false, 'a populated bitfield must go through the planner',
    )
    assert.equal(
        isBareAnchoredEpisode({ _id: 'ttS', type: 'series', state: { video_id: 'ttS:1:2', watched: '' } }, 'ttS:1:1'),
        false, 'the row anchors on a different episode than the delete target',
    )
    assert.equal(
        isBareAnchoredEpisode({ _id: 'ttS', type: 'series', state: { watched: '' } }, 'ttS:1:1'),
        false, 'no video_id anchor at all',
    )
    assert.equal(isBareAnchoredEpisode(undefined, 'ttS:1:1'), false)
    assert.equal(isBareAnchoredEpisode({ _id: 'ttS', type: 'series' }, undefined), false)
})
