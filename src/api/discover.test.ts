import test from 'node:test'
import assert from 'node:assert/strict'
import { _invalidateCache, fetchDiscoverAddons, fetchDiscoverAddon, fetchDiscoverCategories, getConfigureUrl, getAddonResources, requiresConfiguration, type DiscoverAddon } from './discover.ts'

const addon = (overrides: Partial<DiscoverAddon> = {}): DiscoverAddon => ({
    uuid: 'example', url: 'https://catalog.example/addon', manifestUrl: 'https://addon.example/custom/manifest.json',
    manifest: { id: 'example', name: 'Example', version: '1', description: '', behaviorHints: { configurable: true } },
    slug: 'example', stars: 1, categories: [], configureUrl: null, createdAt: '', updatedAt: '', ...overrides,
})

test('configure URLs prefer explicit URLs, derive from configurable manifests, and reject invalid inputs', () => {
    assert.equal(getConfigureUrl(addon({ configureUrl: 'https://configured.example/' })), 'https://configured.example/')
    assert.equal(getConfigureUrl(addon()), 'https://addon.example/custom/configure')
    assert.equal(getConfigureUrl(addon({ manifestUrl: 'invalid' })), null)
    assert.equal(getConfigureUrl(addon({ manifest: { ...addon().manifest, behaviorHints: {} } })), null)
})

test('resource shapes and required configuration derive from manifest behavior', () => {
    const entry = addon({ manifest: { ...addon().manifest, resources: ['stream', { name: 'meta' }, {}] as never, behaviorHints: { configurationRequired: true } } })
    assert.deepEqual(getAddonResources(entry), ['stream', 'meta'])
    assert.equal(requiresConfiguration(entry), true)
    assert.equal(requiresConfiguration(addon()), false)
})

test('Discover requests encode filters, reuse successful cache entries, and retain upstream data', async t => {
    _invalidateCache()
    const urls: string[] = []
    const payload = { addons: [addon()], pagination: { page: 2 } }
    t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
        urls.push(String(url))
        return Response.json(payload)
    })
    const query = { search: '  example  ', category: ['video', 'other'], page: 2 }
    assert.deepEqual(await fetchDiscoverAddons(query), payload)
    await fetchDiscoverAddons(query)
    assert.equal(urls.length, 1)
    const url = new URL(urls[0])
    assert.equal(url.searchParams.get('search'), 'example')
    assert.deepEqual(url.searchParams.getAll('category'), ['video', 'other'])
    assert.equal(url.searchParams.get('page'), '2')
})

test('Discover errors are not cached and malformed list payloads become empty arrays', async t => {
    _invalidateCache()
    let calls = 0
    t.mock.method(globalThis, 'fetch', async () => ++calls === 1 ? new Response('', { status: 503 }) : Response.json({ categories: null, addons: null }))
    await assert.rejects(fetchDiscoverCategories(), /503/)
    assert.deepEqual(await fetchDiscoverCategories(), [])
    assert.deepEqual((await fetchDiscoverAddons()).addons, [])
    assert.equal(calls, 3)
})

test('Discover detail identifiers are path-encoded', async t => {
    _invalidateCache()
    let requested = ''
    t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => { requested = String(url); return Response.json(addon()) })
    await fetchDiscoverAddon('example/other')
    assert.ok(requested.endsWith('/addons/example%2Fother'))
})
