import { triggerSync } from '@/lib/sync-trigger'
import { legacyConnectionGeneration } from '@/lib/connection-generation'
import { migrateConnectionPictures, CONNECTION_PICTURES_SCHEMA_VERSION } from '@/lib/connection-pictures/sync-merge'
import {
      getAddons,
} from '@/api/addons'
import { normalizeAddonUrl, ACCOUNT_COLORS, hasFallbackAddonIdentity } from '@/lib/utils'
import { mergeAddonDeletionState } from '@/lib/addon-tombstones'
import { getHostnameIdentifier } from '@/lib/addon-identifier'
import { loginWithCredentials } from '@/api/auth'
import { LoginResponse } from '@/api/stremio-client'
import { decrypt, encrypt } from '@/lib/crypto'
import { useAuthStore } from '@/store/authStore'
import { updateLatestVersions as updateLatestVersionsCoordinator } from '@/lib/store-coordinator'
import { toast } from '@/hooks/use-toast'
import { Account, AddonChangelogEntry } from '@/types/account'
import { AddonDescriptor } from '@/types/addon'
import { identifyAddon } from '@/lib/addon-identifier'
import type { AddonCollectionDiff } from '@/lib/addon-collection-diff'
import type { ReplaceMetadata } from './account/accountAddonOps'
import localforage from 'localforage'
import { trace } from '@/lib/trace'
import { deleteAccountIds, mergeAccountMembership, type AccountMembership, type AccountListImport } from '@/lib/account-membership'
import { captureSyncOwnership, type SyncOwnership } from './sync-store-helpers'
import { getActiveWorkspaceId } from '@/lib/workspace-persistence'
import { rememberKnownManifests, restoreKnownManifests } from '@/lib/manifest-placeholder'

import { create } from 'zustand'

export const STORAGE_KEY = 'aioman:accounts'
export const CHANGELOG_KEY = 'aioman:changelog'
export const BACKUP_KEY = 'aioman:accounts:backup'
export const ACCOUNT_MEMBERSHIP_KEY = 'aioman:account-membership'
export const ACCOUNT_MEMBERSHIP_MUTEX = '__account-membership__'

export const safeUUID = () => {
    try { return crypto.randomUUID() } catch {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = crypto.getRandomValues(new Uint8Array(1))[0] % 16
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16)
        })
    }
}

const accountPersist = {
    timer: null as ReturnType<typeof setTimeout> | null,
    queue: Promise.resolve() as Promise<void>,
}

// A placeholder manifest never reaches disk over a known-good one. Rows keep count and order.
export const protectAccountsForWrite = (accounts: Account[]): Account[] => {
    for (const acc of accounts) rememberKnownManifests(acc.addons)
    let changed = false
    const out = accounts.map((acc) => {
        const addons = restoreKnownManifests(acc.addons || [])
        const profiles = acc.profiles?.map((profile) => {
            if (!profile.addons) return profile
            const profileAddons = restoreKnownManifests(profile.addons)
            return profileAddons === profile.addons ? profile : { ...profile, addons: profileAddons }
        })
        const profilesChanged = !!profiles && profiles.some((profile, i) => profile !== acc.profiles?.[i])
        if (addons === acc.addons && !profilesChanged) return acc
        changed = true
        return { ...acc, addons, ...(profilesChanged ? { profiles } : {}) }
    })
    return changed ? out : accounts
}

// Recheck ownership when the deferred write actually runs.
export const persistAccounts = (accounts: Account[], ownership?: { current: () => boolean }) => {
    const workspace = getActiveWorkspaceId()
    // Local edits remain durable if an unrelated pull starts and fails. Imports
    // pass their stricter generation fence; all writes stay workspace-scoped.
    const current = ownership?.current ?? (() => getActiveWorkspaceId() === workspace)
    if (accountPersist.timer) clearTimeout(accountPersist.timer)
    accountPersist.timer = setTimeout(async () => {
        accountPersist.timer = null
        if (!current()) return
        accountPersist.queue = accountPersist.queue.then(async () => {
            if (!current()) return
            await localforage.setItem(STORAGE_KEY, protectAccountsForWrite(accounts))
        }).catch(e => { if (import.meta.env.DEV) console.error('[persistAccounts] Failed to save accounts:', e) })
    }, 300)
}

// Deletion intent reaches disk before the list. If a tab closes between writes,
// initialize filters the older list (and the recovery backup) through the markers.
export async function persistAccountMembership(accounts: Account[], membership: AccountMembership, ownership: SyncOwnership): Promise<void> {
    if (accountPersist.timer) { clearTimeout(accountPersist.timer); accountPersist.timer = null }
    const write = accountPersist.queue.then(async () => {
        ownership.assert()
        await localforage.setItem(ACCOUNT_MEMBERSHIP_KEY, membership)
        ownership.assert()
        await localforage.setItem(STORAGE_KEY, protectAccountsForWrite(accounts))
        ownership.assert()
    })
    accountPersist.queue = write.catch(() => {})
    await write
}

// Flush a pending debounced account persist now instead of waiting out the 300 ms
// timer: a phone backgrounding or closing the page must not lose the last local edit.
export const flushPendingAccountPersist = (): boolean => {
    if (!accountPersist.timer) return false
    clearTimeout(accountPersist.timer)
    accountPersist.timer = null
    const { accounts } = useAccountStore.getState()
    localforage.setItem(STORAGE_KEY, protectAccountsForWrite(accounts)).catch((e) => { if (import.meta.env.DEV) console.error('[accountStore] unload persist failed:', e) })
    return true
}

if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', flushPendingAccountPersist)
    // Phones suspend straight from pagehide or a hidden visibility change; the
    // deferred 300 ms timer would otherwise never fire (Sol P1-SYNC-01).
    window.addEventListener('pagehide', flushPendingAccountPersist)
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flushPendingAccountPersist()
    })
}

import { syncMutexes, acquireSyncMutex, tryAcquireSyncMutex } from './syncMutex'
export { syncMutexes, acquireSyncMutex, tryAcquireSyncMutex }
export const getAccountById = (accounts: Account[], id: string): Account | undefined =>
  accounts.find(a => a.id === id)

import { getStremioConnection, getStremioAuthKey, getAccountEmail, getStremioConnections } from '@/lib/account-compat'
import { scopeStremioKeyRotation } from '@/lib/connection-identity'
export { getStremioConnection, getStremioAuthKey, getAccountEmail, getStremioConnections }

export function hasPlatformConnection(account: Account): boolean {
    return !!getStremioAuthKey(account) || !!(account.connections || []).some(c => c.enabled)
}

const AUTH_KEY_CACHE_MAX = 250
const authKeyCache = new Map<string, string>()

export const clearAuthKeyCache = () => authKeyCache.clear()

export const getCachedAuthKey = async (encryptedAuthKey: string, encryptionKey: CryptoKey): Promise<string> => {
    const cached = authKeyCache.get(encryptedAuthKey)
    if (cached) return cached
    const decrypted = await decrypt(encryptedAuthKey, encryptionKey)
    if (authKeyCache.size >= AUTH_KEY_CACHE_MAX) {
        const firstKey = authKeyCache.keys().next().value
        if (firstKey !== undefined) authKeyCache.delete(firstKey)
    }
    authKeyCache.set(encryptedAuthKey, decrypted)
    return decrypted
}

const authKeyHashSet = new Set<string>()
const authKeyHashByAccount = new Map<string, string>()
let _authKeyHashesPopulated = false
let _authKeyHashesPopulatePromise: Promise<void> | null = null

const sha256Hex = async (text: string): Promise<string> => {
    const data = new TextEncoder().encode(text)
    const buf = await crypto.subtle.digest('SHA-256', data)
    const bytes = new Uint8Array(buf)
    let hex = ''
    for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0')
    return hex
}

const upsertAuthKeyHash = async (accountId: string, decryptedAuthKey: string) => {
    const hash = await sha256Hex(decryptedAuthKey)
    const prev = authKeyHashByAccount.get(accountId)
    if (prev !== undefined) authKeyHashSet.delete(prev)
    authKeyHashByAccount.set(accountId, hash)
    authKeyHashSet.add(hash)
}

const removeAuthKeyHash = (accountId: string) => {
    const prev = authKeyHashByAccount.get(accountId)
    if (prev !== undefined) {
        authKeyHashSet.delete(prev)
        authKeyHashByAccount.delete(accountId)
    }
}

