import { AddonManifest } from './addon'

/**
 * Saved Addon - A reusable addon configuration
 *
 * Core building block of the addon-forward architecture.
 * Saved addons can be tagged, organized, and applied to accounts individually or in bulk.
 */
export interface SavedAddon {
  id: string // UUID
  name: string // User-defined name (e.g., "Torrentio - RD+AD")
  installUrl: string // Full addon URL with any config embedded
  manifest: AddonManifest // Cached manifest data
  tags: string[] // User-defined tags for organization
  profileId?: string // Link to a Profile
  createdAt: Date
  updatedAt: Date
  lastUsed?: Date

  // Tracking
  sourceType: 'manual' | 'cloned-from-account'
  sourceAccountId?: string // If cloned from an account

  metadata?: {
    customName?: string
    customLogo?: string
    customDescription?: string
  }

  // Health & Restoration
  autoRestore?: boolean
  health?: {
    isOnline: boolean
    lastChecked: number // timestamp
  }
}

/**
 * Account Addon State - Tracks which saved addons are installed on which accounts
 */
export interface AccountAddonState {
  accountId: string
  installedAddons: InstalledAddon[]
  lastSync: Date
}

export interface InstalledAddon {
  savedAddonId: string | null // Null if manually installed outside library
  addonId: string // The manifest.id from Stremio
  installUrl: string // Current URL on account
  installedAt: Date
  installedVia: 'saved-addon' | 'tag' | 'manual'
  appliedTags?: string[] // Tags that were used to apply this addon
}

/**
 * Result of a merge operation
 */
export interface MergeResult {
  added: Array<{
    addonId: string
    name: string
    installUrl: string
  }>
  updated: Array<{
    addonId: string
    oldUrl: string
    newUrl: string
  }>
  skipped: Array<{
    addonId: string
    reason: 'already-exists' | 'protected' | 'fetch-failed'
  }>
  protected: Array<{
    addonId: string
    name: string
  }>
}

/**
 * Result of bulk operations
 */
export interface BulkResult {
  success: number
  failed: number
  errors: Array<{ accountId: string; error: string }>
  details: Array<{ accountId: string; result: MergeResult }>
}

/**
 * Storage keys for LocalForage
 */
export const STORAGE_KEYS = {
  ADDON_LIBRARY: 'stremio-manager:addon-library',
  ACCOUNT_ADDONS: 'stremio-manager:account-addons',
  ACCOUNTS: 'stremio-manager:accounts',
} as const
