import { AddonDescriptor } from '@/types/addon'
import { stremioClient } from './stremio-client'
import { checkAddonHealth, HealthStatus } from '@/lib/addon-health'
import { isNewerVersion, normalizeAddonUrl } from '@/lib/utils'

export async function getAddons(authKey: string, accountContext: string = 'Unknown'): Promise<AddonDescriptor[]> {
  return stremioClient.getAddonCollection(authKey, accountContext)
}

export async function updateAddons(authKey: string, addons: AddonDescriptor[], accountContext: string = 'Unknown'): Promise<void> {
  // CRITICAL: Apply manifest customizations (Raven fix)
  // This ensures that custom names, logos, and descriptions are pushed to Stremio.
  // We FILTER OUT disabled addons here so they are "hidden" in Stremio.
  const preparedAddons = (addons || [])
    .filter(addon => addon.flags?.enabled !== false)
    .map((addon) => {
      // CRITICAL: Always ensure types and resources are present
      const baseManifest = {
        ...addon.manifest,
        types: addon.manifest?.types || [],
        resources: addon.manifest?.resources || []
      }

      if (addon.metadata?.customName || addon.metadata?.customDescription || addon.metadata?.customLogo) {
        return {
          ...addon,
          manifest: {
            ...baseManifest,
            name: addon.metadata.customName || baseManifest.name || '',
            logo: addon.metadata.customLogo || baseManifest.logo || undefined,
            description: addon.metadata.customDescription || baseManifest.description || '',
          },
        }
      }
      return { ...addon, manifest: baseManifest }
    })

  return stremioClient.setAddonCollection(authKey, preparedAddons, accountContext)
}


export async function installAddon(authKey: string, addonUrl: string, accountContext: string = 'Unknown'): Promise<AddonDescriptor[]> {
  // First, fetch the addon manifest
  const newAddon = await stremioClient.fetchAddonManifest(addonUrl, accountContext)

  // Get current addons
  const currentAddons = await getAddons(authKey, accountContext)

  // Check if addon already installed (by transportUrl to support duplicates with same ID)
  const existingIndex = currentAddons.findIndex(
    (addon) => addon.transportUrl === newAddon.transportUrl
  )

  let updatedAddons: AddonDescriptor[]

  if (existingIndex >= 0) {
    // Update existing addon in place
    updatedAddons = [...currentAddons]
    const existing = currentAddons[existingIndex]
    updatedAddons[existingIndex] = {
      ...newAddon,
      // Preserve local flags and metadata
      flags: { ...existing.flags, ...newAddon.flags },
      metadata: { ...existing.metadata, ...newAddon.metadata }
    }
  } else {
    // Add new addon (Additive)
    updatedAddons = [...currentAddons, newAddon]
  }

  // Update the collection
  await updateAddons(authKey, updatedAddons, accountContext)

  return updatedAddons
}

export async function removeAddon(authKey: string, transportUrl: string, accountContext: string = 'Unknown'): Promise<AddonDescriptor[]> {
  // Get current addons
  const currentAddons = await getAddons(authKey, accountContext)

  // Check if addon is protected
  const addonToRemove = currentAddons.find((addon) => addon.transportUrl === transportUrl)
  if (addonToRemove?.flags?.protected) {
    throw new Error(`Addon "${addonToRemove.manifest.name}" is protected and cannot be removed.`)
  }

  // Remove the addon
  const updatedAddons = currentAddons.filter((addon) => addon.transportUrl !== transportUrl)

  // Update the collection
  await updateAddons(authKey, updatedAddons, accountContext)

  return updatedAddons
}

export async function fetchAddonManifest(url: string, accountContext: string = 'Unknown'): Promise<AddonDescriptor> {
  return stremioClient.fetchAddonManifest(url, accountContext)
}

/**
 * Reinstall an addon by removing and re-installing it with Stremio.
 * This triggers Stremio to fetch the latest manifest from the addon URL.
 */
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
  let newAddonDescriptor: AddonDescriptor
  try {
    newAddonDescriptor = await stremioClient.fetchAddonManifest(transportUrl, accountContext)
  } catch (error) {
    console.error(`[Reinstall Failsafe] Failed to reach addon at ${transportUrl}`, error)
    throw new Error(`Cannot reach addon: ${error instanceof Error ? error.message : 'Unknown error'}. Aborting reinstall.`)
  }

  // 2. Get current remote addons
  const currentAddons = await getAddons(authKey, accountContext)
  const addonIndex = currentAddons.findIndex((addon) => normalizeAddonUrl(addon.transportUrl).toLowerCase() === normalizeAddonUrl(transportUrl).toLowerCase())
  const existingAddon = currentAddons[addonIndex]

  const previousVersion = existingAddon?.manifest?.version
  let finalAddons = currentAddons

  // 3. Update the addon in place if it exists in remote Stremio
  if (existingAddon) {
    const updatedAddons = [...currentAddons]
    // Preserve metadata and flags from the existing remote addon
    updatedAddons[addonIndex] = {
      ...newAddonDescriptor,
      flags: { ...existingAddon.flags, ...newAddonDescriptor.flags },
      metadata: { ...existingAddon.metadata },
    }

    // 4. Save the updated collection (Atomic operation)
    await updateAddons(authKey, updatedAddons, accountContext)
    finalAddons = updatedAddons
  } else {
    console.log(`[Reinstall] Addon ${transportUrl} not found in remote collection. Updating locally only.`)
  }

  return {
    addons: finalAddons,
    updatedAddon: newAddonDescriptor,
    previousVersion,
    newVersion: newAddonDescriptor.manifest.version,
  }
}

