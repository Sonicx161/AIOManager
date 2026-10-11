import { triggerSync } from '@/lib/sync-trigger'
import { toast } from '@/hooks/use-toast'
import { ACCOUNT_CONTEXT_BULK_OP } from '@/lib/account-contexts'
import { getAddons, updateAddons, fetchAddonManifest } from '@/api/addons'
import { identifyAddon } from '@/lib/addon-identifier'
import { mergeAddons, removeAddons } from '@/lib/addon-merger'
import { dedupeAddonsByTransportUrl, getAddonUrlKey } from '@/lib/addon-dedupe'
import { normalizeAddonUrl, getAddonVersionKey } from '@/lib/utils'
import { normalizeUrl, saveAccountAddonStates, saveAddonLibrary } from '@/lib/addon-storage'
import { useAuthStore } from '@/store/authStore'
import { getCachedAuthKey, persistAccounts } from '@/store/accountStore'
import type { AddonDescriptor } from '@/types/addon'
import { isSyncEligibleConnection } from '@/types/connection'
import type { Account } from '@/types/account'
import type {
  AccountAddonState,
  BulkResult,
  InstalledAddon,
  MergeResult,
  SavedAddon,
} from '@/types/saved-addon'
import type { AddonStore } from '../addonStore'
import type { ReplaceTransportUrlResult } from '@/store/accountStore'
import { getEffectiveManifest } from '@/lib/addon-utils'
import { getCachedManifest, setCachedManifest } from '@/lib/manifest-cache'
import { mapConcurrent } from '@/lib/concurrency'
import { getStremioAuthKey } from '@/lib/account-compat'
import { getOfficialFlag } from '@/lib/addon-official'

function isStremioPushEnabled(account: Account | undefined | null): boolean {
    if (!account) return true
    const conn = account.connections?.find(c => c.platform === 'stremio')
    return !conn || conn.enabled !== false
}

async function shouldPushToStremio(accountId: string): Promise<boolean> {
    const { useAccountStore } = await import('../accountStore')
    const account = useAccountStore.getState().accounts.find(a => a.id === accountId)
    return isStremioPushEnabled(account)
}
import { reconcileTombstones } from '@/lib/addon-tombstones'
import { trace, briefAddons } from '@/lib/trace'
import { cloneAddonsWithMode } from '@/lib/clone-mode'
import type { CloneMode } from '@/lib/clone-mode'

type StoreRef = { getState: () => AddonStore; setState: (partial: Partial<AddonStore> | ((state: AddonStore) => Partial<AddonStore>)) => void }

async function getStore(): Promise<StoreRef> {
  const { useAddonStore } = await import('../addonStore')
  return useAddonStore
}

const getEncryptionKey = () => {
  const key = useAuthStore.getState().encryptionKey
  if (!key) throw new Error('App is locked')
  return key
}

function updateActiveProfile(account: Account, updatedAddons: AddonDescriptor[]): Account {
  if (!account.activeProfileId || !account.profiles) return account
  return {
    ...account,
    profiles: account.profiles.map((p) =>
      p.id === account.activeProfileId ? { ...p, addons: updatedAddons } : p
    ),
  }
}

export const SAVED_ADDON_ACCOUNT_CONCURRENCY = 5

const createEmptyMergeResult = (): MergeResult => ({
  added: [],
  updated: [],
  skipped: [],
  protected: [],
})

const getAddonName = (addon: AddonDescriptor) => addon.metadata?.customName || addon.manifest?.name || 'Add-on'

const haveSameAddonOrder = (left: AddonDescriptor[], right: AddonDescriptor[]) => {
  if (left.length !== right.length) return false
  return left.every((addon, index) => getAddonUrlKey(addon.transportUrl) === getAddonUrlKey(right[index]?.transportUrl || ''))
}

const stableStringify = (value: unknown, seen: WeakSet<object> = new WeakSet()): string => {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)

  if (seen.has(value)) return '"[Circular]"'
  seen.add(value)

  try {
    if (Array.isArray(value)) {
      return `[${value.map(entry => stableStringify(entry, seen)).join(',')}]`
    }

    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))

    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue, seen)}`).join(',')}}`
  } finally {
    seen.delete(value)
  }
}

const getComparableAddonFlags = (flags: AddonDescriptor['flags'], manifestId: string) => ({
  official: flags?.official ?? getOfficialFlag(manifestId),
  protected: flags?.protected ?? false,
  enabled: flags?.enabled ?? true,
})

const getComparableAddonMetadata = (metadata: AddonDescriptor['metadata']) => {
  if (!metadata) return null

  const comparableMetadata = {
    customName: metadata.customName,
    customLogo: metadata.customLogo,
    customDescription: metadata.customDescription,
    cinemetaConfig: metadata.cinemetaConfig,
  }

  return Object.values(comparableMetadata).some(value => value !== undefined)
    ? comparableMetadata
    : null
}

const getComparableCatalogOverrides = (catalogOverrides: AddonDescriptor['catalogOverrides']) => (
  catalogOverrides?.removed?.length || catalogOverrides?.catalogs?.length
    ? {
      removed: [...(catalogOverrides.removed || [])].sort(),
      catalogs: catalogOverrides.catalogs || null,
    }
    : null
)

const getAddonCollectionFingerprint = (addon: AddonDescriptor) => stableStringify({
  transportName: addon.transportName || null,
  transportUrl: getAddonUrlKey(addon.transportUrl),
  manifest: addon.manifest || null,
  flags: getComparableAddonFlags(addon.flags, addon.manifest?.id ?? ''),
  metadata: getComparableAddonMetadata(addon.metadata),
  catalogOverrides: getComparableCatalogOverrides(addon.catalogOverrides),
  syncToLibrary: addon.syncToLibrary ?? false,
  note: addon.note || null,
})

const haveSameAddonCollection = (left: AddonDescriptor[], right: AddonDescriptor[]) => {
  if (left.length !== right.length) return false
  return left.every((addon, index) => (
    getAddonCollectionFingerprint(addon) === getAddonCollectionFingerprint(right[index])
  ))
}

const createCloneMergeResult = (
  sourceAddons: AddonDescriptor[],
  previousAddons: AddonDescriptor[],
  finalAddons: AddonDescriptor[],
  overwrite: boolean
): MergeResult => {
  const sourceKeys = new Set(sourceAddons.map(addon => getAddonUrlKey(addon.transportUrl)).filter(Boolean))
  const previousByKey = new Map(previousAddons.map(addon => [getAddonUrlKey(addon.transportUrl), addon]))
  const finalByKey = new Map(finalAddons.map(addon => [getAddonUrlKey(addon.transportUrl), addon]))
  const result = createEmptyMergeResult()

  for (const addon of finalAddons) {
    const key = getAddonUrlKey(addon.transportUrl)
    if (!sourceKeys.has(key)) continue

    const previousAddon = previousByKey.get(key)
    if (previousAddon) {
      if (getAddonCollectionFingerprint(previousAddon) === getAddonCollectionFingerprint(addon)) continue
      result.updated.push({
        addonId: addon.manifest.id,
        oldUrl: previousAddon.transportUrl,
        newUrl: addon.transportUrl,
      })
    } else {
      result.added.push({
        addonId: addon.manifest.id,
        name: getAddonName(addon),
        installUrl: addon.transportUrl,
      })
    }
  }

  if (overwrite) {
    for (const addon of previousAddons) {
      const key = getAddonUrlKey(addon.transportUrl)
      if (finalByKey.has(key)) continue
      result.removed ??= []
      result.removed.push({
        addonId: addon.manifest.id,
        name: getAddonName(addon),
      })
    }
  }

  return result
}

