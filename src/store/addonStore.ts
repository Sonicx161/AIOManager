import {
  getAddons,
  reinstallAddon as reinstallAddonApi,
  updateAddons,
  fetchAddonManifest,

} from '@/api/addons'
import { identifyAddon } from '@/lib/addon-identifier'
import { checkAllAddonsHealth } from '@/lib/addon-health'
import { mergeAddons, removeAddons } from '@/lib/addon-merger'
import { normalizeAddonUrl } from '@/lib/utils'
import {
  findSavedAddonByUrl,
  loadAccountAddonStates,
  loadAddonLibrary,
  saveAccountAddonStates,
  saveAddonLibrary,
} from '@/lib/addon-storage'
import { normalizeTagName } from '@/lib/addon-validator'
import { decrypt } from '@/lib/crypto'
import { useAuthStore } from '@/store/authStore'
import { AddonManifest, AddonDescriptor } from '@/types/addon'
import {
  AccountAddonState,
  BulkResult,
  InstalledAddon,
  MergeResult,
  SavedAddon,
} from '@/types/saved-addon'
import { create } from 'zustand'
import localforage from 'localforage'
import { restorationManager } from '@/lib/autopilot/restorationManager'


// Helper function to get encryption key from auth store
const getEncryptionKey = () => {
  const key = useAuthStore.getState().encryptionKey
  if (!key) throw new Error('App is locked')
  return key
}

interface AddonStore {
  // State
  library: Record<string, SavedAddon>
  latestVersions: Record<string, string>
  accountStates: Record<string, AccountAddonState>
  loading: boolean
  error: string | null
  checkingHealth: boolean

  // Initialization
  initialize: () => Promise<void>

  // === Update Management ===
  updateLatestVersions: (versions: Record<string, string>) => void
  getLatestVersion: (manifestId: string) => string | undefined

  // === Saved Addon Management ===
  createSavedAddon: (
    name: string,
    installUrl: string,
    tags?: string[],
    profileId?: string,
    existingManifest?: AddonManifest,
    metadata?: SavedAddon['metadata']
  ) => Promise<string>
  updateSavedAddon: (
    id: string,
    updates: Partial<Pick<SavedAddon, 'name' | 'tags' | 'installUrl' | 'profileId'>>
  ) => Promise<void>
  updateSavedAddonMetadata: (
    id: string,
    metadata: { customName?: string; customLogo?: string }
  ) => Promise<void>
  bulkUpdateSavedAddons: (
    ids: string[],
    updates: Partial<Pick<SavedAddon, 'tags' | 'profileId'>> & { tagsRemove?: string[] }
  ) => Promise<void>
  bulkDeleteSavedAddons: (ids: string[]) => Promise<void>
  updateSavedAddonManifest: (id: string) => Promise<void>
  deleteSavedAddon: (id: string) => Promise<void>
  deleteSavedAddonsByProfile: (profileId: string) => Promise<void>
  getSavedAddon: (id: string) => SavedAddon | null

  // === Tag Management ===
  getSavedAddonsByTag: (tag: string) => SavedAddon[]
  getAllTags: () => string[]
  renameTag: (oldTag: string, newTag: string) => Promise<void>

  // === Application (Single Saved Addon) ===
  applySavedAddonToAccount: (
    savedAddonId: string,
    accountId: string,
    accountAuthKey: string
  ) => Promise<MergeResult>
  applySavedAddonToAccounts: (
    savedAddonId: string,
    accountIds: Array<{ id: string; authKey: string }>
  ) => Promise<BulkResult>

  // === Application (Tag-based) ===
  applyTagToAccount: (
    tag: string,
    accountId: string,
    accountAuthKey: string
  ) => Promise<MergeResult>
  applyTagToAccounts: (
    tag: string,
    accountIds: Array<{ id: string; authKey: string }>
  ) => Promise<BulkResult>
  importAccountStates: (states: Record<string, AccountAddonState>) => Promise<void>

  // === Bulk Operations (Account-First Workflow) ===
  bulkApplySavedAddons: (
    savedAddonIds: string[],
    accountIds: Array<{ id: string; authKey: string }>,
    allowProtected?: boolean
  ) => Promise<BulkResult>
  bulkApplyTag: (
    tag: string,
    accountIds: Array<{ id: string; authKey: string }>
  ) => Promise<BulkResult>
  bulkRemoveAddons: (
    addonIds: string[],
    accountIds: Array<{ id: string; authKey: string }>,
    allowProtected?: boolean
  ) => Promise<BulkResult>
  bulkRemoveByTag: (
    tag: string,
    accountIds: Array<{ id: string; authKey: string }>,
    allowProtected?: boolean
  ) => Promise<BulkResult>
  bulkReinstallAddons: (
    addonIds: string[],
    accountIds: Array<{ id: string; authKey: string }>
  ) => Promise<BulkResult>
  bulkInstallFromUrls: (
    urls: string[],
    accountIds: Array<{ id: string; authKey: string }>,
    allowProtected?: boolean
  ) => Promise<BulkResult>
  bulkCloneAccount: (
    sourceAccount: { id: string; authKey: string },
    targetAccountIds: Array<{ id: string; authKey: string }>,
    overwrite?: boolean
  ) => Promise<BulkResult>
  bulkReinstallAllOnAccount: (accountId: string, accountAuthKey: string) => Promise<BulkResult>

  // === Sync ===
  syncAccountState: (accountId: string, accountAuthKey: string) => Promise<void>

  syncAllAccountStates: (accounts: Array<{ id: string; authKey: string }>) => Promise<void>
  toggleAutoRestore: (id: string, enabled: boolean) => Promise<void>
  lastHealthCheck?: number

  // === Import/Export ===
  exportLibrary: () => string
  importLibrary: (json: string, merge: boolean, isSilent?: boolean) => Promise<void>

  // === Health Checking ===
  checkAllHealth: () => Promise<void>
  updateHealthStatus: (statuses: Array<{ id: string; isOnline: boolean }>) => Promise<void>

