import { triggerSync } from '@/lib/sync-trigger'
import {
      getAddons,
} from '@/api/addons'
import { normalizeAddonUrl, ACCOUNT_COLORS, hasFallbackAddonIdentity } from '@/lib/utils'
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
import localforage from 'localforage'
import { trace } from '@/lib/trace'

import { create } from 'zustand'

export const STORAGE_KEY = 'aioman:accounts'
export const CHANGELOG_KEY = 'aioman:changelog'
export const BACKUP_KEY = 'aioman:accounts:backup'

export const safeUUID = () => {
    try { return crypto.randomUUID() } catch {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = crypto.getRandomValues(new Uint8Array(1))[0] % 16
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16)
        })
    }
}

let _persistTimer: ReturnType<typeof setTimeout> | null = null

export const persistAccounts = (accounts: Account[]) => {
    if (_persistTimer) clearTimeout(_persistTimer)
    _persistTimer = setTimeout(async () => {
        _persistTimer = null
        try { await localforage.setItem(STORAGE_KEY, accounts) } catch (e) { if (import.meta.env.DEV) console.error('[persistAccounts] Failed to save accounts:', e) }
    }, 300)
}

if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', () => {
        if (_persistTimer) {
            clearTimeout(_persistTimer)
            _persistTimer = null
            const { accounts } = useAccountStore.getState()
            localforage.setItem(STORAGE_KEY, accounts).catch((e) => { if (import.meta.env.DEV) console.error('[accountStore] beforeunload persist failed:', e) })
        }
    })
}

export const syncMutexes = new Map<string, Promise<void>>()

export const acquireSyncMutex = async (accountId: string): Promise<() => void> => {
    while (syncMutexes.has(accountId)) {
        await syncMutexes.get(accountId)
    }
    let resolveMutex!: () => void
    syncMutexes.set(accountId, new Promise<void>((r) => { resolveMutex = r }))
    return () => {
        resolveMutex()
        syncMutexes.delete(accountId)
    }
}

export const getAccountById = (accounts: Account[], id: string): Account | undefined =>
  accounts.find(a => a.id === id)

import { getStremioConnection, getStremioAuthKey, getAccountEmail } from '@/lib/account-compat'
export { getStremioConnection, getStremioAuthKey, getAccountEmail }

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

      const updatedConnections = (account.connections || []).map(c =>
            c.platform === 'stremio'
                  ? { ...c, credentials: { ...c.credentials, authKey: encryptedAuthKey } }
                  : c
      )
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

export const clearAccountsLoading = (accountIds: string[]) => {
  const store = useAccountStore.getState()
  const toRemove = new Set(accountIds)
  useAccountStore.setState({ loadingAccounts: new Set([...store.loadingAccounts].filter(id => !toRemove.has(id))) })
}

export const clearAllAccountLoading = () => {
  useAccountStore.setState({ loadingAccounts: new Set<string>() })
}

export interface ReplaceTransportUrlResult {
      updatedAccountIds: string[]
      failedAccounts: string[]
}