const createOrderMergeResult = (
  previousAddons: AddonDescriptor[],
  reorderedAddons: AddonDescriptor[]
): MergeResult => {
  const result = createEmptyMergeResult()
  const previousIndexByKey = new Map(previousAddons.map((addon, index) => [getAddonUrlKey(addon.transportUrl), index]))

  reorderedAddons.forEach((addon, index) => {
    const previousIndex = previousIndexByKey.get(getAddonUrlKey(addon.transportUrl))
    if (previousIndex === undefined) return

    if (previousIndex !== index) {
      result.updated.push({
        addonId: addon.manifest.id,
        oldUrl: addon.transportUrl,
        newUrl: addon.transportUrl,
      })
    } else {
      result.protected.push({
        addonId: addon.manifest.id,
        name: getAddonName(addon),
      })
    }
  })

  return result
}

export async function applySavedAddonToAccount(
  savedAddonId: string,
  accountId: string,
  accountAuthKey: string
): Promise<MergeResult> {
  const useAddonStore = await getStore()
  useAddonStore.setState({ loading: true, error: null })
  try {
    const savedAddon = useAddonStore.getState().library[savedAddonId]
    if (!savedAddon) {
      throw new Error('Saved addon not found')
    }

    const authKey = await getCachedAuthKey(accountAuthKey, getEncryptionKey())
    const currentAddons = await getAddons(authKey, accountId)
    trace('deploy.apply', 'read', { savedAddonId, accountId, current: currentAddons.length })

    const { addons: updatedAddons, result } = await mergeAddons(
      currentAddons,
      [savedAddon],
      accountId,
      true
    )

    if (await shouldPushToStremio(accountId)) await updateAddons(authKey, updatedAddons, accountId)
    trace('deploy.apply', 'pushed', { savedAddonId, accountId, count: updatedAddons.length })
    const { pushToConnections } = await import('../account/accountAddonOps')
    pushToConnections(accountId).catch(() => { toast({ variant: 'destructive', title: 'Cross-platform sync failed', description: 'Addon changes saved locally but not pushed to connected platforms.' }) })

    const library = { ...useAddonStore.getState().library }
    library[savedAddonId] = { ...savedAddon, lastUsed: new Date() }
    useAddonStore.setState({ library })
    await saveAddonLibrary(library)

    await useAddonStore.getState().syncAccountState(accountId, accountAuthKey, updatedAddons)

    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to apply saved addon'
    trace('deploy.apply', 'failed', { savedAddonId, accountId, error: message })
    useAddonStore.setState({ error: message })
    throw error
  } finally {
    useAddonStore.setState({ loading: false })
  }
}

export async function applySavedAddonToAccounts(
  savedAddonId: string,
  accountIds: Array<{ id: string; authKey: string }>
): Promise<BulkResult> {
  const useAddonStore = await getStore()
  const savedAddon = useAddonStore.getState().library[savedAddonId]
  if (!savedAddon) {
    throw new Error('Saved addon not found')
  }

  return bulkApplySavedAddons([savedAddonId], accountIds)
}

export async function applyTagToAccount(
  tag: string,
  accountId: string,
  accountAuthKey: string
): Promise<MergeResult> {
  const useAddonStore = await getStore()
  const savedAddons = useAddonStore.getState().getSavedAddonsByTag(tag)
  if (savedAddons.length === 0) {
    throw new Error(`No saved addons found with tag: ${tag} `)
  }

  useAddonStore.setState({ loading: true, error: null })
  try {
    const authKey = await getCachedAuthKey(accountAuthKey, getEncryptionKey())
    const currentAddons = await getAddons(authKey, accountId)

    const { addons: updatedAddons, result } = await mergeAddons(
      currentAddons,
      savedAddons,
      accountId,
      true
    )

    if (await shouldPushToStremio(accountId)) await updateAddons(authKey, updatedAddons, accountId)
    const { pushToConnections } = await import('../account/accountAddonOps')
    pushToConnections(accountId).catch(() => { toast({ variant: 'destructive', title: 'Cross-platform sync failed', description: 'Addon changes saved locally but not pushed to connected platforms.' }) })

    const library = { ...useAddonStore.getState().library }
    savedAddons.forEach((savedAddon) => {
      library[savedAddon.id] = { ...savedAddon, lastUsed: new Date() }
    })
    useAddonStore.setState({ library })
    await saveAddonLibrary(library)

    await useAddonStore.getState().syncAccountState(accountId, accountAuthKey, updatedAddons)

    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to apply tag'
    useAddonStore.setState({ error: message })
    throw error
  } finally {
    useAddonStore.setState({ loading: false })
  }
}

export async function applyTagToAccounts(
  tag: string,
  accountIds: Array<{ id: string; authKey: string }>
): Promise<BulkResult> {
  return bulkApplyTag(tag, accountIds)
}

export async function bulkApplySavedAddons(
  savedAddonIds: string[],
  accountIds: Array<{ id: string; authKey: string }>,
  allowProtected = true
): Promise<BulkResult> {
  const useAddonStore = await getStore()
  useAddonStore.setState({ loading: true, error: null })
  try {
    const originalsById = new Map<string, SavedAddon>()
    const savedAddons = savedAddonIds
      .map((id) => {
        const saved = useAddonStore.getState().library[id]
        if (!saved) return null
        originalsById.set(id, saved)
        return saved
      })
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

    await mapConcurrent(accountIds, SAVED_ADDON_ACCOUNT_CONCURRENCY, async ({ id: accountId, authKey: accountAuthKey }) => {
      try {
        const { useAccountStore } = await import('../accountStore')
        const account = useAccountStore.getState().accounts.find(a => a.id === accountId)
        const hasNonStremioConnections = !!(account?.connections || []).some(c => c.enabled && isSyncEligibleConnection(c))
        const isLocalAccount = !accountAuthKey
        const isConnectedNonStremio = isLocalAccount && hasNonStremioConnections
        let currentAddons: AddonDescriptor[]
        let authKey = ''

        if (isLocalAccount) {
          currentAddons = account?.addons || []
        } else {
          authKey = await getCachedAuthKey(accountAuthKey, getEncryptionKey())
          currentAddons = await getAddons(authKey, accountId)
        }

        trace('deploy', 'before-merge', { accountId, isLocalAccount, hasNonStremioConnections, current: currentAddons.length, saving: savedAddons.length, savingUrls: savedAddons.map(s => s.installUrl.slice(-48)), currentAddons: briefAddons(currentAddons) })

        const { addons: mergedAddons, result: mergeResult } = await mergeAddons(
          currentAddons,
          savedAddons,
          accountId,
          allowProtected
        )

        trace('deploy', 'after-merge', { accountId, added: mergeResult.added.map(a => a.installUrl?.slice(-48) || a.addonId), updated: mergeResult.updated.map(u => u.addonId), skipped: mergeResult.skipped.map(s => s.addonId), protected: mergeResult.protected.map(p => p.addonId), merged: mergedAddons.length })

        const updatedAddons = dedupeAddonsByTransportUrl(mergedAddons).map(addon => ({
          ...addon,
          metadata: {
            ...(addon.metadata || {}),
            lastUpdated: Date.now()
          }
        }))

        if (isLocalAccount) {
          const state = useAccountStore.getState()
          const localAccount = state.accounts.find(a => a.id === accountId)
          if (localAccount) {
            let updatedAccount: Account = { ...localAccount, addons: updatedAddons, deletedAddons: reconcileTombstones(localAccount.deletedAddons, updatedAddons), lastSync: new Date() }
            updatedAccount = updateActiveProfile(updatedAccount, updatedAddons)
            useAccountStore.setState({
              accounts: state.accounts.map(a => a.id === accountId ? updatedAccount : a)
            })
            persistAccounts(useAccountStore.getState().accounts)
          }
          if (isConnectedNonStremio) {
            const { pushToConnections } = await import('../account/accountAddonOps')
            pushToConnections(accountId).catch(err => { if (import.meta.env.DEV) console.error('Failed to push to connections:', err) })
          }
        } else {
          trace('deploy', 'stremio-push', { accountId, pushing: updatedAddons.length, addons: briefAddons(updatedAddons) })
          if (await shouldPushToStremio(accountId)) await updateAddons(authKey, updatedAddons, accountId)
          const state = useAccountStore.getState()
          const stremioAccount = state.accounts.find(a => a.id === accountId)
          if (stremioAccount) {
            const clearedTombstones = reconcileTombstones(stremioAccount.deletedAddons, updatedAddons)
            useAccountStore.setState({ accounts: state.accounts.map(a => a.id === accountId ? { ...a, deletedAddons: clearedTombstones } : a) })
            persistAccounts(useAccountStore.getState().accounts)
          }
          const { pushToConnections } = await import('../account/accountAddonOps')
          pushToConnections(accountId, { addons: updatedAddons }).catch(() => { toast({ variant: 'destructive', title: 'Cross-platform sync failed', description: 'Addon changes saved locally but not pushed to connected platforms.' }) })
          // Refresh account.addons through the metadata-preserving passive merge so the deploy
          // surfaces promptly without the deploy path overwriting local flags.
          const { scheduleSyncAccount } = await import('../account/accountSync')
          scheduleSyncAccount(accountId)
        }

        result.success++
        result.details.push({ accountId, result: mergeResult })

        await useAddonStore.getState().syncAccountState(accountId, accountAuthKey, updatedAddons)
      } catch (error) {
        result.failed++
        result.errors.push({
          accountId,
          error: error instanceof Error ? error.message : 'Unknown error',
        })
      }
    })

    const library = { ...useAddonStore.getState().library }
    savedAddons.forEach((applied) => {
      // Write back from the pre-override library entry so a per-install
      // urlOverride never permanently replaces the saved installUrl.
      const original = originalsById.get(applied.id)
      if (original) library[applied.id] = { ...original, lastUsed: new Date() }
    })
    useAddonStore.setState({ library })
    await saveAddonLibrary(library)

    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to apply saved addons'
    useAddonStore.setState({ error: message })
    throw error
  } finally {
    useAddonStore.setState({ loading: false })
  }
}

