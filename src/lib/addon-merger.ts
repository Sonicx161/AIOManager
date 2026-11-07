import { AddonDescriptor } from '@/types/addon'
import { SavedAddon, MergeResult, DeployChoice, DeployDecider } from '@/types/saved-addon'
import { fetchAddonManifest } from '@/api/addons'
import { normalizeAddonUrl } from './utils'
import { getCachedManifest, setCachedManifest } from '@/lib/manifest-cache'
import { mapConcurrent } from './concurrency'
import { dedupeAddonsByUrl } from '@/lib/addon-dedupe'
import { planDeployTargets } from '@/lib/deploy-targets'
import { getAddonConfigLabel } from '@/lib/addon-config-label'
import { getEffectiveManifest } from '@/lib/addon-utils'

export async function mergeAddons(
  currentAddons: AddonDescriptor[],
  savedAddons: SavedAddon[],
  accountId: string = 'Unknown',
  allowProtected: boolean = false,
  library: SavedAddon[] = savedAddons,
  decide?: DeployDecider
): Promise<{ addons: AddonDescriptor[]; result: MergeResult }> {
  const result: MergeResult = {
    added: [],
    updated: [],
    skipped: [],
    protected: [],
    pending: [],
    outcomes: [],
    replaced: [],
    candidates: {},
  }

  const updatedAddons = [...currentAddons]

  await mapConcurrent(savedAddons, 5, async (savedAddon) => {
    const installUrl = savedAddon.installUrl
    // mergeAddons runs once per target account; without this guard a deploy to A
    // accounts re-fetches every manifest A times and exhausts the meta-proxy rate
    // limit. The 10-min TTL cache the merge loop reads from is authority enough.
    if (getCachedManifest(installUrl)) return
    try {
      const fresh = await fetchAddonManifest(installUrl, accountId)
      if (fresh?.manifest?.id && fresh?.manifest?.name && fresh?.manifest?.version) {
        setCachedManifest(installUrl, fresh.manifest)
      }
    } catch {}
  })

  const targets = planDeployTargets(currentAddons, savedAddons, library)

  savedAddons.forEach((savedAddon, savedIndex) => {
    const addonId = savedAddon.manifest.id
    const installUrl = savedAddon.installUrl

    // This handles the backward compatibility case where customName wasn't set in metadata
    // We check against savedAddon.manifest.name because that's the baseline the user renamed FROM
    const effectiveMetadata = { ...savedAddon.metadata }
    if (!effectiveMetadata.customName && savedAddon.name && savedAddon.name !== savedAddon.manifest.name) {
      effectiveMetadata.customName = savedAddon.name
    }

    const target = targets[savedIndex]
    const name = savedAddon.name || savedAddon.manifest.name
    let choice: DeployChoice | undefined
    if (target.kind === 'ask') {
      const candidate = { key: normalizeAddonUrl(updatedAddons[target.index].transportUrl), index: target.index }
      choice = decide?.(savedAddon.id, candidate)
      if (!choice) {
        result.candidates![savedAddon.id] = candidate
        result.pending!.push({
          savedAddonId: savedAddon.id,
          addonId,
          name,
          existingLabel: getAddonConfigLabel(updatedAddons[target.index].transportUrl),
          libraryLabel: getAddonConfigLabel(installUrl),
        })
        return
      }
    }
    const existingIndex = target.kind === 'append' || choice === 'keep' ? -1 : target.index

    if (existingIndex >= 0) {
      const existing = updatedAddons[existingIndex]

      if (existing.flags?.protected && !allowProtected) {
        result.protected.push({
          addonId,
          name: existing.manifest.name,
        })
        return
      }

      const cached = getCachedManifest(installUrl)
      const manifestToApply = (cached?.id && cached?.name && cached?.version)
        ? cached
        : savedAddon.manifest

      const updatedDescriptor: AddonDescriptor = {
        transportUrl: installUrl,
        manifest: manifestToApply,
        flags: existing.flags,
        metadata: { ...existing.metadata, ...effectiveMetadata },
        catalogOverrides: savedAddon.catalogOverrides || existing.catalogOverrides,
        note: existing.note,
        // The entry's per-connection policy survives every in-place write (R1).
        destinations: existing.destinations,
      }

      updatedAddons[existingIndex] = updatedDescriptor
      if (choice === 'replace') result.replaced!.push({ oldUrl: existing.transportUrl, newUrl: installUrl })
      result.outcomes!.push(choice === 'replace'
        ? { savedAddonId: savedAddon.id, name, outcome: 'replaced', replacedLabel: getAddonConfigLabel(existing.transportUrl) }
        : { savedAddonId: savedAddon.id, name, outcome: 'updated' })
      result.updated.push({
        addonId,
        oldUrl: existing.transportUrl,
        newUrl: installUrl,
      })
    } else {
      const cached = getCachedManifest(installUrl)
      const manifestToApply = (cached?.id && cached?.name && cached?.version)
        ? cached
        : savedAddon.manifest

      const newDescriptor: AddonDescriptor = {
        transportUrl: installUrl,
        manifest: manifestToApply,
        metadata: effectiveMetadata,
        catalogOverrides: savedAddon.catalogOverrides,
      }

      updatedAddons.push(newDescriptor)
      result.outcomes!.push({ savedAddonId: savedAddon.id, name, outcome: choice === 'keep' ? 'kept-both' : 'added' })

      result.added.push({
        addonId,
        name: manifestToApply.name,
        installUrl: installUrl,
      })
    }
  })

  // The planner already placed every same-instance write; fold nothing else.
  const merged = dedupeAddonsByUrl(updatedAddons)
    .map(addon => ({ ...addon, manifest: getEffectiveManifest(addon) }))
    .filter(addon => addon.manifest?.id && addon.manifest?.name && addon.manifest?.version)

  return { addons: merged, result }
}

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
    const normA = normalizeAddonUrl(addon.transportUrl)
    const shouldRemove = idsOrUrls.some(target => {
      // If target looks like a URL, match ONLY by URL to support multiple instances of same manifest ID
      if (target.includes('://') || target.startsWith('stremio://')) {
        const normTarget = normalizeAddonUrl(target)
        return normA === normTarget
      }
      return addon.manifest.id === target || normA === normalizeAddonUrl(target)
    })

    if (shouldRemove) {
      if (addon.flags?.protected && !allowProtected) {
        protectedAddons.push(addon.manifest.id)
        return true
      }

      removed.push(addon.manifest.id)
      return false
    }

    return true
  })

  return { addons: updatedAddons, removed, protectedAddons }
}


