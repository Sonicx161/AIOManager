import { Suspense, useEffect, useMemo, useState, useCallback, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Link } from 'react-router-dom'
import { ChevronLeft, ChevronRight, RefreshCw, AlertCircle, Sparkles, ArrowRight, Dice3, Info, Search, Bookmark, LayoutGrid, Upload } from 'lucide-react'

import { ToolbarShell } from '@/components/ui/toolbar-shell'
import { ContentRail, ContentRailCard, ContentRailSkeleton } from '@/components/ui/content-rail'
import { AccountAvatar } from '@/components/accounts/AccountAvatar'
import { Button } from '@/components/ui/button'
import { SearchDialog } from '@/components/search/SearchDialog'
import { useWatchHistory } from '@/hooks/useWatchHistory'
import { useDocumentTitle } from '@/hooks/use-document-title'
import { useAccountStore } from '@/store/accountStore'
import { useDiscoveryPrefs, useHouseholdSettings, HOUSEHOLD_CONTEXT } from '@/store/discoveryStore'
import { DiscoveryPreferencesModal } from '@/components/for-you/DiscoveryPreferencesModal'
import { historyEntryToActivityItem } from '@/lib/activity-utils'
import { cn, maskNameLevel, formatStaleAgo, loadImdbTmdbCache, saveImdbTmdbCache, loadUnresolvedImdbIds, saveUnresolvedImdbIds, IMDB_UNRESOLVED_RETRY_MS } from '@/lib/utils'
import { Tooltip } from '@/components/ui/tooltip'
import { OperationProgress } from '@/components/ui/operation-progress'
import { useUIStore } from '@/store/uiStore'
import type { DetailItem } from '@/components/activity/ActivityDetailModal'
import { lazyChunk } from '@/lib/lazy-chunk'
import { buildTasteProfile, computeHouseholdPopularity, type TasteProfile } from '@/lib/taste-profile'
import { useExternalRatings } from '@/lib/external-ratings-store'
import { useRailSize } from '@/lib/discovery-prefs-store'
import {
    buildRecommendations,
    buildColdStartRails,
    type SeedItem,
    type BuildRecommendationsResult,
} from '@/lib/recommendation-engine'
import { buildCinemetaFatRails } from '@/lib/cinemeta-rails'
import { useTmdbKeyStatus } from '@/hooks/useTmdbKeyStatus'
import { tmdbAdapter, proxyFetch, fetchTmdbDetailsAsMeta, pickTmdbIdFromFind, type TmdbFindPayload } from '@/api/metadata/adapters/tmdb'
import { TabsTrigger } from '@/components/ui/tabs'
import { WorkspaceTabs } from '@/components/ui/workspace-tabs'
import { PublishToPmdbDialog } from '@/components/for-you/PublishToPmdbDialog'
import { checkPmdbKeyConfigured, getLastPublishTime } from '@/lib/pmdb-list-publisher'
import { getWatchlist, type WatchlistItem } from '@/lib/watchlist'
import { bucketize, bucketsToPmdbRails, itemIdFromCanonical, type BucketItem } from '@/lib/rail-buckets'
import type { ActivityItem } from '@/types/activity'
import type { Account } from '@/types/account'

const ActivityDetailModal = lazyChunk(() => import('@/components/activity/ActivityDetailModal').then(m => ({ default: m.ActivityDetailModal })))

const HOUSEHOLD_RAIL_MAX = 12

export interface ForYouPageProps {
    onAccountClick?: (accountId: string) => void
    onItemClick?: (item: { itemId: string; type: string; name: string }) => void
}

// ─── Hero ──────────────────────────────────────────────────────────────────

interface HeroItem {
    title: string
    backdrop?: string
    poster?: string
    year?: number
    genres?: string[]
    voteAverage?: number
    description?: string
    itemId?: string
    type?: string
    confidence?: number
}

interface ForYouHeroProps {
    item: HeroItem | null
    loading: boolean
    onMoreInfo?: () => void
    onSurpriseMe?: () => void
    surpriseSpinning?: boolean
}