export async function bulkApplyTag(
  tag: string,
  accountIds: Array<{ id: string; authKey: string }>
): Promise<BulkResult> {
  const useAddonStore = await getStore()
  const savedAddons = useAddonStore.getState().getSavedAddonsByTag(tag)
  if (savedAddons.length === 0) {
    throw new Error(`No saved addons found with tag: ${tag} `)
  }

  return bulkApplySavedAddons(
    savedAddons.map((s: SavedAddon) => s.id),
    accountIds
  )
}

export async function bulkRemoveAddons(
  addonIds: string[],
  accountIds: Array<{ id: string; authKey: string }>,
  allowProtected = false
): Promise<BulkResult> {
  const useAddonStore = await getStore()
  useAddonStore.setState({ loading: true, error: null })
  try {
    const result: BulkResult = {
      success: 0,
      failed: 0,
      errors: [],
      details: [],
    }
    const targetManifestIds = new Set(addonIds)
    const targetUrlKeys = new Set(addonIds.map((target) => normalizeAddonUrl(target)))

    await mapConcurrent(accountIds, SAVED_ADDON_ACCOUNT_CONCURRENCY, async ({ id: accountId, authKey: accountAuthKey }) => {
      try {
        if (!accountAuthKey) {
          const { useAccountStore } = await import('../accountStore')
          const accountStore = useAccountStore.getState()
          const localAddons = accountStore.accounts.find((account) => account.id === accountId)?.addons || []
          const localMatches = localAddons.flatMap((addon) => {
            const normAddonUrl = normalizeAddonUrl(addon.transportUrl)
            if (!targetManifestIds.has(addon.manifest.id) && !targetUrlKeys.has(normAddonUrl)) return []
            return [{ addon, normAddonUrl }]
          })
          const localProtected = localMatches.filter(({ addon }) => !allowProtected && addon.flags?.protected)
          const localRemovableAddons = localMatches.filter(({ addon }) => {
            return allowProtected || !addon.flags?.protected
          })
          const removedById = new Map<string, { addonId: string; name: string }>()
          for (const { addon } of localRemovableAddons) {
            removedById.set(addon.manifest.id, {
              addonId: addon.manifest.id,
              name: addon.manifest.name,
            })
          }
          const removedDetails = Array.from(removedById.values())
          const hasLocalRemoval = localRemovableAddons.length > 0

          if (hasLocalRemoval) {
            try {
              const { useFailoverStore } = await import('@/store/failoverStore')
              const failoverStore = useFailoverStore.getState()
              for (const url of addonIds) {
                await failoverStore.removeUrlFromRules(accountId, url)
              }
            } catch (e) {
              if (import.meta.env.DEV) console.warn('[AddonStore] Failover cleanup failed during removal:', e)
            }

            await accountStore.removeLocalAddons(accountId, addonIds)
          }

          result.success++
          result.details.push({
            accountId,
            result: {
              added: [],
              removed: removedDetails,
              updated: [],
              skipped: [],
              protected: localProtected.map(({ addon }) => ({
                addonId: addon.manifest.id,
                name: addon.manifest.name,
              })),
            },
          })
          return
        }

        const authKey = await getCachedAuthKey(accountAuthKey, getEncryptionKey())
        const currentAddons = await getAddons(authKey, accountId)
        const currentAddonById = new Map(currentAddons.map((addon) => [addon.manifest.id, addon]))
        const { useAccountStore } = await import('../accountStore')
        const accountStore = useAccountStore.getState()
        const localAddons = accountStore.accounts.find((account) => account.id === accountId)?.addons || []
        const remoteProtectedUrls = new Set(
          currentAddons
            .filter((addon) => addon.flags?.protected)
            .map((addon) => normalizeAddonUrl(addon.transportUrl))
        )
        const localMatches = localAddons.flatMap((addon) => {
          const normAddonUrl = normalizeAddonUrl(addon.transportUrl)
          if (!targetManifestIds.has(addon.manifest.id) && !targetUrlKeys.has(normAddonUrl)) return []
          return [{ addon, normAddonUrl }]
        })
        const localProtectedIds = localMatches
          .filter(({ addon, normAddonUrl }) => {
            return !allowProtected && (addon.flags?.protected || remoteProtectedUrls.has(normAddonUrl))
          })
          .map(({ addon }) => addon.manifest.id)
        const localRemovableAddons = localMatches.filter(({ addon, normAddonUrl }) => {
          return allowProtected || (!addon.flags?.protected && !remoteProtectedUrls.has(normAddonUrl))
        })

        const { addons: updatedAddons, removed, protectedAddons } = removeAddons(currentAddons, addonIds, allowProtected)
        const protectedIds = Array.from(new Set([...protectedAddons, ...localProtectedIds]))
        const hasLocalRemoval = localRemovableAddons.length > 0
        const hasRemoteRemoval = removed.length > 0
        const removedById = new Map<string, { addonId: string; name: string }>()
        for (const { addon } of localRemovableAddons) {
          removedById.set(addon.manifest.id, {
            addonId: addon.manifest.id,
            name: addon.manifest.name,
          })
        }
        for (const id of removed) {
          if (removedById.has(id)) continue
          removedById.set(id, {
            addonId: id,
            name: currentAddonById.get(id)?.manifest.name || id,
          })
        }
        const removedDetails = Array.from(removedById.values())

        if (hasLocalRemoval || hasRemoteRemoval) {
          try {
            const { useFailoverStore } = await import('@/store/failoverStore')
            const failoverStore = useFailoverStore.getState()
            for (const url of addonIds) {
              await failoverStore.removeUrlFromRules(accountId, url)
            }
          } catch (e) {
            if (import.meta.env.DEV) console.warn('[AddonStore] Failover cleanup failed during removal:', e)
          }
        }

        if (hasRemoteRemoval) {
            if (await shouldPushToStremio(accountId)) await updateAddons(authKey, updatedAddons, ACCOUNT_CONTEXT_BULK_OP, { previousCollection: currentAddons, allowCollectionShrink: true })
        }

        if (hasLocalRemoval || hasRemoteRemoval) {
          await accountStore.removeLocalAddons(accountId, addonIds)
        }

        if (hasRemoteRemoval) {
          await useAddonStore.getState().syncAccountState(accountId, accountAuthKey, updatedAddons)
        }

        result.success++
        result.details.push({
          accountId,
          result: {
            added: [],
            removed: removedDetails,
            updated: [],
            skipped: [],
            protected: protectedIds.map((id) => ({
              addonId: id,
              name: currentAddonById.get(id)?.manifest.name || id,
            })),
          },
        })
      } catch (error) {
        result.failed++
        result.errors.push({
          accountId,
          error: error instanceof Error ? error.message : 'Unknown error',
        })
      }
    })

    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to remove addons'
    useAddonStore.setState({ error: message })
    throw error
  } finally {
    useAddonStore.setState({ loading: false })
  }
}