const resetAuthKeyHashes = () => {
    authKeyHashSet.clear()
    authKeyHashByAccount.clear()
    _authKeyHashesPopulated = false
    _authKeyHashesPopulatePromise = null
}

const populateAuthKeyHashes = async (): Promise<void> => {
    if (_authKeyHashesPopulated) return
    if (_authKeyHashesPopulatePromise) return _authKeyHashesPopulatePromise
    _authKeyHashesPopulatePromise = (async () => {
        try {
            const encKey = useAuthStore.getState().encryptionKey
            if (!encKey) return
            const accounts = useAccountStore.getState().accounts
            await Promise.all(accounts.map(async (a) => {
                const encrypted = getStremioAuthKey(a)
                if (!encrypted) return
                try {
                    const decrypted = await decrypt(encrypted, encKey)
                    await upsertAuthKeyHash(a.id, decrypted)
                } catch {}
            }))
            _authKeyHashesPopulated = true
        } finally {
            _authKeyHashesPopulatePromise = null
        }
    })()
    return _authKeyHashesPopulatePromise
}

export const applyAutopilotAddonFlags = async (accountId: string, addons: AddonDescriptor[]) => {
    const { useFailoverStore } = await import('@/store/failoverStore')
    const activeRules = useFailoverStore.getState().rules.filter(rule =>
        rule.accountId === accountId &&
        rule.isActive &&
        Array.isArray(rule.priorityChain) &&
        rule.priorityChain.length > 0
    )

    if (activeRules.length === 0) return { addons, changed: false }

    let changed = false
    const nextAddons = addons.map(addon => {
        const normAddonUrl = normalizeAddonUrl(addon.transportUrl)
        let shouldBeEnabled: boolean | undefined

        for (const rule of activeRules) {
            const normalizedChain = rule.priorityChain.map(url => normalizeAddonUrl(url))
            const chainIndex = normalizedChain.indexOf(normAddonUrl)
            if (chainIndex === -1) continue

            const activeUrl = rule.activeUrl || rule.priorityChain[0]
            shouldBeEnabled = normalizedChain[chainIndex] === normalizeAddonUrl(activeUrl)
            break
        }

        if (shouldBeEnabled === undefined) return addon
        if ((addon.flags?.enabled !== false) === shouldBeEnabled) return addon

        changed = true
        return {
            ...addon,
            flags: { ...addon.flags, enabled: shouldBeEnabled },
            metadata: { ...addon.metadata, lastUpdated: Date.now() }
        }
    })

    return { addons: nextAddons, changed }
}

let _registrationInProgress = false
const pendingSessionBoundChecks = new Set<string>()
const SESSION_BOUND_AUTH_CHECK_DELAY = 90 * 1000

export const sanitizeAddonManifest = (manifest: AddonDescriptor['manifest'], transportUrl?: string): AddonDescriptor['manifest'] => {
      const identified = identifyAddon(transportUrl || '', manifest || undefined)
      return {
            ...identified,
            types: identified.types || [],
            resources: identified.resources || [],
            logo: identified.logo ?? undefined,
            background: identified.background ?? undefined,
            idPrefixes: identified.idPrefixes ?? undefined,
      }
}

export const getEncryptionKey = () => {
      const key = useAuthStore.getState().encryptionKey
      if (!key) {
            throw new Error(
                  'Session expired. Sign in again before adding or editing accounts.'
            )
      }
      return key
}

export const isAuthError = (error: unknown) => {
      const message = error instanceof Error ? error.message : String((error as Record<string, unknown>)?.message || '')
      const lowerMsg = message.toLowerCase()
      return (
            (error as { isAuthError?: boolean })?.isAuthError === true ||
            (error as Record<string, unknown>)?.status === 401 ||
            lowerMsg.includes('invalid or expired auth key') ||
            lowerMsg.includes('invalid auth key') ||
            lowerMsg.includes('session does not exist') ||
            lowerMsg.includes('unauthorized')
      )
}

export const isTransientSyncError = (error: unknown) => {
      const message = error instanceof Error ? error.message : String((error as Record<string, unknown>)?.message || '')
      const lowerMsg = message.toLowerCase()
      return (
            lowerMsg.includes('proxy failed') ||
            lowerMsg.includes('network error') ||
            lowerMsg.includes('econnreset') ||
            lowerMsg.includes('etimedout')
      )
}

export const needsDisabledAddonIdentityRepair = (addon: AddonDescriptor) => {
      if (addon.flags?.enabled !== false) return false
      if (!hasFallbackAddonIdentity(addon)) return false
      if (!addon.metadata?.customName) return true
      const hostName = getHostnameIdentifier(addon.transportUrl)
      return !!hostName && addon.metadata.customName === hostName
}

export const refreshAuthKeyFromStoredPassword = async (
      account: Account,
      encryptionKey: CryptoKey
): Promise<{ account: Account; authKey: string } | null> => {
      if (!account.email || !account.password) return null

      const password = await decrypt(account.password, encryptionKey)
      const response = await loginWithCredentials(account.email, password)
      const encryptedAuthKey = await encrypt(response.authKey, encryptionKey)

      authKeyCache.delete(getStremioAuthKey(account))
      authKeyCache.set(encryptedAuthKey, response.authKey)
      await upsertAuthKeyHash(account.id, response.authKey)

      // A stored-password refresh rotates the account's CANONICAL Stremio login only;
      // secondary Stremio logins on the same account keep their own sealed keys.
      const updatedConnections = scopeStremioKeyRotation(account.connections, account.primaryConnectionId, encryptedAuthKey)
      return {
            authKey: response.authKey,
            account: {
                  ...account,
                  email: response.user?.email || account.email,
                  authKey: encryptedAuthKey,
                  connections: updatedConnections,
                  status: 'active',
            },
      }
}

const scheduleSessionBoundAuthCheck = (accountId: string) => {
       if (pendingSessionBoundChecks.has(accountId)) return
       pendingSessionBoundChecks.add(accountId)
       setTimeout(() => {
             pendingSessionBoundChecks.delete(accountId)
             const account = getAccountById(useAccountStore.getState().accounts, accountId)
              if (!account || !getStremioAuthKey(account) || account.status !== 'active' || account.password) return
            useAccountStore.getState().syncAccount(accountId).catch((error) => {
                  if (import.meta.env.DEV) console.warn('[Account] Delayed OAuth/auth-key health check failed:', error)
            })
      }, SESSION_BOUND_AUTH_CHECK_DELAY)
}

export const setAccountLoading = (accountId: string) => {
  const store = useAccountStore.getState()
  useAccountStore.setState({ loadingAccounts: new Set([...store.loadingAccounts, accountId]) })
}

export const clearAccountLoading = (accountId: string) => {
  const store = useAccountStore.getState()
  useAccountStore.setState({ loadingAccounts: new Set([...store.loadingAccounts].filter(id => id !== accountId)) })
}

export const setAccountsLoading = (accountIds: string[]) => {
  const store = useAccountStore.getState()
  useAccountStore.setState({ loadingAccounts: new Set([...store.loadingAccounts, ...accountIds]) })
}

export const clearAllAccountLoading = () => {
  useAccountStore.setState({ loadingAccounts: new Set<string>() })
}

// Incarnation tokens on load (R2-06, R3-03): connections persisted before the feature
// (or restored from a legacy blob) get a generation minted exactly once; existing
// tokens are never replaced, so the stamp stays stable across loads. The minted
// token is a deterministic digest of account and connection ids, so two devices
// holding the same legacy connection converge on one incarnation.
export async function mintMissingConnectionGenerations<T extends Account>(accounts: T[]): Promise<{ accounts: T[]; minted: boolean }> {
  let minted = false
  const out = await Promise.all(accounts.map(async acc => {
    if (!acc.connections?.some(c => !c.generation)) return acc
    minted = true
    return {
      ...acc,
      connections: await Promise.all(acc.connections.map(async c => c.generation ? c : { ...c, generation: await legacyConnectionGeneration(acc.id, c.id) })),
    }
  }))
  return { accounts: out, minted }
}

export interface ReplaceTransportUrlResult {
      updatedAccountIds: string[]
      failedAccounts: string[]
}

