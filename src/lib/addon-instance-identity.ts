// Addon instance identity: a composite key (origin + manifest.id + stable path
// segments + config). The config (long non-uuid path segments and the query) is
// part of identity unless a uuid anchors the instance: two configs of one host
// (Torrentio RD + TorBox) are two instances. A uuid-anchored config-URL addon
// (AIOStreams, AIOMetadata) rewrites its encrypted config segment on every
// re-save, so for it the config is dropped and the SAME logical instance keeps
// ONE key, while a different uuid or origin still yields a different key.
//
// Pure leaf math on the addon object — no side effects, node:test importable.
// Scope: used ONLY by the sync-replace/dedupe decisions in mergeAddons
// (utils.ts), dedupeAddonsByTransportUrl (addon-dedupe.ts) and the saved-addon
// deploy merge (addon-merger.ts). Never a general dedupe of arbitrary
// collections.
import type { AddonDescriptor } from '@/types/addon'
import { normalizeAddonUrl } from './addon-url.ts'

const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// A path segment that is not UUID-shaped and exceeds this length is an
// encrypted per-config blob.
const MAX_STABLE_SEGMENT_LENGTH = 40
// Instance uuid embedded in manifest.id, boundary-guarded so hex fragments or a
// longer build hash cannot fake one. AIOStreams also appends the uuid's first
// 12 hex; that short form counts only on AIOStreams ids and needs an a-f letter.
const EMBEDDED_UUID_DASHED = /(?<![0-9a-f])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f])/
const EMBEDDED_UUID_COMPACT = /(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/
const AIOSTREAMS_SHORT_TAIL = /aiostreams.*[.-](?=[0-9a-f]*[a-f])[0-9a-f]{12}$/
// Escapes that would become a path, query or escape boundary stay encoded.
const BOUNDARY_ESCAPES = new Set(['%2F', '%26', '%3D', '%3F', '%23', '%25'])

function decodeWithinBoundaries(part: string): string {
  return part.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
    let out = ''
    let pending = ''
    const flush = () => {
      if (!pending) return
      try { out += decodeURIComponent(pending) } catch { out += pending }
      pending = ''
    }
    for (let i = 0; i < run.length; i += 3) {
      const escape = run.slice(i, i + 3).toUpperCase()
      if (BOUNDARY_ESCAPES.has(escape)) { flush(); out += escape } else pending += escape
    }
    flush()
    return out
  })
}

export type AddonIdentity = { configless: string; instance: string; unanchoredConfig: boolean }

const plain = (key: string): AddonIdentity => ({ configless: key, instance: key, unanchoredConfig: false })

