import test from 'node:test'
import assert from 'node:assert/strict'
import { getAddonInstanceKey, claimInstanceRemotes } from './addon-instance-identity.ts'
import { mergeAddons, normalizeAddonUrl } from './utils.ts'
import { dedupeAddonsByTransportUrl } from './addon-dedupe.ts'
import type { AddonDescriptor } from '@/types/addon'

const UUID_A = 'd2484b9b-1a2b-3c4d-5e6f-7a8b9c0d1e2f'
const UUID_B = '362cb5c8-1122-3333-4444-555566667777'
const AIOS_ID = `com.aiostreams.viren070.${UUID_A}`
const AIOS_OLD_URL = `https://aiostreams.viren070.dev/${UUID_A}/${'A'.repeat(80)}/manifest.json`
const AIOS_NEW_URL = `https://aiostreams.viren070.dev/${UUID_A}/${'B'.repeat(80)}/manifest.json`
const META_ID = 'aio-metadata'
const META_URL_A = `https://meta.sonicx161.com/stremio/${UUID_A}/manifest.json`
const META_URL_B = `https://meta.sonicx161.com/stremio/${UUID_B}/manifest.json`
const VANILLA_URL = 'https://cinemeta.stremio.top/manifest.json'
const MF_URL = 'https://mediafusion.example.com/manifest.json'
const MF_BASE_ID = 'stremio.addons.mediafusion'
const MF_MIDNIGHT_ID = 'stremio.addons.mediafusion|midnight'
const MF_ELFHOSTED_ID = 'stremio.addons.mediafusion|elfhosted'

const mkAddon = (transportUrl: string, manifestId: string, overrides: Partial<AddonDescriptor> = {}): AddonDescriptor => ({
  transportUrl,
  manifest: { id: manifestId, name: 'Test Addon', version: '1.0.0', description: '' },
  ...overrides,
})

test('T1: instance key is stable across config changes and distinguishes variants', () => {
  const oldKey = getAddonInstanceKey(mkAddon(AIOS_OLD_URL, AIOS_ID))
  const newKey = getAddonInstanceKey(mkAddon(AIOS_NEW_URL, AIOS_ID))
  assert.equal(oldKey, newKey)

  const otherUuidUrl = `https://aiostreams.viren070.dev/${UUID_B}/${'A'.repeat(80)}/manifest.json`
  assert.notEqual(oldKey, getAddonInstanceKey(mkAddon(otherUuidUrl, `com.aiostreams.viren070.${UUID_B}`)))

  const otherHostUrl = `https://aiostreams.other.dev/${UUID_A}/${'A'.repeat(80)}/manifest.json`
  assert.notEqual(oldKey, getAddonInstanceKey(mkAddon(otherHostUrl, AIOS_ID)))

  assert.notEqual(
    getAddonInstanceKey(mkAddon(META_URL_A, META_ID)),
    getAddonInstanceKey(mkAddon(META_URL_B, META_ID)),
  )

  assert.equal(getAddonInstanceKey(mkAddon(VANILLA_URL, '')), normalizeAddonUrl(VANILLA_URL))

  // volatility threshold: non-uuid segments at/below 40 chars are stable identity,
  // above 40 they are encrypted config blobs and must not affect the key
  const shortSegUrl = (seg: string) => `https://aiostreams.viren070.dev/${UUID_A}/${seg}/manifest.json`
  assert.notEqual(
    getAddonInstanceKey(mkAddon(shortSegUrl('a'.repeat(40)), AIOS_ID)),
    getAddonInstanceKey(mkAddon(shortSegUrl('b'.repeat(40)), AIOS_ID)),
  )
  assert.equal(
    getAddonInstanceKey(mkAddon(shortSegUrl('a'.repeat(41)), AIOS_ID)),
    getAddonInstanceKey(mkAddon(shortSegUrl('b'.repeat(41)), AIOS_ID)),
  )
})

test('T2: sync fold adopts the remote config URL at the local position', () => {
  const local = [mkAddon(AIOS_OLD_URL, AIOS_ID, { flags: { enabled: true }, note: 'my note' })]
  const remote = [mkAddon(AIOS_NEW_URL, AIOS_ID)]
  const out = mergeAddons(local, remote, { instanceMatch: 'adopt-remote-url' })

  assert.equal(out.length, 1)
  assert.equal(out[0].transportUrl, AIOS_NEW_URL)
  assert.equal(out[0].note, 'my note')
})

test('T3: same-addon variants are preserved; only the matched instance is replaced', () => {
  const variantB = mkAddon(META_URL_B, META_ID, { note: 'variant b' })
  const local = [mkAddon(META_URL_A, META_ID, { flags: { enabled: true } }), variantB]
  const remote = [mkAddon(`https://meta.sonicx161.com/stremio/${UUID_A}/${'C'.repeat(80)}/manifest.json`, META_ID)]
  const out = mergeAddons(local, remote, { instanceMatch: 'adopt-remote-url' })

  assert.equal(out.length, 2)
  assert.equal(out[0].transportUrl, remote[0].transportUrl)
  assert.deepEqual(out[1], variantB)

  const claims = claimInstanceRemotes(local, remote)
  assert.equal(claims.size, 1)
  assert.equal(claims.get(local[0]), remote[0])
})

