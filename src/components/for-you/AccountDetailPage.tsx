import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Info, Sparkles, Bookmark, LayoutGrid, RefreshCw, Upload } from 'lucide-react'
import { useWatchHistory } from '@/hooks/useWatchHistory'
import { historyEntryToActivityItem } from '@/lib/activity-utils'
import { cn, formatStaleAgo, loadImdbTmdbCache } from '@/lib/utils'
import { buildTasteProfile } from '@/lib/taste-profile'
import { useExternalRatings } from '@/lib/external-ratings-store'
import { useRailSize } from '@/lib/discovery-prefs-store'
import { useDiscoveryPrefs, HOUSEHOLD_CONTEXT } from '@/store/discoveryStore'
import {
    buildRecommendations,
    buildColdStartRails,
    type SeedItem,
    type RankedRail,
} from '@/lib/recommendation-engine'
import { tmdbAdapter } from '@/api/metadata/adapters/tmdb'
import { useAccountStore } from '@/store/accountStore'
import { AccountAvatar } from '@/components/accounts/AccountAvatar'
import { ToolbarShell } from '@/components/ui/toolbar-shell'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'
import { ContentRail, ContentRailCard, ContentRailSkeleton } from '@/components/ui/content-rail'
import { EmptyState } from '@/components/common/EmptyState'
import type { ActivityItem } from '@/types/activity'
import type { DetailItem } from '@/components/activity/ActivityDetailModal'
import { lazyChunk } from '@/lib/lazy-chunk'
import { DiscoveryPreferencesModal } from '@/components/for-you/DiscoveryPreferencesModal'
import { PublishToPmdbDialog } from '@/components/for-you/PublishToPmdbDialog'
import { checkPmdbKeyConfigured, getLastPublishTime } from '@/lib/pmdb-list-publisher'
import { useTmdbKeyStatus } from '@/hooks/useTmdbKeyStatus'
import { buildCinemetaFatRails } from '@/lib/cinemeta-rails'
import { getWatchlist, type WatchlistItem } from '@/lib/watchlist'
import { bucketize, bucketsToPmdbRails, itemIdFromCanonical, type BucketItem } from '@/lib/rail-buckets'

const ActivityDetailModal = lazyChunk(() => import('@/components/activity/ActivityDetailModal').then(m => ({ default: m.ActivityDetailModal })))

interface AccountDetailPageProps {
    accountId: string
    onBack: () => void
}

const MIN_ITEMS_FOR_RECS = 5
const MAX_SEEDS = 15

function activityItemToSeed(item: ActivityItem): SeedItem {
    const seed: SeedItem = {
        itemId: item.itemId,
        title: item.name,
        type: item.type,
        progress: item.progress,
        timestamp: item.timestamp.getTime(),
    }
    if (item.genres && item.genres.length > 0) seed.genres = item.genres
    if (item.season !== undefined) seed.season = item.season
    if (item.episode !== undefined) seed.episode = item.episode
    return seed
}

function firstName(name: string | undefined | null): string {
    if (!name) return 'you'
    const trimmed = name.trim()
    if (!trimmed) return 'you'
    return trimmed.split(/\s+/)[0]
}

function ProfileSkeleton() {
    return (
        <div className="rounded-2xl border border-border/40 bg-card/50 p-5 shadow-sm space-y-4">
            <div className="h-5 w-44 rounded bg-muted/60 animate-pulse" />
            <div className="space-y-2">
                <div className="h-3 w-24 rounded bg-muted/40 animate-pulse" />
                <div className="flex gap-1.5">
                    {Array.from({ length: 4 }).map((_, i) => (
                        <div key={i} className="h-7 w-20 rounded-full bg-muted/50 animate-pulse" />
                    ))}
                </div>
            </div>
            <div className="space-y-2">
                <div className="h-3 w-20 rounded bg-muted/40 animate-pulse" />
                <div className="h-2 w-full rounded-full bg-muted/50 animate-pulse" />
            </div>
        </div>
    )
}

