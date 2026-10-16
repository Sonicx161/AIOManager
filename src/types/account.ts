import { AddonDescriptor } from './addon'
import { SavedAddon } from './saved-addon'
import { Profile } from './profile'
import { FailoverRule, WebhookConfig } from '@/store/failoverStore'
import { AccountAddonState } from './saved-addon'
import { Connection } from './connection'

export type AccountStatus = 'active' | 'error' | 'expired'

export interface AccountProfile {
  id: string
  name: string
  addons: AddonDescriptor[]
  apRules?: FailoverRule[]
}

export interface Account {
  id: string
  name: string
  email?: string
  authKey: string // Encrypted, or '' for local-only accounts
  password?: string // Encrypted (optional)
  addons: AddonDescriptor[]
  lastSync: Date
  status: AccountStatus
  lastError?: string
  lastErrorAt?: number
  accentColor?: string
  emoji?: string
  avatar?: string
  note?: string
  hideLastWatched?: boolean
  hideAddonPreview?: boolean
  hidePlatformLogos?: boolean
  profiles?: AccountProfile[]
  activeProfileId?: string
  connections?: Connection[]
  primaryConnectionId?: string
  apiKey?: string
  createdAt?: number
  // Normalized transportUrl -> deletedAt(ms). Stops a deleted addon from being resurrected by
  // an inbound Stremio/cloud sync. See lib/addon-tombstones.ts.
  deletedAddons?: Record<string, number>
  /** Deletion versions explicitly overridden by a user reinstall. */
  restoredAddons?: Record<string, number>
}

export interface AddonChangelogEntry {
  id: string
  accountId: string
  addonName: string
  addonId: string
  addonUrl?: string
  oldAddonUrl?: string
  newAddonUrl?: string
  addonLogo?: string
  action: 'installed' | 'updated' | 'removed' | 'replaced'
  timestamp: string
}

export interface AccountCredentials {
  email: string
  password: string
}

export interface SavedAddonExport extends Omit<SavedAddon, 'createdAt' | 'updatedAt' | 'lastUsed'> {
  createdAt: string
  updatedAt: string
  lastUsed?: string
}

export interface ProfileExport extends Omit<Profile, 'createdAt' | 'updatedAt'> {
  createdAt: string
  updatedAt: string
}


import { AddonManifest } from './addon'

export interface FailoverRuleExport extends Omit<FailoverRule, 'lastCheck' | 'lastFailover'> {
  lastCheck?: string
  lastFailover?: string
}


export interface AccountExport {
  version: string
  exportedAt: string
  manifests?: Record<string, AddonManifest> // V2 Deduplicated Manifests
  accounts: Array<{
    id?: string
    name: string
    email?: string
    authKey?: string // User decides whether to include
    password?: string // User decides whether to include
    addons: Array<AddonDescriptor | {
      transportUrl: string
      transportName?: string
      manifestId: string
      flags?: AddonDescriptor['flags']
    }>
  }>
  savedAddons?: SavedAddonExport[]
  profiles?: ProfileExport[]
  failover?: {
    rules: FailoverRuleExport[]
    webhook: WebhookConfig
  }
  accountStates?: Record<string, AccountAddonState>
  identity?: {
    name: string
  }
}