test('T4: hub read keeps the local (authoritative) URL', () => {
  const local = [mkAddon(AIOS_NEW_URL, AIOS_ID, { flags: { enabled: true } })]
  const remote = [mkAddon(AIOS_OLD_URL, AIOS_ID)]
  const out = mergeAddons(local, remote, { keepMissingLocal: true, instanceMatch: 'keep-local-url' })

  assert.equal(out.length, 1)
  assert.equal(out[0].transportUrl, AIOS_NEW_URL)
})

test('T5: install replaces the same-instance entry instead of appending', () => {
  const base = [mkAddon(AIOS_OLD_URL, AIOS_ID, { note: 'keep me' })]
  const install = mkAddon(AIOS_NEW_URL, AIOS_ID, { metadata: { lastUpdated: Date.now() } })
  const merged = mergeAddons(base, [install], { keepMissingLocal: true, instanceMatch: 'adopt-remote-url' })
  const final = dedupeAddonsByTransportUrl(merged)

  assert.equal(final.length, 1)
  assert.equal(final[0].transportUrl, AIOS_NEW_URL)
  assert.equal(final[0].note, 'keep me')
})

test('T6: dedupe self-heals an existing old/new duplicate pair', () => {
  const disabledOld = mkAddon(AIOS_OLD_URL, AIOS_ID, { flags: { enabled: false } })
  const enabledNew = mkAddon(AIOS_NEW_URL, AIOS_ID, { flags: { enabled: true } })
  const collapsed = dedupeAddonsByTransportUrl([disabledOld, enabledNew])

  assert.equal(collapsed.length, 1)
  assert.equal(collapsed[0].transportUrl, AIOS_NEW_URL)
  assert.equal(collapsed[0].flags?.enabled, true)

  const vanilla = mkAddon(VANILLA_URL, 'com.linvo.cinemeta')
  const ordered = dedupeAddonsByTransportUrl([vanilla, disabledOld, enabledNew])
  assert.equal(ordered.length, 2)
  assert.equal(ordered[0].transportUrl, VANILLA_URL)
  assert.equal(ordered[1].transportUrl, AIOS_NEW_URL)

  const protectedOld = mkAddon(AIOS_OLD_URL, AIOS_ID, { flags: { protected: true } })
  const plainNew = mkAddon(AIOS_NEW_URL, AIOS_ID)
  assert.equal(dedupeAddonsByTransportUrl([protectedOld, plainNew])[0].flags?.protected, true)
})

test('T7: replacement preserves the protected flag', () => {
  const local = [mkAddon(AIOS_OLD_URL, AIOS_ID, { flags: { protected: true, enabled: true }, note: 'p' })]
  const remote = [mkAddon(AIOS_NEW_URL, AIOS_ID, { flags: { protected: false } })]
  const out = mergeAddons(local, remote, { instanceMatch: 'adopt-remote-url' })

  assert.equal(out.length, 1)
  assert.equal(out[0].transportUrl, AIOS_NEW_URL)
  assert.equal(out[0].flags?.protected, true)
  assert.equal(out[0].note, 'p')
})

test('T8: vanilla addons behave identically with and without instance matching', () => {
  const vanillaLocal = [
    mkAddon(VANILLA_URL, 'com.linvo.cinemeta', { flags: { enabled: true } }),
    mkAddon('https://trakt-addon.example.com/manifest.json', 'stremio.trakt'),
  ]
  const vanillaRemote = [
    mkAddon(VANILLA_URL, 'com.linvo.cinemeta'),
    mkAddon('https://torrentio.strem.fun/manifest.json', 'com.torrentio'),
  ]

  const withoutOption = mergeAddons(vanillaLocal, vanillaRemote, { keepMissingLocal: true })
  const withOption = mergeAddons(vanillaLocal, vanillaRemote, { keepMissingLocal: true, instanceMatch: 'adopt-remote-url' })
  assert.deepEqual(withOption, withoutOption)

  const keepLocal = mergeAddons(vanillaLocal, vanillaRemote, { keepMissingLocal: true, instanceMatch: 'keep-local-url' })
  assert.deepEqual(keepLocal, withoutOption)

  assert.deepEqual(dedupeAddonsByTransportUrl(vanillaLocal), vanillaLocal)
  const combined = dedupeAddonsByTransportUrl([...vanillaLocal, ...vanillaRemote])
  assert.deepEqual(combined.map((a) => a.transportUrl), [
    VANILLA_URL,
    'https://trakt-addon.example.com/manifest.json',
    'https://torrentio.strem.fun/manifest.json',
  ])
})

test('T1b: manifest.id is verbatim - case-different ids are different instances', () => {
    const keyUpper = getAddonInstanceKey(mkAddon(META_URL_A, 'Com.Aio.Metadata'))
    const keyLower = getAddonInstanceKey(mkAddon(META_URL_A, 'com.aio.metadata'))
    assert.notEqual(keyUpper, keyLower)
})

