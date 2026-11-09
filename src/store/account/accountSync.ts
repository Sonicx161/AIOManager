import { triggerSync } from '@/lib/sync-trigger'
import {
    getAddons,
    fetchAddonManifest as apiFetchAddonManifest,
} from '@/api/addons'
import { isRecoveredAddonCollection } from '@/api/stremio-client'
import { mergeAddons, normalizeAddonUrl, hasFallbackAddonName, maskNameLevel } from '@/lib/utils'
import { createRemoteIdentityMatcher } from '@/lib/addon-instance-identity'
import { filterResurrected, mergeAddonDeletionState } from '@/lib/addon-tombstones'
import { trace } from '@/lib/trace'
import { toast } from '@/hooks/use-toast'
import { fingerprintAddonList } from '@/lib/addon-fingerprint'
import { mapConcurrent } from '@/lib/concurrency'
import { isSyncEligibleConnection, type ConnectionStatus } from '@/types/connection'
import { useAuthStore } from '@/store/authStore'
import { AddonDescriptor } from '@/types/addon'
import type { Account } from '@/types/account'
import { CinemetaManifest } from '@/types/cinemeta'
import { isCinemetaAddon, detectAllPatches, applyCinemetaConfiguration } from '@/lib/cinemeta-utils'
import { syncManager } from '@/lib/sync/syncManager'
import { setPendingPush, setPendingResurrectedCount, type PendingPushReason } from '@/lib/sync/pending-push'
import { classifyConnectionPush, normalizeFailedConnectionState } from '@/lib/sync/push-outcome'
import { platformLabel, skippedReason } from '@/lib/sync/pending-summary'
import type { ConnectionRead } from '@/lib/connection-discovery'
import { getEffectiveManifest } from '@/lib/addon-utils'
import { inferCustomMetadata } from '@/lib/addon-custom-metadata'
import { getHostnameIdentifier } from '@/lib/addon-identifier'
import { getCachedManifest, setCachedManifest, recordManifestFetchFailure, shouldSkipManifestFetch, hydrateManifestCache } from '@/lib/manifest-cache'
import { isPlaceholderManifest, rememberKnownManifests, restoreKnownManifests, healPlaceholderAddons, markManifestUnreachable, clearManifestUnreachable } from '@/lib/manifest-placeholder'
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
    acquireSyncMutex,
    tryAcquireSyncMutex,
    getStremioAuthKey,
    getStremioConnection,
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

export type SyncIntent = 'passive' | 'user'
const _pendingIntents = new Map<string, SyncIntent>()

/**
 * Schedule a debounced syncAccount for state-change-triggered syncs.
 * Multiple calls within SYNC_DEBOUNCE_MS for the same account collapse into one.
 * For user-initiated (manual) syncs call syncAccount() directly. A coalesced user intent is never downgraded.
 */
export function scheduleSyncAccount(id: string, forceRefresh = false, intent: SyncIntent = 'passive'): void {
    const existing = _pendingSyncs.get(id)
    if (existing) clearTimeout(existing)
    const merged: SyncIntent = intent === 'user' || _pendingIntents.get(id) === 'user' ? 'user' : 'passive'
    _pendingIntents.set(id, merged)
    _pendingSyncs.set(id, setTimeout(() => {
        _pendingSyncs.delete(id)
        _pendingIntents.delete(id)
        syncAccount(id, forceRefresh, merged).catch(() => { })
    }, SYNC_DEBOUNCE_MS))
}

export function mergeRemoteIntoHub(account: Account, remoteAddons: AddonDescriptor[], options: { keepLocalFlags?: boolean } = {}): AddonDescriptor[] {
    trace('sync.merge', 'enter', { accountId: account.id, remote: remoteAddons.length, local: account.addons.length })
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
        .map(a => ({ id: a.manifest?.id || '?' }))
    trace('mergeRemoteIntoHub', 'tombstone-filter', {
        accountId: account.id,
        remote: normalizedAddons.length,
        local: (account.addons || []).length,
        surviving: survivingRemote.length,
        tombstoneCount: Object.keys(account.deletedAddons || {}).length,
        strippedByTombstone,
    })
    // Hub-canonical additive merge: a platform read never removes a hub row. Removals
    // happen only in AIOManager and push out with the next user sync; one made in the
    // platform's own app is undone by that same push.
    // keepLocalFlags defaults ON for every read fold (DC-R2-01): the hub's enable
    // state wins for existing rows; platform-only discoveries still arrive enabled.
    const out = mergeAddons(survivingLocal, survivingRemote, {
        keepMissingLocal: true,
        instanceMatch: 'keep-local-url',
        keepLocalFlags: options.keepLocalFlags !== false,
    })
    trace('sync.merge', 'result', { accountId: account.id, out: out.length })
    return out
}