export async function bulkRemoveByTag(
  tag: string,
  accountIds: Array<{ id: string; authKey: string }>,
  allowProtected = false
): Promise<BulkResult> {
  const useAddonStore = await getStore()
  const savedAddons = useAddonStore.getState().getSavedAddonsByTag(tag)
  if (savedAddons.length === 0) {
    throw new Error(`No saved addons found with tag: ${tag} `)
  }

  const transportUrls = savedAddons.map((s: SavedAddon) => s.installUrl)
  return bulkRemoveAddons(transportUrls, accountIds, allowProtected)
}

function escapeReplaceRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function replaceUrlFragment(url: string, find: string, replace: string) {
  return url.replace(new RegExp(escapeReplaceRegExp(find), 'gi'), replace)
}

// Find-and-replace a URL fragment across the installed addons of each selected account.
// Runs on the unified replace path (per account), so library/rules/manifest handling
// stay identical to the single-account and library tools. Scoped per account: the
// shared Library is not touched (savedAddonId is null).
export async function bulkReplaceUrl(
  find: string,
  replace: string,
  accountIds: Array<{ id: string; authKey: string }>,
): Promise<BulkResult> {
  const result: BulkResult = { success: 0, failed: 0, errors: [], details: [] }
  if (!find) return result

  const m = await import('../addonStore') as typeof import('../addonStore')
  const useAddonStore: StoreRef = m.useAddonStore
  const { useAccountStore } = await import('../accountStore')

  const workerResults = await mapConcurrent(accountIds, SAVED_ADDON_ACCOUNT_CONCURRENCY, async ({ id: accountId }) => {
    try {
      const addons = useAccountStore.getState().accounts.find(a => a.id === accountId)?.addons ?? []

      // Mirror the per-account dialog's collision guards: skip no-op changes, targets
      // that already exist on the account, and two matches colliding on one new URL.
      const sources = addons.map((addon, index) => ({
        key: `${addon.transportUrl}::${index}`,
        addonId: addon.manifest.id,
        url: addon.transportUrl,
      }))
      const rawMatches = sources.filter(s => s.url.toLowerCase().includes(find.toLowerCase()))

      const keysByUrl = new Map<string, string[]>()
      for (const s of sources) {
        const urlKey = normalizeAddonUrl(s.url)
        const keys = keysByUrl.get(urlKey)
        if (keys) keys.push(s.key)
        else keysByUrl.set(urlKey, [s.key])
      }

      const movingKeys = new Set<string>()
      for (const s of rawMatches) {
        const newUrl = replaceUrlFragment(s.url, find, replace)
        if (normalizeAddonUrl(s.url) !== normalizeAddonUrl(newUrl)) movingKeys.add(s.key)
      }

      const mergeResult: MergeResult = { added: [], updated: [], skipped: [], protected: [] }
      const claimedTargetKeys = new Set<string>()
      const pairs: Array<{ addonId: string; oldUrl: string; newUrl: string }> = []

      for (const s of rawMatches) {
        const newUrl = replaceUrlFragment(s.url, find, replace)
        const oldKey = normalizeAddonUrl(s.url)
        const newKey = normalizeAddonUrl(newUrl)
        if (oldKey === newKey) continue
        const existingTarget = keysByUrl.get(newKey)?.filter(k => k !== s.key && !movingKeys.has(k)) ?? []
        if (existingTarget.length > 0 || claimedTargetKeys.has(newKey)) {
          mergeResult.skipped.push({ addonId: s.addonId, reason: 'already-exists' })
          continue
        }
        claimedTargetKeys.add(newKey)
        pairs.push({ addonId: s.addonId, oldUrl: s.url, newUrl })
      }

      for (const pair of pairs) {
        try {
          await useAddonStore.getState().replaceTransportUrlUniversally(null, pair.oldUrl, pair.newUrl, accountId)
          mergeResult.updated.push({ addonId: pair.addonId, oldUrl: pair.oldUrl, newUrl: pair.newUrl })
        } catch {
          mergeResult.skipped.push({ addonId: pair.addonId, reason: 'fetch-failed' })
        }
      }

      return { success: 1, failed: 0, detail: { accountId, result: mergeResult } }
    } catch (error) {
      return { success: 0, failed: 1, error: { accountId, error: error instanceof Error ? error.message : 'Unknown error' } }
    }
  })

  for (const wr of workerResults) {
    result.success += wr.success
    result.failed += wr.failed
    if (wr.detail) result.details.push(wr.detail)
    if (wr.error) result.errors.push(wr.error)
  }

  return result
}

