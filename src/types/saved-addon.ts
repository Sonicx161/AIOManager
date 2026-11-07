import { AddonManifest, CatalogOverrides } from './addon'

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
  originalManifest?: AddonManifest
  tags: string[] // User-defined tags for organization
  profileId?: string // Link to a Profile
  sortOrder?: number // Manual position in the library (custom sort mode); unset = after all ordered items
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
  catalogOverrides?: CatalogOverrides

  // Health & Restoration
  autoRestore?: boolean
  syncWithInstalled?: boolean
  syncAccountIds?: string[] | null
  // Partially-failed installUrl fan-out; retried by saving toUrl again.
  pendingUrlSync?: {
    fromUrl: string
    toUrl: string
    failedAccountIds: string[] // [] = unknown scope (global fan-out failed)
  }
  health?: {
    isOnline: boolean
    error?: string
    lastChecked: number
    latencyMs?: number
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
  syncToLibrary?: boolean
  flags?: {
    official?: boolean
    protected?: boolean
    enabled?: boolean
  }
}

export interface SavedAddonManifestChangeSummary {
  catalogsAdded: number
  catalogsRemoved: number
  resourcesAdded: number
  resourcesRemoved: number
  hasManifestShapeChange: boolean
}

export interface SavedAddonManifestUpdateResult extends SavedAddonManifestChangeSummary {
  previousVersion: string
  latestVersion: string
  versionChanged: boolean
  libraryChanged: boolean
  preservedRemovedCatalogs: number
  remappedRemovedCatalogs: number
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
  removed?: Array<{
    addonId: string
    name: string
  }>
  updated: Array<{
    addonId: string
    oldUrl: string
    newUrl: string
  }>
  skipped: Array<{
    addonId: string
    reason: 'already-exists' | 'protected' | 'fetch-failed' | 'not-installed'
  }>
  protected: Array<{
    addonId: string
    name: string
  }>
  // An older different-config copy is on the account: nothing was written for these.
  pending?: DeployDecisionItem[]
  outcomes?: DeployOutcome[]
  // In memory only: the old copies a Replace answer removed, and the exact entry
  // each pending decision is about (normalized URL + position) so an answer binds to it.
  replaced?: Array<{ oldUrl: string; newUrl: string }>
  candidates?: Record<string, DeployCandidate>
}

export interface DeployCandidate {
  key: string
  index: number
}

export type DeployChoice = 'keep' | 'replace'

export type DeployDecider = (savedAddonId: string, candidate: DeployCandidate) => DeployChoice | undefined

export interface DeployDecisionItem {
  savedAddonId: string
  addonId: string
  name: string
  existingLabel: string | null
  libraryLabel: string | null
}

export interface DeployOutcome {
  savedAddonId: string
  name: string
  outcome: 'added' | 'updated' | 'replaced' | 'kept-both'
  replacedLabel?: string | null
}

/**
 * Result of bulk operations
 */
export interface BulkResult {
  success: number
  failed: number
  errors: Array<{ accountId: string; error: string }>
  details: Array<{ accountId: string; result: MergeResult }>
  cancelled?: number
}

/**
 * Storage keys for LocalForage
 */
export const STORAGE_KEYS = {
  ADDON_LIBRARY: 'aioman:addon-library',
  ACCOUNT_ADDONS: 'aioman:account-addons',
  ACCOUNTS: 'aioman:accounts',
} as const
