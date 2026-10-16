import { triggerSync } from '@/lib/sync-trigger'
import {
    getAddons,
    updateAddons,
    fetchAddonManifest as apiFetchAddonManifest,
} from '@/api/addons'
import { mergeAddons, normalizeAddonUrl, hasFallbackAddonName } from '@/lib/utils'
import { filterResurrected, mergeAddonDeletionState } from '@/lib/addon-tombstones'
import { trace } from '@/lib/trace'
import { fingerprintAddonList } from '@/lib/addon-fingerprint'
import { mapConcurrent } from '@/lib/concurrency'
import { isSyncEligibleConnection, type ConnectionStatus } from '@/types/connection'
import { useAuthStore } from '@/store/authStore'
import { AddonDescriptor } from '@/types/addon'
import type { Account } from '@/types/account'
import { CinemetaManifest } from '@/types/cinemeta'
import { isCinemetaAddon, detectAllPatches, applyCinemetaConfiguration } from '@/lib/cinemeta-utils'
import { syncManager } from '@/lib/sync/syncManager'
import { getEffectiveManifest } from '@/lib/addon-utils'
import { inferCustomMetadata } from '@/lib/addon-custom-metadata'
import { getHostnameIdentifier } from '@/lib/addon-identifier'
import { getCachedManifest, setCachedManifest, recordManifestFetchFailure, shouldSkipManifestFetch, hydrateManifestCache } from '@/lib/manifest-cache'
import {
    getCachedAuthKey,
    getEncryptionKey,
    sanitizeAddonManifest,
    isAuthError,
    isTransientSyncError,
    refreshAuthKeyFromStoredPassword,
    applyAutopilotAddonFlags,
    needsDisabledAddonIdentityRepair,
    getAccountById,
    persistAccounts,
    syncMutexes,
    getStremioAuthKey,
    setAccountLoading,
    clearAccountLoading,
    setAccountsLoading,
    clearAllAccountLoading,
} from '../accountStore'
import type { AccountStore } from '../accountStore'

type StoreRef = { getState: () => AccountStore; setState: (partial: Partial<AccountStore> | ((state: AccountStore) => Partial<AccountStore>)) => void }

async function getStore(): Promise<StoreRef> {
    const { useAccountStore } = await import('../accountStore')
    return useAccountStore
}

let _syncAllRunning = false

// Per-account debounce: rapid sequential triggers (toggle, addon op, etc.) coalesce into one sync.
const _pendingSyncs = new Map<string, ReturnType<typeof setTimeout>>()
const SYNC_DEBOUNCE_MS = 800
const SYNC_BATCH_DELAY_MS = 200

/**
 * Schedule a debounced syncAccount for state-change-triggered syncs.
 * Multiple calls within SYNC_DEBOUNCE_MS for the same account collapse into one.
 * For user-initiated (manual) syncs call syncAccount() directly.
 */
export function scheduleSyncAccount(id: string, forceRefresh = false): void {
    const existing = _pendingSyncs.get(id)
    if (existing) clearTimeout(existing)
    _pendingSyncs.set(id, setTimeout(() => {
        _pendingSyncs.delete(id)
        syncAccount(id, forceRefresh).catch(() => { })
    }, SYNC_DEBOUNCE_MS))
}

