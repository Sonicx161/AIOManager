import { triggerSync } from '@/lib/sync-trigger'
import { create } from 'zustand'
import localforage from 'localforage'
import { ActivityItem, LibraryItem } from '@/types/activity'
import { stremioClient } from '@/api/stremio-client'
import { encrypt, decrypt as decryptData } from '@/lib/crypto'
import { getCachedAuthKey, getStremioAuthKey, getStremioConnection, getStremioConnections, isAuthError } from '@/store/accountStore'
import { useAuthStore } from '@/store/authStore'
import { Account } from '@/types/account'
import { toast } from '@/hooks/use-toast'
import { mapConcurrent } from '@/lib/concurrency'
import { trace } from '@/lib/trace'
import { metaIsUnchanged } from '@/lib/stremio-meta-diff'
import { reuseActivityItems, reuseDeletedItemIds } from '@/lib/activity-structural-sharing'
import { historyNoticeCopy } from '@/lib/sync-error-copy'
import { platformName } from '@/components/addons/PlatformSourceChip'

// v4: v3-era blobs persist transformed ActivityItems from before imported-saved-state
// tagging; the fresh-TTL restore and identical-meta skip would keep serving that old
// projection forever. Bumping the version discards the derived cache exactly once —
// deleted-item markers, watch-event history and credentials live in separate stores
// and survive. The legacy keys are cleared too so a pre-rename blob can never
// resurrect an old projection through the migration path (removed below).
const CACHE_KEY = 'aio_library_cache_v4'
const LEGACY_CACHE_KEYS = ['aio_library_cache_v3', 'aio_library_cache']

let _lastPersistedLibraryContent: string | null = null
function invalidatePersistedLibraryFingerprint() {
    _lastPersistedLibraryContent = null
}
const seriesRowsForBackfill = new Map<string, LibraryItem[]>()
export const DELETED_ITEMS_KEY = 'aio_library_deleted'
const CACHE_TTL = 5 * 60 * 1000
const LIBRARY_FETCH_CONCURRENCY = 5
const CACHE_VERSION = 4
// A guest-read (revoked RealStream token) returns zero rows; only a drop this large from the last good read is suspicious.
const REALSTREAM_SUSPICIOUS_EMPTY_MIN = 10
const lastRealStreamProgressCounts = new Map<string, number>()

// A revoked RealStream token reads as a guest: a 401 here, or an empty read where the last good
// one had many. At most one forced revalidation per call (the server rejects a repeat force inside
// its cooldown); never loops, and any failed suspicious-empty retry keeps the earlier result.
async function readRealStreamProgressWithHeal<T>(heal: {
    connId: string
    accessToken: string
    forcedToken: () => Promise<string>
    read: (accessToken: string) => Promise<T[]>
}): Promise<T[]> {
    let progress: T[]
    let forcedRetryUsed = false
    try {
        progress = await heal.read(heal.accessToken)
    } catch (error) {
        if (!isAuthError(error)) throw error
        forcedRetryUsed = true
        progress = await heal.read(await heal.forcedToken())
    }
    const lastGood = lastRealStreamProgressCounts.get(heal.connId) ?? 0
    if (!forcedRetryUsed && progress.length === 0 && lastGood >= REALSTREAM_SUSPICIOUS_EMPTY_MIN) {
        trace('libraryCache', 'realstream.suspicious-empty', { connectionId: heal.connId, lastGood })
        try {
            const retried = await heal.read(await heal.forcedToken())
            if (retried.length > 0) progress = retried
        } catch {
            // ForcedToken rejected inside its cooldown lands here too: keep the earlier result.
        }
    }
    if (progress.length > 0) lastRealStreamProgressCounts.set(heal.connId, progress.length)
    return progress
}

let loadPromise: Promise<void> | null = null
let loadPromiseGeneration = 0
let cacheGeneration = 0
let removeItemsLock: Promise<void> = Promise.resolve()
const toastedNuvioFailures = new Set<string>()
const toastedRealStreamFailures = new Set<string>()

// Watch-history fetch failures get cause-specific copy: a lost or expired
// sign-in points at the fix (amber toast plus an inbox action that opens that
// connection's own sign-in), an outage says nothing needs fixing, and anything
// unrecognised keeps the generic notice from before.
function notifyHistoryFetchFailed(err: unknown, target: { accountId: string; profileName: string; platformId: string; connectionId: string }) {
    const rawMessage = err instanceof Error ? err.message : String(err)
    const platform = platformName(target.platformId)
    // Driver errors carry a structured status/isAuthError (src/lib/drivers/*); trust it over string matching.
    const driverErr = err as { status?: number; isAuthError?: boolean } | null
    const notice = historyNoticeCopy(rawMessage, platform, target.profileName, {
        status: driverErr?.status,
        isAuthError: driverErr?.isAuthError,
    })
    if (!notice) {
        toast({
            title: `${platform} history unavailable`,
            description: `Could not fetch watch history for ${target.profileName}. Using last cached data.`,
            variant: 'destructive',
            href: `/account/${encodeURIComponent(target.accountId)}`,
        })
        return
    }
    toast({
        title: notice.title,
        description: notice.body,
        variant: notice.variant,
        href: `/account/${encodeURIComponent(target.accountId)}`,
        accountId: target.accountId,
        ...(notice.action === 'signin'
            ? {
                actionHint: 'signin' as const,
                actionTarget: { connectionId: target.connectionId, platform: target.platformId },
                action: {
                    label: notice.actionLabel,
                    onClick: () => {
                        void (async () => {
                            const [{ useAccountStore }, { useUIStore }] = await Promise.all([
                                import('@/store/accountStore'),
                                import('@/store/uiStore'),
                            ])
                            const live = useAccountStore.getState().accounts.find(a => a.id === target.accountId)
                            if (!live) return
                            useUIStore.getState().openAddAccountDialog(live, { focusConnectionId: target.connectionId })
                        })()
                    },
                },
            }
            : {}),
    })
}

// Per-origin stickiness: once an account has EVER had more than one native login on a
// platform, every fetch of that platform stays per-connection attributed — disabling or
// removing a sibling must never flip the survivor back to the unattributed legacy id
// shape (that would orphan its cached history, resurrect duplicates, and make old
// deletions ambiguous). Singletons that were never multi keep the legacy shape.
const MULTI_ORIGIN_KEY = 'aio-multi-origin-v1'
const multiOriginAccounts = new Set<string>()
if (typeof localStorage !== 'undefined') {
    try {
        const raw = localStorage.getItem(MULTI_ORIGIN_KEY)
        if (raw) for (const key of JSON.parse(raw) as string[]) multiOriginAccounts.add(key)
    } catch { /* unreadable marker: fresh start */ }
}
function ensureMultiOrigin(platform: string, accountId: string, nativeConnectionCount: number): boolean {
    const key = `${platform}:${accountId}`
    if (nativeConnectionCount > 1 && !multiOriginAccounts.has(key)) {
        multiOriginAccounts.add(key)
        try { localStorage.setItem(MULTI_ORIGIN_KEY, JSON.stringify([...multiOriginAccounts])) } catch { /* storage unavailable: this session's stickiness only */ }
    }
    return multiOriginAccounts.has(key)
}

const bumpCacheGeneration = () => {
    cacheGeneration += 1
}

// The canonical Stremio login covers the bare account key; every enabled secondary
// login needs its own mtime entry or a freshly bound login would ride the account's
// still-fresh cache and never load its history. Canonical resolution is primary-aware
// (the primary-pointed login, else the first stored) — the same rule as
// resolvePrimaryStremio, kept local to avoid a store import cycle here.
const canonicalStremioIdOf = (account: Account): string | undefined => {
    const nativeLogins = getStremioConnections(account)
    return nativeLogins.find(c => c.id === account.primaryConnectionId)?.id ?? nativeLogins[0]?.id
}

