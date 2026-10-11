import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'
import { addonManifestUrl, addonEndpointUrl } from '../server/utils/addon-endpoint-url.js'
import { createStremioDriver } from '../server/providers/stremio-driver.js'
import { registerProxyRoutes } from '../server/routes/proxy.js'
import { setupTestEnv, cleanupTestEnv, mockFetch } from '../server/tests/helpers.js'

const base = 'https://example.com/stremio/AbC/Token%2FX'
const suffix = '?token=A?B%2FC&x=2#Part'
const addon = { transportUrl: base + suffix, manifest: { id: 'test', name: 'Test', version: '1.0.0', types: [], resources: [] }, flags: { protected: true }, metadata: { name: 'Custom' } }
const expected = { ...addon, transportUrl: base + '/manifest.json' + suffix }

test('endpoint URLs preserve opaque path, query and fragment and are idempotent', () => {
  for (const tail of ['', '/', '/manifest', '/manifest.json', '/configure', '/configure/']) {
    assert.equal(addonManifestUrl(base + tail + suffix), expected.transportUrl)
    assert.equal(addonEndpointUrl(base + tail + suffix, 'configure'), base + '/configure' + suffix)
  }
  assert.equal(addonManifestUrl('stremio://example.com/AbC'), 'https://example.com/AbC/manifest.json')
  assert.equal(addonManifestUrl('http://example.com/AbC/manifest.json'), 'http://example.com/AbC/manifest.json')
  assert.equal(addonManifestUrl(''), '')
  assert.throws(() => addonEndpointUrl('javascript:bad', 'configure'))
})

test('provider emits corrected collection without mutating names, flags or input', async () => {
  const mock = mockFetch(() => ({ result: true }))
  try {
    await createStremioDriver().writeAddons('synthetic-auth', [addon])
    assert.deepEqual(mock.calls[0].body.addons, [expected])
    assert.equal(addon.transportUrl, base + suffix)
  } finally { mock.restore() }
})

test('authenticated proxy corrects outbound URLs; keeps authorization and validation', async () => {
  const app = await setupTestEnv()
  app.addHook('onRequest', async request => {
    if (request.headers['x-test-device'] === 'authorized') request.deviceAuth = { accountUuid: 'synthetic' }
  })
  registerProxyRoutes(app, { checkAddonHealthInternal: async () => ({}) })
  const mock = mockFetch(() => ({ result: true }))
  try {
    const payload = { type: 'AddonCollectionSet', authKey: 'synthetic', addons: [addon] }
    assert.equal((await app.inject({ method: 'POST', url: '/api/stremio-proxy', payload })).statusCode, 401)
    assert.equal(mock.calls.length, 0)
    const result = await app.inject({ method: 'POST', url: '/api/stremio-proxy', headers: { 'x-test-device': 'authorized' }, payload })
    assert.equal(result.statusCode, 200, result.body)
    assert.deepEqual(mock.calls[0].body.addons, [expected])
    const invalid = await app.inject({ method: 'POST', url: '/api/stremio-proxy', headers: { 'x-test-device': 'authorized' }, payload: { ...payload, addons: [{ ...addon, transportUrl: 'javascript:bad' }] } })
    assert.equal(invalid.statusCode, 400)
    assert.equal(mock.calls.length, 1)
  } finally { mock.restore(); await app.close(); cleanupTestEnv() }
})

