import localforage from 'localforage'
import { SavedAddon, AccountAddonState, STORAGE_KEYS } from '@/types/saved-addon'

/**
 * Addon Storage Layer
 *
 * Provides persistence for saved addons and account addon states using LocalForage.
 */

/**
 * Load all saved addons from storage
 */
export async function loadAddonLibrary(): Promise<Record<string, SavedAddon>> {
  try {
    const stored = await localforage.getItem<Record<string, SavedAddon>>(
      STORAGE_KEYS.ADDON_LIBRARY
    )

    if (!stored) {
      return {}
    }

    // Convert date strings back to Date objects
    const library: Record<string, SavedAddon> = {}
    for (const [id, savedAddon] of Object.entries(stored)) {
      library[id] = {
        ...savedAddon,
        createdAt: new Date(savedAddon.createdAt),
        updatedAt: new Date(savedAddon.updatedAt),
        lastUsed: savedAddon.lastUsed ? new Date(savedAddon.lastUsed) : undefined,
      }
    }

    return library
  } catch (error) {
    console.error('Failed to load addon library from storage:', error)
    return {}
  }
}

/**
 * Save addon library to storage
 */
export async function saveAddonLibrary(
  library: Record<string, SavedAddon>
): Promise<void> {
  try {
    await localforage.setItem(STORAGE_KEYS.ADDON_LIBRARY, library)
  } catch (error) {
    console.error('Failed to save addon library to storage:', error)
    throw new Error('Failed to save addon library')
  }
}

/**
 * Load all account addon states from storage
 */
export async function loadAccountAddonStates(): Promise<
  Record<string, AccountAddonState>
> {
  try {
    const stored = await localforage.getItem<Record<string, AccountAddonState>>(
      STORAGE_KEYS.ACCOUNT_ADDONS
    )

    if (!stored) {
      return {}
    }

    // Convert date strings back to Date objects
    const states: Record<string, AccountAddonState> = {}
    for (const [id, state] of Object.entries(stored)) {
      states[id] = {
        ...state,
        lastSync: new Date(state.lastSync),
        installedAddons: state.installedAddons.map((addon) => ({
          ...addon,
          installedAt: new Date(addon.installedAt),
        })),
      }
    }

    return states
  } catch (error) {
    console.error('Failed to load account addon states from storage:', error)
    return {}
  }
}

/**
 * Save account addon states to storage
 */
export async function saveAccountAddonStates(
  states: Record<string, AccountAddonState>
): Promise<void> {
  try {
    await localforage.setItem(STORAGE_KEYS.ACCOUNT_ADDONS, states)
  } catch (error) {
    console.error('Failed to save account addon states to storage:', error)
    throw new Error('Failed to save account addon states')
  }
}

/**
 * Normalize URL for comparison
 * Removes trailing slashes, converts to lowercase, sorts query params
 */
export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url)

    // Sort query parameters for consistent comparison
    const params = new URLSearchParams(parsed.search)
    const sortedParams = new URLSearchParams(
      Array.from(params.entries()).sort(([a], [b]) => a.localeCompare(b))
    )

    // Rebuild URL with normalized parts
    parsed.search = sortedParams.toString()
    let normalized = parsed.toString()

    // Remove trailing slash
    if (normalized.endsWith('/')) {
      normalized = normalized.slice(0, -1)
    }

    return normalized.toLowerCase()
  } catch {
    // If URL parsing fails, just normalize the string
    return url.toLowerCase().replace(/\/$/, '')
  }
}

/**
 * Find a saved addon by URL (normalized comparison)
 */
export function findSavedAddonByUrl(
  library: Record<string, SavedAddon>,
  url: string
): SavedAddon | null {
  const normalizedUrl = normalizeUrl(url)

  for (const savedAddon of Object.values(library)) {
    if (normalizeUrl(savedAddon.installUrl) === normalizedUrl) {
      return savedAddon
    }
  }

  return null
}
