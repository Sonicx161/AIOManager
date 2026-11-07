import { AddonDescriptor, AddonManifest } from '@/types/addon'
import { stremioClient, isRecoveredAddonCollection } from './stremio-client'
import { checkAddonHealth, HealthStatus, isLocalOrPrivateUrl } from '@/lib/addon-health'
import { getAddonVersionKey, isNewerVersion, normalizeAddonUrl } from '@/lib/utils'
import { getEffectiveManifest } from '@/lib/addon-utils'
import { getPendingFetch, setPendingFetch } from '@/lib/manifest-cache'
import { getHostnameIdentifier, identifyAddon } from '@/lib/addon-identifier'
import { dedupeAddonsByUrl, getAddonUrlKey } from '@/lib/addon-dedupe'
import { compareManifestShape } from '@/lib/addon-manifest-diff'
import { restoreKnownManifests } from '@/lib/manifest-placeholder'
import { shouldBlockShrink } from '@/lib/shrink-guard'
import { ACCOUNT_CONTEXT_UPDATE_CHECK, ACCOUNT_CONTEXT_LIBRARY_UPDATE } from '@/lib/account-contexts'
import { trace, briefAddons } from '@/lib/trace'
import type { SavedAddonManifestChangeSummary } from '@/types/saved-addon'

const KNOWN_DEAD_DOMAINS = ['opensubtitles.strem.io']
const MAX_ADDON_COLLECTION_SIZE = 250

function isKnownDeadDomain(url: string): boolean {
  try {
    return KNOWN_DEAD_DOMAINS.includes(new URL(url).hostname)
  } catch {
    return false
  }
}

const knownAddonCounts = new Map<string, number>()

const addonCollectionCache = new Map<string, { data: AddonDescriptor[], ts: number }>()
const addonCollectionPending = new Map<string, { version: number; promise: Promise<AddonDescriptor[]> }>()
const addonCollectionVersions = new Map<string, number>()
const COLLECTION_CACHE_TTL = 60000

interface UpdateAddonOptions {
  bypassEmptyGuard?: boolean
  allowCollectionShrink?: boolean
  previousCollection?: AddonDescriptor[]
  /**
   * Normalized transport URLs that destination policy deliberately removes from
   * THIS write target. A blocked shrink (or empty) is allowed to proceed only when
   * every removed URL is in this set — a policy-authorized clear, never a blanket
   * shrink bypass (R2). Fail closed: without a previousCollection to diff against,
   * removals cannot be verified and the anti-wipe guard stands.
   */
  authorizedRemovals?: Set<string>
}

export async function getAddons(authKey: string, accountContext: string = 'Unknown', force: boolean = false): Promise<AddonDescriptor[]> {
  if (force) {
    addonCollectionCache.delete(authKey)
  }
  const cached = addonCollectionCache.get(authKey)
  if (cached && Date.now() - cached.ts < COLLECTION_CACHE_TTL) {
    trace('getAddons', 'cache-hit', { accountId: accountContext, ageMs: Date.now() - cached.ts, count: cached.data.length, addons: briefAddons(cached.data) })
    return cached.data
  }
  const version = addonCollectionVersions.get(authKey) || 0
  const pending = addonCollectionPending.get(authKey)
  if (pending && pending.version === version) {
    return pending.promise
  }

  const promise = (async () => {
    let addons = await stremioClient.getAddonCollection(authKey, accountContext)
    const knownCount = knownAddonCounts.get(authKey) || 0
    if (knownCount > 0 && addons.length < Math.ceil(knownCount * 0.25)) {
      // Suspicious shrink: re-read once for a transient, then accept; prefer cache only on persistent empty.
      trace('read', 'suspicious-shrink', { accountId: accountContext, known: knownCount, got: addons.length })
      if (import.meta.env.DEV) console.warn(`[AddonCollection] Suspicious collection shrink (${knownCount} → ${addons.length}); re-reading to confirm.`)
      const retry = await stremioClient.getAddonCollection(authKey, accountContext).catch(() => addons)
      if (retry.length > addons.length) addons = retry
      trace('read', 'shrink-retry', { accountId: accountContext, before: addons.length, afterRetry: retry.length })
      if (addons.length === 0 && cached?.data?.length) {
        return cached.data
      }
    }
    // A recovered lastGood collection is a stale snapshot, not a live read: never cache it or learn its count.
    const recovered = isRecoveredAddonCollection(addons)
    if ((addonCollectionVersions.get(authKey) || 0) === version) {
      if (addons.length > 0 && !recovered) {
        knownAddonCounts.set(authKey, addons.length)
      }
      if (!recovered) addonCollectionCache.set(authKey, { data: addons, ts: Date.now() })
    }
    trace('getAddons', 'fetched', { accountId: accountContext, knownCount, count: addons.length, recovered, addons: briefAddons(addons) })
    return addons
  })()

  addonCollectionPending.set(authKey, { version, promise })
  try {
    return await promise
  } finally {
    const current = addonCollectionPending.get(authKey)
    if (current?.promise === promise) {
      addonCollectionPending.delete(authKey)
    }
  }
}