export interface AccountStore {
      accounts: Account[]
      deletedAccounts: Record<string, number>
      restoredAccounts: Record<string, number>
      loadingAccounts: Set<string>
      error: string | null
      changelog: AddonChangelogEntry[]
      hydrated: boolean

      initialize: () => Promise<void>
      updateLatestVersions: (versions: Record<string, string>) => void
      addAccountByAuthKey: (authKey: string, name: string, accentColor?: string, emoji?: string, avatar?: string) => Promise<void>
      addAccountByCredentials: (email: string, password: string, name: string, accentColor?: string, emoji?: string, avatar?: string, intent?: 'login' | 'signup') => Promise<void>
      addLocalAccount: (name: string, accentColor?: string, emoji?: string, avatar?: string) => Promise<string>
      removeAccount: (id: string) => Promise<void>
      syncAccount: (id: string, forceRefresh?: boolean, intent?: import('./account/accountSync').SyncIntent) => Promise<void>
      syncAllAccounts: (silent?: boolean) => Promise<boolean>
      repairAccount: (id: string) => Promise<void>
      installAddonToAccount: (accountId: string, addonUrl: string, savedMetadata?: import('@/types/addon').AddonDescriptor['metadata']) => Promise<void>
      installAddonsToAccount: (accountId: string, addonUrls: string[], concurrency?: number) => Promise<{ successCount: number; failCount: number }>
      removeAddonFromAccount: (accountId: string, transportUrl: string) => Promise<void>
      removeAddonByIndexFromAccount: (accountId: string, index: number) => Promise<void>
      reorderAddons: (accountId: string, newOrder: AddonDescriptor[], options?: { explicitInstallUrls?: string[] }) => Promise<void>
      bulkDeleteAddons: (accountId: string, keptAddons: AddonDescriptor[], removedUrls: string[]) => Promise<void>
      exportAccounts: (includeCredentials: boolean) => Promise<string>
      exportAccountsForSync: () => Promise<Record<string, unknown>>
      importAccounts: (json: string | Record<string, unknown>, isSilent?: boolean, mode?: 'merge' | 'mirror', localDecryptionKey?: CryptoKey | null, ownership?: SyncOwnership, accountList?: AccountListImport) => Promise<void>
      updateAccount: (
            id: string,
            data: { name?: string; authKey?: string; email?: string; password?: string; accentColor?: string; emoji?: string; avatar?: string; note?: string; hideLastWatched?: boolean; hideAddonPreview?: boolean; hidePlatformLogos?: boolean }
      ) => Promise<void>
      updateAccountNote: (accountId: string, note: string) => Promise<void>
      toggleAddonProtection: (
            accountId: string,
            transportUrl: string,
            isProtected: boolean,
            targetIndex?: number
      ) => Promise<void>
      toggleAddonEnabled: (
            accountId: string,
            transportUrl: string,
            isEnabled: boolean,
            silent?: boolean,
            targetIndex?: number,
            isAutopilot?: boolean
      ) => Promise<void>
      bulkToggleAddonEnabled: (
            accountId: string,
            addonUrls: string[],
            isEnabled: boolean
      ) => Promise<void>
      updateAddonSettings: (
            accountId: string,
            transportUrl: string,
            settings: {
                  metadata?: { customName?: string; customLogo?: string; customDescription?: string; syncToLibrary?: boolean; hideConfigure?: boolean },
                  catalogOverrides?: AddonDescriptor['catalogOverrides'],
                  manifest?: AddonDescriptor['manifest'],
                  note?: string,
                  destinations?: AddonDescriptor['destinations'] | null,
            },
            targetIndex?: number
      ) => Promise<void>
      moveAccount: (id: string, direction: 'up' | 'down') => Promise<void>
      reorderAccounts: (newOrder: string[]) => Promise<void>
      bulkProtectAddons: (accountId: string, isProtected: boolean) => Promise<number>
      bulkProtectSelectedAddons: (accountId: string, transportUrls: string[], isProtected: boolean) => Promise<number>
      bulkSetHideConfigure: (accountId: string, hideConfigure: boolean) => Promise<number>
      bulkSetHideConfigureSelected: (accountId: string, transportUrls: string[], hideConfigure: boolean) => Promise<number>
      removeLocalAddons: (accountId: string, transportUrls: string[]) => Promise<void>
      replaceTransportUrl: (oldUrl: string, newUrl: string, accountId?: string, freshManifest?: AddonDescriptor['manifest'], metadata?: ReplaceMetadata) => Promise<ReplaceTransportUrlResult>
      reinstallAddon: (accountId: string, transportUrl: string) => Promise<void>
      reinstallAddons: (accountId: string, transportUrls: string[], concurrency?: number, onProgress?: (current: number, total: number) => void) => Promise<{ successCount: number; failCount: number }>
      syncAutopilotRules: (accountId: string) => Promise<void>
      clearError: () => void
      reset: () => Promise<void>
      wipeAccounts: () => Promise<void>
      addChangelogEntry: (entry: Omit<AddonChangelogEntry, 'id' | 'timestamp'>) => Promise<void>
      clearChangelog: (accountId?: string, maxAgeMs?: number) => Promise<void>
      createSubProfile: (accountId: string, name: string, cloneFromCurrent?: boolean) => Promise<string | undefined>
      deleteSubProfile: (accountId: string, profileId: string) => Promise<void>
      renameSubProfile: (accountId: string, profileId: string, newName: string) => Promise<void>
      switchProfile: (accountId: string, targetProfileId: string) => Promise<ProfileSwitchResult>
}

export interface ProfileSwitchResult {
      targetProfileId: string
      targetName: string
      addonChanges: AddonCollectionDiff
      remoteWriteSkipped: boolean
}