function ForYouHero({ item, loading, onMoreInfo, onSurpriseMe, surpriseSpinning }: ForYouHeroProps) {
    const [fetchedBackdrop, setFetchedBackdrop] = useState<string | null>(null)
    const [backdropFailed, setBackdropFailed] = useState(false)

    useEffect(() => {
        setBackdropFailed(false)
        if (!item || item.backdrop) {
            setFetchedBackdrop(null)
            return
        }
        let active = true
        const isImdb = item.itemId?.startsWith('tt')
        const tmdbMatch = item.itemId?.match(/^tmdb:(\d+)$/i)

        if (tmdbMatch) {
            const tmdbId = Number(tmdbMatch[1])
            const mediaType = item.type === 'series' || item.type === 'anime' ? 'tv' : 'movie'
            fetchTmdbDetailsAsMeta(tmdbId, mediaType).then(res => {
                if (active && res.meta.background) setFetchedBackdrop(res.meta.background)
            }).catch(() => {})
        } else if (isImdb && item.itemId) {
            proxyFetch<TmdbFindPayload>(`find/${encodeURIComponent(item.itemId)}?external_source=imdb_id`).then(find => {
                const picked = pickTmdbIdFromFind(find, item.type !== 'movie')
                if (picked) {
                    fetchTmdbDetailsAsMeta(picked.tmdbId, picked.mediaType).then(res => {
                        if (active && res.meta.background) setFetchedBackdrop(res.meta.background)
                    }).catch(() => {})
                }
            }).catch(() => {})
        }
        return () => { active = false }
    }, [item])

    const activeBackdrop = item?.backdrop || fetchedBackdrop

    return (
        <div className="relative w-full overflow-hidden rounded-3xl bg-black text-white shadow-2xl ring-1 ring-border/30" style={{ height: 'clamp(280px, 42vh, 420px)' }}>
            {!loading && activeBackdrop && !backdropFailed && (
                <img
                    src={activeBackdrop}
                    alt=""
                    aria-hidden="true"
                    className="absolute inset-0 h-full w-full object-cover filter blur-3xl opacity-50 scale-125"
                    onError={() => setBackdropFailed(true)}
                />
            )}

            <AnimatePresence mode="wait">
                {loading || !item ? (
                    <motion.div
                        key="hero-skeleton"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="absolute inset-0 bg-white/5"
                    >
                        <div className="absolute inset-0 animate-pulse bg-white/5" />
                    </motion.div>
                ) : (
                    <motion.div
                        key={`hero-${item.itemId}`}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.6, ease: 'easeInOut' }}
                        className="absolute inset-0 bg-black"
                    >
                        {activeBackdrop && !backdropFailed ? (
                            <img
                                src={activeBackdrop}
                                alt=""
                                aria-hidden="true"
                                className="absolute inset-0 h-full w-full object-cover opacity-95 transition-opacity duration-300 sm:object-[center_25%]"
                                style={{
                                    maskImage: 'linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,0.9) 70%, rgba(0,0,0,0) 100%)',
                                    WebkitMaskImage: 'linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,0.9) 70%, rgba(0,0,0,0) 100%)',
                                }}
                                onError={() => setBackdropFailed(true)}
                            />
                        ) : item.poster ? (
                            <>
                                <div className="absolute inset-0 bg-gradient-to-r from-black via-black/90 to-black" />
                                <div className="absolute right-0 top-0 bottom-0 w-1/2 overflow-hidden opacity-75">
                                    <img
                                        src={item.poster}
                                        alt=""
                                        aria-hidden="true"
                                        className="h-full w-full object-cover object-top"
                                    />
                                    <div className="absolute inset-0 bg-gradient-to-r from-black via-transparent to-transparent" />
                                    <div className="absolute inset-0 bg-gradient-to-t from-black via-transparent to-transparent" />
                                </div>
                            </>
                        ) : (
                            <div className="absolute inset-0 bg-black/90" />
                        )}
                    </motion.div>
                )}
            </AnimatePresence>

            <div className="pointer-events-none absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-black/50 via-black/15 to-transparent" />
            <div className="pointer-events-none absolute inset-y-0 left-0 w-3/5 bg-gradient-to-r from-black/60 via-black/20 to-transparent" />

            {/* Content Container */}
            <div className="absolute inset-x-0 bottom-0 flex flex-col gap-3 px-4 pb-6 pt-8 sm:px-6 sm:pb-8 sm:pt-12 sm:px-10">
                {loading || !item ? (
                    <div className="space-y-3">
                        <div className="h-8 w-64 animate-pulse rounded-lg bg-white/20" />
                        <div className="h-4 w-48 animate-pulse rounded bg-white/10" />
                    </div>
                ) : (
                    <motion.div
                        key={`hero-content-${item.itemId}`}
                        initial={{ opacity: 0, y: 12 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.15, duration: 0.4 }}
                        className="space-y-3 max-w-3xl text-white"
                    >
                        {/* Apple TV Badges Row */}
                        <div className="flex flex-wrap items-center gap-2">
                            {item.genres && item.genres[0] && (
                                <span className="rounded-md border border-white/20 bg-black/60 px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wider text-white backdrop-blur-md">
                                    {item.genres[0]}
                                </span>
                            )}
                        </div>

                        {/* Title — Always Crisp White */}
                        <h2 className="text-2xl sm:text-3xl font-black leading-tight tracking-tight text-white drop-shadow-lg sm:text-5xl">
                            {item.title}
                        </h2>

                        {/* Meta Subtitle — High contrast text-white/80 */}
                        <p className="text-sm font-semibold text-white/80 drop-shadow">
                            {[
                                item.year,
                                typeof item.voteAverage === 'number' && item.voteAverage > 0 ? `★ ${item.voteAverage.toFixed(1)}` : null,
                                item.genres?.slice(1, 4).join(' · ')
                            ].filter(Boolean).join('  ·  ')}
                        </p>

                        {/* CTAs — Authentic Apple TV Action Pills */}
                        <div className="flex flex-wrap items-center gap-3 pt-2">
                            {onMoreInfo && (
                                <button
                                    type="button"
                                    data-theme-part="button"
                                    onClick={onMoreInfo}
                                    className="inline-flex h-11 items-center gap-2.5 rounded-full bg-white px-7 text-sm font-bold text-black shadow-xl transition-all hover:bg-white/90 hover:scale-105 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                                >
                                    <Info className="h-4 w-4" />
                                    More Info
                                </button>
                            )}
                            {onSurpriseMe && (
                                <button
                                    type="button"
                                    data-theme-part="button"
                                    onClick={onSurpriseMe}
                                    className="inline-flex h-11 items-center gap-2.5 rounded-full border border-white/20 bg-white/10 px-6 text-sm font-semibold text-white backdrop-blur-md transition-all hover:bg-white/20 hover:scale-105 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
                                >
                                    <Dice3 className={cn('h-4 w-4', surpriseSpinning && 'animate-spin')} />
                                    {surpriseSpinning ? 'Picking…' : 'Surprise Me'}
                                </button>
                            )}
                        </div>
                    </motion.div>
                )}
            </div>
        </div>
    )
}