export async function bulkReinstallAddons(
  addonIds: string[],
  accountIds: Array<{ id: string; authKey: string }>,
  allowProtected = false,
  onProgress?: (current: number, total: number) => void
): Promise<BulkResult> {
  const m = await import('../addonStore') as typeof import('../addonStore')
  const useAddonStore: StoreRef = m.useAddonStore
  const _saveLibraryDebounced = m._saveLibraryDebounced as (getState: () => AddonStore) => void
  useAddonStore.setState({ loading: true, error: null })
  try {
    const result: BulkResult = {
      success: 0,
      failed: 0,
      errors: [],
      details: [],
    }

    if (addonIds.length > 0 && addonIds[0] !== '*') {
      await mapConcurrent(
        [...new Set(addonIds)],
        SAVED_ADDON_ACCOUNT_CONCURRENCY,
        async (url) => {
          try {
            const m = await fetchAddonManifest(url, 'Bulk-Pre-Fetch', true)
            if (m) setCachedManifest(url, m.manifest)
          } catch {}
        }
      )
    }

    let completedAccounts = 0
    const workerResults = await mapConcurrent(accountIds, SAVED_ADDON_ACCOUNT_CONCURRENCY, async ({ id: accountId, authKey: accountAuthKey }) => {
      try {
        const { useAccountStore } = await import('@/store/accountStore')
        const account = useAccountStore.getState().accounts.find(a => a.id === accountId)
        const localAddons = account?.addons || []
        const authKey = accountAuthKey ? await getCachedAuthKey(accountAuthKey, getEncryptionKey()) : ''
        const currentAddons = accountAuthKey ? await getAddons(authKey, accountId) : localAddons
        const localByUrl = new Map(localAddons.map(a => [normalizeAddonUrl(a.transportUrl), a]))
        const remoteUrls = new Set(currentAddons.map(a => normalizeAddonUrl(a.transportUrl)))
        const currentAddonsWithLocalMeta = currentAddons.map(remote => {
          const local = localByUrl.get(normalizeAddonUrl(remote.transportUrl))
          if (!local) return remote
          return {
            ...remote,
            metadata: { ...remote.metadata, ...local.metadata },
            flags: { ...remote.flags, protected: local.flags?.protected, enabled: local.flags?.enabled },
            catalogOverrides: local.catalogOverrides,
            note: local.note,
          }
        })

        const localOnlyAddons = localAddons.filter(
          a => !remoteUrls.has(normalizeAddonUrl(a.transportUrl))
        )
        const targetCollection = [...currentAddonsWithLocalMeta, ...localOnlyAddons]
        let needsRemotePush = false

        const updateResults: Array<{
          addonId: string
          previousVersion?: string
          newVersion?: string
        }> = []
        const skippedResults: Array<{
          addonId: string
          reason: 'already-exists' | 'protected' | 'fetch-failed' | 'not-installed'
        }> = []

        const idsToReinstall = (addonIds.length === 1 && addonIds[0] === '*')
          ? targetCollection.map(a => a.transportUrl)
          : addonIds

        for (const addonId of idsToReinstall) {
          const normalizedTarget = normalizeAddonUrl(addonId)

          const existingIdx = targetCollection.findIndex(
            (a) => normalizeAddonUrl(a.transportUrl) === normalizedTarget
          )
          const existingAddon = existingIdx >= 0 ? targetCollection[existingIdx] : null
          if (!existingAddon) {
            skippedResults.push({ addonId, reason: 'not-installed' })
            continue
          }

          if (existingAddon?.flags?.protected && !allowProtected) {
            skippedResults.push({ addonId, reason: 'protected' })
            continue
          }

          try {
            const targetUrl = existingAddon.transportUrl
            const normUrl = normalizeAddonUrl(targetUrl)

            let freshDescriptor: AddonDescriptor | null = null

            const cachedManifest = getCachedManifest(targetUrl)
            if (cachedManifest) {
              freshDescriptor = { transportUrl: targetUrl, manifest: cachedManifest }
            } else {
              try {
                freshDescriptor = await fetchAddonManifest(targetUrl, accountId, true)
                if (freshDescriptor) {
                  setCachedManifest(targetUrl, freshDescriptor.manifest)

                  const savedAddonId = Object.keys(useAddonStore.getState().library).find(
                    id => normalizeAddonUrl(useAddonStore.getState().library[id].installUrl) === normUrl
                  )
                  if (savedAddonId) {
                    const savedAddon = useAddonStore.getState().library[savedAddonId]
                    const freshManifest = freshDescriptor.manifest
                    const updatedSavedAddon = {
                      ...savedAddon,
                      manifest: getEffectiveManifest({ ...savedAddon, manifest: freshManifest }),
                      updatedAt: new Date(),
                    }
                    useAddonStore.setState((state: AddonStore) => ({ library: { ...state.library, [savedAddonId]: updatedSavedAddon } }))
                    _saveLibraryDebounced(useAddonStore.getState)
                  }
                }
              } catch (manifestError) {
                if (import.meta.env.DEV) console.warn(`[Bulk] Failed to fetch manifest for ${targetUrl}:`, manifestError)
              }
            }

            if (freshDescriptor) {
              const previousVersion = existingAddon.manifest.version
              const newVersion = freshDescriptor.manifest.version

              updateResults.push({
                addonId,
                previousVersion,
                newVersion,
              })

              if (existingIdx >= 0) {
                targetCollection[existingIdx] = {
                  ...freshDescriptor,
                  flags: { ...existingAddon!.flags, ...freshDescriptor.flags },
                  metadata: { ...existingAddon!.metadata },
                  catalogOverrides: existingAddon!.catalogOverrides,
                }
                needsRemotePush = true
              }

              const { useAccountStore } = await import('@/store/accountStore')
              useAccountStore.getState().addChangelogEntry({
                accountId,
                addonId: freshDescriptor.manifest.id,
                addonUrl: targetUrl,
                addonName: existingAddon?.metadata?.customName || freshDescriptor.manifest.name,
                addonLogo: existingAddon?.metadata?.customLogo || freshDescriptor.manifest.logo,
                action: 'updated'
              }).catch(e => { if (import.meta.env.DEV) console.error(e) })
            }
          } catch (error) {
            if (import.meta.env.DEV) console.warn(`Failed to reinstall addon ${addonId} on account ${accountId}: `, error)
            skippedResults.push({ addonId, reason: 'fetch-failed' })
          }
        }

        if (needsRemotePush && accountAuthKey) {
          if (import.meta.env.DEV) console.log(`[Bulk] Pushing batched updates for account ${accountId} (${updateResults.length} addons)`)
          if (await shouldPushToStremio(accountId)) await updateAddons(authKey, targetCollection, accountId)
        }

        const { pushToConnections } = await import('../account/accountAddonOps')
        pushToConnections(accountId).catch(() => { toast({ variant: 'destructive', title: 'Cross-platform sync failed', description: 'Addon changes saved locally but not pushed to connected platforms.' }) })

        await useAddonStore.getState().syncAccountState(accountId, accountAuthKey, targetCollection)

        if (updateResults.length > 0) {
          const targetByUrl = new Map(targetCollection.map(a => [normalizeAddonUrl(a.transportUrl), a]))
          const updatedByUrl = new Map(
            updateResults.map(r => {
              const descriptor = targetByUrl.get(normalizeAddonUrl(r.addonId))
              return descriptor ? [normalizeAddonUrl(r.addonId), descriptor] : null
            }).filter((e): e is [string, AddonDescriptor] => e !== null)
          )

          const { useAccountStore: acctStore } = await import('@/store/accountStore')
          const accountStore = acctStore.getState()
          const account = accountStore.accounts.find(a => a.id === accountId)
          if (account) {
            const patchedAddons = account.addons.map(addon => {
              const updated = updatedByUrl.get(normalizeAddonUrl(addon.transportUrl))
              if (!updated) return addon
              return { ...addon, manifest: updated.manifest }
            })
            acctStore.setState({
              accounts: accountStore.accounts.map(a =>
                a.id === accountId ? { ...a, addons: patchedAddons } : a
              ),
            })
            persistAccounts(acctStore.getState().accounts)

            const latestVersionUpdates: Record<string, string> = {}
            for (const [url, descriptor] of updatedByUrl) {
              if (descriptor.manifest?.id && descriptor.manifest?.version) {
                latestVersionUpdates[descriptor.manifest.id] = descriptor.manifest.version
                latestVersionUpdates[getAddonVersionKey({ transportUrl: url, manifest: descriptor.manifest })] = descriptor.manifest.version
              }
            }
            if (Object.keys(latestVersionUpdates).length > 0) {
              const { useAddonStore } = await import('../addonStore')
              useAddonStore.getState().updateLatestVersions(latestVersionUpdates)
            }
          }
        }

        if (updateResults.length > 0) {
          const { useAccountStore } = await import('@/store/accountStore')
          const accountStore = useAccountStore.getState()
          const account = accountStore.accounts.find(a => a.id === accountId)
          if (account?.profiles?.length) {
            const targetByUrl = new Map(targetCollection.map(a => [normalizeAddonUrl(a.transportUrl), a]))
            const updatedByUrl = new Map(
              updateResults.map(r => {
                const descriptor = targetByUrl.get(normalizeAddonUrl(r.addonId))
                return descriptor ? [normalizeAddonUrl(r.addonId), descriptor] : null
              }).filter((e): e is [string, AddonDescriptor] => e !== null)
            )
            let profilesChanged = false
            const updatedProfiles = account.profiles.map(profile => {
              if (profile.id === account.activeProfileId) return profile
              if (!profile.addons?.length) return profile
              let changed = false
              const patchedAddons = profile.addons.map(addon => {
                const updated = updatedByUrl.get(normalizeAddonUrl(addon.transportUrl))
                if (!updated) return addon
                changed = true
                return { ...addon, manifest: updated.manifest }
              })
              if (changed) profilesChanged = true
              return changed ? { ...profile, addons: patchedAddons } : profile
            })
            if (profilesChanged) {
              useAccountStore.setState({
                accounts: accountStore.accounts.map(a =>
                  a.id === accountId ? { ...a, profiles: updatedProfiles } : a
                ),
              })
              persistAccounts(useAccountStore.getState().accounts)
            }
          }
        }

        return {
          success: 1,
          failed: 0,
          detail: {
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
          },
        }
      } catch (error) {
        return {
          success: 0,
          failed: 1,
          error: { accountId, error: error instanceof Error ? error.message : 'Unknown error' },
        }
      } finally {
        completedAccounts++
        if (onProgress) onProgress(completedAccounts, accountIds.length)
      }
    })

    for (const wr of workerResults) {
      result.success += wr.success
      result.failed += wr.failed
      if (wr.detail) result.details.push(wr.detail)
      if (wr.error) result.errors.push(wr.error)
    }

    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to reinstall addons'
    useAddonStore.setState({ error: message })
    throw error
  } finally {
    useAddonStore.setState({ loading: false })
  }
}