/**
 * Update info for a single addon
 */
export interface AddonUpdateInfo {
  addonId: string
  name: string
  transportUrl: string
  installedVersion: string
  latestVersion: string
  hasUpdate: boolean
  health: { isOnline: boolean; error?: string }
}

// --- Global Cache for Bursts (e.g. Sync All) ---
const PENDING_CHECKS: Record<string, Promise<HealthStatus>> = {}
const PENDING_MANIFESTS: Record<string, Promise<AddonDescriptor>> = {}

/**
 * Check which addons have updates available by comparing installed versions
 * with the latest versions from their transport URLs.
 * Fetches manifests sequentially to avoid overwhelming the server/proxy.
 */
export async function checkAddonUpdates(addons: AddonDescriptor[], accountContext: string = 'Update-Check'): Promise<AddonUpdateInfo[]> {
  // Filter out official addons only (protected addons can still be updated)
  const checkableAddons = addons.filter((addon) => !addon.flags?.official)

  console.log(`[Update Check] Checking ${checkableAddons.length} addons in batches with robust domain caching...`)

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

        const manifestKey = addon.transportUrl // Key by full URL to avoid version collisions (Issue #1)
        if (!PENDING_MANIFESTS[manifestKey]) {
          PENDING_MANIFESTS[manifestKey] = (async () => {
            // Wait for health check before fetching manifest to save proxy bandwidth
            const healthVal = await healthPromise
            if (!healthVal.isOnline) throw new Error('Addon is offline')

            return stremioClient.fetchAddonManifest(addon.transportUrl, accountContext)
          })().catch(err => {
            delete PENDING_MANIFESTS[manifestKey]
            throw err
          })
          // Manifest cache for 5s to sync burst requests
          setTimeout(() => delete PENDING_MANIFESTS[manifestKey], 5000)
        }

        const [latestManifest, healthStatus] = await Promise.all([
          PENDING_MANIFESTS[manifestKey],
          healthPromise,
        ])

        const hasUpdate = isNewerVersion(addon.manifest.version, latestManifest.manifest.version)

        return {
          addonId: addon.manifest.id,
          name: addon.manifest.name,
          transportUrl: addon.transportUrl,
          installedVersion: addon.manifest.version,
          latestVersion: latestManifest.manifest.version,
          hasUpdate,
          health: healthStatus,
        }
      } catch (error) {
        console.warn(`[Update Check] Failed to check ${addon.manifest.name}:`, error)
        return null
      }
    })

    const batchResults = await Promise.all(batchPromises)
    results.push(...(batchResults.filter(Boolean) as AddonUpdateInfo[]))
  }

  console.log(`[Update Check] Complete: ${results.length} checked`)

  return results
}

export async function checkSavedAddonUpdates(
  savedAddons: {
    id: string
    name: string
    installUrl: string
    manifest: { id: string; name: string; version: string }
  }[],
  accountContext: string = 'Library-Update-Check'
): Promise<AddonUpdateInfo[]> {
  console.log(`[Update Check] Checking ${savedAddons.length} saved addons with Domain+ID deduplication (v3)...`)

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

        const manifestKey = addon.installUrl // Key by full URL to avoid version collisions
        if (!PENDING_MANIFESTS[manifestKey]) {
          PENDING_MANIFESTS[manifestKey] = (async () => {
            // Wait for health check before fetching manifest to save proxy bandwidth
            const healthVal = await healthPromise
            if (!healthVal.isOnline) throw new Error('Addon is offline')

            return stremioClient.fetchAddonManifest(addon.installUrl, accountContext)
          })().catch(async (err) => {
            delete PENDING_MANIFESTS[manifestKey]
            throw err
          })
          setTimeout(() => delete PENDING_MANIFESTS[manifestKey], 5000)
        }

        const [latestManifest, healthStatus] = await Promise.all([
          PENDING_MANIFESTS[manifestKey],
          healthPromise,
        ])

        const hasUpdate = isNewerVersion(addon.manifest.version, latestManifest.manifest.version)

        return {
          addonId: addon.id,
          name: addon.name,
          transportUrl: addon.installUrl,
          installedVersion: addon.manifest.version,
          latestVersion: latestManifest.manifest.version,
          hasUpdate,
          health: healthStatus,
        }
      } catch (error) {
        console.warn(`[Update Check] Failed to check ${addon.name}:`, error)
        return null
      }
    })

    const batchResults = await Promise.all(batchPromises)
    results.push(...(batchResults.filter(Boolean) as AddonUpdateInfo[]))
  }

  console.log(`[Update Check] Complete: ${results.length} checked`)
  return results
}
