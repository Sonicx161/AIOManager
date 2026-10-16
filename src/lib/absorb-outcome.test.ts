import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { evaluateAbsorbOutcome } from './absorb-outcome.ts'

test('absorb deletion propagation decision: tombstone-only discovery propagates without a local change', () => {
    const r = evaluateAbsorbOutcome(2, 0, 2)
    assert.equal(r.changed, false)
    assert.equal(r.propagateDeletions, true)
})

test('mixed discovery counts as a change and propagates deletions alongside new addons', () => {
    const r = evaluateAbsorbOutcome(3, 2, 1)
    assert.equal(r.changed, true)
    assert.equal(r.propagateDeletions, true)
})

test('no tombstoned addons means nothing to propagate', () => {
    const r = evaluateAbsorbOutcome(0, 3, 0)
    assert.equal(r.changed, true)
    assert.equal(r.propagateDeletions, false)
})

test('completely empty discovery stays passive on both flags', () => {
    const r = evaluateAbsorbOutcome(0, 0, 0)
    assert.equal(r.changed, false)
    assert.equal(r.propagateDeletions, false)
})

test('the release notes draft matches the actual v1.8.5..HEAD fix set', () => {
    const src = readFileSync(new URL('../../test-support/fixtures/release-notes-v2.0.0-draft.md', import.meta.url), 'utf8')
    for (const fixed of ['304', 'Force push', 'Health checks disabling', 'Watched episode corruption', 'Addon names disappearing', 'Session restore']) {
        assert.match(src, new RegExp(fixed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `missing fix: ${fixed}`)
    }
    for (const notA2Fix of ['429 bursts', 'OpenSubtitles v1 console spam', 'private-IP addons']) {
        assert.doesNotMatch(src, new RegExp(notA2Fix), `v1.8.5-era fix leaked into v2.0.0 notes: ${notA2Fix}`)
    }
})