function invalidateAddonCache(authKey: string) {
  addonCollectionVersions.set(authKey, (addonCollectionVersions.get(authKey) || 0) + 1)
  addonCollectionCache.delete(authKey)
  addonCollectionPending.delete(authKey)
}

function prepareAddonForStremio(addon: AddonDescriptor): AddonDescriptor {
  const effectiveManifest = getEffectiveManifest(restoreKnownManifests([addon])[0])
  const identifiedManifest = identifyAddon(addon.transportUrl, effectiveManifest)
  const fallbackName = getHostnameIdentifier(addon.transportUrl)
  const manifest: AddonManifest = {
    ...identifiedManifest,
    id: identifiedManifest.id || 'unknown',
    name: identifiedManifest.name || fallbackName || 'Unknown Addon',
    version: identifiedManifest.version || '0.0.0',
    description: identifiedManifest.description || '',
    types: identifiedManifest.types || [],
    resources: identifiedManifest.resources || [],
  }

  if (effectiveManifest.behaviorHints) {
    manifest.behaviorHints = effectiveManifest.behaviorHints
  }

  if (addon.metadata?.hideConfigure) {
    manifest.behaviorHints = { ...manifest.behaviorHints, configurable: false }
  }

  if (effectiveManifest.catalogs) {
    manifest.catalogs = effectiveManifest.catalogs.map(catalog => ({
      ...catalog,
      extra: catalog.extra?.map(extra => ({ ...extra })),
    }))
  }

  const prepared: AddonDescriptor = {
    transportUrl: addon.transportUrl,
    manifest
  }

  if (addon.flags) {
    prepared.flags = addon.flags
  }

  return prepared
}

function prepareAddonCollectionForStremio(addons: AddonDescriptor[]): AddonDescriptor[] {
  return dedupeAddonsByUrl(
    (addons || [])
      .filter(addon => addon.flags?.enabled !== false)
      .map(prepareAddonForStremio)
  )
}

function validatePreparedAddon(addon: AddonDescriptor): string | null {
  if (!addon || typeof addon !== 'object') return 'Addon entry is not an object'
  if (!addon.transportUrl) return 'Addon is missing transport URL'
  try {
    const parsed = new URL(normalizeAddonUrl(addon.transportUrl))
    if (!['http:', 'https:'].includes(parsed.protocol)) return 'Addon URL must use HTTP or HTTPS'
  } catch {
    return 'Addon has an invalid transport URL'
  }

  if (!addon.manifest?.id || !addon.manifest?.name || !addon.manifest?.version) {
    return 'Addon manifest is missing required fields'
  }

  return null
}