export async function bulkInstallFromUrls(
  urls: string[],
  accountIds: Array<{ id: string; authKey: string }>,
  allowProtected = true
): Promise<BulkResult> {
  const useAddonStore = await getStore()
  useAddonStore.setState({ loading: true, error: null })
  try {
    const manifestsResults = await Promise.allSettled(
      urls.map((url) => fetchAddonManifest(url, 'Bulk-Pre-Install', true))
    )

    const validDescriptors: AddonDescriptor[] = []
    const invalidUrls: string[] = []

    manifestsResults.forEach((res, index) => {
      if (res.status === 'fulfilled') {
        validDescriptors.push(res.value)
      } else {
        invalidUrls.push(urls[index])
      }
    })

    if (validDescriptors.length === 0) {
      throw new Error(`Failed to fetch manifests from: ${invalidUrls.join(', ')} `)
    }

    const result: BulkResult = {
      success: 0,
      failed: 0,
      errors: [],
      details: [],
    }

    const workerResults = await mapConcurrent(accountIds, SAVED_ADDON_ACCOUNT_CONCURRENCY, async ({ id: accountId, authKey: accountAuthKey }) => {
      try {
        const { useAccountStore } = await import('../accountStore')
        const account = useAccountStore.getState().accounts.find(a => a.id === accountId)
        const hasNonStremioConnections = !!(account?.connections || []).some(c => c.enabled && isSyncEligibleConnection(c))
        const isLocalAccount = !accountAuthKey
        const isConnectedNonStremio = isLocalAccount && hasNonStremioConnections
        let currentAddons: AddonDescriptor[]
        let authKey = ''

        if (isLocalAccount) {
          currentAddons = account?.addons || []
        } else {
          authKey = await getCachedAuthKey(accountAuthKey, getEncryptionKey())
          currentAddons = await getAddons(authKey, accountId)
        }

        const updatedAddons = [...currentAddons]
        const mergeResultDetails: MergeResult = {
          added: [],
          updated: [],
          skipped: [],
          protected: [],
        }

        invalidUrls.forEach((url) => {
          mergeResultDetails.skipped.push({ addonId: url, reason: 'fetch-failed' })
        })

        for (const newAddon of validDescriptors) {
          const normNew = getAddonUrlKey(newAddon.transportUrl)
          const existingIndex = updatedAddons.findIndex(
            (a) => getAddonUrlKey(a.transportUrl) === normNew
          )

          if (existingIndex >= 0) {
            const existing = updatedAddons[existingIndex]
            if (existing.flags?.protected && !allowProtected) {
              mergeResultDetails.protected.push({
                addonId: existing.manifest.id,
                name: existing.manifest.name,
              })
              continue
            }

            const finalDescriptor = {
              ...newAddon,
              metadata: { ...existing.metadata, ...newAddon.metadata },
              catalogOverrides: existing.catalogOverrides,
            }

            updatedAddons[existingIndex] = finalDescriptor
            mergeResultDetails.updated.push({
              addonId: finalDescriptor.manifest.id,
              oldUrl: existing.transportUrl,
              newUrl: newAddon.transportUrl,
            })
          } else {
            updatedAddons.push(newAddon)
            mergeResultDetails.added.push({
              addonId: newAddon.manifest.id,
              name: newAddon.manifest.name,
              installUrl: newAddon.transportUrl,
            })
          }
        }

        const dedupedAddons = dedupeAddonsByTransportUrl(updatedAddons)

        if (isLocalAccount) {
          const state = useAccountStore.getState()
          const localAccount = state.accounts.find(a => a.id === accountId)
          if (localAccount) {
            let updatedAccount: Account = { ...localAccount, addons: dedupedAddons, deletedAddons: reconcileTombstones(localAccount.deletedAddons, dedupedAddons), lastSync: new Date() }
            updatedAccount = updateActiveProfile(updatedAccount, dedupedAddons)
            useAccountStore.setState({
              accounts: state.accounts.map(a => a.id === accountId ? updatedAccount : a)
            })
            persistAccounts(useAccountStore.getState().accounts)
          }
          if (isConnectedNonStremio) {
            const { pushToConnections } = await import('../account/accountAddonOps')
            pushToConnections(accountId).catch(err => { if (import.meta.env.DEV) console.error('Failed to push to connections:', err) })
          }
        } else {
          if (await shouldPushToStremio(accountId)) await updateAddons(authKey, dedupedAddons, accountId)
          const state = useAccountStore.getState()
          const stremioAccount = state.accounts.find(a => a.id === accountId)
          if (stremioAccount) {
            const clearedTombstones = reconcileTombstones(stremioAccount.deletedAddons, dedupedAddons)
            useAccountStore.setState({ accounts: state.accounts.map(a => a.id === accountId ? { ...a, deletedAddons: clearedTombstones } : a) })
            persistAccounts(useAccountStore.getState().accounts)
          }
          const { pushToConnections } = await import('../account/accountAddonOps')
          pushToConnections(accountId, { addons: dedupedAddons }).catch(() => { toast({ variant: 'destructive', title: 'Cross-platform sync failed', description: 'Addon changes saved locally but not pushed to connected platforms.' }) })
          const { scheduleSyncAccount } = await import('../account/accountSync')
          scheduleSyncAccount(accountId)
        }

        await useAddonStore.getState().syncAccountState(accountId, accountAuthKey, dedupedAddons)
        return { success: 1, failed: 0, detail: { accountId, result: mergeResultDetails } }
      } catch (error) {
        return {
          success: 0,
          failed: 1,
          error: { accountId, error: error instanceof Error ? error.message : 'Unknown error' },
        }
      }
    })

    for (const wr of workerResults) {
      result.success += wr.success
      result.failed += wr.failed
      if (wr.detail) result.details.push(wr.detail)
      if (wr.error) result.errors.push(wr.error)
    }

    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to bulk install from URLs'
    useAddonStore.setState({ error: message })
    throw error
  } finally {
    useAddonStore.setState({ loading: false })
  }
}