export function mergeRemoteIntoHub(account: Account, remoteAddons: AddonDescriptor[], forceRefresh = false): AddonDescriptor[] {
    trace('sync.merge', 'enter', { accountId: account.id, remote: remoteAddons.length, local: account.addons.length, forceRefresh })
    const normalizedAddons = remoteAddons
        .filter(a => !syncManager.isPendingRemoval(account.id, a.transportUrl))
        .map((addon) => {
            const manifestWithFallback = (!addon.manifest?.name && addon.transportName)
                ? { ...addon.manifest, name: addon.transportName }
                : addon.manifest
            return {
                ...addon,
                manifest: sanitizeAddonManifest(manifestWithFallback, addon.transportUrl),
            }
        })

    const deletionState = mergeAddonDeletionState(account.deletedAddons, undefined, account.restoredAddons, undefined)
    const survivingRemote = filterResurrected(normalizedAddons, [], deletionState.deletedAddons)
    const survivingLocal = filterResurrected(account.addons, [], deletionState.deletedAddons)
    trace('sync.merge', 'post-tombstone', { accountId: account.id, survived: survivingRemote.length, stripped: normalizedAddons.length - survivingRemote.length })
    const survivingUrls = new Set(survivingRemote.map(a => normalizeAddonUrl(a.transportUrl)))
    const strippedByTombstone = normalizedAddons
        .filter(a => !survivingUrls.has(normalizeAddonUrl(a.transportUrl)))
        .map(a => ({ id: a.manifest?.id || '?', url: (a.transportUrl || '').slice(-48) }))
    trace('mergeRemoteIntoHub', 'tombstone-filter', {
        accountId: account.id,
        forceRefresh,
        remote: normalizedAddons.length,
        local: (account.addons || []).length,
        surviving: survivingRemote.length,
        tombstoneCount: Object.keys(account.deletedAddons || {}).length,
        strippedByTombstone,
    })
    // Hub-canonical: passive read is additive; only an explicit forceRefresh adopts platform removals.
    // instanceMatch keep-local-url: the local post-fold state is authoritative, so a stale
    // platform entry with an older config URL folds into the local entry instead of duplicating.
    const out = mergeAddons(survivingLocal, survivingRemote, { keepMissingLocal: !forceRefresh, instanceMatch: 'keep-local-url' })
    trace('sync.merge', 'result', { accountId: account.id, out: out.length, keepMissingLocal: !forceRefresh })
    return out
}

