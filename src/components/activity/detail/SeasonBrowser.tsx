import { useState, useEffect, useRef } from 'react'
import { Tv, Play, Check, Calendar, Clock, Star, ChevronRight } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { AccountAvatar } from '@/components/accounts/AccountAvatar'
import { EPISODE_WATCHER_AVATAR_CAP, episodeWatcherLabel, type EpisodeWatcherIndex } from '@/lib/episode-watchers'
import { fetchSeasonEpisodes, fetchSeasonsList, proxyFetch, type SeasonInfo, type EpisodeInfo } from '@/api/metadata/adapters/tmdb'
import { SeasonControl } from '@/components/activity/detail/SeasonControl'
import { shouldUseCompactSeasonPicker, watchedSeasonNumbers } from '@/components/activity/detail/season-picker'
import type { DetailItem } from '@/components/activity/detail/types'

interface SeasonBrowserProps {
    seriesTmdbId: number | null
    activeItem: DetailItem | null
    isLight: boolean
    loading: boolean
    /** Actual watched episodes (real events + verified bitfield recoveries) to mark in the browser. */
    watchedEpisodes?: ReadonlyArray<{ season: number; episode: number }>
    /**
     * Which accounts actually watched each episode (household-wide, same evidence bar
     * as watchedEpisodes). Built once by the caller; rows do O(1) lookups and render a
     * capped, non-interactive avatar stack so the list shows who watched what without
     * opening every episode.
     */
    episodeWatchers?: EpisodeWatcherIndex
    /** True while the header is stuck flush under the pinned bar: it then joins the bar's block. */
    joined?: boolean
    onEpisodeClick?: (data: {
        episodeNumber: number
        episodeName: string
        episodeOverview?: string
        airDate?: string
        still?: string
        seasonNumber: number
        seriesTmdbId: number | null
    }) => void
}