  // Utility
  clearError: () => void
  reset: () => Promise<void>
  deleteAccountState: (accountId: string) => Promise<void>
  repairLibrary: () => Promise<void>
  replaceTransportUrlUniversally: (savedAddonId: string | null, oldUrl: string, newUrl: string, accountId?: string) => Promise<void>
}

export const useAddonStore = create<AddonStore>((set, get) => ({
  library: {},
  latestVersions: {},
  accountStates: {},
  loading: false,
  error: null,
  checkingHealth: false,
  lastHealthCheck: undefined,

  deleteAccountState: async (accountId) => {
    const accountStates = { ...get().accountStates }
    if (accountStates[accountId]) {
      delete accountStates[accountId]
      set({ accountStates })
      await saveAccountAddonStates(accountStates)
    }
  },

  initialize: async () => {
    try {
      const [library, accountStates, latestVersions] = await Promise.all([
        loadAddonLibrary(),
        loadAccountAddonStates(),
        localforage.getItem<Record<string, string>>('stremio-manager:latest-versions'),
      ])

      set({
        library,
        accountStates,
        latestVersions: latestVersions || {},
      })

      // Run repair on invalid profile IDs automatically
      get().repairLibrary()
    } catch (error) {
      console.error('Failed to initialize addon store:', error)
      set({ error: 'Failed to load addon data' })
    }
  },

  repairLibrary: async () => {
    const library = { ...get().library }
    let hasChanges = false
    let fixedCount = 0

    for (const id in library) {
      const addon = library[id]
      // Check if profileId is an object (corrupted by bug)
      if (typeof addon.profileId === 'object' && addon.profileId !== null) {
        console.warn(`[Rescue] Found corrupted profileId for addon ${addon.name}. Removing it.`)
        delete (addon as unknown as Record<string, unknown>).profileId
        hasChanges = true
        fixedCount++
      }
    }

    if (hasChanges) {
      set({ library })
      await saveAddonLibrary(library)
      console.log(`[Rescue] Successfully rescued ${fixedCount} addons from the abyss!`)
      // Sync fixed state back to cloud
      const { useSyncStore } = await import('./syncStore')
      useSyncStore.getState().syncToRemote(true).catch(console.error)
    }
  },

  updateLatestVersions: (versions) => {
    const newVersions = { ...get().latestVersions, ...versions }
    set({ latestVersions: newVersions })
    localforage.setItem('stremio-manager:latest-versions', newVersions).catch(console.error)
  },

  getLatestVersion: (manifestId) => {
    return get().latestVersions[manifestId]
  },

  // === Saved Addon Management ===

  createSavedAddon: async (name, installUrl, tags = [], profileId, existingManifest, metadata) => {
    set({ loading: true, error: null })
    try {
      let manifest = existingManifest

      // If no manifest provided, fetch it from the URL
      if (!manifest) {
        const addonDescriptor = await fetchAddonManifest(installUrl, 'System-Check')
        manifest = addonDescriptor.manifest
      }

      // Normalize tags
      const normalizedTags = tags.map(normalizeTagName).filter(Boolean)

      // Use provided name or fall back to robust identification
      let addonName = name.trim()
      if (!addonName || addonName === 'Unknown Addon') {
        const identified = identifyAddon(installUrl, manifest || undefined)
        addonName = identified.name
        if (!manifest) manifest = identified
      }

      // Prevent duplicates: Check if an addon with the same NORMALIZED URL already exists in the library
      const normUrl = normalizeAddonUrl(installUrl).toLowerCase()
      const existingAddon = Object.values(get().library).find(
        (addon) => normalizeAddonUrl(addon.installUrl).toLowerCase() === normUrl
      )

      if (existingAddon) {
        // If profileId matches, we update instead of creating a new one
        if (existingAddon.profileId === profileId) {
          return existingAddon.id
        }
        // If profileId is DIFFERENT, we allow it (User might want same addon in multiple profiles)
        // but usually, we should still warn or handle it. 
        // For now, we proceed to create a new one to allow profile-based segmentation.
      }

      const savedAddon: SavedAddon = {
        id: crypto.randomUUID(),
        name: addonName,
        installUrl,
        manifest,
        tags: normalizedTags,
        profileId,
        metadata,
        autoRestore: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        sourceType: 'manual',
      }

      const library = { ...get().library, [savedAddon.id]: savedAddon }
      set({ library })

      await saveAddonLibrary(library)

      // Sync to cloud immediately
      const { useSyncStore } = await import('./syncStore')
      useSyncStore.getState().syncToRemote(true).catch(console.error)

      return savedAddon.id
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create saved addon'
      set({ error: message })
      throw error
    } finally {
      set({ loading: false })
    }
  },

  updateSavedAddon: async (id, updates) => {
    set({ loading: true, error: null })
    try {
      const savedAddon = get().library[id]
      if (!savedAddon) {
        throw new Error('Saved addon not found')
      }

      const updatedSavedAddon = { ...savedAddon }

      // Update other fields
      if (updates.name !== undefined) {
        updatedSavedAddon.name = updates.name.trim()
      }
      if (updates.tags !== undefined) {
        updatedSavedAddon.tags = updates.tags.map(normalizeTagName).filter(Boolean)
      }
      if (updates.profileId !== undefined) {
        updatedSavedAddon.profileId = updates.profileId
      }

      updatedSavedAddon.updatedAt = new Date()

      const library = { ...get().library, [id]: updatedSavedAddon }
      set({ library })

      await saveAddonLibrary(library)
      // Sync to cloud
      const { useSyncStore } = await import('./syncStore')
      useSyncStore.getState().syncToRemote(true).catch(console.error)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update saved addon'
      set({ error: message })
      throw error
    } finally {
      set({ loading: false })
    }
  },

  updateSavedAddonMetadata: async (id, metadata) => {
    try {
      set({ loading: true, error: null })
      const savedAddon = get().library[id]
      if (!savedAddon) throw new Error('Saved addon not found')

      const cleanMetadata = { ...savedAddon.metadata }
      Object.keys(metadata).forEach(key => {
        const val = (metadata as any)[key]
        if (val === undefined) {
          delete (cleanMetadata as any)[key]
        } else {
          (cleanMetadata as any)[key] = val
        }
      })

      const updatedSavedAddon = {
        ...savedAddon,
        metadata: cleanMetadata,
        updatedAt: new Date()
      }

      const library = { ...get().library, [id]: updatedSavedAddon }
      set({ library })
      await saveAddonLibrary(library)
      // Sync to cloud
      const { useSyncStore } = await import('./syncStore')
      useSyncStore.getState().syncToRemote(true).catch(console.error)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update metadata'
      set({ error: message })
      throw error
    } finally {
      set({ loading: false })
    }
  },

  updateSavedAddonManifest: async (id) => {
    const savedAddon = get().library[id]
    if (!savedAddon) {
      throw new Error('Saved addon not found')
    }

    // Capture previous version for logging
    const previousVersion = savedAddon.manifest.version

    // Fetch fresh manifest from the install URL and sanitize it
    const addonDescriptor = await fetchAddonManifest(savedAddon.installUrl, 'System-Check')
    const freshManifest = identifyAddon(savedAddon.installUrl, addonDescriptor.manifest)

    // Verify manifest ID matches (prevent replacing with wrong addon)
    if (freshManifest.id !== savedAddon.manifest.id) {
      throw new Error('Addon ID mismatch - this may be a different addon')
    }

    // Update the saved addon with fresh manifest
    const updatedSavedAddon = {
      ...savedAddon,
      manifest: freshManifest,
      updatedAt: new Date(),
    }

    const library = { ...get().library, [id]: updatedSavedAddon }
    set({ library })

    await saveAddonLibrary(library)

    // Update latestVersions to clear the update badge
    const latestVersions = { ...get().latestVersions }
    latestVersions[freshManifest.id] = freshManifest.version
    set({ latestVersions })
    localforage.setItem('stremio-manager:latest-versions', latestVersions).catch(console.error)

    console.log(
      `Updated saved addon "${savedAddon.name}" from v${previousVersion} to v${freshManifest.version}`
    )

    // Sync to cloud immediately
    const { useSyncStore } = await import('./syncStore')
    useSyncStore.getState().syncToRemote(true).catch(console.error)
  },

  deleteSavedAddonsByProfile: async (profileId) => {
    const library = { ...get().library }
    let hasChanges = false

    for (const id in library) {
      if (library[id].profileId === profileId) {
        delete library[id]
        hasChanges = true
      }
    }

    if (hasChanges) {
      set({ library })
      await saveAddonLibrary(library)
      // Sync to cloud
      const { useSyncStore } = await import('./syncStore')
      useSyncStore.getState().syncToRemote(true).catch(console.error)
    }
  },

  toggleAutoRestore: async (id, enabled) => {
    try {
      const savedAddon = get().library[id]
      if (!savedAddon) throw new Error('Saved addon not found')

      const updatedSavedAddon = {
        ...savedAddon,
        autoRestore: enabled,
        updatedAt: new Date()
      }

      const library = { ...get().library, [id]: updatedSavedAddon }
      set({ library })
      await saveAddonLibrary(library)

      const { useSyncStore } = await import('./syncStore')
      useSyncStore.getState().syncToRemote(true).catch(console.error)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to toggle auto-restore'
      set({ error: message })
      throw error
    }
  },

  deleteSavedAddon: async (id) => {
    const library = { ...get().library }
    delete library[id]
    set({ library })
    await saveAddonLibrary(library)
    // Sync to cloud immediately
    const { useSyncStore } = await import('./syncStore')
    useSyncStore.getState().syncToRemote(true).catch(console.error)
  },

  bulkDeleteSavedAddons: async (ids) => {
    const library = { ...get().library }
    let hasChanges = false
    ids.forEach((id) => {
      if (library[id]) {
        delete library[id]
        hasChanges = true
      }
    })

    if (hasChanges) {
      set({ library })
      await saveAddonLibrary(library)
      // Sync to cloud immediately
      const { useSyncStore } = await import('./syncStore')
      useSyncStore.getState().syncToRemote(true).catch(console.error)
    }
  },

  bulkUpdateSavedAddons: async (ids, updates) => {
    const { library } = get()
    const updatedLibrary = { ...library }

    let hasChanges = false
    ids.forEach((id) => {
      const addon = updatedLibrary[id]
      if (addon) {
        // Merge tags if provided (don't blindly overwrite)
        let newTags = addon.tags
        const existingTags = new Set(addon.tags)

        if (updates.tags) {
          // Add new tags (set union)
          updates.tags.forEach((t) => existingTags.add(t))
        }

        // Remove tags if requested
        if ((updates as any).tagsRemove) {
          const tagsToRemove = new Set((updates as any).tagsRemove as string[])
          tagsToRemove.forEach(t => existingTags.delete(t as string))
        }

        newTags = Array.from(existingTags)

        updatedLibrary[id] = {
          ...addon,
          ...updates,
          tags: newTags, // Use the merged tags
          updatedAt: new Date(),
        }
        hasChanges = true
      }
    })

    if (hasChanges) {
      set({ library: updatedLibrary })
      await saveAddonLibrary(updatedLibrary)
      // Sync to cloud immediately
      const { useSyncStore } = await import('./syncStore')
      useSyncStore.getState().syncToRemote(true).catch(console.error)
    }
  },

  getSavedAddon: (id) => {
    return get().library[id] || null
  },

  // === Tag Management ===

  getSavedAddonsByTag: (tag) => {
    const normalizedTag = normalizeTagName(tag)
    return Object.values(get().library).filter((savedAddon) =>
      savedAddon.tags.some((t) => normalizeTagName(t) === normalizedTag)
    )
  },

  getAllTags: () => {
    const tagsSet = new Set<string>()
    Object.values(get().library).forEach((savedAddon) => {
      savedAddon.tags.forEach((tag) => tagsSet.add(tag))
    })
    return Array.from(tagsSet).sort()
  },

  renameTag: async (oldTag, newTag) => {
    const normalizedOld = normalizeTagName(oldTag)
    const normalizedNew = normalizeTagName(newTag)

    if (!normalizedNew) {
      throw new Error('Invalid new tag name')
    }

    const library = { ...get().library }
    let hasChanges = false

    for (const savedAddon of Object.values(library)) {
      const tagIndex = savedAddon.tags.findIndex((t) => normalizeTagName(t) === normalizedOld)
      if (tagIndex >= 0) {
        savedAddon.tags[tagIndex] = normalizedNew
        savedAddon.updatedAt = new Date()
        hasChanges = true
      }
    }

    if (hasChanges) {
      set({ library })
      await saveAddonLibrary(library)
      // Sync to cloud
      const { useSyncStore } = await import('./syncStore')
      useSyncStore.getState().syncToRemote(true).catch(console.error)
    }
  },

  // === Application (Single Saved Addon) ===

  applySavedAddonToAccount: async (
    savedAddonId,
    accountId,
    accountAuthKey
  ) => {
    set({ loading: true, error: null })
    try {
      const savedAddon = get().library[savedAddonId]
      if (!savedAddon) {
        throw new Error('Saved addon not found')
      }

      // Get current addons from account
      const authKey = await decrypt(accountAuthKey, getEncryptionKey())
      const currentAddons = await getAddons(authKey, accountId)

      // Merge the saved addon (Purely Additive)
      const { addons: updatedAddons, result } = await mergeAddons(
        currentAddons,
        [savedAddon]
      )

      // Update account addons
      await updateAddons(authKey, updatedAddons, accountId)

      // Update saved addon lastUsed
      const library = { ...get().library }
      library[savedAddonId] = { ...savedAddon, lastUsed: new Date() }
      set({ library })
      await saveAddonLibrary(library)

      // Sync account state
      await get().syncAccountState(accountId, accountAuthKey)

      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to apply saved addon'
      set({ error: message })
      throw error
    } finally {
      set({ loading: false })
    }
  },



  applySavedAddonToAccounts: async (savedAddonId, accountIds) => {
    const savedAddon = get().library[savedAddonId]
    if (!savedAddon) {
      throw new Error('Saved addon not found')
    }

    return get().bulkApplySavedAddons([savedAddonId], accountIds)
  },

  // === Application (Tag-based) ===

  applyTagToAccount: async (tag, accountId, accountAuthKey) => {
    const savedAddons = get().getSavedAddonsByTag(tag)
    if (savedAddons.length === 0) {
      throw new Error(`No saved addons found with tag: ${tag} `)
    }

    set({ loading: true, error: null })
    try {
      // Get current addons from account
      const authKey = await decrypt(accountAuthKey, getEncryptionKey())
      const currentAddons = await getAddons(authKey, accountId)

      // Merge all saved addons with this tag
      const { addons: updatedAddons, result } = await mergeAddons(
        currentAddons,
        savedAddons
      )

      // Update account addons
      await updateAddons(authKey, updatedAddons, accountId)

      // Update saved addon lastUsed for all applied saved addons
      const library = { ...get().library }
      savedAddons.forEach((savedAddon) => {
        library[savedAddon.id] = { ...savedAddon, lastUsed: new Date() }
      })
      set({ library })
      await saveAddonLibrary(library)

      // Sync account state
      await get().syncAccountState(accountId, accountAuthKey)

      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to apply tag'
      set({ error: message })
      throw error
    } finally {
      set({ loading: false })
    }
  },

  applyTagToAccounts: async (tag, accountIds) => {
    return get().bulkApplyTag(tag, accountIds)
  },

  // === Bulk Operations ===

  bulkApplySavedAddons: async (savedAddonIds, accountIds, allowProtected = false) => {
    set({ loading: true, error: null })
    try {
      const savedAddons = savedAddonIds
        .map((id) => get().library[id])
        .filter(Boolean) as SavedAddon[]

      if (savedAddons.length === 0) {
        throw new Error('No valid saved addons found')
      }

      const result: BulkResult = {
        success: 0,
        failed: 0,
        errors: [],
        details: [],
      }

      for (const { id: accountId, authKey: accountAuthKey } of accountIds) {
        try {
          const authKey = await decrypt(accountAuthKey, getEncryptionKey())
          const currentAddons = await getAddons(authKey, accountId)

          const { addons: mergedAddons, result: mergeResult } = await mergeAddons(
            currentAddons,
            savedAddons,
            accountId,
            allowProtected
          )

          // CRITICAL: Set lastUpdated timestamp for the grace period fix
          const updatedAddons = mergedAddons.map(addon => ({
            ...addon,
            metadata: {
              ...(addon.metadata || {}),
              lastUpdated: Date.now()
            }
          }))

          await updateAddons(authKey, updatedAddons, accountId)

          result.success++
          result.details.push({ accountId, result: mergeResult })

          // Sync account state
          await get().syncAccountState(accountId, accountAuthKey)
        } catch (error) {
          result.failed++
          result.errors.push({
            accountId,
            error: error instanceof Error ? error.message : 'Unknown error',
          })
        }
      }

      // Update saved addon lastUsed for all applied saved addons
      const library = { ...get().library }
      savedAddons.forEach((savedAddon) => {
        library[savedAddon.id] = { ...savedAddon, lastUsed: new Date() }
      })
      set({ library })
      await saveAddonLibrary(library)

      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to apply saved addons'
      set({ error: message })
      throw error
    } finally {
      set({ loading: false })
    }
  },

  bulkApplyTag: async (tag, accountIds) => {
    const savedAddons = get().getSavedAddonsByTag(tag)
    if (savedAddons.length === 0) {
      throw new Error(`No saved addons found with tag: ${tag} `)
    }

    return get().bulkApplySavedAddons(
      savedAddons.map((s) => s.id),
      accountIds
    )
  },

  bulkRemoveAddons: async (addonIds, accountIds, allowProtected = false) => {
    set({ loading: true, error: null })
    try {
      const result: BulkResult = {
        success: 0,
        failed: 0,
        errors: [],
        details: [],
      }

      for (const { id: accountId, authKey: accountAuthKey } of accountIds) {
        try {
          const authKey = await decrypt(accountAuthKey, getEncryptionKey())
          const currentAddons = await getAddons(authKey, accountId)

          const { addons: updatedAddons, protectedAddons } = removeAddons(currentAddons, addonIds, allowProtected)

          // CRITICAL: Clean up Autopilot rules for removed addons
          try {
            const { useFailoverStore } = await import('@/store/failoverStore')
            const failoverStore = useFailoverStore.getState()
            for (const url of addonIds) {
              await failoverStore.removeUrlFromRules(accountId, url)
            }
          } catch (e) {
            console.warn('[AddonStore] Failover cleanup failed during removal:', e)
          }

          await updateAddons(authKey, updatedAddons, accountId)

          result.success++
          result.details.push({
            accountId,
            result: {
              added: [],
              updated: [],
              skipped: [],
              protected: protectedAddons.map((id) => ({
                addonId: id,
                name: currentAddons.find((a) => a.manifest.id === id)?.manifest.name || id,
              })),
            },
          })

          // Critical: Explicitly remove from local account state to handle "disabled" addons
          // (which are preserved during sync if only missing from remote)
          const { useAccountStore } = await import('./accountStore')
          await useAccountStore.getState().removeLocalAddons(accountId, addonIds)

          // Sync account state
          await get().syncAccountState(accountId, accountAuthKey)
        } catch (error) {
          result.failed++
          result.errors.push({
            accountId,
            error: error instanceof Error ? error.message : 'Unknown error',
          })
        }
      }

      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to remove addons'
      set({ error: message })
      throw error
    } finally {
      set({ loading: false })
    }
  },

  bulkRemoveByTag: async (tag, accountIds, allowProtected = false) => {
    const savedAddons = get().getSavedAddonsByTag(tag)
    if (savedAddons.length === 0) {
      throw new Error(`No saved addons found with tag: ${tag} `)
    }

    const addonIds = savedAddons.map((s) => s.manifest.id)
    return get().bulkRemoveAddons(addonIds, accountIds, allowProtected)
  },

  bulkReinstallAddons: async (addonIds, accountIds) => {
    set({ loading: true, error: null })
    try {
      const result: BulkResult = {
        success: 0,
        failed: 0,
        errors: [],
        details: [],
      }

      for (const { id: accountId, authKey: accountAuthKey } of accountIds) {
        try {
          const authKey = await decrypt(accountAuthKey, getEncryptionKey())
          const currentAddons = await getAddons(authKey, accountId)

          // Reinstall each addon in place to preserve ordering
          const updateResults: Array<{
            addonId: string
            previousVersion?: string
            newVersion?: string
          }> = []
          const skippedResults: Array<{
            addonId: string
            reason: 'already-exists' | 'protected' | 'fetch-failed'
          }> = []

          const idsToReinstall = (addonIds.length === 1 && addonIds[0] === '*')
            ? currentAddons.map(a => a.transportUrl) // Use URLs as IDs for reinstallation lookup
            : addonIds

          for (const addonId of idsToReinstall) {
            try {
              const reinstallResult = await reinstallAddonApi(authKey, addonId, accountId)
              if (reinstallResult.updatedAddon) {
                updateResults.push({
                  addonId,
                  previousVersion: reinstallResult.previousVersion,
                  newVersion: reinstallResult.newVersion,
                })
              }
            } catch (error) {
              // Log but continue with other addons
              console.warn(`Failed to reinstall addon ${addonId} on account ${accountId}: `, error)
              skippedResults.push({
                addonId,
                reason: 'fetch-failed'
              })
            }
          }

          result.success++
          result.details.push({
            accountId,
            result: {
              added: [],
              updated: updateResults.map((r) => ({
                addonId: r.addonId,
                oldUrl: '',
                newUrl: '',
                previousVersion: r.previousVersion,
                newVersion: r.newVersion,
              })),
              skipped: skippedResults,
              protected: [],
            },
          })

          // Sync account state
          await get().syncAccountState(accountId, accountAuthKey)
        } catch (error) {
          result.failed++
          result.errors.push({
            accountId,
            error: error instanceof Error ? error.message : 'Unknown error',
          })
        }
      }

      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to reinstall addons'
      set({ error: message })
      throw error
    } finally {
      set({ loading: false })
    }
  },

  bulkInstallFromUrls: async (urls, accountIds, allowProtected = false) => {
    set({ loading: true, error: null })
    try {
      // 1. Fetch manifests for all URLs first
      const manifestsResults = await Promise.allSettled(
        urls.map((url) => fetchAddonManifest(url, 'Bulk-Pre-Install'))
      )

      const validDescriptors: any[] = [] // Type safety fallback
      const invalidUrls: string[] = []

      manifestsResults.forEach((res, index) => {
        if (res.status === 'fulfilled') {
          validDescriptors.push(res.value)
        } else {
          invalidUrls.push(urls[index])
          // console.warn(`[Bulk Install] Failed to fetch manifest for ${ urls[index]}: `, res.reason)
        }
      })

      if (validDescriptors.length === 0) {
        // If ALL failed, we throw (or maybe we just return 0 success?)
        // User wants "more information". Let's throw a descriptive error with the list.
        throw new Error(`Failed to fetch manifests from: ${invalidUrls.join(', ')} `)
      }

      // 2. Apply to accounts
      const result: BulkResult = {
        success: 0,
        failed: 0,
        errors: [],
        details: [],
      }

      for (const { id: accountId, authKey: accountAuthKey } of accountIds) {
        try {
          const authKey = await decrypt(accountAuthKey, getEncryptionKey())
          const currentAddons = await getAddons(authKey, accountId)

          const updatedAddons = [...currentAddons]
          const mergeResultDetails: MergeResult = {
            added: [],
            updated: [],
            skipped: [],
            protected: [],
          }

          // Report invalid URLs as skipped/failed for this account operation
          invalidUrls.forEach((url) => {
            mergeResultDetails.skipped.push({ addonId: url, reason: 'fetch-failed' })
          })

          for (const newAddon of validDescriptors) {
            const existingIndex = updatedAddons.findIndex(
              (a) => a.transportUrl === newAddon.transportUrl
            )

            if (existingIndex >= 0) {
              // Update behavior
              const existing = updatedAddons[existingIndex]
              if (existing.flags?.protected && !allowProtected) {
                mergeResultDetails.protected.push({
                  addonId: existing.manifest.id,
                  name: existing.manifest.name,
                })
                continue
              }
              updatedAddons[existingIndex] = newAddon
              mergeResultDetails.updated.push({
                addonId: newAddon.manifest.id,
                oldUrl: existing.transportUrl,
                newUrl: newAddon.transportUrl,
              })
            } else {
              // Add behavior
              updatedAddons.push(newAddon)
              mergeResultDetails.added.push({
                addonId: newAddon.manifest.id,
                name: newAddon.manifest.name,
                installUrl: newAddon.transportUrl,
              })
            }
          }

          await updateAddons(authKey, updatedAddons, accountId)

          invalidUrls.forEach((url) => {
            mergeResultDetails.skipped.push({ addonId: url, reason: 'fetch-failed' })
          })

          result.success++
          result.details.push({ accountId, result: mergeResultDetails })
          await get().syncAccountState(accountId, accountAuthKey)
        } catch (error) {
          result.failed++
          result.errors.push({
            accountId,
            error: error instanceof Error ? error.message : 'Unknown error',
          })
        }
      }

      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to bulk install from URLs'
      set({ error: message })
      throw error
    } finally {
      set({ loading: false })
    }
  },

  bulkCloneAccount: async (sourceAccount, targetAccountIds, overwrite = false) => {
    set({ loading: true, error: null })
    try {
      // 1. Fetch Source Addons (FROM LOCAL STATE to preserve Disabled/Protected flags)
      const { useAccountStore } = await import('./accountStore')

      // Ensure store is initialized so we don't miss local state
      if (useAccountStore.getState().accounts.length === 0) {
        await useAccountStore.getState().initialize()
      }

      const localSourceAccount = useAccountStore.getState().accounts.find(a => a.id === sourceAccount.id)

      const sourceAddons = localSourceAccount ? localSourceAccount.addons : await getAddons(await decrypt(sourceAccount.authKey, getEncryptionKey()), sourceAccount.id)

      const result: BulkResult = {
        success: 0,
        failed: 0,
        errors: [],
        details: [],
      }

      // 2. Apply to Targets
      for (const { id: accountId, authKey: accountAuthKey } of targetAccountIds) {
        if (accountId === sourceAccount.id) continue // Skip self

        try {
          const authKey = await decrypt(accountAuthKey, getEncryptionKey())

          // Get Target Addons (Use local state if available to be aware of local disabled/protected items)
          const localTargetAccount = useAccountStore.getState().accounts.find(a => a.id === accountId)
          const targetAddons = localTargetAccount ? localTargetAccount.addons : await getAddons(authKey, accountId)

          // 1. Build the new addon list
          let newAddons: AddonDescriptor[] = []

          if (overwrite) {
            // Overwrite Mode: Start fresh to mirror the source.
            // We ignore target's existing addons (including protected ones) to ensure mirror fidelity.
            newAddons = []
            console.log(`[Clone] Overwrite mode: Strictly mirroring source onto ${accountId} `)
          } else {
            // Append Mode: Keep everything from target
            newAddons = [...targetAddons]
          }

          // 2. Add source addons (Deduplicating by transportUrl to prevent ghost duplicates)
          const existingUrls = new Set(newAddons.map(a => a.transportUrl))

          sourceAddons.forEach(sourceAddon => {
            if (!existingUrls.has(sourceAddon.transportUrl)) {
              // Clone the addon, explicitly preserving flags and metadata from source
              const clonedAddon = {
                ...sourceAddon,
                flags: {
                  ...sourceAddon.flags,
                  enabled: sourceAddon.flags?.enabled ?? true,
                  protected: sourceAddon.flags?.protected ?? false
                },
                metadata: { ...sourceAddon.metadata }
              }
              newAddons.push(clonedAddon)
              existingUrls.add(sourceAddon.transportUrl)
            }
          })

          // Use reorderAddons to update both LOCAL and REMOTE state
          await useAccountStore.getState().reorderAddons(accountId, newAddons)

          result.success++
          result.details.push({
            accountId,
            result: {
              added: [],
              updated: [],
              skipped: [],
              protected: [],
            },
          })

          // 3. Clone Failover Rules (ONLY in Overwrite Mode for environment parity)
          if (overwrite) {
            const { useFailoverStore } = await import('./failoverStore')
            const failoverStore = useFailoverStore.getState()

            // 1. Clear existing rules for target account
            const existingTargetRules = failoverStore.rules.filter(r => r.accountId === accountId)
            for (const rule of existingTargetRules) {
              await failoverStore.removeRule(rule.id)
            }

            // 2. Clone rules from source account
            const sourceRules = failoverStore.rules.filter(r => r.accountId === sourceAccount.id)
            for (const rule of sourceRules) {
              // Create a fresh copy with target accountId and new UUID
              await failoverStore.addRule(accountId, [...(rule.priorityChain || [])])
            }
          }

          // Sync not needed as reorderAddons does it, but keeping it for safety
          await get().syncAccountState(accountId, accountAuthKey)
        } catch (error) {
          result.failed++
          result.errors.push({
            accountId,
            error: error instanceof Error ? error.message : 'Unknown error',
          })
        }
      }
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to clone account'
      set({ error: message })
      throw error
    } finally {
      set({ loading: false })
    }
  },

  // === Sync ===

  syncAccountState: async (accountId, accountAuthKey) => {
    try {
      // Get current addons from Stremio
      const authKey = await decrypt(accountAuthKey, getEncryptionKey())
      const currentAddons = await getAddons(authKey, accountId)

      // Get existing state
      const existingState = get().accountStates[accountId]
      const installedAddons: InstalledAddon[] = []

      for (const addon of currentAddons) {
        const existing = existingState?.installedAddons.find(
          (a) => a.installUrl === addon.transportUrl
        )

        if (existing) {
          // Update existing
          installedAddons.push({
            ...existing,
            installUrl: addon.transportUrl,
          })
        } else {
          // New addon - try to auto-link to saved addon
          const matchingSavedAddon = findSavedAddonByUrl(get().library, addon.transportUrl)

          installedAddons.push({
            savedAddonId: matchingSavedAddon?.id || null,
            addonId: addon.manifest?.id || '',
            installUrl: addon.transportUrl,
            installedAt: new Date(),
            installedVia: matchingSavedAddon ? 'saved-addon' : 'manual',
            appliedTags: matchingSavedAddon?.tags,
          })
        }
      }

      const state: AccountAddonState = {
        accountId,
        installedAddons,
        lastSync: new Date(),
      }

      const accountStates = { ...get().accountStates, [accountId]: state }
      set({ accountStates })
      await saveAccountAddonStates(accountStates)

      // CRITICAL: Trigger Dashboard Refresh
      const { useAccountStore } = await import('./accountStore')
      await useAccountStore.getState().syncAccount(accountId)

      // Sync the new account state to cloud immediately
      const { useSyncStore } = await import('./syncStore')
      useSyncStore.getState().syncToRemote(true).catch(console.error)
    } catch (error) {
      console.error('Failed to sync account state:', error)
      throw error
    }
  },

  syncAllAccountStates: async (accounts) => {
    for (const account of accounts) {
      try {
        await get().syncAccountState(account.id, account.authKey)
      } catch (error) {
        console.error(`Failed to sync account ${account.id}: `, error)
      }
    }
  },

  // === Import/Export ===

  exportLibrary: () => {
    const library = get().library
    return JSON.stringify(
      {
        version: '1.0',
        exportedAt: new Date().toISOString(),
        savedAddons: Object.values(library),
      },
      null,
      2
    )
  },

  importLibrary: async (json, merge, isSilent = false) => {
    set({ loading: true, error: null })
    console.log("%c[AddonStore] Importing library with SECURE HARDENING", "color: green; font-weight: bold;")
    try {
      // Resilience check: Handle already-parsed objects, strings, or nulls
      let data: any
      if (!json) {
        data = {}
      } else if (typeof json === 'object') {
        data = json
      } else if (typeof json === 'string') {
        if (json.includes('[object Object]')) {
          console.error('Critical: Received "[object Object]" string in importLibrary. Aborting to prevent data loss.')
          throw new Error('Remote library data is corrupted (Double-encoded object). Aborting sync.')
        } else {
          try {
            data = JSON.parse(json)
          } catch (e) {
            console.error('Failed to parse library JSON:', json ? json.substring(0, 100) : 'null')
            throw new Error('Failed to parse library data. Aborting to prevent data loss.')
          }
        }
      } else {
        data = {}
      }

      // Safety fallback: If data is empty or null, just treat as empty library
      if (!data || (typeof data === 'object' && Object.keys(data).length === 0)) {
        if (!merge) {
          set({ library: {} })
          await saveAddonLibrary({})
        }
        return
      }

      // Support exhaustive legacy scavenging
      // 1. Check for raw database dump key: 'stremio-manager:addon-library'
      // 2. Check for legacy export keys: 'savedAddons', 'templates'
      // 3. Check for new full-sync structure: 'addons.savedAddons'
      let scavengedData = data.savedAddons ||
        data['stremio-manager:addon-library'] ||
        data.templates ||
        data.addons?.savedAddons ||
        (Array.isArray(data) ? data : null)

      // If we found an object (raw database map), convert it to an array
      if (scavengedData && !Array.isArray(scavengedData) && typeof scavengedData === 'object') {
        scavengedData = Object.values(scavengedData)
      }

      const savedAddons = scavengedData || []

      const manifestMap = data.manifests || data.addons?.manifests || {}

      if (!savedAddons || !Array.isArray(savedAddons)) {
        console.warn('[AddonStore] No valid addon data found in import object.')
      }

      const currentLibrary = merge ? { ...get().library } : {}

      for (const newItem of savedAddons) {
        // Validate basic structure
        if (!newItem.id || !newItem.installUrl) {
          console.warn('Skipping invalid item (Missing ID or URL):', newItem)
          continue
        }

        // Inflate manifest from map if missing
        if (!newItem.manifest && newItem.manifestId && manifestMap[newItem.manifestId]) {
          newItem.manifest = manifestMap[newItem.manifestId]
        }

        // Final Manifest Resilience: If still missing, try to construct a minimal one or fetch it later
        if (!newItem.manifest) {
          console.warn(`[AddonStore] Item ${newItem.name || newItem.id} is missing a manifest.Attempting recovery...`)

          // If we have an install URL, we can at least try to pull the manifest later via initialize()
          // For now, we construct a "placeholder" manifest to allow the import to succeed
          if (newItem.installUrl) {
            newItem.manifest = {
              id: 'pending-sync-' + newItem.id,
              name: newItem.name || 'Recovering Addon...',
              version: '0.0.0',
              description: 'Manifest is being recovered from the source URL.',
              types: [],
              resources: [],
              catalogs: []
            } as any
          } else {
            console.error(`[AddonStore] Skipping item ${newItem.id} - No manifest and no installUrl for recovery.`)
            continue
          }
        }

        // Check if exists
        const existing = currentLibrary[newItem.id]
        if (existing) {
          // Merge strategy: Overwrite manual fields, keep local createdAt if possible
          currentLibrary[newItem.id] = {
            ...existing,
            ...newItem,
            updatedAt: new Date(),
          }
        } else {
          currentLibrary[newItem.id] = {
            ...newItem,
            createdAt: newItem.createdAt ? new Date(newItem.createdAt) : new Date(),
            updatedAt: new Date(),
          }
        }
      }

      set({ library: currentLibrary })
      await saveAddonLibrary(currentLibrary)

      if (!isSilent) {
        const { useSyncStore } = await import('./syncStore')
        useSyncStore.getState().syncToRemote(true).catch(console.error)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to import library'
      set({ error: message })
      throw error
    } finally {
      set({ loading: false })
    }
  },

  // === Health Checking ===

  checkAllHealth: async () => {
    // Idle Optimization: Skip health checks if the tab is hidden
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return

    const { library, checkingHealth, lastHealthCheck } = get()
    if (checkingHealth) return

    // Throttling: 3-minute cooldown for full health checks to prevent UI lag
    const COOLDOWN = 3 * 60 * 1000
    if (lastHealthCheck && (Date.now() - lastHealthCheck < COOLDOWN)) {
      console.log(`[Health] Skipping checkAllHealth(Cooldown: ${Math.round((COOLDOWN - (Date.now() - lastHealthCheck)) / 1000)}s remaining)`)
      return
    }

    set({ checkingHealth: true })
    try {
      const addons = Object.values(library)
      const results = await checkAllAddonsHealth(addons)

      const updatedLibrary = { ...library }
      let hasChanges = false

      results.forEach(async (result) => {
        const addon = updatedLibrary[result.id]
        if (!addon) return

        const isOnline = result.health?.isOnline ?? false

        updatedLibrary[result.id] = {
          ...addon,
          health: {
            isOnline,
            lastChecked: Date.now(),
          },
          updatedAt: new Date(),
        }
        hasChanges = true

        // Restoration Logic
        if (!isOnline && addon.autoRestore) {
          if (restorationManager.canAttemptRestore(addon.installUrl, true)) {
            console.log(`[Restoration] Attempting recovery for: ${addon.name} `)
            restorationManager.recordAttempt(addon.installUrl)

            try {
              // Generic Restoration: Attempt to re-fetch manifest or re-apply
              // For now, we'll try to update the manifest which re-validates the URL
              await get().updateSavedAddonManifest(addon.id)
              restorationManager.recordSuccess(addon.installUrl)
              console.log(`[Restoration] Successfully recovered: ${addon.name} `)
            } catch (err) {
              restorationManager.recordFailure(addon.installUrl)
              console.warn(`[Restoration] Recovery failed for ${addon.name}: `, err)
            }
          }
        } else if (isOnline && addon.autoRestore) {
          restorationManager.recordSuccess(addon.installUrl)
        }
      })

      if (hasChanges) {
        set({ library: updatedLibrary, lastHealthCheck: Date.now() })
        saveAddonLibrary(updatedLibrary)
      } else {
        set({ lastHealthCheck: Date.now() })
      }
    } catch (error) {
      console.error('Health check failed:', error)
    } finally {
      set({ checkingHealth: false })
    }
  },

  updateHealthStatus: async (statuses: Array<{ id: string; isOnline: boolean }>) => {
    const library = { ...get().library }
    let hasChanges = false

    statuses.forEach(({ id, isOnline }) => {
      if (library[id]) {
        library[id] = {
          ...library[id],
          health: {
            isOnline,
            lastChecked: Date.now(),
          },
        }
        hasChanges = true
      }
    })

    if (hasChanges) {
      set({ library })
      await saveAddonLibrary(library)
    }
  },

  clearError: () => set({ error: null }),

  importAccountStates: async (states: Record<string, any>) => {
    const currentStates = { ...get().accountStates, ...states }
    set({ accountStates: currentStates })
    await localforage.setItem('stremio-manager:account-addons', currentStates)
  },
  reset: async () => {
    set({
      library: {},
      latestVersions: {},
      accountStates: {},
      error: null,
      loading: false,
    })
    await Promise.all([
      localforage.removeItem('stremio-manager:addon-library'),
      localforage.removeItem('stremio-manager:account-addons'),
    ])
  },
  replaceTransportUrlUniversally: async (savedAddonId, oldUrl, newUrl, accountId) => {
    set({ loading: true, error: null })
    try {
      const normOld = normalizeAddonUrl(oldUrl).toLowerCase()
      const normNew = normalizeAddonUrl(newUrl).toLowerCase()

      if (normOld === normNew) return

      // 1. Fetch fresh manifest for the NEW URL to enable "Silent Reinstall"
      let freshManifest = null
      try {
        const { fetchAddonManifest } = await import('@/api/addons')
        const { identifyAddon } = await import('@/lib/addon-identifier')
        const descriptor = await fetchAddonManifest(newUrl, 'System-Check')
        freshManifest = identifyAddon(newUrl, descriptor.manifest)
      } catch (err) {
        console.warn('[AddonStore] Could not fetch fresh manifest for silent reinstall, falling back to URL swap only.', err)
      }

      // 2. Update Library if applicable
      // ONLY update library if we are NOT scoping to a specific account (or if we explicitly want to update the template)
      if (savedAddonId) {
        const savedAddon = get().library[savedAddonId]
        if (savedAddon) {
          const updatedSavedAddon = {
            ...savedAddon,
            installUrl: newUrl,
            manifest: freshManifest || savedAddon.manifest,
            updatedAt: new Date(),
          }

          const library = { ...get().library, [savedAddonId]: updatedSavedAddon }
          set({ library })
          await saveAddonLibrary(library)
          console.log(`[AddonStore] Library URL updated for "${savedAddon.name}"`)
        }
      }

      // 3. Update accounts via AccountStore (with optional scoping)
      const { useAccountStore } = await import('@/store/accountStore')
      await useAccountStore.getState().replaceTransportUrl(oldUrl, newUrl, accountId, freshManifest)

      // 4. Update Autopilot rules via FailoverStore (with optional scoping)
      const { useFailoverStore } = await import('@/store/failoverStore')
      await useFailoverStore.getState().replaceUrlInRules(oldUrl, newUrl, accountId)

      // 5. Sync to cloud
      const { useSyncStore } = await import('./syncStore')
      useSyncStore.getState().syncToRemote(true).catch(console.error)

      console.log(`[AddonStore] Scoped URL replacement complete: ${oldUrl.substring(0, 30)}... -> ${newUrl.substring(0, 30)}... (Account: ${accountId || 'Global'})`)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to replace URL universally'
      set({ error: message })
      console.error('[AddonStore] Universal replacement failed:', error)
      throw error
    } finally {
      set({ loading: false })
    }
  },

  bulkReinstallAllOnAccount: async (accountId, accountAuthKey) => {
    // Convenience wrapper for single account "Reinstall All"
    return get().bulkReinstallAddons(['*'], [{ id: accountId, authKey: accountAuthKey }])
  },
}))