export async function updateAddons(authKey: string, addons: AddonDescriptor[], accountContext: string = 'Unknown', options?: UpdateAddonOptions): Promise<void> {
  const preparedAddons = prepareAddonCollectionForStremio(addons || [])
  const invalidAddons = preparedAddons
    .map((addon, index) => ({ addon, index, reason: validatePreparedAddon(addon) }))
    .filter((result): result is { addon: AddonDescriptor; index: number; reason: string } => Boolean(result.reason))

  if (invalidAddons.length > 0) {
    const firstInvalid = invalidAddons[0]
    trace('push', 'invalid-blocked', { accountId: accountContext, count: invalidAddons?.length || 0 })
    throw new Error(`Safety guard: refusing to push invalid addon collection. Entry ${firstInvalid.index + 1}: ${firstInvalid.reason}`)
  }

  if (preparedAddons.length > MAX_ADDON_COLLECTION_SIZE) {
    trace('push', 'size-blocked', { accountId: accountContext, prepared: preparedAddons.length, limit: MAX_ADDON_COLLECTION_SIZE })
    throw new Error(`Safety guard: refusing to push ${preparedAddons.length} addons. Limit is ${MAX_ADDON_COLLECTION_SIZE}.`)
  }

  const allowCollectionShrink = options?.allowCollectionShrink || options?.bypassEmptyGuard
  const cachedBeforeUpdate = addonCollectionCache.get(authKey)
  const optionPreviousCollection = options?.previousCollection
    ? prepareAddonCollectionForStremio(options.previousCollection)
    : undefined
  let previousCollection = cachedBeforeUpdate && Date.now() - cachedBeforeUpdate.ts < COLLECTION_CACHE_TTL
    ? cachedBeforeUpdate.data
    : optionPreviousCollection && optionPreviousCollection.length > 0
      ? optionPreviousCollection
      : undefined
  // A cold secondary login has no collection cache. Read that login before
  // authorizing a policy removal; a sibling's collection is not evidence.
  if (!previousCollection && options?.authorizedRemovals?.size && !allowCollectionShrink) {
    previousCollection = await getAddons(authKey, accountContext)
  }
  const knownCount = Math.max(knownAddonCounts.get(authKey) || 0, previousCollection?.length || 0)
  const shrinkDecision = shouldBlockShrink(preparedAddons.length, knownCount, !!allowCollectionShrink)
  trace('updateAddons', 'shrink-decision', { accountId: accountContext, inputCount: (addons || []).length, preparedCount: preparedAddons.length, knownCount, allowCollectionShrink: !!allowCollectionShrink, blocked: shrinkDecision.blocked, reason: shrinkDecision.reason, addons: briefAddons(preparedAddons) })

  // Policy-authorized shrink (R2): a blocked empty/shrink may proceed ONLY when every
  // removed URL is a deliberate destination exclusion for THIS target. The caller
  // computes the set from the unfiltered source list (excludedUrlsFor); matching here
  // is on normalized URLs against the previous collection (cache or caller-supplied).
  let policyAuthorizedShrink = false
  if (options?.authorizedRemovals?.size && previousCollection && previousCollection.length > 0) {
    const preparedUrls = new Set(preparedAddons.map(a => normalizeAddonUrl(a.transportUrl)))
    const removedUrls = [...new Set(previousCollection.map(a => normalizeAddonUrl(a.transportUrl)).filter(Boolean))].filter(u => !preparedUrls.has(u))
    policyAuthorizedShrink = removedUrls.length > 0 && removedUrls.every(u => options?.authorizedRemovals?.has(u))
    trace('updateAddons', 'policy-shrink-check', { accountId: accountContext, removed: removedUrls.length, authorized: policyAuthorizedShrink, authorizedCount: options?.authorizedRemovals?.size ?? 0 })
  }
  const writeAuthorized = !shrinkDecision.blocked || policyAuthorizedShrink
  if (!writeAuthorized && shrinkDecision.reason === 'empty') {
    throw new Error(`Anti-wipe guard: refusing to push empty addon collection (${knownCount} addon${knownCount !== 1 ? 's' : ''} previously seen)`)
  }
  if (!writeAuthorized && shrinkDecision.reason === 'shrink') {
    throw new Error(`Anti-wipe guard: refusing to shrink addon collection from ${knownCount} to ${preparedAddons.length}.`)
  }

  invalidateAddonCache(authKey)
  await stremioClient.setAddonCollection(authKey, preparedAddons, accountContext, { allowCollectionShrink: allowCollectionShrink || policyAuthorizedShrink, previousCollection })
  trace('push', 'sent', { accountId: accountContext, prepared: preparedAddons.length, allowCollectionShrink: !!allowCollectionShrink, policyAuthorizedShrink })

  if (preparedAddons.length > 0 || allowCollectionShrink || policyAuthorizedShrink) {
    knownAddonCounts.set(authKey, preparedAddons.length)
    addonCollectionCache.set(authKey, { data: preparedAddons, ts: Date.now() })
  }
}