// Execute the real compiled client class with only network/auth/UI dependencies replaced.
async function clientModule() {
  const context = vm.createContext({ URL, console, Date, Response, Error })
  const calls = []
  const mockExports = {
    '@/lib/addon-endpoint-url': { addonManifestUrl },
    '@/lib/api-resilience': { resilientFetch: async (url, options) => {
      calls.push({ url, body: options?.body && JSON.parse(options.body) })
      return new Response(JSON.stringify(options?.body ? { result: true } : addon.manifest))
    } },
    '@/store/syncStore': { useSyncStore: { getState: () => ({ auth: { isAuthenticated: false } }) } },
    '@/lib/crypto': { deriveSyncToken: () => 'synthetic' },
    '@/lib/addon-identifier': { getHostnameIdentifier: () => 'test', identifyAddon: (_url, manifest) => manifest },
    '@/lib/trace': { trace: () => {} },
    '@/lib/account-contexts': { ACCOUNT_CONTEXT_SYSTEM_CHECK: 'System-Check' },
    './stremio-relay': { exchangeFacebookLogin: () => {}, exchangeAppleLogin: () => {}, deleteStremioUser: () => {} },
  }
  const code = ts.transpileModule(await readFile('src/api/stremio-client.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  const module = new vm.SourceTextModule(code, { context, initializeImportMeta: meta => { meta.env = { DEV: false } } })
  await module.link(specifier => {
    const exports = mockExports[specifier]
    assert.ok(exports, `Unexpected dependency: ${specifier}`)
    return new vm.SyntheticModule(Object.keys(exports), function () { for (const [key, value] of Object.entries(exports)) this.setExport(key, value) }, { context })
  })
  await module.evaluate()
  return { client: module.namespace.stremioClient, calls }
}

test('client fetch stores actual manifest URL and outbound/rollback writes normalize', async () => {
  const { client, calls } = await clientModule()
  const fetched = await client.fetchAddonManifest(addon.transportUrl)
  assert.equal(fetched.transportUrl, expected.transportUrl)
  assert.equal(new URL(calls[0].url, 'https://manager.example').searchParams.get('url'), expected.transportUrl)
  await client.setAddonCollection('synthetic', [addon], 'test', { allowCollectionShrink: true })
  assert.deepEqual(calls[1].body.addons, [expected])
  client.getAddonCollection = async () => []
  await assert.rejects(client.setAddonCollection('synthetic', [addon], 'test', { previousCollection: [addon] }), /Safety rollback/)
  assert.deepEqual(calls.at(-1).body.addons, [expected])
})

test('actual AIOStreams Configure helper handles bare URLs and rejects invalid schemes', async () => {
  const context = vm.createContext({ URL })
  const code = ts.transpileModule(await readFile('src/lib/aiostreams-url.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText
  const module = new vm.SourceTextModule(code, { context })
  await module.link(() => new vm.SyntheticModule(['addonEndpointUrl'], function () { this.setExport('addonEndpointUrl', addonEndpointUrl) }, { context }))
  await module.evaluate()
  for (const tail of ['', '/manifest.json', '/configure']) {
    assert.equal(module.namespace.getAIOStreamsConfigureUrl(base + tail + suffix), base + '/configure' + suffix)
  }
  assert.equal(module.namespace.getAIOStreamsConfigureUrl('javascript:bad'), null)
})

test('suffix-only universal source replacement reaches account and failover stores', async () => {
  const source = await readFile('src/store/addon/addonDeployment.ts', 'utf8')
  const extracted = source.slice(source.indexOf('export async function replaceTransportUrlUniversally('), source.indexOf('export async function bulkReinstallAllOnAccount('))
  const calls = []
  const context = vm.createContext({ Date, Error, identifyAddon: (_url, manifest) => manifest })
  const dependencies = {
    '../addonStore': { useAddonStore: { setState: () => {}, getState: () => ({ library: {} }) }, _saveLibraryDebounced: () => {} },
    '@/store/accountStore': { useAccountStore: { getState: () => ({ replaceTransportUrl: async (...args) => { calls.push(['account', ...args]); return { updatedAccountIds: ['test-account'], failedAccounts: [] } } }) } },
    '@/store/failoverStore': { useFailoverStore: { getState: () => ({ replaceUrlInRules: async (...args) => calls.push(['failover', ...args]) }) } },
  }
  const code = ts.transpileModule(extracted, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  const module = new vm.SourceTextModule(code, { context, initializeImportMeta: meta => { meta.env = { DEV: false } }, importModuleDynamically: async specifier => {
    const exports = dependencies[specifier]
    assert.ok(exports, specifier)
    const dependency = new vm.SyntheticModule(Object.keys(exports), function () { for (const [key, value] of Object.entries(exports)) this.setExport(key, value) }, { context })
    await dependency.link(() => {})
    await dependency.evaluate()
    return dependency
  } })
  await module.link(() => {})
  await module.evaluate()
  const result = await module.namespace.replaceTransportUrlUniversally(null, base, base + '/manifest.json', 'test-account', addon)
  assert.equal(result.updatedAccountIds[0], 'test-account')
  assert.equal(calls.length, 2)
  assert.equal(calls[0][1], base)
  assert.equal(calls[0][2], base + '/manifest.json')
  assert.equal(calls[1][0], 'failover')
})