const readableCanonicalKey = (account: Account): string =>
    getStremioConnection(account)?.enabled === false ? '' : getStremioAuthKey(account)

const requiredCoverageKeys = (accounts: Account[]): string[] => {
    const keys: string[] = []
    for (const account of accounts) {
        keys.push(account.id)
        const canonicalId = canonicalStremioIdOf(account)
        for (const conn of getStremioConnections(account)) {
            if (!conn.enabled || conn.id === canonicalId) continue
            if (!conn.credentials?.authKey) continue
            keys.push(watchContextKey(account.id, conn.id))
        }
    }
    return keys
}

const hasAccountCoverage = (
    lastMtimeByAccount: Record<string, string> | undefined,
    accounts: Account[]
) => {
    const mtimes = lastMtimeByAccount || {}
    return requiredCoverageKeys(accounts).every(key => Object.prototype.hasOwnProperty.call(mtimes, key))
}

interface CacheData {
    items: ActivityItem[]
    lastFetched: number
    lastMtimeByAccount: Record<string, string>
    metaMtimesByAccount?: Record<string, Record<string, number>>
    activityCountByCtx?: Record<string, number>
}

interface DeletedEntry {
    deletedAt: number
}

interface LibraryCacheState {
    items: ActivityItem[]
    lastFetched: number
    lastMtimeByAccount: Record<string, string>
    metaMtimesByAccount: Record<string, Record<string, number>>
    // ActivityItems the last successful full read produced per context: 0 lets a
    // zero-activity account take the meta-skip that cachedItems.length > 0 gates today.
    activityCountByCtx: Record<string, number>
    loading: boolean
    loadingProgress: { current: number; total: number }
    isStale: boolean

    ensureLoaded: (accounts: Account[]) => Promise<void>
    invalidate: () => void
    revalidate: (scopeAccountIds?: string[]) => void
    clear: () => Promise<void>
    removeItems: (itemIds: string[]) => void
    removeItemsForAccount: (accountId: string) => void
    dropMetaRows: (accountId: string, itemIds: string[]) => void
    deletedItemIds: Set<string>
}

import { isActuallyWatched, transformLibraryItemToActivityItem, transformNuvioWatchedItemToActivityItem, transformNuvioProgressToActivityItem, createCinemetaMemo, watchContextKey } from '@/lib/activity-utils'
import { canonicalIds, registerKnownTmdbAliases, tmdbAliasVersion } from '@/lib/activity-id-alias'
import { isLiveLibraryRow } from '@/lib/stremio-liveness'

export { isLiveLibraryRow }