// Both keys from one parse. configless is shared by every config of one addon
// on one host; unanchoredConfig marks a URL whose config is part of identity.
export function getAddonIdentity(addon: Pick<AddonDescriptor, 'transportUrl' | 'manifest'>): AddonIdentity {
  const manifestId = addon.manifest?.id
  const url = addon.transportUrl
  if (!manifestId || !url) return plain(normalizeAddonUrl(url || ''))

  let parsed: URL
  try {
    parsed = new URL(url.replace(/^stremio:\/\//i, 'https://'))
  } catch {
    return plain(normalizeAddonUrl(url))
  }
  if (!parsed.hostname) return plain(normalizeAddonUrl(url))

  const origin = `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}`
  const allSegments = parsed.pathname
    .replace(/\/manifest\.json$/i, '')
    .replace(/\/+$/, '')
    .split('/')
    .filter(Boolean)
  // stremio/u/<alias> is server-resolved routing for the same instance - drop the pair.
  const withoutAlias: string[] = []
  for (let i = 0; i < allSegments.length; i++) {
    if (allSegments[i] === 'u' && i + 1 < allSegments.length) { i++; continue }
    withoutAlias.push(allSegments[i])
  }
  const configSegments = withoutAlias.filter(
    (segment) => !UUID_SEGMENT.test(segment) && segment.length > MAX_STABLE_SEGMENT_LENGTH
  )
  // manifest.id embedding the instance uuid (AIOStreams truncates it) makes the matching uuid path segment redundant.
  const idCompact = manifestId.toLowerCase().replace(/[^0-9a-z]/g, '')
  const stableSegments = withoutAlias.filter((segment) => {
    if (UUID_SEGMENT.test(segment) && idCompact.includes(segment.replace(/-/g, '').slice(0, 8))) return false
    return UUID_SEGMENT.test(segment) || segment.length <= MAX_STABLE_SEGMENT_LENGTH
  })
  const stablePath = stableSegments.map((segment) => segment.toLowerCase()).join('/')
  // Query is identity unless config lives in the path - dropping it would collapse dual-config addons.
  const querySuffix = configSegments.length > 0 ? '' : parsed.search
  const base = `${origin.toLowerCase()}|${manifestId}|${stablePath}${querySuffix}`
  if (configSegments.length === 0) return plain(base)

  const idLower = manifestId.toLowerCase()
  const uuidAnchored =
    withoutAlias.some((segment) => UUID_SEGMENT.test(segment)) ||
    EMBEDDED_UUID_DASHED.test(idLower) ||
    EMBEDDED_UUID_COMPACT.test(idLower) ||
    AIOSTREAMS_SHORT_TAIL.test(idLower)
  if (uuidAnchored) return plain(base)
  // Config text keeps its case (base64 configs differ by case); + in the query is a space.
  const config = JSON.stringify([
    configSegments.map(decodeWithinBoundaries),
    decodeWithinBoundaries(parsed.search.replace(/\+/g, '%20')),
  ])
  return { configless: base, instance: `${base}#${config}`, unanchoredConfig: true }
}

// Instance identity for dedupe, display and remote pairing. A uuid-anchored
// config-URL addon (AIOStreams, AIOMetadata) keeps one key across re-saves;
// without an anchor the config blob and query are identity, so two configs of
// one host (Torrentio RD + TorBox) stay two instances. In-memory only.
export function getAddonInstanceKey(addon: Pick<AddonDescriptor, 'transportUrl' | 'manifest'>): string {
  return getAddonIdentity(addon).instance
}

// Secondary merge pass: pair each local addon that found no URL match with the
// oldest still-unclaimed remote of the same instance. Remotes that URL-match any
// local are left to the primary pass.
export function claimInstanceRemotes<T extends Pick<AddonDescriptor, 'transportUrl' | 'manifest' | 'metadata'>>(
  localAddons: T[],
  remoteAddons: T[],
): Map<T, T> {
  const claims = new Map<T, T>()
  const localNorms = new Set(localAddons.map((a) => normalizeAddonUrl(a.transportUrl)))
  const remoteNorms = new Set(remoteAddons.map((a) => normalizeAddonUrl(a.transportUrl)))

  const pendingByKey = new Map<string, T[]>()
  for (const remote of remoteAddons) {
    if (localNorms.has(normalizeAddonUrl(remote.transportUrl))) continue
    const key = getAddonInstanceKey(remote)
    if (!key) continue
    const bucket = pendingByKey.get(key)
    if (bucket) bucket.push(remote)
    else pendingByKey.set(key, [remote])
  }
  if (pendingByKey.size === 0) return claims

  // Ambiguity rule: oldest local claims the incoming remote; the rest are preserved untouched.
  const claimantsByKey = new Map<string, T[]>()
  for (const local of localAddons) {
    if (remoteNorms.has(normalizeAddonUrl(local.transportUrl))) continue
    const key = getAddonInstanceKey(local)
    if (!key) continue
    const bucket = pendingByKey.get(key)
    if (!bucket || bucket.length === 0) continue
    const claimants = claimantsByKey.get(key)
    if (claimants) claimants.push(local)
    else claimantsByKey.set(key, [local])
  }

  for (const [key, claimants] of claimantsByKey) {
    const bucket = pendingByKey.get(key) || []
    const sorted = [...claimants].sort((a, b) => lastUpdatedOf(a) - lastUpdatedOf(b))
    const paired = Math.min(sorted.length, bucket.length)
    for (let i = 0; i < paired; i++) claims.set(sorted[i], bucket[i])
  }
  return claims
}

function lastUpdatedOf(addon: Pick<AddonDescriptor, 'metadata'>): number {
  return Number(addon.metadata?.lastUpdated) || 0
}

const schemeless = (key: string) => key.replace(/^https?:\/\//i, '')

// Pending-push detection must agree with the merge: a local addon is present on the remote
// when it URL-matches, is instance-claimed (the merge's own pairing), differs only by scheme,
// or is an official/protected addon sharing a known manifest id. Spare remotes pair once each.
export function createRemoteIdentityMatcher<T extends Pick<AddonDescriptor, 'transportUrl' | 'manifest' | 'metadata' | 'flags'>>(
  localAddons: T[],
  remoteAddons: T[],
): (local: T) => T | undefined {
  const byUrl = new Map<string, T>()
  for (const remote of remoteAddons) {
    const norm = normalizeAddonUrl(remote.transportUrl)
    if (!byUrl.has(norm)) byUrl.set(norm, remote)
  }
  const claims = claimInstanceRemotes(localAddons, remoteAddons)
  const claimed = new Set(claims.values())
  const localNorms = new Set(localAddons.map((a) => normalizeAddonUrl(a.transportUrl)))
  const spare = remoteAddons.filter((r) => !claimed.has(r) && !localNorms.has(normalizeAddonUrl(r.transportUrl)))

  return (local) => {
    const exact = byUrl.get(normalizeAddonUrl(local.transportUrl))
    if (exact) return exact
    const claim = claims.get(local)
    if (claim) return claim
    const localKey = schemeless(getAddonInstanceKey(local))
    const localId = local.manifest?.id
    const idx = spare.findIndex((remote) => {
      if (schemeless(getAddonInstanceKey(remote)) === localKey) return true
      const fixed = local.flags?.official || local.flags?.protected || remote.flags?.official || remote.flags?.protected
      return Boolean(fixed && localId && localId !== 'unknown' && remote.manifest?.id === localId)
    })
    return idx === -1 ? undefined : spare.splice(idx, 1)[0]
  }
}
