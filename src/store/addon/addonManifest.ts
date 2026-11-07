import { triggerSync } from '@/lib/sync-trigger'
import { fetchAddonManifest } from '@/api/addons'
import { identifyAddon } from '@/lib/addon-identifier'
import { getAddonVersionKey } from '@/lib/utils'
import { saveAddonLibrary } from '@/lib/addon-storage'
import { getEffectiveManifest } from '@/lib/addon-utils'
import {
  compareManifestShape,
  getManifestFingerprint,
  preserveCatalogOverridesAcrossManifestUpdate,
} from '@/lib/addon-manifest-diff'
import localforage from 'localforage'
import type { AddonStore } from '../addonStore'
import type { SavedAddonManifestUpdateResult } from '@/types/saved-addon'
import { mapConcurrent } from '@/lib/concurrency'
import { SAVED_ADDON_ACCOUNT_CONCURRENCY } from './deployment-constants'

const UUID_FRAGMENT_RE = /[0-9a-f]{8}-[0-9a-f]{2,}/i

function isSameAddonRelaxed(savedId: string, freshId: string, savedName: string, freshName: string): boolean {
    if (savedId === freshId) return true
    const savedSuffix = savedId.match(UUID_FRAGMENT_RE)?.[0]
    const freshSuffix = freshId.match(UUID_FRAGMENT_RE)?.[0]
    if (!savedSuffix || !freshSuffix || savedSuffix !== freshSuffix) return false
    const normalize = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, '')
    return normalize(savedName) === normalize(freshName)
}

export async function updateSavedAddonManifest(id: string): Promise<SavedAddonManifestUpdateResult> {
  const { useAddonStore } = await import('../addonStore') as { useAddonStore: { getState: () => AddonStore; setState: (partial: Partial<AddonStore> | ((state: AddonStore) => Partial<AddonStore>)) => void } }
  useAddonStore.setState({ isUpdatingAddon: true, error: null })
  try {
    const get = useAddonStore.getState
    const savedAddon = get().library[id]
    if (!savedAddon) {
      throw new Error('Saved addon not found')
    }

    const previousVersion = savedAddon.manifest.version
    const previousRawManifest = savedAddon.originalManifest || savedAddon.manifest
    const previousFingerprint = getManifestFingerprint(savedAddon.manifest, savedAddon.catalogOverrides)

    const addonDescriptor = await fetchAddonManifest(savedAddon.installUrl, 'System-Check', true)
    const freshManifest = identifyAddon(savedAddon.installUrl, addonDescriptor.manifest)

    if (!isSameAddonRelaxed(savedAddon.manifest.id, freshManifest.id, savedAddon.name, freshManifest.name)) {
      throw new Error('Addon ID mismatch - this may be a different addon')
    }

    const preservedOverrides = preserveCatalogOverridesAcrossManifestUpdate(
      previousRawManifest,
      freshManifest,
      savedAddon.catalogOverrides
    )
    const manifestChanges = compareManifestShape(previousRawManifest, freshManifest)
    const effectiveManifest = getEffectiveManifest({
      ...savedAddon,
      manifest: freshManifest,
      catalogOverrides: preservedOverrides.catalogOverrides,
    })
    const nextFingerprint = getManifestFingerprint(effectiveManifest, preservedOverrides.catalogOverrides)
    const originalManifestChanged = getManifestFingerprint(previousRawManifest) !== getManifestFingerprint(freshManifest)
    const libraryChanged = previousFingerprint !== nextFingerprint || originalManifestChanged

    const updatedSavedAddon = {
      ...savedAddon,
      manifest: effectiveManifest,
      originalManifest: freshManifest,
      catalogOverrides: preservedOverrides.catalogOverrides,
      updatedAt: libraryChanged ? new Date() : savedAddon.updatedAt,
    }

    if (libraryChanged) {
      const library = { ...get().library, [id]: updatedSavedAddon }
      useAddonStore.setState({ library })
      await saveAddonLibrary(library)

      triggerSync()
    }

    const latestVersions = { ...get().latestVersions }
    const versionKey = getAddonVersionKey({
      transportUrl: savedAddon.installUrl,
      manifest: freshManifest,
    })
    const latestVersionsChanged =
      latestVersions[freshManifest.id] !== freshManifest.version ||
      latestVersions[versionKey] !== freshManifest.version
    if (latestVersionsChanged) {
      latestVersions[freshManifest.id] = freshManifest.version
      latestVersions[versionKey] = freshManifest.version
    }

    const manifestChangeHints = get().manifestChangeHints
    const hadManifestChangeHint = Object.prototype.hasOwnProperty.call(manifestChangeHints, id)
    const stateUpdates: Partial<AddonStore> = {}

    if (latestVersionsChanged) {
      stateUpdates.latestVersions = latestVersions
    }

    if (hadManifestChangeHint) {
      const nextManifestChangeHints = { ...manifestChangeHints }
      delete nextManifestChangeHints[id]
      stateUpdates.manifestChangeHints = nextManifestChangeHints
    }

    if (Object.keys(stateUpdates).length > 0) {
      useAddonStore.setState(stateUpdates)
    }
    if (latestVersionsChanged) {
      localforage.setItem('aioman:latest-versions', latestVersions).catch(e => { if (import.meta.env.DEV) console.error(e) })
    }

    if (import.meta.env.DEV) console.log(
      `Updated saved addon "${savedAddon.name}" from v${previousVersion} to v${freshManifest.version}`
    )

    if (updatedSavedAddon.syncWithInstalled && previousFingerprint !== nextFingerprint) {
      const { useAccountStore } = await import('../accountStore')
      const targets = updatedSavedAddon.syncAccountIds
      if (Array.isArray(targets) && targets.length > 0) {
        await mapConcurrent(targets, SAVED_ADDON_ACCOUNT_CONCURRENCY, async (targetAccountId) => {
          try {
            await useAccountStore.getState().replaceTransportUrl(
              savedAddon.installUrl,
              savedAddon.installUrl,
              targetAccountId,
              effectiveManifest,
              updatedSavedAddon.metadata
            )
          } catch (error) {
            if (import.meta.env.DEV) console.error(`[AddonStore] Manifest sync failed for account ${targetAccountId}:`, error)
          }
        })
      } else if (!Array.isArray(targets)) {
        await useAccountStore.getState().replaceTransportUrl(
          savedAddon.installUrl,
          savedAddon.installUrl,
          undefined,
          effectiveManifest,
          updatedSavedAddon.metadata
        )
      }
    }

    return {
      ...manifestChanges,
      previousVersion,
      latestVersion: freshManifest.version,
      versionChanged: previousVersion !== freshManifest.version,
      libraryChanged,
      preservedRemovedCatalogs: preservedOverrides.preservedRemovedCatalogs,
      remappedRemovedCatalogs: preservedOverrides.remappedRemovedCatalogs,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update saved addon manifest'
    useAddonStore.setState({ error: message })
    throw error
  } finally {
    useAddonStore.setState({ isUpdatingAddon: false })
  }
}
