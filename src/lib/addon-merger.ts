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
  savedAddons: SavedAddon[]
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

    // 1. Check for literal same-URL duplicate to allow "updates"
    const existingIndex = updatedAddons.findIndex((a) => a.transportUrl === installUrl)

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
        const manifest = await fetchAddonManifest(installUrl)
        updatedAddons[existingIndex] = manifest
        result.updated.push({
          addonId,
          oldUrl: installUrl,
          newUrl: manifest.transportUrl,
        })
      } catch (error) {
        // Use cached manifest as fallback if fetch fails during update
        console.warn(`[Merger] Update fetch failed for ${savedAddon.name}, keeping current/cached`, error)
        result.skipped.push({
          addonId,
          reason: 'fetch-failed',
        })
      }
    } else {
      // 2. New instance (Additive)
      try {
        const manifest = await fetchAddonManifest(installUrl)
        updatedAddons.push(manifest)

        result.added.push({
          addonId,
          name: manifest.manifest.name,
          installUrl: manifest.transportUrl,
        })
      } catch (error) {
        // Fallback to cached manifest
        console.warn(`[Merger] Fresh fetch failed for ${savedAddon.name}, using cached`, error)

        updatedAddons.push({
          transportUrl: installUrl,
          manifest: savedAddon.manifest,
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
  addonIds: string[]
): {
  addons: AddonDescriptor[]
  removed: string[]
  protectedAddons: string[]
} {
  const removed: string[] = []
  const protectedAddons: string[] = []

  const updatedAddons = currentAddons.filter((addon) => {
    const shouldRemove = addonIds.includes(addon.manifest.id)

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
  savedAddons: SavedAddon[]
): Promise<MergeResult> {
  const { result } = await mergeAddons(currentAddons, savedAddons)
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