export async function bulkCloneAccount(
  sourceAccount: { id: string; authKey: string },
  targetAccountIds: Array<{ id: string; authKey: string }>,
  options?: { overwrite?: boolean; cloneMode?: CloneMode }
): Promise<BulkResult> {
  const overwrite = options?.overwrite ?? false
  const cloneMode = options?.cloneMode ?? 'full-mirror'
  const useAddonStore = await getStore()
  useAddonStore.setState({ loading: true, error: null })
  try {
    const { useAccountStore } = await import('../accountStore')

    if (useAccountStore.getState().accounts.length === 0) {
      await useAccountStore.getState().initialize()
    }

    const localSourceAccount = useAccountStore.getState().accounts.find(a => a.id === sourceAccount.id)

    const sourceAddons = localSourceAccount ? localSourceAccount.addons : await getAddons(await getCachedAuthKey(sourceAccount.authKey, getEncryptionKey()), sourceAccount.id)

    const result: BulkResult = {
      success: 0,
      failed: 0,
      errors: [],
      details: [],
    }

    const workerResults = await mapConcurrent(targetAccountIds, SAVED_ADDON_ACCOUNT_CONCURRENCY, async ({ id: accountId, authKey: accountAuthKey }) => {
      if (accountId === sourceAccount.id) return { success: 0, failed: 0 }

      try {
        const isLocalAccount = !accountAuthKey

        const localTargetAccount = useAccountStore.getState().accounts.find(a => a.id === accountId)
        const targetAddons = isLocalAccount
          ? (localTargetAccount?.addons || [])
          : (localTargetAccount ? localTargetAccount.addons : await getAddons(await getCachedAuthKey(accountAuthKey, getEncryptionKey()), accountId))

        if (overwrite && import.meta.env.DEV) {
          console.log(`[Clone] Overwrite mode: Strictly mirroring source add-ons onto ${accountId} `)
        }

        const newAddons = cloneAddonsWithMode(sourceAddons, targetAddons, { mode: cloneMode, overwrite })

        const addonListChanged = !haveSameAddonCollection(targetAddons, newAddons)
        if (addonListChanged) {
          await useAccountStore.getState().reorderAddons(accountId, newAddons)
        }

        if (addonListChanged) {
          await useAddonStore.getState().syncAccountState(accountId, accountAuthKey, newAddons)
        }

        return {
          success: 1,
          failed: 0,
          detail: {
            accountId,
            result: createCloneMergeResult(sourceAddons, targetAddons, newAddons, overwrite),
          },
        }
      } catch (error) {
        return {
          success: 0,
          failed: 1,
          error: { accountId, error: error instanceof Error ? error.message : 'Unknown error' },
        }
      }
    })

    for (const wr of workerResults) {
      result.success += wr.success
      result.failed += wr.failed
      if (wr.detail) result.details.push(wr.detail)
      if (wr.error) result.errors.push(wr.error)
    }
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to clone account'
    useAddonStore.setState({ error: message })
    throw error
  } finally {
    useAddonStore.setState({ loading: false })
  }
}

export async function bulkSyncOrder(
  sourceAccountId: string,
  targetAccountIds: Array<{ id: string; authKey: string }>
): Promise<BulkResult> {
  const useAddonStore = await getStore()
  useAddonStore.setState({ loading: true, error: null })
  try {
    const { useAccountStore } = await import('../accountStore')

    if (useAccountStore.getState().accounts.length === 0) {
      await useAccountStore.getState().initialize()
    }

    const localSourceAccount = useAccountStore.getState().accounts.find(a => a.id === sourceAccountId)
    if (!localSourceAccount) {
      throw new Error('Source account not found in local state')
    }

    const result: BulkResult = {
      success: 0,
      failed: 0,
      errors: [],
      details: [],
    }

    const workerResults = await mapConcurrent(targetAccountIds, SAVED_ADDON_ACCOUNT_CONCURRENCY, async ({ id: accountId, authKey: accountAuthKey }) => {
      if (accountId === sourceAccountId) return { success: 0, failed: 0, changed: false }

      try {
        const isLocalAccount = !accountAuthKey

        const localTarget = useAccountStore.getState().accounts.find(a => a.id === accountId)
        const targetAddons = isLocalAccount
          ? (localTarget?.addons || [])
          : (localTarget ? localTarget.addons : await getAddons(await getCachedAuthKey(accountAuthKey, getEncryptionKey()), accountId))

        const reorderedTargetAddons: AddonDescriptor[] = []
        let remainingTargetAddons = [...targetAddons]

        for (const sourceAddon of localSourceAccount.addons) {
          const srcNormUrl = normalizeAddonUrl(sourceAddon.transportUrl)
          const srcId = sourceAddon.manifest.id
          const srcName = sourceAddon.manifest.name

          let primaryMatchIndex = remainingTargetAddons.findIndex(t => t.transportUrl === sourceAddon.transportUrl)
          if (primaryMatchIndex === -1) {
            primaryMatchIndex = remainingTargetAddons.findIndex(t => normalizeAddonUrl(t.transportUrl) === srcNormUrl)
          }
          if (primaryMatchIndex === -1 && srcId) {
            primaryMatchIndex = remainingTargetAddons.findIndex(t => t.manifest.id === srcId)
          }

          if (primaryMatchIndex >= 0) {
            const primaryMatch = remainingTargetAddons[primaryMatchIndex]
            reorderedTargetAddons.push(primaryMatch)

            remainingTargetAddons = remainingTargetAddons.filter((_, i) => i !== primaryMatchIndex)

            if (srcId || srcName) {
              const duplicates = remainingTargetAddons.filter(t =>
                t.manifest.id === srcId ||
                t.manifest.name === srcName
              )
              if (duplicates.length > 0) {
                reorderedTargetAddons.push(...duplicates)
                remainingTargetAddons = remainingTargetAddons.filter(t =>
                  t.manifest.id !== srcId &&
                  t.manifest.name !== srcName
                )
              }
            }
          }
        }

        reorderedTargetAddons.push(...remainingTargetAddons)

        const orderChanged = !haveSameAddonOrder(targetAddons, reorderedTargetAddons)
        if (orderChanged) {
          await useAccountStore.getState().reorderAddons(accountId, reorderedTargetAddons)
        }

        return {
          success: 1,
          failed: 0,
          changed: orderChanged,
          detail: { accountId, result: createOrderMergeResult(targetAddons, reorderedTargetAddons) },
        }
      } catch (error) {
        return {
          success: 0,
          failed: 1,
          changed: false,
          error: { accountId, error: error instanceof Error ? error.message : 'Unknown error' },
        }
      }
    })

    let didChangeOrder = false
    for (const wr of workerResults) {
      result.success += wr.success
      result.failed += wr.failed
      if (wr.changed) didChangeOrder = true
      if (wr.detail) result.details.push(wr.detail)
      if (wr.error) result.errors.push(wr.error)
    }

    if (didChangeOrder) {
      const { useSyncStore } = await import('../syncStore')
      useSyncStore.getState().syncToRemote(false).catch(e => { if (import.meta.env.DEV) console.error(e) })
    }

    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to sync addon order'
    useAddonStore.setState({ error: message })
    throw error
  } finally {
    useAddonStore.setState({ loading: false })
  }
}