export const useAccountStore = create<AccountStore>((set, get) => ({
      accounts: [],
      deletedAccounts: {},
      restoredAccounts: {},
      hydrated: false,
      loadingAccounts: new Set<string>(),
      error: null,
      changelog: [],

      syncAutopilotRules: async (accountId: string) => {
            try {
                  const { useFailoverStore } = await import('@/store/failoverStore')
                  await useFailoverStore.getState().syncRulesForAccount(accountId)
            } catch (e) {
                  if (import.meta.env.DEV) console.warn('[AccountStore] Autopilot sync notification failed:', e)
            }
      },

      initialize: async () => {
            const ownership = captureSyncOwnership()
            try {
                  // Independent localforage keys: one IDB round trip each, so
                  // read them concurrently instead of serially.
                  const [storedAccountsRead, storedChangelog, storedMembership] = await Promise.all([
                        localforage.getItem<Account[]>(STORAGE_KEY),
                        localforage.getItem<AddonChangelogEntry[]>(CHANGELOG_KEY),
                        localforage.getItem<AccountMembership>(ACCOUNT_MEMBERSHIP_KEY),
                  ])
                  let storedAccounts = storedAccountsRead
                  const membership = mergeAccountMembership(storedMembership || {})
                  ownership.assert()

                  // This catches the case where a corrupted re-login wiped accounts between sessions.
                  if (!storedAccounts || !Array.isArray(storedAccounts)) {
                        const backup = await localforage.getItem<Account[]>(BACKUP_KEY)
                        ownership.assert()
                        if (backup && Array.isArray(backup) && backup.length > 0) {
                              if (import.meta.env.DEV) console.warn(`[AccountStore] Accounts missing on disk. Restoring ${backup.length} accounts from backup.`)
                              storedAccounts = backup.filter(a => !Object.hasOwn(membership.deletedAccounts, a.id))
                              await localforage.setItem(STORAGE_KEY, storedAccounts)
                        }
                  }

                  ownership.assert()
                  set(membership)
                  if (storedAccounts && Array.isArray(storedAccounts)) {
                        const accounts = storedAccounts.filter(a => !Object.hasOwn(membership.deletedAccounts, a.id)).map((acc) => ({
                              ...acc,
                              lastSync: new Date(acc.lastSync),
                        }))
                        for (const acc of accounts) rememberKnownManifests(acc.addons)

                        // One-time migration: colorIndex -> accentColor
                        let didHubMigrate = false
                        let didConnectionPicturesMigrate = false
                        let migratedAccounts = accounts.map(acc => {
                              const connections = acc.connections || []
                              const needsHubMigration = acc.authKey && acc.authKey.length > 60 && connections.length === 0
                              let migrated = {
                                    ...acc,
                                    profiles: acc.profiles ?? [],
                                    apiKey: acc.apiKey || safeUUID(),
                              }

                              // Versioned migration (schema v3): drop malformed
                              // rows and rows for the removed platforms
                              // (Stremio, Nuvio, RealStream) from older blobs.
                              if (acc.connectionPictures !== undefined) {
                                    const migratedPictures = migrateConnectionPictures(acc.connectionPictures)
                                    if (JSON.stringify(migratedPictures ?? null) !== JSON.stringify(acc.connectionPictures ?? null)) {
                                          didConnectionPicturesMigrate = true
                                          migrated = migratedPictures
                                                ? { ...migrated, connectionPictures: migratedPictures }
                                                : (() => { const { connectionPictures: _cp, ...rest } = migrated as Record<string, unknown> & { connectionPictures?: unknown }; return rest as typeof migrated })()
                                    }
                                    if (migrated.connectionPictures && migrated.connectionPicturesSchemaVersion !== CONNECTION_PICTURES_SCHEMA_VERSION) {
                                          didConnectionPicturesMigrate = true
                                          migrated = { ...migrated, connectionPicturesSchemaVersion: CONNECTION_PICTURES_SCHEMA_VERSION }
                                    }
                              }

                              if ('colorIndex' in migrated && (migrated as Record<string, unknown>).colorIndex !== undefined && !migrated.accentColor) {
                                    const { colorIndex: _, ...rest } = migrated as Record<string, unknown> & { colorIndex?: unknown }
                                    migrated = {
                                          ...rest,
                                          accentColor: ACCOUNT_COLORS[Number((migrated as Record<string, unknown>).colorIndex) % ACCOUNT_COLORS.length],
                                    } as typeof migrated
                              }

                              if (needsHubMigration) {
                                    didHubMigrate = true
                                    // Dual-write: give the Stremio connection a stable id and KEEP the flat
                                    // authKey/email so v1.8.5 clients on the same cloud account still work.
                                    // The v1.8.5 root password is deliberately NOT copied into connection
                                    // credentials: authKey covers every active flow, and re-auth prompts
                                    // ask for the password again.
                                    const stremioId = `${acc.id}:stremio`
                                    migrated = {
                                          ...migrated,
                                          connections: [{
                                                id: stremioId,
                              platform: 'stremio',
                              driverType: 'native',
                              connectionType: 'native' as const,
                              enabled: true,
                                                status: acc.status === 'expired' ? 'expired' : 'active',
                                                credentials: {
                                                      authKey: acc.authKey || '',
                                                      email: acc.email || '',
                                                },
                                                lastSync: new Date(acc.lastSync).getTime() || 0,
                                                lastKnownAddonCount: acc.addons?.length || 0,
                                                capabilities: ['addons'],
                                                consecutiveFailures: 0,
                                          }],
                                          primaryConnectionId: stremioId,
                                    }
                              }

                              return migrated
                        })

                        let needsCleanup = false
                        const cleaned = migratedAccounts.map(acc => {
                              if (acc.authKey && acc.authKey.length <= 60) {
                                    needsCleanup = true
                                    return { ...acc, authKey: '' }
                              }
                              return acc
                        })
                        if (needsCleanup) {
                              migratedAccounts = cleaned
                              persistAccounts(cleaned)
                        }

                         // R2-06: legacy connections gain an incarnation token once, at load.
                         const generationMint = await mintMissingConnectionGenerations(migratedAccounts)
                         migratedAccounts = generationMint.accounts

                        set({ accounts: migratedAccounts })
                        if (didHubMigrate) {
                            persistAccounts(migratedAccounts)
                            triggerSync()
                        }
                        if (didConnectionPicturesMigrate) {
                            persistAccounts(migratedAccounts)
                        }
                         if (generationMint.minted) {
                               persistAccounts(migratedAccounts)
                         }
                  }

                  if (storedChangelog && Array.isArray(storedChangelog)) {
                        set({ changelog: storedChangelog })
                  }
                  set({ hydrated: true })
                  // One-time heal: oversized stored avatar data URIs shrink in the
                  // background (worker), but only after an authenticated session has
                  // completed its initial sync; local hydration alone (pre-login)
                  // never arms it (Sol P1-AVATAR-01).
                  void armAvatarHealAfterSession()
            } catch (error) {
                  if (!ownership.current()) return
                  if (import.meta.env.DEV) console.error('Failed to load accounts from storage:', error)
                  set({ error: 'Failed to load saved accounts' })
            }
      },

      updateLatestVersions: (versions: Record<string, string>) => {
            updateLatestVersionsCoordinator(versions)
      },

      addAccountByAuthKey: async (authKey: string, name: string, accentColor?: string, emoji?: string, avatar?: string) => {
            const ownership = captureSyncOwnership()
            const opId = '__add_account__'
            set({ loadingAccounts: new Set([...get().loadingAccounts, opId]), error: null })
            const start = Date.now()
            trace('account', 'add.start', { method: 'auth-key' })
            try {
                  const { stremioClient } = await import('@/api/stremio-client')

                  const [user, addons] = await Promise.all([
                        stremioClient.getUser(authKey).catch(() => null),
                        getAddons(authKey, 'Account Import')
                  ])

                  const normalizedAddons = addons.map((addon) => ({
                        ...addon,
                        manifest: sanitizeAddonManifest(addon.manifest, addon.transportUrl),
                  }))

                  // Log diagnostic info to help debug naming issues
                  if (import.meta.env.DEV) console.log('[AccountStore] Finalizing auth-key import:', {
                        providedName: name,
                        userEmail: user?.email,
                        hasAddons: addons.length > 0
                  })

                  const accountName = name.trim() || user?.email || 'Account'
                  if (import.meta.env.DEV) console.log('[AccountStore] Resolved account name:', accountName)

                  const existingAccount = await (async () => {
                        const encKey = useAuthStore.getState().encryptionKey
                        if (!encKey) return null
                        await populateAuthKeyHashes()
                        const newHash = await sha256Hex(authKey)
                        if (!authKeyHashSet.has(newHash)) return null
                        for (const a of get().accounts) {
                            if (authKeyHashByAccount.get(a.id) === newHash) return a
                        }
                        return null
                  })()
                  if (existingAccount) {
                        throw new Error(`This account is already added as "${existingAccount.name}"`)
                  }

                  const stremioConnectionId = safeUUID()
                  const account: Account = {
                        id: safeUUID(),
                        name: accountName,
                        authKey: '',
                        addons: normalizedAddons,
                        lastSync: new Date(),
                        status: 'active',
                        accentColor,
                        emoji,
                        avatar,
                        profiles: [],
                        apiKey: safeUUID(),
                        createdAt: Date.now(),
                        connections: [{
                              id: stremioConnectionId,
                              platform: 'stremio',
                              driverType: 'native',
                              connectionType: 'native' as const,
                              enabled: true,
                              status: 'active',
                              credentials: {
                                    authKey: await encrypt(authKey, getEncryptionKey()!),
                              },
                              lastSync: Date.now(),
                              lastKnownAddonCount: normalizedAddons.length,
                              capabilities: ['addons'],
                              consecutiveFailures: 0,
                        }],
                        primaryConnectionId: stremioConnectionId,
                  }

                  const releaseMembership = await acquireSyncMutex(ACCOUNT_MEMBERSHIP_MUTEX)
                  try {
                        ownership.assert()
                        const accounts = [...get().accounts, account]
                        set({ accounts })
                        persistAccounts(accounts)
                  } finally { releaseMembership() }
                  await upsertAuthKeyHash(account.id, authKey)

                  const { useLibraryCache } = await import('@/store/libraryCache')
                  useLibraryCache.setState({ isStale: true })

                  triggerSync()
                  scheduleSessionBoundAuthCheck(account.id)
                  trace('account', 'add.success', { accountId: account.id, method: 'auth-key', addonCount: normalizedAddons.length, timing: Date.now() - start })
            } catch (error) {
                  const message = error instanceof Error ? error.message : 'Failed to add account'
                  set({ error: message })
                  trace('account', 'add.error', { method: 'auth-key', error: message, timing: Date.now() - start })
                  throw error
            } finally {
                  set({ loadingAccounts: new Set([...get().loadingAccounts].filter(id => id !== opId)) })
            }
      },

      addAccountByCredentials: async (email: string, password: string, name: string, accentColor?: string, emoji?: string, avatar?: string, intent: 'login' | 'signup' = 'login') => {
            const ownership = captureSyncOwnership()
            if (_registrationInProgress) throw new Error('Registration already in progress')
            _registrationInProgress = true
            const opId = '__add_account__'
            set({ loadingAccounts: new Set([...get().loadingAccounts, opId]), error: null })
            const start = Date.now()
            trace('account', 'add.start', { method: 'credentials', intent })
            try {
                  let response: LoginResponse
                  if (intent === 'signup') {
                        const { registerAccount } = await import('@/api/auth')
                        response = await registerAccount(email, password)
                        toast({
                              title: 'Account Created',
                              description: `Successfully registered ${email} on Stremio.`,
                        })
                  } else {
                        try {
                              response = await loginWithCredentials(email, password)
                        } catch (loginError: unknown) {
                              const err = loginError as Record<string, unknown>
                              const isUserNotFound =
                                    err.code === 'USER_NOT_FOUND' ||
                                    (typeof err.message === 'string' && (err.message as string).includes('USER_NOT_FOUND')) ||
                                    (typeof err.message === 'string' && (err.message as string).includes('User not found')) ||
                                    (typeof err.code === 'string' && (err.code as string).includes('USER_NOT_FOUND'))
                              if (isUserNotFound) {
                                    throw new Error('No account found for that email. Switch to "Create Account" to register a new one.')
                              }
                              throw loginError
                        }
                  }

                  const addons = await getAddons(response.authKey, 'New-Login-Check')
                  const normalizedAddons = addons.map((addon) => ({
                        ...addon,
                        manifest: sanitizeAddonManifest(addon.manifest, addon.transportUrl),
                  }))

                  const existingAccount = get().accounts.find(a => {
                        try {
                              return a.email?.toLowerCase() === email.toLowerCase()
                        } catch { return false }
                  })
                  if (existingAccount) {
                        throw new Error(`This account is already added as "${existingAccount.name}"`)
                  }

                  const stremioConnectionId = safeUUID()
                  const account: Account = {
                        id: safeUUID(),
                        name: name || email,
                        authKey: '',
                        addons: normalizedAddons,
                        lastSync: new Date(),
                        status: 'active',
                        accentColor,
                        emoji,
                        avatar,
                        profiles: [],
                        apiKey: safeUUID(),
                        createdAt: Date.now(),
                        connections: [{
                              id: stremioConnectionId,
                              platform: 'stremio',
                              driverType: 'native',
                              connectionType: 'native' as const,
                              enabled: true,
                              status: 'active',
                              credentials: {
                                    authKey: await encrypt(response.authKey, getEncryptionKey()!),
                                    email: email,
                                    password: await encrypt(password, getEncryptionKey()!),
                              },
                              lastSync: Date.now(),
                              lastKnownAddonCount: normalizedAddons.length,
                              capabilities: ['addons'],
                              consecutiveFailures: 0,
                        }],
                        primaryConnectionId: stremioConnectionId,
                  }

                  const releaseMembership = await acquireSyncMutex(ACCOUNT_MEMBERSHIP_MUTEX)
                  try {
                        ownership.assert()
                        const accounts = [...get().accounts, account]
                        set({ accounts })
                        persistAccounts(accounts)
                  } finally { releaseMembership() }
                  await upsertAuthKeyHash(account.id, response.authKey)

                  const { useLibraryCache } = await import('@/store/libraryCache')
                  useLibraryCache.setState({ isStale: true })

                  triggerSync()
                  trace('account', 'add.success', { accountId: account.id, method: 'credentials', intent, addonCount: normalizedAddons.length, timing: Date.now() - start })
            } catch (error) {
                  const message = error instanceof Error ? error.message : 'Failed to add account'
                  set({ error: message })
                  trace('account', 'add.error', { method: 'credentials', intent, error: message, timing: Date.now() - start })
                  throw error
            } finally {
                  set({ loadingAccounts: new Set([...get().loadingAccounts].filter(id => id !== opId)) })
                  _registrationInProgress = false
             }
        },

      addLocalAccount: async (name: string, accentColor?: string, emoji?: string, avatar?: string) => {
            const ownership = captureSyncOwnership()
            const opId = '__add_account__'
            set({ loadingAccounts: new Set([...get().loadingAccounts, opId]), error: null })
            trace('account', 'add.start', { method: 'local' })
            const start = Date.now()
            try {
                  const account: Account = {
                        id: safeUUID(),
                        name: name.trim() || 'Local Account',
                        authKey: '',
                        addons: [],
                        lastSync: new Date(),
                        status: 'active',
                        accentColor,
                        emoji,
                        avatar,
                        profiles: [],
                        apiKey: safeUUID(),
                        createdAt: Date.now(),
                  }
                  const releaseMembership = await acquireSyncMutex(ACCOUNT_MEMBERSHIP_MUTEX)
                  try {
                        ownership.assert()
                        const accounts = [...get().accounts, account]
                        set({ accounts })
                        persistAccounts(accounts)
                  } finally { releaseMembership() }

                  const { useLibraryCache } = await import('@/store/libraryCache')
                  useLibraryCache.setState({ isStale: true })

                  trace('account', 'add.success', { accountId: account.id, method: 'local', timing: Date.now() - start })
                  return account.id
            } catch (error) {
                  set({ error: error instanceof Error ? error.message : 'Failed to create account' })
                  trace('account', 'add.error', { method: 'local', error: error instanceof Error ? error.message : 'unknown', timing: Date.now() - start })
                  throw error
            } finally {
                  set({ loadingAccounts: new Set([...get().loadingAccounts].filter(id => id !== opId)) })
            }
      },

      removeAccount: async (id: string) => {
            const ownership = captureSyncOwnership()
            const releaseMembership = await acquireSyncMutex(ACCOUNT_MEMBERSHIP_MUTEX)
            const releaseMutex = await acquireSyncMutex(id)
            const start = Date.now()
            trace('account', 'remove.start', { accountId: id })
            try {
            ownership.assert()
            const accountsBeforeRemoval = get().accounts.find(a => a.id === id)
            if (!accountsBeforeRemoval) return
            const accounts = get().accounts.filter(acc => acc.id !== id)
            const membership = deleteAccountIds(mergeAccountMembership(get()), [id])
            await persistAccountMembership(accounts, membership, ownership)
            set({ accounts, ...membership })
            removeAuthKeyHash(id)
            triggerSync()
            try {
                  const { useSyncStore } = await import('./syncStore')
                  const { auth, serverUrl } = useSyncStore.getState()
                  if (auth.isAuthenticated) {
                        const baseUrl = serverUrl || ''
                        const apiPath = baseUrl.startsWith('http') ? `${baseUrl.replace(/\/$/, '')}/api` : '/api'
                        const { getSyncPasswordHeader } = await import('@/lib/sync-auth')
                        const syncToken = await getSyncPasswordHeader(auth)
                        ownership.assert()
                        const res = await fetch(`${apiPath}/accounts/${encodeURIComponent(id)}/server-state`, {
                              method: 'DELETE',
                              headers: { 'x-sync-password': syncToken, 'x-sync-user': auth.id }
                        })
                        if (!res.ok) throw new Error(`Server state delete failed (${res.status})`)
                        trace('account', 'server-state.deleted', { accountId: id })
                  }
            } catch (serverStateErr) {
                  ownership.assert()
                  trace('account', 'server-state.pending', { accountId: id, error: serverStateErr instanceof Error ? serverStateErr.message : 'unknown' })
                  const { queuePendingAccountServerCleanup } = await import('@/lib/account-server-cleanup')
                  await queuePendingAccountServerCleanup(id)
            }
            try {
                  const { useFailoverStore } = await import('@/store/failoverStore')
                  ownership.assert()
                  const failoverState = useFailoverStore.getState()
                  const rulesForAccount = failoverState.rules.filter(r => r.accountId === id)

                  if (rulesForAccount.length > 0) {
                        if (import.meta.env.DEV) console.log(`[Account] Cleaning up ${rulesForAccount.length} autopilot rules for account ${id}`)

                        try {
                              const { useSyncStore } = await import('./syncStore')
                              const { auth, serverUrl } = useSyncStore.getState()
                              if (auth.isAuthenticated) {
                                    const baseUrl = serverUrl || ''
                                    const apiPath = baseUrl.startsWith('http') ? `${baseUrl.replace(/\/$/, '')}/api` : '/api'
                                    const { getSyncPasswordHeader } = await import('@/lib/sync-auth')
                                    const syncToken = await getSyncPasswordHeader(auth)
                                    ownership.assert()
                                    await fetch(`${apiPath}/autopilot/account/${id}`, {
                                        method: 'DELETE',
                                        headers: { 'x-sync-password': syncToken, 'x-sync-user': auth.id }
                                    })
                                    if (import.meta.env.DEV) console.log(`[Account] Bulk-deleted server rules for account ${id}`)
                              }
                        } catch (serverErr) {
                              ownership.assert()
                              if (import.meta.env.DEV) console.warn('[Account] Bulk server delete failed, falling back to per-rule delete:', serverErr)
                              // Fallback: delete each rule individually from server (fire-and-forget)
                              for (const rule of rulesForAccount) {
                                    failoverState.removeRule(rule.id).catch(() => { })
                              }
                        }

                        const remainingRules = failoverState.rules.filter(r => r.accountId !== id)
                        ownership.assert()
                        useFailoverStore.setState({ rules: remainingRules })
                        const localforageFO = await import('localforage')
                        ownership.assert()
                        await localforageFO.default.setItem('aioman:failover-rules', remainingRules)
                  }
            } catch (e) {
                  if (import.meta.env.DEV) console.warn('[Account] Autopilot rule cleanup failed (non-blocking):', e)
            }

            try {
                  const account = accountsBeforeRemoval
                  if (account) {
                        const connIds = (account.connections || []).map(c => c.id)
                        if (connIds.length > 0) {
                              const { useSyncStore } = await import('./syncStore')
                              const { auth, serverUrl } = useSyncStore.getState()
                              if (auth.isAuthenticated) {
                                    const baseUrl = serverUrl || ''
                                    const credApiPath = baseUrl.startsWith('http') ? `${baseUrl.replace(/\/$/, '')}/api` : '/api'
                                    const { getSyncPasswordHeader } = await import('@/lib/sync-auth')
                                    const syncToken = await getSyncPasswordHeader(auth)
                                    for (const connId of connIds) {
                                          ownership.assert()
                                          await fetch(`${credApiPath}/providers/connections/${connId}/credentials`, {
                                                method: 'DELETE',
                                                headers: { 'x-sync-password': syncToken, 'x-sync-user': auth.id }
                                          }).catch(() => {})
                                    }
                              }
                        }
                  }
            } catch {}

            const { useLibraryCache } = await import('@/store/libraryCache')
            ownership.assert()
            useLibraryCache.getState().removeItemsForAccount(id)

            const { useAddonStore } = await import('@/store/addonStore')
            ownership.assert()
            await useAddonStore.getState().deleteAccountState(id)

            const { useWatchEventStore } = await import('@/store/watchEventStore')
            ownership.assert()
            const wes = useWatchEventStore.getState()
            await wes.load()
            ownership.assert()
            if (useWatchEventStore.getState().initialized) {
                const loaded = useWatchEventStore.getState().events
                const filtered = loaded.filter(e => e.accountId !== id)
                const { [id]: _, ...restSnapshot } = useWatchEventStore.getState().snapshot
                useWatchEventStore.getState().initialize(filtered, restSnapshot)
            }

            trace('account', 'remove.success', { accountId: id, remainingAccounts: accounts.length, timing: Date.now() - start })
            } finally {
                  releaseMutex()
                  releaseMembership()
            }
      },

      syncAccount: async (id: string, forceRefresh: boolean = false, intent?: import('./account/accountSync').SyncIntent) => {
            const { syncAccount } = await import('./account/accountSync')
            return syncAccount(id, forceRefresh, intent)
      },

      syncAllAccounts: async (silent: boolean = false) => {
            const { syncAllAccounts } = await import('./account/accountSync')
            return syncAllAccounts(silent)
      },

      repairAccount: async (id: string) => {
            const { repairAccount } = await import('./account/accountSync')
            return repairAccount(id)
      },

      installAddonToAccount: async (accountId: string, addonUrl: string, savedMetadata?: import('@/types/addon').AddonDescriptor['metadata']) => {
            const { installAddonToAccount } = await import('./account/accountAddonOps')
            return installAddonToAccount(accountId, addonUrl, savedMetadata)
      },

      installAddonsToAccount: async (accountId: string, addonUrls: string[], concurrency?: number) => {
            const { installAddonsToAccount } = await import('./account/accountAddonOps')
            return installAddonsToAccount(accountId, addonUrls, concurrency)
      },

      removeAddonFromAccount: async (accountId: string, transportUrl: string) => {
            const { removeAddonFromAccount } = await import('./account/accountAddonOps')
            return removeAddonFromAccount(accountId, transportUrl)
      },

      removeAddonByIndexFromAccount: async (accountId: string, index: number) => {
            const { removeAddonByIndexFromAccount } = await import('./account/accountAddonOps')
            return removeAddonByIndexFromAccount(accountId, index)
      },

      bulkDeleteAddons: async (accountId: string, keptAddons: AddonDescriptor[], removedUrls: string[]) => {
            const { bulkDeleteAddons } = await import('./account/accountAddonOps')
            return bulkDeleteAddons(accountId, keptAddons, removedUrls)
      },
      reorderAddons: async (accountId: string, newOrder: AddonDescriptor[], options?: { explicitInstallUrls?: string[] }) => {
            const { reorderAddons } = await import('./account/accountAddonOps')
            return reorderAddons(accountId, newOrder, options)
      },

      exportAccounts: async (includeCredentials: boolean) => {
            const { exportAccounts } = await import('./account/accountImportExport')
            return exportAccounts(includeCredentials)
      },

      exportAccountsForSync: async () => {
            const { exportAccountsForSync } = await import('./account/accountImportExport')
            return exportAccountsForSync()
      },

      importAccounts: async (json: string | Record<string, unknown>, isSilent?: boolean, mode?: 'merge' | 'mirror', localDecryptionKey?: CryptoKey | null, ownership?: SyncOwnership, accountList?: AccountListImport) => {
            const { importAccounts } = await import('./account/accountImportExport')
            return importAccounts(json, isSilent, mode, localDecryptionKey, ownership, accountList)
      },

      updateAccount: async (id: string, data: { name?: string; authKey?: string; email?: string; password?: string; accentColor?: string; emoji?: string; avatar?: string; note?: string; hideLastWatched?: boolean; hideAddonPreview?: boolean; hidePlatformLogos?: boolean }) => {
            // The re-auth branch awaits (login + getAddons) then writes a snapshot taken before the
            // await, which would clobber any addon op that landed meanwhile. Hold the per-account
            // mutex so this serializes with addon writes instead of racing them.
            const releaseMutex = await acquireSyncMutex(id)
            set({ loadingAccounts: new Set([...get().loadingAccounts, id]), error: null })
            const start = Date.now()
            trace('account', 'update.start', { accountId: id })
            try {
                  const account = getAccountById(get().accounts, id)
                  if (!account) throw new Error('Account not found')

                  const updatedAccount: Account = {
                        ...account,
                        name: data.name ?? account.name,
                        // Present-but-undefined means cleared (Remove photo, color Off); only an absent key keeps the old value.
                        accentColor: 'accentColor' in data ? data.accentColor : account.accentColor,
                        emoji: 'emoji' in data ? data.emoji : account.emoji,
                        avatar: 'avatar' in data ? data.avatar : account.avatar,
                        note: data.note ?? (account.note ?? undefined),
                        hideLastWatched: data.hideLastWatched ?? (account.hideLastWatched ?? false),
                        hideAddonPreview: data.hideAddonPreview ?? (account.hideAddonPreview ?? false),
                        hidePlatformLogos: data.hidePlatformLogos ?? (account.hidePlatformLogos ?? false),
                  }
                  if (data.authKey || (data.email && data.password)) {
                        const encryptionKey = getEncryptionKey()
                        let authKey: string
                        if (data.authKey) {
                              authKey = data.authKey.trim()
                              if (!authKey) throw new Error('Auth key cannot be empty')
                              updatedAccount.password = undefined
                        } else {
                              const response = await loginWithCredentials(data.email!, data.password!)
                              authKey = response.authKey
                              updatedAccount.email = response.user?.email || data.email
                              updatedAccount.password = await encrypt(data.password!, encryptionKey)
                        }

                        authKeyCache.delete(getStremioAuthKey(account))
                        const encryptedNewKey = await encrypt(authKey, encryptionKey)
                        updatedAccount.authKey = encryptedNewKey
                        // Rotating the account login updates the CANONICAL Stremio
                        // connection; secondary logins keep their own sealed keys.
                        updatedAccount.connections = scopeStremioKeyRotation(updatedAccount.connections, updatedAccount.primaryConnectionId, encryptedNewKey)
                        authKeyCache.set(getStremioAuthKey(updatedAccount), authKey)
                        await upsertAuthKeyHash(updatedAccount.id, authKey)
                        const addons = await getAddons(authKey, updatedAccount.id)
                        // Re-authentication refreshes credentials, so a stale platform
                        // snapshot must pass the same additive merge as a passive sync.
                        const { mergeRemoteIntoHub } = await import('./account/accountSync')
                        const deletionState = mergeAddonDeletionState(account.deletedAddons, undefined, account.restoredAddons, undefined)
                        updatedAccount.addons = mergeRemoteIntoHub({ ...account, ...deletionState }, addons)
                        Object.assign(updatedAccount, deletionState)
                        updatedAccount.profiles = updatedAccount.profiles?.map(profile =>
                              profile.id === (updatedAccount.activeProfileId || 'default')
                                    ? { ...profile, addons: structuredClone(updatedAccount.addons) }
                                    : profile
                        )
                        updatedAccount.lastSync = new Date()
                        updatedAccount.status = 'active'
                  }

                  const accounts = get().accounts.map((acc) => (acc.id === id ? updatedAccount : acc))
                  set({ accounts })
                  persistAccounts(accounts)

                  triggerSync()
                  if (data.authKey && !updatedAccount.password) {
                        scheduleSessionBoundAuthCheck(updatedAccount.id)
                  }
                  trace('account', 'update.success', { accountId: id, reauthed: !!(data.authKey || (data.email && data.password)), timing: Date.now() - start })
            } catch (error) {
                  set({ error: (error as Error).message })
                  trace('account', 'update.error', { accountId: id, error: (error as Error).message, timing: Date.now() - start })
                  throw error
            } finally {
                  set({ loadingAccounts: new Set([...get().loadingAccounts].filter(x => x !== id)) })
                  releaseMutex()
            }
      },

      updateAccountNote: async (accountId: string, note: string) => {
            // Serialize with addon ops: without the mutex, an addon op that snapshotted this account
            // before its await would clobber this note on resume.
            const releaseMutex = await acquireSyncMutex(accountId)
            try {
                  const accounts = get().accounts.map(acc =>
                        acc.id === accountId ? { ...acc, note: note.trim() || undefined } : acc
                  )
                  set({ accounts })
                  persistAccounts(accounts)
                  triggerSync()
            } finally {
                  releaseMutex()
            }
      },

      toggleAddonProtection: async (accountId: string, transportUrl: string, isProtected: boolean, targetIndex?: number) => {
            const { toggleAddonProtection } = await import('./account/accountAddonOps')
            return toggleAddonProtection(accountId, transportUrl, isProtected, targetIndex)
      },

      toggleAddonEnabled: async (accountId: string, transportUrl: string, isEnabled: boolean, silent?: boolean, targetIndex?: number, isAutopilot?: boolean) => {
            const { toggleAddonEnabled } = await import('./account/accountAddonOps')
            return toggleAddonEnabled(accountId, transportUrl, isEnabled, silent, targetIndex, isAutopilot)
      },

      bulkToggleAddonEnabled: async (accountId: string, addonUrls: string[], isEnabled: boolean) => {
            const { bulkToggleAddonEnabled } = await import('./account/accountAddonOps')
            return bulkToggleAddonEnabled(accountId, addonUrls, isEnabled)
      },

      reinstallAddon: async (accountId: string, transportUrl: string) => {
            const { reinstallAddon } = await import('./account/accountAddonOps')
            return reinstallAddon(accountId, transportUrl)
      },

      reinstallAddons: async (accountId: string, transportUrls: string[], concurrency?: number, onProgress?: (current: number, total: number) => void) => {
            const { reinstallAddons } = await import('./account/accountAddonOps')
            return reinstallAddons(accountId, transportUrls, concurrency, onProgress)
      },

      updateAddonSettings: async (
            accountId: string,
            transportUrl: string,
            settings: {
                  metadata?: { customName?: string; customLogo?: string; customDescription?: string; syncToLibrary?: boolean; hideConfigure?: boolean },
                  catalogOverrides?: AddonDescriptor['catalogOverrides'],
                  note?: string,
                  destinations?: AddonDescriptor['destinations'] | null,
            },
            targetIndex?: number
      ) => {
            const { updateAddonSettings } = await import('./account/accountAddonOps')
            return updateAddonSettings(accountId, transportUrl, settings, targetIndex)
      },

      bulkProtectAddons: async (accountId: string, isProtected: boolean) => {
            const { bulkProtectAddons } = await import('./account/accountAddonOps')
            return bulkProtectAddons(accountId, isProtected)
      },

      bulkProtectSelectedAddons: async (accountId: string, transportUrls: string[], isProtected: boolean) => {
            const { bulkProtectSelectedAddons } = await import('./account/accountAddonOps')
            return bulkProtectSelectedAddons(accountId, transportUrls, isProtected)
      },

      bulkSetHideConfigure: async (accountId: string, hideConfigure: boolean) => {
            const { bulkSetHideConfigure } = await import('./account/accountAddonOps')
            return bulkSetHideConfigure(accountId, hideConfigure)
      },

      bulkSetHideConfigureSelected: async (accountId: string, transportUrls: string[], hideConfigure: boolean) => {
            const { bulkSetHideConfigureSelected } = await import('./account/accountAddonOps')
            return bulkSetHideConfigureSelected(accountId, transportUrls, hideConfigure)
      },

      removeLocalAddons: async (accountId: string, transportUrls: string[]) => {
            const { removeLocalAddons } = await import('./account/accountAddonOps')
            return removeLocalAddons(accountId, transportUrls)
      },

      replaceTransportUrl: async (oldUrl: string, newUrl: string, accountId?: string, freshManifest?: AddonDescriptor['manifest'], metadata?: ReplaceMetadata) => {
            const { replaceTransportUrl } = await import('./account/accountAddonOps')
            return replaceTransportUrl(oldUrl, newUrl, accountId, freshManifest, metadata)
      },

      moveAccount: async (id: string, direction: 'up' | 'down') => {
            const accounts = [...get().accounts]
            const idx = accounts.findIndex((a) => a.id === id)
            if (idx === -1) return
            if (direction === 'up' && idx > 0)
                  [accounts[idx], accounts[idx - 1]] = [accounts[idx - 1], accounts[idx]]
            else if (direction === 'down' && idx < accounts.length - 1)
                  [accounts[idx], accounts[idx + 1]] = [accounts[idx + 1], accounts[idx]]
            set({ accounts })
            persistAccounts(accounts)
            triggerSync()
      },

      reorderAccounts: async (newOrder: string[]) => {
            const accounts = newOrder
                  .map((id) => getAccountById(get().accounts, id))
                  .filter(Boolean) as Account[]
            set({ accounts })
            persistAccounts(accounts)
            triggerSync()
      },

      clearError: () => set({ error: null }),
      reset: async () => {
            set({
                  accounts: [],
                  deletedAccounts: {},
                  restoredAccounts: {},
                  loadingAccounts: new Set<string>(),
                  error: null,
                  changelog: [],
                  hydrated: false,
            })
            resetAuthKeyHashes()
            await localforage.removeItem(STORAGE_KEY)
            // Keep deletion markers with the recovery backup; a full workspace wipe
            // clears both. Resetting memory must not revive removed backup rows.
            await localforage.removeItem(CHANGELOG_KEY)
      },

      wipeAccounts: async () => {
            const ownership = captureSyncOwnership()
            const releaseMembership = await acquireSyncMutex(ACCOUNT_MEMBERSHIP_MUTEX)
            try {
                  ownership.assert()
                  const ids = get().accounts.map(a => a.id)
                  const membership = deleteAccountIds(mergeAccountMembership(get()), ids)
                  await persistAccountMembership([], membership, ownership)
                  ownership.assert()
                  await localforage.removeItem(BACKUP_KEY)
                  ownership.assert()
                  await localforage.setItem(CHANGELOG_KEY, [])
                  ownership.assert()
                  set({ accounts: [], ...membership, loadingAccounts: new Set<string>(), error: null, changelog: [] })
                  resetAuthKeyHashes()
                  triggerSync()
            } finally {
                  releaseMembership()
            }
      },

      addChangelogEntry: async (entry) => {
            const newEntry: AddonChangelogEntry = {
                  ...entry,
                  id: safeUUID(),
                  timestamp: new Date().toISOString()
            }

            set(state => {
                  const newChangelog = [newEntry, ...state.changelog].slice(0, 100)
                  localforage.setItem(CHANGELOG_KEY, newChangelog).catch(e => { if (import.meta.env.DEV) console.error(e) })
                  return { changelog: newChangelog }
            })
      },

      clearChangelog: async (accountId?: string, maxAgeMs?: number) => {
            const cutoff = maxAgeMs ? Date.now() - maxAgeMs : null
            let nextChangelog = get().changelog
            if (accountId) {
                  nextChangelog = nextChangelog.filter((entry) => entry.accountId !== accountId)
            }
            if (cutoff) {
                  nextChangelog = nextChangelog.filter((entry) => new Date(entry.timestamp).getTime() > cutoff)
            } else if (!accountId) {
                  nextChangelog = []
            }
            set({ changelog: nextChangelog })
            await localforage.setItem(CHANGELOG_KEY, nextChangelog)
            triggerSync()
      },

      createSubProfile: async (accountId: string, name: string, cloneFromCurrent?: boolean) => {
            const { createSubProfile } = await import('./account/accountProfile')
            return createSubProfile(accountId, name, cloneFromCurrent)
      },

      deleteSubProfile: async (accountId: string, profileId: string) => {
            const { deleteSubProfile } = await import('./account/accountProfile')
            return deleteSubProfile(accountId, profileId)
      },

      renameSubProfile: async (accountId: string, profileId: string, newName: string) => {
            const { renameSubProfile } = await import('./account/accountProfile')
            return renameSubProfile(accountId, profileId, newName)
      },

      switchProfile: async (accountId: string, targetProfileId: string) => {
            const { switchProfile } = await import('./account/accountProfile')
            return switchProfile(accountId, targetProfileId)
      }
}))