async function repairAndFlag(
    account: Account,
    addons: AddonDescriptor[],
    forceRefresh: boolean,
): Promise<AddonDescriptor[]> {
    const localManifestByUrl = new Map<string, AddonDescriptor['manifest']>()
    for (const a of account.addons) {
        if (a.manifest?.name && a.manifest.name !== 'Unknown Addon') {
            localManifestByUrl.set(normalizeAddonUrl(a.transportUrl), a.manifest)
        }
    }

    const repairedAddons = await mapConcurrent(addons, 4, async (addon) => {
            try {
                const v = (addon.manifest?.version || '').replace(/^v/, '')
                const isBroken = !addon.manifest?.name ||
                    addon.manifest.name === 'Unknown Addon' ||
                    hasFallbackAddonName(addon) ||
                    v === '0.0.0' ||
                    v === '' ||
                    !addon.manifest.resources ||
                    addon.manifest.resources.length === 0 ||
                    needsDisabledAddonIdentityRepair(addon)

                if (!forceRefresh && addon.manifest && addon.manifest.id && !isBroken) {
                    if (isCinemetaAddon(addon) && !addon.metadata?.cinemetaConfig) {
                        const detected = detectAllPatches(addon.manifest as CinemetaManifest)
                        if (detected.searchArtifactsPatched || detected.standardCatalogsPatched || detected.metaResourcePatched) {
                            const updated = {
                                ...addon,
                                metadata: {
                                    ...(addon.metadata || {}),
                                    cinemetaConfig: {
                                        removeSearchArtifacts: detected.searchArtifactsPatched,
                                        removeStandardCatalogs: detected.standardCatalogsPatched,
                                        removeMetaResource: detected.metaResourcePatched,
                                    }
                                }
                            }
                            return { ...updated, manifest: getEffectiveManifest(updated) }
                        }
                    }
                    return { ...addon, manifest: getEffectiveManifest(addon) }
                }

                let cinemetaPatches = null
                if (isCinemetaAddon(addon)) {
                    cinemetaPatches = detectAllPatches(addon.manifest as CinemetaManifest)
                }

                let manifestRaw = null
                const cached = getCachedManifest(addon.transportUrl)
                if (cached) {
                    manifestRaw = cached
                } else if (isBroken && !forceRefresh) {
                    const localManifest = localManifestByUrl.get(normalizeAddonUrl(addon.transportUrl))
                    if (localManifest && localManifest.id && localManifest.id !== 'unknown' && localManifest.version && localManifest.version !== '0.0.0') {
                        manifestRaw = localManifest
                    }
                }

                if (!manifestRaw && !forceRefresh && shouldSkipManifestFetch(addon.transportUrl)) {
                    manifestRaw = localManifestByUrl.get(normalizeAddonUrl(addon.transportUrl)) || addon.manifest
                }

                if (!manifestRaw) {
                    try {
                        const { manifest } = await apiFetchAddonManifest(
                            addon.transportUrl,
                            account.id
                        )
                        manifestRaw = manifest
                        setCachedManifest(addon.transportUrl, manifestRaw)
                    } catch (err) {
                        recordManifestFetchFailure(addon.transportUrl)
                        throw err
                    }
                }

                const metadata = { ...(addon.metadata || {}) }

                let repairedManifest = sanitizeAddonManifest(manifestRaw, addon.transportUrl)

                if (metadata.cinemetaConfig) {
                    repairedManifest = applyCinemetaConfiguration(repairedManifest as CinemetaManifest, metadata.cinemetaConfig) as AddonDescriptor['manifest']
                } else if (cinemetaPatches && (
                    cinemetaPatches.searchArtifactsPatched ||
                    cinemetaPatches.standardCatalogsPatched ||
                    cinemetaPatches.metaResourcePatched
                )) {
                    const config = {
                        removeSearchArtifacts: cinemetaPatches.searchArtifactsPatched,
                        removeStandardCatalogs: cinemetaPatches.standardCatalogsPatched,
                        removeMetaResource: cinemetaPatches.metaResourcePatched,
                    }
                    repairedManifest = applyCinemetaConfiguration(repairedManifest as CinemetaManifest, config) as AddonDescriptor['manifest']
                    metadata.cinemetaConfig = config
                }
                const finalMetadata = inferCustomMetadata(metadata, addon.manifest, repairedManifest, addon.transportUrl)

                if (finalMetadata.customName) {
                    const existingHost = getHostnameIdentifier(addon.transportUrl)
                    if (existingHost && finalMetadata.customName === existingHost) {
                        delete finalMetadata.customName
                    }
                }

                if (!finalMetadata.customName && repairedManifest?.name) {
                    const hostName = getHostnameIdentifier(addon.transportUrl)
                    if (hostName && repairedManifest.name !== hostName && repairedManifest.name !== 'Unknown Addon') {
                        finalMetadata.customName = repairedManifest.name
                    }
                }

                const finalManifest = getEffectiveManifest({ ...addon, manifest: repairedManifest, metadata: finalMetadata })
                return { ...addon, manifest: finalManifest, metadata: finalMetadata }
            } catch (e) {
                if (import.meta.env.DEV) console.warn(`[Sync] Failed to baseline ${addon.manifest?.name || 'addon'}:`, e)
                const incoming = addon.manifest
                const hasUsableName = incoming?.name && incoming.name !== 'Unknown Addon' && !hasFallbackAddonName(addon)
                const manifestToUse = hasUsableName ? incoming : sanitizeAddonManifest(incoming, addon.transportUrl)
                const finalManifest = getEffectiveManifest({ ...addon, manifest: manifestToUse })
                return { ...addon, manifest: finalManifest }
            }
        })

    const autopilotResult = await applyAutopilotAddonFlags(account.id, repairedAddons)
    return autopilotResult.addons
}

interface SyncCoreResult {
    changed: boolean
    authKeyRefreshed: boolean
}