async function repairAndFlag(
    account: Account,
    addons: AddonDescriptor[],
    forceRefresh: boolean,
): Promise<AddonDescriptor[]> {
    rememberKnownManifests(account.addons)
    const localManifestByUrl = new Map<string, AddonDescriptor['manifest']>()
    for (const a of account.addons) {
        if (a.manifest?.name && a.manifest.name !== 'Unknown Addon' && !isPlaceholderManifest(a.manifest)) {
            localManifestByUrl.set(normalizeAddonUrl(a.transportUrl), a.manifest)
        }
    }

    const healed = await healPlaceholderAddons(addons, {
        shouldSkip: (url) => !forceRefresh && shouldSkipManifestFetch(url),
        fetchManifest: async (url) => {
            const cached = getCachedManifest(url)
            if (cached) return cached
            const { manifest } = await apiFetchAddonManifest(url, account.id)
            setCachedManifest(url, manifest)
            return manifest
        },
        apply: (addon, fetched) => {
            const sanitized = sanitizeAddonManifest(fetched, addon.transportUrl)
            return { ...addon, manifest: getEffectiveManifest({ ...addon, manifest: sanitized }) }
        },
        onFailure: (url) => recordManifestFetchFailure(url),
    })
    addons = healed.addons

    const repairedAddons = await mapConcurrent(addons, 4, async (addon) => {
            try {
                const v = (addon.manifest?.version || '').replace(/^v/, '')
                const isBroken = !addon.manifest?.name ||
                    addon.manifest.name === 'Unknown Addon' ||
                    hasFallbackAddonName(addon) ||
                    v === '0.0.0' ||
                    v === '' ||
                    isPlaceholderManifest(addon.manifest) ||
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
                if (isPlaceholderManifest(addon.manifest)) markManifestUnreachable(addon.transportUrl)
                const incoming = addon.manifest
                const hasUsableName = incoming?.name && incoming.name !== 'Unknown Addon' && !hasFallbackAddonName(addon)
                const manifestToUse = hasUsableName ? incoming : sanitizeAddonManifest(incoming, addon.transportUrl)
                const finalManifest = getEffectiveManifest({ ...addon, manifest: manifestToUse })
                return { ...addon, manifest: finalManifest }
            }
        })

    const autopilotResult = await applyAutopilotAddonFlags(account.id, repairedAddons)
    const settled = restoreKnownManifests(autopilotResult.addons, account.addons)
    for (const a of settled) if (!isPlaceholderManifest(a.manifest)) clearManifestUnreachable(a.transportUrl)
    rememberKnownManifests(settled)
    return settled
}

interface SyncCoreResult {
    changed: boolean
    authKeyRefreshed: boolean
}

export const SAVED_LOGIN_LOCKED = "This saved login can't be unlocked here. Re-enter it to sync."

// Chrome reports a wrong-key AES-GCM decrypt as an OperationError with an EMPTY
// message; map it to needs-login so the card never shows blank or generic copy.
export function lockedSavedLoginError(error: unknown): Error {
    const friendly = new Error(SAVED_LOGIN_LOCKED) as Error & { isAuthError?: boolean; cause?: unknown }
    friendly.isAuthError = true
    friendly.cause = error
    return friendly
}

// Only the failures a stored sealed credential can genuinely produce at the unlock
// boundary: an AES-GCM OperationError (wrong or damaged ciphertext) or a
// malformed-base64 decode error. Anything else is a runtime fault.
export function isSavedCredentialFailure(error: unknown): boolean {
    const name = (error as { name?: unknown } | null)?.name
    return name === 'OperationError' || name === 'InvalidCharacterError'
}