// One-time heal per valid session: shrink stored oversized avatar data URIs. The shrink
// runs in the avatar GIF worker (never the main thread) and is armed only once an
// authenticated, unlocked session has completed its initial sync; local hydration
// before login never arms it (Sol P1-AVATAR-01). Before every await and every write
// the session gates are re-checked (authenticated, vault unlocked, no re-auth needed,
// accounts-hydration marker still set, same session id and sync-ownership
// generation); a cancelled run releases the
// latch so the next valid session can heal, while a completed run holds it for the app
// load. The routine is deterministic, so two devices healing the same picture converge
// on sync. Only the exact oversized avatar string is replaced; https links and other
// fields are never touched, and a second pass is a no-op.
const avatarHealState = { latched: false }

export function avatarHealSessionReady(gates: {
    authenticated: boolean
    locked: boolean
    needsReauth: boolean
    initialSyncCompleted: boolean
    hydrationComplete: boolean
}): boolean {
    return gates.hydrationComplete && gates.authenticated && !gates.locked && !gates.needsReauth && gates.initialSyncCompleted
}

let avatarHealWatch: (() => void) | null = null

// Arm the heal from the first valid session onward: watch the sync store and schedule
// once the gates turn green. Subscribed for the app lifetime; the latch keeps a
// completed heal from ever repeating, and a cancelled run re-arms on the next valid
// session transition.
async function armAvatarHealAfterSession(): Promise<void> {
    if (avatarHealWatch) return
    const [{ useSyncStore }, { isAccountsHydrationComplete }] = await Promise.all([
        import('./syncStore'),
        import('./sync-store-helpers'),
    ])
    if (avatarHealWatch) return
    const arm = () => {
        if (avatarHealState.latched) return
        const sync = useSyncStore.getState()
        if (avatarHealSessionReady({
            authenticated: sync.auth.isAuthenticated,
            locked: useAuthStore.getState().isLocked,
            needsReauth: sync.needsReauth,
            initialSyncCompleted: sync.isInitialSyncCompleted,
            hydrationComplete: isAccountsHydrationComplete(),
        })) scheduleAvatarHeal()
    }
    avatarHealWatch = useSyncStore.subscribe(arm)
    arm()
}

