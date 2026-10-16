import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateAbsorbOutcome } from './absorb-outcome.ts'

test('tombstone-only discovery propagates the deletion without a local change (the #56/#59 family loop)', () => {
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

test('completely empty discovery stays passive', () => {
    const r = evaluateAbsorbOutcome(0, 0, 0)
    assert.equal(r.changed, false)
    assert.equal(r.propagateDeletions, false)
})
