import { compressSyncPayload, decompressSyncPayload } from './sync-payload-codec.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'

// The wire format is zlib + base64, and any change here MUST round-trip
// byte-identically: a compressor swap once shipped without this gate and
// stored undecodable payloads (see the codec's header comment).

test('compressed payloads round-trip byte-identically', async () => {
    const state = JSON.stringify({
        accounts: [{ id: 'acc-1', name: 'Ünïcode ✅ account', addons: Array.from({ length: 40 }, (_, i) => ({ transportUrl: `https://addon-${i}.example/manifest.json`, enabled: i % 2 === 0 })) }],
        nested: { deep: { arr: [1, 2, 3], empty: '', n: null } },
    })
    const compressed = await compressSyncPayload(state)
    assert.notEqual(compressed, state)
    assert.match(compressed, /^[A-Za-z0-9+/=]+$/, 'wire format must stay plain base64')
    const round = await decompressSyncPayload(compressed)
    assert.equal(round, state)
})

test('the empty string and unicode survive the wire format', async () => {
    for (const probe of ['', '{"a":""}', '{"emoji":"🚀📜"}']) {
        const compressed = await compressSyncPayload(probe)
        assert.equal(await decompressSyncPayload(compressed), probe)
    }
})
