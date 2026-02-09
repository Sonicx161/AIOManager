import { AddonDescriptor } from '@/types/addon'
import { SavedAddon, MergeResult } from '@/types/saved-addon'
import { fetchAddonManifest } from '@/api/addons'
import { normalizeAddonUrl } from './utils'

/**
 * Addon Merger
 *
 * Implements smart merging logic for applying saved addons to accounts.
 */

/**
 * Merge addons into an account's addon collection
 *
 * @param currentAddons - The account's current addon collection
 * @param savedAddons - Saved addons to apply
 * @returns Updated addon collection and merge result
 */
export async function mergeAddons(
  currentAddons: AddonDescriptor[],
  savedAddons: SavedAddon[],
  accountId: string = 'Unknown',
  allowProtected: boolean = false
): Promise<{ addons: AddonDescriptor[]; result: MergeResult }> {
  const result: MergeResult = {
    added: [],
    updated: [],
    skipped: [],
    protected: [],
  }

  // Start with current addons
  const updatedAddons = [...currentAddons]

  for (const savedAddon of savedAddons) {
    const addonId = savedAddon.manifest.id
    const installUrl = savedAddon.installUrl

    // 1. Smart Swap: Check for same Addon ID OR normalized same-URL 
    // This prevents duplicates if the URL protocol/trailing-slash changed
    const normInstallUrl = normalizeAddonUrl(installUrl).toLowerCase()
    const existingIndex = updatedAddons.findIndex((a) => {
      const normA = normalizeAddonUrl(a.transportUrl).toLowerCase()
      return normA === normInstallUrl
    })

    if (existingIndex >= 0) {
      const existing = updatedAddons[existingIndex]

      // Skip protected addons unless explicitly allowed
      if (existing.flags?.protected && !allowProtected) {
        result.protected.push({
          addonId,
          name: existing.manifest.name,
        })
        continue
      }

      // Update existing instance
      try {
        // ... rest of update logic ...
        const manifestToApply = savedAddon.manifest || (await fetchAddonManifest(installUrl, accountId)).manifest

        const updatedDescriptor: AddonDescriptor = {
          transportUrl: installUrl, // Ensure we use the latest installUrl
          manifest: manifestToApply,
          metadata: savedAddon.metadata
        }

        updatedAddons[existingIndex] = updatedDescriptor
        result.updated.push({
          addonId,
          oldUrl: existing.transportUrl,
          newUrl: installUrl, // We already have the installUrl
        })
      } catch (error) {
        // ... fallback logic ...
        console.warn(`[Merger] Update fetch failed for ${savedAddon.name}, keeping current/cached`, error)

        // Even if fetch fails, we still apply the metadata from the library
        updatedAddons[existingIndex] = {
          ...updatedAddons[existingIndex],
          metadata: savedAddon.metadata
        }

        result.skipped.push({
          addonId,
          reason: 'fetch-failed',
        })
      }
    } else {
      // 2. New instance (Additive)
      // ... new instance logic ...
      try {
        // Trust the saved manifest first to preserve patches
        const manifestToApply = savedAddon.manifest || (await fetchAddonManifest(installUrl, accountId)).manifest

        const newDescriptor: AddonDescriptor = {
          transportUrl: installUrl,
          manifest: manifestToApply,
          metadata: savedAddon.metadata
        }

        updatedAddons.push(newDescriptor)

        result.added.push({
          addonId,
          name: manifestToApply.name,
          installUrl: installUrl,
        })
      } catch (error) {
        // Fallback to cached manifest
        console.warn(`[Merger] Fresh fetch failed for ${savedAddon.name}, using cached`, error)

        updatedAddons.push({
          transportUrl: installUrl,
          manifest: savedAddon.manifest,
          metadata: savedAddon.metadata
        })

        result.added.push({
          addonId,
          name: savedAddon.manifest.name,
          installUrl,
        })
      }
    }
  }

  return { addons: updatedAddons, result }
}

/**
 * Remove addons from an account's collection
 *
 * @param currentAddons - The account's current addon collection
 * @param idsOrUrls - Addon IDs or transport URLs to remove
 * @param allowProtected - If true, protected addons will also be removed
 * @returns Updated addon collection and list of removed addons
 */
export function removeAddons(
  currentAddons: AddonDescriptor[],
  idsOrUrls: string[],
  allowProtected: boolean = false
): {
  addons: AddonDescriptor[]
  removed: string[]
  protectedAddons: string[]
} {
  const removed: string[] = []
  const protectedAddons: string[] = []

  const updatedAddons = currentAddons.filter((addon) => {
    // Check if the addon's ID OR its transport URL is in the removal list
    const normA = normalizeAddonUrl(addon.transportUrl).toLowerCase()
    const shouldRemove = idsOrUrls.some(target => {
      const normTarget = normalizeAddonUrl(target).toLowerCase()
      return addon.manifest.id === target || normA === normTarget
    })

    if (shouldRemove) {
      // Don't remove protected addons unless explicitly allowed
      if (addon.flags?.protected && !allowProtected) {
        protectedAddons.push(addon.manifest.id)
        return true // Keep it
      }

      removed.push(addon.manifest.id)
      return false // Remove it
    }

    return true // Keep it
  })

  return { addons: updatedAddons, removed, protectedAddons }
}

/**
 * Preview what will happen when merging saved addons
 * (same as merge but doesn't actually apply)
 */
export async function previewMerge(
  currentAddons: AddonDescriptor[],
  savedAddons: SavedAddon[],
  accountId: string = 'Unknown'
): Promise<MergeResult> {
  const { result } = await mergeAddons(currentAddons, savedAddons, accountId)
  return result
}

/**
 * Check if two addon URLs are equivalent
 * (normalize and compare)
 */
export function areUrlsEquivalent(url1: string, url2: string): boolean {
  return normalizeAddonUrl(url1).toLowerCase() === normalizeAddonUrl(url2).toLowerCase()
}