export async function syncAccountState(accountId: string, accountAuthKey: string, addons?: AddonDescriptor[]): Promise<void> {
  const m = await import('../addonStore') as typeof import('../addonStore')
  const useAddonStore: StoreRef = m.useAddonStore
  const _outboundSyncInProgress: Set<string> = m._outboundSyncInProgress
  try {
    let currentAddons: AddonDescriptor[]
    if (addons) {
      currentAddons = addons
    } else if (accountAuthKey) {
      const authKey = await getCachedAuthKey(accountAuthKey, getEncryptionKey())
      currentAddons = await getAddons(authKey, accountId)
    } else {
      const { useAccountStore } = await import('../accountStore')
      const account = useAccountStore.getState().accounts.find(a => a.id === accountId)
      currentAddons = account?.addons || []
    }

    const get = useAddonStore.getState
    const existingState = get().accountStates[accountId]
    const existingInstalled = existingState?.installedAddons || []
    const existingByInstallUrl = new Map(existingInstalled.map(addon => [addon.installUrl, addon]))
    const linkedSavedAddonIds = new Set(
      existingInstalled
        .map(addon => addon.savedAddonId)
        .filter((id): id is string => Boolean(id))
    )
    const library = get().library
    const savedAddons = Object.values(library)
    const savedAddonByNormalizedUrl = new Map(
      savedAddons.map(savedAddon => [normalizeUrl(savedAddon.installUrl), savedAddon])
    )
    const syncableSavedAddonByAddonId = new Map(
      savedAddons
        .filter(savedAddon => savedAddon.syncWithInstalled)
        .filter(savedAddon => !Array.isArray(savedAddon.syncAccountIds) || savedAddon.syncAccountIds.includes(accountId))
        .map(savedAddon => [savedAddon.manifest.id, savedAddon])
    )
    const installedAddons: InstalledAddon[] = []

    for (const addon of currentAddons) {
      const existing = existingByInstallUrl.get(addon.transportUrl)

      if (existing) {
        if (existing.savedAddonId) {
          const savedAddon = library[existing.savedAddonId]
          if (savedAddon && existing.syncToLibrary && !_outboundSyncInProgress.has(savedAddon.id)) {
            const incomingMetadata = addon.metadata || {}

            const hasNameChange = incomingMetadata.customName &&
              incomingMetadata.customName !== savedAddon.metadata?.customName
            const hasLogoChange = incomingMetadata.customLogo &&
              incomingMetadata.customLogo !== savedAddon.metadata?.customLogo
            const hasDescChange = incomingMetadata.customDescription &&
              incomingMetadata.customDescription !== savedAddon.metadata?.customDescription

            if (hasNameChange || hasLogoChange || hasDescChange) {
              if (import.meta.env.DEV) console.log(`[AddonStore] Inbound Sync: Detected metadata change for "${savedAddon.name}" on source account ${accountId}. Updating library.`)
              await useAddonStore.getState().updateSavedAddonMetadata(savedAddon.id, {
                ...(hasNameChange && { customName: incomingMetadata.customName }),
                ...(hasLogoChange && { customLogo: incomingMetadata.customLogo }),
                ...(hasDescChange && { customDescription: incomingMetadata.customDescription }),
              }, true).catch(e => { if (import.meta.env.DEV) console.error(e) })
            }
          }
        }

        installedAddons.push({
          ...existing,
          installUrl: addon.transportUrl,
          syncToLibrary: existing.syncToLibrary ?? false,
          flags: {
            ...addon.flags,
            official: getOfficialFlag(addon.manifest?.id || '', addon.flags?.official),
          },
        })
        continue
      }

      const addonId = addon.manifest?.id || ''
      const syncableSavedAddon = syncableSavedAddonByAddonId.get(addonId)

      const alreadyLinked = syncableSavedAddon
        ? linkedSavedAddonIds.has(syncableSavedAddon.id)
        : false

      if (syncableSavedAddon && syncableSavedAddon.installUrl !== addon.transportUrl && alreadyLinked) {
        if (import.meta.env.DEV) console.log(`[AddonStore] Inbound Sync: Updating library URL for "${syncableSavedAddon.name}" from account ${accountId}`)
        useAddonStore.getState().replaceTransportUrlUniversally(syncableSavedAddon.id, syncableSavedAddon.installUrl, addon.transportUrl, accountId).catch(e => { if (import.meta.env.DEV) console.error(e) })

        installedAddons.push({
          savedAddonId: syncableSavedAddon.id,
          addonId,
          installUrl: addon.transportUrl,
          installedAt: new Date(),
          installedVia: 'saved-addon',
          appliedTags: syncableSavedAddon.tags,
          flags: {
            ...addon.flags,
            official: getOfficialFlag(addon.manifest?.id || '', addon.flags?.official),
          },
        })
        continue
      }

      const matchingSavedAddon = savedAddonByNormalizedUrl.get(normalizeUrl(addon.transportUrl))

      installedAddons.push({
        savedAddonId: matchingSavedAddon?.id || null,
        addonId: addonId || addon.manifest?.id || '',
        installUrl: addon.transportUrl,
        installedAt: new Date(),
        installedVia: matchingSavedAddon ? 'saved-addon' : 'manual',
        appliedTags: matchingSavedAddon?.tags,
        flags: {
          ...addon.flags,
          official: getOfficialFlag(addon.manifest?.id || '', addon.flags?.official),
        },
      })
    }

    const remoteUrls = new Set(currentAddons.map(a => normalizeAddonUrl(a.transportUrl)))
    if (existingState) {
      for (const existing of existingState.installedAddons) {
        const normUrl = normalizeAddonUrl(existing.installUrl)
        if (!remoteUrls.has(normUrl)) {
          if ((existing.flags?.enabled === false || existing.flags?.protected) && !existing.savedAddonId) {
            if (!installedAddons.some(a => normalizeAddonUrl(a.installUrl) === normUrl)) {
              installedAddons.push(existing)
            }
          }
        }
      }
    }

    const isDirty = JSON.stringify(installedAddons.map(a => a.installUrl).sort()) !==
      JSON.stringify(existingInstalled.map(a => a.installUrl).sort())

    const state: AccountAddonState = {
      accountId,
      installedAddons,
      lastSync: new Date(),
    }

    const accountStates = { ...get().accountStates, [accountId]: state }
    useAddonStore.setState({ accountStates })

    if (isDirty) {
      await saveAccountAddonStates(accountStates)

      triggerSync()
    }
  } catch (error) {
    if (import.meta.env.DEV) console.error('Failed to sync account state:', error)
    throw error
  }
}

export async function syncAllAccountStates(accounts: Account[]) {
  await mapConcurrent(accounts, SAVED_ADDON_ACCOUNT_CONCURRENCY, async (account) => {
    try {
      const stremioKey = getStremioAuthKey(account)
      if (stremioKey) {
        await syncAccountState(account.id, stremioKey)
      } else {
        await syncAccountState(account.id, '', account.addons || [])
      }
    } catch (error) {
      if (import.meta.env.DEV) console.error(`Failed to sync account ${account.id}: `, error)
    }
  })
}

export async function replaceTransportUrlUniversally(
  savedAddonId: string | null,
  oldUrl: string,
  newUrl: string,
  accountId?: string,
  descriptor?: AddonDescriptor
): Promise<ReplaceTransportUrlResult> {
  const m = await import('../addonStore') as typeof import('../addonStore')
  const useAddonStore: StoreRef = m.useAddonStore
  const _saveLibraryDebounced = m._saveLibraryDebounced as (getState: () => AddonStore) => void
  useAddonStore.setState({ isUpdatingAddon: true, error: null })
  try {
    if (oldUrl.trim() === newUrl.trim()) return { updatedAccountIds: [], failedAccounts: [] }

    let freshManifest = null
    try {
      const descriptorToUse = descriptor || await fetchAddonManifest(newUrl, 'System-Check')
      freshManifest = identifyAddon(newUrl, descriptorToUse.manifest)
    } catch (err) {
      if (import.meta.env.DEV) console.warn('[AddonStore] Could not fetch fresh manifest for URL replacement.', err)
      throw new Error(err instanceof Error ? `Could not fetch replacement manifest: ${err.message}` : 'Could not fetch replacement manifest')
    }

    if (savedAddonId) {
      const savedAddon = useAddonStore.getState().library[savedAddonId]
      if (savedAddon) {
        const updatedSavedAddon = {
          ...savedAddon,
          installUrl: newUrl,
          manifest: freshManifest || savedAddon.manifest,
          updatedAt: new Date(),
        }

        const library = { ...useAddonStore.getState().library, [savedAddonId]: updatedSavedAddon }
        useAddonStore.setState({ library })
        _saveLibraryDebounced(useAddonStore.getState)
        if (import.meta.env.DEV) console.log(`[AddonStore] Library URL updated for "${savedAddon.name}"`)
      }
    }

    const { useAccountStore } = await import('@/store/accountStore')
    const metadata = savedAddonId ? useAddonStore.getState().library[savedAddonId]?.metadata : undefined
    const replacementResult = await useAccountStore.getState().replaceTransportUrl(oldUrl, newUrl, accountId, freshManifest, metadata)

    const { useFailoverStore } = await import('@/store/failoverStore')
    await useFailoverStore.getState().replaceUrlInRules(oldUrl, newUrl, accountId)

    if (import.meta.env.DEV) console.log(`[AddonStore] Scoped URL replacement complete: ${oldUrl.substring(0, 30)}... -> ${newUrl.substring(0, 30)}... (Account: ${accountId || 'Global'})`)
    return replacementResult
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to replace URL universally'
    useAddonStore.setState({ error: message })
    if (import.meta.env.DEV) console.error('[AddonStore] Universal replacement failed:', error)
    throw error
  } finally {
    useAddonStore.setState({ isUpdatingAddon: false })
  }
}

export async function bulkReinstallAllOnAccount(accountId: string, accountAuthKey: string) {
  return bulkReinstallAddons(['*'], [{ id: accountId, authKey: accountAuthKey }], true)
}