export async function installAddon(authKey: string, addonUrl: string, accountContext: string = 'Unknown'): Promise<AddonDescriptor[]> {
  const [newAddon, currentAddons] = await Promise.all([
    fetchAddonManifest(addonUrl, accountContext),
    getAddons(authKey, accountContext),
  ])

  // Check if addon already installed (by transportUrl to support duplicates with same ID)
  const newAddonUrlKey = getAddonUrlKey(newAddon.transportUrl)
  const existingIndex = currentAddons.findIndex(
    (addon) => getAddonUrlKey(addon.transportUrl) === newAddonUrlKey
  )

  let updatedAddons: AddonDescriptor[]

  if (existingIndex >= 0) {
    updatedAddons = [...currentAddons]
    const existing = currentAddons[existingIndex]
    updatedAddons[existingIndex] = {
      ...newAddon,
      flags: { ...existing.flags, ...newAddon.flags },
      metadata: { ...existing.metadata, ...newAddon.metadata },
      catalogOverrides: existing.catalogOverrides,
    }
  } else {
    updatedAddons = [...currentAddons, newAddon]
  }

  await updateAddons(authKey, updatedAddons, accountContext)

  return updatedAddons
}

export async function removeAddon(authKey: string, transportUrl: string, accountContext: string = 'Unknown'): Promise<AddonDescriptor[]> {
  const currentAddons = await getAddons(authKey, accountContext)

  const addonToRemove = currentAddons.find((addon) => addon.transportUrl === transportUrl)
  if (addonToRemove?.flags?.protected) {
    throw new Error(`Addon "${addonToRemove.manifest.name}" is protected and cannot be removed.`)
  }

  const updatedAddons = currentAddons.filter((addon) => addon.transportUrl !== transportUrl)

  await updateAddons(authKey, updatedAddons, accountContext)

  return updatedAddons
}

export async function fetchAddonManifest(url: string, accountContext: string = 'Unknown', force: boolean = false): Promise<AddonDescriptor> {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch (error) {
    throw new Error(`Invalid addon URL: ${url}`);
  }

  await acquireDomainSlot(origin)
  try {
    return await stremioClient.fetchAddonManifest(url, accountContext, force)
  } finally {
    releaseDomainSlot(origin)
  }
}

export async function reinstallAddon(
  authKey: string,
  transportUrl: string,
  accountContext: string = 'Unknown'
): Promise<{
  addons: AddonDescriptor[]
  updatedAddon: AddonDescriptor | null
  previousVersion?: string
  newVersion?: string
}> {
  // 1. Fetch new manifest (Failsafe)
  // We fetch this FIRST. This ensures we can update the LOCAL store even if the addon 
  // isn't currently in Stremio (e.g. it's disabled).
  const manifestPromise = fetchAddonManifest(transportUrl, accountContext, true).catch((error) => {
    if (import.meta.env.DEV) console.error(`[Reinstall Failsafe] Failed to reach addon at ${transportUrl}`, error)
    throw new Error(`Cannot reach addon: ${error instanceof Error ? error.message : 'Unknown error'}. Aborting reinstall.`)
  })
  const collectionPromise = authKey
    ? getAddons(authKey, accountContext, true).catch(() => [] as AddonDescriptor[])
    : Promise.resolve([] as AddonDescriptor[])
  const [newAddonDescriptor, currentAddons] = await Promise.all([manifestPromise, collectionPromise])
  const addonIndex = currentAddons.findIndex((addon) => normalizeAddonUrl(addon.transportUrl) === normalizeAddonUrl(transportUrl))
  const existingAddon = currentAddons[addonIndex]

  const previousVersion = existingAddon?.manifest?.version
  let finalAddons = currentAddons

  if (existingAddon) {
    const updatedAddons = [...currentAddons]
    updatedAddons[addonIndex] = {
      ...newAddonDescriptor,
      flags: { ...existingAddon.flags, ...newAddonDescriptor.flags },
      metadata: { ...existingAddon.metadata },
    }

    // 4. Update the addons array for the caller (but do NOT push to Stremio yet)
    // The accountStore will handle the final state persistence/push.
    finalAddons = updatedAddons
  } else {
    if (import.meta.env.DEV) console.log(`[Reinstall] Addon ${transportUrl} not found in remote collection. Updating locally only.`)
  }

  return {
    addons: finalAddons,
    updatedAddon: newAddonDescriptor,
    previousVersion,
    newVersion: newAddonDescriptor.manifest.version,
  }
}

