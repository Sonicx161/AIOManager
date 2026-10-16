import { fetchCinemetaDetail } from './cinemeta-cache.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'

// The library-refresh transforms call fetchCinemetaDetail once per episode row,
// and an episode list is the same show many times over. The trace mining of the
// real 8.9s library load showed 16+ rows for two shows; without in-flight dedupe
// each row fired its own full-detail Cinemeta download (the cache only fills
// AFTER the fetch, so a concurrent burst all misses). These tests pin the dedupe.

const metaJson = (name: string) => ({ meta: { id: 'tt0000001', type: 'series', name, poster: 'p.jpg', genre: 'Drama' } })

function withMockedFetch(handler: (url: string) => Promise<unknown>) {
    const calls: string[] = []
    const original = globalThis.fetch
    globalThis.fetch = ((input: RequestInfo | URL) => {
        const url = String(input)
        calls.push(url)
        return handler(url)
    }) as typeof fetch
    return {
        calls,
        restore: () => { globalThis.fetch = original },
    }
}

test('concurrent callers for one show share a single upstream fetch', async () => {
    const mock = withMockedFetch(async () => new Response(JSON.stringify(metaJson('Euphoria')), { headers: { 'Content-Type': 'application/json' } }))
    try {
        const results = await Promise.all(Array.from({ length: 8 }, () => fetchCinemetaDetail('tt10000001', 'series')))
        assert.equal(mock.calls.length, 1, `expected 1 upstream fetch, got ${mock.calls.length}`)
        assert.ok(results.every(r => r?.name === 'Euphoria'))

        // After completion the result cache serves follow-ups without a new fetch.
        const again = await fetchCinemetaDetail('tt10000001', 'series')
        assert.equal(again?.name, 'Euphoria')
        assert.equal(mock.calls.length, 1)
    } finally {
        mock.restore()
    }
})

test('a failed fetch is shared and its null result is served for the null-TTL window', async () => {
    const mock = withMockedFetch(async () => {
        throw new Error('network down')
    })
    try {
        const results = await Promise.all(Array.from({ length: 5 }, () => fetchCinemetaDetail('tt10000002', 'series')))
        assert.equal(mock.calls.length, 1)
        assert.ok(results.every(r => r === null))

        // Within the null-TTL window no retry fires.
        const retry = await fetchCinemetaDetail('tt10000002', 'series')
        assert.equal(retry, null)
        assert.equal(mock.calls.length, 1)
    } finally {
        mock.restore()
    }
})

test('different media types for the same id do not share an in-flight fetch', async () => {
    const mock = withMockedFetch(async (url: string) =>
        new Response(JSON.stringify(metaJson(url.includes('/movie/') ? 'The Movie' : 'The Series')), { headers: { 'Content-Type': 'application/json' } }))
    try {
        const [movie, series] = await Promise.all([
            fetchCinemetaDetail('tt10000003', 'movie'),
            fetchCinemetaDetail('tt10000003', 'series'),
        ])
        assert.equal(mock.calls.length, 2, 'movie and series requests are distinct upstream fetches')
        assert.equal(movie?.name, 'The Movie')
        assert.equal(series?.name, 'The Series')
    } finally {
        mock.restore()
    }
})
