import { AddonDescriptor } from '@/types/addon'
import { stremioClient } from './stremio-client'
import { checkAddonHealth } from '@/lib/addon-health'

export async function getAddons(authKey: string): Promise<AddonDescriptor[]> {
  return stremioClient.getAddonCollection(authKey)
}

export async function updateAddons(authKey: string, addons: AddonDescriptor[]): Promise<void> {
  // CRITICAL: Filter out disabled addons and apply manifest customizations (Raven fix)
  // This ensures that custom names, logos, and descriptions are pushed to Stremio.
  const preparedAddons = (addons || [])
    .filter((addon) => addon.flags?.enabled !== false)
    .map((addon) => {
      if (addon.metadata?.customName || addon.metadata?.customDescription || addon.metadata?.customLogo) {
        return {
          ...addon,
          manifest: {
            ...addon.manifest,
            name: addon.metadata.customName || addon.manifest?.name || '',
            logo: addon.metadata.customLogo || addon.manifest?.logo || undefined,
            description: addon.metadata.customDescription || addon.manifest?.description || '',
          },
        }
      }
      return addon
    })

  return stremioClient.setAddonCollection(authKey, preparedAddons)
}

export async function installAddon(authKey: string, addonUrl: string): Promise<AddonDescriptor[]> {
  // First, fetch the addon manifest
  const newAddon = await stremioClient.fetchAddonManifest(addonUrl)

  // Get current addons
  const currentAddons = await getAddons(authKey)

  // Check if addon already installed (by transportUrl to support duplicates with same ID)
  const existingIndex = currentAddons.findIndex(
    (addon) => addon.transportUrl === newAddon.transportUrl
  )

  let updatedAddons: AddonDescriptor[]

  if (existingIndex >= 0) {
    // Update existing addon in place
    updatedAddons = [...currentAddons]
    updatedAddons[existingIndex] = newAddon
  } else {
    // Add new addon (Additive)
    updatedAddons = [...currentAddons, newAddon]
  }

  // Update the collection
  await updateAddons(authKey, updatedAddons)

  return updatedAddons
}

export async function removeAddon(authKey: string, transportUrl: string): Promise<AddonDescriptor[]> {
  // Get current addons
  const currentAddons = await getAddons(authKey)

  // Check if addon is protected
  const addonToRemove = currentAddons.find((addon) => addon.transportUrl === transportUrl)
  if (addonToRemove?.flags?.protected) {
    throw new Error(`Addon "${addonToRemove.manifest.name}" is protected and cannot be removed.`)
  }

  // Remove the addon
  const updatedAddons = currentAddons.filter((addon) => addon.transportUrl !== transportUrl)

  // Update the collection
  await updateAddons(authKey, updatedAddons)

  return updatedAddons
}

export async function fetchAddonManifest(url: string): Promise<AddonDescriptor> {
  return stremioClient.fetchAddonManifest(url)
}

/**
 * Reinstall an addon by removing and re-installing it with Stremio.
 * This triggers Stremio to fetch the latest manifest from the addon URL.
 */
