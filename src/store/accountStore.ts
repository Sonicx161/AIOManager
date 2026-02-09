import {
      installAddon as apiInstallAddon,
      removeAddon as apiRemoveAddon,
      getAddons,
      updateAddons,
} from '@/api/addons'
import { loginWithCredentials } from '@/api/auth'
import { LoginResponse } from '@/api/stremio-client'
import { decrypt, encrypt } from '@/lib/crypto'
import { useAuthStore } from '@/store/authStore'
import { updateLatestVersions as updateLatestVersionsCoordinator } from '@/lib/store-coordinator'
import { toast } from '@/hooks/use-toast'
import { mergeAddons, normalizeAddonUrl } from '@/lib/utils'
import { StremioAccount } from '@/types/account'
import { useProfileStore } from '@/store/profileStore'
import { AddonDescriptor } from '@/types/addon'
import { CinemetaManifest } from '@/types/cinemeta'
import { isCinemetaAddon, detectAllPatches, applyCinemetaConfiguration } from '@/lib/cinemeta-utils'
import { identifyAddon } from '@/lib/addon-identifier'
import localforage from 'localforage'
import { syncManager } from '@/lib/sync/syncManager'
import { autopilotManager } from '@/lib/autopilot/autopilotManager'

import { create } from 'zustand'

const STORAGE_KEY = 'stremio-manager:accounts'

// Manifest Cache to speed up sync baseline recovery
const MANIFEST_CACHE: Record<string, { manifest: AddonDescriptor['manifest']; timestamp: number }> =
      {}
const CACHE_TTL = 30 * 60 * 1000 // 30 minutes

// Helper function to sanitize addon manifests by converting null to undefined
const sanitizeAddonManifest = (manifest: AddonDescriptor['manifest'], transportUrl?: string) => {
      if (!manifest || !manifest.name || manifest.name === 'Unknown Addon') {
            return identifyAddon(transportUrl || '', manifest || undefined)
      }
      return {
            ...manifest,
            types: manifest.types || [],
            logo: manifest.logo ?? undefined,
            background: manifest.background ?? undefined,
            idPrefixes: manifest.idPrefixes ?? undefined,
      }
}

const getEncryptionKey = () => {
      const key = useAuthStore.getState().encryptionKey
      if (!key) {
            throw new Error(
                  'Database is locked. Please ensure your master password is set up or unlock the app.'
            )
      }
      return key
}

interface AccountStore {
      accounts: StremioAccount[]
      loading: boolean
      error: string | null

      // Actions
      initialize: () => Promise<void>
      updateLatestVersions: (versions: Record<string, string>) => void
      addAccountByAuthKey: (authKey: string, name: string) => Promise<void>
      addAccountByCredentials: (email: string, password: string, name: string) => Promise<void>
      removeAccount: (id: string) => Promise<void>
      syncAccount: (id: string, forceRefresh?: boolean) => Promise<void>
      syncAllAccounts: () => Promise<void>
      repairAccount: (id: string) => Promise<void>
      installAddonToAccount: (accountId: string, addonUrl: string) => Promise<void>
      removeAddonFromAccount: (accountId: string, transportUrl: string) => Promise<void>
      removeAddonByIndexFromAccount: (accountId: string, index: number) => Promise<void>
      reorderAddons: (accountId: string, newOrder: AddonDescriptor[]) => Promise<void>
      exportAccounts: (includeCredentials: boolean) => Promise<string>
      importAccounts: (json: string, isSilent?: boolean, mode?: 'merge' | 'mirror') => Promise<void>
      updateAccount: (
            id: string,
            data: { name: string; authKey?: string; email?: string; password?: string }
      ) => Promise<void>
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
      updateAddonMetadata: (
            accountId: string,
            transportUrl: string,
            metadata: { customName?: string; customLogo?: string; customDescription?: string },
            targetIndex?: number
      ) => Promise<void>
      moveAccount: (id: string, direction: 'up' | 'down') => Promise<void>
      reorderAccounts: (newOrder: string[]) => Promise<void>
      bulkProtectAddons: (accountId: string, isProtected: boolean) => Promise<void>
      bulkProtectSelectedAddons: (accountId: string, transportUrls: string[], isProtected: boolean) => Promise<void>
      removeLocalAddons: (accountId: string, transportUrls: string[]) => Promise<void>
      syncAutopilotRules: (accountId: string) => Promise<void>
      clearError: () => void
      reset: () => Promise<void>
}