export interface AddonUpdateInfo {
  addonId: string
  versionKey: string
  name: string
  transportUrl: string
  installedVersion: string
  latestVersion: string
  hasUpdate: boolean
  hasVersionUpdate?: boolean
  hasManifestShapeChange?: boolean
  manifestChanges?: SavedAddonManifestChangeSummary
  health: { isOnline: boolean; error?: string }
}

const PENDING_CHECKS: Record<string, Promise<HealthStatus>> = {}

// Track active manifest fetches per origin domain to avoid rate limiting
const DOMAIN_ACTIVE_FETCHES: Record<string, number> = {}
const DOMAIN_QUEUE: Record<string, (() => void)[]> = {}
const MAX_CONCURRENT_PER_DOMAIN = 1

function acquireDomainSlot(origin: string): Promise<void> {
  return new Promise((resolve) => {
    const active = DOMAIN_ACTIVE_FETCHES[origin] || 0
    if (active < MAX_CONCURRENT_PER_DOMAIN) {
      DOMAIN_ACTIVE_FETCHES[origin] = active + 1
      resolve()
    } else {
      if (!DOMAIN_QUEUE[origin]) DOMAIN_QUEUE[origin] = []
      DOMAIN_QUEUE[origin].push(() => {
        DOMAIN_ACTIVE_FETCHES[origin] = (DOMAIN_ACTIVE_FETCHES[origin] || 0) + 1
        resolve()
      })
    }
  })
}

function releaseDomainSlot(origin: string): void {
  DOMAIN_ACTIVE_FETCHES[origin] = Math.max(0, (DOMAIN_ACTIVE_FETCHES[origin] || 1) - 1)
  const next = DOMAIN_QUEUE[origin]?.shift()
  if (next) {
    // Stagger slightly to avoid burst 429s
    setTimeout(next, 100)
  }
}

export async function checkAddonUpdates(addons: AddonDescriptor[],   accountContext: string = ACCOUNT_CONTEXT_UPDATE_CHECK, onProgress?: (current: number, total: number) => void): Promise<AddonUpdateInfo[]> {
  const checkableAddons = addons.filter((addon) => !addon.flags?.official)

  if (import.meta.env.DEV) console.log(`[Update Check] Checking ${checkableAddons.length} addons in batches with robust domain caching...`)

  const results: AddonUpdateInfo[] = []
  const domainHealthCache: Record<string, boolean> = {}
  const batchSize = 10

  for (let i = 0; i < checkableAddons.length; i += batchSize) {
    const batch = checkableAddons.slice(i, i + batchSize)
    const batchPromises = batch.map(async (addon) => {
      try {
        const origin = new URL(addon.transportUrl).origin

        const healthPromise = domainHealthCache[origin] === true
          ? Promise.resolve({ isOnline: true } as HealthStatus)
          : isLocalOrPrivateUrl(addon.transportUrl)
            ? Promise.resolve({ isOnline: false, error: 'Local addon unreachable from server' } as HealthStatus)
            : (async () => {
              if (!PENDING_CHECKS[origin]) {
                PENDING_CHECKS[origin] = checkAddonHealth(addon.transportUrl).then((status) => {
                  if (status.isOnline) domainHealthCache[origin] = true
                  setTimeout(() => delete PENDING_CHECKS[origin], 5000) // Cache health for 5s
                  return status
                })
              }
              return await PENDING_CHECKS[origin]
            })()

        const manifestKey = addon.transportUrl
        if (!getPendingFetch(manifestKey)) {
          setPendingFetch(manifestKey, (async () => {
            const healthVal = await healthPromise
            if (!healthVal.isOnline) return null

            await acquireDomainSlot(origin)
            try {
              return await stremioClient.fetchAddonManifest(addon.transportUrl, accountContext)
            } catch {
              return null
            } finally {
              releaseDomainSlot(origin)
            }
          })() as Promise<AddonDescriptor>)
        }

        const [latestManifest, healthStatus] = await Promise.all([
          getPendingFetch(manifestKey)!,
          healthPromise,
        ])

        if (!latestManifest) return null

        const hasUpdate = isNewerVersion(addon.manifest.version, latestManifest.manifest.version)

        return {
          addonId: addon.manifest.id,
          versionKey: getAddonVersionKey(addon),
          name: addon.manifest.name,
          transportUrl: addon.transportUrl,
          installedVersion: addon.manifest.version,
          latestVersion: latestManifest.manifest.version,
          hasUpdate,
          health: healthStatus,
        }
      } catch (error) {
        if (!isKnownDeadDomain(addon.transportUrl)) {
          if (import.meta.env.DEV) console.warn(`[Update Check] Failed to check ${addon.manifest.name}:`, error)
        }
        return null
      }
    })

    const batchResults = await Promise.all(batchPromises)
    results.push(...(batchResults.filter(Boolean) as AddonUpdateInfo[]))
    if (onProgress) onProgress(Math.min(i + batchSize, checkableAddons.length), checkableAddons.length)
  }

  if (import.meta.env.DEV) console.log(`[Update Check] Complete: ${results.length} checked`)

  return results
}

