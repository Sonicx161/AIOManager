import { useState, useEffect, useCallback, useRef, useMemo, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, ArrowRight, ChevronUp, ChevronDown, ChevronLeft, ChevronRight, Calendar, Clock, Clapperboard, Film, ExternalLink, Image as ImageIcon, Eye, RotateCcw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { fetchEpisodeDetail, type EpisodeDetail } from '@/api/metadata/adapters/tmdb'
import { CastSection, type CastSectionPerson, type CastSectionCrew } from '@/components/activity/detail/CastSection'
import { LightboxViewer } from '@/components/activity/detail/LightboxViewer'
import { RatingBadge, type ProviderRating } from '@/components/activity/detail/RatingBadge'
import { fetchAdditionalRatings } from '@/lib/ratings'
import { useWatchEventStore } from '@/store/watchEventStore'
import { useAccountStore } from '@/store/accountStore'
import { useUIStore } from '@/store/uiStore'
import { AccountAvatar } from '@/components/accounts/AccountAvatar'
import { maskedDisplayName } from '@/components/common/AccountSwitcher'
import { Tooltip } from '@/components/ui/tooltip'
import { PinnedBarMaterial } from '@/components/activity/detail/bar-material'
import { heroCollapseState, type HeroCollapseGeometry } from '@/components/activity/detail/hero-collapse'
import type { EpisodeWatcherIndex } from '@/lib/episode-watchers'

export interface EpisodeDetailPageProps {
    seriesName: string
    seasonNumber: number
    episodeNumber: number
    episodeName: string
    episodeOverview?: string
    airDate?: string
    still?: string
    seriesTmdbId: number | null
    seriesImdbId?: string
    isAnime?: boolean
    isLight: boolean
    maxEpisodesInSeason?: number | null
    hasPrevSeason?: boolean
    hasNextSeason?: boolean
    onPersonClick: (person: { name: string; photo?: string }, role: string) => void
    onAccountClick?: (accountId: string) => void
    /** Household completion evidence shared with the series episode list. */
    episodeWatchers?: EpisodeWatcherIndex
    onGoBack: () => void
    onGoForward?: () => void
    canForward?: boolean
    onClose: () => void
    onNavigateEpisode?: (seasonNumber: number, episodeNumber: number) => void
}

export function EpisodeDetailPage({
    seriesName,
    seasonNumber,
    episodeNumber,
    episodeName,
    episodeOverview,
    airDate,
    still,
    seriesTmdbId,
    seriesImdbId,
    isAnime = false,
    isLight,
    maxEpisodesInSeason,
    hasPrevSeason,
    hasNextSeason,
    onPersonClick,
    onAccountClick,
    episodeWatchers,
    onGoBack,
    onGoForward,
    canForward = false,
    onClose,
    onNavigateEpisode,
}: EpisodeDetailPageProps) {
    const [detail, setDetail] = useState<EpisodeDetail | null>(null)
    const [loading, setLoading] = useState(false)
    const [fetchFailed, setFetchFailed] = useState(false)
    const [retryCount, setRetryCount] = useState(0)
    const [ratingsPartial, setRatingsPartial] = useState(false)
    const [synopsisExpanded, setSynopsisExpanded] = useState(false)
    const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
    const [lightboxZoom, setLightboxZoom] = useState(false)
    const [providerRatings, setProviderRatings] = useState<ProviderRating[]>([])
    const scrollGalleryRef = useRef<HTMLDivElement>(null)
    // Pinned bar machinery, shared with the title sheet and the person view.
    const episodeBarRef = useRef<HTMLDivElement>(null)
    const episodeBarTitleRef = useRef<HTMLParagraphElement>(null)
    const episodeScrollRef = useRef<HTMLDivElement>(null)
    const episodeHeroRef = useRef<HTMLDivElement>(null)
    const episodeHeroTitleRef = useRef<HTMLDivElement>(null)
    const episodeStickyRef = useRef<HTMLDivElement>(null)
    const joinedRef = useRef(false)
    const [barJoined, setBarJoined] = useState(false)
    const [barTitleShown, setBarTitleShown] = useState(false)

    useEffect(() => {
        setDetail(null)
        setSynopsisExpanded(false)
        setProviderRatings([])
        setFetchFailed(false)
        setRatingsPartial(false)

        let active = true

        if (seriesImdbId?.startsWith('tt')) {
            let ratingsOk = false
            fetchAdditionalRatings(seriesImdbId)
                .then(extra => {
                    if (!active) return
                    if (extra.length > 0) {
                        ratingsOk = true
                        setProviderRatings(extra)
                    }
                })
                .catch(() => {})
                .finally(() => { if (active && !ratingsOk) setRatingsPartial(true) })
        }

        if (!seriesTmdbId) {
            setLoading(false)
            return
        }
        setLoading(true)
        fetchEpisodeDetail(seriesTmdbId, seasonNumber, episodeNumber)
            .then(d => {
                if (!active) return
                if (d) setDetail(d)
                else setFetchFailed(true)
            })
            .catch(() => { if (active) setFetchFailed(true) })
            .finally(() => { if (active) setLoading(false) })

        return () => { active = false }
    }, [seriesTmdbId, seriesImdbId, seasonNumber, episodeNumber, retryCount])

    const heroStill = detail?.still || still
    const displayName = detail?.name || episodeName || `Episode ${episodeNumber}`
    const overview = detail?.overview || episodeOverview
    const voteAverage = detail?.voteAverage
    const voteCount = detail?.voteCount
    const runtime = detail?.runtime
    const imdbId = detail?.imdbId
    const productionCode = detail?.productionCode

    const galleryImages = (detail?.images ?? []).map(img => img.url)

    const castForSection: CastSectionPerson[] = (detail?.cast ?? []).map(c => ({
        name: c.name,
        character: c.character,
        photo: c.photo,
    }))

    const crewForSection: CastSectionCrew[] = (detail?.crew ?? []).map(c => ({
        name: c.name,
        role: c.job || c.department,
        photo: c.photo,
    }))

    const ratings: ProviderRating[] = [...providerRatings]
    if (voteAverage != null && voteAverage > 0 && !ratings.some(r => r.source === 'tmdb')) {
        ratings.push({ source: 'tmdb', value: voteAverage.toFixed(1), votes: voteCount?.toLocaleString() })
    }

    const heroFrostedBtn = isLight
        ? 'border-border bg-card/80 text-foreground hover:bg-card'
        : 'border-white/15 bg-white/10 text-white/90 hover:bg-white/25'

    const fmtDate = useCallback((d?: string) => {
        if (!d) return null
        const date = new Date(d)
        if (isNaN(date.getTime())) return null
        return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    }, [])

    const events = useWatchEventStore(s => s.events)
    const accounts = useAccountStore(s => s.accounts)
    const visibleAccounts = useMemo(() => new Map(accounts.filter(account => !account.hideLastWatched).map(account => [account.id, account])), [accounts])
    const isPrivacyModeEnabled = useUIStore(s => s.isPrivacyModeEnabled)
    const privacyLevelNames = useUIStore(s => s.privacyLevelNames)

    const episodeWatchStats = useMemo(() => {
        const sharedWatchers = (episodeWatchers?.get(seasonNumber)?.get(episodeNumber) ?? [])
            .filter(watcher => visibleAccounts.has(watcher.id))
        const exact = events.filter(e =>
            !!seriesImdbId && visibleAccounts.has(e.accountId) &&
            e.itemId === seriesImdbId &&
            e.season === seasonNumber &&
            e.episode === episodeNumber
        )
        // Anime entries often store absolute numbering with a flat season while
        // TMDB splits them into real seasons; when the exact match is empty,
        // fall back to matching the episode number across seasons.
        const matches = exact.length > 0 || !isAnime
            ? exact
            : events.filter(e => !!seriesImdbId && visibleAccounts.has(e.accountId) && e.itemId === seriesImdbId && e.episode === episodeNumber)
        if (matches.length === 0 && sharedWatchers.length === 0) return null
        const accountIds = new Set([
            ...sharedWatchers.map(watcher => watcher.id),
            ...matches.map(e => e.accountId),
        ])
        const totalTime = matches.reduce((sum, e) => sum + (e.backfill ? 0 : e.time_watched || 0), 0)
        // Recovered watches and the shared avatar ordering carry observation times,
        // not watch dates. Only dated events can populate the date label.
        const latest = matches.reduce((max, e) => e.backfill ? max : Math.max(max, e.event_ts || 0), 0)
        return {
            count: matches.length,
            accountIds: Array.from(accountIds),
            totalTimeMs: totalTime,
            latestTs: latest > 0 ? new Date(latest) : null,
        }
    }, [events, episodeWatchers, visibleAccounts, seriesImdbId, seasonNumber, episodeNumber, isAnime])

    // Pinned-bar scroll effect: same handoff as the title sheet (hero title fades out,
    // then the bar title fades in; the Watch Activity header joins the bar when stuck).
    const heroTitleFadeStyle: CSSProperties = { opacity: 'var(--tt-o, 1)' }
    useEffect(() => {
        const scroller = episodeScrollRef.current
        const bar = episodeBarRef.current
        if (!scroller || !bar) return
        setBarJoined(false)
        joinedRef.current = false
        delete bar.dataset.joined
        let geo: HeroCollapseGeometry = {
            barHeight: bar.offsetHeight,
            barTitleTop: 0,
            barTitleHeight: 0,
            heroBottom: 0,
            heroTitleTop: 0,
            heroTitleHeight: 0,
            actionsBottom: Number.POSITIVE_INFINITY,
        }
        let frame = 0
        const scrollerTop = () => scroller.getBoundingClientRect().top - scroller.scrollTop
        const offsetIn = (el: HTMLElement) => el.getBoundingClientRect().top - scrollerTop()
        const pinnedTop = (el: HTMLElement) => el.getBoundingClientRect().top - scroller.getBoundingClientRect().top
        const measure = () => {
            const barTitle = episodeBarTitleRef.current
            const block = episodeHeroTitleRef.current
            const text = block?.firstElementChild instanceof HTMLElement ? block.firstElementChild : null
            const textRect = text ? text.getBoundingClientRect() : null
            const hero = episodeHeroRef.current
            geo = {
                barHeight: bar.offsetHeight,
                barTitleTop: barTitle ? pinnedTop(barTitle) : 0,
                barTitleHeight: barTitle ? barTitle.getBoundingClientRect().height : 0,
                heroBottom: hero ? offsetIn(hero) + hero.getBoundingClientRect().height : 0,
                heroTitleTop: textRect ? offsetIn(text!) : 0,
                heroTitleHeight: textRect ? textRect.height : 0,
                actionsBottom: Number.POSITIVE_INFINITY,
            }
        }
        const apply = () => {
            frame = 0
            const f = heroCollapseState(scroller.scrollTop, geo)
            bar.style.setProperty('--bar-bg', String(f.bg))
            bar.style.setProperty('--bar-title', String(f.barTitleOpacity))
            const sticky = episodeStickyRef.current
            const joined = !!sticky && sticky.getBoundingClientRect().top - bar.getBoundingClientRect().bottom < 1
            if ((bar.dataset.joined === 'true') !== joined) bar.dataset.joined = joined ? 'true' : 'false'
            if (joined !== joinedRef.current) {
                joinedRef.current = joined
                setBarJoined(joined)
            }
            episodeHeroTitleRef.current?.style.setProperty('--tt-o', String(f.heroTitleOpacity))
            const next = f.barTitleOpacity > 0.5
            setBarTitleShown(prev => (prev === next ? prev : next))
        }
        const onScroll = () => { if (!frame) frame = requestAnimationFrame(apply) }
        measure()
        apply()
        scroller.addEventListener('scroll', onScroll, { passive: true })
        const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
            if (frame) cancelAnimationFrame(frame)
            measure()
            apply()
        })
        ro?.observe(scroller)
        if (scroller.firstElementChild) ro?.observe(scroller.firstElementChild)
        return () => {
            scroller.removeEventListener('scroll', onScroll)
            ro?.disconnect()
            if (frame) cancelAnimationFrame(frame)
        }
    }, [displayName, loading, detail])

    return (
        <div className="flex h-[92vh] sm:h-[88vh] flex-col overflow-hidden bg-card text-card-foreground">
            {/* pt-0.5 keeps scrolled content off the sheet's top edge row, mirroring the title sheet. */}
            <div className="relative flex min-h-0 flex-1 flex-col pt-0.5">
                {/* Pinned episode bar: Back/Forward, prev/next, SxxExx + name, Close */}
                <div
                    ref={episodeBarRef}
                    data-episode-bar=""
                    className="group/bar pointer-events-none absolute inset-x-0 top-0 z-40 flex h-14 items-center gap-1 pl-2 pr-3 sm:pl-3"
                    style={{ '--bar-bg': 0, '--bar-title': 0 } as CSSProperties}
                >
                    <PinnedBarMaterial />
                    <div className="relative flex shrink-0 items-center gap-1">
                        <button
                            type="button"
                            data-theme-part="button"
                            onClick={onGoBack}
                            aria-label={`Back to ${seriesName}`}
                            className={cn('pointer-events-auto relative flex h-11 w-11 items-center justify-center rounded-full border shadow-lg backdrop-blur-md transition-all hover:scale-105 active:scale-95 motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 sm:h-9 sm:w-9', heroFrostedBtn)}
                        >
                            <ArrowLeft className="h-4 w-4" />
                            <span className="sr-only">Back to {seriesName}</span>
                        </button>
                        <button
                            type="button"
                            data-theme-part="button"
                            onClick={onGoForward}
                            disabled={!canForward}
                            aria-label="Forward"
                            className={cn('pointer-events-auto relative flex h-11 w-11 items-center justify-center rounded-full border shadow-lg backdrop-blur-md transition-all hover:scale-105 active:scale-95 motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-35 sm:h-9 sm:w-9', heroFrostedBtn)}
                        >
                            <ArrowRight className="h-4 w-4" />
                            <span className="sr-only">Forward</span>
                        </button>
                    </div>

                    {onNavigateEpisode && (
                        <div className="relative flex shrink-0 items-center gap-1">
                            <button
                                type="button"
                                data-theme-part="button"
                                data-bar-prev=""
                                onClick={() => {
                                    if (episodeNumber > 1) {
                                        onNavigateEpisode(seasonNumber, episodeNumber - 1)
                                    } else if (hasPrevSeason) {
                                        onNavigateEpisode(seasonNumber - 1, -1)
                                    }
                                }}
                                disabled={episodeNumber <= 1 && !hasPrevSeason}
                                className={cn('pointer-events-auto relative flex h-11 w-11 items-center justify-center rounded-full border shadow-md backdrop-blur-md transition-all hover:scale-110 active:scale-95 disabled:pointer-events-none disabled:opacity-30 sm:h-9 sm:w-9', heroFrostedBtn)}
                                aria-label="Previous episode"
                            >
                                <ChevronLeft className="h-4 w-4" />
                            </button>
                            <button
                                type="button"
                                data-theme-part="button"
                                data-bar-next=""
                                onClick={() => {
                                    if (maxEpisodesInSeason != null && episodeNumber >= maxEpisodesInSeason) {
                                        if (hasNextSeason) onNavigateEpisode(seasonNumber + 1, 1)
                                    } else {
                                        onNavigateEpisode(seasonNumber, episodeNumber + 1)
                                    }
                                }}
                                disabled={maxEpisodesInSeason != null && episodeNumber >= maxEpisodesInSeason && !hasNextSeason}
                                className={cn('pointer-events-auto relative flex h-11 w-11 items-center justify-center rounded-full border shadow-md backdrop-blur-md transition-all hover:scale-110 active:scale-95 disabled:pointer-events-none disabled:opacity-30 sm:h-9 sm:w-9', heroFrostedBtn)}
                                aria-label="Next episode"
                            >
                                <ChevronRight className="h-4 w-4" />
                            </button>
                        </div>
                    )}

                    {/* SxxExx + name fade in after the large title fades out; the still shows at wider widths */}
                    <div aria-hidden={!barTitleShown} className="relative flex min-w-0 flex-1 items-center gap-2">
                        <div
                            data-bar-thumb=""
                            className="relative hidden h-7 w-12 shrink-0 overflow-hidden rounded-md bg-muted ring-1 ring-border/40 sm:block"
                            style={{ opacity: 'var(--bar-title)', transform: 'scale(calc(0.85 + 0.15 * var(--bar-title)))' } as CSSProperties}
                        >
                            {heroStill ? (
                                <img src={heroStill} alt="" className="h-full w-full object-cover" loading="lazy" />
                            ) : (
                                <div className="flex h-full w-full items-center justify-center">
                                    <Clapperboard className="h-3.5 w-3.5 text-muted-foreground/40" />
                                </div>
                            )}
                        </div>
                        <p ref={episodeBarTitleRef} data-bar-title="" className="min-w-0 flex-1 truncate text-xs font-bold text-foreground sm:text-sm" style={{ opacity: 'var(--bar-title)' }}>
                            <span className="text-primary">S{seasonNumber} E{episodeNumber}</span>
                            <span className="ml-1.5">{displayName}</span>
                        </p>
                    </div>

                    <button
                        type="button"
                        data-theme-part="button"
                        onClick={onClose}
                        aria-label="Close"
                        className={cn('pointer-events-auto relative flex h-11 w-11 shrink-0 items-center justify-center rounded-full border shadow-md backdrop-blur-sm transition-all hover:scale-105 active:scale-95 motion-reduce:transition-none motion-reduce:hover:scale-100 focus-visible:outline-none focus-visible:ring-2 sm:h-9 sm:w-9', isLight ? 'border-border/60 bg-card/90 text-foreground hover:bg-muted focus-visible:ring-ring/40' : 'border-white/15 bg-black/50 text-white/90 hover:bg-black/75 focus-visible:ring-white/40')}
                    >
                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                        <span className="sr-only">Close</span>
                    </button>
                </div>

                <div ref={episodeScrollRef} className="scrollbar-hide min-h-0 flex-1 overflow-y-auto overscroll-contain" data-detail-scroll="">
                    <div className="overflow-x-clip">
            {/* ── HEADER (scrolls; the pinned bar replaces it) ─────────────────── */}
            <div className={cn('relative px-4 pb-4 pt-14 sm:px-8 sm:pb-5 sm:pt-[60px]', isLight ? 'bg-muted/50 text-foreground' : 'bg-card text-white')}>
                {/* Episode still + info */}
                <div ref={episodeHeroRef} className="flex items-start gap-3 sm:gap-6">
                    <div className="relative h-20 w-32 shrink-0 overflow-hidden rounded-xl border border-primary/40 bg-muted shadow-2xl sm:h-24 sm:w-40">
                        {heroStill ? (
                            <img src={heroStill} alt={displayName} className="h-full w-full object-cover" />
                        ) : (
                            <div className="flex h-full w-full items-center justify-center bg-muted">
                                <Clapperboard className="h-8 w-8 text-muted-foreground/40" />
                            </div>
                        )}
                    </div>

                    <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                            <span data-theme-part="badge" className="rounded-md bg-primary/85 px-2 py-0.5 text-[11px] font-bold uppercase tracking-widest text-primary-foreground">
                                S{seasonNumber} E{episodeNumber}
                            </span>
                            {productionCode && (
                                <span data-theme-part="badge" className={cn('rounded-md border px-2 py-0.5 text-[10px] font-medium', isLight ? 'border-border bg-card text-muted-foreground' : 'border-white/15 bg-white/5 text-white/60')}>
                                    {productionCode}
                                </span>
                            )}
                        </div>
                        <div ref={episodeHeroTitleRef}>
                            <h2 style={heroTitleFadeStyle} className={cn('mt-1 text-xl font-extrabold tracking-tight sm:text-2xl', isLight ? 'text-foreground' : 'text-white')}>
                                {displayName}
                            </h2>
                        </div>
                        <div className={cn('mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs font-medium', isLight ? 'text-muted-foreground' : 'text-white/80')}>
                            {fmtDate(airDate || detail?.airDate) && (
                                <span className="inline-flex items-center gap-1">
                                    <Calendar className="h-3.5 w-3.5" />
                                    {fmtDate(airDate || detail?.airDate)}
                                </span>
                            )}
                            {runtime != null && (
                                <span className="inline-flex items-center gap-1">
                                    <Clock className="h-3.5 w-3.5" />
                                    {runtime}m
                                </span>
                            )}
                            {voteCount != null && voteCount > 0 && (
                                <span className="inline-flex items-center gap-1">
                                    <Film className="h-3.5 w-3.5" />
                                    {voteCount.toLocaleString()} votes
                                </span>
                            )}
                            {imdbId && (
                                <a href={`https://www.imdb.com/title/${imdbId}/`} target="_blank" rel="noopener noreferrer" className={cn('inline-flex items-center gap-1 transition-colors hover:text-primary', isLight ? 'text-muted-foreground' : 'text-white/60')}>
                                    <ExternalLink className="h-3.5 w-3.5" />
                                    IMDB
                                </a>
                            )}
                            {seriesTmdbId && (
                                <a href={`https://www.themoviedb.org/tv/${seriesTmdbId}/season/${seasonNumber}/episode/${episodeNumber}`} target="_blank" rel="noopener noreferrer" className={cn('inline-flex items-center gap-1 transition-colors hover:text-primary', isLight ? 'text-muted-foreground' : 'text-white/60')}>
                                    <ExternalLink className="h-3.5 w-3.5" />
                                    TMDB
                                </a>
                            )}
                        </div>

                        {/* Rating badges */}
                        {ratings.length > 0 && (
                            <div className="mt-2 flex flex-wrap items-center gap-1.5">
                                {ratings.map(r => <RatingBadge key={r.source} rating={r} />)}
                            </div>
                        )}
                    </div>
                </div>

                {/* Synopsis card */}
                {overview && (
                    <div data-theme-part="panel" className={cn('mt-4 rounded-xl border p-2.5 text-xs leading-relaxed backdrop-blur-sm sm:p-3.5 sm:text-sm', isLight ? 'border-border/40 bg-muted/30 text-muted-foreground' : 'border-white/10 bg-white/5 text-white/90')}>
                        <p className={cn(!synopsisExpanded && 'line-clamp-3 sm:line-clamp-4')}>
                            {overview}
                        </p>
                        {overview.length > 220 && (
                            <button type="button" data-theme-part="button" onClick={() => setSynopsisExpanded(!synopsisExpanded)} className="mt-1.5 inline-flex items-center gap-1 text-xs font-bold text-primary hover:underline">
                                {synopsisExpanded ? <>Show Less <ChevronUp className="h-3 w-3" /></> : <>Read More <ChevronDown className="h-3 w-3" /></>}
                            </button>
                        )}
                    </div>
                )}

                {loading && (
                    <div className={cn('mt-3 flex items-center gap-2 text-xs font-medium', isLight ? 'text-muted-foreground/70' : 'text-white/60')}>
                        <div className="h-3 w-3 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-primary" />
                        Loading episode details...
                    </div>
                )}
            </div>

            {/* ── BODY ────────────────────────────────────────────────────────── */}
            <div className="space-y-6 px-4 py-4 sm:space-y-8 sm:px-6 sm:py-6">
                {/* WATCH ACTIVITY */}
                {episodeWatchStats && (() => {
                    const totalMin = Math.round(episodeWatchStats.totalTimeMs / 60000)
                    const watcherAccounts = episodeWatchStats.accountIds
                        .map(id => visibleAccounts.get(id))
                        .filter(Boolean)
                    return (
                        <>
                            {/* Sticks under the pinned bar and joins it, like the episodes header on the title sheet.
                                A direct child of the body so it can stay stuck across the whole scroll. */}
                            <div
                                ref={episodeStickyRef}
                                data-episode-sticky=""
                                data-joined={barJoined ? 'true' : undefined}
                                className={cn(
                                    'sticky top-[3.25rem] z-20 -mx-4 flex items-center gap-2 px-4 pb-2.5 pt-3 text-xs font-bold uppercase tracking-widest sm:-mx-6 sm:px-6',
                                    barJoined
                                        ? 'border-b border-[color:var(--chrome-line)] bg-card text-foreground/80 shadow-[0_10px_24px_-12px_rgba(0,0,0,0.45)]'
                                        : 'border-b border-border/50 bg-card text-muted-foreground/80',
                                )}
                            >
                                <Eye className="h-3.5 w-3.5 shrink-0 text-primary" />
                                Watch Activity
                            </div>
                            <div className="mb-6 flex flex-wrap items-center gap-3 sm:mb-8">
                                {watcherAccounts.length > 0 && (
                                    <div className="flex items-center -space-x-2">
                                        {watcherAccounts.slice(0, 8).map((acc) => {
                                            const maskedName = maskedDisplayName(acc!.name, acc!.email, isPrivacyModeEnabled ? privacyLevelNames : 0)
                                            return (
                                                <Tooltip key={acc!.id} content={maskedName}>
                                                    <button
                                                        type="button"
                                                        aria-label={maskedName}
                                                        onClick={onAccountClick ? () => onAccountClick(acc!.id) : undefined}
                                                        className={cn(
                                                            'relative flex h-9 w-9 items-center justify-center rounded-full border-2 border-background bg-card overflow-hidden transition-transform',
                                                            onAccountClick && 'hover:scale-110 hover:z-10'
                                                        )}
                                                    >
                                                        <AccountAvatar
                                                            account={{ ...acc!, name: maskedName }}
                                                            size="md"
                                                            showStatus={false}
                                                            className="!h-full !w-full rounded-full"
                                                        />
                                                    </button>
                                                </Tooltip>
                                            )
                                        })}
                                        {watcherAccounts.length > 8 && (
                                            <span className="pl-3 text-xs text-muted-foreground/60">+{watcherAccounts.length - 8}</span>
                                        )}
                                    </div>
                                )}
                                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                                    <span className="inline-flex items-center gap-1">
                                        <Eye className="h-3 w-3" />
                                        {episodeWatchStats.count > 0
                                            ? `${episodeWatchStats.count} watch${episodeWatchStats.count === 1 ? '' : 'es'}`
                                            : 'Watched'}
                                    </span>
                                    {totalMin > 0 && (
                                        <span className="inline-flex items-center gap-1">
                                            <Clock className="h-3 w-3" />
                                            {totalMin < 60 ? `${totalMin}m` : `${Math.floor(totalMin / 60)}h ${totalMin % 60}m`}
                                        </span>
                                    )}
                                    {episodeWatchStats.latestTs && (
                                        <span className="inline-flex items-center gap-1">
                                            <Calendar className="h-3 w-3" />
                                            {episodeWatchStats.latestTs.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                                        </span>
                                    )}
                                </div>
                            </div>
                        </>
                    )
                })()}

                {/* GALLERY (matches main modal pattern with scroll buttons) */}
                {galleryImages.length > 0 && (
                    <div>
                        <div className="mb-2 flex items-center justify-between">
                            <h3 className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-muted-foreground/80">
                                <ImageIcon className="h-3.5 w-3.5 text-primary" />
                                Gallery
                            </h3>
                            <div className="flex items-center gap-1">
                                <button type="button" data-theme-part="button" onClick={() => scrollGalleryRef.current?.scrollBy({ left: -320, behavior: 'smooth' })} aria-label="Scroll gallery left" className="flex h-7 w-7 items-center justify-center rounded-full border border-border/40 bg-muted/60 text-muted-foreground shadow-sm transition-all hover:bg-accent hover:text-foreground active:scale-95">
                                    <ChevronLeft className="h-4 w-4" />
                                </button>
                                <button type="button" data-theme-part="button" onClick={() => scrollGalleryRef.current?.scrollBy({ left: 320, behavior: 'smooth' })} aria-label="Scroll gallery right" className="flex h-7 w-7 items-center justify-center rounded-full border border-border/40 bg-muted/60 text-muted-foreground shadow-sm transition-all hover:bg-accent hover:text-foreground active:scale-95">
                                    <ChevronRight className="h-4 w-4" />
                                </button>
                            </div>
                        </div>
                        <div ref={scrollGalleryRef} className="scrollbar-hide -mx-1 flex gap-2 overflow-x-auto px-1 pb-1 scroll-smooth">
                            {galleryImages.map((img, i) => (
                                <button key={i} type="button" onClick={() => { setLightboxIndex(i); setLightboxZoom(false) }} className="group relative aspect-video w-48 shrink-0 overflow-hidden rounded-lg border border-border/30 bg-muted shadow-sm transition-all hover:border-border/60 hover:shadow-md sm:w-64">
                                    <img src={img} alt="" loading="lazy" className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105" />
                                    <div className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-all group-hover:bg-black/20 group-hover:opacity-100">
                                        <span className="rounded-full bg-black/60 px-2 py-1 text-[10px] font-bold text-white backdrop-blur-sm">Expand</span>
                                    </div>
                                </button>
                            ))}
                        </div>
                    </div>
                )}

                {/* CAST + CREW (reusing CastSection component) */}
                {!loading && (castForSection.length > 0 || crewForSection.length > 0) && (
                    <CastSection
                        cast={castForSection}
                        crew={crewForSection}
                        isLight={isLight}
                        onPersonClick={onPersonClick}
                    />
                )}

                {/* ERROR STATE */}
                {!loading && fetchFailed && (
                    <div className="flex h-64 flex-col items-center justify-center text-center gap-3">
                        <Clapperboard className="h-10 w-10 mb-2 text-muted-foreground/40" />
                        <p className="text-sm font-medium text-muted-foreground">Couldn't reach the metadata service.</p>
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setRetryCount(c => c + 1)}
                            className="gap-1.5"
                        >
                            <RotateCcw className="h-3.5 w-3.5" />
                            Retry
                        </Button>
                    </div>
                )}

                {/* EMPTY STATE */}
                {!loading && !fetchFailed && castForSection.length === 0 && !overview && galleryImages.length === 0 && (
                    <div className="flex h-64 flex-col items-center justify-center text-center">
                        <Clapperboard className="h-10 w-10 mb-2 text-muted-foreground/40" />
                        <p className="text-sm font-medium text-muted-foreground">No detailed information available for this episode.</p>
                        {ratingsPartial && (
                            <p className="mt-1 text-xs text-muted-foreground/60">Ratings may be partially unavailable.</p>
                        )}
                    </div>
                )}

                {/* DEV NOTICE */}
                {!seriesTmdbId && !loading && import.meta.env?.DEV && (
                    <div data-theme-part="panel" data-theme-tone="status" className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs text-warning">
                        No TMDB ID available. Episode enrichment data requires a TMDB ID.
                    </div>
                )}
            </div>
                    </div>
                </div>
            </div>

            {/* LIGHTBOX (portaled to document.body to escape Dialog transform context) */}
            {createPortal(
                <LightboxViewer
                    images={galleryImages}
                    index={lightboxIndex}
                    zoom={lightboxZoom}
                    onClose={() => { setLightboxIndex(null); setLightboxZoom(false) }}
                    onNavigate={(i) => { setLightboxIndex(i); setLightboxZoom(false) }}
                    onToggleZoom={() => setLightboxZoom(z => !z)}
                />,
                document.body
            )}
        </div>
    )
}