// Only an explicit user intent may write to a platform; a passive sync reads, merges locally and marks what is pending.
async function syncAccountCore(id: string, forceRefresh: boolean, intent: SyncIntent = 'passive'): Promise<SyncCoreResult> {
    const allowWrite = intent === 'user'
    const pendingReasons = new Set<PendingPushReason>()
    let resurrectedCount = 0
    const store = await getStore()
    const account = getAccountById(store.getState().accounts, id)
    if (!account) throw new Error('Account not found')

    // The canonical Stremio login drives the read/merge pipeline; secondary Stremio
    // logins bound to the same account are write targets only (fan-out below).
    const stremioConn = getStremioConnection(account)
    const stremioEnabled = !account.connections?.length || stremioConn?.enabled !== false
    const accountAuthKey = getStremioAuthKey(account)
    const useStremio = !!accountAuthKey && stremioEnabled

    let currentAccount = account
    let authKeyRefreshed = false
    let stremioAuthKey: string | undefined
    let stremioRead: AddonDescriptor[] = []
    let recoveredRead = false
    let finalAddons: AddonDescriptor[]

    trace('sync.core', 'start', { accountId: id, useStremio, hasConnections: !!currentAccount.connections?.some(c => c.enabled) })

    if (useStremio) {
        const encryptionKey = getEncryptionKey()
        let authKey: string
        try {
            authKey = await getCachedAuthKey(accountAuthKey, encryptionKey)
        } catch (error) {
            // Expected decode/decrypt failures mean this device cannot open the stored
            // login; any other runtime error must surface unchanged.
            if (isSavedCredentialFailure(error)) throw lockedSavedLoginError(error)
            throw error
        }
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
        stremioRead = remoteAddons
        // A recovered lastGood collection is a stale snapshot, not a live read.
        recoveredRead = isRecoveredAddonCollection(remoteAddons)
        trace('sync.core', 'read', { accountId: id, remote: remoteAddons.length, recovered: recoveredRead })
        if (!useAuthStore.getState().encryptionKey) return { changed: false, authKeyRefreshed }
        const readDeletions = mergeAddonDeletionState(currentAccount.deletedAddons, undefined, currentAccount.restoredAddons, undefined)
        if (filterResurrected(remoteAddons, [], readDeletions.deletedAddons).length < remoteAddons.length) {
            pendingReasons.add('resurrected')
            const live = new Set(filterResurrected(remoteAddons, [], readDeletions.deletedAddons).map(a => normalizeAddonUrl(a.transportUrl)))
            resurrectedCount = remoteAddons.filter(a => !live.has(normalizeAddonUrl(a.transportUrl))).length
            trace('sync.pending', 'resurrected', { accountId: id, names: remoteAddons.filter(a => !live.has(normalizeAddonUrl(a.transportUrl))).map(a => `${a.manifest?.name || a.manifest?.id || '?'} [tombstoned-on-remote]`) })
        }
        // The merge is additive: a platform read never removes a hub row, passive or
        // Refresh alike. A removal made in the platform's own app is undone by the next
        // user Sync; a recovered lastGood collection is only stale, never destructive.
        const merged = mergeRemoteIntoHub(currentAccount, remoteAddons)
        finalAddons = await repairAndFlag(currentAccount, merged, forceRefresh)
    } else {
        finalAddons = await repairAndFlag(currentAccount, currentAccount.addons, forceRefresh)
    }
    if (!useAuthStore.getState().encryptionKey) return { changed: false, authKeyRefreshed }

    let failedReadConnIds = new Set<string>()
    let failedReads = new Map<string, { message: string; isAuthError: boolean }>()
    let nativeReads: ConnectionRead[] = []
    let discoveryChanged = false
    let propagateDeletions = false
    let deletionConnIds = new Set<string>()
    const nativeEnabled = (currentAccount.connections || []).filter(c => c.enabled && (c.platform === 'nuvio' || c.platform === 'realstream'))
    if (currentAccount.connections?.some(c => c.enabled)) {
        const { absorbConnectionAddons } = await import('@/lib/connection-discovery')
        const absorb = await absorbConnectionAddons({ ...currentAccount, addons: finalAddons }, id)
        if (!useAuthStore.getState().encryptionKey) return { changed: false, authKeyRefreshed }
        failedReadConnIds = absorb.failedReadConnIds
        failedReads = absorb.failedReads ?? failedReads
        nativeReads = absorb.reads ?? []
        propagateDeletions = absorb.propagateDeletions
        deletionConnIds = absorb.deletionConnIds?.size ? absorb.deletionConnIds : new Set(propagateDeletions ? nativeEnabled.map(c => c.id) : [])
        if (absorb.changed) {
            finalAddons = absorb.addons
            discoveryChanged = true
        }
    }

    trace('sync.core', 'discovery', { accountId: id, changed: discoveryChanged, final: finalAddons.length, propagateDeletions })

    const deletionState = mergeAddonDeletionState(currentAccount.deletedAddons, undefined, currentAccount.restoredAddons, undefined)
    finalAddons = filterResurrected(finalAddons, [], deletionState.deletedAddons)
    const nameOf = (a: AddonDescriptor) => a.manifest?.name || a.manifest?.id || '?'
    if (useStremio) {
        const matchRemote = createRemoteIdentityMatcher(finalAddons, stremioRead)
        const manifestNames: string[] = []
        for (const addon of finalAddons) {
            const remote = matchRemote(addon)
            if (!remote) continue
            const remoteVersion = remote.manifest?.version
            const localVersion = addon.manifest?.version
            if (remoteVersion && localVersion && remoteVersion !== localVersion) {
                pendingReasons.add('manifest')
                manifestNames.push(`${nameOf(addon)} [version-differs]`)
            }
        }
        if (manifestNames.length > 0) trace('sync.pending', 'manifest', { accountId: id, names: manifestNames })
    }

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
    // Every source this account reads failed: stamping it healthy would hide a dead connection.
    const allReadsFailed = !useStremio && nativeEnabled.length > 0 && nativeEnabled.every(c => failedReadConnIds.has(c.id))
    let updatedAccount: Account = {
        ...currentAccount,
        // A fingerprint-equal read keeps the stored addon identities so memoized
        // rows and cards see no change (content is proven identical by the hash).
        addons: addonsChanged ? finalAddons : prevAddons,
        profiles: updatedProfiles,
        ...deletionState,
        ...(allReadsFailed
            ? {
                status: 'error' as const,
                lastError: failedReads.get(nativeEnabled[0].id)?.message || 'Connection read failed',
                lastErrorAt: Date.now(),
            }
            : { lastSync: new Date(), status: 'active' as const }),
    }
    const syncNow = Date.now()
    // Only a connection this cycle actually read is stamped healthy here; writes confirm theirs after the push.
    // A recovered read is not a confirmed live read, so it never stamps the connection as synced.
    const readConfirmedIds = new Set<string>([...nativeReads.map(r => r.connectionId), ...(useStremio && stremioConn && !recoveredRead ? [stremioConn.id] : [])])
    if (updatedAccount.connections?.length) {
        updatedAccount = {
            ...updatedAccount,
            connections: updatedAccount.connections.map(c => {
                if (!c.enabled) return c
                if (!failedReadConnIds.has(c.id)) return readConfirmedIds.has(c.id) ? { ...c, lastSync: syncNow, status: 'active' as const } : c
                const failure = failedReads.get(c.id)
                return { ...c, status: failure?.isAuthError ? 'expired' as const : 'error' as const, lastError: failure?.message || 'Read failed', lastErrorAt: syncNow }
            }),
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
    // A push sends exactly what the hub shows (rule 1): the fan-out projects each login's
    // destination policy itself, and the policy-authorized removals ride with it (R2).
    const stremioPrevious = currentAccount.addons
    const willPushStremio = allowWrite && !!(useStremio && stremioAuthKey && (forceRefresh || discoveryChanged))
    trace('sync.core', 'writeback-gate', { accountId: id, intent, willPushStremio, reason: !allowWrite ? 'passive-read-only' : forceRefresh ? 'forceRefresh' : discoveryChanged ? 'discoveryChanged' : 'passive-skip' })
    // A dead connection is reported on the connection, never allowed to abort the
    // cycle - an abort here skips triggerSync() below and starves the cloud push.
    // Stremio writes fan out to EVERY enabled login bound to the account (canonical
    // first); each login uses its own sealed key so a secondary is never written
    // through the canonical account's session.
    const stremioWriteErrors = new Map<string, unknown>()
    let stremioPushed = false
    const stremioWrittenIds = new Set<string>()
    if (willPushStremio) {
        pushPromises.push(
            (async () => {
                const { pushAddonsToStremioConnections } = await import('@/lib/account-compat')
                const result = await pushAddonsToStremioConnections(currentAccount, finalAddons, { previousCollection: stremioPrevious })
                stremioPushed = result.failed.length === 0
                for (const w of result.written) stremioWrittenIds.add(w)
                for (const failure of result.failed) {
                    const err = failure.error
                    if (failure.isPrimary) {
                        // Canonical login keeps the single-connection contract.
                        if (isTransientSyncError(err)) continue
                        if (isAuthError(err)) throw err
                    }
                    stremioWriteErrors.set(failure.connectionId, err)
                }
            })()
        )
    }

    let reconcileStates: Record<string, { status?: ConnectionStatus; lastError?: string }> | null = null
    const confirmedConnIds = new Set<string>()
    const blockedPlatforms = new Set<string>()
    const skippedPlatforms = new Map<string, string | undefined>()
    const rejectedPlatforms = new Set<string>()
    // Only enabled, write-eligible connections are push targets. The canonical and secondary Stremio
    // logins are written by the fan-out above, so they never reach the reconciler.
    const pushTargets = (updatedAccount.connections || []).filter(c => c.enabled && isSyncEligibleConnection(c))
    const willPushConnections = allowWrite && pushTargets.length > 0 && !!(forceRefresh || discoveryChanged || propagateDeletions)
    trace('sync.core', 'push-connections-gate', { accountId: id, intent, willPush: willPushConnections })
    if (willPushConnections) {
        pushPromises.push(
            (async () => {
                const { triggerReconciliation } = await import('@/api/connection')
                const allowEmptyDeletionRetry = propagateDeletions && finalAddons.length === 0
                const pushConnections = pushTargets.filter(c =>
                    !failedReadConnIds.has(c.id) && (!allowEmptyDeletionRetry || (
                        c.connectionType !== 'hydra-outbound' && (c.platform === 'nuvio' || c.platform === 'realstream')
                    ))
                )
                if (allowEmptyDeletionRetry && pushConnections.length === 0) return
                try {
                    // A tombstone-only provider read is an explicit deletion signal. If
                    // that was the last addon, the reconciler must be allowed to send the
                    // empty projection back to the provider; otherwise its anti-wipe guard
                    // skips the write and the stale addon remains on the provider. This
                    // retry is limited to native providers covered by discovery above.
                    // Every connection receives the same hub rows: the server twin projects
                    // each connection's destination policy itself.
                    const reconcileResult = await triggerReconciliation(
                        id,
                        updatedAccount.primaryConnectionId,
                        pushConnections,
                        finalAddons,
                        { allowCollectionShrink: allowEmptyDeletionRetry },
                    )
                    const states = reconcileResult?.connectionStates ?? {}
                    const changedPlatforms = new Set((reconcileResult?.changes ?? []).map(ch => ch.platform))
                    const failures: string[] = []
                    for (const c of pushConnections) {
                        const outcome = classifyConnectionPush(id, c.id, states, Date.now(), reconcileResult?.connectionOutcomes, changedPlatforms, c.platform)
                        if (outcome.kind === 'confirmed') confirmedConnIds.add(c.id)
                        else if (outcome.kind === 'failed') blockedPlatforms.add(c.platform)
                        else if (outcome.kind === 'skipped') skippedPlatforms.set(c.platform, outcome.reason)
                        // The same shared normalization as serverReconcile: an explicit
                        // failure overrides a below-backoff "active" state and keeps the
                        // prior confirmed lastSync (SOL-R1-BETA-06).
                        const failed = normalizeFailedConnectionState(reconcileResult?.connectionOutcomes?.[c.id], states[c.id])
                        if (failed) {
                            states[c.id] = failed.state as typeof states[string]
                            failures.push(failed.message)
                        }
                    }
                    if (failures.length > 0) {
                        const shown = failures.slice(0, 2).join(' | ')
                        toast({
                            title: 'Connection sync failed',
                            description: failures.length > 2 ? `${shown} (+${failures.length - 2} more)` : shown,
                            variant: 'destructive',
                            href: `/account/${encodeURIComponent(id)}`,
                        })
                    }
                    if (Object.keys(states).length > 0) {
                        reconcileStates = { ...(reconcileStates ?? {}), ...(states as Record<string, { status?: ConnectionStatus; lastError?: string }>) }
                        import('@/store/connectionStore').then(({ useConnectionStore }) => {
                            useConnectionStore.setState(s => ({
                                connectionStates: {
                                    ...s.connectionStates,
                                    [id]: { ...(s.connectionStates[id] || {}), ...states },
                                },
                            }))
                        }).catch(() => { })
                    }
                } catch (e) {
                    if (import.meta.env.DEV) console.warn('[Account] Multi-connection reconciler push failed:', e)
                    for (const c of pushConnections) { blockedPlatforms.add(c.platform); rejectedPlatforms.add(c.platform) }
                }
            })()
        )
    }

    await Promise.all(pushPromises)

    if (stremioPushed) for (const r of ['resurrected', 'manifest'] as const) pendingReasons.delete(r)
    for (const c of updatedAccount.connections ?? []) {
        if (deletionConnIds.has(c.id) && !confirmedConnIds.has(c.id)) pendingReasons.add(`removed-${c.platform}`)
    }
    for (const platform of blockedPlatforms) pendingReasons.add(`push-blocked-${platform}`)
    if (willPushStremio && !stremioPushed) pendingReasons.add('push-blocked-stremio')
    for (const [platform, reason] of skippedPlatforms) if (!blockedPlatforms.has(platform)) pendingReasons.add(skippedReason(platform, reason))
    if (willPushConnections) {
        for (const c of pushTargets) if (failedReadConnIds.has(c.id)) pendingReasons.add(`read-failed-${c.platform}`)
    }
    const maskedAccountName = async () => {
        const { useUIStore } = await import('@/store/uiStore')
        const ui = useUIStore.getState()
        return maskNameLevel(currentAccount.name || 'this account', ui.isPrivacyModeEnabled ? ui.privacyLevelNames : 0)
    }
    if (rejectedPlatforms.size > 0) {
        const accountName = await maskedAccountName()
        const names = [...rejectedPlatforms].map(platformLabel).join(' and ')
        toast({
            variant: 'destructive',
            title: `Nothing was pushed to ${names}`,
            description: `${names} could not be updated for ${accountName}, so nothing was pushed there. Try Sync now again.`,
            href: `/account/${encodeURIComponent(id)}`,
        })
    }
    setPendingPush(id, pendingReasons)
    setPendingResurrectedCount(id, resurrectedCount)

    const writeConfirmedIds = new Set<string>([...confirmedConnIds, ...stremioWrittenIds])
    if (writeConfirmedIds.size > 0 && updatedAccount.connections?.length) {
        const confirmedAt = Date.now()
        updatedAccount = {
            ...updatedAccount,
            connections: updatedAccount.connections.map(c =>
                c.enabled && writeConfirmedIds.has(c.id) && !failedReadConnIds.has(c.id) && !stremioWriteErrors.has(c.id)
                    ? { ...c, lastSync: confirmedAt, status: 'active' as const }
                    : c),
        }
        const confirmedAccounts = store.getState().accounts.map((acc) => (acc.id === id ? updatedAccount : acc))
        store.setState({ accounts: confirmedAccounts })
        persistAccounts(confirmedAccounts)
    }

    // Correct the per-connection stamps with the real write outcomes, so a
    // failing Nuvio/Stremio connection shows its error instead of a false 'active'.
    // Stremio errors are per login: only the connection whose own write failed is
    // marked, never every Stremio login on the account.
    if (stremioWriteErrors.size > 0 || reconcileStates) {
        const statusFor = (err: unknown): ConnectionStatus => (isAuthError(err) ? 'expired' : 'error')
        const correctedConnections = (updatedAccount.connections ?? []).map(c => {
            if (!c.enabled || failedReadConnIds.has(c.id)) return c
            const stremioError = c.platform === 'stremio' ? stremioWriteErrors.get(c.id) : undefined
            if (stremioError) {
                return {
                    ...c,
                    status: statusFor(stremioError),
                    lastError: stremioError instanceof Error ? stremioError.message : String(stremioError),
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

export async function syncAccount(id: string, forceRefresh = false, intent?: SyncIntent) {
    // A bare force refresh is an explicit button press; everything else is passive unless the caller says 'user'.
    const effectiveIntent: SyncIntent = intent ?? (forceRefresh ? 'user' : 'passive')
    const store = await getStore()
    if (!useAuthStore.getState().encryptionKey) return

    // Server addon-action lift runs before the sync mutex: installs take that mutex themselves.
    const { reconcileServerAddonActions } = await import('./addonActions')
    await reconcileServerAddonActions(id).catch(() => {})

    const releaseMutex = await acquireSyncMutex(id)
    store.setState({ error: null })
    setAccountLoading(id)
    let coreOk = false
    try {
        await syncAccountCore(id, forceRefresh, effectiveIntent)
        coreOk = true
        triggerSync()
    } catch (error) {
        const message = error instanceof Error && error.message ? error.message : 'Failed to sync account'
        const isExpired = isAuthError(error)
        const accounts = store.getState().accounts.map((acc) =>
            acc.id === id ? { ...acc, status: isExpired ? 'expired' as const : 'error' as const, lastError: message, lastErrorAt: Date.now() } : acc
        )
        store.setState({ accounts, error: message })
        persistAccounts(accounts)
        throw error
    } finally {
        clearAccountLoading(id)
        releaseMutex()
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

// Resolves true when a sync pass ran, false when it was skipped.
export async function syncAllAccounts(silent = false): Promise<boolean> {
    const store = await getStore()
    if (_syncAllRunning) {
        if (import.meta.env.DEV) console.log(`[Account] syncAllAccounts skipped - already running`)
        return false
    }
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return false
    if (!useAuthStore.getState().encryptionKey) return false

    _syncAllRunning = true
    try {
        await hydrateManifestCache()

        store.setState({ error: null })
        const accounts = store.getState().accounts
        setAccountsLoading(accounts.map(a => a.id))
        let hasAnyChange = false

        const BATCH_SIZE = 5
        const syncOne = async (account: typeof accounts[0]) => {
            // Busy accounts are skipped without waiting, and the sweep runs before the
            // eligibility skips so connectionless (local-only) accounts lift too. The
            // sweep releases its probe before running, so the mutex comes back with its
            // return value: null means the account went busy and is skipped here too.
            const { preSyncSweep, reconcileServerAddonActions } = await import('./addonActions')
            const releaseMutex = await preSyncSweep({
                tryAcquire: () => tryAcquireSyncMutex(account.id),
                sweep: () => reconcileServerAddonActions(account.id),
            })
            if (!releaseMutex) return

            try {
                const hasAnyEnabledConnection = account.connections?.some(c => c.enabled)
                const hasRootAuthKey = !!getStremioAuthKey(account)
                if (!hasAnyEnabledConnection && !hasRootAuthKey) return

                const nonStremioConnections = account.connections?.filter(c => isSyncEligibleConnection(c) && c.enabled) || []
                const allNonStremioExpired = nonStremioConnections.length > 0 && nonStremioConnections.every(c => c.status === 'expired')
                if (allNonStremioExpired) {
                    if (import.meta.env.DEV) console.log(`[Account] syncAllAccounts skipping ${account.id}: all non-Stremio connections expired`)
                    return
                }

                const result = await syncAccountCore(account.id, false, 'passive')
                if (result.changed) hasAnyChange = true
            } catch (error: unknown) {
                if (isTransientSyncError(error)) return
                const isExpired = isAuthError(error)
                const message = error instanceof Error && error.message ? error.message : 'Failed to sync account'
                store.setState(state => ({
                    accounts: state.accounts.map(acc =>
                        acc.id === account.id ? { ...acc, status: isExpired ? 'expired' as const : 'error' as const, lastError: message, lastErrorAt: Date.now() } : acc
                    )
                }))
                hasAnyChange = true
            } finally {
                releaseMutex()
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
    return true
}

export async function repairAccount(id: string) {
    const store = await getStore()
    return store.getState().syncAccount(id, true, 'user')
}