export interface AccountStore {
      accounts: Account[]
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
      syncAccount: (id: string, forceRefresh?: boolean) => Promise<void>
      syncAllAccounts: (silent?: boolean) => Promise<void>
      repairAccount: (id: string) => Promise<void>
      installAddonToAccount: (accountId: string, addonUrl: string, savedMetadata?: import('@/types/addon').AddonDescriptor['metadata']) => Promise<void>
      installAddonsToAccount: (accountId: string, addonUrls: string[], concurrency?: number) => Promise<{ successCount: number; failCount: number }>
      removeAddonFromAccount: (accountId: string, transportUrl: string) => Promise<void>
      removeAddonByIndexFromAccount: (accountId: string, index: number) => Promise<void>
      reorderAddons: (accountId: string, newOrder: AddonDescriptor[]) => Promise<void>
      bulkDeleteAddons: (accountId: string, keptAddons: AddonDescriptor[], removedUrls: string[]) => Promise<void>
      exportAccounts: (includeCredentials: boolean) => Promise<string>
      exportAccountsForSync: () => Promise<Record<string, unknown>>
      importAccounts: (json: string, isSilent?: boolean, mode?: 'merge' | 'mirror', localDecryptionKey?: CryptoKey | null) => Promise<void>
      updateAccount: (
            id: string,
            data: { name: string; authKey?: string; email?: string; password?: string; accentColor?: string; emoji?: string; avatar?: string; note?: string; hideLastWatched?: boolean; hideAddonPreview?: boolean; hidePlatformLogos?: boolean }
      ) => Promise<void>
      updateAccountNote: (accountId: string, note: string) => Promise<void>
      toggleAddonProtection: (
            accountId: string,
            transportUrl: string,
            isProtected: boolean,
            targetIndex?: number
      ) => Promise<void>
      setAddonPlatformExclusions: (
            accountId: string,
            transportUrl: string,
            platforms: string[],
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
      replaceTransportUrl: (oldUrl: string, newUrl: string, accountId?: string, freshManifest?: AddonDescriptor['manifest'], metadata?: AddonDescriptor['metadata']) => Promise<ReplaceTransportUrlResult>
      reinstallAddon: (accountId: string, transportUrl: string) => Promise<void>
      reinstallAddons: (accountId: string, transportUrls: string[], concurrency?: number, onProgress?: (current: number, total: number) => void) => Promise<{ successCount: number; failCount: number }>
      syncAutopilotRules: (accountId: string) => Promise<void>
      clearError: () => void
      reset: () => Promise<void>
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
            try {
                  let storedAccounts = await localforage.getItem<Account[]>(STORAGE_KEY)
                  const storedChangelog = await localforage.getItem<AddonChangelogEntry[]>(CHANGELOG_KEY)

                  // This catches the case where a corrupted re-login wiped accounts between sessions.
                  if (!storedAccounts || !Array.isArray(storedAccounts)) {
                        const backup = await localforage.getItem<Account[]>(BACKUP_KEY)
                        if (backup && Array.isArray(backup) && backup.length > 0) {
                              if (import.meta.env.DEV) console.warn(`[AccountStore] Accounts missing on disk. Restoring ${backup.length} accounts from backup.`)
                              storedAccounts = backup
                              await localforage.setItem(STORAGE_KEY, backup)
                        }
                  }

                  if (storedAccounts && Array.isArray(storedAccounts)) {
                        const accounts = storedAccounts.map((acc) => ({
                              ...acc,
                              lastSync: new Date(acc.lastSync),
                        }))

                        // One-time migration: colorIndex -> accentColor
                        let didHubMigrate = false
                        let migratedAccounts = accounts.map(acc => {
                              const connections = acc.connections || []
                              const needsHubMigration = acc.authKey && acc.authKey.length > 60 && connections.length === 0
                              let migrated = {
                                    ...acc,
                                    profiles: acc.profiles ?? [],
                                    apiKey: acc.apiKey || safeUUID(),
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

                        set({ accounts: migratedAccounts })
                        if (didHubMigrate) {
                            persistAccounts(migratedAccounts)
                            triggerSync()
                        }
                  }

                  if (storedChangelog && Array.isArray(storedChangelog)) {
                        set({ changelog: storedChangelog })
                  }
                  set({ hydrated: true })
            } catch (error) {
                  if (import.meta.env.DEV) console.error('Failed to load accounts from storage:', error)
                  set({ error: 'Failed to load saved accounts' })
            }
      },

      updateLatestVersions: (versions: Record<string, string>) => {
            updateLatestVersionsCoordinator(versions)
      },

      addAccountByAuthKey: async (authKey: string, name: string, accentColor?: string, emoji?: string, avatar?: string) => {
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

                  const accounts = [...get().accounts, account]
                  set({ accounts })
                  persistAccounts(accounts)
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

                  const accounts = [...get().accounts, account]
                  set({ accounts })
                  persistAccounts(accounts)
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
                  const accounts = [...get().accounts, account]
                  set({ accounts })
                  persistAccounts(accounts)

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
            const releaseMutex = await acquireSyncMutex(id)
            const start = Date.now()
            trace('account', 'remove.start', { accountId: id })
            try {
            try {
                  const { useFailoverStore } = await import('@/store/failoverStore')
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
                                    const { deriveSyncToken } = await import('@/lib/crypto')
                                    const syncToken = await deriveSyncToken(auth.password)
                                    await fetch(`${apiPath}/autopilot/account/${id}`, {
                                        method: 'DELETE',
                                        headers: { 'x-sync-password': syncToken, 'x-sync-user': auth.id }
                                    })
                                    if (import.meta.env.DEV) console.log(`[Account] Bulk-deleted server rules for account ${id}`)
                              }
                        } catch (serverErr) {
                              if (import.meta.env.DEV) console.warn('[Account] Bulk server delete failed, falling back to per-rule delete:', serverErr)
                              // Fallback: delete each rule individually from server (fire-and-forget)
                              for (const rule of rulesForAccount) {
                                    failoverState.removeRule(rule.id).catch(() => { })
                              }
                        }

                        const remainingRules = failoverState.rules.filter(r => r.accountId !== id)
                        useFailoverStore.setState({ rules: remainingRules })
                        const localforageFO = await import('localforage')
                        await localforageFO.default.setItem('aioman:failover-rules', remainingRules)
                  }
            } catch (e) {
                  if (import.meta.env.DEV) console.warn('[Account] Autopilot rule cleanup failed (non-blocking):', e)
            }

            try {
                  const account = get().accounts.find(a => a.id === id)
                  if (account) {
                        const connIds = (account.connections || []).map(c => c.id)
                        if (connIds.length > 0) {
                              const { useSyncStore } = await import('./syncStore')
                              const { auth, serverUrl } = useSyncStore.getState()
                              if (auth.isAuthenticated) {
                                    const baseUrl = serverUrl || ''
                                    const credApiPath = baseUrl.startsWith('http') ? `${baseUrl.replace(/\/$/, '')}/api` : '/api'
                                    const { deriveSyncToken } = await import('@/lib/crypto')
                                    const syncToken = await deriveSyncToken(auth.password)
                                    for (const connId of connIds) {
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
            useLibraryCache.getState().removeItemsForAccount(id)

            const { useAddonStore } = await import('@/store/addonStore')
            await useAddonStore.getState().deleteAccountState(id)

            const { useWatchEventStore } = await import('@/store/watchEventStore')
            const wes = useWatchEventStore.getState()
            if (wes.initialized) {
                const filtered = wes.events.filter(e => e.accountId !== id)
                const { [id]: _, ...restSnapshot } = wes.snapshot
                wes.initialize(filtered, restSnapshot)
            }

            const accounts = get().accounts.filter((acc) => acc.id !== id)
            set({ accounts })
            persistAccounts(accounts)
            removeAuthKeyHash(id)

            triggerSync()
            trace('account', 'remove.success', { accountId: id, remainingAccounts: accounts.length, timing: Date.now() - start })
            } finally {
                  releaseMutex()
            }
      },

      syncAccount: async (id: string, forceRefresh: boolean = false) => {
            const { syncAccount } = await import('./account/accountSync')
            return syncAccount(id, forceRefresh)
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
      reorderAddons: async (accountId: string, newOrder: AddonDescriptor[]) => {
            const { reorderAddons } = await import('./account/accountAddonOps')
            return reorderAddons(accountId, newOrder)
      },

      exportAccounts: async (includeCredentials: boolean) => {
            const { exportAccounts } = await import('./account/accountImportExport')
            return exportAccounts(includeCredentials)
      },

      exportAccountsForSync: async () => {
            const { exportAccountsForSync } = await import('./account/accountImportExport')
            return exportAccountsForSync()
      },

      importAccounts: async (json: string, isSilent?: boolean, mode?: 'merge' | 'mirror', localDecryptionKey?: CryptoKey | null) => {
            const { importAccounts } = await import('./account/accountImportExport')
            return importAccounts(json, isSilent, mode, localDecryptionKey)
      },

      updateAccount: async (id: string, data: { name: string; authKey?: string; email?: string; password?: string; accentColor?: string; emoji?: string; avatar?: string; note?: string; hideLastWatched?: boolean; hideAddonPreview?: boolean; hidePlatformLogos?: boolean }) => {
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
                        name: data.name,
                        accentColor: data.accentColor,
                        emoji: data.emoji,
                        avatar: 'avatar' in data ? data.avatar : account.avatar,
                        note: data.note || undefined,
                        hideLastWatched: data.hideLastWatched ?? false,
                        hideAddonPreview: data.hideAddonPreview ?? false,
                        hidePlatformLogos: data.hidePlatformLogos ?? false,
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
                        updatedAccount.connections = (updatedAccount.connections || []).map(c =>
                              c.platform === 'stremio'
                                    ? { ...c, credentials: { ...c.credentials, authKey: encryptedNewKey } }
                                    : c
                        )
                        authKeyCache.set(getStremioAuthKey(updatedAccount), authKey)
                        await upsertAuthKeyHash(updatedAccount.id, authKey)
                        const addons = await getAddons(authKey, updatedAccount.id)
                        updatedAccount.addons = addons.map((a) => ({
                              ...a,
                              manifest: sanitizeAddonManifest(a.manifest, a.transportUrl),
                        }))
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

      setAddonPlatformExclusions: async (accountId: string, transportUrl: string, platforms: string[], targetIndex?: number) => {
            const { setAddonPlatformExclusions } = await import('./account/accountAddonOps')
            return setAddonPlatformExclusions(accountId, transportUrl, platforms, targetIndex)
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

      replaceTransportUrl: async (oldUrl: string, newUrl: string, accountId?: string, freshManifest?: AddonDescriptor['manifest'], metadata?: AddonDescriptor['metadata']) => {
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
                  loadingAccounts: new Set<string>(),
                  error: null,
                  changelog: [],
                  hydrated: false,
            })
            resetAuthKeyHashes()
            await localforage.removeItem(STORAGE_KEY)
            await localforage.removeItem(CHANGELOG_KEY)
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
