import { triggerSync } from '@/lib/sync-trigger'
import { ActivityFeed } from '@/components/activity/ActivityFeed'
import { MediaReadBanner } from '@/components/activity/MediaReadBanner'
import { lazyChunk } from '@/lib/lazy-chunk'
import { ForYouPage } from '@/components/for-you/ForYouPage'
import { AccountDetailPage } from '@/components/for-you/AccountDetailPage'
import { ContentRail } from '@/components/ui/content-rail'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { AccountSwitcher } from '@/components/common/AccountSwitcher'
import { ActivityItem, LibraryItem } from '@/types/activity'
import { useAccountStore, getStremioAuthKey, getStremioConnection, getAccountEmail, hasPlatformConnection } from '@/store/accountStore'
import { useDiscoveryPrefs, useDiscoveryStore, CONTINUE_WATCHING_CONTEXT } from '@/store/discoveryStore'
import { useLibraryCache } from '@/store/libraryCache'
import { useWatchHistory } from '@/hooks/useWatchHistory'
import { isReadOnlyMediaActivity } from '@/lib/jellyfin/activity'
import { deleteJellyfinWatchItems, mediaDeleteTargets } from '@/lib/jellyfin/delete-history'
import { refreshJellyfinMedia } from '@/components/providers/useJellyfinMedia'
import { stremioClient } from '@/api/stremio-client'
import { decrypt } from '@/lib/crypto'
import { useAuthStore } from '@/store/authStore'
import { useSyncStore } from '@/store/syncStore'
import { useWatchEventStore } from '@/store/watchEventStore'
import { useUIStore } from '@/store/uiStore'
import { ActivityItemSkeleton } from '@/components/ui/skeleton'
import { historyEntryToActivityItem, nuvioProgressKey, getCachedCinemetaName, watchContextKey, peerLoginLabel, canonicalStremioConnections } from '@/lib/activity-utils'
import { activitySearchHaystack, activityItemTimeMs } from '@/lib/activity-search-cache'
import { continueWatchingRail } from '@/lib/activity-continue-watching'
import { rollupMinutes } from '@/lib/activity-hours'
import { useSettledOnce } from '@/hooks/useSettledSignal'
import { useActivityMetadata } from '@/hooks/useActivityMetadata'
import { enrichActivityItemsByIdentity } from '@/lib/activity-cross-source-enrichment'
import { planEpisodeBitfieldDelete } from '@/lib/episode-bitfield-delete'
import { isEpisodeScopedDelete, isBareAnchoredEpisode, hasPendingRemoteDelete } from '@/lib/activity-delete-routing'
import { fetchSeriesVideos } from '@/lib/watched-episodes'
import type { Account } from '@/types/account'

