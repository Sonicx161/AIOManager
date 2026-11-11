/**
 * Store Coordinator
 *
 * Handles coordination between multiple stores without creating circular dependencies.
 * This module can import all stores, but stores should NOT import this module.
 */

import { useAccountStore } from '@/store/accountStore'
import { useAddonStore } from '@/store/addonStore'

export async function resetAllStores(options: { includeSync?: boolean } = {}): Promise<void> {
  const { includeSync = true } = options

  const resets: Promise<unknown>[] = [
    Promise.resolve(useAccountStore.getState().reset()),
    Promise.resolve(useAddonStore.getState().reset()),
    import('@/store/failoverStore').then(({ useFailoverStore }) => useFailoverStore.getState().reset()),
    import('@/store/profileStore').then(({ useProfileStore }) => useProfileStore.getState().reset()),
    import('@/store/libraryCache').then(({ useLibraryCache }) => useLibraryCache.getState().clear()),
    // Display-only read caches (Nuvio tabs, grid membership, avatar catalog,
    // Stremio GetUser): a second user on a shared browser must never see them.
    import('@/lib/display-read-cache').then(({ clearDisplayReadCache }) => clearDisplayReadCache()),
    // Activity row pipeline caches: their module roots retain the previous
    // workspace's feed rows and sorted orders until the next Activity visit.
    import('@/components/activity/feed-rows').then(({ resetActivityRowCaches }) => resetActivityRowCaches()),
    import('@/lib/jellyfin/activity').then(({ resetNowStatusCaches }) => resetNowStatusCaches()),
  ]

  if (includeSync) {
    resets.push(import('@/store/syncStore').then(({ useSyncStore }) => useSyncStore.getState().reset()))
  }

  await Promise.allSettled(resets)
}

export function updateLatestVersions(versions: Record<string, string>): void {
  useAddonStore.getState().updateLatestVersions(versions)
}