export const useAccountStore = create<AccountStore>((set, get) => ({
      accounts: [],
      loading: false,
      error: null,

      syncAutopilotRules: async (accountId: string) => {
            try {
                  const { useFailoverStore } = await import('@/store/failoverStore')
                  await useFailoverStore.getState().syncRulesForAccount(accountId)
            } catch (e) {
                  console.warn('[AccountStore] Autopilot sync notification failed:', e)
            }
      },

      initialize: async () => {
            try {
                  const storedAccounts = await localforage.getItem<StremioAccount[]>(STORAGE_KEY)
                  if (storedAccounts && Array.isArray(storedAccounts)) {
                        const accounts = storedAccounts.map((acc) => ({
                              ...acc,
                              lastSync: new Date(acc.lastSync),
                        }))
                        set({ accounts })
                  }
            } catch (error) {
                  console.error('Failed to load accounts from storage:', error)
                  set({ error: 'Failed to load saved accounts' })
            }
      },

      updateLatestVersions: (versions: Record<string, string>) => {
            updateLatestVersionsCoordinator(versions)
      },

      addAccountByAuthKey: async (authKey: string, name: string) => {
            set({ loading: true, error: null })
            try {
                  const addons = await getAddons(authKey, 'New-Login-Check')
                  const normalizedAddons = addons.map((addon) => ({
                        ...addon,
                        manifest: sanitizeAddonManifest(addon.manifest, addon.transportUrl),
                  }))

                  const account: StremioAccount = {
                        id: authKey,
                        name,
                        authKey: await encrypt(authKey, getEncryptionKey()!),
                        addons: normalizedAddons,
                        lastSync: new Date(),
                        status: 'active',
                  }

                  const accounts = [...get().accounts, account]
                  set({ accounts })
                  await localforage.setItem(STORAGE_KEY, accounts)

                  const { useSyncStore } = await import('./syncStore')
                  useSyncStore.getState().syncToRemote(true).catch(console.error)
            } catch (error) {
                  const message = error instanceof Error ? error.message : 'Failed to add account'
                  set({ error: message })
                  throw error
            } finally {
                  set({ loading: false })
            }
      },

      addAccountByCredentials: async (email: string, password: string, name: string) => {
            set({ loading: true, error: null })
            try {
                  let response: LoginResponse
                  try {
                        response = await loginWithCredentials(email, password)
                  } catch (loginError: any) {
                        const isUserNotFound =
                              loginError.code === 'USER_NOT_FOUND' ||
                              (typeof loginError.message === 'string' && loginError.message.includes('USER_NOT_FOUND')) ||
                              (typeof loginError.message === 'string' && loginError.message.includes('User not found')) ||
                              (typeof loginError.code === 'string' && loginError.code.includes('USER_NOT_FOUND'))

                        if (isUserNotFound) {
                              console.log(`[Auth] User not found. Attempting auto-registration for: ${email}`)
                              const { registerAccount } = await import('@/api/auth')
                              response = await registerAccount(email, password)
                              toast({
                                    title: 'Stremio Account Created',
                                    description: `Successfully registered ${email} on Stremio.`,
                              })
                        } else {
                              throw loginError
                        }
                  }

                  const addons = await getAddons(response.authKey, 'New-Login-Check')
                  const normalizedAddons = addons.map((addon) => ({
                        ...addon,
                        manifest: sanitizeAddonManifest(addon.manifest, addon.transportUrl),
                  }))

                  const account: StremioAccount = {
                        id: crypto.randomUUID(),
                        name: name || email,
                        email,
                        authKey: await encrypt(response.authKey, getEncryptionKey()!),
                        password: await encrypt(password, getEncryptionKey()!),
                        addons: normalizedAddons,
                        lastSync: new Date(),
                        status: 'active',
                  }

                  const accounts = [...get().accounts, account]
                  set({ accounts })
                  await localforage.setItem(STORAGE_KEY, accounts)

                  const { useSyncStore } = await import('./syncStore')
                  useSyncStore.getState().syncToRemote(true).catch(console.error)
            } catch (error) {
                  const message = error instanceof Error ? error.message : 'Failed to add account'
                  set({ error: message })
                  throw error
            } finally {
                  set({ loading: false })
            }
      },

      removeAccount: async (id: string) => {
            const { useActivityStore } = await import('@/store/activityStore')
            await useActivityStore.getState().deleteActivityForAccount(id)

            const { useAddonStore } = await import('@/store/addonStore')
            await useAddonStore.getState().deleteAccountState(id)

            const accounts = get().accounts.filter((acc) => acc.id !== id)
            set({ accounts })
            await localforage.setItem(STORAGE_KEY, accounts)

            const { useSyncStore } = await import('./syncStore')
            useSyncStore.getState().syncToRemote(true).catch(console.error)
      },

      syncAccount: async (id: string, forceRefresh: boolean = false) => {
            set({ loading: true, error: null })
            try {
                  const account = get().accounts.find((acc) => acc.id === id)
                  if (!account) throw new Error('Account not found')

                  const authKey = await decrypt(account.authKey, getEncryptionKey())
                  const addons = await getAddons(authKey, account.id)

                  const normalizedAddons = addons
                        .filter(a => !syncManager.isPendingRemoval(account.id, a.transportUrl))
                        .map((addon) => ({
                              ...addon,
                              manifest: sanitizeAddonManifest(addon.manifest, addon.transportUrl),
                        }))

                  const mergedAddons = mergeAddons(account.addons, normalizedAddons)

                  set({ loading: true })
                  const { stremioClient } = await import('@/api/stremio-client')

                  const repairedAddons = await Promise.all(
                        mergedAddons.map(async (addon) => {
                              try {
                                    const now = Date.now()

                                    const v = (addon.manifest?.version || '').replace(/^v/, '')
                                    const isBroken = !addon.manifest?.name ||
                                          addon.manifest.name === 'Unknown Addon' ||
                                          v === '0.0.0' ||
                                          v === '' ||
                                          !addon.manifest.resources ||
                                          addon.manifest.resources.length === 0

                                    if (!forceRefresh && addon.manifest && addon.manifest.id && !isBroken) {
                                          return addon
                                    }

                                    let cinemetaPatches = null
                                    if (isCinemetaAddon(addon)) {
                                          cinemetaPatches = detectAllPatches(addon.manifest as CinemetaManifest)
                                    }

                                    let manifestRaw = null
                                    const cached = MANIFEST_CACHE[addon.transportUrl]
                                    if (cached && now - cached.timestamp < CACHE_TTL) {
                                          manifestRaw = cached.manifest
                                    } else {
                                          const { manifest } = await stremioClient.fetchAddonManifest(
                                                addon.transportUrl,
                                                account.id
                                          )
                                          manifestRaw = manifest
                                          MANIFEST_CACHE[addon.transportUrl] = { manifest: manifestRaw, timestamp: now }
                                    }

                                    let repairedManifest = sanitizeAddonManifest(manifestRaw, addon.transportUrl)

                                    if (cinemetaPatches) {
                                          repairedManifest = applyCinemetaConfiguration(repairedManifest as CinemetaManifest, {
                                                removeSearchArtifacts: cinemetaPatches.searchArtifactsPatched,
                                                removeStandardCatalogs: cinemetaPatches.standardCatalogsPatched,
                                                removeMetaResource: cinemetaPatches.metaResourcePatched,
                                          }) as AddonDescriptor['manifest']
                                    }

                                    return { ...addon, manifest: repairedManifest }
                              } catch (e) {
                                    console.warn(`[Sync] Failed to baseline ${addon.manifest?.name || 'addon'}:`, e)
                                    return { ...addon, manifest: sanitizeAddonManifest(addon.manifest, addon.transportUrl) }
                              }
                        })
                  )

                  if (forceRefresh) {
                        await updateAddons(authKey, repairedAddons, account.id)
                  }

                  const updatedAccount = {
                        ...account,
                        addons: repairedAddons,
                        lastSync: new Date(),
                        status: 'active' as const,
                  }

                  const accounts = get().accounts.map((acc) => (acc.id === id ? updatedAccount : acc))
                  set({ accounts })
                  await localforage.setItem(STORAGE_KEY, accounts)

                  const { useSyncStore } = await import('./syncStore')
                  useSyncStore.getState().syncToRemote(true).catch(console.error)
            } catch (error) {
                  const message = error instanceof Error ? error.message : 'Failed to sync account'
                  const accounts = get().accounts.map((acc) =>
                        acc.id === id ? { ...acc, status: 'error' as const } : acc
                  )
                  set({ accounts, error: message })
                  await localforage.setItem(STORAGE_KEY, accounts)

                  const { useSyncStore } = await import('./syncStore')
                  useSyncStore.getState().syncToRemote(true).catch(console.error)
                  throw error
            } finally {
                  set({ loading: false })
            }
      },

      syncAllAccounts: async () => {
            if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return

            set({ loading: true, error: null })
            const accounts = get().accounts

            await Promise.all(
                  accounts.map(async (account) => {
                        try {
                              const authKey = await decrypt(account.authKey, getEncryptionKey())
                              const addons = await getAddons(authKey, account.id)

                              const normalizedAddons = addons.map((addon) => ({
                                    ...addon,
                                    manifest: sanitizeAddonManifest(addon.manifest, addon.transportUrl),
                              }))

                              const mergedAddons = mergeAddons(account.addons, normalizedAddons)

                              const updatedAccount = {
                                    ...account,
                                    addons: mergedAddons,
                                    lastSync: new Date(),
                                    status: 'active' as const,
                              }

                              const updatedAccounts = get().accounts.map((acc) =>
                                    acc.id === account.id ? updatedAccount : acc
                              )
                              set({ accounts: updatedAccounts })
                        } catch (error) {
                              const updatedAccounts = get().accounts.map((acc) =>
                                    acc.id === account.id ? { ...acc, status: 'error' as const } : acc
                              )
                              set({ accounts: updatedAccounts })
                        }
                  })
            )

            await localforage.setItem(STORAGE_KEY, get().accounts)
            const { useSyncStore } = await import('./syncStore')
            useSyncStore.getState().syncToRemote(true).catch(console.error)
            set({ loading: false })
      },

      repairAccount: async (id: string) => {
            return get().syncAccount(id, true)
      },

      installAddonToAccount: async (accountId: string, addonUrl: string) => {
            set({ loading: true, error: null })
            try {
                  const account = get().accounts.find((acc) => acc.id === accountId)
                  if (!account) throw new Error('Account not found')

                  const authKey = await decrypt(account.authKey, getEncryptionKey())
                  const updatedAddons = await apiInstallAddon(authKey, addonUrl, account.id)

                  const normalizedAddons = updatedAddons.map((addon) => ({
                        ...addon,
                        manifest: sanitizeAddonManifest(addon.manifest, addon.transportUrl),
                        metadata: {
                              ...addon.metadata,
                              lastUpdated: Date.now(),
                        },
                  }))

                  const mergedAddons = mergeAddons(account.addons, normalizedAddons)
                  const updatedAccount = { ...account, addons: mergedAddons, lastSync: new Date() }

                  const accounts = get().accounts.map((acc) => (acc.id === accountId ? updatedAccount : acc))
                  set({ accounts })
                  await localforage.setItem(STORAGE_KEY, accounts)

                  const { useSyncStore } = await import('./syncStore')
                  useSyncStore.getState().syncToRemote(true).catch(console.error)
                  get().syncAutopilotRules(accountId)
            } catch (error) {
                  const message = error instanceof Error ? error.message : 'Failed to install addon'
                  set({ error: message })
                  throw error
            } finally {
                  set({ loading: false })
            }
      },

      removeAddonFromAccount: async (accountId: string, transportUrl: string) => {
            set({ loading: true, error: null })
            try {
                  const account = get().accounts.find((acc) => acc.id === accountId)
                  if (!account) throw new Error('Account not found')

                  const authKey = await decrypt(account.authKey, getEncryptionKey())

                  // Optimistically mark as pending to prevent background sync from restoring it
                  syncManager.addPendingRemoval(accountId, transportUrl)

                  const updatedAddons = await apiRemoveAddon(authKey, transportUrl, account.id)

                  const normalizedAddons = updatedAddons.map((addon) => ({
                        ...addon,
                        manifest: sanitizeAddonManifest(addon.manifest, addon.transportUrl),
                  }))

                  const localAddonsFiltered = account.addons.filter((a) => a.transportUrl !== transportUrl)
                  const mergedOrder = mergeAddons(localAddonsFiltered, normalizedAddons)

                  const updatedAccount = { ...account, addons: mergedOrder, lastSync: new Date() }
                  const accounts = get().accounts.map((acc) => (acc.id === accountId ? updatedAccount : acc))
                  set({ accounts })
                  await localforage.setItem(STORAGE_KEY, accounts)

                  const { useSyncStore } = await import('./syncStore')
                  useSyncStore.getState().syncToRemote(true).catch(console.error)
                  get().syncAutopilotRules(accountId)
            } catch (error) {
                  const message = error instanceof Error ? error.message : 'Failed to remove addon'
                  set({ error: message })
                  throw error
            } finally {
                  set({ loading: false })
                  // Clear pending status after a short grace period
                  setTimeout(() => syncManager.removePendingRemoval(accountId, transportUrl), 5000)
            }
      },

      removeAddonByIndexFromAccount: async (accountId: string, index: number) => {
            set({ loading: true, error: null })
            let transportUrl = ''
            try {
                  const account = get().accounts.find((acc) => acc.id === accountId)
                  if (!account) throw new Error('Account not found')

                  const addonToRemove = account.addons[index]
                  if (!addonToRemove) throw new Error('Addon not found at index')

                  transportUrl = addonToRemove.transportUrl
                  syncManager.addPendingRemoval(accountId, transportUrl)

                  if (addonToRemove.flags?.protected) {
                        throw new Error(
                              `Addon "\${addonToRemove.manifest.name}" is protected and cannot be removed.`
                        )
                  }

                  const updatedAddons = [...account.addons]
                  updatedAddons.splice(index, 1)

                  const updatedAccount = { ...account, addons: updatedAddons, lastSync: new Date() }
                  const accounts = get().accounts.map((acc) => (acc.id === accountId ? updatedAccount : acc))
                  set({ accounts })
                  await localforage.setItem(STORAGE_KEY, accounts)

                  const { useSyncStore } = await import('./syncStore')
                  useSyncStore.getState().syncToRemote(true).catch(console.error)
                  get().syncAutopilotRules(accountId)

                  const authKey = await decrypt(account.authKey, getEncryptionKey())
                  await updateAddons(authKey, updatedAddons, account.id)
            } catch (error) {
                  const message = error instanceof Error ? error.message : 'Failed to remove addon'
                  set({ error: message })
                  throw error
            } finally {
                  set({ loading: false })
                  // Clear pending status after a short grace period
                  setTimeout(() => syncManager.removePendingRemoval(accountId, transportUrl), 5000)
            }
      },

      reorderAddons: async (accountId: string, newOrder: AddonDescriptor[]) => {
            // Set lastUpdated on all moved/reordered addons to protect them from sync reversion
            const timestampedOrder = newOrder.map(addon => ({
                  ...addon,
                  metadata: {
                        ...addon.metadata,
                        lastUpdated: Date.now()
                  }
            }))

            set({ loading: true, error: null })
            try {
                  const account = get().accounts.find((acc) => acc.id === accountId)
                  if (!account) throw new Error('Account not found')

                  const authKey = await decrypt(account.authKey, getEncryptionKey())
                  await updateAddons(authKey, timestampedOrder, account.id)

                  const updatedAccount = { ...account, addons: timestampedOrder, lastSync: new Date() }
                  const accounts = get().accounts.map((acc) => (acc.id === accountId ? updatedAccount : acc))
                  set({ accounts })
                  await localforage.setItem(STORAGE_KEY, accounts)

                  const { useSyncStore } = await import('./syncStore')
                  useSyncStore.getState().syncToRemote(true).catch(console.error)
                  get().syncAutopilotRules(accountId)
            } catch (error) {
                  const message = error instanceof Error ? error.message : 'Failed to reorder addons'
                  set({ error: message })
                  throw error
            } finally {
                  set({ loading: false })
            }
      },

      exportAccounts: async (includeCredentialsValue: boolean) => {
            try {
                  const manifestMap: Record<string, AddonDescriptor['manifest']> = {}
                  const getManifestKey = (m: AddonDescriptor['manifest']) => `${m.id}:${m.version}`

                  const processAddons = (addons: AddonDescriptor[]) => {
                        return addons.map((addon: AddonDescriptor) => {
                              const sanitized = sanitizeAddonManifest(addon.manifest, addon.transportUrl)
                              const key = getManifestKey(sanitized)
                              if (!manifestMap[key]) manifestMap[key] = sanitized
                              return {
                                    transportUrl: addon.transportUrl,
                                    transportName: addon.transportName,
                                    manifestId: key,
                                    flags: addon.flags,
                                    metadata: addon.metadata,
                              }
                        })
                  }

                  const exportedAccounts = await Promise.all(
                        get().accounts.map(async (acc) => ({
                              id: acc.id,
                              name: acc.name,
                              email: acc.email,
                              authKey: includeCredentialsValue ? await decrypt(acc.authKey, getEncryptionKey()!) : undefined,
                              password:
                                    includeCredentialsValue && acc.password
                                          ? await decrypt(acc.password, getEncryptionKey()!)
                                          : undefined,
                              addons: processAddons(acc.addons),
                        }))
                  )

                  const data: any = {
                        version: '2.0.0',
                        exportedAt: new Date().toISOString(),
                        manifests: manifestMap,
                        accounts: exportedAccounts,
                        profiles: useProfileStore.getState().profiles.map((p) => ({
                              ...p,
                              createdAt: new Date(p.createdAt).toISOString(),
                              updatedAt: new Date(p.updatedAt).toISOString(),
                        })),
                        identity: {
                              name: (await import('./syncStore')).useSyncStore.getState().auth.name,
                        },
                        addons: JSON.parse((await import('./addonStore')).useAddonStore.getState().exportLibrary()),
                        failover: {
                              rules: (await import('./failoverStore')).useFailoverStore.getState().rules,
                              webhook: (await import('./failoverStore')).useFailoverStore.getState().webhook
                        }
                  }

                  return JSON.stringify(data, null, 2)
            } catch (error) {
                  console.error('Failed to export accounts:', error)
                  throw error
            }
      },

      importAccounts: async (json: string, isSilent: boolean = false, mode: 'merge' | 'mirror' = 'merge') => {
            set({ loading: true, error: null })
            try {
                  let data: any
                  if (!json) throw new Error('No data provided to import')
                  try {
                        data = typeof json === 'object' ? json : JSON.parse(json)
                  } catch (e) {
                        throw new Error('Invalid JSON format for import')
                  }

                  const manifestMap = data.manifests || {}

                  // 1. Handle Saved Addon Library if present (Resilient scavenge)
                  const { useAddonStore } = await import('./addonStore')
                  await useAddonStore.getState().importLibrary(data, mode === 'merge')

                  // 2. Handle Failover Rules if present (Resilient scavenge)
                  const { useFailoverStore } = await import('./failoverStore')
                  await useFailoverStore.getState().importRules(data, mode)

                  // 3. Handle Profiles if present (Resilient scavenge)
                  const { useProfileStore } = await import('./profileStore')
                  let scavengedProfiles = data.profiles || data['stremio-manager:profiles']
                  if (scavengedProfiles && !Array.isArray(scavengedProfiles) && typeof scavengedProfiles === 'object') {
                        scavengedProfiles = Object.values(scavengedProfiles)
                  }
                  if (Array.isArray(scavengedProfiles) && scavengedProfiles.length > 0) {
                        await useProfileStore.getState().importProfiles(scavengedProfiles)
                  }

                  // Resilience: Support data.accounts being a wrapper object, a direct array, or missing
                  let accountsToImport = data.accounts || []
                  if (!Array.isArray(accountsToImport) && typeof accountsToImport === 'object') {
                        // Handle legacy wrapper: { accounts: [...] }
                        accountsToImport = (accountsToImport as any).accounts || []
                  }

                  // Ensure it's definitely an array before mapping
                  if (!Array.isArray(accountsToImport)) accountsToImport = []

                  const normalizedAccounts = accountsToImport.map((acc: any) => {
                        return {
                              id: acc.id || crypto.randomUUID(),
                              name: acc.name || 'Imported Account',
                              email: acc.email,
                              rawKey: acc.authKey || '',
                              password: acc.password,
                              addons: Array.isArray(acc.addons)
                                    ? acc.addons.map((ad: any) => ({
                                          ...ad,
                                          manifest: sanitizeAddonManifest(ad.manifest || manifestMap[ad.manifestId], ad.transportUrl),
                                    }))
                                    : [],
                              lastSync: new Date(),
                              status: 'active' as const,
                        }
                  })

                  const encryptionKey = getEncryptionKey()
                  const currentAccounts = [...get().accounts]

                  // Pre-decrypt local accounts for AuthKey-based reconciliation
                  const localDecrypted = await Promise.all(
                        currentAccounts.map(async (acc) => {
                              try {
                                    return { id: acc.id, key: await decrypt(acc.authKey, encryptionKey) }
                              } catch (e) {
                                    return { id: acc.id, key: null }
                              }
                        })
                  )

                  const reconciledAccounts: StremioAccount[] = []
                  const processedLocalIds = new Set<string>()

                  for (const ra of normalizedAccounts) {
                        // RECONCILIATION LAYERS:
                        // 1. Exact ID Match (Same instance)
                        // 2. AuthKey Match (Same Stremio account, different AIOM instance/ID)
                        // 3. Email Match (Credential logins)
                        let matchedAccount = currentAccounts.find((a) => a.id === ra.id)

                        if (!matchedAccount && ra.rawKey) {
                              const found = localDecrypted.find((ld) => ld.key === ra.rawKey)
                              if (found) matchedAccount = currentAccounts.find((a) => a.id === found.id)
                        }

                        if (!matchedAccount && ra.email) {
                              matchedAccount = currentAccounts.find(
                                    (a) => a.email?.toLowerCase() === ra.email?.toLowerCase()
                              )
                        }

                        if (matchedAccount) {
                              const updated: StremioAccount = {
                                    ...matchedAccount,
                                    name: ra.name || matchedAccount.name,
                                    authKey: ra.rawKey
                                          ? ra.rawKey.length > 50
                                                ? ra.rawKey
                                                : await encrypt(ra.rawKey, encryptionKey)
                                          : matchedAccount.authKey,
                                    addons: mergeAddons(matchedAccount.addons, ra.addons),
                                    lastSync: ra.lastSync || new Date(),
                                    status: 'active' as const,
                              }
                              reconciledAccounts.push(updated)
                              processedLocalIds.add(matchedAccount.id)
                        } else {
                              reconciledAccounts.push({
                                    ...ra,
                                    authKey: await encrypt(ra.rawKey, encryptionKey),
                                    password: ra.password ? await encrypt(ra.password, encryptionKey) : undefined,
                              } as StremioAccount)
                        }
                  }

                  let finalAccounts =
                        mode === 'mirror'
                              ? reconciledAccounts
                              : [...currentAccounts.filter((a) => !processedLocalIds.has(a.id)), ...reconciledAccounts]

                  set({ accounts: finalAccounts })
                  await localforage.setItem(STORAGE_KEY, finalAccounts)

                  const { useSyncStore } = await import('./syncStore')
                  useSyncStore.getState().syncToRemote(true).catch(console.error)

                  if (!isSilent) toast({ title: 'Import Successful' })
                  get().syncAllAccounts().catch(console.error)
            } catch (error) {
                  set({ error: (error as Error).message })
                  throw error
            } finally {
                  set({ loading: false })
            }
      },

      updateAccount: async (id: string, data: { name: string; authKey?: string; email?: string; password?: string }) => {
            set({ loading: true, error: null })
            try {
                  const account = get().accounts.find((acc) => acc.id === id)
                  if (!account) throw new Error('Account not found')

                  const updatedAccount = { ...account, name: data.name }
                  if (data.authKey || (data.email && data.password)) {
                        let authKey =
                              data.authKey || (await loginWithCredentials(data.email!, data.password!)).authKey
                        updatedAccount.authKey = await encrypt(authKey, getEncryptionKey())
                        const addons = await getAddons(authKey, updatedAccount.id)
                        updatedAccount.addons = addons.map((a) => ({
                              ...a,
                              manifest: sanitizeAddonManifest(a.manifest),
                        }))
                        updatedAccount.lastSync = new Date()
                  }

                  const accounts = get().accounts.map((acc) => (acc.id === id ? updatedAccount : acc))
                  set({ accounts })
                  await localforage.setItem(STORAGE_KEY, accounts)

                  const { useSyncStore } = await import('./syncStore')
                  useSyncStore.getState().syncToRemote(true).catch(console.error)
            } catch (error) {
                  set({ error: (error as Error).message })
                  throw error
            } finally {
                  set({ loading: false })
            }
      },

      toggleAddonProtection: async (accountId: string, transportUrl: string, isProtected: boolean, targetIndex?: number) => {
            const account = get().accounts.find((acc) => acc.id === accountId)
            if (!account) return
            const updatedAddons = account.addons.map((addon, index) =>
                  (targetIndex !== undefined ? index === targetIndex : addon.transportUrl === transportUrl)
                        ? { ...addon, flags: { ...addon.flags, protected: isProtected } }
                        : addon
            )
            const accounts = get().accounts.map((acc) =>
                  acc.id === accountId ? { ...acc, addons: updatedAddons } : acc
            )
            set({ accounts })
            await localforage.setItem(STORAGE_KEY, accounts)
            const { useSyncStore } = await import('./syncStore')
            useSyncStore.getState().syncToRemote(true).catch(console.error)
            const authKey = await decrypt(account.authKey, getEncryptionKey())
            await updateAddons(authKey, updatedAddons, accountId)
      },

      toggleAddonEnabled: async (accountId: string, transportUrl: string, isEnabled: boolean, silent: boolean = false, targetIndex?: number, isAutopilot: boolean = false) => {
            const account = get().accounts.find((acc) => acc.id === accountId)
            if (!account) return
            const updatedAddons = account.addons.map((addon, index) =>
                  (targetIndex !== undefined ? index === targetIndex : addon.transportUrl === transportUrl)
                        ? { ...addon, flags: { ...addon.flags, enabled: isEnabled } }
                        : addon
            )
            const accounts = get().accounts.map((acc) =>
                  acc.id === accountId ? { ...acc, addons: updatedAddons } : acc
            )
            set({ accounts })
            await localforage.setItem(STORAGE_KEY, accounts)
            const { useSyncStore } = await import('./syncStore')
            useSyncStore.getState().syncToRemote(true).catch(console.error)
            if (!silent) {
                  const authKey = await decrypt(account.authKey, getEncryptionKey())
                  await updateAddons(authKey, updatedAddons, accountId)
            }

            // Task 5: Inform Autopilot of manual toggle
            // ONLY if this wasn't an automatic action by Autopilot itself
            if (!isAutopilot) {
                  autopilotManager.handleManualToggle(accountId, transportUrl)
            }
      },

      updateAddonMetadata: async (accountId: string, transportUrl: string, metadata: { customName?: string; customLogo?: string; customDescription?: string }, targetIndex?: number) => {
            const account = get().accounts.find((a) => a.id === accountId)
            if (!account) return
            const updatedAddons = account.addons.map((addon, index) => {
                  if (targetIndex !== undefined ? index === targetIndex : addon.transportUrl === transportUrl) {
                        const cleanMetadata = { ...(addon.metadata || {}) } as any
                        Object.keys(metadata).forEach((k) => {
                              if ((metadata as any)[k] === undefined) delete cleanMetadata[k]
                              else cleanMetadata[k] = (metadata as any)[k]
                        })
                        return { ...addon, metadata: cleanMetadata }
                  }
                  return addon
            })
            const accounts = get().accounts.map((acc) =>
                  acc.id === accountId ? { ...acc, addons: updatedAddons } : acc
            )
            set({ accounts })
            await localforage.setItem(STORAGE_KEY, accounts)
            const { useSyncStore } = await import('./syncStore')
            useSyncStore.getState().syncToRemote(true).catch(console.error)
            const authKey = await decrypt(account.authKey, getEncryptionKey())
            await updateAddons(authKey, updatedAddons, accountId)
      },

      bulkProtectAddons: async (accountId: string, isProtected: boolean) => {
            const account = get().accounts.find((a) => a.id === accountId)
            if (!account) return
            const updatedAddons = account.addons.map((a) => ({
                  ...a,
                  flags: { ...a.flags, protected: isProtected },
            }))
            const accounts = get().accounts.map((acc) =>
                  acc.id === accountId ? { ...acc, addons: updatedAddons } : acc
            )
            set({ accounts })
            await localforage.setItem(STORAGE_KEY, accounts)
            const { useSyncStore } = await import('./syncStore')
            useSyncStore.getState().syncToRemote(true).catch(console.error)
      },

      bulkProtectSelectedAddons: async (accountId: string, transportUrls: string[], isProtected: boolean) => {
            const account = get().accounts.find((a) => a.id === accountId)
            if (!account) return
            const updatedAddons = account.addons.map((a) => (
                  transportUrls.includes(a.transportUrl)
                        ? { ...a, flags: { ...a.flags, protected: isProtected } }
                        : a
            ))
            const accounts = get().accounts.map((acc) =>
                  acc.id === accountId ? { ...acc, addons: updatedAddons } : acc
            )
            set({ accounts })
            await localforage.setItem(STORAGE_KEY, accounts)
            const { useSyncStore } = await import('./syncStore')
            useSyncStore.getState().syncToRemote(true).catch(console.error)
      },

      removeLocalAddons: async (accountId: string, idsOrUrls: string[]) => {
            const account = get().accounts.find((a) => a.id === accountId)
            if (!account) return

            // Robust matching (ID or Normalized URL)
            const updatedAddons = account.addons.filter((addon) => {
                  const normA = normalizeAddonUrl(addon.transportUrl).toLowerCase()
                  const shouldRemove = idsOrUrls.some((target) => {
                        const normTarget = normalizeAddonUrl(target).toLowerCase()
                        return addon.manifest.id === target || normA === normTarget
                  })
                  return !shouldRemove
            })

            const accounts = get().accounts.map((acc) =>
                  acc.id === accountId ? { ...acc, addons: updatedAddons } : acc
            )
            set({ accounts })
            await localforage.setItem(STORAGE_KEY, accounts)
            const { useSyncStore } = await import('./syncStore')
            useSyncStore.getState().syncToRemote(true).catch(console.error)
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
            await localforage.setItem(STORAGE_KEY, accounts)
            const { useSyncStore } = await import('./syncStore')
            useSyncStore.getState().syncToRemote(true).catch(console.error)
      },

      reorderAccounts: async (newOrder: string[]) => {
            const accounts = newOrder
                  .map((id) => get().accounts.find((a) => a.id === id))
                  .filter(Boolean) as StremioAccount[]
            set({ accounts })
            await localforage.setItem(STORAGE_KEY, accounts)
            const { useSyncStore } = await import('./syncStore')
            useSyncStore.getState().syncToRemote(true).catch(console.error)
      },

      clearError: () => set({ error: null }),
      reset: async () => {
            set({ accounts: [], loading: false, error: null })
            await localforage.removeItem(STORAGE_KEY)
      },
}))
