import test from 'node:test'
import assert from 'node:assert/strict'
import { parseAIOStreamsUrl, getAIOStreamsConfigureUrl } from './aiostreams-url.ts'

test('standard AIOStreams urls parse host and uuid', () => {
    const parsed = parseAIOStreamsUrl('https://aiostreams.stremio.ru/stremio/d2484b9b-5214-4e99-afa8-1ea936d6f26a/manifest.json')
    assert.deepEqual(parsed, { baseUrl: 'https://aiostreams.stremio.ru', uuid: 'd2484b9b-5214-4e99-afa8-1ea936d6f26a' })
})

test('aliased AIOStreams urls (/stremio/u/<alias>/) resolve the alias, not the letter u', () => {
    const parsed = parseAIOStreamsUrl('https://aiostreams.stremio.ru/stremio/u/my-alias/manifest.json')
    assert.deepEqual(parsed, { baseUrl: 'https://aiostreams.stremio.ru', uuid: 'my-alias' })
})

test('aliased configure urls map to the per-user configure page', () => {
    const url = getAIOStreamsConfigureUrl('https://aiostreams.stremio.ru/stremio/u/my-alias/manifest.json')
    assert.equal(url, 'https://aiostreams.stremio.ru/stremio/u/my-alias/configure')
})

test('configure urls preserve query strings on standard paths', () => {
    const url = getAIOStreamsConfigureUrl('https://aiostreams.stremio.ru/stremio/d2484b9b-5214-4e99-afa8-1ea936d6f26a/manifest.json?addonName=My%20AIOStreams')
    assert.equal(url, 'https://aiostreams.stremio.ru/stremio/d2484b9b-5214-4e99-afa8-1ea936d6f26a/configure?addonName=My%20AIOStreams')
})

test('configure urls preserve query strings under alias paths', () => {
    const url = getAIOStreamsConfigureUrl('https://aiostreams.stremio.ru/stremio/u/my-alias/manifest.json?theme=dark')
    assert.equal(url, 'https://aiostreams.stremio.ru/stremio/u/my-alias/configure?theme=dark')
})

test('urls without a manifest suffix pass through unchanged', () => {
    const url = getAIOStreamsConfigureUrl('https://aiostreams.stremio.ru/stremio/u/my-alias/configure')
    assert.equal(url, 'https://aiostreams.stremio.ru/stremio/u/my-alias/configure')
})