function scheduleAvatarHeal(): void {
    const ric = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback
    if (typeof ric === 'function') ric(() => { void healOversizedAvatars() }, { timeout: 10_000 })
    else setTimeout(() => { void healOversizedAvatars() }, 3_000)
}

async function healOversizedAvatars(): Promise<void> {
    if (avatarHealState.latched) return
    avatarHealState.latched = true
    const cancel = () => { avatarHealState.latched = false }
    try {
        // auth.id is the stable account id: a same-account sign-out/sign-in restores
        // it, so it cannot identify a session. The sync ownership generation is
        // bumped by logout and never rewinds; capture it before any await.
        const ownership = captureSyncOwnership()
        // The session id arrives with the first import; until then only the
        // statically importable gate is checkable.
        let gatesCheck: (() => boolean) | null = null
        const cancelled = () => !ownership.current() || (gatesCheck ? gatesCheck() : useAuthStore.getState().isLocked)
        if (cancelled()) return cancel()
        const [{ isAccountsHydrationComplete }, { useSyncStore }] = await Promise.all([
            import('./sync-store-helpers'),
            import('./syncStore'),
        ])
        const session = useSyncStore.getState().auth.id
        gatesCheck = () => {
            const sync = useSyncStore.getState()
            return sync.auth.id !== session || !avatarHealSessionReady({
                authenticated: sync.auth.isAuthenticated,
                locked: useAuthStore.getState().isLocked,
                needsReauth: sync.needsReauth,
                initialSyncCompleted: sync.isInitialSyncCompleted,
                hydrationComplete: isAccountsHydrationComplete(),
            })
        }
        if (cancelled()) return cancel()
        // Never overlap a running sync: wait for the sync engine to settle (bounded).
        for (let attempt = 0; ; attempt++) {
            if (cancelled()) return cancel()
            if (!useSyncStore.getState().isSyncing) break
            if (attempt >= 30) return cancel()
            await new Promise(resolve => setTimeout(resolve, 2_000))
        }
        if (cancelled()) return cancel()
        const [{ healAccountAvatars }, { shrinkAvatarDataUrlOffMain }] = await Promise.all([
            import('@/lib/avatar-heal'),
            import('@/lib/avatar-gif-worker-client'),
        ])
        if (cancelled()) return cancel()
        const result = await healAccountAvatars(useAccountStore.getState().accounts, shrinkAvatarDataUrlOffMain, cancelled)
        if (result.cancelled || cancelled()) return cancel()
        for (const heal of result.heals) {
            if (cancelled()) return cancel()
            const releaseMutex = await acquireSyncMutex(heal.id)
            try {
                if (cancelled()) return cancel()
                const workspace = getActiveWorkspaceId()
                const accounts = useAccountStore.getState().accounts.map(acc =>
                    acc.id === heal.id && acc.avatar === heal.from ? { ...acc, avatar: heal.to } : acc)
                useAccountStore.setState({ accounts })
                // The 300 ms delayed write stays fenced to this exact session
                // and workspace (Sol P1-AVATAR-01 recheck).
                persistAccounts(accounts, { current: () => getActiveWorkspaceId() === workspace && !cancelled() })
                trace('account', 'avatar.healed', { accountId: heal.id })
            } finally {
                releaseMutex()
            }
        }
        if (result.heals.length > 0) triggerSync()
    } catch (e) {
        cancel()
        if (import.meta.env.DEV) console.warn('[AccountStore] Avatar heal failed:', e)
    }
}
