import { triggerSync } from '@/lib/sync-trigger'
import { fetchAddonManifest } from '@/api/addons'
import { identifyAddon } from '@/lib/addon-identifier'
import { checkAllAddonsHealth } from '@/lib/addon-health'
import { getAddonVersionKey, normalizeAddonUrl } from '@/lib/utils'
import {
  loadAccountAddonStates,
  loadAddonLibrary,
  saveAccountAddonStates,
  saveAddonLibrary,
} from '@/lib/addon-storage'
import { normalizeTagName } from '@/lib/addon-validator'

import { useAccountStore, type ReplaceTransportUrlResult } from '@/store/accountStore'
import { AddonManifest, AddonDescriptor } from '@/types/addon'
import type { Account } from '@/types/account'
import { getEffectiveManifest } from '@/lib/addon-utils'
import { isPlaceholderManifest, getKnownManifest } from '@/lib/manifest-placeholder'
import {
  AccountAddonState,
  BulkResult,
  MergeResult,
  SavedAddon,
  SavedAddonManifestChangeSummary,
  SavedAddonManifestUpdateResult,
} from '@/types/saved-addon'
import { create } from 'zustand'
import localforage from 'localforage'
import { restorationManager } from '@/lib/autopilot/restorationManager'
import type { CloneMode } from '@/lib/clone-mode'
import { captureSyncOwnership, type SyncOwnership } from './sync-store-helpers'

import { SAVED_ADDON_ACCOUNT_CONCURRENCY } from './addon/deployment-constants'
import { guardedImport } from '@/lib/lazy-chunk'

// Deployment code stays out of the boot chunk; a failed chunk load (deploy
// window, transient network error) reloads the tab once instead of surfacing
// every deploy action as a bare rejection.
const loadAddonDeployment = guardedImport(() => import('./addon/addonDeployment'))
import { updateSavedAddonManifest } from './addon/addonManifest'
import { mapConcurrent } from '@/lib/concurrency'

export const _outboundSyncInProgress = new Set<string>()

// Linked copies that run their own URL (for example a person's own config). Keep in sync
// leaves that URL and its manifest alone but still sends them the library's name, logo
// and description.
function linkedOwnUrlCopies(saved: SavedAddon, accountStates: Record<string, AccountAddonState>): Array<{ accountId: string; url: string }> {
  const scope = Array.isArray(saved.syncAccountIds) ? new Set(saved.syncAccountIds) : null
  const libraryUrl = normalizeAddonUrl(saved.installUrl)
  const copies: Array<{ accountId: string; url: string }> = []
  for (const [accountId, state] of Object.entries(accountStates)) {
    if (scope && !scope.has(accountId)) continue
    for (const installed of state?.installedAddons || []) {
      if (installed.savedAddonId === saved.id && normalizeAddonUrl(installed.installUrl) !== libraryUrl) {
        copies.push({ accountId, url: installed.installUrl })
      }
    }
  }
  return copies
}

const LIBRARY_DISPLAY_KEYS = ['customName', 'customLogo', 'customDescription'] as const

async function pushMetadataToOwnUrlCopies(saved: SavedAddon, accountStates: Record<string, AccountAddonState>, metadata: SavedAddon['metadata']) {
  await mapConcurrent(linkedOwnUrlCopies(saved, accountStates), SAVED_ADDON_ACCOUNT_CONCURRENCY, async ({ accountId, url }) => {
    try {
      const mergeDisplay = (current: AddonDescriptor['metadata']) => {
        const merged: Record<string, unknown> = { ...(current || {}) }
        for (const key of LIBRARY_DISPLAY_KEYS) {
          const value = metadata?.[key]
          if (value === undefined) delete merged[key]
          else merged[key] = value
        }
        return merged as AddonDescriptor['metadata']
      }
      await useAccountStore.getState().replaceTransportUrl(url, url, accountId, undefined, mergeDisplay)
    } catch (error) {
      if (import.meta.env.DEV) console.error(`[AddonStore] Metadata sync failed for account ${accountId}:`, error)
    }
  })
}

function anyTargetAccountHasUrl(url: string, targetAccountIds: string[] | null): boolean {
  const norm = normalizeAddonUrl(url)
  return useAccountStore.getState().accounts.some(account =>
    (targetAccountIds === null || targetAccountIds.includes(account.id)) &&
    account.addons.some(addon => normalizeAddonUrl(addon.transportUrl) === norm)
  )
}

async function persistPendingUrlSync(id: string, fromUrl: string, toUrl: string, failedAccountIds: string[]) {
  const entry = useAddonStore.getState().library[id]
  if (!entry) return
  const library = {
    ...useAddonStore.getState().library,
    [id]: { ...entry, pendingUrlSync: { fromUrl, toUrl, failedAccountIds } },
  }
  useAddonStore.setState({ library })
  await saveAddonLibrary(library)
}

const BACKOFF_STORAGE_KEY = 'aio:self-repair-backoff'
const SELF_REPAIR_COOLDOWN_MS = 60 * 60 * 1000

const selfRepairBackoff = {
  _cache: new Map<string, number>(),
  _load() {
    try {
      const raw = sessionStorage.getItem(BACKOFF_STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, number>
        const now = Date.now()
        for (const [k, v] of Object.entries(parsed)) {
          if (now - v < SELF_REPAIR_COOLDOWN_MS) this._cache.set(k, v)
        }
        this._flush()
      }
    } catch {
      return
    }
  },
  _flush() {
    try {
      const obj: Record<string, number> = {}
      for (const [k, v] of this._cache) obj[k] = v
      sessionStorage.setItem(BACKOFF_STORAGE_KEY, JSON.stringify(obj))
    } catch {
      return
    }
  },
  get(key: string): number | undefined { return this._cache.get(key) },
  set(key: string, ts: number) { this._cache.set(key, ts); this._flush() },
  delete(key: string) { this._cache.delete(key); this._flush() },
}
selfRepairBackoff._load()

let _saveDebounceTimer: ReturnType<typeof setTimeout> | null = null

