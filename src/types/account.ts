import { AddonDescriptor } from './addon'
import { SavedAddon } from './saved-addon'
import { Profile } from './profile'
import { FailoverRule, WebhookConfig } from '@/store/failoverStore'
import { AccountAddonState } from './saved-addon'

export type AccountStatus = 'active' | 'error'

export interface StremioAccount {
  id: string
  name: string
  email?: string
  authKey: string // Encrypted
  password?: string // Encrypted (optional)
  addons: AddonDescriptor[]
  lastSync: Date
  status: AccountStatus

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
