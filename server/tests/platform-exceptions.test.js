import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canonicalForPlatform, isExcludedFor } from '../providers/reconciler.js'

const addon = (url, excludePlatforms) => ({
    transportUrl: url,
    flags: excludePlatforms ? { enabled: true, excludePlatforms } : { enabled: true },
})

test('an account with no exclusions gets the same array back', () => {
    const canonical = [addon('https://a/manifest.json'), addon('https://b/manifest.json')]
    // Identity, not just equality: an account that has never set an exclusion
    // must not allocate a new list or take a different path.
    assert.equal(canonicalForPlatform(canonical, 'nuvio'), canonical)
    assert.equal(canonicalForPlatform(canonical, 'stremio'), canonical)
})

test('an excluded addon is withheld from that platform only', () => {
    const cinemeta = addon('https://cinemeta/manifest.json', ['nuvio'])
    const other = addon('https://other/manifest.json')
    const canonical = [cinemeta, other]

    const nuvio = canonicalForPlatform(canonical, 'nuvio')
    assert.deepEqual(nuvio.map(a => a.transportUrl), ['https://other/manifest.json'])

    const stremio = canonicalForPlatform(canonical, 'stremio')
    assert.deepEqual(stremio.map(a => a.transportUrl), [
        'https://cinemeta/manifest.json',
        'https://other/manifest.json',
    ])
})

test('excluding from several platforms withholds from each of them', () => {
    const canonical = [addon('https://x/manifest.json', ['nuvio', 'realstream'])]
    assert.equal(canonicalForPlatform(canonical, 'nuvio').length, 0)
    assert.equal(canonicalForPlatform(canonical, 'realstream').length, 0)
    assert.equal(canonicalForPlatform(canonical, 'stremio').length, 1)
})

test('a missing platform name withholds nothing', () => {
    const canonical = [addon('https://x/manifest.json', ['nuvio'])]
    assert.equal(canonicalForPlatform(canonical, undefined), canonical)
    assert.equal(canonicalForPlatform(canonical, null), canonical)
})

test('a malformed exclusion is ignored rather than throwing', () => {
    assert.equal(isExcludedFor({ flags: { excludePlatforms: 'nuvio' } }, 'nuvio'), false)
    assert.equal(isExcludedFor({ flags: {} }, 'nuvio'), false)
    assert.equal(isExcludedFor({}, 'nuvio'), false)
    assert.equal(isExcludedFor(null, 'nuvio'), false)
})
