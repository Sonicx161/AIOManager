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
import { accountExportSchema } from '@/lib/validation'
import { loadAddonLibrary, saveAddonLibrary } from '@/lib/addon-storage'
import { updateLatestVersions as updateLatestVersionsCoordinator } from '@/lib/store-coordinator'
import { toast } from '@/hooks/use-toast'
import { AccountExport, StremioAccount, FailoverRuleExport } from '@/types/account'
import { useProfileStore } from '@/store/profileStore'
import { AddonDescriptor } from '@/types/addon'
import { SavedAddon } from '@/types/saved-addon'
import { CinemetaManifest } from '@/types/cinemeta'
import { isCinemetaAddon, detectAllPatches, applyCinemetaConfiguration } from '@/lib/cinemeta-utils'
import localforage from 'localforage'
import { create } from 'zustand'

const STORAGE_KEY = 'stremio-manager:accounts'

// Manifest Cache to speed up sync baseline recovery
const MANIFEST_CACHE: Record<string, { manifest: AddonDescriptor['manifest']; timestamp: number }> = {}
const CACHE_TTL = 30 * 60 * 1000 // 30 minutes

// Helper function to sanitize addon manifests by converting null to undefined
const sanitizeAddonManifest = (manifest: AddonDescriptor['manifest']) => {
  if (!manifest) {
    return {
      id: '',
      name: 'Unknown Addon',
      version: '0.0.0',
      description: '',
      types: [], // CRITICAL: Stremio requires this field
      logo: undefined,
      background: undefined,
      idPrefixes: undefined,
    } as AddonDescriptor['manifest']
  }
  return {
    ...manifest,
    types: manifest.types || [], // Ensure types exists
    logo: manifest.logo ?? undefined,
    background: manifest.background ?? undefined,
    idPrefixes: manifest.idPrefixes ?? undefined,
  }
}

const getEncryptionKey = () => {
  const key = useAuthStore.getState().encryptionKey
  if (!key) {
    const isSetup = useAuthStore.getState().isPasswordSet()
    throw new Error(isSetup ? 'App is locked. Please unlock to continue.' : 'Master password not set up. Please set a password first.')
  }
  return key
}

// Helper: Merge remote addons with local addons, preserving order and flags
const mergeAddons = (localAddons: AddonDescriptor[], remoteAddons: AddonDescriptor[]) => {
  // 1. Map remote addons for lookup (by transportUrl to support duplicates)
  const remoteAddonMap = new Map(remoteAddons.map(a => [a.transportUrl, a]))
  const processedRemoteUrls = new Set<string>()
  const finalAddons: AddonDescriptor[] = []

  // 2. Iterate through LOCAL addons to preserve their order
  localAddons.forEach(localAddon => {
    const remoteAddon = remoteAddonMap.get(localAddon.transportUrl)

    if (remoteAddon) {
      // Exists in both: Use Remote data + Local flags
      finalAddons.push({
        ...remoteAddon,
        flags: {
          ...remoteAddon.flags,
          protected: localAddon.flags?.protected,
          enabled: localAddon.flags?.enabled ?? true
        },
        metadata: localAddon.metadata
      })
      processedRemoteUrls.add(localAddon.transportUrl)
    } else {
      // Missing from remote
      // Keep ONLY if it is explicitly disabled locally or protected
      if (localAddon.flags?.enabled === false || localAddon.flags?.protected) {
        finalAddons.push(localAddon)
      }
    }
  })

  // 3. Append any NEW remote addons that weren't in local list
  remoteAddons.forEach(remoteAddon => {
    if (!processedRemoteUrls.has(remoteAddon.transportUrl)) {
      finalAddons.push(remoteAddon)
    }
  })

  return finalAddons
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
  importAccounts: (json: string, isSilent?: boolean) => Promise<void>
  updateAccount: (
    id: string,
    data: { name: string; authKey?: string; email?: string; password?: string }
  ) => Promise<void>
  toggleAddonProtection: (accountId: string, transportUrl: string, isProtected: boolean, targetIndex?: number) => Promise<void>
  toggleAddonEnabled: (accountId: string, transportUrl: string, isEnabled: boolean, silent?: boolean, targetIndex?: number) => Promise<void>
  updateAddonMetadata: (accountId: string, transportUrl: string, metadata: { customName?: string; customLogo?: string; customDescription?: string }, targetIndex?: number) => Promise<void>
  moveAccount: (id: string, direction: 'up' | 'down') => Promise<void>
  reorderAccounts: (newOrder: string[]) => Promise<void>
  bulkProtectAddons: (accountId: string, isProtected: boolean) => Promise<void>
  removeLocalAddons: (accountId: string, transportUrls: string[]) => Promise<void>
  clearError: () => void
  reset: () => Promise<void>
}