async function syncAccountCore(id: string, forceRefresh: boolean): Promise<SyncCoreResult> {
    const store = await getStore()
    const account = getAccountById(store.getState().accounts, id)
    if (!account) throw new Error('Account not found')

    const stremioConn = account.connections?.find(c => c.platform === 'stremio')
    const stremioEnabled = !account.connections?.length || stremioConn?.enabled !== false
    const accountAuthKey = getStremioAuthKey(account)
    const useStremio = !!accountAuthKey && stremioEnabled

    let currentAccount = account
    let authKeyRefreshed = false
    let stremioAuthKey: string | undefined
    let finalAddons: AddonDescriptor[]

    trace('sync.core', 'start', { accountId: id, useStremio, hasConnections: !!currentAccount.connections?.some(c => c.enabled) })

    if (useStremio) {
        const encryptionKey = getEncryptionKey()
        let authKey = await getCachedAuthKey(accountAuthKey, encryptionKey)
        let remoteAddons: AddonDescriptor[]
        try {
            remoteAddons = await getAddons(authKey, currentAccount.id, forceRefresh)
        } catch (error) {
            if (!isAuthError(error)) throw error
            const refreshed = await refreshAuthKeyFromStoredPassword(currentAccount, encryptionKey).catch((refreshError) => {
                if (import.meta.env.DEV) console.warn('[Account] Stored credential refresh failed:', refreshError)
                return null
            })
            if (!refreshed) throw error
            currentAccount = refreshed.account
            authKey = refreshed.authKey
            authKeyRefreshed = true
            remoteAddons = await getAddons(authKey, currentAccount.id, forceRefresh)
        }
        stremioAuthKey = authKey
        trace('sync.core', 'read', { accountId: id, remote: remoteAddons.length })
        if (!useAuthStore.getState().encryptionKey) return { changed: false, authKeyRefreshed }
        const merged = mergeRemoteIntoHub(currentAccount, remoteAddons, forceRefresh)
        finalAddons = await repairAndFlag(currentAccount, merged, forceRefresh)
    } else {
        finalAddons = await repairAndFlag(currentAccount, currentAccount.addons, forceRefresh)
    }
    if (!useAuthStore.getState().encryptionKey) return { changed: false, authKeyRefreshed }

    let failedReadConnIds = new Set<string>()
    let discoveryChanged = false
    let propagateDeletions = false
    if (currentAccount.connections?.some(c => c.enabled)) {
        const { absorbConnectionAddons } = await import('@/lib/connection-discovery')
        const absorb = await absorbConnectionAddons({ ...currentAccount, addons: finalAddons }, id)
        if (!useAuthStore.getState().encryptionKey) return { changed: false, authKeyRefreshed }
        failedReadConnIds = absorb.failedReadConnIds
        propagateDeletions = absorb.propagateDeletions
        if (absorb.changed) {
            finalAddons = absorb.addons
            discoveryChanged = true
        }
    }

    trace('sync.core', 'discovery', { accountId: id, changed: discoveryChanged, final: finalAddons.length, propagateDeletions })

    const deletionState = mergeAddonDeletionState(currentAccount.deletedAddons, undefined, currentAccount.restoredAddons, undefined)
    finalAddons = filterResurrected(finalAddons, [], deletionState.deletedAddons)
    const prevAddons = currentAccount.addons
    const addonsChanged = fingerprintAddonList(prevAddons) !== fingerprintAddonList(finalAddons)
    trace('sync.core', 'flags', { accountId: id, addonsChanged, discoveryChanged, forceRefresh })
    let updatedProfiles = currentAccount.profiles
    if (addonsChanged && currentAccount.activeProfileId && updatedProfiles) {
        updatedProfiles = updatedProfiles.map(p =>
            p.id === currentAccount.activeProfileId
                ? { ...p, addons: structuredClone(finalAddons) }
                : p
        )
    }
    let updatedAccount: Account = {
        ...currentAccount,
        addons: finalAddons,
        profiles: updatedProfiles,
        ...deletionState,
        lastSync: new Date(),
        status: 'active' as const,
    }
    const syncNow = Date.now()
    if (updatedAccount.connections?.length) {
        updatedAccount = {
            ...updatedAccount,
            connections: updatedAccount.connections.map(c =>
                c.enabled ? { ...c, lastSync: syncNow, status: 'active' as const } : c
            ),
        }
    }

    const accounts = store.getState().accounts.map((acc) => (acc.id === id ? updatedAccount : acc))
    store.setState({ accounts })
    if (addonsChanged || authKeyRefreshed || discoveryChanged) {
        persistAccounts(accounts)
    }

    const { useAddonStore } = await import('@/store/addonStore')
    await useAddonStore.getState().syncAccountState(id, getStremioAuthKey(currentAccount), finalAddons).catch(e => { if (import.meta.env.DEV) console.error(e) })
    if (!useAuthStore.getState().encryptionKey) return { changed: addonsChanged || discoveryChanged || authKeyRefreshed, authKeyRefreshed }

    const pushPromises: Promise<void>[] = []
    trace('sync.core', 'writeback-gate', { accountId: id, willPushStremio: !!(useStremio && stremioAuthKey && (forceRefresh || discoveryChanged)), reason: forceRefresh ? 'forceRefresh' : discoveryChanged ? 'discoveryChanged' : 'passive-skip' })
    // A dead connection is reported on the connection, never allowed to abort the
    // cycle - an abort here skips triggerSync() below and starves the cloud push.
    let stremioWriteError: unknown = null
    if (useStremio && stremioAuthKey && (forceRefresh || discoveryChanged)) {
        pushPromises.push(
            updateAddons(stremioAuthKey, finalAddons, currentAccount.id, { previousCollection: currentAccount.addons })
                .catch(err => {
                    if (isTransientSyncError(err)) return
                    if (isAuthError(err)) throw err
                    stremioWriteError = err
                })
        )
    }

    let reconcileStates: Record<string, { status?: ConnectionStatus; lastError?: string }> | null = null
    trace('sync.core', 'push-connections-gate', { accountId: id, willPush: !!(forceRefresh || (discoveryChanged || propagateDeletions) && updatedAccount.connections?.some(c => c.enabled)) })
    if (forceRefresh || ((discoveryChanged || propagateDeletions) && updatedAccount.connections?.some(c => c.enabled))) {
        pushPromises.push(
            (async () => {
                try {
                    const { triggerReconciliation } = await import('@/api/connection')
                    const pushConnections = (updatedAccount.connections || []).filter(c => !failedReadConnIds.has(c.id))
                    const reconcileResult = await triggerReconciliation(id, updatedAccount.primaryConnectionId, pushConnections, finalAddons)
                    if (reconcileResult.connectionStates && Object.keys(reconcileResult.connectionStates).length > 0) {
                        reconcileStates = reconcileResult.connectionStates as Record<string, { status?: ConnectionStatus; lastError?: string }>
                        import('@/store/connectionStore').then(({ useConnectionStore }) => {
                            useConnectionStore.setState(s => ({
                                connectionStates: {
                                    ...s.connectionStates,
                                    [id]: { ...(s.connectionStates[id] || {}), ...reconcileResult.connectionStates },
                                },
                            }))
                        }).catch(() => { })
                    }
                } catch (e) {
                    if (import.meta.env.DEV) console.warn('[Account] Multi-connection reconciler push failed:', e)
                }
            })()
        )
    }

    await Promise.all(pushPromises)

    // Correct the optimistic per-connection stamps with the real write outcomes, so a
    // failing Nuvio/Stremio connection shows its error instead of a false 'active'.
    if (stremioWriteError || reconcileStates) {
        const statusFor = (err: unknown): ConnectionStatus => (isAuthError(err) ? 'expired' : 'error')
        const correctedConnections = (updatedAccount.connections ?? []).map(c => {
            if (!c.enabled) return c
            if (stremioWriteError && c.platform === 'stremio') {
                return {
                    ...c,
                    status: statusFor(stremioWriteError),
                    lastError: stremioWriteError instanceof Error ? stremioWriteError.message : String(stremioWriteError),
                    lastErrorAt: Date.now(),
                }
            }
            const st = reconcileStates?.[c.id]
            if (st?.status) {
                return { ...c, status: st.status, lastError: st.lastError ?? c.lastError, lastErrorAt: Date.now() }
            }
            return c
        })
        updatedAccount = { ...updatedAccount, connections: correctedConnections }
        const correctedAccounts = store.getState().accounts.map((acc) => (acc.id === id ? updatedAccount : acc))
        store.setState({ accounts: correctedAccounts })
        persistAccounts(correctedAccounts)
    }

    return { changed: addonsChanged || discoveryChanged || authKeyRefreshed, authKeyRefreshed }
}

