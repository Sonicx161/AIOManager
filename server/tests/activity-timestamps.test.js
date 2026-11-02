process.env.ENCRYPTION_KEY = 'test-encryption-key-32bytes-long!!'

import test from 'node:test'
import assert from 'node:assert/strict'

import { parseEventTime } from '../activity/engine.js'

test('parseEventTime reads an ISO timestamp', () => {
    assert.equal(parseEventTime('2024-05-25T10:00:00.000Z'), Date.parse('2024-05-25T10:00:00.000Z'))
})

test('parseEventTime treats the zero date as missing', () => {
    assert.equal(parseEventTime('0001-01-01T00:00:00Z'), 0)
    assert.equal(parseEventTime('1969-12-31T23:59:59Z'), 0)
    assert.equal(parseEventTime('1970-01-01T00:00:00Z'), 0)
    assert.equal(parseEventTime(0), 0)
    assert.equal(parseEventTime('not a date'), 0)
})

test('parseEventTime clamps future timestamps to now', () => {
    const parsed = parseEventTime(new Date(Date.now() + 24 * 3600 * 1000).toISOString())
    assert.ok(Math.abs(parsed - Date.now()) < 5000)
})