export function SeasonBrowser({ seriesTmdbId, activeItem, isLight, loading, watchedEpisodes, episodeWatchers, joined, onEpisodeClick }: SeasonBrowserProps) {
    const [seasons, setSeasons] = useState<SeasonInfo[]>([])
    const [selectedSeason, setSelectedSeason] = useState<number | null>(null)
    const [episodes, setEpisodes] = useState<EpisodeInfo[]>([])
    const [episodesLoading, setEpisodesLoading] = useState(false)
    const [cinemetaSeasons, setCinemetaSeasons] = useState<SeasonInfo[]>([])
    const [cinemetaEpisodesBySeason, setCinemetaEpisodesBySeason] = useState<Map<number, EpisodeInfo[]>>(new Map())
    const [cinemetaTmdbId, setCinemetaTmdbId] = useState<number | null>(null)
    const [tmdbSeasonsFailed, setTmdbSeasonsFailed] = useState(false)
    const absoluteSeasonRedirectRef = useRef<string | null>(null)

    const effectiveTmdbId = seriesTmdbId ?? cinemetaTmdbId

    // Watched episodes by season (real watch events + verified bitfield recoveries), used to
    // mark every actually-watched episode and to pick a sensible starting season when the
    // active item itself has no episode anchor (imported saved series).
    const watchedBySeason = new Map<number, Set<number>>()
    for (const ep of watchedEpisodes ?? []) {
        if (ep?.season == null || ep?.episode == null) continue
        const set = watchedBySeason.get(ep.season) ?? new Set<number>()
        if (set.size === 0) watchedBySeason.set(ep.season, set)
        set.add(ep.episode)
    }
    const latestWatchedSeason = watchedBySeason.size > 0 ? Math.max(...watchedBySeason.keys()) : null

    useEffect(() => {
        setSeasons([])
        setSelectedSeason(null)
        setEpisodes([])
        setCinemetaTmdbId(null)
        absoluteSeasonRedirectRef.current = null
    }, [activeItem])

    useEffect(() => {
        if (!seriesTmdbId) return
        let active = true
        setTmdbSeasonsFailed(false)
        fetchSeasonsList(seriesTmdbId)
            .then(list => {
                if (!active) return
                const filtered = list.filter(s => s.seasonNumber > 0)
                if (filtered.length === 0) { setTmdbSeasonsFailed(true); return }
                setSeasons(filtered)
                const watched = activeItem?.season ?? latestWatchedSeason
                const target = watched != null && filtered.some(s => s.seasonNumber === watched)
                    ? watched
                    : filtered[0].seasonNumber
                setSelectedSeason(target)
            })
            .catch(() => { if (active) setTmdbSeasonsFailed(true) })
        return () => { active = false }
    }, [seriesTmdbId, activeItem?.season, latestWatchedSeason])

    useEffect(() => {
        if (!seriesTmdbId || selectedSeason === null) return
        let active = true
        const controller = new AbortController()
        setEpisodesLoading(true)
        fetchSeasonEpisodes(seriesTmdbId, selectedSeason, controller.signal)
            .then(eps => {
                if (!active || controller.signal.aborted) return
                setEpisodes(eps)
            })
            .catch(() => { })
            .finally(() => { if (active && !controller.signal.aborted) setEpisodesLoading(false) })
        return () => { active = false; controller.abort() }
    }, [seriesTmdbId, selectedSeason])

    useEffect(() => {
        setCinemetaSeasons([])
        setCinemetaEpisodesBySeason(new Map())
        if (!activeItem) return
        if (seriesTmdbId && !tmdbSeasonsFailed) return
        const isSeries = activeItem.type === 'series' || activeItem.type === 'anime' || activeItem.type === 'episode'
        if (!isSeries) return
        let active = true
        const cinemetaController = new AbortController()
        const cinemetaTimeout = setTimeout(() => cinemetaController.abort(), 8000)
        const fetchCinemeta = (imdb: string) => {
            fetch(`https://cinemeta-live.strem.io/meta/series/${encodeURIComponent(imdb)}.json`, { signal: cinemetaController.signal })
                .then(res => res.ok ? res.json() : null)
                .then(data => {
                    if (!active || !data?.meta?.videos) return
                    if (typeof data.meta.moviedb_id === 'number' && data.meta.moviedb_id > 0) {
                        setCinemetaTmdbId(data.meta.moviedb_id)
                    }
                    const vids: Array<Record<string, unknown>> = data.meta.videos
                    const bySeason = new Map<number, EpisodeInfo[]>()
                    const seasonSet = new Set<number>()
                    for (const v of vids) {
                        const season = typeof v.season === 'number' ? v.season : 1
                        const episode = typeof v.episode === 'number' ? v.episode : typeof v.number === 'number' ? v.number : 0
                        if (season < 1 || episode < 1) continue
                        seasonSet.add(season)
                        const ep: EpisodeInfo = {
                            episodeNumber: episode,
                            name: String(v.name || v.title || `Episode ${episode}`),
                            overview: typeof v.overview === 'string' ? v.overview : typeof v.description === 'string' ? v.description : undefined,
                            airDate: typeof v.released === 'string' ? v.released : typeof v.firstAired === 'string' ? v.firstAired : undefined,
                            still: typeof v.thumbnail === 'string' ? v.thumbnail : undefined,
                        }
                        const arr = bySeason.get(season) ?? []
                        arr.push(ep)
                        bySeason.set(season, arr)
                    }
                    for (const arr of bySeason.values()) arr.sort((a, b) => a.episodeNumber - b.episodeNumber)
                    const seasonList: SeasonInfo[] = Array.from(seasonSet)
                        .sort((a, b) => b - a)
                        .map(sn => ({
                            seasonNumber: sn,
                            name: sn === 0 ? 'Specials' : `Season ${sn}`,
                            episodeCount: bySeason.get(sn)?.length ?? 0,
                        }))
                    if (active && seasonList.length > 0) {
                        setCinemetaSeasons(seasonList)
                        setCinemetaEpisodesBySeason(bySeason)
                    }
                })
                .catch(() => { })
        }
        const itemId = activeItem.itemId
        if (itemId.startsWith('tt')) {
            fetchCinemeta(itemId)
        } else if (seriesTmdbId && tmdbSeasonsFailed) {
            proxyFetch<{ imdb_id?: string }>(`tv/${seriesTmdbId}/external_ids`)
                .then(ext => {
                    if (!active) return
                    if (ext?.imdb_id) {
                        fetchCinemeta(ext.imdb_id)
                    } else if (activeItem.name) {
                        const nameQuery = encodeURIComponent(activeItem.name)
                        Promise.all([
                            fetch(`https://cinemeta-live.strem.io/catalog/series/top/search=${nameQuery}.json`)
                                .then(r => r.ok ? r.json() : null)
                                .catch(() => null),
                            fetch(`https://cinemeta-live.strem.io/catalog/movie/top/search=${nameQuery}.json`)
                                .then(r => r.ok ? r.json() : null)
                                .catch(() => null),
                        ])
                            .then(([seriesData, movieData]) => {
                                if (!active) return
                                const metas: Array<Record<string, unknown>> = [
                                    ...((Array.isArray(seriesData?.metas) ? seriesData.metas : []) as Array<Record<string, unknown>>),
                                    ...((Array.isArray(movieData?.metas) ? movieData.metas : []) as Array<Record<string, unknown>>),
                                ]
                                if (metas.length === 0) return
                                const match = metas.find((m: Record<string, unknown>) =>
                                    m.type === 'series' &&
                                    String(m.name || '').toLowerCase() === activeItem.name!.toLowerCase()
                                ) || metas[0]
                                if (match?.id && String(match.id).startsWith('tt')) {
                                    fetchCinemeta(String(match.id))
                                }
                            })
                            .catch(() => {})
                    }
                })
                .catch(() => {})
        }
        return () => { active = false; clearTimeout(cinemetaTimeout); cinemetaController.abort() }
    }, [seriesTmdbId, activeItem, tmdbSeasonsFailed])

    useEffect(() => {
        if ((seriesTmdbId && !tmdbSeasonsFailed) || cinemetaSeasons.length === 0 || selectedSeason !== null) return
        const watched = activeItem?.season ?? latestWatchedSeason
        const target = watched != null && cinemetaSeasons.some(s => s.seasonNumber === watched)
            ? watched
            : cinemetaSeasons[0].seasonNumber
        setSelectedSeason(target)
    }, [cinemetaSeasons, seriesTmdbId, selectedSeason, activeItem, tmdbSeasonsFailed, latestWatchedSeason])

    const pillsRowRef = useRef<HTMLDivElement>(null)
    // With 8 seasons or fewer the pills stay; the selected pill is centred on open and on change.
    useEffect(() => {
        if (selectedSeason === null) return
        const list = seasons.length > 0 ? seasons : cinemetaSeasons
        if (shouldUseCompactSeasonPicker(list.length)) return
        const row = pillsRowRef.current
        if (!row) return
        const pill = row.querySelector<HTMLButtonElement>(`[data-season-pill="${selectedSeason}"]`)
        if (!pill) return
        const reduced = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
            && window.matchMedia('(prefers-reduced-motion: reduce)').matches
        pill.scrollIntoView({ block: 'nearest', inline: 'center', behavior: reduced ? 'auto' : 'smooth' })
    }, [seasons, cinemetaSeasons, selectedSeason])

    if (loading || (seasons.length === 0 && cinemetaSeasons.length === 0)) return null

    const activeSeasons = seasons.length > 0 ? seasons : cinemetaSeasons
    const activeEpisodes = seriesTmdbId ? episodes : (cinemetaEpisodesBySeason.get(selectedSeason ?? -1) ?? [])
    const isLoadingEps = seriesTmdbId ? episodesLoading : false
    const compactPicker = shouldUseCompactSeasonPicker(activeSeasons.length)
    const watchedSeasonSet = watchedSeasonNumbers(watchedBySeason)

    // Anime watch events usually carry absolute episode numbers on a flat season 1,
    // while TMDB splits the show into real seasons. When the watched episode isn't in
    // the selected season, map it through cumulative episode counts (absolute →
    // season/offset) so the watched episode still gets selected and highlighted.
    const watchedSeason = activeItem?.season
    const watchedEpisode = activeItem?.episode
    const directHit = watchedSeason != null && watchedEpisode != null
        && watchedSeason === selectedSeason
        && activeEpisodes.some(ep => ep.episodeNumber === watchedEpisode)
    const mappedFromAbsolute = (!directHit && watchedEpisode != null && activeItem?.type === 'anime')
        ? (() => {
            const ordered = [...activeSeasons].sort((a, b) => a.seasonNumber - b.seasonNumber)
            let before = 0
            for (const s of ordered) {
                const count = s.episodeCount || 0
                if (watchedEpisode! <= before + count) {
                    return { season: s.seasonNumber, episode: watchedEpisode! - before }
                }
                before += count
            }
            return null
        })()
        : null
    const redirectKey = activeItem ? `${activeItem.itemId}:${watchedSeason ?? ''}:${watchedEpisode ?? ''}` : null
    if (
        mappedFromAbsolute &&
        redirectKey !== null &&
        absoluteSeasonRedirectRef.current !== redirectKey &&
        selectedSeason != null &&
        selectedSeason === watchedSeason &&
        mappedFromAbsolute.season !== selectedSeason &&
        !isLoadingEps
    ) {
        absoluteSeasonRedirectRef.current = redirectKey
        setSelectedSeason(mappedFromAbsolute.season)
    }
    const highlight = directHit
        ? { season: watchedSeason!, episode: watchedEpisode! }
        : mappedFromAbsolute ?? null

    const handleEpisodeClick = (ep: EpisodeInfo) => {
        if (!onEpisodeClick || selectedSeason === null) return
        onEpisodeClick({
            episodeNumber: ep.episodeNumber,
            episodeName: ep.name,
            episodeOverview: ep.overview,
            airDate: ep.airDate,
            still: ep.still,
            seasonNumber: selectedSeason,
            seriesTmdbId: effectiveTmdbId,
        })
    }

    return (
        <div className="space-y-3">
            {/* Tucks 2px under the pinned bar (which paints above it) so fractional display scaling cannot open a crack between them.
                While joined, the header becomes part of the bar's block: the bar drops its own bottom line
                and shadow, and the block's line and shadow live at the header's bottom. */}
            <div
                data-episodes-bar=""
                data-joined={joined ? 'true' : undefined}
                className={cn(
                    'sticky top-[3.25rem] z-20 -mx-5 space-y-3 px-5 pb-3 pt-3 sm:-mx-8 sm:px-8',
                    joined
                        ? 'border-b border-[color:var(--chrome-line)] bg-card shadow-[0_10px_24px_-12px_rgba(0,0,0,0.45)]'
                        : 'border-b border-border/50 bg-card',
                )}
            >
                <div className="flex items-center justify-between gap-3">
                    <h3 className={cn('flex items-center gap-2 text-xs font-bold uppercase tracking-widest', joined ? 'text-foreground/80' : 'text-muted-foreground/80')}>
                        <Tv className="h-3.5 w-3.5 text-primary" />
                        Episodes
                    </h3>
                    {!compactPicker && selectedSeason !== null && (() => {
                        const s = activeSeasons.find(x => x.seasonNumber === selectedSeason)
                        return s ? (
                            <span className={cn('text-[11px] font-medium', joined ? 'text-foreground/70' : 'text-muted-foreground/60')}>
                                {s.episodeCount} episode{s.episodeCount === 1 ? '' : 's'}
                                {s.airDate ? ` \u00b7 ${new Date(s.airDate).getFullYear()}` : ''}
                            </span>
                        ) : null
                    })()}
                </div>

                {compactPicker ? (
                    <SeasonControl
                        seasons={activeSeasons}
                        selected={selectedSeason}
                        onSelect={setSelectedSeason}
                        watchedSeasons={watchedSeasonSet}
                        isLight={isLight}
                    />
                ) : (
                    <div ref={pillsRowRef} className="scrollbar-hide -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
                        {activeSeasons.map(s => {
                            const isActive = s.seasonNumber === selectedSeason
                            return (
                                <button
                                    key={s.seasonNumber}
                                    type="button"
                                    data-theme-part="tab"
                                    data-season-pill={s.seasonNumber}
                                    data-state={isActive ? 'active' : 'inactive'}
                                    onClick={() => setSelectedSeason(s.seasonNumber)}
                                    className={cn(
                                        'shrink-0 rounded-full px-4 py-2 text-xs font-bold transition-all active:scale-95',
                                        isActive
                                            ? (isLight ? 'bg-primary text-primary-foreground shadow' : 'bg-white text-black shadow')
                                            : (isLight ? 'bg-muted/50 text-muted-foreground hover:bg-muted' : 'bg-white/10 text-white/80 hover:bg-white/20')
                                    )}
                                >
                                    {s.seasonNumber === 0 ? 'Specials' : `S${s.seasonNumber}`}
                                </button>
                            )
                        })}
                    </div>
                )}
            </div>

            <div className="space-y-1.5">
                {isLoadingEps ? (
                    [0, 1, 2, 3].map(i => (
                        <div key={i} className="flex gap-3 rounded-xl border border-border/40 bg-muted/30 p-2.5">
                            <Skeleton className="h-14 w-24 shrink-0 rounded-lg" />
                            <div className="flex-1 space-y-1.5 py-1">
                                <Skeleton className="h-3.5 w-3/4 rounded" />
                                <Skeleton className="h-3 w-1/2 rounded" />
                            </div>
                        </div>
                    ))
                ) : activeEpisodes.length === 0 ? (
                    <p className="py-4 text-center text-xs text-muted-foreground/60">
                        No episode data available for this season.
                    </p>
                ) : (
                    activeEpisodes.map(ep => {
                        // Selection (the active item's episode) and watched (real completion
                        // evidence) are independent states with separate treatments, so a
                        // selected row never reads as watched and a row can show both.
                        const isWatched = selectedSeason !== null && watchedBySeason.get(selectedSeason)?.has(ep.episodeNumber) === true
                        const isSelected = highlight !== null && highlight.season === selectedSeason && highlight.episode === ep.episodeNumber
                        // Who actually watched this episode (any account in the household).
                        // Informational only: the stack is plain spans with a shared
                        // title/aria label, so nothing interactive nests inside the row
                        // button and no per-avatar Tooltip portals exist to stack up.
                        const watchers = selectedSeason !== null
                            ? episodeWatchers?.get(selectedSeason)?.get(ep.episodeNumber)
                            : undefined
                        return (
                            <Tooltip key={ep.episodeNumber} content="View episode details" side="top">
                            <button
                                key={ep.episodeNumber}
                                type="button"
                                data-theme-part="nav-item"
                                data-state={isSelected ? 'active' : 'inactive'}
                                data-watched={isWatched ? 'true' : 'false'}
                                aria-current={isSelected ? 'true' : undefined}
                                onClick={() => handleEpisodeClick(ep)}
                                className={cn(
                                    'group flex w-full items-center gap-3 rounded-xl border p-2 text-left transition-all',
                                    isSelected
                                        ? 'border-primary bg-primary/10 shadow-sm ring-2 ring-primary/40'
                                        : 'border-border/40 bg-muted/20 hover:border-border hover:bg-muted/40'
                                )}
                            >
                                <div className="relative h-14 w-24 shrink-0 overflow-hidden rounded-lg bg-muted sm:h-16 sm:w-28">
                                    {ep.still ? (
                                        <img src={ep.still} alt="" loading="lazy" className="h-full w-full object-cover" />
                                    ) : null}
                                    <span className={cn(
                                        'absolute left-1 top-1 rounded px-1.5 py-0.5 font-mono text-[10px] font-bold leading-none',
                                        isSelected
                                            ? 'bg-primary text-primary-foreground'
                                            : 'bg-black/70 text-white'
                                    )}>
                                        E{ep.episodeNumber}
                                    </span>
                                    {isWatched && (
                                        <span aria-hidden="true" className="absolute bottom-1 right-1 flex h-4 w-4 items-center justify-center rounded-full bg-success text-success-foreground">
                                            <Check className="h-2.5 w-2.5" strokeWidth={3} />
                                        </span>
                                    )}
                                </div>
                                <div className="min-w-0 flex-1">
                                    <p className={cn(
                                        'line-clamp-1 text-xs font-bold leading-tight sm:text-sm',
                                        isSelected ? 'text-primary' : 'text-foreground/90'
                                    )}>
                                        {ep.name}
                                    </p>
                                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground/70">
                                        {isSelected && (
                                            <span data-episode-state="current" className="inline-flex items-center gap-0.5 font-semibold text-primary">
                                                <Play className="h-3 w-3 fill-current" />
                                                Current
                                            </span>
                                        )}
                                        {isWatched && (
                                            <span data-episode-state="watched" className="inline-flex items-center gap-0.5 font-semibold text-success">
                                                <Check className="h-3 w-3" strokeWidth={3} />
                                                Watched
                                            </span>
                                        )}
                                        {ep.airDate && (
                                            <span className="inline-flex items-center gap-0.5">
                                                <Calendar className="h-3 w-3" />
                                                {new Date(ep.airDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                                            </span>
                                        )}
                                        {ep.runtime ? (
                                            <span className="inline-flex items-center gap-0.5">
                                                <Clock className="h-3 w-3" />
                                                {ep.runtime}m
                                            </span>
                                        ) : null}
                                        {typeof ep.voteAverage === 'number' && ep.voteAverage > 0 && (
                                            <span className="inline-flex items-center gap-0.5">
                                                <Star className="h-3 w-3" />
                                                {ep.voteAverage.toFixed(1)}
                                            </span>
                                        )}
                                    </div>
                                </div>
                                {watchers && watchers.length > 0 && (
                                    <span
                                        role="img"
                                        data-watcher-count={watchers.length}
                                        title={episodeWatcherLabel(watchers)}
                                        aria-label={episodeWatcherLabel(watchers)}
                                        className="flex shrink-0 items-center -space-x-1.5"
                                    >
                                        {watchers.slice(0, EPISODE_WATCHER_AVATAR_CAP).map(w => (
                                            <span
                                                key={w.id}
                                                data-watcher-avatar=""
                                                className="relative flex h-5 w-5 items-center justify-center overflow-hidden rounded-full border border-background bg-card sm:h-6 sm:w-6"
                                            >
                                                <AccountAvatar
                                                    account={{ name: w.name, emoji: w.emoji, avatar: w.avatar }}
                                                    size="xs"
                                                    showStatus={false}
                                                    className="!h-full !w-full rounded-full"
                                                />
                                            </span>
                                        ))}
                                        {watchers.length > EPISODE_WATCHER_AVATAR_CAP && (
                                            <span
                                                data-watcher-overflow=""
                                                className="pl-2.5 text-[10px] font-bold leading-none text-muted-foreground"
                                            >
                                                +{watchers.length - EPISODE_WATCHER_AVATAR_CAP}
                                            </span>
                                        )}
                                    </span>
                                )}
                                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5 group-hover:text-muted-foreground" />
                            </button>
                            </Tooltip>
                        )
                    })
                )}
            </div>
        </div>
    )
}