export async function syncAccount(id: string, forceRefresh = false) {
    const store = await getStore()
    if (!useAuthStore.getState().encryptionKey) return

    while (syncMutexes.has(id)) {
        await syncMutexes.get(id)
    }
    let resolveMutex!: () => void
    syncMutexes.set(id, new Promise<void>((r) => { resolveMutex = r }))
    store.setState({ error: null })
    setAccountLoading(id)
    let coreOk = false
    try {
        await syncAccountCore(id, forceRefresh)
        coreOk = true
        triggerSync()
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to sync account'
        const isExpired = isAuthError(error)
        const accounts = store.getState().accounts.map((acc) =>
            acc.id === id ? { ...acc, status: isExpired ? 'expired' as const : 'error' as const, lastError: message, lastErrorAt: Date.now() } : acc
        )
        store.setState({ accounts, error: message })
        persistAccounts(accounts)
        throw error
    } finally {
        clearAccountLoading(id)
        resolveMutex()
        syncMutexes.delete(id)
    }
    if (coreOk) {
        deferCanonicalFold()
    }
}

function deferCanonicalFold() {
    setTimeout(() => {
        import('./accountCanonical')
            .then(({ reconcileInboundCanonical }) => reconcileInboundCanonical())
            .then(changed => { if (changed) triggerSync() })
            .catch(() => {})
    }, 0)
}

