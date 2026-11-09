import { triggerSync } from '@/lib/sync-trigger'
import { toast } from '@/hooks/use-toast'
import { ACCOUNT_CONTEXT_BULK_OP } from '@/lib/account-contexts'
import { getAddons, updateAddons, fetchAddonManifest } from '@/api/addons'
import { identifyAddon } from '@/lib/addon-identifier'
import { mergeAddons, removeAddons } from '@/lib/addon-merger'
import { dedupeAddonsByUrl, findInstallSlot, getAddonUrlKey } from '@/lib/addon-dedupe'
import { normalizeAddonUrl, getAddonVersionKey, maskAccountLabel } from '@/lib/utils'
import { askDeployDecision } from '@/store/deployDecisionStore'
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
  DeployCandidate,
  DeployChoice,
  DeployDecider,
  DeployDecisionItem,
  MergeResult,
  SavedAddon,
} from '@/types/saved-addon'
import type { AddonStore } from '../addonStore'
import type { ReplaceTransportUrlResult } from '@/store/accountStore'
import { getEffectiveManifest } from '@/lib/addon-utils'
import { getCachedManifest, setCachedManifest } from '@/lib/manifest-cache'
import { mapConcurrent } from '@/lib/concurrency'
import { getStremioAuthKey, getStremioConnection } from '@/lib/account-compat'
import { effectiveAddonsFor, excludedUrlsFor } from '@/lib/addon-destinations'
import { getOfficialFlag } from '@/lib/addon-official'

function isStremioPushEnabled(account: Account | undefined | null): boolean {
    if (!account) return true
    // The gate follows the CANONICAL Stremio login, matching where addon pushes route.
    const conn = getStremioConnection(account)
    return !conn || conn.enabled !== false
}

async function shouldPushToStremio(accountId: string): Promise<boolean> {
    const { useAccountStore } = await import('../accountStore')
    const account = useAccountStore.getState().accounts.find(a => a.id === accountId)
    return isStremioPushEnabled(account)
}

/**
 * Destination-policy projection for deployment writes. These paths write the
 * CANONICAL Stremio login directly with its sealed key, so the write list must drop
 * rows that login's policy excludes (platform-wide stremio entries and the exact
 * canonical connection id), and the anti-wipe guard must see those removals as
 * authorized (R2). Deploy lists merge platform reads / library rows that carry no
 * policy — the HUB row is the policy home, so its destinations are grafted onto
 * matching URLs before filtering: a deploy must never re-install a row the canonical
 * login excludes. Secondary Stremio logins are covered by the server reconcile that
 * the follow-up pushToConnections schedules.
 */
async function canonicalStremioDeployProjection(accountId: string, addons: AddonDescriptor[]): Promise<{ list: AddonDescriptor[]; authorizedRemovals: Set<string> }> {
    const { useAccountStore } = await import('../accountStore')
    const account = useAccountStore.getState().accounts.find(a => a.id === accountId)
    const target = { platform: 'stremio', connectionId: account ? getStremioConnection(account)?.id : undefined }
    const policyByUrl = new Map<string, AddonDescriptor['destinations']>()
    for (const row of account?.addons || []) {
        const url = normalizeAddonUrl(row.transportUrl)
        if (url && row.destinations) policyByUrl.set(url, row.destinations)
    }
    const withPolicy = addons.map(a => {
        const url = normalizeAddonUrl(a.transportUrl)
        return url && policyByUrl.has(url) && !a.destinations ? { ...a, destinations: policyByUrl.get(url) } : a
    })
    const projected = effectiveAddonsFor(withPolicy, target)
    return {
        list: projected,
        authorizedRemovals: excludedUrlsFor(withPolicy, target),
    }
}

/**
 * The common guarded destination-aware push for single-target user writes: the
 * canonical Stremio login receives the enabled destination projection of the
 * caller's hub list, with policy removals authorized for the anti-wipe guard.
 */