export function ForYouPage({ onAccountClick }: ForYouPageProps) {
    useDocumentTitle('For You')

    const RAIL_MAX = useRailSize()
    const accounts = useAccountStore(s => s.accounts)
    const isPrivacyModeEnabled = useUIStore(s => s.isPrivacyModeEnabled)
    const privacyLevelNames = useUIStore(s => s.privacyLevelNames)
    const namePrivacy = isPrivacyModeEnabled ? privacyLevelNames : 0
    const { history: watchHistory, loading: historyLoading } = useWatchHistory()
    const discoveryPrefs = useDiscoveryPrefs(HOUSEHOLD_CONTEXT)
    const householdSettings = useHouseholdSettings()
    const [catalogOpen, setCatalogOpen] = useState(false)
    const [subTab, setSubTab] = useState<'unified' | 'accounts'>('unified')
    const [heroIndex, setHeroIndex] = useState(0)
    const [heroPaused, setHeroPaused] = useState(false)

    const allItems = useMemo<ActivityItem[]>(
        () => watchHistory.map(historyEntryToActivityItem).filter(item => !item.backfill),
        [watchHistory]
    )

    const filteredItems = useMemo(() => {
        if (householdSettings.enabledAccounts === 'all') return allItems
        return allItems.filter(item => householdSettings.enabledAccounts.includes(item.accountId))
    }, [allItems, householdSettings.enabledAccounts])

    const itemsByAccount = useMemo(() => {
        const m = new Map<string, ActivityItem[]>()
        for (const item of allItems) {
            const arr = m.get(item.accountId)
            if (arr) arr.push(item)
            else m.set(item.accountId, [item])
        }
        return m
    }, [allItems])

    const externalRatings = useExternalRatings()

    const profiles = useMemo(() => {
        const m = new Map<string, TasteProfile>()
        for (const [accId, items] of itemsByAccount) {
            if (items.length === 0) continue
            m.set(accId, buildTasteProfile(accId, items, externalRatings))
        }
        return m
    }, [itemsByAccount, externalRatings])

    const householdProfile = useMemo((): TasteProfile | undefined => {
        if (profiles.size === 0) return undefined
        const allProfiles = Array.from(profiles.values())
        if (allProfiles.length === 1) return allProfiles[0]
        const totalWeight = allProfiles.reduce((s, p) => s + Math.max(p.totalItems, 1), 0)
        const mergedGenres: Record<string, { weight: number; count: number; avgRating: number }> = {}
        const mergedEras: Record<string, number> = {}
        const mergedTypes = { movie: 0, series: 0 }
        for (const p of allProfiles) {
            const w = Math.max(p.totalItems, 1) / totalWeight
            for (const [genre, data] of Object.entries(p.genres)) {
                if (!mergedGenres[genre]) mergedGenres[genre] = { weight: 0, count: 0, avgRating: 0 }
                mergedGenres[genre].weight += data.weight * w
                mergedGenres[genre].count += data.count
                mergedGenres[genre].avgRating += data.avgRating * w
            }
            for (const [era, val] of Object.entries(p.eras ?? {})) {
                mergedEras[era] = (mergedEras[era] ?? 0) + val * w
            }
            mergedTypes.movie += (p.types?.movie ?? 0) * w
            mergedTypes.series += (p.types?.series ?? 0) * w
        }
        // Use the profile with most items as a structural base, then overlay merged fields
        const base = allProfiles.reduce((a, b) => a.totalItems >= b.totalItems ? a : b)
        return {
            ...base,
            genres: mergedGenres,
            eras: mergedEras,
            types: mergedTypes,
            totalItems: allProfiles.reduce((sum, p) => sum + p.totalItems, 0),
        }
    }, [profiles])

    const seeds = useMemo<SeedItem[]>(
        () => {
            const fromActivity = filteredItems.map(item => ({
                itemId: item.itemId,
                title: item.name,
                type: item.type,
                genres: item.genres,
                progress: item.progress,
                timestamp: item.timestamp.getTime(),
                season: item.season,
                episode: item.episode,
            }))
            return fromActivity
        },
        [filteredItems]
    )

    const [recsResult, setRecsResult] = useState<BuildRecommendationsResult | null>(null)
    const [recsLoading, setRecsLoading] = useState(false)
    const [recsError, setRecsError] = useState<string | null>(null)
    const [reloadKey, setReloadKey] = useState(0)
    const hasResultsRef = useRef(false)

    const [isColdStart, setIsColdStart] = useState(false)
    const tmdbKeyStatus = useTmdbKeyStatus()
    const [popularFallbackNotice, setPopularFallbackNotice] = useState(false)

    const watchedImdbIdsFromSeeds = useCallback(() => new Set(
        seeds.filter(s => s.itemId.startsWith('tt') && s.progress > 30).map(s => s.itemId)
    ), [seeds])

    useEffect(() => {
        setPopularFallbackNotice(false)
        if (seeds.length < 5) {
            setIsColdStart(true)
            setRecsLoading(true)
            setRecsError(null)
            const ac = new AbortController()
            const coldStartWatched = new Set<string>()
            const cache = loadImdbTmdbCache()
            for (const v of Object.values(cache)) { if (v) coldStartWatched.add(v) }
            for (const s of seeds) { if (s.itemId.startsWith('tmdb:')) coldStartWatched.add(s.itemId) }
            buildColdStartRails(ac.signal, RAIL_MAX, coldStartWatched)
                .then(rails => {
                    if (ac.signal.aborted) return
                    setRecsResult({ rails, totalCandidates: rails.reduce((s, r) => s + r.items.length, 0) })
                })
                .catch(err => { if (ac.signal.aborted || err?.name === 'AbortError') return; setRecsError('Failed to load trending content') })
                .finally(() => { if (!ac.signal.aborted) setRecsLoading(false) })
            return () => ac.abort()
        }
        if (tmdbKeyStatus === 'checking') {
            setRecsLoading(true)
            return
        }
        if (tmdbKeyStatus === 'absent') {
            const ac = new AbortController()
            setIsColdStart(true)
            setRecsLoading(true)
            setRecsError(null)
            buildCinemetaFatRails(ac.signal, RAIL_MAX, { watchedImdbIds: watchedImdbIdsFromSeeds() })
                .then(rails => {
                    if (ac.signal.aborted) return
                    setRecsResult({ rails, totalCandidates: rails.reduce((sum, r) => sum + r.items.length, 0) })
                })
                .catch(err => { if (ac.signal.aborted || err?.name === 'AbortError') return; setRecsError('Failed to load popular content') })
                .finally(() => { if (!ac.signal.aborted) setRecsLoading(false) })
            return () => ac.abort()
        }
        const ac = new AbortController()
        const hadResults = hasResultsRef.current
        setIsColdStart(false)
        setRecsLoading(true)
        setRecsError(null)
        performance.mark('foryou:recommend:start')
        ;(async () => {
            const watchedTmdbIds = new Set<string>()
            const cache = loadImdbTmdbCache()
            const unresolved = loadUnresolvedImdbIds()
            const now = Date.now()
            let cacheDirty = false
            let unresolvedDirty = false
            const watchedIds = seeds.filter(s => s.progress > 30 && s.itemId?.startsWith('tt')).map(s => s.itemId).slice(0, 20)
            const preferTvById = new Map(
                seeds.filter(s => s.itemId?.startsWith('tt')).map(s => [s.itemId, s.type === 'series' || s.type === 'anime'] as const)
            )
            const needsResolve = watchedIds.filter(id => !cache[id] && !(unresolved[id] !== undefined && now - unresolved[id] < IMDB_UNRESOLVED_RETRY_MS))
            const BATCH = 3
            for (let i = 0; i < needsResolve.length; i += BATCH) {
                if (ac.signal.aborted) break
                const batch = needsResolve.slice(i, i + BATCH)
                await Promise.all(batch.map(async (imdbId) => {
                    try {
                        const find = await proxyFetch<TmdbFindPayload>(`find/${imdbId}?external_source=imdb_id`, ac.signal)
                        const picked = pickTmdbIdFromFind(find, preferTvById.get(imdbId) ?? false)
                        if (picked) {
                            cache[imdbId] = `tmdb:${picked.tmdbId}`
                            cacheDirty = true
                        } else if (find) {
                            // Null data is a transport failure, not a confirmed negative find.
                            unresolved[imdbId] = Date.now()
                            unresolvedDirty = true
                        }
                    } catch {}
                }))
            }
            if (cacheDirty) saveImdbTmdbCache(cache)
            if (unresolvedDirty) saveUnresolvedImdbIds(unresolved)
            for (const id of watchedIds) { if (cache[id]) watchedTmdbIds.add(cache[id]) }
            return watchedTmdbIds
        })().then(watchedTmdbIds =>
            buildRecommendations(seeds, tmdbAdapter, {
                signal: ac.signal,
                railSize: RAIL_MAX,
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
                tasteProfile: householdProfile,
                watchedTmdbIds,
            })
        )
            .then(async result => {
                if (ac.signal.aborted) return
                const allSeedsFailed = result.rails.length === 0 && (result.failedSeedCount ?? 0) > 0
                if (allSeedsFailed && hadResults) {
                    setRecsError(result.firstError || 'Recommendation service temporarily unavailable. Try again in a moment.')
                    return
                }
                if (!allSeedsFailed) {
                    hasResultsRef.current = true
                    setRecsResult(result)
                    return
                }
                try {
                    const rails = await buildCinemetaFatRails(ac.signal, RAIL_MAX, { watchedImdbIds: watchedImdbIdsFromSeeds() })
                    if (ac.signal.aborted) return
                    if (rails.length > 0) {
                        setIsColdStart(true)
                        setPopularFallbackNotice(true)
                        hasResultsRef.current = true
                        setRecsResult({ rails, totalCandidates: rails.reduce((sum, r) => sum + r.items.length, 0) })
                        return
                    }
                } catch {}
                setRecsError(result.firstError || 'Recommendation service temporarily unavailable. Try again in a moment.')
            })
            .catch(err => {
                if (ac.signal.aborted || err?.name === 'AbortError') return
                setRecsError(err instanceof Error ? err.message : 'Failed to load recommendations')
            })
            .finally(() => {
                if (!ac.signal.aborted) {
                    performance.mark('foryou:recommend:end')
                    performance.measure('foryou:recommend', 'foryou:recommend:start', 'foryou:recommend:end')
                    setRecsLoading(false)
                }
            })
        return () => { try { ac.abort() } catch {} }
    }, [seeds, reloadKey, RAIL_MAX, householdProfile, tmdbKeyStatus, watchedImdbIdsFromSeeds,
        discoveryPrefs.obscurity, discoveryPrefs.minRating, discoveryPrefs.eraRange, discoveryPrefs.typeMix,
        discoveryPrefs.genreBoosts, discoveryPrefs.excludedGenres, discoveryPrefs.dismissedItems, discoveryPrefs.lovedItems])

    const itemMetaById = useMemo(() => {
        const m = new Map<string, { title: string; poster?: string; type?: string; genres?: string[] }>()
        for (const item of allItems) {
            const existing = m.get(item.itemId)
            if (!existing) {
                m.set(item.itemId, {
                    title: item.name,
                    poster: item.poster || undefined,
                    type: item.type,
                    genres: item.genres,
                })
            } else {
                if (!existing.poster && item.poster) existing.poster = item.poster
                if ((!existing.genres || existing.genres.length === 0) && item.genres && item.genres.length > 0) {
                    existing.genres = item.genres
                }
            }
        }
        return m
    }, [allItems])

    const householdRail = useMemo(() => {
        if (profiles.size === 0) return []
        const rows = computeHouseholdPopularity(Array.from(profiles.values()), allItems)
        return rows.slice(0, HOUSEHOLD_RAIL_MAX).map(row => {
            const meta = itemMetaById.get(row.itemId)
            return {
                itemId: row.itemId,
                title: meta?.title || row.title,
                poster: meta?.poster,
                type: meta?.type,
                genres: meta?.genres,
                watchers: row.watchers,
            }
        })
    }, [profiles, allItems, itemMetaById])

    const [watchlistItems, setWatchlistItems] = useState<WatchlistItem[]>([])
    const refreshWatchlist = useCallback(() => {
        getWatchlist().then(items => {
            if (items.length > 0) setWatchlistItems(items.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)))
            else setWatchlistItems([])
        }).catch(() => setWatchlistItems([]))
    }, [])
    useEffect(() => { refreshWatchlist() }, [refreshWatchlist])

    const enrichedWatchlist = useMemo(() => {
        if (!recsResult) return watchlistItems
        const posterById = new Map<string, string>()
        for (const rail of recsResult.rails) {
            for (const item of rail.items) {
                const id = itemIdFromCanonical(item.id)
                if (item.poster) posterById.set(id, item.poster)
            }
        }
        return watchlistItems.map(w => {
            const poster = posterById.get(w.itemId)
            return poster ? { ...w, poster } : w
        })
    }, [watchlistItems, recsResult])

    const buckets = useMemo(() => {
        if (!recsResult) return { movies: [] as BucketItem[], series: [] as BucketItem[], anime: [] as BucketItem[], watchlist: enrichedWatchlist }
        const extraItems: BucketItem[] = householdRail.map(row => ({
            id: row.itemId,
            title: row.title,
            type: row.type || 'series',
            poster: row.poster,
            genres: row.genres,
        }))
        return bucketize(recsResult.rails, enrichedWatchlist, extraItems)
    }, [recsResult, householdRail, enrichedWatchlist])

    const pmdbRails = useMemo(() => bucketsToPmdbRails(buckets, RAIL_MAX), [buckets, RAIL_MAX])

    const accountStats = useMemo(() => {
        const out: Array<{ account: Account; itemCount: number; topGenres: string[] }> = []
        for (const account of accounts) {
            const items = itemsByAccount.get(account.id) ?? []
            if (items.length === 0) continue
            const profile = profiles.get(account.id)
            const topGenres = profile
                ? Object.entries(profile.genres)
                    .sort((a, b) => b[1].weight - a[1].weight)
                    .slice(0, 3)
                    .map(([g]) => g)
                : []
            out.push({ account, itemCount: items.length, topGenres })
        }
        return out
    }, [accounts, itemsByAccount, profiles])

    const handleReload = useCallback(() => {
        hasResultsRef.current = false
        setRecsResult(null)
        setRecsLoading(true)
        setPopularFallbackNotice(false)
        setReloadKey(k => k + 1)
    }, [])

    const [searchOpen, setSearchOpen] = useState(false)
    const [detailItem, setDetailItem] = useState<DetailItem | null>(null)
    const [detailModalSeen, setDetailModalSeen] = useState(false)
    useEffect(() => { if (detailItem) setDetailModalSeen(true) }, [detailItem])
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
            setPmdbLastPublished(getLastPublishTime('household'))
        }
    }, [pmdbDialogOpen])

    const hasHistory = allItems.length > 0
    const showInitialSkeleton = historyLoading
    const showBuildingSkeleton = !historyLoading && recsLoading && recsResult === null
    const showError = recsError !== null && recsResult === null && !recsLoading
    const showRails = recsResult !== null

    // ── Surprise Me ────────────────────────────────────────────────────────
    const [surpriseSpinning, setSurpriseSpinning] = useState(false)
    const surpriseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    useEffect(() => () => { if (surpriseTimerRef.current) clearTimeout(surpriseTimerRef.current) }, [])
    const handleSurpriseMe = useCallback(() => {
        const pool = recsResult?.rails
            .flatMap(r => r.items)
            .filter(item => !discoveryPrefs.dismissedItems.includes(itemIdFromCanonical(item.id)))
            ?? []
        if (pool.length === 0) return
        setSurpriseSpinning(true)
        if (surpriseTimerRef.current) clearTimeout(surpriseTimerRef.current)
        surpriseTimerRef.current = setTimeout(() => {
            setSurpriseSpinning(false)
            const pick = pool[Math.floor(Math.random() * pool.length)]
            const id = itemIdFromCanonical(pick.id)
            setDetailItem({
                itemId: id,
                type: pick.type === 'series' || pick.type === 'anime' ? 'series' : pick.type,
                name: pick.title,
                poster: pick.poster,
                genres: pick.genres,
                year: pick.year,
                voteAverage: pick.voteAverage,
                backdrop: pick.backdrop,
            })
        }, 700)
    }, [recsResult, discoveryPrefs.dismissedItems])

    // ── Hero item: first item of highest-confidence rail ───────────────────
    const heroItems = useMemo((): HeroItem[] => {
        if (!recsResult || recsResult.rails.length === 0) return []
        const seen = new Set<string>()
        const items: HeroItem[] = []
        for (const rail of recsResult.rails) {
            if (items.length >= 5) break
            const item = rail.items[0]
            if (!item) continue
            const id = itemIdFromCanonical(item.id)
            if (seen.has(id)) continue
            seen.add(id)
            const maxScore = Math.max(...rail.items.map(i => i.score), 0.001)
            items.push({
                title: item.title,
                backdrop: item.backdrop,
                poster: item.poster,
                year: item.year,
                genres: item.genres,
                voteAverage: item.voteAverage,
                itemId: id,
                type: item.type,
                confidence: item.score / maxScore,
            })
        }
        return items
    }, [recsResult])

    const heroItem = heroItems[heroIndex] ?? heroItems[0] ?? null

    useEffect(() => {
        if (heroPaused || heroItems.length <= 1) return
        const timer = setTimeout(() => {
            setHeroIndex(i => (i + 1) % heroItems.length)
        }, 8000)
        return () => clearTimeout(timer)
    }, [heroIndex, heroPaused, heroItems.length])

    useEffect(() => {
        if (heroIndex >= heroItems.length) setHeroIndex(0)
    }, [heroItems.length, heroIndex])

    return (
        <WorkspaceTabs value={subTab} panelValue={subTab} onValueChange={v => setSubTab(v as 'unified' | 'accounts')} label="For You views" contentClassName="space-y-4 sm:space-y-6 overflow-x-hidden" tabs={<>
                    <TabsTrigger value="unified">Discover</TabsTrigger>
                    <TabsTrigger value="accounts">Accounts</TabsTrigger>
        </>}>

            <ToolbarShell contentClassName="gap-2 sm:gap-3">
                <div className="w-full sm:w-80 shrink-0 min-w-0">
                    <button
                        type="button"
                        aria-haspopup="dialog"
                        onClick={() => setSearchOpen(true)}
                        className="flex h-11 sm:h-8 w-full cursor-pointer items-center gap-2 rounded-md border border-border/40 bg-muted/30 pl-3 pr-3 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                        <Search className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate">Search movies, series, anime, people…</span>
                    </button>
                </div>
                <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:flex-wrap sm:items-center sm:ml-auto sm:gap-2">
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={handleReload}
                        disabled={recsLoading || historyLoading}
                        className="h-8 gap-1.5 text-xs font-medium"
                    >
                        <RefreshCw className={recsLoading ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
                        Refresh
                    </Button>
                    {hasHistory && hasPmdbKey && (
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
                    {hasHistory && !hasPmdbKey && (
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

            {showBuildingSkeleton && (
                <OperationProgress
                    status="running"
                    current={0}
                    total={0}
                    label="Building Your Recommendations"
                    detail="Analyzing watch history and taste profile"
                />
            )}

            {subTab === 'accounts' ? (
                <div className="space-y-4 pt-2">
                    <div data-theme-part="card" className="rounded-2xl border border-border/40 bg-card/40 p-3 shadow-sm">
                    <div className="grid grid-cols-1 gap-3 sm:gap-4 sm:grid-cols-2 lg:grid-cols-3">
                        {accountStats.map(({ account, topGenres }) => (
                            <div
                                key={account.id}
                                role="button"
                                tabIndex={0}
                                data-theme-part="card"
                                onClick={() => onAccountClick?.(account.id)}
                                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onAccountClick?.(account.id) } }}
                                className="group relative flex h-full cursor-pointer flex-col rounded-[1.35rem] border border-border/45 bg-card/80 shadow-sm transition-[background-color,border-color,box-shadow,transform,opacity] duration-200 hover:-translate-y-0.5 hover:border-border/70 hover:bg-card/95 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                            >
                                <div className="flex items-center justify-between px-4 pb-3 pt-4">
                                    <div className="flex items-center gap-3 flex-1 min-w-0">
                                        <AccountAvatar account={account} size="lg" />
                                        <div className="min-w-0 flex-1">
                                            <p className="truncate text-sm font-bold text-foreground">
                                                {maskNameLevel(account.name || account.email?.split('@')[0] || 'Account', namePrivacy)}
                                            </p>
                                        </div>
                                    </div>
                                    <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground/50 transition-all group-hover:translate-x-0.5 group-hover:text-primary" />
                                </div>

                                {topGenres.length > 0 && (
                                    <div className="flex flex-wrap gap-1.5 px-3 sm:px-4 pb-3">
                                        {topGenres.map(genre => (
                                            <span key={genre} data-theme-part="badge" className="rounded-md border border-border/40 bg-muted/30 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                                                {genre}
                                            </span>
                                        ))}
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                    </div>
                </div>
            ) : (
                <>
            <div
                className="relative"
                onMouseEnter={() => setHeroPaused(true)}
                onMouseLeave={() => setHeroPaused(false)}
            >
            <ForYouHero
                item={heroItem}
                loading={showInitialSkeleton || showBuildingSkeleton}
                onMoreInfo={heroItem ? () => setDetailItem({
                    itemId: heroItem.itemId!,
                    type: heroItem.type!,
                    name: heroItem.title,
                    poster: heroItem.poster,
                    genres: heroItem.genres,
                    year: heroItem.year,
                    voteAverage: heroItem.voteAverage,
                    backdrop: heroItem.backdrop,
                }) : undefined}
                onSurpriseMe={recsResult && recsResult.rails.length > 0 ? handleSurpriseMe : undefined}
                surpriseSpinning={surpriseSpinning}
            />

            {heroItems.length > 1 && !showInitialSkeleton && !showBuildingSkeleton && (
                <>
                    <button
                        type="button"
                        data-theme-part="button"
                        onClick={() => setHeroIndex(i => (i - 1 + heroItems.length) % heroItems.length)}
                        className="absolute left-3 top-1/2 z-20 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full border border-white/20 bg-black/50 text-white shadow-lg backdrop-blur-md transition-all hover:bg-black/70 hover:scale-105"
                        aria-label="Previous"
                    >
                        <ChevronLeft className="h-5 w-5" />
                    </button>
                    <button
                        type="button"
                        data-theme-part="button"
                        onClick={() => setHeroIndex(i => (i + 1) % heroItems.length)}
                        className="absolute right-3 top-1/2 z-20 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full border border-white/20 bg-black/50 text-white shadow-lg backdrop-blur-md transition-all hover:bg-black/70 hover:scale-105"
                        aria-label="Next"
                    >
                        <ChevronRight className="h-5 w-5" />
                    </button>
                    <div className="absolute bottom-3 left-1/2 z-20 flex -translate-x-1/2 gap-1.5">
                        {heroItems.map((_, i) => (
                            <button
                                key={i}
                                type="button"
                                data-theme-part="tab"
                                data-state={i === heroIndex ? 'active' : 'inactive'}
                                onClick={() => setHeroIndex(i)}
                                className={cn(
                                    'h-1.5 rounded-full transition-all',
                                    i === heroIndex ? 'w-6 bg-white' : 'w-1.5 bg-white/40 hover:bg-white/60'
                                )}
                                aria-label={`Go to slide ${i + 1}`}
                            />
                        ))}
                    </div>
                </>
            )}
            </div>

            {(showInitialSkeleton || showBuildingSkeleton) && (
                <div className="space-y-8">
                    <ContentRailSkeleton />
                    <ContentRailSkeleton />
                    <ContentRailSkeleton />
                </div>
            )}

            {popularFallbackNotice && showRails && (
                <div className="flex items-center gap-2 rounded-xl border border-border/40 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                    <Info className="h-3.5 w-3.5 shrink-0" />
                    Personalized recommendations are unavailable right now. Showing popular titles instead.
                </div>
            )}

            {showError && (
                <div data-theme-part="panel" data-theme-tone="status" className="rounded-2xl border border-destructive/40 bg-destructive/5 p-4">
                            <div className="flex items-start gap-3">
                                <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
                                <div className="flex-1">
                                    <p className="font-medium text-destructive">Recommendations failed to load</p>
                                    <p className="mt-0.5 text-sm text-muted-foreground">{recsError}</p>
                                </div>
                                <Button variant="outline" size="sm" onClick={handleReload}>Retry</Button>
                            </div>
                        </div>
                    )}

                    {showRails && (
                        <div className="space-y-8">
                            {(() => {
                                const hasAny = buckets.movies.length > 0 || buckets.series.length > 0 || buckets.anime.length > 0 || enrichedWatchlist.length > 0
                                if (!hasAny) {
                                    return (
                                        <div className="rounded-2xl border border-border/40 bg-card/50 p-8 text-center">
                                            <Sparkles className="mx-auto mb-3 h-8 w-8 text-muted-foreground/40" />
                                            <p className="font-medium">No recommendations yet</p>
                                            <p className="mt-1 text-sm text-muted-foreground">
                                                Start watching content on your connected accounts to unlock personalized recommendations.
                                            </p>
                                            <Link to="/saved-addons#discover" className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-primary hover:underline">
                                                Browse addons to get started
                                            </Link>
                                        </div>
                                    )
                                }
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
                                            <ContentRail title="Watchlist" icon={<Bookmark className="h-4 w-4" />}>
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
                                            <ContentRail title="Movies" subtitle={isColdStart ? 'Trending now' : 'Recommended for your household'} showGridToggle>
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
                                            <ContentRail title="Series" subtitle={isColdStart ? 'Trending now' : 'Recommended for your household'} showGridToggle>
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
                                            <ContentRail title="Anime" subtitle={isColdStart ? 'Trending now' : 'Recommended for your household'} showGridToggle>
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

            <DiscoveryPreferencesModal open={catalogOpen} onOpenChange={setCatalogOpen} />

            <PublishToPmdbDialog
                open={pmdbDialogOpen}
                onOpenChange={setPmdbDialogOpen}
                scope="household"
                scopeLabel="Household"
                rails={pmdbRails}
            />

            <SearchDialog
                open={searchOpen}
                onOpenChange={setSearchOpen}
                onResultClick={(result) => {
                    setDetailItem({
                        itemId: result.id,
                        type: result.type,
                        name: result.name,
                        poster: result.poster,
                        backdrop: result.backdrop,
                        year: result.year ? parseInt(result.year, 10) : undefined,
                        voteAverage: result.voteAverage,
                    })
                }}
            />

            {detailModalSeen && (
            <Suspense fallback={null}>
            <ActivityDetailModal
                open={detailItem !== null}
                onOpenChange={(open: boolean) => { if (!open) { setDetailItem(null); refreshWatchlist() } }}
                item={detailItem}
            />
            </Suspense>
            )}
        </WorkspaceTabs>
    )
}