export async function checkSavedAddonUpdates(
  savedAddons: {
    id: string
    name: string
    installUrl: string
    manifest: AddonManifest
  }[],
  accountContext: string = ACCOUNT_CONTEXT_LIBRARY_UPDATE,
  onProgress?: (current: number, total: number) => void
): Promise<AddonUpdateInfo[]> {
  if (import.meta.env.DEV) console.log(`[Update Check] Checking ${savedAddons.length} saved addons with Domain+ID deduplication (v3)...`)

  const domainHealthCache: Record<string, boolean> = {}

  // Group by Domain + Addon ID to handle UUID-based duplicates (AIOStreams style)
  const results: AddonUpdateInfo[] = []
  const batchSize = 10

  for (let i = 0; i < savedAddons.length; i += batchSize) {
    const batch = savedAddons.slice(i, i + batchSize)
    const batchPromises = batch.map(async (addon) => {
      try {
        const origin = new URL(addon.installUrl).origin

        const healthPromise = domainHealthCache[origin] === true
          ? Promise.resolve({ isOnline: true } as HealthStatus)
          : isLocalOrPrivateUrl(addon.installUrl)
            ? Promise.resolve({ isOnline: false, error: 'Local addon unreachable from server' } as HealthStatus)
            : (async () => {
              if (!PENDING_CHECKS[origin]) {
                PENDING_CHECKS[origin] = checkAddonHealth(addon.installUrl).then(status => {
                  if (status.isOnline) domainHealthCache[origin] = true
                  setTimeout(() => delete PENDING_CHECKS[origin], 5000)
                  return status
                })
              }
              return await PENDING_CHECKS[origin]
            })()

        const manifestKey = addon.installUrl
        if (!getPendingFetch(manifestKey)) {
          setPendingFetch(manifestKey, (async () => {
            const healthVal = await healthPromise
            if (!healthVal.isOnline) throw new Error('Addon is offline')

            await acquireDomainSlot(origin)
            try {
              return await stremioClient.fetchAddonManifest(addon.installUrl, accountContext)
            } finally {
              releaseDomainSlot(origin)
            }
          })().catch(async (err) => {
            throw err
          }))
        }

        const [latestManifest, healthStatus] = await Promise.all([
          getPendingFetch(manifestKey)!,
          healthPromise,
        ])

        const hasVersionUpdate = isNewerVersion(addon.manifest.version, latestManifest.manifest.version)
        const manifestChanges = compareManifestShape(addon.manifest, latestManifest.manifest)
        const hasUpdate = hasVersionUpdate || manifestChanges.hasManifestShapeChange

        return {
          addonId: addon.id,
          versionKey: getAddonVersionKey({
            transportUrl: addon.installUrl,
            manifest: addon.manifest,
          }),
          name: addon.name,
          transportUrl: addon.installUrl,
          installedVersion: addon.manifest.version,
          latestVersion: latestManifest.manifest.version,
          hasUpdate,
          hasVersionUpdate,
          hasManifestShapeChange: manifestChanges.hasManifestShapeChange,
          manifestChanges,
          health: healthStatus,
        }
      } catch (error) {
        if (!isKnownDeadDomain(addon.installUrl)) {
          if (import.meta.env.DEV) console.warn(`[Update Check] Failed to check ${addon.name}:`, error)
        }
        return null
      }
    })

    const batchResults = await Promise.all(batchPromises)
    results.push(...(batchResults.filter(Boolean) as AddonUpdateInfo[]))
    if (onProgress) onProgress(Math.min(i + batchSize, savedAddons.length), savedAddons.length)
  }

  if (import.meta.env.DEV) console.log(`[Update Check] Complete: ${results.length} checked`)
  return results
}