export const useLibraryCache = create<LibraryCacheState>((set, get) => ({
    items: [],
    lastFetched: 0,
    lastMtimeByAccount: {},
    metaMtimesByAccount: {},
    activityCountByCtx: {},
    loading: false,
    loadingProgress: { current: 0, total: 0 },
    isStale: false,
    deletedItemIds: new Set(),

    removeItems: (itemIds: string[]) => {
        if (itemIds.length === 0) return
        bumpCacheGeneration()
        const { items, deletedItemIds } = get()
        const itemIdSet = new Set(itemIds)
        const newDeleted = new Set(deletedItemIds)
        const now = Date.now()
        itemIds.forEach(id => newDeleted.add(id))
        if (newDeleted.size > 500) {
            const arr = Array.from(newDeleted)
            newDeleted.clear()
            arr.slice(arr.length - 500).forEach(id => newDeleted.add(id))
        }
        const newItems = items.filter(item => !itemIdSet.has(item.id))
        set({ items: newItems, deletedItemIds: newDeleted })

        removeItemsLock = removeItemsLock.then(async () => {
            await localforage.removeItem(CACHE_KEY); invalidatePersistedLibraryFingerprint()
            const existing = await localforage.getItem<Record<string, DeletedEntry>>(DELETED_ITEMS_KEY)
            const entries = existing || {}
            itemIds.forEach(id => { entries[id] = { deletedAt: now } })
            await localforage.setItem(DELETED_ITEMS_KEY, entries)
        }).catch(() => {})
    },

    removeItemsForAccount: (accountId: string) => {
        bumpCacheGeneration()
        const { items, lastMtimeByAccount, metaMtimesByAccount, activityCountByCtx } = get()
        const filtered = items.filter(item => item.accountId !== accountId)
        const scopePrefix = `${accountId}::`
        const newMtimes = { ...lastMtimeByAccount }
        for (const key of Object.keys(newMtimes)) {
            if (key === accountId || key.startsWith(scopePrefix)) delete newMtimes[key]
        }
        const newMetas = { ...metaMtimesByAccount }
        for (const key of Object.keys(newMetas)) {
            if (key === accountId || key.startsWith(scopePrefix)) delete newMetas[key]
        }
        const newCounts = { ...activityCountByCtx }
        for (const key of Object.keys(newCounts)) {
            if (key === accountId || key.startsWith(scopePrefix)) delete newCounts[key]
        }
        for (const key of [...seriesRowsForBackfill.keys()]) {
            if (key === accountId || key.startsWith(scopePrefix)) seriesRowsForBackfill.delete(key)
        }
        set({ items: filtered, lastMtimeByAccount: newMtimes, metaMtimesByAccount: newMetas, activityCountByCtx: newCounts, isStale: true })
        localforage.removeItem(CACHE_KEY).then(() => invalidatePersistedLibraryFingerprint()).catch(() => {})
    },

    // Rows whose content changed without an mtime bump (bitfield rewrites keep the original
    // mtime); dropping the key forces the next meta comparison to miss and refetch.
    // lastMtime goes too, or the mtime-skip branch reuses the stale rows this drop evicted.
    dropMetaRows: (accountId, itemIds) => {
        const { metaMtimesByAccount, lastMtimeByAccount } = get()
        const map = metaMtimesByAccount[accountId]
        if (!map) return
        const next = { ...map }
        let changed = false
        for (const id of itemIds) {
            if (id in next) { delete next[id]; changed = true }
        }
        if (changed) {
            const newMtimes = { ...lastMtimeByAccount }
            delete newMtimes[accountId]
            const newCounts = { ...get().activityCountByCtx }
            delete newCounts[accountId]
            seriesRowsForBackfill.delete(accountId)
            set({ metaMtimesByAccount: { ...metaMtimesByAccount, [accountId]: next }, lastMtimeByAccount: newMtimes, activityCountByCtx: newCounts })
        }
    },

    invalidate: () => {
        bumpCacheGeneration()
        seriesRowsForBackfill.clear()
        set({ items: [], lastMtimeByAccount: {}, metaMtimesByAccount: {}, activityCountByCtx: {}, isStale: true })
        localforage.removeItem(CACHE_KEY).then(() => invalidatePersistedLibraryFingerprint()).catch(() => {})
    },

    // Refresh without dropping last-known items: a failed account keeps them, and
    // clearing the scoped meta maps forces a full read instead of a meta-skip.
    revalidate: (scopeAccountIds) => {
        bumpCacheGeneration()
        const inScope = (key: string) => !scopeAccountIds || scopeAccountIds.some(id => key === id || key.startsWith(`${id}::`))
        const metaMtimesByAccount = { ...get().metaMtimesByAccount }
        for (const key of Object.keys(metaMtimesByAccount)) {
            if (inScope(key)) delete metaMtimesByAccount[key]
        }
        const activityCountByCtx = { ...get().activityCountByCtx }
        for (const key of Object.keys(activityCountByCtx)) {
            if (inScope(key)) delete activityCountByCtx[key]
        }
        for (const key of [...seriesRowsForBackfill.keys()]) {
            if (inScope(key)) seriesRowsForBackfill.delete(key)
        }
        set({ metaMtimesByAccount, activityCountByCtx, isStale: true })
    },

    clear: async () => {
        bumpCacheGeneration()
        seriesRowsForBackfill.clear()
        set({ items: [], lastFetched: 0, lastMtimeByAccount: {}, metaMtimesByAccount: {}, activityCountByCtx: {}, isStale: true, deletedItemIds: new Set() })
        await localforage.removeItem(CACHE_KEY); invalidatePersistedLibraryFingerprint()
        await localforage.removeItem(DELETED_ITEMS_KEY)
    },

    ensureLoaded: async (accounts: Account[]) => {
        if (accounts.length === 0) return
        trace('libraryCache', 'ensureLoaded.start', { accountCount: accounts.length })

        const storedVersion = localStorage.getItem('aio-cache-version')
        if (storedVersion !== String(CACHE_VERSION)) {
            await localforage.removeItem(CACHE_KEY)
            for (const legacyKey of LEGACY_CACHE_KEYS) {
                await localforage.removeItem(legacyKey)
            }
            invalidatePersistedLibraryFingerprint()
            localStorage.setItem('aio-cache-version', String(CACHE_VERSION))
            set({ items: [], lastMtimeByAccount: {}, metaMtimesByAccount: {}, activityCountByCtx: {} })
        }

        let shouldRetry = true
        while (shouldRetry) {
            const state = get()
            const now = Date.now()

            if (
                !state.isStale &&
                state.lastFetched > 0 &&
                now - state.lastFetched < CACHE_TTL &&
                hasAccountCoverage(state.lastMtimeByAccount, accounts)
            ) {
                trace('libraryCache', 'ensureLoaded.cache-hit', { accountCount: accounts.length, items: state.items.length })
                return
            }

            if (loadPromise) {
                const currentLoad = loadPromise
                await currentLoad
                if (loadPromise === currentLoad) {
                    loadPromise = null
                }
                const nextState = get()
                if (
                    loadPromiseGeneration !== cacheGeneration ||
                    nextState.isStale ||
                    !hasAccountCoverage(nextState.lastMtimeByAccount, accounts)
                ) {
                    continue
                }
                shouldRetry = false
                continue
            }

            loadPromiseGeneration = cacheGeneration
            let loadFailed = false
            loadPromise = (async () => {
                const state = get()
                const now = Date.now()
                const activeAccountIds = new Set(accounts.map(account => account.id))
                const generation = cacheGeneration
                const loadStart = Date.now()
                trace('libraryCache', 'ensureLoaded.load', { accountCount: accounts.length, reason: state.isStale ? 'stale' : (!state.lastFetched ? 'cold' : 'ttl') })

                set({ loading: true })

                try {
                if (state.items.length === 0) {
                    const encrypted = await localforage.getItem<string>(CACHE_KEY)
                    const { encryptionKey } = useAuthStore.getState()

                    if (encrypted && encryptionKey && !state.isStale) {
                        try {
                            const decrypted = await decryptData(encrypted, encryptionKey)
                            const cached = JSON.parse(decrypted) as CacheData
                            const cachedMtimes = cached.lastMtimeByAccount || {}
                            const cachedMetas = cached.metaMtimesByAccount || {}
                            const cachedCounts = cached.activityCountByCtx || {}
                            const isFresh = now - cached.lastFetched < CACHE_TTL
                            const hasCov = hasAccountCoverage(cachedMtimes, accounts)
                            const savedDeleted = await localforage.getItem<Record<string, DeletedEntry>>(DELETED_ITEMS_KEY)
                            if (generation !== cacheGeneration) return
                            const deletedEntries = savedDeleted || {}
                            const filteredItems = cached.items.filter(item =>
                                activeAccountIds.has(item.accountId) && !deletedEntries[item.id]
                            ).filter(item => {
                                const n = item.name?.trim() || ''
                                if (!n || n === 'Unknown' || n === 'Unknown Title') return false
                                if (item.source === 'realstream' && /^(tmdb:|movie_|series_|rs:|tv_)/i.test(n)) return false
                                // Pre-2026-08 mapper artifact: realstream series cached without episode
                                // identity duplicate the badged entries — drop; the next refresh re-adds them.
                                if (item.source === 'realstream' && item.type !== 'movie' && item.episode == null) return false
                                return true
                            })
                            const hydratedItems = filteredItems.map(i => {
                                const t = new Date(i.timestamp)
                                return {
                                    ...i,
                                    timestamp: t.getTime() > now ? new Date(now) : t
                                }
                            })

                            if (isFresh && hasCov) {
                                set({
                                    items: reuseActivityItems(get().items, hydratedItems),
                                    lastFetched: cached.lastFetched,
                                    lastMtimeByAccount: cachedMtimes,
                                    metaMtimesByAccount: cachedMetas,
                                    activityCountByCtx: cachedCounts,
                                    isStale: false,
                                    loading: false,
                                    deletedItemIds: reuseDeletedItemIds(get().deletedItemIds, Object.keys(deletedEntries))
                                })
                                return
                            }

                            if (hydratedItems.length > 0) {
                                set({
                                    items: reuseActivityItems(get().items, hydratedItems),
                                    lastMtimeByAccount: cachedMtimes,
                                    metaMtimesByAccount: cachedMetas,
                                    activityCountByCtx: cachedCounts,
                                    deletedItemIds: reuseDeletedItemIds(get().deletedItemIds, Object.keys(deletedEntries))
                                })
                            } else {
                                // A cache of zero-activity scopes has no items but its markers still
                                // let unchanged metadata skip the full library read.
                                set({ lastMtimeByAccount: cachedMtimes, metaMtimesByAccount: cachedMetas, activityCountByCtx: cachedCounts })
                            }
                        } catch (e) {
                            if (import.meta.env.DEV) console.error('[LibraryCache] Failed to decrypt cache:', e)
                            localforage.removeItem(CACHE_KEY).then(() => invalidatePersistedLibraryFingerprint()).catch(() => {})
                        }
                    }
                }

                const savedDeleted = await localforage.getItem<Record<string, DeletedEntry>>(DELETED_ITEMS_KEY)
                if (savedDeleted) {
                    const deletedItemIds = reuseDeletedItemIds(get().deletedItemIds, Object.keys(savedDeleted))
                    if (deletedItemIds !== get().deletedItemIds) set({ deletedItemIds })
                }

                set({ loadingProgress: { current: 0, total: accounts.length } })

                const { encryptionKey } = useAuthStore.getState()
                if (!encryptionKey) {
                    set({ loading: false })
                    throw new Error('App is locked')
                }

                const staleByAccount = new Map<string, ActivityItem[]>()
                const currentItems = get().items
                for (const item of currentItems) {
                    if (activeAccountIds.has(item.accountId)) {
                        const list = staleByAccount.get(item.accountId)
                        if (list) list.push(item)
                        else staleByAccount.set(item.accountId, [item])
                    }
                }
                const fetchedByAccount = new Map<string, ActivityItem[]>()
                const newMtimes: Record<string, string> = { ...get().lastMtimeByAccount }
                const newMetaMtimes: Record<string, Record<string, number>> = { ...get().metaMtimesByAccount }
                const newActivityCounts: Record<string, number> = { ...get().activityCountByCtx }
                const allMtimes = new Map<string, number>()

                const buildMergedItems = (): ActivityItem[] => {
                    const merged: ActivityItem[] = []
                    for (const accId of activeAccountIds) {
                        const fetched = fetchedByAccount.get(accId)
                        if (fetched) {
                            merged.push(...fetched)
                        } else {
                            const stale = staleByAccount.get(accId)
                            if (stale) merged.push(...stale)
                        }
                    }
                    merged.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
                    return merged
                }

                const executing = new Set<Promise<void>>()
                let completedCount = 0

                const [
                    { useWatchEventStore },
                    { fetchConnectionToken, hashRejectedToken, isNuvioJwtAuthError },
                    { nuvioDriverFor, realStreamDriverFor },
                    { getCachedNuvioToken, setCachedNuvioToken, invalidateNuvioToken },
                    { invalidateNuvioProfileCache },
                ] = await Promise.all([
                    import('@/store/watchEventStore'),
                    import('@/api/connection'),
                    import('@/lib/drivers/factory'),
                    import('@/lib/nuvio-token-cache'),
                    import('@/lib/nuvio-profile-cache'),
                ])
                await useWatchEventStore.getState().load()
                // Registers the mappings already on hand; when that changes what is known,
                // tombstones and baselines are re-checked through the new aliases.
                const learnTmdbAliases = (items: ReadonlyArray<{ itemId: string; type: string }>) => {
                    const version = tmdbAliasVersion()
                    registerKnownTmdbAliases(items)
                    if (tmdbAliasVersion() !== version) useWatchEventStore.getState().reapplyTombstones()
                }

                // Batch cached library metadata checks; failed slots fall back to full account reads.
                const metaRowsByAccount = new Map<string, Array<[string, number]> | null>()
                let batchMetaFailed = false
                const authKeyByAccount = new Map<string, string>()
                // Decrypt every Stremio login's key up front: the canonical login under the
                // bare account key, each enabled secondary under its per-connection context.
                const secondaryAuthKeysByAccount = new Map<string, Array<{ connectionId: string; authKey: string }>>()
                const unreadableSecondariesByAccount = new Map<string, string[]>()
                await mapConcurrent(accounts, 5, async (account) => {
                    const stremioAuthKey = readableCanonicalKey(account)
                    if (stremioAuthKey) {
                        try {
                            authKeyByAccount.set(account.id, await getCachedAuthKey(stremioAuthKey, encryptionKey))
                        } catch {
                            // Unreadable key: the per-account path records the failure as before.
                        }
                    }
                    const nativeLogins = getStremioConnections(account)
                    const canonicalId = canonicalStremioIdOf(account)
                    const secondaries: Array<{ connectionId: string; authKey: string }> = []
                    const unreadable: string[] = []
                    for (const conn of nativeLogins) {
                        if (!conn.enabled || conn.id === canonicalId || !conn.credentials?.authKey) continue
                        try {
                            secondaries.push({ connectionId: conn.id, authKey: await getCachedAuthKey(conn.credentials.authKey, encryptionKey) })
                        } catch {
                            unreadable.push(conn.id)
                        }
                    }
                    if (secondaries.length > 0) secondaryAuthKeysByAccount.set(account.id, secondaries)
                    if (unreadable.length > 0) unreadableSecondariesByAccount.set(account.id, unreadable)
                })
                const precheckEntries: Array<{ scopeKey: string; authKey: string; accountContext: string }> = []
                for (const account of accounts) {
                    const cachedMetaMap = get().metaMtimesByAccount[account.id]
                    const cachedAccountItems = staleByAccount.get(account.id)
                    const hasCachedAccountItems = (cachedAccountItems?.length ?? 0) > 0
                    const hasEventSnapshot = Boolean(useWatchEventStore.getState().snapshot[account.id])
                    const authKey = authKeyByAccount.get(account.id)
                    if (cachedMetaMap && (hasCachedAccountItems || newActivityCounts[account.id] === 0) && hasEventSnapshot && authKey) {
                        precheckEntries.push({ scopeKey: account.id, authKey, accountContext: account.id })
                    }
                    for (const secondary of secondaryAuthKeysByAccount.get(account.id) || []) {
                        const ctx = watchContextKey(account.id, secondary.connectionId)
                        const ctxMetaMap = get().metaMtimesByAccount[ctx]
                        const ctxItems = currentItems.filter(i => i.sourceConnectionId === secondary.connectionId)
                        const ctxSnapshot = Boolean(useWatchEventStore.getState().snapshot[ctx])
                        if (ctxMetaMap && (ctxItems.length > 0 || newActivityCounts[ctx] === 0) && ctxSnapshot) {
                            precheckEntries.push({ scopeKey: ctx, authKey: secondary.authKey, accountContext: ctx })
                        }
                    }
                }
                // The batch runs un-awaited: cold scopes start their reads immediately and
                // only the precheck branch in fetchStremioLogin waits for these rows.
                let batchPromise: Promise<void> | null = null
                if (precheckEntries.length > 0) {
                    const batchStart = Date.now()
                    batchPromise = stremioClient
                        .getLibraryMetaBatch(precheckEntries.map(e => ({ authKey: e.authKey, accountContext: e.accountContext })))
                        .then(batchResults => {
                            precheckEntries.forEach((entry, i) => metaRowsByAccount.set(entry.scopeKey, batchResults[i] ?? null))
                            trace('libraryCache', 'meta-batch.hit', { accounts: precheckEntries.length, timing: Date.now() - batchStart })
                        })
                        .catch(err => {
                            // If batching fails, use the existing per-account metadata path.
                            batchMetaFailed = true
                            trace('libraryCache', 'meta-batch.error', { accounts: precheckEntries.length, error: (err as Error)?.message, timing: Date.now() - batchStart })
                        })
                }

                // One Stremio login's load. The canonical login runs with ctx = account.id and
                // the exact pre-multiplicity behavior (legacy ids, snapshot and mtime keys);
                // a secondary login runs under `${accountId}::${connectionId}` with its own
                // sealed key, its own diff context and connection-tagged item ids.
                const fetchStremioLogin = async (
                    account: Account,
                    login: { authKey: string; ctx: string; connectionId?: string; ownerConnectionId?: string },
                    sink: ActivityItem[]
                ): Promise<void> => {
                    const isCanonical = login.ctx === account.id
                    const cachedItems = isCanonical
                        ? (staleByAccount.get(account.id) || []).filter(item =>
                            (!item.source || item.source === 'stremio')
                            && (login.ownerConnectionId
                                ? item.sourceConnectionId === login.ownerConnectionId
                                : !item.sourceConnectionId))
                        : currentItems.filter(i => i.sourceConnectionId === login.connectionId)

                    // datastoreMeta pre-check: provably unchanged id->mtime snapshot skips the
                    // fetch and diff. Backfill still fires (retry contract), and a missing event
                    // snapshot forces the full path - the diff is what re-seeds it after a reset.
                    let metaSkipped = false
                    const cachedMetaMap = get().metaMtimesByAccount[login.ctx]
                    const hasEventSnapshot = Boolean(useWatchEventStore.getState().snapshot[login.ctx])
                    const hasSameCanonicalOwner = !isCanonical || !login.ownerConnectionId
                        || useWatchEventStore.getState().snapshotOwners[account.id] === login.ownerConnectionId
                    if (cachedMetaMap && cachedItems && (cachedItems.length > 0 || newActivityCounts[login.ctx] === 0) && hasEventSnapshot && hasSameCanonicalOwner) {
                        // Only this branch reads the batch's rows: wait for it here, so
                        // scopes that skip the precheck never pay the batch round trip.
                        if (batchPromise) await batchPromise
                        let metaRows: Array<[string, number]> | null = null
                        if (batchMetaFailed) {
                            try {
                                metaRows = await stremioClient.getLibraryMeta(login.authKey, login.ctx)
                            } catch {
                                metaRows = null
                            }
                        } else {
                            const slot = metaRowsByAccount.get(login.ctx)
                            metaRows = slot ?? null
                            if (metaRows === null && metaRowsByAccount.has(login.ctx)) {
                                // A failed batch slot should not immediately fan out into a
                                // full library read. Retry the cheap single-account metadata
                                // check first; only that account falls back if it also fails.
                                try {
                                    metaRows = await stremioClient.getLibraryMeta(login.authKey, login.ctx)
                                    trace('libraryCache', 'meta-batch.slot-retry', { accountId: account.id, connectionId: login.connectionId, rows: metaRows.length })
                                } catch {
                                    metaRows = null
                                }
                            }
                        }
                        if (metaRows && metaRows.length > 0 && metaIsUnchanged(cachedMetaMap, metaRows)) {
                            // Canonical meta-skip serves only THIS scope's items: secondary-attributed
                            // stale copies are left out so the secondary loop re-adds its own fresh
                            // items instead of being frozen (or duplicated) by this push.
                            sink.push(...(cachedItems || []))
                            const metaMap: Record<string, number> = {}
                            let maxMs = 0
                            for (const [itemId, mtimeMs] of metaRows) {
                                metaMap[itemId] = mtimeMs
                                allMtimes.set(`${login.ctx}:${itemId}`, mtimeMs)
                                if (mtimeMs > maxMs) maxMs = mtimeMs
                            }
                            newMetaMtimes[login.ctx] = metaMap
                            newMtimes[login.ctx] = new Date(maxMs).toISOString()
                            trace('libraryCache', 'stremio.meta-skip', { accountId: account.id, connectionId: login.connectionId, rows: metaRows.length })
                            metaSkipped = true
                            learnTmdbAliases(cachedItems || [])
                            const cachedRows = seriesRowsForBackfill.get(login.ctx)
                            if (cachedRows && cachedRows.length > 0) {
                                useWatchEventStore.getState().recordBackfillEpisodes(account.id, cachedRows, { contextKey: login.ctx, sourceConnectionId: login.connectionId, ownerConnectionId: login.ownerConnectionId })
                                    .then(backfilled => { if (backfilled > 0) triggerSync() })
                                    .catch(e => { if (import.meta.env?.DEV) console.error(`[LibraryCache] bitfield backfill (meta-skip) failed for ${account.name || account.id}:`, e) })
                            }
                        } else {
                            trace('libraryCache', 'stremio.meta-miss', { accountId: account.id, connectionId: login.connectionId })
                        }
                    }

                    if (metaSkipped) return

                    const libraryItems = await stremioClient.getLibraryItems(login.authKey, login.ctx) as LibraryItem[]
                    // Known id mappings must be in place before seed, diff and backfill admission.
                    learnTmdbAliases(libraryItems.map(item => ({ itemId: item._id, type: item.type || '' })))

                    const metaMap: Record<string, number> = {}
                    for (const item of libraryItems) {
                        const ms = new Date(item._mtime || '').getTime()
                        metaMap[item._id] = Number.isNaN(ms) ? 0 : ms
                    }
                    newMetaMtimes[login.ctx] = metaMap

                    const seriesRows = libraryItems.filter(item =>
                        (item.type === 'series' || item.type === 'anime' || item.type === 'episode')
                        && item._id?.startsWith('tt')
                        && item.state?.watched
                    )
                    if (seriesRows.length > 0) seriesRowsForBackfill.set(login.ctx, seriesRows)
                    else seriesRowsForBackfill.delete(login.ctx)

                    const latestMtime = libraryItems.reduce((max, item) => {
                        if (!item._mtime) return max
                        return item._mtime > max ? item._mtime : max
                    }, '0')

                    // Secondary logins diff with full per-connection attribution; the canonical
                    // login records its owner (switch guard) and attributes items without
                    // changing any legacy id or event identity.
                    const diffOptions = login.connectionId
                        ? { contextKey: login.ctx, sourceConnectionId: login.connectionId }
                        : (login.ownerConnectionId ? { ownerConnectionId: login.ownerConnectionId } : undefined)
                    const transformOptions = login.connectionId
                        ? { connectionId: login.connectionId }
                        : (login.ownerConnectionId ? { connectionId: login.ownerConnectionId, distinctId: false } : undefined)
                    libraryItems.forEach(item => {
                        if (item._mtime) {
                            const key = `${login.ctx}:${item._id}`
                            allMtimes.set(key, new Date(item._mtime).getTime())
                        }
                    })

                    const ownBits = await useWatchEventStore.getState().resolveOwnEpisodeBits(libraryItems, login.ctx)
                    const newEvents = useWatchEventStore.getState().diffAndRecord(
                        account.id, libraryItems, account, accounts, { ...diffOptions, ownBits }
                    )
                    if (newEvents.length > 0) {
                        triggerSync()
                    }

                    useWatchEventStore.getState().recordBackfillEpisodes(account.id, libraryItems, diffOptions)
                        .then(backfilled => { if (backfilled > 0) triggerSync() })
                        .catch(e => { if (import.meta.env.DEV) console.error(`[LibraryCache] bitfield backfill failed for ${account.name || account.id}:`, e) })

                    const accountActivity = libraryItems
                        // Liveness is Stremio's rule (removed && !temp is gone, temp rows
                        // stay live); deletion suppression is the shipped tombstone path.
                        .filter(item => isActuallyWatched(item) && isLiveLibraryRow(item))
                        .map(item => transformLibraryItemToActivityItem(item, account, accounts, transformOptions))

                    newActivityCounts[login.ctx] = accountActivity.length
                    sink.push(...accountActivity)
                    newMtimes[login.ctx] = latestMtime
                }

                const nuvioConnsFor = (account: Account) => (account.connections || []).filter(c => c.enabled && c.platform === 'nuvio')

                for (let i = 0; i < accounts.length; i++) {
                    const account = accounts[i]
                    const p = (async () => {
                        const accountItems: ActivityItem[] = []
                        const nuvioConns = nuvioConnsFor(account)
                        try {
                            const stremioAuthKey = readableCanonicalKey(account)
                            if (stremioAuthKey) {
                                const authKey = authKeyByAccount.get(account.id) ?? await getCachedAuthKey(stremioAuthKey, encryptionKey)
                                // Canonical identity: a real stored canonical connection owns the
                                // bare-account diff (owner marker guards canonical switches) and its
                                // items carry attribution for exact-origin deletes — while ids, event
                                // identities and tombstones keep the legacy shapes. A legacy
                                // authKey-only account has no stored connection and stays fully legacy.
                                const canonicalConnId = canonicalStremioIdOf(account)
                                await fetchStremioLogin(account, { authKey, ctx: account.id, ownerConnectionId: canonicalConnId }, accountItems)
                            } else {
                                newMtimes[account.id] = newMtimes[account.id] ?? '0'
                            }

                            // Secondary Stremio logins: each history loads under its own
                            // context with its own sealed key. A failed secondary never
                            // blocks or wipes the canonical login's items (isolated catch),
                            // and its own last-known items are preserved like Nuvio's.
                            const secondaries = secondaryAuthKeysByAccount.get(account.id) || []
                            for (const secondary of secondaries) {
                                const ctx = watchContextKey(account.id, secondary.connectionId)
                                try {
                                    await fetchStremioLogin(account, { authKey: secondary.authKey, ctx, connectionId: secondary.connectionId }, accountItems)
                                    trace('libraryCache', 'stremio.secondary.loaded', { accountId: account.id, connectionId: secondary.connectionId })
                                } catch (err) {
                                    if (import.meta.env.DEV) console.warn(`[LibraryCache] Secondary Stremio history fetch failed for ${account.name || account.id} (${secondary.connectionId}), preserving last known items:`, err)
                                    trace('libraryCache', 'stremio.secondary.error', { accountId: account.id, connectionId: secondary.connectionId, error: (err as Error)?.message })
                                    const existingSecondary = currentItems.filter(item => item.sourceConnectionId === secondary.connectionId)
                                    if (existingSecondary.length > 0) accountItems.push(...existingSecondary)
                                    newMtimes[ctx] = newMtimes[ctx] ?? '0'
                                }
                            }
                            // Undecryptable secondary keys still count toward coverage: keep their
                            // last-known rows and mark the context so ensureLoaded does not loop.
                            for (const connectionId of unreadableSecondariesByAccount.get(account.id) || []) {
                                accountItems.push(...currentItems.filter(item => item.sourceConnectionId === connectionId))
                                const ctx = watchContextKey(account.id, connectionId)
                                newMtimes[ctx] = newMtimes[ctx] ?? '0'
                            }
                        } catch (err) {
                            if (import.meta.env.DEV) console.error(`[LibraryCache] Failed to fetch account ${account.name || account.id}:`, err)
                            newMtimes[account.id] = newMtimes[account.id] ?? '0'
                            // Fetch failed (offline/flaky): preserve last-known items like the
                            // Nuvio/RealStream paths do, instead of recording an empty account
                            // and wiping the cached feed.
                            const stale = staleByAccount.get(account.id)
                            if (stale) accountItems.push(...stale)
                            // Secondaries were skipped; without their mtime keys the load never
                            // reaches coverage and ensureLoaded re-runs it in a tight loop.
                            const skipped = [...(secondaryAuthKeysByAccount.get(account.id) || []).map(s => s.connectionId), ...(unreadableSecondariesByAccount.get(account.id) || [])]
                            for (const connectionId of skipped) {
                                const ctx = watchContextKey(account.id, connectionId)
                                newMtimes[ctx] = newMtimes[ctx] ?? '0'
                            }
                        }

                        // Cross-connection dedup: unattributed items (canonical Stremio, the
                        // single-connection Nuvio/RealStream legacy shape) dedup on the bare
                        // account keys exactly as before. Attributed items (a second+ login on
                        // the same platform) dedup only within their OWN connection — the same
                        // title watched through two logins stays separately visible — while the
                        // bare keys stay read-only cross-platform guards (Stremio vs Nuvio).
                        const existingKeys = new Set<string>()
                        for (const it of accountItems) {
                            existingKeys.add(`${account.id}:${it.itemId}`)
                            if (it.uniqueItemId) existingKeys.add(`${account.id}:${it.uniqueItemId}`)
                        }
                        const originKey = (activity: ActivityItem, unique: boolean): string => {
                            if (!activity.sourceConnectionId) return `${account.id}:${unique ? activity.uniqueItemId : activity.itemId}`
                            return `${account.id}:${activity.source}:${activity.sourceConnectionId}:${unique ? activity.uniqueItemId : activity.itemId}`
                        }
                        // A tmdb: row of a title the Stremio library holds under its tt id is the same
                        // play when an authoritative mapping says so: compare through it, never rewrite.
                        learnTmdbAliases(accountItems)
                        const aliasedKeyHit = (activity: ActivityItem, includeShow: boolean): boolean => {
                            const canon = canonicalIds(activity)
                            if (canon === activity) return false
                            return existingKeys.has(originKey(canon, true)) || (includeShow && existingKeys.has(originKey(canon, false)))
                        }

                        if (nuvioConns.length > 0) {
                            // Sticky per-origin attribution: once multi, always attributed —
                            // disabling or removing a sibling must never flip the survivor's
                            // ids/history back to the unattributed legacy shape. Counted over
                            // ALL native logins (enabled or not); the persisted marker covers
                            // removed siblings.
                            const allNuvioNative = (account.connections || []).filter(c => c.platform === 'nuvio')
                            const multiNuvio = ensureMultiOrigin('nuvio', account.id, allNuvioNative.length)
                            await mapConcurrent(nuvioConns, 3, async (conn) => {
                                const cinemetaMemo = createCinemetaMemo()
                                const transformOpts = { ...(multiNuvio ? { connectionId: conn.id } : {}), cinemetaMemo }
                                const eventOpts = multiNuvio ? { sourceConnectionId: conn.id } : undefined
                                try {
                                    let token = getCachedNuvioToken(conn.id)
                                    if (!token) {
                                        token = await fetchConnectionToken(account.id, conn.id, 'nuvio', conn.credentials?.baseUrl)
                                        setCachedNuvioToken(conn.id, token)
                                    }
                                    const driver = nuvioDriverFor(conn)
                                    let profileId = token.profileId ?? conn.credentials?.profileId
                                    const readPair = async (accessToken: string) => {
                                        const [historyResult, progressResult] = await Promise.allSettled([
                                            driver.readWatchHistory(accessToken, profileId),
                                            driver.readWatchProgress(accessToken, profileId),
                                        ])
                                        const rejected = [historyResult, progressResult].filter((result): result is PromiseRejectedResult => result.status === 'rejected')
                                        const authFailure = rejected.find(result => isAuthError(result.reason))
                                        if (authFailure) throw authFailure.reason
                                        if (rejected.length === 2) throw rejected[0].reason
                                        return {
                                            watched: historyResult.status === 'fulfilled' ? historyResult.value : [],
                                            progress: progressResult.status === 'fulfilled' ? progressResult.value : [],
                                            partial: rejected.length > 0,
                                            failedHistory: historyResult.status === 'rejected',
                                            failedProgress: progressResult.status === 'rejected',
                                        }
                                    }
                                    let watched: Awaited<ReturnType<typeof driver.readWatchHistory>>
                                    let progress: Awaited<ReturnType<typeof driver.readWatchProgress>>
                                    let partialRead = false
                                    let failedHistory = false
                                    let failedProgress = false
                                    try {
                                        const result = await readPair(token.accessToken)
                                        watched = result.watched
                                        progress = result.progress
                                        partialRead = result.partial
                                        failedHistory = result.failedHistory
                                        failedProgress = result.failedProgress
                                    } catch (readError) {
                                        // A cached bearer can expire between the token vend and
                                        // the two parallel reads. Invalidate it and retry the pair
                                        // once; never turn a 401 into an empty snapshot. A JWT-type
                                        // 401 asks the server to force-revalidate that exact token.
                                        if (!isAuthError(readError)) throw readError
                                        const forcedHash = isNuvioJwtAuthError(readError) ? await hashRejectedToken(token.accessToken) : undefined
                                        invalidateNuvioToken(conn.id)
                                        invalidateNuvioProfileCache()
                                        const refreshed = await fetchConnectionToken(account.id, conn.id, 'nuvio', conn.credentials?.baseUrl, forcedHash ? { rejectedTokenHash: forcedHash } : undefined)
                                        setCachedNuvioToken(conn.id, refreshed)
                                        token = refreshed
                                        profileId = token.profileId ?? conn.credentials?.profileId
                                        const result = await readPair(token.accessToken)
                                        watched = result.watched
                                        progress = result.progress
                                        partialRead = result.partial
                                        failedHistory = result.failedHistory
                                        failedProgress = result.failedProgress
                                    }
                                    if (partialRead) {
                                        trace('libraryCache', 'nuvio.fetch.partial', {
                                            accountId: account.id,
                                            connectionId: multiNuvio ? conn.id : undefined,
                                            failedHistory,
                                            failedProgress,
                                        })
                                        const stale = currentItems.filter(item => item.accountId === account.id && item.source === 'nuvio'
                                            && (!multiNuvio || !item.sourceConnectionId || item.sourceConnectionId === conn.id))
                                        for (const item of stale) {
                                            const staleKey = originKey(item, true)
                                            const staleBaseKey = originKey(item, false)
                                            if (existingKeys.has(staleKey) || existingKeys.has(staleBaseKey)) continue
                                            accountItems.push(item)
                                            existingKeys.add(staleBaseKey)
                                            if (item.uniqueItemId) existingKeys.add(staleKey)
                                        }
                                        return
                                    }
                                    if (import.meta.env.DEV) console.info(`[LibraryCache] Nuvio fetched ${watched.length} watched + ${progress.length} progress for ${account.name || account.id}`)
                                    trace('libraryCache', 'nuvio.fetch', { accountId: account.id, connectionId: multiNuvio ? conn.id : undefined, watched: watched.length, progress: progress.length })
                                    const nuvioTitles = new Map<string, string>()
                                    for (const w of watched) {
                                        if (w?.content_id && w?.title) nuvioTitles.set(String(w.content_id), String(w.title))
                                    }
                                    const progressActivities = await mapConcurrent(progress, 5, async (row) => {
                                        try {
                                            return await transformNuvioProgressToActivityItem(row, account, accounts, nuvioTitles.get(String(row.content_id)), transformOpts)
                                        } catch {
                                            return null
                                        }
                                    })
                                    const seenIds = new Set<string>()
                                    for (const activity of progressActivities) {
                                        if (!activity) continue
                                        const pk1 = originKey(activity, true)
                                        const pk2 = originKey(activity, false)
                                        if (existingKeys.has(pk1) || existingKeys.has(pk2) || aliasedKeyHit(activity, true)) continue
                                        seenIds.add(activity.uniqueItemId)
                                        // pk2 (show-level) is checked only — never added — so that
                                        // later episodes of the same show in this batch survive.
                                        existingKeys.add(pk1)
                                        accountItems.push(activity)
                                    }
                                    const watchedActivities = await mapConcurrent(watched, 5, async (row) => {
                                        try {
                                            return await transformNuvioWatchedItemToActivityItem(row, account, accounts, transformOpts)
                                        } catch (err) {
                                            trace('libraryCache', 'nuvio.watched.transform-failed', { accountId: account.id, connectionId: multiNuvio ? conn.id : undefined, contentId: row?.content_id, error: (err as Error)?.message })
                                            return null
                                        }
                                    })
                                    for (const activity of watchedActivities) {
                                        if (!activity || seenIds.has(activity.uniqueItemId)) continue
                                        // Episode-level dedup only: a show-level key would drop every
                                        // Nuvio episode of a show that merely exists in the Stremio library.
                                        const wk1 = originKey(activity, true)
                                        if (existingKeys.has(wk1) || aliasedKeyHit(activity, false)) {
                                            trace('libraryCache', 'nuvio.watched.drop-dedup', { accountId: account.id, connectionId: multiNuvio ? conn.id : undefined, itemId: activity.itemId, uniqueItemId: activity.uniqueItemId, name: activity.name, hit: 'unique' })
                                            continue
                                        }
                                        existingKeys.add(wk1)
                                        accountItems.push(activity)
                                    }
                                    const nuvioActivities = [
                                        ...progressActivities.filter((a): a is ActivityItem => a !== null),
                                        ...watchedActivities.filter((a): a is ActivityItem => a !== null && !seenIds.has(a.uniqueItemId)),
                                    ]
                                    if (nuvioActivities.length > 0) {
                                        useWatchEventStore.getState().mergeExternalWatchEvents(account.id, 'nuvio', nuvioActivities.map(a => ({
                                            itemId: a.itemId,
                                            video_id: a.uniqueItemId,
                                            type: a.type,
                                            season: a.season,
                                            episode: a.episode,
                                            name: a.name,
                                            poster: a.poster,
                                            duration: a.duration,
                                            progress: a.progress,
                                            backfill: a.backfill,
                                            timestamp: a.timestamp.getTime(),
                                        })), eventOpts)
                                    }
                                } catch (err) {
                                    invalidateNuvioToken(conn.id)
                                    if (import.meta.env.DEV) console.warn(`[LibraryCache] Nuvio history fetch failed for ${account.name || account.id}, preserving last known items:`, err)
                                    trace('libraryCache', 'nuvio.fetch.error', { accountId: account.id, connectionId: multiNuvio ? conn.id : undefined, error: (err as Error)?.message })
                                    if (!toastedNuvioFailures.has(conn.id)) {
                                        toastedNuvioFailures.add(conn.id)
                                        notifyHistoryFetchFailed(err, { accountId: account.id, profileName: account.name || 'account', platformId: conn.platform, connectionId: conn.id })
                                        setTimeout(() => toastedNuvioFailures.delete(conn.id), 3600000)
                                    }
                                    // A failed login preserves ITS OWN last-known items; sibling
                                    // logins' items are never dragged into the fallback copy.
                                    const existingNuvio = currentItems.filter(item => item.accountId === account.id && item.source === 'nuvio'
                                        && (!multiNuvio || !item.sourceConnectionId || item.sourceConnectionId === conn.id))
                                    if (existingNuvio.length > 0) {
                                        accountItems.push(...existingNuvio)
                                    }
                                }
                            })
                        }
                        const realstreamConns = (account.connections || []).filter(c => c.enabled && c.platform === 'realstream')
                        if (realstreamConns.length > 0) {
                            // Same sticky rule as Nuvio: never flip a survivor's attribution.
                            const allRSNative = (account.connections || []).filter(c => c.platform === 'realstream')
                            const multiRS = ensureMultiOrigin('realstream', account.id, allRSNative.length)
                            await mapConcurrent(realstreamConns, 3, async (conn) => {
                                try {
                                    const userId = conn.credentials?.userId || ''
                                    if (!userId) throw new Error('RealStream user ID missing; re-authenticate this connection')
                                    const token = await fetchConnectionToken(account.id, conn.id, 'realstream')
                                    const driver = realStreamDriverFor(conn)
                                    const progress = await readRealStreamProgressWithHeal({
                                        connId: conn.id,
                                        accessToken: token.accessToken,
                                        forcedToken: async () => (await fetchConnectionToken(account.id, conn.id, 'realstream', undefined, { rejectedTokenHash: await hashRejectedToken(token.accessToken) })).accessToken,
                                        read: accessToken => driver.readWatchProgress(accessToken, userId),
                                    })
                                    if (import.meta.env.DEV) console.info(`[LibraryCache] RealStream fetched ${progress.length} progress for ${account.name || account.id}`)
                                    trace('libraryCache', 'realstream.fetch', { accountId: account.id, connectionId: multiRS ? conn.id : undefined, progress: progress.length })
                                    const cinemetaMemo = createCinemetaMemo()
                                    const transformOpts = { ...(multiRS ? { connectionId: conn.id } : {}), cinemetaMemo }
                                    const progressActivities = await mapConcurrent(progress, 5, async (row) => {
                                        try {
                                            const rsTitle = row.title
                                            const rsPoster = row.posterPath
                                            const activity = await transformNuvioProgressToActivityItem(row, account, accounts, rsTitle, transformOpts)
                                            activity.id = multiRS
                                                ? `${account.id}:realstream:${conn.id}:${activity.uniqueItemId}`
                                                : `${account.id}:realstream:${activity.uniqueItemId}`
                                            activity.source = 'realstream'
                                            if (rsTitle && rsTitle.trim()) activity.name = rsTitle.trim()
                                            if (rsPoster && rsPoster.trim()) activity.poster = rsPoster.trim()
                                            return activity
                                        } catch {
                                            return null
                                        }
                                    })
                                    const seenIds = new Set<string>()
                                    for (const activity of progressActivities) {
                                        if (!activity || seenIds.has(activity.uniqueItemId)) continue
                                        const rk1 = originKey(activity, true)
                                        const rk2 = originKey(activity, false)
                                        if (existingKeys.has(rk1) || existingKeys.has(rk2)) continue
                                        seenIds.add(activity.uniqueItemId)
                                        // rk2 (show-level) is checked only — never added — so that
                                        // later episodes of the same show in this batch survive.
                                        existingKeys.add(rk1)
                                        accountItems.push(activity)
                                    }
                                    const realstreamActivities = progressActivities.filter((a): a is ActivityItem => a !== null)
                                    if (realstreamActivities.length > 0) {
                                        useWatchEventStore.getState().mergeExternalWatchEvents(account.id, 'realstream', realstreamActivities.map(a => ({
                                            itemId: a.itemId,
                                            video_id: a.uniqueItemId,
                                            type: a.type,
                                            season: a.season,
                                            episode: a.episode,
                                            name: a.name,
                                            poster: a.poster,
                                            duration: a.duration,
                                            progress: a.progress,
                                            backfill: a.backfill,
                                            timestamp: a.timestamp.getTime(),
                                        })), multiRS ? { sourceConnectionId: conn.id } : undefined)
                                    }
                                } catch (err) {
                                    if (import.meta.env.DEV) console.warn(`[LibraryCache] RealStream history fetch failed for ${account.name || account.id}, preserving last known items:`, err)
                                    trace('libraryCache', 'realstream.fetch.error', { accountId: account.id, connectionId: multiRS ? conn.id : undefined, error: (err as Error)?.message })
                                    if (!toastedRealStreamFailures.has(conn.id)) {
                                        toastedRealStreamFailures.add(conn.id)
                                        notifyHistoryFetchFailed(err, { accountId: account.id, profileName: account.name || 'account', platformId: conn.platform, connectionId: conn.id })
                                        setTimeout(() => toastedRealStreamFailures.delete(conn.id), 3600000)
                                    }
                                    // Per-login fallback: only THIS connection's items are preserved.
                                    const existingRealStream = currentItems.filter(item => item.accountId === account.id && item.source === 'realstream'
                                        && (!multiRS || !item.sourceConnectionId || item.sourceConnectionId === conn.id))
                                    if (existingRealStream.length > 0) {
                                        accountItems.push(...existingRealStream)
                                    }
                                }
                            })
                        }
                        if (!fetchedByAccount.has(account.id)) {
                            fetchedByAccount.set(account.id, accountItems)
                        }
                    })().then(() => {
                        completedCount++
                        set({
                            loadingProgress: { current: completedCount, total: accounts.length }
                        })
                        executing.delete(p)
                    })
                    executing.add(p)
                    if (executing.size >= LIBRARY_FETCH_CONCURRENCY) {
                        await Promise.race(executing)
                    }
                }

                await Promise.all(executing)
                // A precheck scope that left the precheck branch (canonical owner flip)
                // never awaited the batch: settle it before persisting either way.
                if (batchPromise) await batchPromise

                if (generation !== cacheGeneration) return

                const finalItems = buildMergedItems()

                const savedDeletedMap = await localforage.getItem<Record<string, DeletedEntry>>(DELETED_ITEMS_KEY)
                if (generation !== cacheGeneration) return
                const deletedEntries = savedDeletedMap || {}
                let entriesChanged = false

                const filteredFinal = finalItems.filter(item => {
                    const n = item.name?.trim() || ''
                    if (!n || n === 'Unknown' || n === 'Unknown Title') return false
                    if (item.source === 'realstream' && /^(tmdb:|movie_|series_|rs:|tv_)/i.test(n)) return false
                    // Pre-2026-08 mapper artifact: realstream series cached without episode
                    // identity duplicate the badged entries — drop; the next refresh re-adds them.
                    if (item.source === 'realstream' && item.type !== 'movie' && item.episode == null) return false
                    const entry = deletedEntries[item.id]
                    if (!entry) return true

                    // If Stremio shows a newer _mtime than when we deleted it,
                    // the user watched it again - remove from blacklist and show it.
                    // allMtimes holds Stremio library mtimes only, so the restore check
                    // is limited to Stremio-source items; an external item's _id collision
                    // with a Stremio library entry must not resurrect it.
                    const itemMtimeKey = `${watchContextKey(item.accountId, item.sourceConnectionId)}:${item.itemId}`
                    const itemMtime = item.source && item.source !== 'stremio'
                        ? 0
                        : (allMtimes.get(itemMtimeKey) || 0)

                    if (itemMtime > entry.deletedAt) {
                        delete deletedEntries[item.id]
                        entriesChanged = true
                        if (import.meta.env.DEV) console.log(`[Smart Restore] Restoring ${item.name} (${item.id}) - watched again after deletion.`)
                        return true
                    }
                    trace('libraryCache', 'final.blacklisted', { id: item.id, source: item.source, name: item.name, deletedAt: entry.deletedAt })
                    return false
                })

                if (entriesChanged) {
                    await localforage.setItem(DELETED_ITEMS_KEY, deletedEntries)
                }

                set({
                    items: reuseActivityItems(get().items, filteredFinal),
                    deletedItemIds: reuseDeletedItemIds(get().deletedItemIds, Object.keys(deletedEntries)),
                    lastFetched: now,
                    lastMtimeByAccount: newMtimes,
                    metaMtimesByAccount: newMetaMtimes,
                    activityCountByCtx: newActivityCounts,
                    loading: false,
                    isStale: false
                })
                trace('libraryCache', 'ensureLoaded.load.complete', { accountCount: accounts.length, items: filteredFinal.length, timing: Date.now() - loadStart })

                if (encryptionKey) {
                    const content = JSON.stringify({ items: filteredFinal, lastMtimeByAccount: newMtimes, metaMtimesByAccount: newMetaMtimes, activityCountByCtx: newActivityCounts })
                    if (content !== _lastPersistedLibraryContent) {
                        _lastPersistedLibraryContent = content
                        // Reuse the content serialized for deduplication: walking a
                        // large library a second time only to add its fetch time
                        // doubles the serialization work on every changed read.
                        const encrypted = await encrypt(`${content.slice(0, -1)},"lastFetched":${now}}`, encryptionKey)
                        await localforage.setItem(CACHE_KEY, encrypted)
                    }
                }
                } catch (err) {
                    loadFailed = true
                    if (import.meta.env.DEV) console.error('[LibraryCache] Fatal error during load:', err)
                } finally {
                    set({ loading: false })
                }
            })()

            const currentLoad = loadPromise
            try {
                await currentLoad
            } finally {
                if (loadPromise === currentLoad) {
                    loadPromise = null
                }
            }

            const nextState = get()
            if (loadFailed && loadPromiseGeneration === cacheGeneration) {
                // Fatal load error with no pending invalidation (e.g. vault locked
                // mid-refresh): an immediate retry fails identically and busy-loops.
                // Bail; the next ensureLoaded call re-attempts.
                shouldRetry = false
                continue
            }
            if (
                loadPromiseGeneration !== cacheGeneration ||
                nextState.isStale ||
                !hasAccountCoverage(nextState.lastMtimeByAccount, accounts)
            ) {
                continue
            }
            shouldRetry = false
        }
    }
}))
