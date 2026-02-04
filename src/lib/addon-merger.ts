import { AddonDescriptor } from '@/types/addon'
import { SavedAddon, MergeResult } from '@/types/saved-addon'
import { fetchAddonManifest } from '@/api/addons'

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
  accountId: string = 'Unknown'
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

    // 1. Smart Swap: Check for same Addon ID OR literal same-URL 
    // This prevents duplicates if the URL changed but it's the same addon
    const existingIndex = updatedAddons.findIndex((a) =>
      a.manifest.id === addonId || a.transportUrl === installUrl
    )

    if (existingIndex >= 0) {
      const existing = updatedAddons[existingIndex]

      // Skip protected addons
      if (existing.flags?.protected) {
        result.protected.push({
          addonId,
          name: existing.manifest.name,
        })
        continue
      }

      // Update existing instance
      try {
        // CRITICAL: We trust the saved manifest from the library if it exists.
        // This ensures that custom-patched manifests (like Cinemeta) are preserved
        // when installing the "saved" version.
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
        // Use cached manifest as fallback if fetch fails during update
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
 * @param addonIds - Addon IDs to remove
 * @returns Updated addon collection and list of removed addons
 */
export function removeAddons(
  currentAddons: AddonDescriptor[],
  idsOrUrls: string[]
): {
  addons: AddonDescriptor[]
  removed: string[]
  protectedAddons: string[]
} {
  const removed: string[] = []
  const protectedAddons: string[] = []

  const updatedAddons = currentAddons.filter((addon) => {
    // Check if the addon's ID OR its transport URL is in the removal list
    const shouldRemove = idsOrUrls.includes(addon.manifest.id) || idsOrUrls.includes(addon.transportUrl)

    if (shouldRemove) {
      // Don't remove protected addons
      if (addon.flags?.protected) {
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
  const normalize = (url: string) => {
    try {
      const parsed = new URL(url)
      const params = new URLSearchParams(parsed.search)
      const sortedParams = new URLSearchParams(
        Array.from(params.entries()).sort(([a], [b]) => a.localeCompare(b))
      )
      parsed.search = sortedParams.toString()
      return parsed.toString().toLowerCase().replace(/\/$/, '')
    } catch {
      return url.toLowerCase().replace(/\/$/, '')
    }
  }

  return normalize(url1) === normalize(url2)
}