export const _saveLibraryDebounced = (getState: () => AddonStore) => {
  if (_saveDebounceTimer) clearTimeout(_saveDebounceTimer)
  _saveDebounceTimer = setTimeout(async () => {
    try {
      await saveAddonLibrary(getState().library)
      _saveDebounceTimer = null
    } catch (err) {
      if (import.meta.env.DEV) console.error('[AddonStore] Debounced save failed:', err)
    }
  }, 500)
}

export interface AddonStore {
  library: Record<string, SavedAddon>
  latestVersions: Record<string, string>
  manifestChangeHints: Record<string, SavedAddonManifestChangeSummary>
  accountStates: Record<string, AccountAddonState>
  loading: boolean
  isUpdatingAddon: boolean
  error: string | null
  checkingHealth: boolean

  initialize: (ownership?: SyncOwnership) => Promise<void>

  updateLatestVersions: (versions: Record<string, string>) => void
  updateManifestChangeHints: (hints: Record<string, SavedAddonManifestChangeSummary>) => void
  getLatestVersion: (manifestId: string) => string | undefined

  createSavedAddon: (
    name: string,
    installUrl: string,
    tags?: string[],
    profileId?: string,
    existingManifest?: AddonManifest,
    metadata?: SavedAddon['metadata'],
    catalogOverrides?: SavedAddon['catalogOverrides']
  ) => Promise<string>
  updateSavedAddon: (
    id: string,
    updates: Partial<Pick<SavedAddon, 'name' | 'tags' | 'installUrl' | 'syncWithInstalled' | 'syncAccountIds' | 'manifest'>> & { profileId?: string | null; metadata?: SavedAddon['metadata'] }
  ) => Promise<void>
  updateSavedAddonMetadata: (
    id: string,
    metadata: Record<string, unknown>,
    skipOutbound?: boolean
  ) => Promise<void>
  bulkUpdateSavedAddons: (
    ids: string[],
    updates: Partial<Pick<SavedAddon, 'tags' | 'profileId' | 'syncWithInstalled'>> & { tagsRemove?: string[] }
  ) => Promise<void>
  bulkDeleteSavedAddons: (ids: string[]) => Promise<void>
  updateSavedAddonManifest: (id: string) => Promise<SavedAddonManifestUpdateResult>
  reorderSavedAddons: (orderedIds: string[]) => Promise<void>
  deleteSavedAddon: (id: string) => Promise<void>
  deleteSavedAddonsByProfile: (profileId: string) => Promise<void>
  getSavedAddon: (id: string) => SavedAddon | null

  getSavedAddonsByTag: (tag: string) => SavedAddon[]
  getAllTags: () => string[]
  renameTag: (oldTag: string, newTag: string) => Promise<void>

  applySavedAddonToAccount: (
    savedAddonId: string,
    accountId: string,
    accountAuthKey: string
  ) => Promise<MergeResult>
  applySavedAddonToAccounts: (
    savedAddonId: string,
    accountIds: Array<{ id: string; authKey: string }>
  ) => Promise<BulkResult>

  applyTagToAccount: (
    tag: string,
    accountId: string,
    accountAuthKey: string
  ) => Promise<MergeResult>
  applyTagToAccounts: (
    tag: string,
    accountIds: Array<{ id: string; authKey: string }>
  ) => Promise<BulkResult>
  importAccountStates: (states: Record<string, AccountAddonState>, ownership?: SyncOwnership) => Promise<void>

  bulkApplySavedAddons: (
    savedAddonIds: string[],
    accountIds: Array<{ id: string; authKey: string }>,
    allowProtected?: boolean,
    options?: { batch?: AbortController }
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
    accountIds: Array<{ id: string; authKey: string }>,
    allowProtected?: boolean,
    onProgress?: (current: number, total: number) => void,
    options?: { skipConnectionPlatforms?: string[] }
  ) => Promise<BulkResult>
  bulkInstallFromUrls: (
    urls: string[],
    accountIds: Array<{ id: string; authKey: string }>,
    allowProtected?: boolean
  ) => Promise<BulkResult>
  bulkReplaceUrl: (
    find: string,
    replace: string,
    accountIds: Array<{ id: string; authKey: string }>
  ) => Promise<BulkResult>
  bulkCloneAccount: (
    sourceAccount: { id: string; authKey: string },
    targetAccountIds: Array<{ id: string; authKey: string }>,
    overwrite?: boolean,
    cloneMode?: CloneMode
  ) => Promise<BulkResult>
  bulkSyncOrder: (
    sourceAccountId: string,
    targetAccountIds: Array<{ id: string; authKey: string }>
  ) => Promise<BulkResult>
  bulkReinstallAllOnAccount: (accountId: string, accountAuthKey: string) => Promise<BulkResult>

  syncAccountState: (accountId: string, accountAuthKey: string, addons?: AddonDescriptor[]) => Promise<void>
  syncAllAccountStates: (accounts: Account[]) => Promise<void>
  toggleAutoRestore: (id: string, enabled: boolean) => Promise<void>
  lastHealthCheck?: number

  exportLibrary: (forSync?: boolean) => string | Record<string, unknown>
  importLibrary: (json: string | Record<string, unknown>, merge: boolean, isSilent?: boolean, isImmediate?: boolean, ownership?: SyncOwnership) => Promise<void>

  checkAllHealth: (deferUntilQuiet?: boolean) => Promise<void>
  updateHealthStatus: (statuses: Array<{ id: string; isOnline: boolean }>) => Promise<void>

  clearError: () => void
  reset: () => Promise<void>
  deleteAccountState: (accountId: string) => Promise<void>
  repairLibrary: () => Promise<void>
  setAddonSyncToLibrary: (accountId: string, transportUrl: string, value: boolean) => Promise<void>
  replaceTransportUrlUniversally: (savedAddonId: string | null, oldUrl: string, newUrl: string, accountId?: string, descriptor?: AddonDescriptor) => Promise<ReplaceTransportUrlResult>
}

// Health probes wait out the page's own download window so the grid paints first.
// The run flag spans the deferral too, so a second caller cannot double-start the batch.
let healthRunInFlight = false