export async function pushHubToStremio(accountId: string, authKey: string, addons: AddonDescriptor[]): Promise<void> {
    if (!(await shouldPushToStremio(accountId))) return
    const projection = await canonicalStremioDeployProjection(accountId, addons)
    await updateAddons(authKey, projection.list, accountId, { authorizedRemovals: projection.authorizedRemovals })
}
import { addTombstones, restoreAddonDeletions } from '@/lib/addon-tombstones'
import { queueAddonActionDeletes, addonDeleteAcks } from '../account/addonActions'
import { captureSyncOwnership } from '../sync-store-helpers'
import { trace } from '@/lib/trace'
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

export function updateActiveProfile(account: Account, updatedAddons: AddonDescriptor[]): Account {
  if (!account.activeProfileId || !account.profiles) return account
  return {
    ...account,
    profiles: account.profiles.map((p) =>
      p.id === account.activeProfileId ? { ...p, addons: updatedAddons } : p
    ),
  }
}

function explicitMergeAddons(result: MergeResult, appliedAddons: AddonDescriptor[]): Array<{ transportUrl: string }> {
  const appliedUrls = new Set(appliedAddons.map(addon => getAddonUrlKey(addon.transportUrl)))
  return [
    ...result.added.map(addon => ({ transportUrl: addon.installUrl })),
    ...result.updated.map(addon => ({ transportUrl: addon.newUrl })),
  ].filter(addon => appliedUrls.has(getAddonUrlKey(addon.transportUrl)))
}

async function acknowledgeExplicitInstall(accountId: string, result: MergeResult, appliedAddons: AddonDescriptor[]): Promise<void> {
  const installed = explicitMergeAddons(result, appliedAddons)
  if (installed.length === 0) return
  const { useAccountStore } = await import('../accountStore')
  const state = useAccountStore.getState()
  const account = state.accounts.find(a => a.id === accountId)
  if (!account) return
  const deletionState = restoreAddonDeletions(account.deletedAddons, account.restoredAddons, installed)
  useAccountStore.setState({ accounts: state.accounts.map(a => a.id === accountId ? { ...a, ...deletionState } : a) })
  persistAccounts(useAccountStore.getState().accounts)
}