test('T1c: MediaFusion pipe-suffix trio stays distinct', () => {
    const base = getAddonInstanceKey(mkAddon(MF_URL, MF_BASE_ID))
    const midnight = getAddonInstanceKey(mkAddon(MF_URL, MF_MIDNIGHT_ID))
    const elfhosted = getAddonInstanceKey(mkAddon(MF_URL, MF_ELFHOSTED_ID))
    assert.notEqual(base, midnight)
    assert.notEqual(base, elfhosted)
    assert.notEqual(midnight, elfhosted)
})

test('T1d: query is identity when config is not in the path', () => {
    const keyA = getAddonInstanceKey(mkAddon('https://addon.example.com/manifest.json?apikey=AAA', MF_BASE_ID))
    const keyB = getAddonInstanceKey(mkAddon('https://addon.example.com/manifest.json?apikey=BBB', MF_BASE_ID))
    assert.notEqual(keyA, keyB)
})

test('T1e: query is noise when the config lives in the path', () => {
    const withQuery = getAddonInstanceKey(mkAddon(AIOS_NEW_URL + '?x=1', AIOS_ID))
    const without = getAddonInstanceKey(mkAddon(AIOS_NEW_URL, AIOS_ID))
    assert.equal(withQuery, without)
})

test('T-oldest-claim: the oldest local claims the incoming remote, the rest are preserved', () => {
    const oldLocal = mkAddon(AIOS_OLD_URL, AIOS_ID, { metadata: { lastUpdated: 100 } })
    const newerLocal = mkAddon('https://aiostreams.viren070.dev/' + UUID_A + '/' + 'C'.repeat(80) + '/manifest.json', AIOS_ID, { metadata: { lastUpdated: 200 } })
    const remote = mkAddon(AIOS_NEW_URL, AIOS_ID)
    const claims = claimInstanceRemotes([oldLocal, newerLocal], [remote])
    assert.equal(claims.size, 1)
    assert.equal(claims.get(oldLocal), remote)
})

test('T-dedupe-query: query-differentiated instances survive the dedupe', () => {
    const a = mkAddon('https://addon.example.com/manifest.json?apikey=AAA', MF_BASE_ID)
    const b = mkAddon('https://addon.example.com/manifest.json?apikey=BBB', MF_BASE_ID)
    const out = dedupeAddonsByTransportUrl([a, b])
    assert.equal(out.length, 2)
})

test('alias and uuid AIOStreams urls unify into one instance key (real redirect pair)', () => {
  const uuidForm = { manifest: { id: 'com.aiostreams.viren070.f27a922d-ee2' }, transportUrl: 'https://stream.sonicx161.com/stremio/f27a922d-ee28-47cd-8c64-38f9c1103487/eyJpdiI6IkYrZGJtK2hoTGg4azZkeGEySXdXZEE9PSIsImVuY3J5cHRlZCI6InNwOFFUQlB6VWJxRC9qaTIvaFFFOE91Rnh5aGRIVkdjMjU2bWYyTCt5UDg9IiwidHlwZSI6ImFpb0VuY3J5cHQifQ/manifest.json' }
  const aliasForm = { manifest: { id: 'com.aiostreams.viren070.f27a922d-ee2' }, transportUrl: 'https://stream.sonicx161.com/stremio/u/me/manifest.json' }
  assert.equal(getAddonInstanceKey(aliasForm), getAddonInstanceKey(uuidForm))
})

test('alias path variant and uuid path variant unify; different variants stay distinct', () => {
  const id = 'com.aiostreams.viren070.f27a922d-ee2'
  const uuidVariant = { manifest: { id }, transportUrl: 'https://stream.sonicx161.com/stremio/f27a922d-ee28-47cd-8c64-38f9c1103487/eyJpbmRleCI6IjEyMzQ1Njc4OWFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6In0/v/variant/manifest.json' }
  const aliasVariant = { manifest: { id }, transportUrl: 'https://stream.sonicx161.com/stremio/u/me/v/variant/manifest.json' }
  const aliasQueryVariant = { manifest: { id }, transportUrl: 'https://stream.sonicx161.com/stremio/u/me/manifest.json?v=variant' }
  assert.equal(getAddonInstanceKey(aliasVariant), getAddonInstanceKey(uuidVariant))
  assert.notEqual(getAddonInstanceKey(aliasQueryVariant), getAddonInstanceKey(aliasVariant))
})

test('aiometadata users never collapse: no uuid in manifest id keeps path identity', () => {
  const a = { manifest: { id: 'aio-metadata' }, transportUrl: 'https://meta.example.com/stremio/uuid-one/manifest.json' }
  const b = { manifest: { id: 'aio-metadata' }, transportUrl: 'https://meta.example.com/stremio/uuid-two/manifest.json' }
  assert.notEqual(getAddonInstanceKey(a), getAddonInstanceKey(b))
})