export async function syncAllAccounts(silent = false) {
    const store = await getStore()
    if (_syncAllRunning) {
        if (import.meta.env.DEV) console.log(`[Account] syncAllAccounts skipped - already running`)
        return
    }
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    if (!useAuthStore.getState().encryptionKey) return

    _syncAllRunning = true
    try {
        await hydrateManifestCache()

        store.setState({ error: null })
        const accounts = store.getState().accounts
        setAccountsLoading(accounts.map(a => a.id))
        let hasAnyChange = false

        const BATCH_SIZE = 5
        const syncOne = async (account: typeof accounts[0]) => {
            if (syncMutexes.has(account.id)) return
            const hasAnyEnabledConnection = account.connections?.some(c => c.enabled)
            const hasRootAuthKey = !!getStremioAuthKey(account)
            if (!hasAnyEnabledConnection && !hasRootAuthKey) return

            const nonStremioConnections = account.connections?.filter(c => isSyncEligibleConnection(c) && c.enabled) || []
            const allNonStremioExpired = nonStremioConnections.length > 0 && nonStremioConnections.every(c => c.status === 'expired')
            if (allNonStremioExpired) {
                if (import.meta.env.DEV) console.log(`[Account] syncAllAccounts skipping ${account.id}: all non-Stremio connections expired`)
                return
            }

            let resolveMutex!: () => void
            syncMutexes.set(account.id, new Promise<void>((r) => { resolveMutex = r }))
            try {
                const result = await syncAccountCore(account.id, false)
                if (result.changed) hasAnyChange = true
            } catch (error: unknown) {
                if (isTransientSyncError(error)) return
                const isExpired = isAuthError(error)
                const message = error instanceof Error ? error.message : 'Failed to sync account'
                store.setState(state => ({
                    accounts: state.accounts.map(acc =>
                        acc.id === account.id ? { ...acc, status: isExpired ? 'expired' as const : 'error' as const, lastError: message, lastErrorAt: Date.now() } : acc
                    )
                }))
                hasAnyChange = true
            } finally {
                resolveMutex()
                syncMutexes.delete(account.id)
                clearAccountLoading(account.id)
            }
        }

        for (let i = 0; i < accounts.length; i += BATCH_SIZE) {
            await Promise.all(accounts.slice(i, i + BATCH_SIZE).map(syncOne))
            if (i + BATCH_SIZE < accounts.length) {
                await new Promise(r => setTimeout(r, SYNC_BATCH_DELAY_MS))
            }
        }

        if (hasAnyChange) {
            persistAccounts(store.getState().accounts)
        }

        if (!silent && hasAnyChange) {
            triggerSync()
        }

        deferCanonicalFold()
    } finally {
        clearAllAccountLoading()
        _syncAllRunning = false
    }
}

export async function repairAccount(id: string) {
    const store = await getStore()
    return store.getState().syncAccount(id, true)
}
