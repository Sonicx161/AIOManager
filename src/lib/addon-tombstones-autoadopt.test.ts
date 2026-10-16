import test from 'node:test'
import assert from 'node:assert/strict'
import { filterResurrectedAuto } from './addon-tombstones.ts'

const URL_PIPE = 'https://example.com/pipe/manifest.json'
const KEY_PIPE = 'https://example.com/pipe'
const NOW = 1700000000000
const TTL = 21 * 24 * 60 * 60 * 1000

test('first sighting of a tombstoned out-of-band addon is suppressed', () => {
  const remote = [{ transportUrl: URL_PIPE }]
  const r = filterResurrectedAuto(remote, [], { [KEY_PIPE]: NOW - 1000 }, {}, NOW, TTL)
  assert.equal(r.kept.length, 0)
  assert.equal(r.adopted.length, 0)
  assert.equal(r.suppressedCount, 1)
  assert.equal(r.nextSightings[KEY_PIPE], undefined)
})

test('repeated stale sightings do not adopt a deleted addon', () => {
  const remote = [{ transportUrl: URL_PIPE }]
  const sightings = { [KEY_PIPE]: 2 }
  const r = filterResurrectedAuto(remote, [], { [KEY_PIPE]: NOW - 1000 }, sightings, NOW, TTL)
  assert.equal(r.kept.length, 0)
  assert.equal(r.adopted.length, 0)
  assert.equal(r.nextSightings[KEY_PIPE], 2)
})

test('saved sighting count does not authorize a remote reinstall', () => {
  const remote = [{ transportUrl: URL_PIPE }]
  const sightings = { [KEY_PIPE]: 1 }
  const r = filterResurrectedAuto(remote, [], { [KEY_PIPE]: NOW - 1000 }, sightings, NOW, TTL)
  assert.equal(r.kept.length, 0)
  assert.equal(r.suppressedCount, 1)
  assert.equal(r.nextSightings[KEY_PIPE], 1)
})

test('local presence wins over the tombstone regardless of sightings', () => {
  const remote = [{ transportUrl: URL_PIPE }]
  const local = [{ transportUrl: URL_PIPE }]
  const r = filterResurrectedAuto(remote, local, { [KEY_PIPE]: NOW - 1000 }, {}, NOW, TTL)
  assert.equal(r.kept.length, 1)
  assert.equal(r.adopted.length, 0)
})

test('expired tombstones no longer suppress', () => {
  const remote = [{ transportUrl: URL_PIPE }]
  const expired = NOW - TTL - 1000
  const r = filterResurrectedAuto(remote, [], { [KEY_PIPE]: expired }, {}, NOW, TTL)
  assert.equal(r.kept.length, 1)
  assert.equal(r.suppressedCount, 0)
})

test('non-tombstoned addons pass through without touching counters', () => {
  const remote = [{ transportUrl: 'https://example.com/other/manifest.json' }]
  const sightings = { [KEY_PIPE]: 1 }
  const r = filterResurrectedAuto(remote, [], {}, sightings, NOW, TTL)
  assert.equal(r.kept.length, 1)
  assert.deepEqual(r.nextSightings, sightings)
})

test('absent addon leaves old counter untouched', () => {
  const first = filterResurrectedAuto([{ transportUrl: URL_PIPE }], [], { [KEY_PIPE]: NOW - 1000 }, {}, NOW, TTL)
  assert.equal(first.nextSightings[KEY_PIPE], undefined)
  const gone = filterResurrectedAuto([], [], { [KEY_PIPE]: NOW - 1000 }, first.nextSightings, NOW, TTL)
  assert.equal(gone.nextSightings[KEY_PIPE], undefined)
})