export function AccountDetailPage({ accountId, onBack }: AccountDetailPageProps) {
    const accounts = useAccountStore(s => s.accounts)
    const account = useMemo(() => accounts.find(a => a.id === accountId), [accounts, accountId])
    const accountName = account?.name || account?.email?.split('@')[0] || 'Account'

    const RAIL_SIZE = useRailSize(accountId)

    const { history: allHistory, loading: historyLoading } = useWatchHistory(undefined, true, { sessions: false })

    const allActivity = useMemo(
        () => allHistory.map(historyEntryToActivityItem).filter(item => !item.backfill),
        [allHistory]
    )

    const accountActivity = useMemo(
        () => allActivity.filter(item => item.accountId === accountId),
        [allActivity, accountId]
    )

    const externalRatings = useExternalRatings()

    const tasteProfile = useMemo(
        // Only this account's rows: buildTasteProfile filters to the account
        // internally, so passing all accounts' activity would re-walk every
        // other account's history on each rebuild.
        () => buildTasteProfile(accountId, accountActivity, externalRatings),
        [accountActivity, accountId, externalRatings]
    )

    const discoveryPrefs = useDiscoveryPrefs(accountId || HOUSEHOLD_CONTEXT)

    const seeds = useMemo(
        () => accountActivity.map(activityItemToSeed),
        [accountActivity]
    )

    const [rails, setRails] = useState<RankedRail[]>([])
    const [recsLoading, setRecsLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [reloadKey, setReloadKey] = useState(0)
    const hasRailsRef = useRef(false)
    const [isColdStart, setIsColdStart] = useState(false)
    const tmdbKeyStatus = useTmdbKeyStatus()
    const [popularFallbackNotice, setPopularFallbackNotice] = useState(false)
    const [detailItem, setDetailItem] = useState<DetailItem | null>(null)
    const [detailModalSeen, setDetailModalSeen] = useState(false)
    useEffect(() => { if (detailItem) setDetailModalSeen(true) }, [detailItem])
    const [catalogOpen, setCatalogOpen] = useState(false)

    const [pmdbDialogOpen, setPmdbDialogOpen] = useState(false)
    const [hasPmdbKey, setHasPmdbKey] = useState(false)
    const [pmdbLastPublished, setPmdbLastPublished] = useState<number | null>(null)

    useEffect(() => {
        let cancelled = false
        const check = async (attempt: number) => {
            const result = await checkPmdbKeyConfigured()
            if (cancelled) return
            if (result) { setHasPmdbKey(true); return }
            if (attempt < 5) setTimeout(() => check(attempt + 1), 1500 * (attempt + 1))
        }
        check(0)
        return () => { cancelled = true }
    }, [])

    useEffect(() => {
        if (!pmdbDialogOpen) {
            setPmdbLastPublished(getLastPublishTime(accountId))
        }
    }, [pmdbDialogOpen, accountId])

    useEffect(() => {
        setPopularFallbackNotice(false)
        if (accountActivity.length < MIN_ITEMS_FOR_RECS) {
            setIsColdStart(true)
            setRecsLoading(true)
            setError(null)
            let cancelled = false
            const ctrl = new AbortController()
            const coldWatched = new Set<string>()
            const cache = loadImdbTmdbCache()
            for (const v of Object.values(cache)) { if (v) coldWatched.add(v) }
            for (const s of seeds) { if (s.itemId.startsWith('tmdb:')) coldWatched.add(s.itemId) }
            buildColdStartRails(ctrl.signal, RAIL_SIZE, coldWatched)
                .then(rails => { if (!cancelled) setRails(rails) })
                .catch(err => {
                    if (cancelled || ctrl.signal.aborted || err?.name === 'AbortError') return
                    setError('Failed to load trending content')
                })
                .finally(() => {
                    if (!cancelled) setRecsLoading(false)
                })
            return () => { cancelled = true; try { ctrl.abort() } catch {} }
        }
        if (tmdbKeyStatus === 'checking') {
            if (!hasRailsRef.current) setRecsLoading(true)
            return
        }
        if (tmdbKeyStatus === 'absent') {
            let cancelled = false
            const ctrl = new AbortController()
            setIsColdStart(true)
            setRecsLoading(true)
            setError(null)
            const watchedImdbIds = new Set(
                seeds.filter(s => s.itemId.startsWith('tt') && s.progress > 30).map(s => s.itemId)
            )
            buildCinemetaFatRails(ctrl.signal, RAIL_SIZE, { watchedImdbIds })
                .then(rails => { if (!cancelled) setRails(rails) })
                .catch(err => {
                    if (cancelled || ctrl.signal.aborted || err?.name === 'AbortError') return
                    setError('Failed to load popular content')
                })
                .finally(() => { if (!cancelled) setRecsLoading(false) })
            return () => { cancelled = true; try { ctrl.abort() } catch {} }
        }
        let cancelled = false
        const ctrl = new AbortController()
        const hadRails = hasRailsRef.current
        setIsColdStart(false)
        if (!hadRails) setRecsLoading(true)
        setError(null)
        const cachedTmdbIds = new Set<string>()
        const cache = loadImdbTmdbCache()
        for (const v of Object.values(cache)) { if (v) cachedTmdbIds.add(v) }
        buildRecommendations(seeds, tmdbAdapter, {
            signal: ctrl.signal,
            maxSeeds: MAX_SEEDS,
            railSize: RAIL_SIZE,
            tasteProfile,
            watchedTmdbIds: cachedTmdbIds,
            filters: {
                obscurity: discoveryPrefs.obscurity,
                minRating: discoveryPrefs.minRating,
                eraRange: discoveryPrefs.eraRange,
                typeMix: discoveryPrefs.typeMix,
                genreBoosts: discoveryPrefs.genreBoosts,
                excludedGenres: discoveryPrefs.excludedGenres,
                dismissedItems: discoveryPrefs.dismissedItems,
                lovedItems: discoveryPrefs.lovedItems,
            },
        })
            .then(async result => {
                if (cancelled) return
                const allSeedsFailed = result.rails.length === 0 && (result.failedSeedCount ?? 0) > 0
                if (allSeedsFailed && hadRails) return
                if (!allSeedsFailed) {
                    hasRailsRef.current = true
                    setRails(result.rails)
                    return
                }
                try {
                    const rails = await buildCinemetaFatRails(ctrl.signal, RAIL_SIZE, {
                        watchedImdbIds: new Set(
                            seeds.filter(s => s.itemId.startsWith('tt') && s.progress > 30).map(s => s.itemId)
                        ),
                    })
                    if (cancelled || ctrl.signal.aborted) return
                    if (rails.length > 0) {
                        setIsColdStart(true)
                        setPopularFallbackNotice(true)
                        hasRailsRef.current = true
                        setRails(rails)
                        return
                    }
                } catch {}
                setError(result.firstError || 'TMDB recommendation provider returned no results. Check the browser console for details.')
            })
            .catch(err => {
                if (cancelled || ctrl.signal.aborted) return
                setError(err?.message ?? 'Failed to load recommendations')
            })
            .finally(() => {
                if (!cancelled) setRecsLoading(false)
            })
        return () => {
            cancelled = true
            try { ctrl.abort() } catch {}
        }
    }, [seeds, accountActivity.length, RAIL_SIZE, accountId, reloadKey, tasteProfile, tmdbKeyStatus,
        discoveryPrefs.obscurity, discoveryPrefs.minRating, discoveryPrefs.eraRange, discoveryPrefs.typeMix,
        discoveryPrefs.genreBoosts, discoveryPrefs.excludedGenres, discoveryPrefs.dismissedItems, discoveryPrefs.lovedItems])

    const [watchlistItems, setWatchlistItems] = useState<WatchlistItem[]>([])
    const refreshWatchlist = useCallback(() => {
        if (!accountId) return
        getWatchlist(accountId).then(items => {
            if (items.length > 0) setWatchlistItems(items.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)))
            else setWatchlistItems([])
        }).catch(() => setWatchlistItems([]))
    }, [accountId])
    useEffect(() => { refreshWatchlist() }, [refreshWatchlist])

    const enrichedWatchlist = useMemo(() => {
        if (rails.length === 0) return watchlistItems
        const posterById = new Map<string, string>()
        for (const rail of rails) {
            for (const item of rail.items) {
                const id = itemIdFromCanonical(item.id)
                if (item.poster) posterById.set(id, item.poster)
            }
        }
        return watchlistItems.map(w => {
            const poster = posterById.get(w.itemId)
            return poster ? { ...w, poster } : w
        })
    }, [watchlistItems, rails])

    const buckets = useMemo(() => {
        return bucketize(rails, enrichedWatchlist)
    }, [rails, enrichedWatchlist])

    const pmdbRails = useMemo(() => bucketsToPmdbRails(buckets, RAIL_SIZE), [buckets, RAIL_SIZE])

    if (!account) {
        return (
            <div className="space-y-6 overflow-x-hidden">
                <ToolbarShell>
                    <Button variant="ghost" size="sm" onClick={onBack} className="gap-1.5">
                        <ArrowLeft className="h-4 w-4" />
                        Back
                    </Button>
            </ToolbarShell>

                <EmptyState
                    variant="warning"
                    title="Account not found"
                    description="This account no longer exists."
                />
            </div>
        )
    }

    const first = firstName(accountName)
    const isInitialLoading = historyLoading && allActivity.length === 0
    const hasEnoughHistory = accountActivity.length >= MIN_ITEMS_FOR_RECS
    const hasAnyContent = rails.length > 0 || enrichedWatchlist.length > 0

    return (
        <div className="space-y-6 overflow-x-hidden">
            <ToolbarShell>
                <Button
                    variant="ghost"
                    size="sm"
                    onClick={onBack}
                    className="gap-1.5 text-muted-foreground hover:text-foreground"
                >
                    <ArrowLeft className="h-4 w-4" />
                    Back
                </Button>
                <div className="hidden sm:block h-6 w-px bg-border/40" />
                <div className="flex items-center gap-2.5 min-w-0">
                    <AccountAvatar account={account} size="md" />
                    <div className="min-w-0">
                        <h1 className="text-sm sm:text-base font-semibold truncate leading-tight">{accountName}</h1>
                    </div>
                </div>
                <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setReloadKey(k => k + 1)}
                        disabled={recsLoading}
                        className="h-8 gap-1.5 text-xs font-medium"
                    >
                        <RefreshCw className={recsLoading ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
                        Refresh
                    </Button>
                    {hasEnoughHistory && hasPmdbKey && (
                        <Tooltip content={pmdbLastPublished !== null
                            ? `Last published ${formatStaleAgo(pmdbLastPublished)}`
                            : 'Publish rails to PMDB lists'}>
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setPmdbDialogOpen(true)}
                                disabled={recsLoading}
                                className="h-8 gap-1.5 text-xs font-medium"
                            >
                                <Upload className="h-3.5 w-3.5" />
                                Publish to PMDB
                                {pmdbLastPublished !== null && (
                                    <span className={cn(
                                        'h-1.5 w-1.5 rounded-full',
                                        Date.now() - pmdbLastPublished > 86400000 ? 'bg-amber-500' : 'bg-emerald-500'
                                    )} />
                                )}
                            </Button>
                        </Tooltip>
                    )}
                    {hasEnoughHistory && !hasPmdbKey && (
                        <Tooltip content="Add a PMDB API key in Settings > Metadata Integrations to enable publishing">
                            <Button
                                variant="outline"
                                size="sm"
                                disabled
                                className="h-8 gap-1.5 text-xs font-medium opacity-50"
                            >
                                <Upload className="h-3.5 w-3.5" />
                                Publish to PMDB
                            </Button>
                        </Tooltip>
                    )}
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setCatalogOpen(true)}
                        className="h-8 gap-1.5 text-xs font-medium"
                    >
                        <LayoutGrid className="h-3.5 w-3.5" />
                        Shelves
                    </Button>
                </div>
            </ToolbarShell>

            {isInitialLoading ? (
                <>
                    <ProfileSkeleton />
                    {Array.from({ length: 2 }).map((_, i) => (
                        <ContentRailSkeleton key={i} />
                    ))}
                </>
            ) : !hasEnoughHistory ? (
                <EmptyState
                    icon={<Sparkles className="h-5 w-5" />}
                    title="Not enough history for personalized recs"
                    description={`Watch at least ${MIN_ITEMS_FOR_RECS} items to unlock ${first}'s taste profile and recommendations.`}
                />
            ) : (
                <>
                    {recsLoading ? (
                        <div className="space-y-4">
                            {Array.from({ length: 3 }).map((_, i) => (
                                <ContentRailSkeleton key={i} />
                            ))}
                        </div>
                    ) : error ? (
                        <EmptyState
                            variant="error"
                            title="Couldn't load recommendations"
                            description={error}
                        />
                    ) : !hasAnyContent ? (
                        <EmptyState
                            icon={<Sparkles className="h-5 w-5" />}
                            title="No recommendations yet"
                            description="We couldn't find personalized recommendations for this account right now."
                        />
                    ) : (
                        <div className="space-y-5">
                            {popularFallbackNotice && (
                                <div className="flex items-center gap-2 rounded-xl border border-border/40 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                                    <Info className="h-3.5 w-3.5 shrink-0" />
                                    Personalized recommendations are unavailable right now. Showing popular titles instead.
                                </div>
                            )}
                            {(() => {
                                const hasAny = buckets.movies.length > 0 || buckets.series.length > 0 || buckets.anime.length > 0 || enrichedWatchlist.length > 0
                                if (!hasAny) return null
                                const makeClick = (item: BucketItem, type: string) => () => setDetailItem({
                                    itemId: item.id,
                                    type: type === 'series' || type === 'anime' ? 'series' : 'movie',
                                    name: item.title,
                                    poster: item.poster,
                                    genres: item.genres,
                                    year: item.year,
                                    voteAverage: item.voteAverage,
                                    backdrop: item.backdrop,
                                })
                                return (
                                    <>
                                        {enrichedWatchlist.length > 0 && (
                                            <ContentRail title="Watchlist" icon={<Bookmark className="h-4 w-4 text-primary" />} count={enrichedWatchlist.length}>
                                                {enrichedWatchlist.map((item, i) => (
                                                    <ContentRailCard
                                                        key={`wl-${item.itemId}`}
                                                        title={item.name || 'Unknown'}
                                                        poster={item.poster}
                                                        itemId={item.itemId}
                                                        itemType={item.type === 'movie' ? 'movie' : 'series'}
                                                        index={i}
                                                        onClick={() => setDetailItem({
                                                            itemId: item.itemId,
                                                            type: item.type === 'movie' ? 'movie' : 'series',
                                                            name: item.name || 'Unknown',
                                                            poster: item.poster,
                                                        })}
                                                    />
                                                ))}
                                            </ContentRail>
                                        )}
                                        {buckets.movies.length > 0 && (
                                            <ContentRail title="Movies" subtitle={isColdStart ? 'Trending now' : 'Recommended for this account'} showGridToggle>
                                                {buckets.movies.map((item, i) => (
                                                    <ContentRailCard
                                                        key={`mv-${item.id}`}
                                                        title={item.title}
                                                        poster={item.poster}
                                                        itemId={item.id}
                                                        itemType="movie"
                                                        subtitle={[item.year, item.genres?.[0]].filter(Boolean).join(' · ')}
                                                        index={i}
                                                        onClick={makeClick(item, 'movie')}
                                                    />
                                                ))}
                                            </ContentRail>
                                        )}
                                        {buckets.series.length > 0 && (
                                            <ContentRail title="Series" subtitle={isColdStart ? 'Trending now' : 'Recommended for this account'} showGridToggle>
                                                {buckets.series.map((item, i) => (
                                                    <ContentRailCard
                                                        key={`sr-${item.id}`}
                                                        title={item.title}
                                                        poster={item.poster}
                                                        itemId={item.id}
                                                        itemType="series"
                                                        subtitle={[item.year, item.genres?.[0]].filter(Boolean).join(' · ')}
                                                        index={i}
                                                        onClick={makeClick(item, 'series')}
                                                    />
                                                ))}
                                            </ContentRail>
                                        )}
                                        {buckets.anime.length > 0 && (
                                            <ContentRail title="Anime" subtitle={isColdStart ? 'Trending now' : 'Recommended for this account'} showGridToggle>
                                                {buckets.anime.map((item, i) => (
                                                    <ContentRailCard
                                                        key={`an-${item.id}`}
                                                        title={item.title}
                                                        poster={item.poster}
                                                        itemId={item.id}
                                                        itemType="series"
                                                        subtitle={[item.year, item.genres?.[0]].filter(Boolean).join(' · ')}
                                                        index={i}
                                                        onClick={makeClick(item, 'anime')}
                                                    />
                                                ))}
                                            </ContentRail>
                                        )}
                                    </>
                                )
                            })()}
                        </div>
                    )}
                </>
            )}

            {detailModalSeen && (
            <Suspense fallback={null}>
            <ActivityDetailModal
                open={detailItem !== null}
                onOpenChange={(open: boolean) => { if (!open) { setDetailItem(null); refreshWatchlist() } }}
                item={detailItem}
            />
            </Suspense>
            )}

            <DiscoveryPreferencesModal
                open={catalogOpen}
                onOpenChange={setCatalogOpen}
                accountId={accountId}
            />

            <PublishToPmdbDialog
                open={pmdbDialogOpen}
                onOpenChange={setPmdbDialogOpen}
                scope={accountId}
                scopeLabel={accountName}
                rails={pmdbRails}
            />
        </div>
    )
}