export const useAccountStore = create<AccountStore>((set, get) => ({
  accounts: [],
  loading: false,
  error: null,

  initialize: async () => {
    try {
      const storedAccounts = await localforage.getItem<StremioAccount[]>(STORAGE_KEY)

      if (storedAccounts && Array.isArray(storedAccounts)) {
        // Convert date strings back to Date objects
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

  updateLatestVersions: (versions) => {
    updateLatestVersionsCoordinator(versions)
  },

  addAccountByAuthKey: async (authKey, name) => {
    set({ loading: true, error: null })
    try {
      // Validate auth key by fetching addons
      const addons = await getAddons(authKey, 'New-Login-Check')

      // Normalize addon manifests
      const normalizedAddons = addons.map((addon) => ({
        ...addon,
        manifest: sanitizeAddonManifest(addon.manifest),
      }))

      const account: StremioAccount = {
        id: authKey, // Option B: Use the Sync UUID as the ID for parity with AIOStreams
        name,
        authKey: await encrypt(authKey, getEncryptionKey()),
        addons: normalizedAddons,
        lastSync: new Date(),
        status: 'active',
      }

      const accounts = [...get().accounts, account]
      set({ accounts })

      // Persist to storage
      await localforage.setItem(STORAGE_KEY, accounts)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to add account'
      set({ error: message })
      throw error
    } finally {
      set({ loading: false })
    }
  },

  addAccountByCredentials: async (email, password, name) => {
    set({ loading: true, error: null })
    try {
      // 1. Attempt Login
      let response: LoginResponse
      try {
        response = await loginWithCredentials(email, password)
      } catch (loginError: any) {
        // 2. If login fails with "USER_NOT_FOUND", attempt auto-registration
        const isUserNotFound = loginError.code === 'USER_NOT_FOUND' ||
          loginError.message?.includes('USER_NOT_FOUND') ||
          loginError.message?.includes('User not found') ||
          loginError.code?.includes('USER_NOT_FOUND')

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

      // 3. Fetch addons
      const addons = await getAddons(response.authKey, 'New-Login-Check')

      // Normalize addon manifests
      const normalizedAddons = addons.map((addon) => ({
        ...addon,
        manifest: sanitizeAddonManifest(addon.manifest),
      }))

      const account: StremioAccount = {
        id: crypto.randomUUID(),
        name: name || email,
        email,
        authKey: await encrypt(response.authKey, getEncryptionKey()),
        password: await encrypt(password, getEncryptionKey()),
        addons: normalizedAddons,
        lastSync: new Date(),
        status: 'active',
      }

      const accounts = [...get().accounts, account]
      set({ accounts })

      // Persist to storage
      await localforage.setItem(STORAGE_KEY, accounts)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to add account'
      set({ error: message })
      throw error
    } finally {
      set({ loading: false })
    }
  },

  removeAccount: async (id) => {
    // Cascade delete activity (imported dynamically to avoid circular dependency issues at init time)
    const { useActivityStore } = await import('@/store/activityStore')
    await useActivityStore.getState().deleteActivityForAccount(id)

    // Cascade delete account state from addon store
    const { useAddonStore } = await import('@/store/addonStore')
    await useAddonStore.getState().deleteAccountState(id)

    const accounts = get().accounts.filter((acc) => acc.id !== id)
    set({ accounts })
    await localforage.setItem(STORAGE_KEY, accounts)
  },

  syncAccount: async (id, forceRefresh = false) => {
    set({ loading: true, error: null })
    try {
      const account = get().accounts.find((acc) => acc.id === id)
      if (!account) {
        throw new Error('Account not found')
      }

      const authKey = await decrypt(account.authKey, getEncryptionKey())
      const addons = await getAddons(authKey, account.id)

      // Normalize addon manifests
      const normalizedAddons = addons.map((addon) => ({
        ...addon,
        manifest: sanitizeAddonManifest(addon.manifest),
      }))

      const mergedAddons = mergeAddons(account.addons, normalizedAddons)

      // Lazy Baseline Recovery: Only fetch fresh manifests if forceRefresh is true OR if manifest is missing
      set({ loading: true })
      const { stremioClient } = await import('@/api/stremio-client')
      const repairedAddons = await Promise.all(mergedAddons.map(async (addon) => {
        try {
          const addonName = addon.manifest?.name || 'Unknown Addon'
          const now = Date.now()

          // If we already have a manifest and aren't forcing a refresh, skip deep fetch
          if (!forceRefresh && addon.manifest && addon.manifest.id) {
            return addon
          }

          // Cinemeta Patch Detection
          let cinemetaPatches = null
          if (isCinemetaAddon(addon)) {
            cinemetaPatches = detectAllPatches(addon.manifest as CinemetaManifest)
          }

          // Manifest Baseline Recovery (from Cache or Fetch)
          let manifestRaw = null
          const cached = MANIFEST_CACHE[addon.transportUrl]
          if (cached && (now - cached.timestamp < CACHE_TTL)) {
            manifestRaw = cached.manifest
          } else {
            console.log(`[Sync] Fetching fresh manifest baseline for: ${addonName}`)
            const { manifest } = await stremioClient.fetchAddonManifest(addon.transportUrl, account.id)
            manifestRaw = manifest
            MANIFEST_CACHE[addon.transportUrl] = { manifest: manifestRaw, timestamp: now }
          }

          let repairedManifest = sanitizeAddonManifest(manifestRaw)

          // Cinemeta Patch Restore
          if (cinemetaPatches) {
            repairedManifest = applyCinemetaConfiguration(repairedManifest as CinemetaManifest, {
              removeSearchArtifacts: cinemetaPatches.searchArtifactsPatched,
              removeStandardCatalogs: cinemetaPatches.standardCatalogsPatched,
              removeMetaResource: cinemetaPatches.metaResourcePatched
            }) as AddonDescriptor['manifest']
          }

          return { ...addon, manifest: repairedManifest }
        } catch (e) {
          console.warn(`[Sync] Failed to baseline ${addon.manifest?.name || 'addon'}:`, e)
          return { ...addon, manifest: sanitizeAddonManifest(addon.manifest) }
        }
      }))

      // Only push back to Stremio if we actually did a refresh OR if there are local customizations
      // This saves a lot of time on simple refreshes
      if (forceRefresh) {
        console.log(`[Sync] Pushing state to Stremio (Repair/Deep Sync)...`)
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
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to sync account'
      const account = get().accounts.find((acc) => acc.id === id)

      // Mark account as error
      const accounts = get().accounts.map((acc) =>
        acc.id === id ? { ...acc, status: 'error' as const } : acc
      )
      set({ accounts, error: message })

      // Show toast notification
      toast({
        variant: 'destructive',
        title: 'Sync Failed',
        description: `Unable to sync "${account?.name}". Please check your credentials.`,
      })

      await localforage.setItem(STORAGE_KEY, accounts)
      throw error
    } finally {
      set({ loading: false })
    }
  },

  syncAllAccounts: async () => {
    // Idle Optimization: Skip full sync if tab is hidden
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return

    set({ loading: true, error: null })
    const accounts = get().accounts

    // Parallelize syncing using Promise.all to significantly speed up multi-account setups
    await Promise.all(accounts.map(async (account) => {
      try {
        const authKey = await decrypt(account.authKey, getEncryptionKey())
        const addons = await getAddons(authKey, account.id)

        // Normalize addon manifests
        const normalizedAddons = addons.map((addon) => ({
          ...addon,
          manifest: sanitizeAddonManifest(addon.manifest),
        }))

        const mergedAddons = mergeAddons(account.addons, normalizedAddons)

        // Parallel sync for syncAll is always "Lazy" (forceRefresh = false)
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
        // Mark account as error but continue with others
        const updatedAccounts = get().accounts.map((acc) =>
          acc.id === account.id ? { ...acc, status: 'error' as const } : acc
        )
        set({ accounts: updatedAccounts })

        // Show toast notification for this account
        toast({
          variant: 'destructive',
          title: 'Sync Failed',
          description: `Unable to sync "${account.name}". Please check your credentials.`,
        })
      }
    }))

    await localforage.setItem(STORAGE_KEY, get().accounts)
    set({ loading: false })
  },

  repairAccount: async (id) => {
    return get().syncAccount(id, true)
  },

  installAddonToAccount: async (accountId, addonUrl) => {
    set({ loading: true, error: null })
    try {
      const account = get().accounts.find((acc) => acc.id === accountId)
      if (!account) {
        throw new Error('Account not found')
      }

      const authKey = await decrypt(account.authKey, getEncryptionKey())
      const updatedAddons = await apiInstallAddon(authKey, addonUrl, account.id)

      const normalizedAddons = updatedAddons.map((addon) => ({
        ...addon,
        manifest: sanitizeAddonManifest(addon.manifest),
      }))
      const mergedAddons = mergeAddons(account.addons, normalizedAddons)

      const updatedAccount = {
        ...account,
        addons: mergedAddons,
        lastSync: new Date(),
      }

      const accounts = get().accounts.map((acc) => (acc.id === accountId ? updatedAccount : acc))

      set({ accounts })
      await localforage.setItem(STORAGE_KEY, accounts)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to install addon'
      set({ error: message })
      throw error
    } finally {
      set({ loading: false })
    }
  },

  removeAddonFromAccount: async (accountId, transportUrl) => {
    set({ loading: true, error: null })
    try {
      const account = get().accounts.find((acc) => acc.id === accountId)
      if (!account) {
        throw new Error('Account not found')
      }

      const authKey = await decrypt(account.authKey, getEncryptionKey())
      const updatedAddons = await apiRemoveAddon(authKey, transportUrl, account.id)

      const normalizedAddons = updatedAddons.map((addon) => ({
        ...addon,
        manifest: sanitizeAddonManifest(addon.manifest),
      }))

      // Filter out the removed addon from LOCAL state before merging
      // This ensures that if it was "disabled" (and thus kept by mergeAddons), it is now explicitly dropped.
      const localAddonsFiltered = account.addons.filter(a => a.transportUrl !== transportUrl)

      const mergedOrder = mergeAddons(localAddonsFiltered, normalizedAddons)

      const updatedAccount = {
        ...account,
        addons: mergedOrder,
        lastSync: new Date(),
      }

      const accounts = get().accounts.map((acc) => (acc.id === accountId ? updatedAccount : acc))

      set({ accounts })
      await localforage.setItem(STORAGE_KEY, accounts)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to remove addon'
      set({ error: message })
      throw error
    } finally {
      set({ loading: false })
    }
  },

  removeAddonByIndexFromAccount: async (accountId, index) => {
    set({ loading: true, error: null })
    try {
      const account = get().accounts.find((acc) => acc.id === accountId)
      if (!account) {
        throw new Error('Account not found')
      }

      // Check if addon is protected before removing
      const addonToRemove = account.addons[index]
      if (!addonToRemove) throw new Error('Addon not found at index')

      if (addonToRemove.flags?.protected) {
        throw new Error(`Addon "${addonToRemove.manifest.name}" is protected and cannot be removed.`)
      }

      // 1. Remove ONLY the item at the specific index (order-safe for duplicates)
      const updatedAddons = [...account.addons]
      updatedAddons.splice(index, 1)

      // 2. Local Update
      const updatedAccount = {
        ...account,
        addons: updatedAddons,
        lastSync: new Date(),
      }
      const accounts = get().accounts.map((acc) => (acc.id === accountId ? updatedAccount : acc))
      set({ accounts })
      await localforage.setItem(STORAGE_KEY, accounts)

      // 3. Remote Sync (Push the entire collection to preserve order)
      const authKey = await decrypt(account.authKey, getEncryptionKey())
      await updateAddons(authKey, updatedAddons, account.id)

    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to remove addon'
      set({ error: message })
      throw error
    } finally {
      set({ loading: false })
    }
  },

  reorderAddons: async (accountId, newOrder) => {
    set({ loading: true, error: null })
    try {
      const account = get().accounts.find((acc) => acc.id === accountId)
      if (!account) {
        throw new Error('Account not found')
      }

      const authKey = await decrypt(account.authKey, getEncryptionKey())
      await updateAddons(authKey, newOrder, account.id)

      const updatedAccount = {
        ...account,
        addons: newOrder,
        lastSync: new Date(),
      }

      const accounts = get().accounts.map((acc) => (acc.id === accountId ? updatedAccount : acc))

      set({ accounts })
      await localforage.setItem(STORAGE_KEY, accounts)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to reorder addons'
      set({ error: message })
      throw error
    } finally {
      set({ loading: false })
    }
  },

  exportAccounts: async (includeCredentials) => {
    try {
      // Load saved addon library for consistency
      const addonLibrary = await loadAddonLibrary()

      // V2 Deduplication: Collect unique manifests
      const manifestMap: Record<string, AddonDescriptor['manifest']> = {}
      const getManifestKey = (m: AddonDescriptor['manifest']) => `${m.id}:${m.version}`

      // Helper to process addons: sanitize, dedupe, and return reference
      const processAddons = (addons: AddonDescriptor[]) => {
        return addons.map(addon => {
          // V3 Optimization: Keep critical fields (types, resources, catalogs) for Stremio validity
          // We only sanitize nulls
          const sanitized = sanitizeAddonManifest(addon.manifest)
          const key = getManifestKey(sanitized)

          if (!manifestMap[key]) {
            manifestMap[key] = sanitized
          }

          return {
            transportUrl: addon.transportUrl,
            transportName: addon.transportName,
            manifestId: key,
            flags: addon.flags,
            metadata: addon.metadata
          }
        })
      }

      const exportedAccounts = await Promise.all(
        get().accounts.map(async (acc) => ({
          id: acc.id,
          name: acc.name,
          email: acc.email,
          authKey: includeCredentials
            ? await decrypt(acc.authKey, getEncryptionKey())
            : undefined,
          password:
            includeCredentials && acc.password
              ? await decrypt(acc.password, getEncryptionKey())
              : undefined,
          addons: processAddons(acc.addons)
        }))
      )

      // Also process savedAddons (they also contain manifests)
      const savedAddons = Object.values(addonLibrary).map((addon) => {
        // Apply V3 logic: Full manifest preservation
        const sanitized = sanitizeAddonManifest(addon.manifest)
        const key = getManifestKey(sanitized)

        if (!manifestMap[key]) manifestMap[key] = sanitized

        return {
          ...addon,
          manifest: sanitized,
          createdAt: addon.createdAt.toISOString(),
          updatedAt: addon.updatedAt.toISOString(),
          lastUsed: addon.lastUsed?.toISOString(),
        }
      })

      const data: AccountExport = {
        version: '2.0.0',
        exportedAt: new Date().toISOString(),
        manifests: manifestMap,
        accounts: exportedAccounts,
        savedAddons: savedAddons.length > 0 ? savedAddons as any : undefined,
        profiles: useProfileStore.getState().profiles.map(p => ({
          ...p,
          createdAt: p.createdAt.toISOString(),
          updatedAt: p.updatedAt.toISOString()
        })),
        failover: {
          rules: (await import('./failoverStore')).useFailoverStore.getState().rules.map(r => ({
            ...r,
            lastCheck: r.lastCheck?.toISOString(),
            lastFailover: r.lastFailover?.toISOString()
          })) as FailoverRuleExport[],
          webhook: (await import('./failoverStore')).useFailoverStore.getState().webhook
        },
        accountStates: (await import('./addonStore')).useAddonStore.getState().accountStates,
        identity: {
          name: (await import('./syncStore')).useSyncStore.getState().auth.name
        }
      }

      return JSON.stringify(data, null, 2)
    } catch (error) {
      console.error('Failed to export accounts:', error)
      throw error
    }
  },

  importAccounts: async (json, isSilent = false) => {
    set({ loading: true, error: null })
    try {
      const data = typeof json === 'string' ? JSON.parse(json) : json
      let accountsToImport: any[] = []
      let savedAddonsToImport: SavedAddon[] = []
      let profilesToImport: any[] = []
      let failoverToImport: AccountExport['failover'] = undefined
      let accountStatesToImport: AccountExport['accountStates'] = undefined
      let identityToImport: AccountExport['identity'] = undefined

      const manifestMap = data.manifests || {}

      // Try Zod schema first (Best case)
      const validated = accountExportSchema.safeParse(data)
      if (validated.success) {
        const parsed = validated.data
        // V2 Import: Re-inflate manifests if present
        // Process accounts in parallel (Legacy ID recovery)
        accountsToImport = await Promise.all(parsed.accounts.map(async (acc) => {
          // Parity Fix: Recover original UUID from AuthKey if possible
          let realUUID = acc.id
          try {
            if (acc.authKey) {
              realUUID = await decrypt(acc.authKey, getEncryptionKey())
            }
          } catch (e) { /* Ignore */ }

          return {
            ...acc,
            id: realUUID,
            lastSync: new Date((acc as any).lastSync || Date.now())
          }
        }))

        // Restore other data types
        if (parsed.savedAddons) savedAddonsToImport = parsed.savedAddons as any[]
        if (parsed.profiles) profilesToImport = parsed.profiles
        if (parsed.failover) failoverToImport = parsed.failover as any
        if (parsed.accountStates) accountStatesToImport = parsed.accountStates
        if (parsed.identity) identityToImport = parsed.identity
      } else {
        // Fallback 1: Direct array of accounts
        if (Array.isArray(data)) {
          accountsToImport = data
        }
        // Fallback 2: Object with accounts array (standard export)
        else if (data && typeof data === 'object' && 'accounts' in data && Array.isArray((data as { accounts: unknown[] }).accounts)) {
          accountsToImport = (data as { accounts: unknown[] }).accounts
          savedAddonsToImport = (data as { savedAddons?: unknown[] }).savedAddons as any[] || []
          profilesToImport = (data as { profiles?: unknown[] }).profiles || []
          failoverToImport = (data as any).failover
          accountStatesToImport = (data as any).accountStates
          identityToImport = (data as any).identity
        }
        // Fallback 3: Object with users array (legacy Stremio Account Manager / Syncio)
        else if (data && typeof data === 'object' && 'users' in data && Array.isArray((data as { users: unknown[] }).users)) {
          accountsToImport = (data as { users: unknown[] }).users
          savedAddonsToImport = (data as { savedAddons?: unknown[] }).savedAddons as any[] || []
        }
        // Fallback 4: Single account object (must have specific keys to be valid)
        else if (typeof data === 'object' && data !== null && !Array.isArray(data) && (
          ('authKey' in data) || ('email' in data && 'password' in data)
        )) {
          // Ensure it's not a wrapper object by checking for meaningful account properties
          accountsToImport = [data]
        } else {
          throw new Error('Invalid format: structure not recognized. Expected "accounts" or "users" array.')
        }
      }

      console.log(`[Import] Found ${accountsToImport.length} accounts to import`)

      // First pass: normalize data but keep raw keys for comparison
      const normalizedAccounts = accountsToImport.map((acc: unknown) => {
        const item = acc as Record<string, unknown>
        const rawKey = (item.stremioAuthKey as string) || (item.authKey as string) || ''
        const email = item.email as string | undefined
        const password = item.password as string | undefined

        return {
          id: (item.id as string) || crypto.randomUUID(),
          name: (item.name as string) || (item.username as string) || 'Imported Account',
          email,
          rawKey, // Keep raw key for comparison
          password,
          addons: Array.isArray(item.addons) ? item.addons.map((addon: unknown) => {
            let ad = addon as any

            // Inflate manifest from map if missing (Optimized Backup Recovery)
            if (!ad.manifest && ad.manifestId && manifestMap[ad.manifestId]) {
              ad = { ...ad, manifest: manifestMap[ad.manifestId] }
            }

            return {
              ...ad,
              manifest: sanitizeAddonManifest(ad.manifest),
            }
          }) : [],
          lastSync: new Date(),
          status: 'active',
        }
      })

      // Merge with existing accounts
      // To properly check for duplicates, we must decrypt existing keys and check emails
      const existingAuthKeys = new Set<string>()
      const existingEmails = new Set<string>()
      const encryptionKey = getEncryptionKey()

      for (const acc of get().accounts) {
        if (acc.email) {
          existingEmails.add(acc.email.toLowerCase())
        }
        try {
          const decrypted = await decrypt(acc.authKey, encryptionKey)
          existingAuthKeys.add(decrypted)
        } catch (e) {
          // If we can't decrypt, fallback to the stored key (better than nothing)
          existingAuthKeys.add(acc.authKey)
        }
      }

      const uniqueNewAccounts: StremioAccount[] = []

      for (const acc of normalizedAccounts) {
        // Check 1: Email Match
        if (acc.email && existingEmails.has(acc.email.toLowerCase())) {
          console.log(`[Import] Skipping duplicate account by email: ${acc.email}`)
          continue
        }

        // Check 2: Auth Key Match
        // If the key is already encrypted (long string), try to decrypt it to check against existing
        // If it's short, it's raw, so just check it
        let keyToCheck = acc.rawKey
        if (acc.rawKey.length > 50) {
          try {
            keyToCheck = await decrypt(acc.rawKey, encryptionKey)
          } catch (e) {
            // Can't decrypt, assume it's raw or invalid
          }
        }

        if (keyToCheck && existingAuthKeys.has(keyToCheck)) {
          console.log(`[Import] Skipping duplicate account by authKey`)
          continue
        }

        // It's unique, so now we encrypt it for storage
        const finalizedAccount: StremioAccount = {
          id: acc.id,
          name: acc.name,
          email: acc.email,
          // Encrypt the key now
          authKey: acc.rawKey.length > 50 ? acc.rawKey : await encrypt(acc.rawKey, encryptionKey),
          password: acc.password ? (acc.password.length > 50 ? acc.password : await encrypt(acc.password, encryptionKey)) : undefined,
          addons: acc.addons,
          lastSync: acc.lastSync,
          status: 'active' as const
        }
        uniqueNewAccounts.push(finalizedAccount)
      }

      const accounts = [...get().accounts, ...uniqueNewAccounts]
      set({ accounts })
      await localforage.setItem(STORAGE_KEY, accounts)

      // Import profiles if present
      if (profilesToImport.length > 0) {
        const profiles = profilesToImport.map(p => {
          const item = p as any
          return {
            ...item,
            createdAt: new Date(item.createdAt),
            updatedAt: new Date(item.updatedAt)
          }
        })
        await useProfileStore.getState().importProfiles(profiles)
      }

      // Import saved addons if present
      if (savedAddonsToImport.length > 0) {
        try {
          const existingLibrary = await loadAddonLibrary()
          const newLibrary = { ...existingLibrary }

          for (const item of savedAddonsToImport) {
            const savedAddon = item as SavedAddon
            const addonId = savedAddon.id || crypto.randomUUID()
            const addon: SavedAddon = {
              ...savedAddon,
              id: addonId,
              manifest: sanitizeAddonManifest(savedAddon.manifest),
              createdAt: savedAddon.createdAt ? new Date(savedAddon.createdAt) : new Date(),
              updatedAt: savedAddon.updatedAt ? new Date(savedAddon.updatedAt) : new Date(),
              lastUsed: savedAddon.lastUsed ? new Date(savedAddon.lastUsed) : undefined,
            }
            newLibrary[addonId] = addon
          }

          await saveAddonLibrary(newLibrary)

          // Reload the addon store to reflect changes in memory
          const { useAddonStore } = await import('@/store/addonStore')
          await useAddonStore.getState().initialize()

        } catch (error) {
          console.error('Failed to import saved addons:', error)
          toast({
            variant: 'destructive',
            title: 'Warning',
            description: 'Accounts imported, but saved addons failed.',
          })
        }
      }

      // Restore Account States
      if (accountStatesToImport) {
        try {
          const { useAddonStore } = await import('./addonStore')
          await useAddonStore.getState().importAccountStates(accountStatesToImport)
        } catch (e) {
          console.warn('Failed to import account states', e)
        }
      }

      // Import failover rules if present
      if (failoverToImport) {
        try {
          console.log('[Import] Restoring failover configuration...')
          const { useFailoverStore } = await import('./failoverStore')
          await useFailoverStore.getState().importRules((failoverToImport.rules as any[]).map(r => ({
            ...r,
            lastCheck: r.lastCheck ? new Date(r.lastCheck) : undefined,
            lastFailover: r.lastFailover ? new Date(r.lastFailover) : undefined
          })))
          if (failoverToImport.webhook) {
            useFailoverStore.getState().setWebhook(failoverToImport.webhook.url, failoverToImport.webhook.enabled)
          }
        } catch (err) {
          console.error('[Import] Failed to restore failover rules:', err)
        }
      }

      // Restore Identity (Display Name)
      if (identityToImport?.name) {
        try {
          (await import('./syncStore')).useSyncStore.getState().setDisplayName(identityToImport.name)
        } catch (err) {
          console.warn('[Import] Failed to restore identity:', err)
        }
      }

      if (!isSilent) {
        toast({
          title: 'Import Successful',
          description: 'All accounts and settings have been restored.'
        })
      }

      // BACKGROUND SYNC: Populate manifests for imported accounts
      // Since imported accounts might have empty manifests, we trigger 
      // syncAllAccounts to baseline them using the Recovery logic.
      get().syncAllAccounts().catch(e => console.error('[Import] Auto-sync failed:', e))

    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to import accounts'
      set({ error: message })
      throw error
    } finally {
      set({ loading: false })
    }
  },

  updateAccount: async (id, data) => {
    set({ loading: true, error: null })
    try {
      const account = get().accounts.find((acc) => acc.id === id)
      if (!account) {
        throw new Error('Account not found')
      }

      const updatedAccount = { ...account, name: data.name }

      // If credentials changed, re-validate
      if (data.authKey || (data.email && data.password)) {
        let authKey = ''

        if (data.authKey) {
          authKey = data.authKey
          updatedAccount.authKey = await encrypt(authKey, getEncryptionKey())
        } else if (data.email && data.password) {
          const response = await loginWithCredentials(data.email, data.password)
          authKey = response.authKey
          updatedAccount.email = data.email
          updatedAccount.password = await encrypt(data.password, getEncryptionKey())
          updatedAccount.authKey = await encrypt(authKey, getEncryptionKey())
        }

        // Fetch addons with new key
        const addons = await getAddons(authKey, updatedAccount.id)

        // Normalize addon manifests
        const normalizedAddons = addons.map((addon) => ({
          ...addon,
          manifest: sanitizeAddonManifest(addon.manifest),
        }))

        updatedAccount.addons = normalizedAddons
        updatedAccount.status = 'active'
        updatedAccount.lastSync = new Date()
      }

      const accounts = get().accounts.map((acc) => (acc.id === id ? updatedAccount : acc))

      set({ accounts })
      await localforage.setItem(STORAGE_KEY, accounts)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update account'
      set({ error: message })
      throw error
    } finally {
      set({ loading: false })
    }
  },

  toggleAddonProtection: async (accountId, transportUrl, isProtected, targetIndex) => {
    try {
      const account = get().accounts.find((acc) => acc.id === accountId)
      if (!account) return

      const updatedAddons = account.addons.map((addon, index) => {
        // If targetIndex provided, strict match. Otherwise, match all by URL.
        const shouldUpdate = typeof targetIndex === 'number'
          ? index === targetIndex
          : addon.transportUrl === transportUrl

        if (shouldUpdate) {
          return {
            ...addon,
            flags: {
              ...addon.flags,
              protected: isProtected
            }
          }
        }
        return addon
      })

      // Update local state immediately (Optimistic UI)
      const updatedAccount = { ...account, addons: updatedAddons }
      const accounts = get().accounts.map(acc => acc.id === accountId ? updatedAccount : acc)

      set({ accounts })
      await localforage.setItem(STORAGE_KEY, accounts)

      // Sync to server to ensure API checks pass
      const authKey = await decrypt(account.authKey, getEncryptionKey())
      await updateAddons(authKey, updatedAddons, accountId) // Store coordinator handles enabled flag

    } catch (err) {
      console.error('Failed to toggle protection', err)
      const message = err instanceof Error ? err.message : 'Failed to save protection status'
      toast({
        variant: 'destructive',
        title: 'Protection Sync Failed',
        description: message
      })
    }
  },

  toggleAddonEnabled: async (accountId, transportUrl, isEnabled, silent = false, targetIndex) => {
    try {
      if (!silent) set({ loading: true, error: null })
      const account = get().accounts.find((acc) => acc.id === accountId)
      if (!account) return

      const updatedAddons = account.addons.map((addon, index) => {
        // If targetIndex provided, strict match. Otherwise, match all by URL.
        const shouldUpdate = typeof targetIndex === 'number'
          ? index === targetIndex
          : addon.transportUrl === transportUrl

        if (shouldUpdate) {
          return {
            ...addon,
            flags: {
              ...addon.flags,
              enabled: isEnabled,
            },
          }
        }
        return addon
      })

      // Update local state immediately (Optimistic UI)
      const updatedAccount = { ...account, addons: updatedAddons, lastSync: new Date() }
      const accounts = get().accounts.map((acc) => (acc.id === accountId ? updatedAccount : acc))

      set({ accounts })
      await localforage.setItem(STORAGE_KEY, accounts)

      // Sync to server if unlocked
      try {
        const authKey = await decrypt(account.authKey, getEncryptionKey())
        await updateAddons(authKey, updatedAddons, accountId)
      } catch (e) {
        console.warn('Could not sync enabled state to remote (likely locked)', e)
      }

      if (!silent) {
        const addonName = account.addons.find((a) => a.transportUrl === transportUrl)?.manifest.name || 'Addon'
        toast({
          title: 'Sync Complete',
          description: `"${addonName}" is now ${isEnabled ? 'enabled' : 'disabled'} and synced to Stremio.`,
        })
      }
    } catch (err) {
      console.error('Failed to toggle addon state', err)
      const message = err instanceof Error ? err.message : 'Failed to save addon state'

      if (!silent) {
        toast({
          variant: 'destructive',
          title: 'Sync Failed',
          description: message,
        })
      }
      if (!silent) set({ error: message })
    } finally {
      if (!silent) set({ loading: false })
    }
  },

  updateAddonMetadata: async (accountId, transportUrl, metadata, targetIndex) => {
    try {
      set({ loading: true, error: null })
      const account = get().accounts.find((acc) => acc.id === accountId)
      if (!account) throw new Error('Account not found')

      // Detect if this is a "Full Reset" (all fields undefined)
      const isReset = metadata.customName === undefined &&
        metadata.customLogo === undefined &&
        metadata.customDescription === undefined

      let recoveredManifest: AddonDescriptor['manifest'] | null = null
      if (isReset) {
        // Re-fetch the original manifest to clear any patches (e.g. Cinemeta)
        try {
          const { fetchAddonManifest } = await import('@/api/addons')
          const freshAddon = await fetchAddonManifest(transportUrl, accountId)
          recoveredManifest = freshAddon.manifest
        } catch (e) {
          console.warn('[Metadata] Failed to re-fetch manifest for reset, falling back to local.', e)
        }
      }

      const updatedAddons = account.addons.map((addon, index) => {
        // If targetIndex provided, strict match. Otherwise, match all by URL.
        const shouldUpdate = typeof targetIndex === 'number'
          ? index === targetIndex
          : addon.transportUrl === transportUrl

        if (shouldUpdate) {
          // CRITICAL: Clean metadata of undefined keys to allow manifest fallback
          const cleanMetadata = { ...(addon.metadata || {}) }
          Object.keys(metadata).forEach(key => {
            const val = (metadata as any)[key]
            if (val === undefined) {
              delete (cleanMetadata as any)[key]
            } else {
              (cleanMetadata as any)[key] = val
            }
          })

          return {
            ...addon,
            manifest: recoveredManifest || addon.manifest, // Restore manifest if we re-fetched it
            metadata: cleanMetadata
          }
        }
        return addon
      })

      const updatedAccount = { ...account, addons: updatedAddons, lastSync: new Date() }
      const accounts = get().accounts.map((acc) => (acc.id === accountId ? updatedAccount : acc))

      set({ accounts })
      await localforage.setItem(STORAGE_KEY, accounts)

      // CRITICAL: Push to Stremio (Raven Method)
      const authKey = await decrypt(account.authKey, getEncryptionKey())
      await updateAddons(authKey, updatedAddons, accountId)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update metadata'
      set({ error: message })
      throw error
    } finally {
      set({ loading: false })
    }
  },

  bulkProtectAddons: async (accountId, isProtected) => {
    try {
      const account = get().accounts.find((acc) => acc.id === accountId)
      if (!account) return

      const updatedAddons = account.addons.map(addon => ({
        ...addon,
        flags: {
          ...addon.flags,
          protected: isProtected
        }
      }))

      // Update local state immediately (Optimistic UI)
      const updatedAccount = { ...account, addons: updatedAddons }
      const accounts = get().accounts.map(acc => acc.id === accountId ? updatedAccount : acc)

      set({ accounts })
      await localforage.setItem(STORAGE_KEY, accounts)

      // Sync to server
      const authKey = await decrypt(account.authKey, getEncryptionKey())
      await updateAddons(authKey, updatedAddons, accountId)

    } catch (err) {
      console.error('Failed to bulk protect addons', err)
      const message = err instanceof Error ? err.message : 'Failed to save protection status'
      toast({
        variant: 'destructive',
        title: 'Protection Sync Failed',
        description: message
      })
    }
  },

  removeLocalAddons: async (accountId, transportUrls) => {
    // Helper to explicitly remove addons from local state (used for deleting disabled/ghost addons)
    const account = get().accounts.find((acc) => acc.id === accountId)
    if (!account) return

    const updatedAddons = account.addons.filter(a => !transportUrls.includes(a.transportUrl))

    // Only update if changes were made
    if (updatedAddons.length !== account.addons.length) {
      const updatedAccount = { ...account, addons: updatedAddons }
      const accounts = get().accounts.map(acc => acc.id === accountId ? updatedAccount : acc)
      set({ accounts })
      await localforage.setItem(STORAGE_KEY, accounts)
    }
  },

  moveAccount: async (id, direction) => {
    const accounts = [...get().accounts]
    const index = accounts.findIndex((a) => a.id === id)
    if (index === -1) return

    if (direction === 'up' && index > 0) {
      [accounts[index], accounts[index - 1]] = [accounts[index - 1], accounts[index]]
    } else if (direction === 'down' && index < accounts.length - 1) {
      [accounts[index], accounts[index + 1]] = [accounts[index + 1], accounts[index]]
    } else {
      return
    }

    set({ accounts })
    await localforage.setItem(STORAGE_KEY, accounts)
  },

  reorderAccounts: async (newOrder) => {
    const currentAccounts = get().accounts
    const accountMap = new Map(currentAccounts.map((a) => [a.id, a]))

    // Create new array based on order, filtering out any invalid IDs
    const reorderedAccounts = newOrder
      .map((id) => accountMap.get(id))
      .filter((a): a is StremioAccount => !!a)

    // Safety check: ensure we didn't lose any accounts (e.g. if newOrder was partial)
    if (reorderedAccounts.length !== currentAccounts.length) {
      console.warn('Reorder mismatch', { expected: currentAccounts.length, actual: reorderedAccounts.length })
      // Fallback: append missing accounts
      const reorderedIds = new Set(reorderedAccounts.map(a => a.id))
      currentAccounts.forEach(a => {
        if (!reorderedIds.has(a.id)) {
          reorderedAccounts.push(a)
        }
      })
    }

    set({ accounts: reorderedAccounts })
    await localforage.setItem(STORAGE_KEY, reorderedAccounts)
  },

  clearError: () => {
    set({ error: null })
  },

  reset: async () => {
    set({ accounts: [], loading: false, error: null })
    await localforage.removeItem(STORAGE_KEY)
  },
}))
