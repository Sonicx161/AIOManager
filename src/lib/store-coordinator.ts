/**
 * Store Coordinator
 *
 * Handles coordination between multiple stores without creating circular dependencies.
 * This module can import all stores, but stores should NOT import this module.
 */

import { useAccountStore } from '@/store/accountStore'
import { useAddonStore } from '@/store/addonStore'

/**
 * Reset all application stores to their initial state
 * Called during master password reset to ensure clean slate
 */
export function resetAllStores(): void {
  useAccountStore.getState().reset()
  useAddonStore.getState().reset()
}

/**
 * Update latest addon versions across relevant stores
 * Called when account sync detects new addon versions
 */
export function updateLatestVersions(versions: Record<string, string>): void {
  useAddonStore.getState().updateLatestVersions(versions)
}