export async function reinstallAddon(
  authKey: string,
  transportUrl: string
): Promise<{
  addons: AddonDescriptor[]
  updatedAddon: AddonDescriptor | null
  previousVersion?: string
  newVersion?: string
}> {
  // 1. Get current addons
  const currentAddons = await getAddons(authKey)
  const addonIndex = currentAddons.findIndex((addon) => addon.transportUrl === transportUrl)
  const existingAddon = currentAddons[addonIndex]

  if (!existingAddon) {
    return { addons: currentAddons, updatedAddon: null }
  }

  // We allow reinstalling protected addons (updates are permitted, deletion is not)

  const previousVersion = existingAddon.manifest.version
  const addonUrl = existingAddon.transportUrl

  // 2. Fetch new manifest (Failsafe)
  // We fetch this BEFORE modifying the list. If it fails, we abort, leaving the list untouched.
  let newAddonDescriptor: AddonDescriptor
  try {
    newAddonDescriptor = await stremioClient.fetchAddonManifest(addonUrl)
  } catch (error) {
    console.error(`[Reinstall Failsafe] Failed to reach addon at ${transportUrl}`, error)
    throw new Error(`Cannot reach addon: ${error instanceof Error ? error.message : 'Unknown error'}. Aborting reinstall to save existing addon.`)
  }

  // 3. Update the addon in place
  // This preserves the exact position in the list
  const updatedAddons = [...currentAddons]
  const oldAddon = currentAddons[addonIndex]

  // Preserve metadata and flags from the existing addon
  updatedAddons[addonIndex] = {
    ...newAddonDescriptor,
    flags: { ...oldAddon.flags, ...newAddonDescriptor.flags },
    metadata: { ...oldAddon.metadata },
  }

  // 4. Save the updated collection (Atomic operation)
  await updateAddons(authKey, updatedAddons)

  return {
    addons: updatedAddons,
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
  isOnline: boolean
}

/**
 * Check which addons have updates available by comparing installed versions
 * with the latest versions from their transport URLs.
 * Fetches manifests sequentially to avoid overwhelming the server/proxy.
 */
export async function checkAddonUpdates(addons: AddonDescriptor[]): Promise<AddonUpdateInfo[]> {
  // Filter out official addons only (protected addons can still be updated)
  const checkableAddons = addons.filter(
    (addon) => !addon.flags?.official
  )

  console.log(`[Update Check] Checking ${checkableAddons.length} addons sequentially...`)

  const results: AddonUpdateInfo[] = []

  for (const addon of checkableAddons) {
    try {
      // Check both addon health and version in parallel
      const [latestManifest, isOnline] = await Promise.all([
        stremioClient.fetchAddonManifest(addon.transportUrl),
        checkAddonHealth(addon.transportUrl),
      ])

      const hasUpdate = latestManifest.manifest.version !== addon.manifest.version

      console.log(
        `[Update Check] ${addon.manifest.name}: installed=${addon.manifest.version}, latest=${latestManifest.manifest.version}, hasUpdate=${hasUpdate}, isOnline=${isOnline}`
      )

      results.push({
        addonId: addon.manifest.id,
        name: addon.manifest.name,
        transportUrl: addon.transportUrl,
        installedVersion: addon.manifest.version,
        latestVersion: latestManifest.manifest.version,
        hasUpdate,
        isOnline,
      })
    } catch (error) {
      console.warn(`[Update Check] Failed to check ${addon.manifest.name}:`, error)
      console.warn(`  URL was: ${addon.transportUrl}`)
    }
  }

  console.log(`[Update Check] Complete: ${results.length} checked`)

  return results
}

/**
 * Check which saved addons have updates available.
 * Fetches manifests sequentially to avoid overwhelming the server/proxy.
 */
export async function checkSavedAddonUpdates(
  savedAddons: {
    id: string
    name: string
    installUrl: string
    manifest: { id: string; name: string; version: string }
  }[]
): Promise<AddonUpdateInfo[]> {
  console.log(`[Update Check] Checking ${savedAddons.length} saved addons sequentially...`)

  const results: AddonUpdateInfo[] = []

  for (const addon of savedAddons) {
    try {
      // Check both addon health and version in parallel
      const [latestManifest, isOnline] = await Promise.all([
        stremioClient.fetchAddonManifest(addon.installUrl),
        checkAddonHealth(addon.installUrl),
      ])

      const hasUpdate = latestManifest.manifest.version !== addon.manifest.version

      console.log(
        `[Update Check] ${addon.name}: installed=${addon.manifest.version}, latest=${latestManifest.manifest.version}, hasUpdate=${hasUpdate}, isOnline=${isOnline}`
      )

      results.push({
        addonId: addon.id,
        name: addon.name,
        transportUrl: addon.installUrl,
        installedVersion: addon.manifest.version,
        latestVersion: latestManifest.manifest.version,
        hasUpdate,
        isOnline,
      })
    } catch (error) {
      console.warn(`[Update Check] Failed to check ${addon.name}:`, error)
      console.warn(`  URL was: ${addon.installUrl}`)
    }
  }

  console.log(`[Update Check] Complete: ${results.length} checked`)

  return results
}