import { FloatingActionBar } from '@/components/ui/floating-action-bar'
import { Grid, List, Search, Check, X } from 'lucide-react'
import { AnimatedRefreshIcon, AnimatedTrashIcon } from '@/components/ui/AnimatedIcons'
import { Suspense, useEffect, useState, useMemo, useRef, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { toast } from '@/hooks/use-toast'
import { useDocumentTitle } from '@/hooks/use-document-title'
import { cn, maskNameLevel, maskEmailLevel } from '@/lib/utils'
import { SYNCED_SETTINGS_EVENT, type ActivitySettings } from '@/lib/synced-settings'
import { scheduleUndoable, usePendingUndoIds } from '@/lib/undo-action'
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog'
import { OperationProgress } from '@/components/ui/operation-progress'
import { ToolbarShell } from '@/components/ui/toolbar-shell'
import { Tooltip } from '@/components/ui/tooltip'
import { UpNextCard } from '@/components/activity/UpNextCard'
import { AccountAvatar } from '@/components/accounts/AccountAvatar'
import { mapConcurrent } from '@/lib/concurrency'
import { getPlatformEntry } from '@/lib/platform-registry'
import { trace } from '@/lib/trace'

const ACTIVITY_ACCOUNT_DELETE_CONCURRENCY = 4
const CONTINUE_WATCHING_LIMIT = 24
const ACTIVITY_ITEM_DELETE_CONCURRENCY = 5

const ActivityDetailModal = lazyChunk(() => import('@/components/activity/ActivityDetailModal').then(m => ({ default: m.ActivityDetailModal })))

/**
 * The sealed Stremio key + request context a delete/writeback must use for one item:
 * the EXACT connection the watch came from when the item carries attribution, the
 * canonical/legacy login otherwise. A secondary whose connection no longer exists
 * resolves to nothing — its rows are never routed through another login's key.
 */
function resolveStremioDeleteTarget(account: Account, origin: { sourceConnectionId?: string }): { sealedKey?: string; ctx: string } {
    if (origin.sourceConnectionId) {
        const conn = (account.connections || []).find(c => c.id === origin.sourceConnectionId && c.platform === 'stremio')
        if (!conn?.credentials?.authKey) return { ctx: watchContextKey(account.id, origin.sourceConnectionId) }
        return { sealedKey: conn.credentials.authKey, ctx: watchContextKey(account.id, origin.sourceConnectionId) }
    }
    return { sealedKey: getStremioAuthKey(account) || undefined, ctx: account.id }
}

// platformsPhrase retired in favor of originTargetsSummary: bulk-delete copy names the
// exact logins, not just the platforms, so grouped same-platform users see their targets.

function includesWholeShowSeriesDelete(items: ActivityItem[]): boolean {
    return items.some(item => !isReadOnlyMediaActivity(item) && item.source !== 'jellyfin' && item.source !== 'nuvio' && item.source !== 'realstream'
        && (item.type === 'series' || item.type === 'anime')
        && (item.season == null || item.episode == null))
}

/** Masked summary of the exact logins a bulk delete will touch, so grouped users see the targets. */
function originTargetsSummary(items: ActivityItem[], accountById: Map<string, Account>, privacyLevel: number, emailPrivacyLevel: number): { text: string; count: number } | null {
    const labels = new Map<string, string>()
    for (const item of items) {
        const account = accountById.get(item.accountId)
        const unlinked = item.sourceConnectionId && !account?.connections?.some(connection => connection.id === item.sourceConnectionId)
        const raw = (unlinked ? 'Unlinked connection' : peerLoginLabel(account, item.sourceConnectionId))
            ?? (account ? (account.name && !account.name.includes('@') ? account.name : getAccountEmail(account)) : undefined)
            ?? (item.source ? (getPlatformEntry(item.source)?.name ?? item.source) : 'Stremio')
        const masked = raw.includes('@') ? (maskEmailLevel(raw, emailPrivacyLevel) || raw) : maskNameLevel(raw, privacyLevel)
        labels.set(`${watchContextKey(item.accountId, item.sourceConnectionId)}|${masked}`, masked)
    }
    if (labels.size === 0) return null
    const list = Array.from(labels.values())
    return { text: list.length <= 3 ? list.join(', ') : `${list.slice(0, 3).join(', ')} +${list.length - 3} more`, count: list.length }
}

async function deleteNuvioWatchItems(account: Account, items: ActivityItem[]): Promise<{ ok: boolean; keptItems: ActivityItem[] }> {
    const nuvioConns = (account.connections || []).filter(c => c.enabled && c.platform === 'nuvio')
    if (nuvioConns.length === 0) return { ok: false, keptItems: items }
    const [{ fetchConnectionToken }, { nuvioDriverFor }, { getCachedNuvioToken, setCachedNuvioToken, invalidateNuvioToken }] = await Promise.all([
        import('@/api/connection'),
        import('@/lib/drivers/factory'),
        import('@/lib/nuvio-token-cache'),
    ])

    // Route by EXACT origin: an attributed item is deleted only through the login it came
    // from — never broadcast to sibling logins (a broad loop would erase the same title
    // across every Nuvio account bound here). Unattributed (legacy) items route through
    // the single unambiguous login; with several logins and no attribution they are kept.
    const groups = new Map<string, { conn?: typeof nuvioConns[number]; items: ActivityItem[] }>()
    const keptItems: ActivityItem[] = []
    for (const item of items) {
        if (!item.sourceConnectionId) {
            if (nuvioConns.length !== 1) { keptItems.push(item); continue }
            const group = groups.get('') ?? { conn: nuvioConns[0], items: [] }
            group.items.push(item)
            groups.set('', group)
            continue
        }
        const conn = nuvioConns.find(c => c.id === item.sourceConnectionId)
        if (!conn) { keptItems.push(item); continue }
        const group = groups.get(conn.id) ?? { conn, items: [] }
        group.items.push(item)
        groups.set(conn.id, group)
    }

    let ok = true
    for (const group of groups.values()) {
        if (!group.conn || group.items.length === 0) continue
        const historyKeys = group.items.map(i => {
            const k: { content_id: string; season?: number; episode?: number } = { content_id: i.itemId }
            if (i.episode != null) { k.season = i.season ?? 1; k.episode = i.episode }
            return k
        })
        const progressKeys = group.items.map(i => nuvioProgressKey(i.itemId, i.season, i.episode))
        try {
            let token = getCachedNuvioToken(group.conn.id)
            if (!token) {
                token = await fetchConnectionToken(account.id, group.conn.id, 'nuvio')
                setCachedNuvioToken(group.conn.id, token)
            }
            const driver = nuvioDriverFor(group.conn)
            const profileId = token.profileId ?? group.conn.credentials?.profileId
            await driver.deleteWatchHistory(token.accessToken, historyKeys, profileId)
            await driver.deleteWatchProgress(token.accessToken, progressKeys, profileId)
            trace('activityDelete', 'nuvio.connection.ok', { accountId: account.id, connectionId: group.conn.id, historyKeys: historyKeys.length, progressKeys: progressKeys.length })
        } catch (e) {
            if (import.meta.env.DEV) console.error('[Activity] Nuvio delete failed:', e)
            trace('activityDelete', 'nuvio.connection.error', { accountId: account.id, connectionId: group.conn.id, status: (e as { status?: number })?.status, error: (e as Error)?.message })
            invalidateNuvioToken(group.conn.id)
            ok = false
            keptItems.push(...group.items)
        }
    }
    return { ok, keptItems }
}

async function deleteRealStreamWatchItems(account: Account, items: ActivityItem[]): Promise<{ ok: boolean; keptItems: ActivityItem[] }> {
    const rsConns = (account.connections || []).filter(c => c.enabled && c.platform === 'realstream')
    if (rsConns.length === 0) return { ok: false, keptItems: items }
    const [{ fetchConnectionToken, hashRejectedToken }, { realStreamDriverFor }, { getOrFetchRealStreamToken, refreshRealStreamToken, invalidateRealStreamToken }, { realStreamTokenOwner }, { isAuthError }] = await Promise.all([
        import('@/api/connection'),
        import('@/lib/drivers/factory'),
        import('@/lib/realstream-token-cache'),
        import('@/lib/realstream-token-owner'),
        import('@/store/accountStore'),
    ])

    // Same exact-origin rule as Nuvio: one login's delete never touches a sibling's copy.
    const groups = new Map<string, { conn?: typeof rsConns[number]; items: ActivityItem[] }>()
    const keptItems: ActivityItem[] = []
    for (const item of items) {
        if (!item.sourceConnectionId) {
            if (rsConns.length !== 1) { keptItems.push(item); continue }
            const group = groups.get('') ?? { conn: rsConns[0], items: [] }
            group.items.push(item)
            groups.set('', group)
            continue
        }
        const conn = rsConns.find(c => c.id === item.sourceConnectionId)
        if (!conn) { keptItems.push(item); continue }
        const group = groups.get(conn.id) ?? { conn, items: [] }
        group.items.push(item)
        groups.set(conn.id, group)
    }

    let ok = true
    for (const group of groups.values()) {
        if (!group.conn || group.items.length === 0) continue
        const entries = group.items.map(i => ({
            videoId: i.uniqueItemId || i.itemId,
            contentId: i.itemId.startsWith('tt') ? i.itemId : undefined,
            season: i.season ?? null,
            episode: i.episode ?? null,
        }))
        try {
            const conn = group.conn
            const userId = conn.credentials?.userId || ''
            if (!userId) throw new Error('RealStream user ID missing; re-authenticate this connection')
            const tokenOwner = realStreamTokenOwner(account.id, conn)
            const token = await getOrFetchRealStreamToken(tokenOwner, () => fetchConnectionToken(account.id, conn.id, 'realstream'))
            const driver = realStreamDriverFor(conn)
            try {
                await driver.deleteWatchProgress(token.accessToken, userId, entries)
            } catch (err) {
                // A cached token the server has since rejected heals once, like the push path.
                if (!isAuthError(err)) throw err
                const rejectedTokenHash = await hashRejectedToken(token.accessToken)
                const fresh = await refreshRealStreamToken(tokenOwner, token.accessToken, () => fetchConnectionToken(account.id, conn.id, 'realstream', undefined, { rejectedTokenHash }))
                await driver.deleteWatchProgress(fresh.accessToken, userId, entries)
            }
            trace('activityDelete', 'realstream.connection.ok', { accountId: account.id, connectionId: conn.id, entries: entries.length })
        } catch (e) {
            if (group.conn) invalidateRealStreamToken(group.conn.id)
            if (import.meta.env.DEV) console.error('[Activity] RealStream delete failed:', e)
            trace('activityDelete', 'realstream.connection.error', { accountId: account.id, connectionId: group.conn.id, error: (e as Error)?.message })
            ok = false
            keptItems.push(...group.items)
        }
    }
    return { ok, keptItems }
}

// Minimal ActivityItem for deep links (?detail=<id>): the watch-history
// object is preferred when available, but on a cold load (or for films only
// reachable via filmography/person URLs) we open with just the id and let the
// modal's metadata fetch fill in name/poster/genres.
function detailItemFromUrlParams(itemId: string, type: string | null): ActivityItem {
    return {
        id: `url:${itemId}`,
        accountId: '',
        accountName: '',
        accountColorIndex: 0,
        itemId,
        uniqueItemId: itemId,
        name: '',
        type: type || 'movie',
        poster: '',
        timestamp: new Date(0),
        duration: 0,
        watched: 0,
        progress: 0,
        isInProgress: false,
    }
}

export function ActivityPage() {
    useDocumentTitle('Activity')
    const accounts = useAccountStore(s => s.accounts)
    const ensureLoaded = useLibraryCache(s => s.ensureLoaded)
    const loading = useLibraryCache(s => s.loading)
    const loadingProgress = useLibraryCache(s => s.loadingProgress)
    const revalidate = useLibraryCache(s => s.revalidate)
    const removeItems = useLibraryCache(s => s.removeItems)
    const syncIsAuthenticated = useSyncStore(s => s.auth.isAuthenticated)
    const syncId = useSyncStore(s => s.auth.id)
    const syncPassword = useSyncStore(s => s.auth.password)
    const isRefreshingFromCloud = useSyncStore(s => s.isRefreshingFromCloud)
    const refreshFromCloud = useSyncStore(s => s.refreshFromCloud)
    const watchEventsInitialized = useWatchEventStore(s => s.initialized)
    const liveActivity = useUIStore(s => s.liveActivity)
    const isPrivacyModeEnabled = useUIStore(s => s.isPrivacyModeEnabled)
    const privacyLevelNames = useUIStore(s => s.privacyLevelNames)
    const privacyLevelEmail = useUIStore(s => s.privacyLevelEmail)
    const privacyLevel = isPrivacyModeEnabled ? privacyLevelNames : 0
    const emailPrivacyLevel = isPrivacyModeEnabled ? privacyLevelEmail : 0
    const { dismissedItems: dismissedContinueWatching } = useDiscoveryPrefs(CONTINUE_WATCHING_CONTEXT)

    const { history: watchHistory, inProgress, refreshMedia, mediaIssues, mediaSettling } = useWatchHistory()

    const [activeView, setActiveView] = useState<'feed' | 'foryou'>('feed')
    const [forYouAccountId, setForYouAccountId] = useState<string | null>(null)

    // Convert to ActivityItem[] for existing feed components. Backfilled episodes (recovered from the
    // watched-bitfield) have no real per-episode time, so they are kept out of the chronological feed
    // -- they still power Replay totals/discoveries and the per-show "seen" state. The one exception
    // is imported SAVED state (bitfield-aggregate series, flagged-only movies): those rows carry no
    // watch dates at all, so they are kept for the dedicated imported group below instead of leaking
    // into the dated chronology as a phantom watch on the import date.
    const mappedHistory = useMemo(() => watchHistory.map(historyEntryToActivityItem), [watchHistory])
    const sourceHistory: ActivityItem[] = useMemo(
        () => enrichActivityItemsByIdentity(mappedHistory.filter(item => !item.backfill || item.importedSavedState)),
        [mappedHistory]
    )
    // Raw watch rows for header hours: the same rows and runtime source Metrics uses.
    const hoursSource = useMemo(() => mappedHistory.filter(item => !item.backfill), [mappedHistory])
    const history = useActivityMetadata(sourceHistory)

    // Split for presentation only: the dated chronology and day metrics see genuinely dated
    // watches, while imported saved state (no watch dates) renders in its own group. Deletion,
    // deep links and bulk flows keep operating on the full `history` list with unchanged ids.
    const datedHistory = useMemo(() => history.filter(item => !item.importedSavedState), [history])
    const importedSummaries = useMemo(() => history.filter(item => item.importedSavedState), [history])

    // Map useLibraryCache functions to original names for UI compatibility
    const fetchActivity = useCallback(async (silent = false) => {
        if (!silent) {
            refreshMedia()
            revalidate()
            await ensureLoaded(accounts)
        }
    }, [accounts, ensureLoaded, revalidate, refreshMedia])

    const [searchInput, setSearchInput] = useState('')
    const [searchTerm, setSearchTerm] = useState('')
    const searchInputRef = useRef<HTMLInputElement>(null)
    const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    const handleSearchChange = useCallback((val: string) => {
        setSearchInput(val)
        if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current)
        if (!val) {
            setSearchTerm('')
            return
        }
        searchTimeoutRef.current = setTimeout(() => {
            setSearchTerm(val)
        }, 150)
    }, [])

    useEffect(() => {
        return () => {
            if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current)
        }
    }, [])

    useEffect(() => {
        if (!liveActivity) return
        let active = true
        const tick = () => {
            if (!active || document.visibilityState !== 'visible') return
            useLibraryCache.setState({ isStale: true })
            ensureLoaded(accounts)
        }
        const scheduleNext = () => {
            const jitter = Math.floor(Math.random() * 30000)
            return setTimeout(() => {
                tick()
                timerId = scheduleNext()
            }, 60000 + jitter)
        }
        let timerId = scheduleNext()
        const onVisibility = () => { if (document.visibilityState === 'visible') tick() }
        document.addEventListener('visibilitychange', onVisibility)
        return () => {
            active = false
            clearTimeout(timerId)
            document.removeEventListener('visibilitychange', onVisibility)
        }
    }, [liveActivity, accounts, ensureLoaded])

    // Returning to the page or focusing the tab re-checks the cache: ensureLoaded
    // honours the existing TTL and coverage gates (a fresh cache is a cache hit and
    // reads nothing), with no forced invalidation behind it (Sol R1 F6/F7).
    useEffect(() => {
        const refreshIfStale = () => {
            if (document.visibilityState !== 'visible') return
            void ensureLoaded(useAccountStore.getState().accounts)
        }
        refreshIfStale()
        document.addEventListener('visibilitychange', refreshIfStale)
        window.addEventListener('focus', refreshIfStale)
        return () => {
            document.removeEventListener('visibilitychange', refreshIfStale)
            window.removeEventListener('focus', refreshIfStale)
        }
    }, [ensureLoaded])

    const [userFilter, setUserFilter] = useState(() => {
        try { return localStorage.getItem('aio-activity-user-filter') || 'all' } catch { return 'all' }
    })
    const scopedMediaIssues = mediaIssues.filter(issue => userFilter === 'all' || issue.accountId === userFilter)
    const mediaReadWarnings = scopedMediaIssues.filter(issue => issue.kind !== 'limit' && issue.kind !== 'source-count')
    const mediaHistoryLimits = scopedMediaIssues.filter(issue => issue.kind === 'limit')
    const [timeFilter, setTimeFilter] = useState(() => {
        try { return localStorage.getItem('activity-time-filter') || 'all' } catch { return 'all' }
    })
    const [customStartDate, setCustomStartDate] = useState<string>(() => {
        try { return localStorage.getItem('activity-since-date') || '' } catch { return '' }
    })
    const [viewMode, setViewMode] = useState<'grid' | 'list'>(() => {
        try {
            const saved = localStorage.getItem('activity-view-mode')
            return saved === 'list' ? 'list' : 'grid'
        } catch { return 'grid' }
    })
    const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set())
    const pendingUndoIds = usePendingUndoIds('activity')
    const runDeleteRef = useRef<(items: ActivityItem[], ids: string[], success: { title: string; description: string }) => Promise<void>>(async () => {})
    const [pendingWholeShow, setPendingWholeShow] = useState<Array<{ accountId: string; itemId: string; id: string; sourceConnectionId?: string }> | null>(null)
    const [isDeletingWholeShow, setIsDeletingWholeShow] = useState(false)
    const [isBulkMode, setIsBulkMode] = useState(false)
    const [detailItem, setDetailItem] = useState<ActivityItem | null>(null)
    const [detailModalSeen, setDetailModalSeen] = useState(false)
    useEffect(() => { if (detailItem) setDetailModalSeen(true) }, [detailItem])
    const cloudRefreshAttemptedRef = useRef(false)

    useEffect(() => {
        const handleSyncedSettings = (event: Event) => {
            const activity = (event as CustomEvent<{ activity?: ActivitySettings }>).detail?.activity
            if (!activity) return
            if (activity.timeFilter && ['all', '24h', '7d', '30d', 'since'].includes(activity.timeFilter)) {
                setTimeFilter(activity.timeFilter)
            }
            if (typeof activity.sinceDate === 'string') {
                setCustomStartDate(activity.sinceDate)
            }
            if (activity.viewMode === 'grid' || activity.viewMode === 'list') {
                setViewMode(activity.viewMode)
            }
        }

        window.addEventListener(SYNCED_SETTINGS_EVENT, handleSyncedSettings)
        return () => window.removeEventListener(SYNCED_SETTINGS_EVENT, handleSyncedSettings)
    }, [])

    useEffect(() => {
        if (accounts.length === 0) return

        // refreshFromCloud only latches watchEventsInitialized on a *successful* pull. Gate the
        // attempt to once per mount so a persistent pull failure can't re-fire this effect forever.
        const shouldRefreshEvents = Boolean(
            syncIsAuthenticated && syncId && syncPassword &&
            !watchEventsInitialized && !cloudRefreshAttemptedRef.current
        )

        let cancelled = false
        const loadActivity = async () => {
            if (shouldRefreshEvents) {
                cloudRefreshAttemptedRef.current = true
                await refreshFromCloud().catch(e => {
                    if (import.meta.env.DEV) console.error('[Activity] Failed to refresh watch history from cloud:', e)
                })
                if (cancelled) return

                const latestAccounts = useAccountStore.getState().accounts
                await ensureLoaded(latestAccounts.length > 0 ? latestAccounts : accounts)
                return
            }

            await ensureLoaded(accounts)
        }

        loadActivity().catch(e => {
            if (import.meta.env.DEV) console.error('[Activity] Failed to load watch history:', e)
        })

        return () => {
            cancelled = true
        }
    }, [accounts, ensureLoaded, refreshFromCloud, syncIsAuthenticated, syncId, syncPassword, watchEventsInitialized])

    const accountById = useMemo(() => new Map(accounts.map(account => [account.id, account])), [accounts])
    const mediaAccountName = useCallback((accountId: string) => {
        const account = accountById.get(accountId)
        if (!account) return 'Unknown account'
        const raw = account.name && !account.name.includes('@') ? account.name : getAccountEmail(account) || account.name || 'Account'
        return raw.includes('@') ? (maskEmailLevel(raw, emailPrivacyLevel) || raw) : maskNameLevel(raw, privacyLevel)
    }, [accountById, privacyLevel, emailPrivacyLevel])
    const canonicalConnections = useMemo(() => canonicalStremioConnections(accounts), [accounts])

    const accountOptions = useMemo(() => accounts.map((account, index) => ({
        id: account.id,
        name: account.name || getAccountEmail(account)?.split('@')[0] || account.id || 'Unknown',
        colorIndex: index % 10,
        emoji: account.emoji,
        avatar: account.avatar,
    })), [accounts])

    const searchNeedle = useMemo(() => searchTerm.toLowerCase(), [searchTerm])
    const matchesAccountAndSearch = useCallback((item: ActivityItem) => {
        if (userFilter !== 'all' && item.accountId !== userFilter) return false
        if (!searchTerm.trim()) return true
        return activitySearchHaystack(item, getCachedCinemetaName).includes(searchNeedle)
    }, [userFilter, searchTerm, searchNeedle])

    const filteredHistory = useMemo(() => {
        const now = new Date().getTime()
        const oneDay = 24 * 60 * 60 * 1000
        const sevenDays = 7 * oneDay
        const thirtyDays = 30 * oneDay

        return datedHistory.filter(item => {
            if (pendingUndoIds.has(item.id)) return false
            if (!matchesAccountAndSearch(item)) return false
            const itemTime = activityItemTimeMs(item)
            if (timeFilter === '24h' && now - itemTime > oneDay) return false
            if (timeFilter === '7d' && now - itemTime > sevenDays) return false
            if (timeFilter === '30d' && now - itemTime > thirtyDays) return false
            if (timeFilter === 'since' && customStartDate) {
                const sinceTime = new Date(customStartDate).getTime()
                if (itemTime < sinceTime) return false
            }

            return true
        })
    }, [datedHistory, matchesAccountAndSearch, timeFilter, customStartDate, pendingUndoIds])

    // The imported group follows the same account/search filters, but never the time filters:
    // those describe watch dates, and saved state deliberately has none.
    const importedSummaryItems = useMemo(() => {
        if (timeFilter !== 'all') return []
        return importedSummaries.filter(item => !pendingUndoIds.has(item.id) && matchesAccountAndSearch(item))
    }, [importedSummaries, matchesAccountAndSearch, timeFilter, pendingUndoIds])

    const handleUserFilterChange = useCallback((id: string) => {
        setUserFilter(id)
        try { localStorage.setItem('aio-activity-user-filter', id) } catch {}
    }, [])

    useEffect(() => {
        if (userFilter !== 'all' && !accountOptions.some(o => o.id === userFilter)) {
            handleUserFilterChange('all')
        }
    }, [accountOptions, userFilter, handleUserFilterChange])

    const hoursScope = useMemo(
        () => userFilter === 'all' && !searchTerm.trim() ? undefined : new Set(datedHistory.filter(matchesAccountAndSearch).map(item => item.id)),
        [datedHistory, userFilter, searchTerm, matchesAccountAndSearch],
    )

    const rollups = useWatchEventStore(s => s.rollups)
    const headerRollupMinutes = useMemo(
        () => (timeFilter === 'all' && !searchTerm.trim() ? rollupMinutes(rollups, userFilter) : 0),
        [rollups, userFilter, timeFilter, searchTerm],
    )

    const handleViewModeChange = useCallback((mode: 'grid' | 'list') => {
        setViewMode(mode)
        try { localStorage.setItem('activity-view-mode', mode) } catch {}
        triggerSync()
    }, [])


    const handleToggleSelect = useCallback((itemId: string | string[]) => {
        const mutable = new Set(history.filter(item => !isReadOnlyMediaActivity(item)).map(item => item.id))
        const ids = (Array.isArray(itemId) ? itemId : [itemId]).filter(id => mutable.has(id))
        setSelectedItems(prev => {
            const newSet = new Set(prev)
            const allSelected = ids.every(id => newSet.has(id))
            if (allSelected) {
                ids.forEach(id => newSet.delete(id))
            } else {
                ids.forEach(id => newSet.add(id))
            }
            return newSet
        })
    }, [history])

    const handleSelectAll = useCallback(() => {
        setSelectedItems(new Set(filteredHistory.filter(item => !isReadOnlyMediaActivity(item)).map((item: ActivityItem) => item.id)))
    }, [filteredHistory])

    const handleDeselectAll = useCallback(() => {
        setSelectedItems(new Set())
        setIsBulkMode(false)
    }, [])

    const handleFeedToggleSelect = useCallback((id: string | string[]) => {
        handleToggleSelect(id)
        setIsBulkMode(true)
    }, [handleToggleSelect])

    const scheduleActivityDelete = useCallback((ids: string[], bulk: boolean) => {
        const idSet = new Set(ids)
        const items = history.filter(item => idSet.has(item.id))
        if (items.length === 0) return
        const count = items.length
        const previousSelection = bulk ? new Set(selectedItems) : null
        const summary = originTargetsSummary(items, accountById, privacyLevel, emailPrivacyLevel)
        const mediaTargets = new Set(items.flatMap(item => (item.mediaTargets || []).map(target => `${item.accountId}|${target.connectionId}|${target.itemId}`))).size
        const notes = [
            summary ? `From ${summary.text}${summary.count > 1 ? ` (${summary.count} logins)` : ''}.` : '',
            mediaTargets > 0 ? `Also clears watched state on ${mediaTargets} media-server ${mediaTargets === 1 ? 'target' : 'targets'}.` : '',
            includesWholeShowSeriesDelete(items) ? 'Series deletes remove the whole show history.' : '',
        ].filter(Boolean)
        scheduleUndoable({
            scope: 'activity',
            ids,
            title: count > 1 ? `Deleting ${count} items` : 'Deleting 1 item',
            description: notes.join(' ') || undefined,
            commit: () => runDeleteRef.current(items, ids, bulk
                ? { title: 'Items Deleted', description: `${count} item(s) removed from history.` }
                : { title: count > 1 ? 'Episodes Deleted' : 'Item Deleted', description: 'Removed from activity history.' }),
            onUndo: () => { if (previousSelection) setSelectedItems(previousSelection) },
        })
    }, [history, selectedItems, accountById, privacyLevel, emailPrivacyLevel])

    const handleFeedDelete = useCallback((id: string | string[]) => {
        const ids = Array.isArray(id) ? id : [id]
        const mutable = new Set(history.filter(item => !isReadOnlyMediaActivity(item)).map(item => item.id))
        const allowed = ids.filter(itemId => mutable.has(itemId))
        if (allowed.length) scheduleActivityDelete(allowed, false)
    }, [history, scheduleActivityDelete])

    const handleOpenDetail = useCallback((item: ActivityItem) => {
        setDetailItem(item)
    }, [])

    // Deep-link sync with the detail modal's URL params. Opening the modal
    // pushes ?detail=… (handled inside ActivityDetailModal); this covers the
    // other direction: entering /activity with ?detail=… opens the modal
    // (deep link / refresh), and browser Back removing the params closes it.
    // While the modal is open we never swap detailItem from here — in-modal
    // navigation (person/episode/filmography) belongs to the modal's navStack.
    // If two accounts watched the same itemId the first history match wins,
    // and a cold-load fallback item is not retro-upgraded once history loads.
    const [searchParams] = useSearchParams()
    const detailParamId = searchParams.get('detail')

    // The modal writes ?detail= a couple of async effect rounds after the tap.
    // Identity-only re-runs in that window (history refresh, unrelated param
    // churn) still see no param; nulling detailItem there flipped open off
    // mid-entrance and the sheet remounted with a second entrance animation.
    // Only a real set -> null transition (browser Back removing ?detail) closes.
    const prevDetailParamRef = useRef<string | null>(null)
    useEffect(() => {
        const hadParam = prevDetailParamRef.current
        prevDetailParamRef.current = detailParamId
        if (!detailParamId) {
            if (hadParam !== null) setDetailItem(null)
            return
        }
        setDetailItem(prev => {
            if (prev) return prev
            return history.find(h => h.itemId === detailParamId) ?? detailItemFromUrlParams(detailParamId, searchParams.get('type'))
        })
    }, [detailParamId, history, searchParams])

    const deletePlatformItems = useCallback(async (items: ActivityItem[]): Promise<{ failed: boolean; keptIds: Set<string>; keptReasons: Map<string, number>; noVideos: Array<{ accountId: string; itemId: string; id: string; sourceConnectionId?: string }> }> => {
        if (items.length === 0) return { failed: false, keptIds: new Set<string>(), keptReasons: new Map<string, number>(), noVideos: [] }
        const byAccount: Record<string, ActivityItem[]> = {}
        for (const item of items) {
            if (isReadOnlyMediaActivity(item)) continue
            (byAccount[item.accountId] ||= []).push(item)
        }
        const keptIds = new Set<string>(items.filter(isReadOnlyMediaActivity).map(item => item.id))
        const keptReasons = new Map<string, number>()
        if (keptIds.size) keptReasons.set('This source does not support deleting history.', keptIds.size)
        const noVideos: Array<{ accountId: string; itemId: string; id: string; sourceConnectionId?: string }> = []
        const countKeep = (reason: string, n: number = 1) => keptReasons.set(reason, (keptReasons.get(reason) || 0) + n)
        let failed = false
        await mapConcurrent(Object.entries(byAccount), ACTIVITY_ACCOUNT_DELETE_CONCURRENCY, async ([accountId, accItems]) => {
            const account = accountById.get(accountId)
            if (!account) {
                for (const item of accItems) keptIds.add(item.id)
                countKeep('account-error', accItems.length)
                failed = true
                return
            }

            const mediaItems = accItems.filter(item => item.source === 'jellyfin' || item.mediaTargets?.length)
            if (mediaItems.length) {
                const key = useAuthStore.getState().encryptionKey
                const mediaKept = key
                    ? await deleteJellyfinWatchItems(account, mediaItems, value => decrypt(value, key))
                    : new Set(mediaItems.map(item => item.id))
                if (mediaKept.size) {
                    for (const id of mediaKept) keptIds.add(id)
                    countKeep('media-error', mediaKept.size)
                    failed = true
                }
            }
            if (!hasPlatformConnection(account)) return

            const nuvioItems = accItems.filter(i => !keptIds.has(i.id) && i.source === 'nuvio')
            const realstreamItems = accItems.filter(i => !keptIds.has(i.id) && i.source === 'realstream')
            const stremioItems = accItems.filter(i => !keptIds.has(i.id) && !isReadOnlyMediaActivity(i) && i.source !== 'jellyfin' && i.source !== 'nuvio' && i.source !== 'realstream')

            if (stremioItems.length > 0) {
                const { encryptionKey } = useAuthStore.getState()
                // Group by exact remote origin: attributed items resolve their own
                // connection's sealed key; unattributed (legacy) rows keep the canonical
                // route. A secondary whose connection is gone is KEPT, never re-routed
                // through the canonical login's key (that would delete the wrong user's copy).
                const groups = new Map<string, { connectionId?: string; sealedKey?: string; ctx: string; items: ActivityItem[] }>()
                for (const item of stremioItems) {
                    const target = resolveStremioDeleteTarget(account, item)
                    if (!target.sealedKey) {
                        keptIds.add(item.id)
                        countKeep(item.sourceConnectionId ? 'connection-missing' : 'no-auth-key')
                        failed = true
                        trace('activityDelete', 'stremio.item.kept', { accountId, itemId: item.itemId, connectionId: item.sourceConnectionId, reason: item.sourceConnectionId ? 'connection-missing' : 'no-auth-key' })
                        continue
                    }
                    const groupKey = item.sourceConnectionId ?? ''
                    const existing = groups.get(groupKey)
                    if (existing) existing.items.push(item)
                    else groups.set(groupKey, { connectionId: item.sourceConnectionId, sealedKey: target.sealedKey, ctx: target.ctx, items: [item] })
                }
                for (const group of groups.values()) {
                    const gAuthKey = encryptionKey ? await decrypt(group.sealedKey!, encryptionKey).catch(() => null) : null
                    if (!encryptionKey || !gAuthKey) {
                        trace('activityDelete', 'stremio.account.skipped', { accountId, connectionId: group.connectionId, items: group.items.length, reason: encryptionKey ? 'no-auth-key' : 'locked' })
                        for (const item of group.items) keptIds.add(item.id)
                        countKeep('account-error', group.items.length)
                        failed = true
                        continue
                    }
                    try {
                        const authKey = gAuthKey
                        const ctx = group.ctx

                        const episodeItems = group.items.filter(i => isEpisodeScopedDelete(i))
                        const rowsById = new Map<string, LibraryItem>()
                        let rowsFetchFailed = false
                        if (episodeItems.length > 0) {
                            const rowIds = Array.from(new Set(episodeItems.map(i => i.itemId)))
                            try {
                                for (const row of await stremioClient.getLibraryItemsByIds(authKey, rowIds, ctx)) {
                                    rowsById.set(row._id, row)
                                }
                            } catch (e) {
                                // A failed rows fetch must not degrade into destructive per-item fallbacks.
                                rowsFetchFailed = true
                                trace('activityDelete', 'stremio.rows.error', { accountId, connectionId: group.connectionId, rows: rowIds.length, error: (e as Error)?.message })
                                for (const item of episodeItems) keptIds.add(item.id)
                                countKeep('rows-unavailable', episodeItems.length)
                                failed = true
                            }
                        }

                        const showLocks = new Map<string, Promise<unknown>>()
                        const touchedShows = new Set<string>()
                        const withShowLock = (itemId: string, fn: () => Promise<void>): Promise<void> => {
                            const prev = showLocks.get(itemId) ?? Promise.resolve()
                            const next = prev.catch(() => {}).then(fn)
                            showLocks.set(itemId, next)
                            return next
                        }

                        await mapConcurrent(group.items, ACTIVITY_ITEM_DELETE_CONCURRENCY, async (item) => {
                            const wholeShowDelete = async () => {
                                await stremioClient.removeLibraryItem(authKey, item.itemId, ctx)
                                trace('activityDelete', 'stremio.item.ok', { accountId, connectionId: group.connectionId, itemId: item.itemId, mode: 'whole-show' })
                            }
                            try {
                                // Movies (even with season 0/episode 0) and rows without real
                                // episode coordinates have no per-episode state to edit.
                                if (!isEpisodeScopedDelete(item)) {
                                    await withShowLock(item.itemId, wholeShowDelete)
                                    return
                                }
                                if (rowsFetchFailed) return
                                // A part-watched episode is the row's only watch state — removing
                                // the row IS the episode delete.
                                if (isBareAnchoredEpisode(rowsById.get(item.itemId), item.uniqueItemId)) {
                                    await withShowLock(item.itemId, wholeShowDelete)
                                    return
                                }
                                const target = { uniqueItemId: item.uniqueItemId, season: item.season, episode: item.episode }
                                await withShowLock(item.itemId, async () => {
                                    const plan = await planEpisodeBitfieldDelete({
                                        itemId: item.itemId,
                                        row: rowsById.get(item.itemId),
                                        videos: await fetchSeriesVideos(item.itemId),
                                        target,
                                    })
                                    if (plan.kind === 'fail') {
                                        // Transient/structural failures must never escalate to whole-show deletion.
                                        keptIds.add(item.id)
                                        countKeep(plan.reason)
                                        failed = true
                                        if (plan.reason === 'no-videos') noVideos.push({ accountId, itemId: item.itemId, id: item.id, sourceConnectionId: group.connectionId })
                                        trace('activityDelete', 'stremio.item.kept', { accountId, connectionId: group.connectionId, itemId: item.itemId, reason: plan.reason })
                                        return
                                    }
                                    if (plan.kind === 'skip') {
                                        trace('activityDelete', 'stremio.item.skip', { accountId, connectionId: group.connectionId, itemId: item.itemId, reason: 'nothing-remote' })
                                        return
                                    }
                                    if (plan.kind === 'remove-row') {
                                        await wholeShowDelete()
                                        return
                                    }
                                    await stremioClient.upsertLibraryItem(authKey, plan.rewritten, ctx)
                                    rowsById.set(item.itemId, plan.rewritten)
                                    touchedShows.add(item.itemId)
                                    // The rewrite preserves the row mtime, so the watcher inference
                                    // would otherwise read the repointed anchor as a fresh watch.
                                    useWatchEventStore.getState().patchSnapshot(accountId, item.itemId, {
                                        mtime: new Date(plan.rewritten._mtime || '').getTime() || 0,
                                        video_id: plan.rewritten.state?.video_id,
                                        season: plan.rewritten.state?.season,
                                        episode: plan.rewritten.state?.episode,
                                    }, group.connectionId ? { contextKey: ctx } : undefined)
                                    trace('activityDelete', 'stremio.item.ok', { accountId, connectionId: group.connectionId, itemId: item.itemId, mode: 'per-episode', season: item.season, episode: item.episode, remaining: plan.rewritten.state?.timesWatched })
                                })
                            } catch (e) {
                                if (import.meta.env.DEV) console.error(`Failed to remove ${item.itemId}:`, e)
                                trace('activityDelete', 'stremio.item.error', { accountId, connectionId: group.connectionId, itemId: item.itemId, error: (e as Error)?.message })
                                keptIds.add(item.id)
                                countKeep('item-error')
                                failed = true
                            }
                        })
                        if (touchedShows.size > 0) {
                            useLibraryCache.getState().dropMetaRows(ctx, Array.from(touchedShows))
                        }
                        trace('activityDelete', 'stremio.account.done', { accountId, connectionId: group.connectionId, items: group.items.length })
                    } catch (e) {
                        if (import.meta.env.DEV) console.error(`Failed to process deletions for account ${accountId}:`, e)
                        trace('activityDelete', 'stremio.account.error', { accountId, connectionId: group.connectionId, items: group.items.length, error: (e as Error)?.message })
                        for (const item of group.items) keptIds.add(item.id)
                        countKeep('account-error', group.items.length)
                        failed = true
                    }
                }
            }

            if (nuvioItems.length > 0) {
                trace('activityDelete', 'nuvio.account.start', { accountId, items: nuvioItems.length })
                const outcome = await deleteNuvioWatchItems(account, nuvioItems)
                trace('activityDelete', 'nuvio.account.done', { accountId, items: nuvioItems.length, ok: outcome.ok, kept: outcome.keptItems.length })
                if (!outcome.ok || outcome.keptItems.length > 0) {
                    failed = failed || !outcome.ok
                    countKeep(outcome.ok ? 'ambiguous-origin' : 'platform-error', outcome.keptItems.length)
                    for (const item of outcome.keptItems) keptIds.add(item.id)
                }
            }

            if (realstreamItems.length > 0) {
                trace('activityDelete', 'realstream.account.start', { accountId, items: realstreamItems.length })
                const outcome = await deleteRealStreamWatchItems(account, realstreamItems)
                trace('activityDelete', 'realstream.account.done', { accountId, items: realstreamItems.length, ok: outcome.ok, kept: outcome.keptItems.length })
                if (!outcome.ok || outcome.keptItems.length > 0) {
                    failed = failed || !outcome.ok
                    countKeep(outcome.ok ? 'ambiguous-origin' : 'platform-error', outcome.keptItems.length)
                    for (const item of outcome.keptItems) keptIds.add(item.id)
                }
            }
        })
        return { failed, keptIds, keptReasons, noVideos }
    }, [accountById])

    const KEEP_REASON_LABELS: Record<string, string> = {
        'no-videos': 'episode list unavailable',
        'no-bitfield': 'no per-episode data to edit',
        'anchor-mismatch': "the show's episode data changed since watching",
        'non-tt': 'anime titles can only be deleted as a whole show',
        'rows-unavailable': 'watch history rows unavailable',
        'account-error': 'account sync error',
        'item-error': 'Stremio API error',
        'connection-missing': 'the login this watch came from was removed; reconnect it to delete its history',
        'platform-error': 'platform sync error',
        'media-error': 'media-server watched state or progress could not be cleared; check the connection and retry',
    }

    const keptReasonSummary = (keptReasons: Map<string, number>): string => {
        if (keptReasons.size === 0) return ''
        const parts = Array.from(keptReasons.entries())
            .map(([reason, n]) => `${n} ${KEEP_REASON_LABELS[reason] || reason}${n > 1 ? 's' : ''}`)
        return ` (${parts.join(', ')})`
    }

    const purgeLocalActivity = useCallback((items: ActivityItem[], feedIds: string[]) => {
        const liveIds = new Set<string>(feedIds)
        // Canonical-origin items carry attribution for exact-key deletes, but their
        // events/snapshot live under the LEGACY bare scope — strip the connection from
        // the local-drop payload so tombstones hit the identities those events use.
        const normalized = items.map(i => {
            if (!i.sourceConnectionId) return i
            const owner = accountById.get(i.accountId)
            const canonicalId = owner ? getStremioConnection(owner)?.id : undefined
            return canonicalId && i.sourceConnectionId === canonicalId ? { ...i, sourceConnectionId: undefined } : i
        })
        for (const i of normalized) {
            const cacheId = i.sourceConnectionId
                ? `${i.accountId}:${i.source || 'stremio'}:${i.sourceConnectionId}:${i.uniqueItemId}`
                : i.source === 'nuvio' ? `${i.accountId}:nuvio:${i.uniqueItemId}`
                : i.source === 'realstream' ? `${i.accountId}:realstream:${i.uniqueItemId}`
                : `${i.accountId}:${i.uniqueItemId}`
            liveIds.add(cacheId)
        }
        removeItems(Array.from(liveIds))
        useWatchEventStore.getState().removeEvents(normalized)
        for (const target of mediaDeleteTargets(items)) refreshJellyfinMedia(target.accountId, target.connectionId)
    }, [accountById, removeItems])

    const runActivityDelete = async (items: ActivityItem[], ids: string[], success: { title: string; description: string }) => {
        const { failed, keptIds, keptReasons, noVideos } = await deletePlatformItems(items)
        purgeLocalActivity(items.filter(item => !keptIds.has(item.id)), ids.filter(id => !keptIds.has(id)))

        if (noVideos.length > 0) {
            setPendingWholeShow(noVideos)
            return
        }

        if (hasPendingRemoteDelete({ failed, keptIds })) {
            toast({ variant: 'destructive', title: 'Partial Deletion', description: `Some items could not be removed from their source platforms and are still in your history. Select them and delete again to retry.${keptReasonSummary(keptReasons)}` })
        } else {
            toast(success)
        }
    }

    useEffect(() => {
        runDeleteRef.current = runActivityDelete
    })

    const handleDeleteSelected = () => {
        if (selectedItems.size === 0) return
        const ids = Array.from(selectedItems)
        setSelectedItems(new Set())
        scheduleActivityDelete(ids, true)
    }

    const handleDeleteWholeShows = async () => {
        if (!pendingWholeShow || pendingWholeShow.length === 0) {
            setPendingWholeShow(null)
            return
        }
        setIsDeletingWholeShow(true)
        try {
            const { encryptionKey } = useAuthStore.getState()
            const deleted: Array<{ accountId: string; itemId: string; id: string; sourceConnectionId?: string }> = []
            const byAccount: Record<string, typeof pendingWholeShow> = {}
            for (const entry of pendingWholeShow) {
                (byAccount[entry.accountId] ||= []).push(entry)
            }
            await mapConcurrent(Object.entries(byAccount), ACTIVITY_ACCOUNT_DELETE_CONCURRENCY, async ([accountId, entries]) => {
                const account = accountById.get(accountId)
                if (!account || !encryptionKey) return
                // Whole-show deletes resolve the same per-origin keys as item deletes: the
                // entry's own connection when attributed, the canonical login otherwise.
                for (const entry of entries) {
                    const sealedKey = resolveStremioDeleteTarget(account, entry).sealedKey
                    if (!sealedKey) continue
                    try {
                        const authKey = await decrypt(sealedKey, encryptionKey)
                        const ctx = entry.sourceConnectionId ? watchContextKey(accountId, entry.sourceConnectionId) : accountId
                        await stremioClient.removeLibraryItem(authKey, entry.itemId, ctx)
                        deleted.push(entry)
                    } catch {
                        // A failed whole-show removal leaves the entry in history for a retry.
                    }
                }
            })
            if (deleted.length > 0) {
                purgeLocalActivity(deleted.map(entry => history.find(h => h.id === entry.id)).filter((h): h is ActivityItem => !!h), deleted.map(entry => entry.id))
                toast({ title: 'Shows Deleted', description: `${deleted.length} show(s) removed from Stremio and history.` })
            } else {
                toast({ variant: 'destructive', title: 'Delete failed', description: 'The shows could not be removed from Stremio. Try again later.' })
            }
            setPendingWholeShow(null)
        } finally {
            setIsDeletingWholeShow(false)
        }
    }

    const isSelecting = selectedItems.size > 0 || isBulkMode
    const isLoading = loading || isRefreshingFromCloud
    const historySettled = useSettledOnce(watchHistory, isLoading || mediaSettling || !watchEventsInitialized, { maxWaitMs: 20000 })
    // Refresh the current feed in place. These are the live, scoped hook
    // results, so removals and account changes still take effect immediately.
    const showFeedSkeleton = isLoading && history.length === 0 && inProgress.length === 0

    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            const el = document.activeElement as HTMLElement
            const isInput = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
            if (e.key === '/' && !isSelecting && !isInput) {
                e.preventDefault()
                searchInputRef.current?.focus()
            }
            if (e.key === 'Escape' && isSelecting && !isInput) {
                handleDeselectAll()
            }
        }
        document.addEventListener('keydown', handler)
        return () => document.removeEventListener('keydown', handler)
    }, [isSelecting, handleDeselectAll])

    return (
        <div className="space-y-6 overflow-x-hidden">
            <Tabs value={activeView} onValueChange={(v) => { setActiveView(v as 'feed' | 'foryou'); setForYouAccountId(null) }}>
                <TabsList>
                    <TabsTrigger value="feed" className="h-8 px-4 text-xs">
                        Activity Feed
                    </TabsTrigger>
                    <TabsTrigger value="foryou" className="h-8 px-4 text-xs">
                        For You
                    </TabsTrigger>
                </TabsList>
            </Tabs>
            {activeView === 'foryou' && (
                <div className={forYouAccountId ? 'hidden' : undefined}>
                    <ForYouPage onAccountClick={(id) => setForYouAccountId(id)} />
                </div>
            )}
            {activeView === 'foryou' && forYouAccountId && (
                <AccountDetailPage
                    accountId={forYouAccountId}
                    onBack={() => setForYouAccountId(null)}
                />
            )}
            {activeView === 'feed' && (
            <>
            {/* Single unified toolbar */}
            <ToolbarShell contentClassName="gap-2 sm:gap-3">
                {/* Search */}
                <div className="relative w-full sm:w-80 shrink-0 min-w-0">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                    <Input
                        ref={searchInputRef}
                        placeholder="Search history..."
                        value={searchInput}
                        onChange={(e) => handleSearchChange(e.target.value)}
                        className="pl-9 pr-9 h-8 py-0 text-xs bg-muted/30 border border-border/40 focus:bg-muted/40 transition-colors w-full"
                        data-search-focus
                    />
                    {searchInput && (
                        <button
                            data-theme-part="button"
                            onClick={() => handleSearchChange('')}
                            className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 hover:bg-accent rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            aria-label="Clear search"
                        >
                            <X className="h-3.5 w-3.5 text-muted-foreground" />
                        </button>
                    )}
                </div>

                {/* Filters - Left aligned to match search */}
                <div className={cn(
                    "grid w-full gap-2 sm:flex sm:flex-1 sm:flex-wrap sm:items-center sm:min-w-0",
                    accountOptions.length > 1 ? "grid-cols-2" : "grid-cols-1"
                )}>
                    {accountOptions.length > 1 && (
                        <AccountSwitcher
                            mode="filter"
                            accounts={accountOptions}
                            selectedId={userFilter}
                            onSelect={handleUserFilterChange}
                            allLabel="All Users"
                            placeholder="Search users..."
                            buttonClassName="inline-flex h-8 w-full items-center justify-center gap-1.5 whitespace-nowrap rounded-xl border border-border/40 bg-muted/30 px-3 text-xs font-medium shadow-sm transition-colors hover:bg-muted/50 hover:text-foreground"
                        />
                    )}

                    <Select value={timeFilter} onValueChange={(val) => {
                        setTimeFilter(val)
                        try { localStorage.setItem('activity-time-filter', val) } catch {}
                        triggerSync()
                    }}>
                        <SelectTrigger className="h-8 w-full sm:w-[120px] text-xs font-medium">
                            <SelectValue placeholder="All Time" />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">All Time</SelectItem>
                            <SelectItem value="24h">Last 24 Hours</SelectItem>
                            <SelectItem value="7d">Last 7 Days</SelectItem>
                            <SelectItem value="30d">Last 30 Days</SelectItem>
                            <SelectItem value="since">Since…</SelectItem>
                        </SelectContent>
                    </Select>

                    {timeFilter === 'since' && (
                        <Input
                            type="date"
                            value={customStartDate}
                            onChange={(e) => {
                                setCustomStartDate(e.target.value)
                                try { localStorage.setItem('activity-since-date', e.target.value) } catch {}
                                triggerSync()
                            }}
                            className="col-span-full h-8 w-full sm:w-[150px] text-xs font-medium"
                        />
                    )}
                </div>

                {/* Actions - pushed to right */}
                <div className="grid w-full grid-cols-[1fr_1fr_auto] items-center gap-2 sm:ml-auto sm:flex sm:w-auto sm:justify-end shrink-0">
                    <Button
                    variant="outline"
                    size="sm"
                    onClick={() => fetchActivity()}
                        disabled={isLoading}
                        className="w-full text-xs font-medium gap-1.5 sm:w-auto"
                    >
                        <AnimatedRefreshIcon className="h-3.5 w-3.5" isAnimating={isLoading} />
                        Refresh
                    </Button>

                    <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                        if (isBulkMode || selectedItems.size > 0) handleDeselectAll()
                        else setIsBulkMode(true)
                        }}
                        className="w-full text-xs font-medium gap-1.5 sm:w-auto"
                    >
                        {isSelecting ? <X className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />}
                        {isSelecting ? 'Cancel' : 'Select'}
                    </Button>

                    {/* Grid / List toggle */}
                    <div data-theme-part="tabs-list" className="flex items-center bg-muted/50 rounded-lg p-0.5 border border-border/40 gap-0.5 shrink-0">
                        <Tooltip content="Grid view" side="bottom">
                        <Button
                            variant="ghost"
                            size="sm"
                            data-theme-part="tab"
                            data-state={viewMode === 'grid' ? 'active' : 'inactive'}
                            onClick={() => handleViewModeChange('grid')}
                            className={cn(
                                'h-8 w-8 rounded-lg p-0',
                                viewMode === 'grid'
                                    ? 'bg-background shadow-sm text-foreground'
                                    : 'text-muted-foreground hover:text-foreground'
                            )}
                            aria-label="Grid view"
                        >
                            <Grid className="h-3.5 w-3.5" />
                        </Button>
                        </Tooltip>
                        <Tooltip content="List view" side="bottom">
                        <Button
                            variant="ghost"
                            size="sm"
                            data-theme-part="tab"
                            data-state={viewMode === 'list' ? 'active' : 'inactive'}
                            onClick={() => handleViewModeChange('list')}
                            className={cn(
                                'h-8 w-8 rounded-lg p-0',
                                viewMode === 'list'
                                    ? 'bg-background shadow-sm text-foreground'
                                    : 'text-muted-foreground hover:text-foreground'
                            )}
                            aria-label="List view"
                        >
                            <List className="h-3.5 w-3.5" />
                        </Button>
                        </Tooltip>
                    </div>
                </div>
            </ToolbarShell>
            {isLoading && (
                <OperationProgress
                    status="running"
                    current={loadingProgress.current}
                    total={loadingProgress.total}
                    label={loadingProgress.current > 0
                        ? `Syncing ${loadingProgress.current} of ${loadingProgress.total} accounts`
                        : 'Connecting...'}
                    detail={loadingProgress.current > 0
                        ? `${loadingProgress.total - loadingProgress.current} remaining`
                        : 'Fetching watch history'}
                    className="mt-2"
                />
            )}

            {/* Continue Watching Rail */}
            <MediaReadBanner issues={mediaReadWarnings} accountName={mediaAccountName} onRetry={refreshMedia} />
            {[
                { title: 'Activity history limits', issues: mediaHistoryLimits },
            ].filter(group => group.issues.length > 0).map(group => (
                <details key={group.title} data-theme-part="panel" className="rounded-xl border border-border/40 bg-card p-3 text-xs text-muted-foreground">
                    <summary className="cursor-pointer font-medium">{group.title}</summary>
                    <ul className="mt-2 space-y-1.5">
                        {group.issues.map(issue => (
                            <li key={`${issue.accountId}:${issue.connectionId}:${issue.label}`}><span className="font-medium text-foreground">{issue.productName} · {issue.label}:</span> {issue.message}</li>
                        ))}
                    </ul>
                </details>
            ))}
            {(() => {
              // Per-origin dismissal: the key carries the connection scope so removing
              // one login's copy never hides a sibling's copy of the same title.
              const filteredInProgress = continueWatchingRail(inProgress, userFilter,
                item => dismissedContinueWatching.includes(`${watchContextKey(item.accountId, item.sourceConnectionId)}:${item.itemId}`))
              if (filteredInProgress.length === 0 || searchTerm) return null
              const filterAccount = userFilter !== 'all' ? accountById.get(userFilter) : undefined
              return (
                <ContentRail
                    title="Continue Watching"
                    titleAccessory={filterAccount && (
                        <span className="inline-flex min-w-0 items-center gap-1.5 font-medium text-muted-foreground">
                            <span aria-hidden>·</span>
                            <AccountAvatar account={filterAccount} size="xs" showStatus={false} className="h-6 w-6 md:h-7 md:w-7" />
                            <span className="truncate">{mediaAccountName(filterAccount.id)}</span>
                        </span>
                    )}
                    subtitle="Latest saved progress and reported playback from connected platforms."
                    scrollAmount={512}
                    count={Math.min(filteredInProgress.length, CONTINUE_WATCHING_LIMIT)}
                    countLabel={filteredInProgress.length > CONTINUE_WATCHING_LIMIT ? `of ${filteredInProgress.length} in progress` : 'in progress'}
                >
                            {filteredInProgress.slice(0, CONTINUE_WATCHING_LIMIT).map((item, i) => {
                                const account = accountById.get(item.accountId)
                                const rawPeer = account ? peerLoginLabel(account, item.sourceConnectionId) : null
                                return (
                                    <UpNextCard
                                        key={item.id}
                                        item={item}
                                        account={account}
                                        index={i}
                                        watcherName={account ? mediaAccountName(account.id) : undefined}
                                        peerLabel={rawPeer ? (rawPeer.includes('@') ? maskEmailLevel(rawPeer, emailPrivacyLevel) : maskNameLevel(rawPeer, privacyLevel)) : null}
                                        onOpen={() => setDetailItem(item)}
                                        onDismiss={() => useDiscoveryStore.getState().dismissItem(CONTINUE_WATCHING_CONTEXT, `${watchContextKey(item.accountId, item.sourceConnectionId)}:${item.itemId}`)}
                                    />
                                )
                            })}
                </ContentRail>
              )
            })()}

            {showFeedSkeleton ? (
                <div className="space-y-3">
                    {Array.from({ length: 6 }).map((_, i) => (
                        <ActivityItemSkeleton key={i} />
                    ))}
                </div>
            ) : (
                <ActivityFeed
                    history={filteredHistory}
                    allHistory={history}
                    hoursSource={hoursSource}
                    rollupMinutes={headerRollupMinutes}
                    importedSummaries={importedSummaryItems}
                    settling={!historySettled}
                    refreshing={isLoading}
                    filterKey={`${userFilter}|${timeFilter}|${customStartDate}|${searchTerm}`}
                    canonicalConnections={canonicalConnections}
                    currentActivity={inProgress}
                    viewMode={viewMode}
                    hoursScope={hoursScope}
                    selectedItems={selectedItems}
                    isBulkMode={isBulkMode}
                    onToggleSelect={handleFeedToggleSelect}
                    onDelete={handleFeedDelete}
                    onOpenDetail={handleOpenDetail}
                    onRefresh={() => fetchActivity()}
                />
            )}

            {detailModalSeen && (
            <Suspense fallback={null}>
            <ActivityDetailModal
                open={detailItem !== null}
                onOpenChange={(open: boolean) => { if (!open) setDetailItem(null) }}
                item={detailItem}
                watchHistory={watchHistory}
            />
            </Suspense>
            )}

            <ConfirmationDialog
                open={!!pendingWholeShow}
                onOpenChange={(open) => { if (!open && !isDeletingWholeShow) setPendingWholeShow(null) }}
                title="Delete entire shows instead?"
                description={`${pendingWholeShow?.length ?? 0} item(s) could not be deleted per-episode because their show's episode list is unavailable. Delete the ENTIRE show from Stremio instead? Every episode of each show will be removed from Stremio and history. This cannot be undone.`}
                confirmText="Delete entire shows"
                isDestructive
                isLoading={isDeletingWholeShow}
                onConfirm={() => { void handleDeleteWholeShows() }}
            />

            {/* Floating Action Bar for Bulk Deletion */}
            <FloatingActionBar
                open={selectedItems.size > 0}
                selectedCount={selectedItems.size}
                totalCount={filteredHistory.length}
                onClearSelection={handleDeselectAll}
                actions={[
                    {
                        label: 'Select All',
                        onClick: handleSelectAll,
                        variant: 'outline',
                        icon: <Check className="h-4 w-4" />,
                        disabled: selectedItems.size === filteredHistory.length,
                        tooltip: 'Select all items',
                    },
                    {
                        label: 'Delete History',
                        onClick: handleDeleteSelected,
                        variant: 'destructive',
                        icon: <AnimatedTrashIcon className="h-4 w-4" />,
                        tooltip: 'Delete selected items',
                    },
                ]}
            />

            </>
            )}
        </div >
    )
}