function waitForPageQuiet(quietMs = 1800, maxWaitMs = 5000): Promise<void> {  return new Promise(resolve => {
    if (typeof window === 'undefined' || typeof requestAnimationFrame !== 'function' || !performance?.getEntriesByType) {
      setTimeout(resolve, quietMs)
      return
    }
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const startedAt = performance.now()
      const poll = () => {
        const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[]
        let lastEnd = 0
        for (let i = Math.max(0, entries.length - 60); i < entries.length; i++) {
          lastEnd = Math.max(lastEnd, entries[i].startTime + entries[i].duration)
        }
        const now = performance.now()
        if (now - Math.max(lastEnd, startedAt) >= quietMs || now - startedAt >= maxWaitMs) resolve()
        else setTimeout(poll, 200)
      }
      poll()
    }))
  })
}

export const useAddonStore = create<AddonStore>((set, get) => ({
  library: {},
  latestVersions: {},
  manifestChangeHints: {},
  accountStates: {},
  loading: false,
  isUpdatingAddon: false,
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

  initialize: async (ownership?: SyncOwnership) => {
    const own = ownership ?? captureSyncOwnership()
    try {
      const [library, accountStates, latestVersions] = await Promise.all([
        loadAddonLibrary(),
        loadAccountAddonStates(),
        localforage.getItem<Record<string, string>>('aioman:latest-versions'),
      ])

      // Recheck ownership before publishing hydrated state.
      own.assert()
      set({
        library,
        accountStates,
        latestVersions: latestVersions || {},
      })

      ;(async () => {
        const broken = Object.values(library).filter(addon =>
          !addon.manifest ||
          (addon.manifest as unknown as Record<string, unknown>).error === true ||
          addon.manifest.id?.startsWith('pending-sync-') ||
          !addon.manifest.name ||
          !addon.manifest.resources ||
          addon.manifest.version === '0.0.0'
        )
        if (broken.length === 0) return

        if (import.meta.env.DEV) console.log(`[AddonStore] Self-repair: ${broken.length} addons with missing/broken manifests`)
        let repaired = 0
        for (let i = 0; i < broken.length; i += 3) {
          // Fence detached repairs before publishing, updating cooldowns, or saving.
          if (!own.current()) return
          await Promise.allSettled(broken.slice(i, i + 3).map(async (addon) => {
            const lastFailure = selfRepairBackoff.get(addon.installUrl)
            if (lastFailure && (Date.now() - lastFailure < SELF_REPAIR_COOLDOWN_MS)) return
            try {
              const descriptor = await fetchAddonManifest(addon.installUrl, 'Self-Repair')
              if (!own.current()) return
              const freshManifest = identifyAddon(addon.installUrl, descriptor.manifest)
              set(state => ({
                library: {
                  ...state.library,
                  [addon.id]: {
                    ...state.library[addon.id],
                    manifest: getEffectiveManifest({ ...state.library[addon.id], manifest: freshManifest }),
                    updatedAt: new Date(),
                  },
                },
              }))
              selfRepairBackoff.delete(addon.installUrl)
              repaired++
            } catch (e) {
              if (!own.current()) return
              selfRepairBackoff.set(addon.installUrl, Date.now())
              if (import.meta.env.DEV) console.warn(`[Self-Repair] Failed for ${addon.name || addon.installUrl}:`, e)
            }
          }))
        }
        if (repaired > 0) {
          if (!own.current()) return
          await saveAddonLibrary(get().library)
          if (import.meta.env.DEV) console.log(`[AddonStore] Self-repair complete: ${repaired} manifests fixed`)
        }
      })()
    } catch (error) {
      if (import.meta.env.DEV) console.error('Failed to initialize addon store:', error)
      // A superseded initialization publishes no error state either.
      if (own.current()) set({ error: 'Failed to load addon data' })
    }
  },

  repairLibrary: async () => {
    const library = { ...get().library }
    let hasChanges = false
    let fixedCount = 0

    for (const id in library) {
      const addon = { ...library[id] }
      if (typeof addon.profileId === 'object' && addon.profileId !== null) {
        if (import.meta.env.DEV) console.warn(`[Rescue] Found corrupted profileId for addon ${addon.name}. Removing it.`)
        delete (addon as unknown as Record<string, unknown>).profileId
        library[id] = addon
        hasChanges = true
        fixedCount++
      }
    }

    if (hasChanges) {
      set({ library })
      _saveLibraryDebounced(get)
      if (import.meta.env.DEV) console.log(`[Rescue] Successfully rescued ${fixedCount} addons from the abyss!`)
      triggerSync()
    }
  },

  setAddonSyncToLibrary: async (accountId, transportUrl, value) => {
    const { accountStates } = get()
    const newAccountStates = { ...accountStates }
    const accountState = newAccountStates[accountId]

    if (!accountState) return

    let targetFound = false
    const updatedInstalledAddons = accountState.installedAddons.map(addon => {
      if (addon.installUrl === transportUrl) {
        targetFound = true
        return { ...addon, syncToLibrary: value }
      }
      return addon
    })

    if (!targetFound) return

    newAccountStates[accountId] = {
      ...accountState,
      installedAddons: updatedInstalledAddons,
      lastSync: new Date()
    }

    if (value) {
      Object.keys(newAccountStates).forEach(otherAccountId => {
        if (otherAccountId === accountId) return

        const otherState = newAccountStates[otherAccountId]
        let otherChanged = false
        const otherUpdatedAddons = otherState.installedAddons.map(addon => {
          if (addon.installUrl === transportUrl && addon.syncToLibrary) {
            otherChanged = true
            return { ...addon, syncToLibrary: false }
          }
          return addon
        })

        if (otherChanged) {
          newAccountStates[otherAccountId] = {
            ...otherState,
            installedAddons: otherUpdatedAddons,
            lastSync: new Date()
          }
        }
      })
    }

    set({ accountStates: newAccountStates })
    await saveAccountAddonStates(newAccountStates)
  },

  updateLatestVersions: (versions) => {
    const merged = { ...get().latestVersions, ...versions }

    const { accounts } = useAccountStore.getState()
    const library = get().library

    const liveIds = new Set<string>()
    for (const account of accounts) {
      for (const addon of account.addons) {
        if (addon.manifest?.id) {
          liveIds.add(addon.manifest.id)
          liveIds.add(getAddonVersionKey(addon))
        }
      }
    }
    for (const savedAddon of Object.values(library)) {
      if (savedAddon.manifest?.id) {
        liveIds.add(savedAddon.manifest.id)
        liveIds.add(getAddonVersionKey({
          transportUrl: savedAddon.installUrl,
          manifest: savedAddon.manifest,
        }))
      }
    }

    const pruned: Record<string, string> = {}
    for (const [id, version] of Object.entries(merged)) {
      if (liveIds.has(id)) pruned[id] = version
    }

    set({ latestVersions: pruned })
    localforage.setItem('aioman:latest-versions', pruned).catch(e => { if (import.meta.env.DEV) console.error(e) })
  },

  updateManifestChangeHints: (hints) => {
    set({ manifestChangeHints: hints })
  },

  getLatestVersion: (manifestId) => {
    return get().latestVersions[manifestId]
  },

  createSavedAddon: async (name, installUrl, tags = [], profileId, existingManifest, metadata, catalogOverrides) => {
    set({ loading: true, error: null })
    try {
      let manifest = (existingManifest as unknown as Record<string, unknown> & { manifest?: AddonManifest })?.manifest || existingManifest

      if (manifest && isPlaceholderManifest(manifest)) manifest = getKnownManifest(installUrl) ?? manifest

      if (!manifest) {
        const addonDescriptor = await fetchAddonManifest(installUrl, 'System-Check')
        manifest = getEffectiveManifest({ ...addonDescriptor, catalogOverrides })
      }

      const normalizedTags = tags.map(normalizeTagName).filter(Boolean)

      let addonName = name.trim()
      if (!addonName || addonName === 'Unknown Addon') {
        const identified = identifyAddon(installUrl, manifest || undefined)
        addonName = identified.name
        if (!manifest) manifest = identified
      }

      const normUrl = normalizeAddonUrl(installUrl)
      const existingAddon = Object.values(get().library).find(
        (addon) => normalizeAddonUrl(addon.installUrl) === normUrl
      )

      if (existingAddon) {
        if (existingAddon.profileId === profileId) {
          return existingAddon.id
        }
      }

      const savedAddon: SavedAddon = {
        id: crypto.randomUUID(),
        name: addonName,
        installUrl,
        manifest,
        originalManifest: manifest,
        tags: normalizedTags,
        profileId,
        metadata,
        catalogOverrides,
        autoRestore: false,
        syncWithInstalled: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        sourceType: 'manual',
      }

      const library = { ...get().library, [savedAddon.id]: savedAddon }
      set({ library })
      _saveLibraryDebounced(get)

      triggerSync()

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
    set({ isUpdatingAddon: true, error: null })
    try {
      const savedAddon = get().library[id]
      if (!savedAddon) {
        throw new Error('Saved addon not found')
      }

      const updatedSavedAddon = { ...savedAddon }

      if (updates.name !== undefined) {
        updatedSavedAddon.name = updates.name.trim()
        updatedSavedAddon.metadata = {
          ...(updatedSavedAddon.metadata || {}),
          customName: updatedSavedAddon.name
        }
      }
      if (updates.tags !== undefined) {
        updatedSavedAddon.tags = updates.tags.map(normalizeTagName).filter(Boolean)
      }
      if (updates.profileId !== undefined) {
        updatedSavedAddon.profileId = updates.profileId || undefined
      }
      if (updates.syncWithInstalled !== undefined) {
        updatedSavedAddon.syncWithInstalled = updates.syncWithInstalled
      }
      if (updates.syncAccountIds !== undefined) {
        updatedSavedAddon.syncAccountIds = updates.syncAccountIds
      }

      const syncTargets = (target: SavedAddon) => {
        const ids = target.syncAccountIds
        // Tri-state: an explicit [] means "sync to NO accounts" (routed to the '__none__' branch
        // below); null/undefined means "no explicit targeting" = ALL accounts. Do NOT change this
        // to a `length > 0` check — that would silently convert "sync to nobody" into "sync to everyone".
        return Array.isArray(ids) ? ids : null
      }

      if (updates.manifest !== undefined) {
        updatedSavedAddon.manifest = updates.manifest
      }

      if (updates.metadata !== undefined) {
        updatedSavedAddon.metadata = { ...updatedSavedAddon.metadata, ...updates.metadata }
        if (updates.metadata.customName) {
          updatedSavedAddon.name = updates.metadata.customName
        }
      }

      const syncEnabled = updates.syncWithInstalled ?? savedAddon.syncWithInstalled
      const urlChanged = Boolean(updates.installUrl) && updates.installUrl !== savedAddon.installUrl
      let retryFromUrl: string | null = null
      if (updates.installUrl && !urlChanged && savedAddon.pendingUrlSync && savedAddon.pendingUrlSync.toUrl === updates.installUrl) {
        if (anyTargetAccountHasUrl(savedAddon.pendingUrlSync.fromUrl, syncTargets(updatedSavedAddon))) {
          retryFromUrl = savedAddon.pendingUrlSync.fromUrl
        } else {
          delete updatedSavedAddon.pendingUrlSync
        }
      }

      if (updates.installUrl && syncEnabled && (urlChanged || retryFromUrl !== null)) {
        const fromUrl = urlChanged ? savedAddon.installUrl : (retryFromUrl as string)
        const newUrl = updates.installUrl

        const descriptor = await fetchAddonManifest(newUrl, 'System-Check')

        updatedSavedAddon.installUrl = newUrl
        updatedSavedAddon.updatedAt = new Date()
        delete updatedSavedAddon.pendingUrlSync
        const library = { ...get().library, [id]: updatedSavedAddon }
        set({ library })
        if (updates.syncWithInstalled !== undefined) {
          await saveAddonLibrary(library)
        } else {
          _saveLibraryDebounced(get)
        }
        triggerSync()

        const targets = syncTargets(updatedSavedAddon)
        const failedTargets: Array<{ accountId: string; error: string }> = []

        if (targets && targets.length > 0) {
          await mapConcurrent(targets, SAVED_ADDON_ACCOUNT_CONCURRENCY, async (targetAccountId) => {
            try {
              await get().replaceTransportUrlUniversally(id, fromUrl, newUrl, targetAccountId, descriptor)
            } catch (error) {
              failedTargets.push({ accountId: targetAccountId, error: error instanceof Error ? error.message : 'Unknown error' })
            }
          })
        } else if (targets) {
          await get().replaceTransportUrlUniversally(id, fromUrl, newUrl, '__none__', descriptor)
        } else {
          try {
            await get().replaceTransportUrlUniversally(id, fromUrl, newUrl, undefined, descriptor)
          } catch (error) {
            await persistPendingUrlSync(id, fromUrl, newUrl, [])
            throw error
          }
        }

        if (failedTargets.length > 0) {
          await persistPendingUrlSync(id, fromUrl, newUrl, failedTargets.map(failed => failed.accountId))
          const accountName = (accountId: string) => useAccountStore.getState().accounts.find(a => a.id === accountId)?.name || accountId
          const failedSummary = failedTargets.map(failed => `${accountName(failed.accountId)}: ${failed.error}`).join(', ')
          throw new Error(`New URL applied to ${targets ? targets.length - failedTargets.length : 0} of ${targets ? targets.length : 0} sync targets. Failed (${failedTargets.length}) — ${failedSummary}. Save the same URL again to retry the failed accounts.`)
        }

        return
      }

      if (updates.installUrl) updatedSavedAddon.installUrl = updates.installUrl
      updatedSavedAddon.updatedAt = new Date()

      const hasMetadataChanges = updates.metadata !== undefined || (updates.name !== undefined && updates.name !== savedAddon.name)
      if ((updates.syncWithInstalled ?? savedAddon.syncWithInstalled) && hasMetadataChanges) {
        _outboundSyncInProgress.add(id)
        try {
          const { useAccountStore } = await import('./accountStore')
          const targets = updatedSavedAddon.syncAccountIds
          if (Array.isArray(targets) && targets.length > 0) {
            await mapConcurrent(targets, SAVED_ADDON_ACCOUNT_CONCURRENCY, async (targetAccountId) => {
              try {
                await useAccountStore.getState().replaceTransportUrl(
                  updatedSavedAddon.installUrl,
                  updatedSavedAddon.installUrl,
                  targetAccountId,
                  updatedSavedAddon.manifest,
                  updatedSavedAddon.metadata
                )
              } catch (error) {
                if (import.meta.env.DEV) console.error(`[AddonStore] Metadata sync failed for account ${targetAccountId}:`, error)
              }
            })
          } else if (!Array.isArray(targets)) {
            await useAccountStore.getState().replaceTransportUrl(
              updatedSavedAddon.installUrl,
              updatedSavedAddon.installUrl,
              undefined,
              updatedSavedAddon.manifest,
              updatedSavedAddon.metadata
            )
          }
          await pushMetadataToOwnUrlCopies(updatedSavedAddon, get().accountStates, updatedSavedAddon.metadata)
        } finally {
          _outboundSyncInProgress.delete(id)
        }
      }

      const library = { ...get().library, [id]: updatedSavedAddon }
      set({ library })
      if (updates.syncWithInstalled !== undefined) {
        await saveAddonLibrary(library)
      } else {
        _saveLibraryDebounced(get)
      }
      triggerSync()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update saved addon'
      set({ error: message })
      throw error
    } finally {
      set({ isUpdatingAddon: false })
    }
  },

  updateSavedAddonMetadata: async (id, metadata, skipOutbound = false) => {
    try {
      set({ isUpdatingAddon: true, error: null })
      const savedAddon = get().library[id]
      if (!savedAddon) throw new Error('Saved addon not found')

      const cleanMetadata = { ...savedAddon.metadata }
      Object.keys(metadata).forEach(key => {
        const val = (metadata as Record<string, unknown>)[key]
        if (val === undefined) {
          delete (cleanMetadata as Record<string, unknown>)[key]
        } else {
          (cleanMetadata as Record<string, unknown>)[key] = val
        }
      })

      const updatedSavedAddon = {
        ...savedAddon,
        metadata: cleanMetadata,
        name: cleanMetadata.customName || savedAddon.manifest.name,
        updatedAt: new Date()
      }

      const library = { ...get().library, [id]: updatedSavedAddon }
      set({ library })
      _saveLibraryDebounced(get)

      const hasChanged = JSON.stringify(savedAddon.metadata) !== JSON.stringify(cleanMetadata)

      if (updatedSavedAddon.syncWithInstalled && !skipOutbound && hasChanged) {
        _outboundSyncInProgress.add(id)
        try {
          const { useAccountStore } = await import('./accountStore')
          const targets = updatedSavedAddon.syncAccountIds
          if (Array.isArray(targets) && targets.length > 0) {
            await mapConcurrent(targets, SAVED_ADDON_ACCOUNT_CONCURRENCY, async (targetAccountId) => {
              try {
                await useAccountStore.getState().replaceTransportUrl(
                  savedAddon.installUrl,
                  savedAddon.installUrl,
                  targetAccountId,
                  savedAddon.manifest,
                  cleanMetadata
                )
              } catch (error) {
                if (import.meta.env.DEV) console.error(`[AddonStore] Metadata sync failed for account ${targetAccountId}:`, error)
              }
            })
          } else if (!Array.isArray(targets)) {
            await useAccountStore.getState().replaceTransportUrl(
              savedAddon.installUrl,
              savedAddon.installUrl,
              undefined,
              savedAddon.manifest,
              cleanMetadata
            )
          }
          await pushMetadataToOwnUrlCopies(updatedSavedAddon, get().accountStates, cleanMetadata)
        } finally {
          _outboundSyncInProgress.delete(id)
        }
      }

      triggerSync()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update metadata'
      set({ error: message })
      throw error
    } finally {
      set({ isUpdatingAddon: false })
    }
  },

  updateSavedAddonManifest: async (id) => {
    return updateSavedAddonManifest(id)
  },

  reorderSavedAddons: async (orderedIds) => {
    const { library } = get()
    const known = orderedIds.filter(id => library[id])
    if (known.length < 2) return

    const updates: Record<string, SavedAddon> = {}
    known.forEach((id, i) => {
      if (library[id].sortOrder !== i) updates[id] = { ...library[id], sortOrder: i }
    })
    if (Object.keys(updates).length === 0) return

    const next = { ...library, ...updates }
    set({ library: next })
    await saveAddonLibrary(next)
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
      triggerSync()
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
      _saveLibraryDebounced(get)

      triggerSync()
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
    triggerSync()
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
      triggerSync()
    }
  },

  bulkUpdateSavedAddons: async (ids, updates) => {
    const { library } = get()
    const updatedLibrary = { ...library }

    let hasChanges = false
    ids.forEach((id) => {
      const addon = updatedLibrary[id]
      if (addon) {
        let newTags = addon.tags
        const existingTags = new Set(addon.tags)

        if (updates.tags) {
          updates.tags.forEach((t) => existingTags.add(t))
        }

        if ('tagsRemove' in updates && (updates as Record<string, unknown>).tagsRemove) {
          const tagsToRemove = new Set((updates as Record<string, unknown>).tagsRemove as string[])
          tagsToRemove.forEach(t => existingTags.delete(t as string))
        }

        newTags = Array.from(existingTags)

        updatedLibrary[id] = {
          ...addon,
          ...updates,
          tags: newTags,
          updatedAt: new Date(),
        }
        hasChanges = true
      }
    })

    if (hasChanges) {
      set({ library: updatedLibrary })
      await saveAddonLibrary(updatedLibrary)
      triggerSync()
    }
  },

  getSavedAddon: (id) => {
    return get().library[id] || null
  },

  getSavedAddonsByTag: (tag) => {
    const normalizedTag = normalizeTagName(tag)
    return Object.values(get().library).filter((savedAddon) =>
      savedAddon.tags.some((t) => normalizeTagName(t) === normalizedTag)
    )
  },

  getAllTags: () => {
    const seen = new Map<string, string>()
    Object.values(get().library).forEach((savedAddon) => {
      savedAddon.tags.forEach((tag) => {
        const key = tag.toLowerCase().trim()
        if (key && !seen.has(key)) seen.set(key, tag)
      })
    })
    return Array.from(seen.values()).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
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
      const tags = [...savedAddon.tags]
      const tagIndex = tags.findIndex((t) => normalizeTagName(t) === normalizedOld)
      if (tagIndex >= 0) {
        tags[tagIndex] = normalizedNew
        library[savedAddon.id] = { ...savedAddon, tags, updatedAt: new Date() }
        hasChanges = true
      }
    }

    if (hasChanges) {
      set({ library })
      await saveAddonLibrary(library)
      triggerSync()
    }
  },

  applySavedAddonToAccount: async (savedAddonId, accountId, accountAuthKey) => {
    const deployment = await loadAddonDeployment()
    return deployment.applySavedAddonToAccount(savedAddonId, accountId, accountAuthKey)
  },

  applySavedAddonToAccounts: async (savedAddonId, accountIds) => {
    const deployment = await loadAddonDeployment()
    return deployment.applySavedAddonToAccounts(savedAddonId, accountIds)
  },

  applyTagToAccount: async (tag, accountId, accountAuthKey) => {
    const deployment = await loadAddonDeployment()
    return deployment.applyTagToAccount(tag, accountId, accountAuthKey)
  },

  applyTagToAccounts: async (tag, accountIds) => {
    const deployment = await loadAddonDeployment()
    return deployment.applyTagToAccounts(tag, accountIds)
  },

  importAccountStates: async (states: Record<string, AccountAddonState>, ownership?: SyncOwnership) => {
    // Fence state publication and persistence dispatches.
    ownership?.assert()
    const currentStates = { ...get().accountStates, ...states }
    set({ accountStates: currentStates })
    ownership?.assert()
    await localforage.setItem('aioman:account-addons', currentStates)
  },

  bulkApplySavedAddons: async (savedAddonIds, accountIds, allowProtected?, options?) => {
    const deployment = await loadAddonDeployment()
    return deployment.bulkApplySavedAddons(savedAddonIds, accountIds, allowProtected, options)
  },

  bulkApplyTag: async (tag, accountIds) => {
    const deployment = await loadAddonDeployment()
    return deployment.bulkApplyTag(tag, accountIds)
  },

  bulkRemoveAddons: async (addonIds, accountIds, allowProtected?) => {
    const deployment = await loadAddonDeployment()
    return deployment.bulkRemoveAddons(addonIds, accountIds, allowProtected)
  },

  bulkRemoveByTag: async (tag, accountIds, allowProtected?) => {
    const deployment = await loadAddonDeployment()
    return deployment.bulkRemoveByTag(tag, accountIds, allowProtected)
  },

      bulkReinstallAddons: async (addonIds, accountIds, allowProtected?, onProgress?, options?) => {
            const deployment = await loadAddonDeployment()
            return deployment.bulkReinstallAddons(addonIds, accountIds, allowProtected, onProgress, options)
  },

  bulkInstallFromUrls: async (urls, accountIds, allowProtected?) => {
    const deployment = await loadAddonDeployment()
    return deployment.bulkInstallFromUrls(urls, accountIds, allowProtected)
  },

  bulkReplaceUrl: async (find, replace, accountIds) => {
    const deployment = await loadAddonDeployment()
    return deployment.bulkReplaceUrl(find, replace, accountIds)
  },

  bulkCloneAccount: async (sourceAccount, targetAccountIds, overwrite?, cloneMode?) => {
    const deployment = await loadAddonDeployment()
    return deployment.bulkCloneAccount(sourceAccount, targetAccountIds, { overwrite, cloneMode })
  },

  bulkSyncOrder: async (sourceAccountId, targetAccountIds) => {
    const deployment = await loadAddonDeployment()
    return deployment.bulkSyncOrder(sourceAccountId, targetAccountIds)
  },

  bulkReinstallAllOnAccount: async (accountId, accountAuthKey) => {
    const deployment = await loadAddonDeployment()
    return deployment.bulkReinstallAllOnAccount(accountId, accountAuthKey)
  },

  syncAccountState: async (accountId, accountAuthKey, addons?) => {
    const deployment = await loadAddonDeployment()
    return deployment.syncAccountState(accountId, accountAuthKey, addons)
  },

  syncAllAccountStates: async (accounts) => {
    const deployment = await loadAddonDeployment()
    return deployment.syncAllAccountStates(accounts)
  },

  exportLibrary: (forSync = false) => {
    const library = get().library
    const savedAddons = Object.values(library).map(({ originalManifest: _originalManifest, ...rest }) => rest)
    if (forSync) return { version: '1.0', savedAddons }
    return JSON.stringify(
      {
        version: '1.0',
        exportedAt: new Date().toISOString(),
        savedAddons,
      },
      null,
      2
    )
  },

  importLibrary: async (json, merge, isSilent = false, isImmediate = false, ownership?: SyncOwnership) => {
    const own = ownership ?? captureSyncOwnership()
    set({ loading: true, error: null })
    if (import.meta.env.DEV) console.log("%c[AddonStore] Importing library with SECURE HARDENING", "color: green; font-weight: bold;")
    try {
      let data: Record<string, unknown>
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
            if (import.meta.env.DEV) console.error('Failed to parse library JSON:', json ? json.substring(0, 100) : 'null')
            throw new Error('Failed to parse library data. Aborting to prevent data loss.')
          }
        }
      } else {
        data = {}
      }

      if (!data || (typeof data === 'object' && Object.keys(data).length === 0)) {
        if (!merge) {
          set({ library: {} })
          await saveAddonLibrary({})
        }
        return
      }

      const dataRec = data as Record<string, unknown>
      let scavengedData = dataRec.savedAddons ||
        dataRec['stremio-manager:addon-library'] ||
        dataRec.templates ||
        (dataRec.addons as Record<string, unknown> | undefined)?.savedAddons ||
        (Array.isArray(data) ? data : null)

      if (scavengedData && !Array.isArray(scavengedData) && typeof scavengedData === 'object') {
        scavengedData = Object.values(scavengedData as Record<string, unknown>)
      }

      const savedAddons = scavengedData as unknown[] || []

      const manifestMap = (dataRec.manifests || (dataRec.addons as Record<string, unknown> | undefined)?.manifests || {}) as Record<string, unknown>

      if (!savedAddons || !Array.isArray(savedAddons)) {
        if (import.meta.env.DEV) console.warn('[AddonStore] No valid addon data found in import object.')
      }

      const currentLibrary: Record<string, SavedAddon> = merge ? { ...get().library } : {}

      for (const item of savedAddons) {
        const newItem = item as Record<string, unknown>
        if (!newItem.id || !newItem.installUrl) {
          if (import.meta.env.DEV) console.warn('Skipping invalid item (Missing ID or URL):', newItem)
          continue
        }

        try {
          const parsed = new URL(newItem.installUrl as string)
            if (!['http:', 'https:'].includes(parsed.protocol)) {
              if (import.meta.env.DEV) console.warn('Skipping addon with invalid URL scheme:', newItem.installUrl)
              continue
            }
        } catch {
            if (import.meta.env.DEV) console.warn('Skipping addon with invalid URL:', newItem.installUrl)
          continue
        }

        if (!newItem.manifest && newItem.manifestId && manifestMap[newItem.manifestId as string]) {
          newItem.manifest = manifestMap[newItem.manifestId as string]
        }

        if (newItem.manifest && (newItem.manifest as unknown as Record<string, unknown>).manifest) {
          newItem.manifest = (newItem.manifest as unknown as Record<string, unknown> & { manifest: AddonManifest }).manifest
        }

        if (!newItem.manifest || isPlaceholderManifest(newItem.manifest as AddonManifest)) {
          const known = getKnownManifest(newItem.installUrl as string)
          if (known) newItem.manifest = known
        }

        if (!newItem.manifest) {
          if (import.meta.env.DEV) console.warn(`[AddonStore] Item ${newItem.name || newItem.id} is missing a manifest.Attempting recovery...`)

          if (newItem.installUrl) {
             newItem.manifest = {
              id: 'pending-sync-' + (newItem.id as string),
              name: (newItem.name as string) || 'Recovering Addon...',
              version: '0.0.0',
              description: 'Manifest is being recovered from the source URL.',
              types: [],
              resources: [],
              catalogs: []
            } as AddonManifest
          } else {
            if (import.meta.env.DEV) console.error(`[AddonStore] Skipping item ${newItem.id} - No manifest and no installUrl for recovery.`)
            continue
          }
        }

        const metadata = newItem.metadata && typeof newItem.metadata === 'object'
          ? (() => {
            const md = newItem.metadata as Record<string, unknown>
            return {
              ...(typeof md.customName === 'string' && { customName: md.customName }),
              ...(typeof md.customLogo === 'string' && { customLogo: md.customLogo }),
              ...(typeof md.customDescription === 'string' && { customDescription: md.customDescription }),
            }
          })()
          : undefined
        const catalogOverrides = newItem.catalogOverrides && typeof newItem.catalogOverrides === 'object'
          ? (() => {
            const co = newItem.catalogOverrides as Record<string, unknown>
            return {
              removed: Array.isArray(co.removed)
                ? (co.removed as unknown[]).filter((item: unknown): item is string => typeof item === 'string')
                : [],
              ...(Array.isArray(co.catalogs) && {
                catalogs: (co.catalogs as unknown[]).filter((item: unknown) =>
                  item && typeof item === 'object' &&
                  typeof (item as Record<string, unknown>).id === 'string' &&
                  typeof (item as Record<string, unknown>).type === 'string'
                ) as import('@/types/addon').Catalog[],
              }),
            }
          })()
          : undefined
        const lastUsed = newItem.lastUsed ? new Date(newItem.lastUsed as string | number) : undefined

        const sanitizedItem = {
          id: String(newItem.id),
          name: String(newItem.name || ''),
          installUrl: String(newItem.installUrl || ''),
          sourceType: (newItem.sourceType as SavedAddon['sourceType']) || 'manual',
          ...(typeof newItem.sourceAccountId === 'string' && { sourceAccountId: newItem.sourceAccountId }),
          manifest: newItem.manifest as AddonManifest,
          createdAt: newItem.createdAt ? new Date(newItem.createdAt as string | number) : new Date(),
          updatedAt: new Date(),
          ...(lastUsed && !Number.isNaN(lastUsed.getTime()) && { lastUsed }),
          tags: Array.isArray(newItem.tags) ? newItem.tags : [],
          profileId: newItem.profileId as string | undefined,
          ...(typeof newItem.sortOrder === 'number' && { sortOrder: newItem.sortOrder }),
          ...(metadata && { metadata }),
          ...(catalogOverrides && { catalogOverrides }),
          ...(typeof newItem.autoRestore === 'boolean' && { autoRestore: newItem.autoRestore }),
          ...(typeof newItem.syncWithInstalled === 'boolean' && { syncWithInstalled: newItem.syncWithInstalled }),
          ...(Array.isArray(newItem.syncAccountIds) && { syncAccountIds: newItem.syncAccountIds.map(String) }),
          note: typeof newItem.note === 'string' ? newItem.note.slice(0, 10000) : undefined,
        }
        const existing = currentLibrary[newItem.id as string]
        if (existing) {
          currentLibrary[existing.id] = {
            ...existing,
            ...sanitizedItem,
            createdAt: existing.createdAt || sanitizedItem.createdAt,
          }
        } else {
          currentLibrary[newItem.id as string] = sanitizedItem
        }
      }

      // Fence hydration before publishing into shared state.
      own.assert()
      set({ library: currentLibrary })

      if (isImmediate) {
        own.assert()
        await saveAddonLibrary(currentLibrary)
      } else {
        _saveLibraryDebounced(get)
      }

      if (!isSilent) {
        triggerSync()
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to import library'
      set({ error: message })
      throw error
    } finally {
      set({ loading: false })
    }
  },

  checkAllHealth: async (deferUntilQuiet?: boolean) => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return

    const { lastHealthCheck } = get()
    if (healthRunInFlight) return

    const COOLDOWN = 3 * 60 * 1000
    if (lastHealthCheck && (Date.now() - lastHealthCheck < COOLDOWN)) {
      if (import.meta.env.DEV) console.log(`[Health] Skipping checkAllHealth(Cooldown: ${Math.round((COOLDOWN - (Date.now() - lastHealthCheck)) / 1000)}s remaining)`)
      return
    }

    healthRunInFlight = true
    try {
      if (deferUntilQuiet) {
        await waitForPageQuiet()
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      }
      set({ checkingHealth: true })
      const { library } = get()
      const addons = Object.values(library)
      const results = await checkAllAddonsHealth(addons)

      const updatedLibrary = { ...library }
      let hasChanges = false

      for (const result of results) {
        const addon = updatedLibrary[result.id]
        if (!addon) continue

        const isOnline = result.health?.isOnline ?? false
        const wasOnline = addon.health?.isOnline

        if (wasOnline !== isOnline) {
          updatedLibrary[result.id] = {
            ...addon,
            health: {
              isOnline,
              lastChecked: Date.now(),
            },
            updatedAt: new Date(),
          }
          hasChanges = true
        } else {
          updatedLibrary[result.id] = {
            ...addon,
            health: {
              isOnline,
              lastChecked: Date.now(),
            },
          }
        }

        if (!isOnline && addon.autoRestore) {
          if (restorationManager.canAttemptRestore(addon.installUrl, true)) {
            if (import.meta.env.DEV) console.log(`[Restoration] Attempting recovery for: ${addon.name} `)
            restorationManager.recordAttempt(addon.installUrl)

            try {
              await get().updateSavedAddonManifest(addon.id)
              restorationManager.recordSuccess(addon.installUrl)
              if (import.meta.env.DEV) console.log(`[Restoration] Successfully recovered: ${addon.name} `)
            } catch (err) {
              restorationManager.recordFailure(addon.installUrl)
              if (import.meta.env.DEV) console.warn(`[Restoration] Recovery failed for ${addon.name}: `, err)
            }
          }
        } else if (isOnline && addon.autoRestore) {
          restorationManager.recordSuccess(addon.installUrl)
        }
      }

      if (hasChanges) {
        set({ library: updatedLibrary, lastHealthCheck: Date.now() })
        saveAddonLibrary(updatedLibrary)
      } else {
        set({ lastHealthCheck: Date.now() })
      }
    } catch (error) {
      if (import.meta.env.DEV) console.error('Health check failed:', error)
    } finally {
      healthRunInFlight = false
      set({ checkingHealth: false })
    }
  },

  updateHealthStatus: async (statuses: Array<{ id: string; isOnline: boolean }>) => {
    const library = { ...get().library }
    let hasChanges = false

    statuses.forEach(({ id, isOnline }) => {
      if (library[id]) {
        if (library[id].health?.isOnline !== isOnline) {
          library[id] = {
            ...library[id],
            health: {
              isOnline,
              lastChecked: Date.now(),
            },
          }
          hasChanges = true
        } else {
          library[id] = {
            ...library[id],
            health: {
              isOnline,
              lastChecked: Date.now(),
            },
          }
        }
      }
    })

    if (hasChanges) {
      set({ library })
      _saveLibraryDebounced(get)
    }
  },

  clearError: () => set({ error: null }),

  reset: async () => {
    set({
      library: {},
      latestVersions: {},
      manifestChangeHints: {},
      accountStates: {},
      error: null,
      loading: false,
    })
    await Promise.all([
      localforage.removeItem('aioman:addon-library'),
      localforage.removeItem('aioman:account-addons'),
    ])
  },
  replaceTransportUrlUniversally: async (savedAddonId, oldUrl, newUrl, accountId, descriptor) => {
    const deployment = await loadAddonDeployment()
    return deployment.replaceTransportUrlUniversally(savedAddonId, oldUrl, newUrl, accountId, descriptor)
  },
}))

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    if (_saveDebounceTimer) {
      clearTimeout(_saveDebounceTimer)
      const state = useAddonStore.getState()
      if (Object.keys(state.library).length > 0) {
        saveAddonLibrary(state.library).catch(() => {})
      }
    }
  })
}