import { SAVED_ADDON_ACCOUNT_CONCURRENCY } from './deployment-constants'
export { SAVED_ADDON_ACCOUNT_CONCURRENCY }

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
  const { acquireSyncMutex } = await import('../accountStore')
  const release = await acquireSyncMutex(accountId)
  try {
    const savedAddon = useAddonStore.getState().library[savedAddonId]
    if (!savedAddon) {
      throw new Error('Saved addon not found')
    }

    const authKey = await getCachedAuthKey(accountAuthKey, getEncryptionKey())
    const platformRead = await getAddons(authKey, accountId)
    // The hub is the deploy's source of truth: platform rows only add, hub flags and
    // policy win regardless of lastUpdated, tombstoned remote rows stay suppressed (R3-01, DC-01).
    const { useAccountStore } = await import('../accountStore')
    const { mergeRemoteIntoHub } = await import('../account/accountSync')
    const account = useAccountStore.getState().accounts.find(a => a.id === accountId)
    const currentAddons = account ? mergeRemoteIntoHub(account, platformRead, { keepLocalFlags: true }) : platformRead
    trace('deploy.apply', 'read', { savedAddonId, accountId, current: currentAddons.length })

    const { addons: updatedAddons, result } = await mergeAddons(
      currentAddons,
      [savedAddon],
      accountId,
      true,
      Object.values(useAddonStore.getState().library),
      () => 'keep'
    )

    await pushHubToStremio(accountId, authKey, updatedAddons)
    await acknowledgeExplicitInstall(accountId, result, updatedAddons)
    const current = useAccountStore.getState()
    const hubAccount = current.accounts.find(a => a.id === accountId)
    if (hubAccount) {
      const updatedAccount = updateActiveProfile({ ...hubAccount, addons: updatedAddons, lastSync: new Date() }, updatedAddons)
      useAccountStore.setState({ accounts: current.accounts.map(a => a.id === accountId ? updatedAccount : a) })
      persistAccounts(useAccountStore.getState().accounts)
    }
    trace('deploy.apply', 'pushed', { savedAddonId, accountId, count: updatedAddons.length })
    const { pushToConnections } = await import('../account/accountAddonOps')
    pushToConnections(accountId, { addons: updatedAddons }).catch(() => { toast({ variant: 'destructive', title: 'Cross-platform sync failed', description: 'Addon changes saved locally but not pushed to connected platforms.', href: `/account/${encodeURIComponent(accountId)}` }) })

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
    release()
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
  const { acquireSyncMutex } = await import('../accountStore')
  const release = await acquireSyncMutex(accountId)
  try {
    const authKey = await getCachedAuthKey(accountAuthKey, getEncryptionKey())
    const platformRead = await getAddons(authKey, accountId)
    // The hub is the deploy's source of truth: platform rows only add, hub flags and
    // policy win regardless of lastUpdated, tombstoned remote rows stay suppressed (R3-01, DC-01).
    const { useAccountStore } = await import('../accountStore')
    const { mergeRemoteIntoHub } = await import('../account/accountSync')
    const account = useAccountStore.getState().accounts.find(a => a.id === accountId)
    const currentAddons = account ? mergeRemoteIntoHub(account, platformRead, { keepLocalFlags: true }) : platformRead

    const { addons: updatedAddons, result } = await mergeAddons(
      currentAddons,
      savedAddons,
      accountId,
      true,
      Object.values(useAddonStore.getState().library),
      () => 'keep'
    )

    await pushHubToStremio(accountId, authKey, updatedAddons)
    await acknowledgeExplicitInstall(accountId, result, updatedAddons)
    const current = useAccountStore.getState()
    const hubAccount = current.accounts.find(a => a.id === accountId)
    if (hubAccount) {
      const updatedAccount = updateActiveProfile({ ...hubAccount, addons: updatedAddons, lastSync: new Date() }, updatedAddons)
      useAccountStore.setState({ accounts: current.accounts.map(a => a.id === accountId ? updatedAccount : a) })
      persistAccounts(useAccountStore.getState().accounts)
    }
    const { pushToConnections } = await import('../account/accountAddonOps')
    pushToConnections(accountId, { addons: updatedAddons }).catch(() => { toast({ variant: 'destructive', title: 'Cross-platform sync failed', description: 'Addon changes saved locally but not pushed to connected platforms.', href: `/account/${encodeURIComponent(accountId)}` }) })

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
    release()
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
  allowProtected = true,
  options: { batch?: AbortController } = {}
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

    type Awaiting = { pending: DeployDecisionItem[]; candidates: Record<string, DeployCandidate> }
    const awaiting = new Map<string, Awaiting>()
    // An account with a question nothing has answered (or whose answer no longer
    // matches its candidate) is held back unwritten and its questions are returned.
    // A cancelled batch (Cancel on any of its questions, or the batch's own Cancel) stops
    // every account before its first write; 'stopped' marks an account it stopped.
    const batchCancelled = () => !!options.batch?.signal.aborted
    const deployToAccount = async ({ id: accountId, authKey: accountAuthKey }: { id: string; authKey: string }, decide?: DeployDecider): Promise<Awaiting | 'stopped' | undefined> => {
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
          const platformRead = await getAddons(authKey, accountId)
          // The hub is the deploy's source of truth: platform rows only add, hub flags
          // and policy win regardless of lastUpdated, tombstoned remote rows stay
          // suppressed (R3-01, DC-01).
          const { mergeRemoteIntoHub } = await import('../account/accountSync')
          currentAddons = account ? mergeRemoteIntoHub(account, platformRead, { keepLocalFlags: true }) : platformRead
        }

        trace('deploy', 'before-merge', { accountId, isLocalAccount, hasNonStremioConnections, current: currentAddons.length, saving: savedAddons.length, savingIds: savedAddons.map(s => s.manifest.id), currentIds: currentAddons.map(a => a.manifest?.id || '?') })

        const { addons: mergedAddons, result: mergeResult } = await mergeAddons(
          currentAddons,
          savedAddons,
          accountId,
          allowProtected,
          Object.values(useAddonStore.getState().library),
          decide
        )

        if (mergeResult.pending?.length) {
          trace('deploy', 'awaiting-decision', { accountId, pending: mergeResult.pending.map(p => p.addonId) })
          return { pending: mergeResult.pending, candidates: mergeResult.candidates || {} }
        }

        trace('deploy', 'after-merge', { accountId, added: mergeResult.added.map(a => a.addonId), updated: mergeResult.updated.map(u => u.addonId), skipped: mergeResult.skipped.map(s => s.addonId), protected: mergeResult.protected.map(p => p.addonId), merged: mergedAddons.length })

        // mergeAddons already deduped and kept the planner's separate copies apart.
        const updatedAddons = mergedAddons.map(addon => ({
          ...addon,
          metadata: {
            ...(addon.metadata || {}),
            lastUpdated: Date.now()
          }
        }))
        const installed = explicitMergeAddons(mergeResult, updatedAddons)
        // A Replace answer removed exactly these old URLs: tombstone them (never one still
        // installed, never the new copy) so a stale sync or cloud snapshot cannot bring them back.
        const stillInstalled = new Set(updatedAddons.map(a => normalizeAddonUrl(a.transportUrl)))
        const replacedOld = (mergeResult.replaced || []).filter(r => !stillInstalled.has(normalizeAddonUrl(r.oldUrl)))
        // A Stremio read carries no Hub policy: the replaced Hub row's destinations move onto
        // the library copy before any write or connection fan-out is projected (R1).
        if (!isLocalAccount) {
          for (const r of replacedOld) {
            const policy = account?.addons.find(row => normalizeAddonUrl(row.transportUrl) === normalizeAddonUrl(r.oldUrl))?.destinations
            const i = updatedAddons.findIndex(a => normalizeAddonUrl(a.transportUrl) === normalizeAddonUrl(r.newUrl))
            if (policy && i >= 0 && !updatedAddons[i].destinations) updatedAddons[i] = { ...updatedAddons[i], destinations: policy }
          }
        }
        const withReplaceTombstones = (state: { deletedAddons: Record<string, number>; restoredAddons: Record<string, number> }) =>
          replacedOld.length === 0 ? state : { ...state, deletedAddons: addTombstones(state.deletedAddons, replacedOld.map(r => r.oldUrl), Date.now(), state.restoredAddons) }

        if (batchCancelled()) {
          trace('deploy', 'stopped', { accountId })
          return 'stopped'
        }
        if (isLocalAccount) {
          const state = useAccountStore.getState()
          const localAccount = state.accounts.find(a => a.id === accountId)
          if (localAccount) {
            const deletionState = withReplaceTombstones(restoreAddonDeletions(localAccount.deletedAddons, localAccount.restoredAddons, installed))
            let updatedAccount: Account = { ...localAccount, addons: updatedAddons, ...deletionState, lastSync: new Date() }
            updatedAccount = updateActiveProfile(updatedAccount, updatedAddons)
            useAccountStore.setState({
              accounts: state.accounts.map(a => a.id === accountId ? updatedAccount : a)
            })
            persistAccounts(useAccountStore.getState().accounts)
          }
          if (replacedOld.length > 0) {
            const tombstones = useAccountStore.getState().accounts.find(a => a.id === accountId)?.deletedAddons
            queueAddonActionDeletes(accountId, addonDeleteAcks(tombstones, replacedOld.map(r => r.oldUrl)), captureSyncOwnership())
          }
          if (isConnectedNonStremio) {
            const { pushToConnections } = await import('../account/accountAddonOps')
            pushToConnections(accountId, { signal: options.batch?.signal }).catch(err => { if (import.meta.env.DEV) console.error('Failed to push to connections:', err) })
          }
        } else {
          const state = useAccountStore.getState()
          const stremioAccount = state.accounts.find(a => a.id === accountId)
          let finalAddons = updatedAddons
          if (stremioAccount && replacedOld.length > 0) {
            // The Hub row of a replaced copy becomes the library copy in place, keeping
            // its own flags and policy, so no stale copy is listed next to the new one.
            finalAddons = updatedAddons.map(addon => {
              const swap = replacedOld.find(r => normalizeAddonUrl(r.newUrl) === normalizeAddonUrl(addon.transportUrl))
              const hubRow = swap && stremioAccount.addons.find(row => normalizeAddonUrl(row.transportUrl) === normalizeAddonUrl(swap.oldUrl))
              return hubRow ? { ...hubRow, transportUrl: addon.transportUrl, manifest: addon.manifest, metadata: { ...hubRow.metadata, ...addon.metadata } } : addon
            })
          }
          trace('deploy', 'stremio-push', { accountId, pushing: finalAddons.length, ids: finalAddons.map(a => a.manifest?.id || '?') })
          if (await shouldPushToStremio(accountId)) {
            const stremioProjection = await canonicalStremioDeployProjection(accountId, finalAddons)
            // Last check before the remote write; once it lands, the Hub, tombstone and rule
            // bookkeeping below always follows so the account stays consistent.
            if (batchCancelled()) {
              trace('deploy', 'stopped', { accountId })
              return 'stopped'
            }
            await updateAddons(authKey, stremioProjection.list, accountId, { authorizedRemovals: stremioProjection.authorizedRemovals })
          }
          // Commit only this account against the LATEST store state: sibling accounts in
          // the same batch may have committed while this write was in flight, and their
          // installs and tombstones must survive (DC-02). The deletion bookkeeping is
          // derived from the latest target account inside the update.
          useAccountStore.setState(prev => {
            const current = prev.accounts.find(a => a.id === accountId)
            if (!current) return {}
            const deletionState = withReplaceTombstones(restoreAddonDeletions(current.deletedAddons, current.restoredAddons, installed))
            const updatedAccount = updateActiveProfile({ ...current, addons: finalAddons, ...deletionState, lastSync: new Date() }, finalAddons)
            return { accounts: prev.accounts.map(a => a.id === accountId ? updatedAccount : a) }
          })
          persistAccounts(useAccountStore.getState().accounts)
          if (replacedOld.length > 0) {
            const tombstones = useAccountStore.getState().accounts.find(a => a.id === accountId)?.deletedAddons
            queueAddonActionDeletes(accountId, addonDeleteAcks(tombstones, replacedOld.map(r => r.oldUrl)), captureSyncOwnership())
          }
          const { pushToConnections } = await import('../account/accountAddonOps')
          pushToConnections(accountId, { addons: finalAddons, signal: options.batch?.signal }).catch(() => { toast({ variant: 'destructive', title: 'Cross-platform sync failed', description: 'Addon changes saved locally but not pushed to connected platforms.', href: `/account/${encodeURIComponent(accountId)}` }) })
          // Debounced additive refresh keeps manifests and bookkeeping current.
          const { scheduleSyncAccount } = await import('../account/accountSync')
          scheduleSyncAccount(accountId)
        }

        // Failover rules follow a replaced copy like every other URL swap (best effort).
        if (replacedOld.length > 0) {
          const { useFailoverStore } = await import('@/store/failoverStore')
          for (const r of replacedOld) {
            await useFailoverStore.getState().replaceUrlInRules(r.oldUrl, r.newUrl, accountId).catch(() => {})
          }
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
    }

    // Every read, merge and write runs under the account's sync mutex; an account that
    // must ask releases it while the question is open and re-reads under it to write.
    const { acquireSyncMutex: lockAccount } = await import('../accountStore')
    await mapConcurrent(accountIds, SAVED_ADDON_ACCOUNT_CONCURRENCY, async target => {
      const release = await lockAccount(target.id)
      let held: Awaiting | 'stopped' | undefined
      try {
        held = batchCancelled() ? 'stopped' : await deployToAccount(target)
      } finally {
        release()
      }
      if (held === 'stopped') result.cancelled = (result.cancelled || 0) + 1
      else if (held) awaiting.set(target.id, held)
    })

    // Accounts holding an older different-config copy ask one question per copy,
    // in account order; each account is written right after its answers.
    const asking = accountIds.filter(target => awaiting.has(target.id))
    if (asking.length > 0) {
      const { useAccountStore, acquireSyncMutex } = await import('../accountStore')
      const { useUIStore } = await import('../uiStore')
      const ui = useUIStore.getState()
      const nameLevel = ui.isPrivacyModeEnabled ? ui.privacyLevelNames : 0
      const emailLevel = ui.isPrivacyModeEnabled ? ui.privacyLevelEmail : 0
      let total = asking.reduce((n, target) => n + (awaiting.get(target.id)?.pending.length || 0), 0)
      let asked = 0
      let sticky: DeployChoice | null = null
      let cancelled = false
      for (const [position, target] of asking.entries()) {
        if (cancelled || batchCancelled()) { cancelled = true; result.cancelled = (result.cancelled || 0) + 1; continue }
        const account = useAccountStore.getState().accounts.find(a => a.id === target.id)
        const accountLabel = maskAccountLabel(account, nameLevel, emailLevel)
        // A Replace answer binds to the exact entry it was asked about. The write replans
        // under the account's sync mutex; if a sync changed or removed that entry meanwhile,
        // the account is asked again (keep both once questions run out).
        const approvals = new Map<string, { choice: DeployChoice } & DeployCandidate>()
        const decide: DeployDecider = (savedAddonId, candidate) => {
          const approval = approvals.get(savedAddonId)
          if (!approval) return undefined
          if (approval.choice === 'keep') return 'keep'
          return approval.key === candidate.key && approval.index === candidate.index ? 'replace' : undefined
        }
        let held: Awaiting | undefined = awaiting.get(target.id)
        for (let round = 0; held && !cancelled; round++) {
          for (const item of held.pending) {
            const candidate = held.candidates[item.savedAddonId]
            if (round > 0) total++
            asked++
            if (round >= 3) { approvals.set(item.savedAddonId, { choice: 'keep', ...candidate }); continue }
            if (sticky && round === 0) { approvals.set(item.savedAddonId, { choice: sticky, ...candidate }); continue }
            const answer = await askDeployDecision({ accountLabel, addonName: item.name, existingLabel: item.existingLabel, libraryLabel: item.libraryLabel, index: asked, total, remainingAccounts: asking.length - position - 1 }, options.batch?.signal)
            if (answer === 'cancel') { cancelled = true; options.batch?.abort(); break }
            const choice = answer?.choice ?? 'keep'
            approvals.set(item.savedAddonId, { choice, ...candidate })
            if (answer?.applyToRest) sticky = choice
          }
          if (cancelled) break
          trace('deploy', 'decided', { accountId: target.id, round, choices: [...approvals.values()].map(a => a.choice) })
          const release = await acquireSyncMutex(target.id)
          try {
            const outcome = batchCancelled() ? 'stopped' : await deployToAccount(target, decide)
            if (outcome === 'stopped') cancelled = true
            else held = outcome
          } finally {
            release()
          }
        }
        if (cancelled) { result.cancelled = (result.cancelled || 0) + 1; continue }
      }
    }

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
            if (await shouldPushToStremio(accountId)) {
                const stremioProjection = await canonicalStremioDeployProjection(accountId, updatedAddons)
                await updateAddons(authKey, stremioProjection.list, ACCOUNT_CONTEXT_BULK_OP, { previousCollection: currentAddons, allowCollectionShrink: true, authorizedRemovals: stremioProjection.authorizedRemovals })
            }
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
  onProgress?: (current: number, total: number) => void,
  options: { skipConnectionPlatforms?: string[] } = {}
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
          if (await shouldPushToStremio(accountId)) {
            const stremioProjection = await canonicalStremioDeployProjection(accountId, targetCollection)
            await updateAddons(authKey, stremioProjection.list, accountId, { authorizedRemovals: stremioProjection.authorizedRemovals })
          }
        }

        const { pushToConnections } = await import('../account/accountAddonOps')
        pushToConnections(accountId, { addons: updateResults.length > 0 ? targetCollection : undefined, skipPlatforms: options.skipConnectionPlatforms }).catch(() => { toast({ variant: 'destructive', title: 'Cross-platform sync failed', description: 'Addon changes saved locally but not pushed to connected platforms.', href: `/account/${encodeURIComponent(accountId)}` }) })

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

        const preExisting = updatedAddons.length
        const taken = new Set<number>()
        for (const newAddon of validDescriptors) {
          const existingIndex = findInstallSlot(updatedAddons, newAddon, preExisting, taken)

          if (existingIndex >= 0) {
            taken.add(existingIndex)
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
              flags: existing.flags ?? newAddon.flags,
              metadata: { ...existing.metadata, ...newAddon.metadata },
              catalogOverrides: existing.catalogOverrides,
              destinations: existing.destinations,
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

        const dedupedAddons = dedupeAddonsByUrl(updatedAddons)
        const installed = explicitMergeAddons(mergeResultDetails, dedupedAddons)

        if (isLocalAccount) {
          const state = useAccountStore.getState()
          const localAccount = state.accounts.find(a => a.id === accountId)
          if (localAccount) {
            const deletionState = restoreAddonDeletions(localAccount.deletedAddons, localAccount.restoredAddons, installed)
            let updatedAccount: Account = { ...localAccount, addons: dedupedAddons, ...deletionState, lastSync: new Date() }
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
          if (await shouldPushToStremio(accountId)) {
            const stremioProjection = await canonicalStremioDeployProjection(accountId, dedupedAddons)
            await updateAddons(authKey, stremioProjection.list, accountId, { authorizedRemovals: stremioProjection.authorizedRemovals })
          }
          const state = useAccountStore.getState()
          const stremioAccount = state.accounts.find(a => a.id === accountId)
          if (stremioAccount) {
            const deletionState = restoreAddonDeletions(stremioAccount.deletedAddons, stremioAccount.restoredAddons, installed)
            useAccountStore.setState({ accounts: state.accounts.map(a => a.id === accountId ? { ...a, ...deletionState } : a) })
            persistAccounts(useAccountStore.getState().accounts)
          }
          const { pushToConnections } = await import('../account/accountAddonOps')
          pushToConnections(accountId, { addons: dedupedAddons }).catch(() => { toast({ variant: 'destructive', title: 'Cross-platform sync failed', description: 'Addon changes saved locally but not pushed to connected platforms.', href: `/account/${encodeURIComponent(accountId)}` }) })
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
        const sourceUrls = new Set(sourceAddons.map(addon => getAddonUrlKey(addon.transportUrl)))
        const explicitInstallUrls = newAddons.filter(addon => sourceUrls.has(getAddonUrlKey(addon.transportUrl))).map(addon => addon.transportUrl)
        const restoresDeletedAddon = explicitInstallUrls.some(url => localTargetAccount?.deletedAddons?.[normalizeAddonUrl(url)] !== undefined)
        if (addonListChanged || restoresDeletedAddon) {
          await useAccountStore.getState().reorderAddons(accountId, newAddons, { explicitInstallUrls })
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

      // Keep in sync is one-way (library to accounts): an account's own URL stays on its
      // record and never rewrites the shared library entry from a read.
      if (syncableSavedAddon && syncableSavedAddon.installUrl !== addon.transportUrl && alreadyLinked) {
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
