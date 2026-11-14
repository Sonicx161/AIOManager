import { continueWatchingPosterFor } from '@/lib/activity-cw-poster'
import { useEffect, useState, useRef, useMemo, useCallback, type CSSProperties } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { toast } from '@/hooks/use-toast'
import { useTheme } from '@/contexts/ThemeContext'

import { Skeleton } from '@/components/ui/skeleton'
import { Poster, fetchTmdbArtworkByTitle } from '@/components/common/Poster'
import { detailArtwork } from '@/lib/activity-artwork'
import { fetchCinemetaDetail, formatSavedEpisodeRanges, type CinemetaMeta, type CinemetaCastMember, type CinemetaReview } from '@/lib/activity-utils'
import { crossLinkWatcherIndex, watcherMatchesItem, type WatcherItemIdentity } from '@/lib/watcher-identity'
import { resolveTrailerAsync, type TrailerResult } from '@/lib/trailer-resolver'
import { fetchTmdbDetailsAsMeta, fetchTmdbImdbId, proxyFetch, fetchSeasonEpisodes, fetchSeasonsList, pickTmdbIdFromFind, searchCinemeta, type TmdbFindPayload } from '@/api/metadata/adapters/tmdb'
import { traceAsync } from '@/api/metadata/adapters/shared-fetch'
import { addToWatchlist, removeFromWatchlist, getWatchlist } from '@/lib/watchlist'
import { getPmdbRating } from '@/api/metadata/adapters/pmdb'
import { apiGet } from '@/lib/http-client'
import { cn, openStremioDetail } from '@/lib/utils'
import { Tooltip } from '@/components/ui/tooltip'
import { PinnedBarMaterial } from '@/components/activity/detail/bar-material'
import { dominantColorFromImageUrl, deriveArtworkChrome, rgbCss, themeSurfaceColors, type ArtworkChrome } from '@/lib/artwork-color'
import { DialogBack, DialogAltHistory } from '@/components/ui/dialog'
import { useAccountStore } from '@/store/accountStore'
import { useUIStore } from '@/store/uiStore'
import { AccountAvatar } from '@/components/accounts/AccountAvatar'
import { maskedDisplayName } from '@/components/common/AccountSwitcher'
import { useWatchHistory, type HistoryEntry } from '@/hooks/useWatchHistory'
import { useMaskedAccountLabel } from '@/hooks/useMaskedAccountLabel'
import { pickModalHistory, shouldDeriveModalHistory } from '@/lib/activity-detail-history'
import { buildEpisodeWatcherIndex } from '@/lib/episode-watchers'
import { Star, Clock, Calendar, Play, ExternalLink, ChevronDown, ChevronUp, Film, Clapperboard, ArrowLeft, ArrowRight, User, ChevronLeft, ChevronRight, Tv, Sparkles, Languages, Building2, Layers, Users } from 'lucide-react'
import { RatingBadge, type ProviderRating } from '@/components/activity/detail/RatingBadge'
import { fetchAdditionalRatings, mergeRatingsKeepExisting } from '@/lib/ratings'
import { CastInitials } from '@/components/activity/detail/CastInitials'
import { LightboxViewer } from '@/components/activity/detail/LightboxViewer'
import { ReviewsSection } from '@/components/activity/detail/ReviewsSection'
import { WatchlistPicker } from '@/components/activity/detail/WatchlistPicker'
import { JellyfinFavoriteControl, type JellyfinFavoritePerson } from '@/components/activity/detail/JellyfinFavoriteControl'
import { jellyfinFavoritesCapable } from '@/lib/jellyfin/favorites'
import { FilmPosterCard } from '@/components/activity/detail/FilmPosterCard'
import { CastSection } from '@/components/activity/detail/CastSection'
import { SeasonBrowser } from '@/components/activity/detail/SeasonBrowser'
import { EpisodeDetailPage } from '@/components/activity/detail/EpisodeDetailPage'
import { heroCollapseState, type HeroCollapseGeometry } from '@/components/activity/detail/hero-collapse'
import type { RailWatcher } from '@/components/ui/content-rail'

// ── Types ─────────────────────────────────────────────────────────────────

export type { DetailItem } from '@/components/activity/detail/types'
import type { DetailItem, TmdbPersonSearchResponse, TmdbPersonCreditsResponse, FilmographyItem } from '@/components/activity/detail/types'
import type { Connection } from '@/types/connection'

export type { FilmographyItem } from '@/components/activity/detail/types'

interface ActivityDetailModalProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    item: DetailItem | null
    /** Continue Watching posters by IMDb id, tried ahead of the shown item's own art. */
    cwPosterIndex?: ReadonlyMap<string, string>
    /** The caller's unscoped watch history; when omitted the modal derives its own. */
    watchHistory?: HistoryEntry[]
}

// ── Constants ─────────────────────────────────────────────────────────────

const CAST_DISPLAY_LIMIT = 20
const DESCRIPTION_COLLAPSE_LENGTH = 240
const TMDB_PROFILE_BASE = 'https://image.tmdb.org/t/p/w185'

const RATING_LABELS: Record<string, string> = {
    tomatoes: 'Rotten Tomatoes Tomatometer',
    popcorn: 'Rotten Tomatoes Audience Score',
    metacritic: 'Metacritic Metascore',
    imdb: 'IMDb Rating',
    trakt: 'Trakt Rating',
    letterboxd: 'Letterboxd Rating',
    tmdb: 'TMDB Rating',
    pmdb: 'PublicMetaDB Rating',
}

// ── Rating Fetchers ───────────────────────────────────────────────────────

async function getPmdbRatingFromImdb(
    imdbId: string,
    type: string,
): Promise<{ score: number | null; voteCount: number } | null> {
    try {
        const isTv = type === 'series' || type === 'anime'
        const mediaType = isTv ? 'tv' : 'movie'

        let tmdbId: number | null = null

        const cinemetaMeta = await fetchCinemetaDetail(imdbId, type)
        if (cinemetaMeta?.tmdbId) {
            tmdbId = cinemetaMeta.tmdbId
        }

        if (!tmdbId) {
            const data = await proxyFetch<TmdbFindPayload>(
                `find/${encodeURIComponent(imdbId)}?external_source=imdb_id`,
            )
            tmdbId = pickTmdbIdFromFind(data, isTv)?.tmdbId ?? null
        }

        if (!tmdbId) return null
        const pmdb = await getPmdbRating(tmdbId, undefined, mediaType)
        if (!pmdb) return null
        return { score: pmdb.rating, voteCount: pmdb.voteCount }
    } catch {
        return null
    }
}

function getYear(meta: CinemetaMeta | null, item: DetailItem | null): string {
    if (meta?.released) return meta.released.slice(0, 4)
    if (meta?.year) return meta.year
    if (item?.firstWatched) {
        const y = new Date(item.firstWatched).getFullYear()
        if (!isNaN(y)) return String(y)
    }
    if (item?.year) return String(item.year)
    return ''
}

function getGenres(meta: CinemetaMeta | null, item: DetailItem | null): string[] {
    if (meta?.genre && typeof meta.genre === 'string') {
        const parsed = meta.genre.split(',').map(g => g.trim()).filter(Boolean)
        if (parsed.length > 0) return parsed
    }
    return item?.genres ?? []
}

function getDirectors(meta: CinemetaMeta | null): Array<{ name: string; photo?: string }> {
    if (!meta?.director) return []
    if (Array.isArray(meta.director)) {
        return (meta.director as Array<string | { name?: string; photo?: string }>)
            .map(d => {
                if (typeof d === 'string') return { name: d }
                return {
                    name: typeof d?.name === 'string' ? d.name : '',
                    photo: typeof d?.photo === 'string' ? d.photo : undefined,
                }
            })
            .filter(d => d.name.trim().length > 0 && !/^https?:\/\//i.test(d.name))
    }
    if (typeof meta.director === 'string') {
        return meta.director
            .split(',')
            .map(d => d.trim())
            .filter(d => d.length > 0 && !/^https?:\/\//i.test(d))
            .map(name => ({ name }))
    }
    return []
}

function getCrew(meta: CinemetaMeta | null): Array<{ name: string; role?: string; photo?: string }> {
    if (meta?.crew && Array.isArray(meta.crew) && meta.crew.length > 0) {
        return meta.crew
    }
    const directors = getDirectors(meta)
    return directors.map(d => ({ name: d.name, role: 'Director', photo: d.photo }))
}

/**
 * Cinemeta returns cast as either:
 *   - string[]  (just names, e.g. ["Matthew McConaughey", "Anne Hathaway"])
 *   - CinemetaCastMember[] (rich objects from TMDB enrichment or AIOMetadata)
 * This helper normalises both into the rich shape the UI expects.
 */
function getCast(
    meta: CinemetaMeta | null,
): Array<{ name: string; character?: string; photo?: string }> {
    if (!meta?.cast || meta.cast.length === 0) return []
    return (meta.cast as Array<string | CinemetaCastMember>)
        .map(c => {
            if (typeof c === 'string') return { name: c }
            return {
                name: typeof c?.name === 'string' ? c.name : '',
                character: typeof c?.character === 'string' ? c.character : undefined,
                photo: typeof c?.photo === 'string' ? c.photo : undefined,
            }
        })
        .filter(c => c.name.trim().length > 0)
        .slice(0, CAST_DISPLAY_LIMIT)
}

function isStremioFriendlyType(type: string): boolean {
    return type === 'movie' || type === 'series'
}

export interface PersonDetails {
    name: string
    photo?: string
    biography?: string
    birthday?: string
    deathday?: string
    placeOfBirth?: string
    knownFor?: string
}

export interface PersonFilmographyResult {
    person: PersonDetails
    movies: FilmographyItem[]
    series: FilmographyItem[]
    anime: FilmographyItem[]
}

export type NavEntry =
    | {
        kind: 'item'
        item: DetailItem
    }
    | {
        kind: 'person'
        name: string
        photo?: string
        role?: string
        biography?: string
        birthday?: string
        deathday?: string
        placeOfBirth?: string
        knownFor?: string
        movies: FilmographyItem[]
        series: FilmographyItem[]
        anime: FilmographyItem[]
        loading: boolean
        activeTab: 'all' | 'movies' | 'series' | 'anime'
    }
    | {
        kind: 'account'
        accountId: string
    }
    | {
        kind: 'episode'
        seriesName: string
        seriesImdbId?: string
        seasonNumber: number
        episodeNumber: number
        episodeName: string
        episodeOverview?: string
        airDate?: string
        still?: string
        seriesTmdbId: number | null
        seriesPoster?: string
    }

// ── Deep-link URL encoding ─────────────────────────────────────────────────
//
// DESIGN CHOICE: the in-component navStack remains the source of truth (URL
// params cannot carry loaded filmography / episode data). Every nav change
// mirrors the CURRENT entry into the /activity search params — a deeper stack
// pushes a history entry so browser Back pops one nav level — and external
// param changes (browser back/forward) are reconciled back into the stack.
//
// Encoding (cumulative, the entry kind determines which keys are present):
//   item    → ?detail=<itemId>&type=<type>
//   episode → ?detail=<seriesId>&type=<type>&season=<n>&episode=<n>
//   account → ?detail=<itemId>&type=<type>&account=<accountId>
//   person  → …&person=<name>   (layered over whatever entry is below)
//
// Known limits (honest scope): the URL only encodes the nav path down to the
// current entry — deeper stack context (e.g. a person page two levels below a
// filmography-picked film) survives browser Back but not a fresh page load,
// and person filmography / episode details are re-fetched on restore.

const DETAIL_URL_KEYS = ['detail', 'type', 'person', 'account', 'season', 'episode'] as const

interface ParsedDetailParams {
    detail: string
    type?: string
    person?: string
    account?: string
    season?: number
    episode?: number
}

function parseDetailParams(sp: URLSearchParams): ParsedDetailParams | null {
    const detail = sp.get('detail')
    if (!detail) return null
    const season = sp.get('season')
    const episode = sp.get('episode')
    return {
        detail,
        type: sp.get('type') || undefined,
        person: sp.get('person') || undefined,
        account: sp.get('account') || undefined,
        season: season && /^\d+$/.test(season) ? Number(season) : undefined,
        episode: episode && /^\d+$/.test(episode) ? Number(episode) : undefined,
    }
}

function stripDetailParams(sp: URLSearchParams): URLSearchParams {
    const next = new URLSearchParams(sp.toString())
    for (const key of DETAIL_URL_KEYS) next.delete(key)
    return next
}

function paramsEqual(a: URLSearchParams, b: URLSearchParams): boolean {
    const aKeys = Array.from(a.keys())
    if (aKeys.length !== Array.from(b.keys()).length) return false
    for (const key of aKeys) {
        if (a.get(key) !== b.get(key)) return false
    }
    return true
}

/** Search params mirroring the current navStack state (null = modal closed). */
function paramsForStack(stack: NavEntry[]): URLSearchParams | null {
    const top = stack[stack.length - 1]
    if (!top) return null
    if (top.kind === 'item') {
        const sp = new URLSearchParams()
        sp.set('detail', top.item.itemId)
        sp.set('type', top.item.type)
        return sp
    }
    const below = paramsForStack(stack.slice(0, -1))
    if (!below) return null
    if (top.kind === 'episode') {
        below.set('season', String(top.seasonNumber))
        below.set('episode', String(top.episodeNumber))
    } else if (top.kind === 'account') {
        below.set('account', top.accountId)
    } else {
        below.set('person', top.name)
    }
    return below
}

function filmographyFallbackFor(item: DetailItem | null, role?: string): FilmographyItem | null {
    if (!item) return null
    return {
        id: item.itemId,
        title: item.name || 'Current Title',
        poster: item.poster,
        year: item.year,
        type: item.type === 'anime' ? 'anime' : item.type === 'series' ? 'series' : 'movie',
        job: role,
    }
}

function calculateAge(birthday?: string, deathday?: string | null): number | null {
    if (!birthday) return null
    const birth = new Date(birthday)
    if (isNaN(birth.getTime())) return null
    const end = deathday ? new Date(deathday) : new Date()
    let age = end.getFullYear() - birth.getFullYear()
    const m = end.getMonth() - birth.getMonth()
    if (m < 0 || (m === 0 && end.getDate() < birth.getDate())) {
        age--
    }
    return age >= 0 ? age : null
}

function formatPersonBirthInfo(birthday?: string, placeOfBirth?: string, deathday?: string): string | undefined {
    if (!birthday && !placeOfBirth) return undefined
    const parts: string[] = []
    if (birthday) {
        const birthDate = new Date(birthday)
        if (!isNaN(birthDate.getTime())) {
            const formattedDate = birthDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
            const age = calculateAge(birthday, deathday)
            if (deathday) {
                parts.push(`Born ${formattedDate} (Died ${new Date(deathday).getFullYear()})`)
            } else if (age !== null) {
                parts.push(`Born ${formattedDate} (age ${age})`)
            } else {
                parts.push(`Born ${formattedDate}`)
            }
        }
    }
    if (placeOfBirth) {
        parts.push(birthday ? `in ${placeOfBirth}` : `Born in ${placeOfBirth}`)
    }
    return parts.join(' ')
}

function formatRuntime(runtimeStr?: string): string | undefined {
    if (!runtimeStr) return undefined
    const num = parseInt(runtimeStr.replace(/[^0-9]/g, ''), 10)
    if (!num || isNaN(num)) return runtimeStr
    const hrs = Math.floor(num / 60)
    const mins = num % 60
    if (hrs > 0 && mins > 0) return `${hrs}h ${mins}m`
    if (hrs > 0) return `${hrs}h`
    return `${mins}m`
}

async function fetchPersonFilmography(
    personName: string,
    currentFilm?: FilmographyItem | null
): Promise<PersonFilmographyResult> {
    const ensureCurrentFilm = (res: PersonFilmographyResult): PersonFilmographyResult => {
        if (!currentFilm) return res
        const normTitle = currentFilm.title.toLowerCase().trim()
        const allItems = [...res.movies, ...res.series, ...res.anime]
        const exists = allItems.some(i => i.id === currentFilm.id || i.title.toLowerCase().trim() === normTitle)
        if (!exists) {
            if (currentFilm.type === 'movie') {
                res.movies = [currentFilm, ...res.movies]
            } else if (currentFilm.type === 'anime') {
                res.anime = [currentFilm, ...res.anime]
            } else {
                res.series = [currentFilm, ...res.series]
            }
        }
        return res
    }

    // 1. Query TMDB search + person details with combined_credits via authenticated proxyFetch
    try {
        const searchData = await proxyFetch<TmdbPersonSearchResponse>(`search/person?query=${encodeURIComponent(personName)}`)
        if (searchData && Array.isArray(searchData.results) && searchData.results.length > 0) {
            const searchPerson = searchData.results[0]
            const personId = searchPerson.id

            const personData = await proxyFetch<TmdbPersonCreditsResponse>(`person/${personId}?append_to_response=combined_credits`)
            if (personData) {
                const photo = personData.profile_path ? `https://image.tmdb.org/t/p/w500${personData.profile_path}` : (searchPerson.profile_path ? `https://image.tmdb.org/t/p/w500${searchPerson.profile_path}` : undefined)
                const creditsData = personData.combined_credits
                const rawCast: Record<string, unknown>[] = Array.isArray(creditsData?.cast) ? creditsData.cast : []
                const rawCrew: Record<string, unknown>[] = Array.isArray(creditsData?.crew) ? creditsData.crew : []

                const combined = [...rawCast, ...rawCrew]
                const movieMap = new Map<string, FilmographyItem>()
                const seriesMap = new Map<string, FilmographyItem>()
                const animeMap = new Map<string, FilmographyItem>()

                for (const item of combined) {
                    const title = (item.title as string) || (item.name as string)
                    if (!title) continue
                    const date = (item.release_date as string) || (item.first_air_date as string) || ''
                    const year = date ? parseInt(date.slice(0, 4), 10) : undefined
                    const isTv = item.media_type === 'tv'
                    const genreIds = Array.isArray(item.genre_ids) ? item.genre_ids as number[] : []
                    const origLang = (item.original_language as string) || ''
                    const isAnimation = genreIds.includes(16)
                    const isAnimeItem = isTv && isAnimation && (origLang === 'ja' || (Array.isArray(item.origin_country) && (item.origin_country as string[]).includes('JP')))

                    const poster = item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : undefined
                    const targetMap = !isTv ? movieMap : isAnimeItem ? animeMap : seriesMap
                    const itemId = item.id ? `tmdb:${item.id}` : ''

                    if (itemId && !targetMap.has(itemId)) {
                        targetMap.set(itemId, {
                            id: itemId,
                            title,
                            poster,
                            year,
                            type: !isTv ? 'movie' : isAnimeItem ? 'anime' : 'series',
                            character: item.character as string | undefined,
                            job: (item.job as string) || (item.department as string),
                            voteAverage: item.vote_average as number | undefined,
                        })
                    }
                }

                const movies = Array.from(movieMap.values()).sort((a, b) => (b.year ?? 0) - (a.year ?? 0))
                const series = Array.from(seriesMap.values()).sort((a, b) => (b.year ?? 0) - (a.year ?? 0))
                const anime = Array.from(animeMap.values()).sort((a, b) => (b.year ?? 0) - (a.year ?? 0))

                if (movies.length > 0 || series.length > 0 || anime.length > 0) {
                    return ensureCurrentFilm({
                        person: {
                            name: personData.name || personName,
                            photo,
                            biography: personData.biography?.trim() || undefined,
                            birthday: personData.birthday || undefined,
                            deathday: personData.deathday || undefined,
                            placeOfBirth: personData.place_of_birth || undefined,
                            knownFor: personData.known_for_department || undefined,
                        },
                        movies,
                        series,
                        anime,
                    })
                }
            }
        }
    } catch (e) { if (import.meta.env?.DEV) console.warn('[ActivityDetail] fetch failed:', e) }

    return ensureCurrentFilm({ person: { name: personName }, movies: [], series: [], anime: [] })
}

export function ActivityDetailModal({ open, onOpenChange, item, cwPosterIndex, watchHistory: providedWatchHistory }: ActivityDetailModalProps) {
    const { isLight } = useTheme()
    const [activeItem, setActiveItem] = useState<DetailItem | null>(item)
    const [meta, setMeta] = useState<CinemetaMeta | null>(null)
    const [resolvedImdbId, setResolvedImdbId] = useState<string | null>(null)
    const [heroAttempt, setHeroAttempt] = useState(0)
    const [titleBackdrop, setTitleBackdrop] = useState<string | undefined>()
    // The hero art fades in only after its bytes decode, so a backdrop landing
    // mid-animation composes smoothly instead of popping over the black fallback.
    const [heroReadySrc, setHeroReadySrc] = useState<string | null>(null)
    const [loading, setLoading] = useState(false)
    const [failed, setFailed] = useState(false)
    const [descExpanded, setDescExpanded] = useState(false)
    const [trailer, setTrailer] = useState<TrailerResult | null>(null)
    const [providerRatings, setProviderRatings] = useState<ProviderRating[]>([])
    const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
    const [lightboxZoom, setLightboxZoom] = useState(false)
    const [barShown, setBarShown] = useState({ title: false, play: false, pinned: false })
    // True while a sticky section header sits flush under the pinned bar: the two
    // read as one joined block.
    const [barJoined, setBarJoined] = useState(false)
    const joinedRef = useRef(false)
    const barRef = useRef<HTMLDivElement>(null)
    const barTitleRef = useRef<HTMLParagraphElement>(null)
    const heroMediaRef = useRef<HTMLDivElement>(null)
    const heroTitleRef = useRef<HTMLDivElement>(null)
    const heroActionsRef = useRef<HTMLDivElement>(null)
    const barPlayRef = useRef<HTMLButtonElement>(null)
    const heroPlayRef = useRef<HTMLButtonElement>(null)
    const barCloseRef = useRef<HTMLButtonElement>(null)
    // Person branch: same pinned-bar machinery, own hero anchors.
    const personHeroRef = useRef<HTMLDivElement>(null)
    const personHeroTitleRef = useRef<HTMLDivElement>(null)

    const heroPrimaryBtn = isLight
        ? 'bg-primary text-primary-foreground hover:bg-primary/90'
        : 'bg-white text-black hover:bg-white/90'
    const heroGhostBtn = isLight
        ? 'border border-border bg-card/80 text-foreground hover:bg-card'
        : 'border border-white/20 bg-white/10 text-white hover:bg-white/20'
    const heroFrostedBtn = isLight
        ? 'border-border bg-card/80 text-foreground hover:bg-card'
        : 'border-white/15 bg-white/10 text-white/90 hover:bg-white/25'
    const heroTabActive = isLight
        ? 'bg-primary text-primary-foreground shadow'
        : 'bg-white text-black shadow'
    const heroTabInactive = isLight
        ? 'bg-muted/50 text-foreground/70 hover:bg-muted'
        : 'bg-white/10 text-white/80 hover:bg-white/20'

    // The hero title scrolls with the content; the large-title bar effect only fades it (--tt-o).
    const heroTitleFadeStyle: CSSProperties = { opacity: 'var(--tt-o, 1)' }

    const scrollGalleryRef = useRef<HTMLDivElement>(null)
    const scrollTrailersRef = useRef<HTMLDivElement>(null)
    const scrollRelatedRef = useRef<HTMLDivElement>(null)
    const trailerSectionRef = useRef<HTMLDivElement>(null)
    // State-backed refs: the observer must attach whenever these mount, not only on open.
    const [detailScrollEl, setDetailScrollEl] = useState<HTMLDivElement | null>(null)
    const [watchlistTargets, setWatchlistTargets] = useState<Set<string>>(new Set())
    const [watchlistLoading, setWatchlistLoading] = useState(false)
    const [seriesTmdbId, setSeriesTmdbId] = useState<number | null>(null)

    // ── Adaptive Navigation Stack ─────────────────────────────────────────────
    const [navStack, setNavStack] = useState<NavEntry[]>([])
    const [forwardStack, setForwardStack] = useState<NavEntry[]>([])
    const [bioExpanded, setBioExpanded] = useState(false)

    // ── URL ↔ navStack sync (deep-link support) ──────────────────────────────
    const [searchParams, setSearchParams] = useSearchParams()
    // Refs mirror router/stack state so each sync effect below only reacts to
    // the dependency that actually changed (navStack vs searchParams).
    const searchParamsRef = useRef(searchParams)
    const setSearchParamsRef = useRef(setSearchParams)
    const navStackRef = useRef(navStack)
    const lastSyncedParamsRef = useRef<URLSearchParams | null>(null)
    const prevStackLenRef = useRef(0)
    const prevOpenRef = useRef(false)

    useEffect(() => { searchParamsRef.current = searchParams }, [searchParams])
    useEffect(() => { setSearchParamsRef.current = setSearchParams }, [setSearchParams])
    useEffect(() => { navStackRef.current = navStack }, [navStack])

    const applyPersonResult = useCallback((personName: string, res: PersonFilmographyResult) => {
        setNavStack(prev => {
            const next = [...prev]
            const lastIdx = next.length - 1
            if (lastIdx >= 0 && next[lastIdx].kind === 'person' && next[lastIdx].name === personName) {
                const cur = next[lastIdx]
                next[lastIdx] = {
                    ...cur,
                    name: res.person.name || cur.name,
                    photo: res.person.photo || cur.photo,
                    biography: res.person.biography,
                    birthday: res.person.birthday,
                    deathday: res.person.deathday,
                    placeOfBirth: res.person.placeOfBirth,
                    knownFor: res.person.knownFor,
                    movies: res.movies,
                    series: res.series,
                    anime: res.anime,
                    loading: false,
                }
            }
            return next
        })
    }, [])

    const markPersonLoadFailed = useCallback((personName: string) => {
        setNavStack(prev => {
            const next = [...prev]
            const lastIdx = next.length - 1
            if (lastIdx >= 0 && next[lastIdx].kind === 'person' && next[lastIdx].name === personName) {
                next[lastIdx] = { ...next[lastIdx], loading: false }
            }
            return next
        })
    }, [])

    useEffect(() => {
        if (open && item) {
            prevStackLenRef.current = 0
            // Deep-link/refresh: if the URL already describes this item with
            // nested nav (episode/account/person), rebuild that stack. Entries
            // needing fetches (person filmography) start loading and hydrate
            // in place; deep-linked episodes get their TMDB id patched once
            // the series meta resolves (see effect below).
            const p = parseDetailParams(searchParamsRef.current)
            if (p && p.detail === item.itemId && (p.person || p.account || (p.season != null && p.episode != null))) {
                const rebuilt: NavEntry[] = [{ kind: 'item', item }]
                if (p.season != null && p.episode != null) {
                    rebuilt.push({
                        kind: 'episode',
                        seriesName: item.name || 'Series',
                        seriesImdbId: item.itemId.startsWith('tt') ? item.itemId : undefined,
                        seasonNumber: p.season,
                        episodeNumber: p.episode,
                        episodeName: `Episode ${p.episode}`,
                        seriesTmdbId: null,
                        seriesPoster: item.poster,
                    })
                } else if (p.account) {
                    rebuilt.push({ kind: 'account', accountId: p.account })
                }
                const personName = p.person
                if (personName) {
                    rebuilt.push({ kind: 'person', name: personName, movies: [], series: [], anime: [], loading: true, activeTab: 'all' })
                    fetchPersonFilmography(personName, filmographyFallbackFor(item))
                        .then(res => applyPersonResult(personName, res))
                        .catch(() => markPersonLoadFailed(personName))
                }
                setNavStack(rebuilt)
            } else {
                setNavStack([{ kind: 'item', item }])
            }
            setForwardStack([])
            setActiveItem(item)
            setSeriesTmdbId(null)
            setBioExpanded(false)
        }
    }, [open, item, applyPersonResult, markPersonLoadFailed])

    const currentEntry = useMemo(
        () => navStack[navStack.length - 1] ?? (item ? { kind: 'item', item } : null),
        [navStack, item]
    )
    const previousEntry = navStack.length > 1 ? navStack[navStack.length - 2] : null

    // navStack → URL: a deeper stack PUSHes a history entry (browser Back pops
    // one nav level); shallower/in-place changes REPLACE so closing the modal
    // or its own Back button don't pollute history.
    useEffect(() => {
        const wasOpen = prevOpenRef.current
        prevOpenRef.current = open
        if (!open) {
            prevStackLenRef.current = 0
            if (wasOpen && parseDetailParams(searchParamsRef.current)) {
                lastSyncedParamsRef.current = null
                setSearchParamsRef.current(stripDetailParams(searchParamsRef.current), { replace: true })
            }
            return
        }
        // Wait for the opening effect to rebuild the stack before updating the URL.
        if (!wasOpen) return
        const grew = navStack.length > prevStackLenRef.current
        prevStackLenRef.current = navStack.length
        const desired = paramsForStack(navStack)
        if (!desired) return
        lastSyncedParamsRef.current = desired
        if (!paramsEqual(searchParamsRef.current, desired)) {
            setSearchParamsRef.current(desired, { replace: !grew })
        }
        // Router callback changes must not write stale modal state over Back/Forward navigation.
    }, [open, navStack])

    // URL → navStack: reconcile external param changes (browser back/forward)
    // back into the stack. Our own writes are recognised via
    // lastSyncedParamsRef; the open-flip commit is skipped because the open
    // effect above already restored any deep-linked state.
    const prevOpenForSyncRef = useRef(false)
    useEffect(() => {
        const wasOpen = prevOpenForSyncRef.current
        prevOpenForSyncRef.current = open
        if (!open || !wasOpen) return
        if (lastSyncedParamsRef.current && paramsEqual(lastSyncedParamsRef.current, searchParams)) return
        lastSyncedParamsRef.current = searchParams
        const target = parseDetailParams(searchParams)
        if (!target) return // detail params removed — the page closes the modal
        const prev = navStackRef.current
        const baseEntry = prev.find((e): e is Extract<NavEntry, { kind: 'item' }> => e.kind === 'item')
        let stack: NavEntry[]
        let baseItem: DetailItem
        if (baseEntry && baseEntry.item.itemId === target.detail) {
            // Browser Back: pop entries no longer reflected in the URL.
            stack = [...prev]
            while (stack.length > 1) {
                const cur = paramsForStack(stack)
                if (cur && paramsEqual(cur, searchParams)) break
                stack.pop()
            }
            baseItem = baseEntry.item
        } else {
            // Forward nav to a different base film — rebuild around a minimal
            // item; the modal's metadata fetch fills in name/poster.
            baseItem = { itemId: target.detail, type: target.type || 'movie' }
            stack = [{ kind: 'item', item: baseItem }]
            setActiveItem(baseItem)
        }
        // Browser Forward / manual URL: re-add encoded entries that aren't in
        // the surviving stack (filmography re-fetches asynchronously).
        let personToFetch: string | null = null
        let top = stack[stack.length - 1]
        if (target.season != null && target.episode != null && top.kind === 'item') {
            stack.push({
                kind: 'episode',
                seriesName: top.item.name || 'Series',
                seriesImdbId: target.detail.startsWith('tt') ? target.detail : undefined,
                seasonNumber: target.season,
                episodeNumber: target.episode,
                episodeName: `Episode ${target.episode}`,
                // Reuse metadata only when Forward restores an episode of the same base series.
                seriesTmdbId: baseEntry?.item.itemId === target.detail ? seriesTmdbId : null,
                seriesPoster: top.item.poster,
            })
            top = stack[stack.length - 1]
        }
        if (target.account && top.kind === 'item') {
            stack.push({ kind: 'account', accountId: target.account })
            top = stack[stack.length - 1]
        }
        if (target.person && !(top.kind === 'person' && top.name === target.person && !top.loading)) {
            stack.push({ kind: 'person', name: target.person, movies: [], series: [], anime: [], loading: true, activeTab: 'all' })
            personToFetch = target.person
        }
        setNavStack(stack)
        setForwardStack([])
        if (personToFetch) {
            const personName = personToFetch
            fetchPersonFilmography(personName, filmographyFallbackFor(baseItem))
                .then(res => applyPersonResult(personName, res))
                .catch(() => markPersonLoadFailed(personName))
        }
    }, [searchParams, open, seriesTmdbId, applyPersonResult, markPersonLoadFailed])

    // Deep-linked episodes are rebuilt without a TMDB id (the URL only carries
    // item ids); patch the entry once series meta resolves so EpisodeDetailPage
    // can fetch real episode details and season bounds.
    useEffect(() => {
        if (!seriesTmdbId) return
        setNavStack(prev => {
            const lastIdx = prev.length - 1
            if (lastIdx >= 0 && prev[lastIdx].kind === 'episode' && prev[lastIdx].seriesTmdbId === null) {
                const next = [...prev]
                next[lastIdx] = { ...prev[lastIdx], seriesTmdbId }
                return next
            }
            return prev
        })
    }, [seriesTmdbId])

    const [episodeSeasonBounds, setEpisodeSeasonBounds] = useState<{ maxEpisodes: number; hasPrev: boolean; hasNext: boolean } | null>(null)

    const episodeSeriesTmdbId = currentEntry?.kind === 'episode' ? currentEntry.seriesTmdbId : null
    const episodeSeasonNumber = currentEntry?.kind === 'episode' ? currentEntry.seasonNumber : null

    useEffect(() => {
        if (!episodeSeriesTmdbId) {
            setEpisodeSeasonBounds(null)
            return
        }
        let active = true
        fetchSeasonsList(episodeSeriesTmdbId)
            .then(seasons => {
                if (!active) return
                const sorted = seasons.filter(s => s.seasonNumber >= 1).sort((a, b) => a.seasonNumber - b.seasonNumber)
                const idx = sorted.findIndex(s => s.seasonNumber === episodeSeasonNumber)
                if (idx < 0) { setEpisodeSeasonBounds(null); return }
                setEpisodeSeasonBounds({
                    maxEpisodes: sorted[idx].episodeCount || 0,
                    hasPrev: idx > 0,
                    hasNext: idx < sorted.length - 1,
                })
            })
            .catch(() => { if (active) setEpisodeSeasonBounds(null) })
        return () => { active = false }
    }, [episodeSeriesTmdbId, episodeSeasonNumber])

    const accounts = useAccountStore(state => state.accounts)
    const maskedAccountLabel = useMaskedAccountLabel()

    const previousTitle = previousEntry
        ? previousEntry.kind === 'item'
            ? previousEntry.item.name || 'Details'
            : previousEntry.kind === 'person'
                ? previousEntry.name
                : previousEntry.kind === 'episode'
                    ? previousEntry.seriesName
                    : maskedAccountLabel(accounts.find(a => a.id === previousEntry.accountId))
        : ''

    const renderItem: DetailItem | null = currentEntry?.kind === 'item' ? currentEntry.item : (activeItem ?? item)
    const preferredPoster = continueWatchingPosterFor(cwPosterIndex, renderItem?.itemId)

    // The closed shell still handles navigation and exit animation, but does not
    // need another history derivation or another set of live query observers.
    const { history: derivedWatchHistory } = useWatchHistory(undefined, shouldDeriveModalHistory(open, providedWatchHistory), { sessions: false })
    const allWatchHistory = pickModalHistory(providedWatchHistory, derivedWatchHistory)

    const isPrivacyModeEnabled = useUIStore(s => s.isPrivacyModeEnabled)
    const privacyLevelNames = useUIStore(s => s.privacyLevelNames)

    // The lightbox must not reopen on the next title or a reopened modal.
    useEffect(() => { setLightboxIndex(null); setLightboxZoom(false) }, [open, renderItem?.itemId])

    // Large-title bar: the bar overlays the hero transparently and only fades solid once the
    // hero's bottom edge passes under it. The hero title scrolls with the content and fades out
    // as it reaches the bar, then the bar's own title and thumbnail fade in (iOS-style handoff).
    // Nothing is moved by script, so nothing can lag behind compositor scrolling. Scroll frames
    // write CSS variables only; React state flips at the thresholds.
    // Person view: content loads and hydrates in place, so the collapse re-measures
    // on the loading and biography transitions as well as the item id.
    const detailContentKey = currentEntry?.kind === 'person'
        ? `${currentEntry.name}:${currentEntry.loading}:${currentEntry.biography?.length ?? 0}`
        : renderItem?.itemId
    useEffect(() => {
        setBarShown({ title: false, play: false, pinned: false })
        setBarJoined(false)
        joinedRef.current = false
        if (barRef.current) delete barRef.current.dataset.joined
        const scroller = detailScrollEl
        const bar = barRef.current
        // The person filmography view reuses the same bar and handoff: its hero anchors
        // are the ident row and the large name, and its sticky filter pills join the bar.
        const isPerson = currentEntry?.kind === 'person'
        if (!open || (currentEntry?.kind !== 'item' && !isPerson) || !scroller || !bar) return
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
        let shown = { title: false, play: false, pinned: false }
        const scrollerTop = () => scroller.getBoundingClientRect().top - scroller.scrollTop
        // Content elements are measured in doc space (stable while only scrollTop changes).
        const offsetIn = (el: HTMLElement) => el.getBoundingClientRect().top - scrollerTop()
        // Pinned bar parts never scroll, so their anchor is the offset from the scroller's top
        // edge at any scroll position; adding scrollTop here would shift the collapse window
        // whenever a re-measure happens mid-scroll (e.g. switching items in the open sheet).
        const pinnedTop = (el: HTMLElement) => el.getBoundingClientRect().top - scroller.getBoundingClientRect().top
        const measure = () => {
            const barTitle = barTitleRef.current
            const hero = isPerson ? personHeroRef.current : heroMediaRef.current
            const block = isPerson ? personHeroTitleRef.current : heroTitleRef.current
            const text = block?.firstElementChild instanceof HTMLElement ? block.firstElementChild : null
            const actions = isPerson ? null : heroActionsRef.current
            const textRect = text ? text.getBoundingClientRect() : null
            geo = {
                barHeight: bar.offsetHeight,
                barTitleTop: barTitle ? pinnedTop(barTitle) : 0,
                barTitleHeight: barTitle ? barTitle.getBoundingClientRect().height : 0,
                heroBottom: hero ? offsetIn(hero) + hero.getBoundingClientRect().height : 0,
                heroTitleTop: textRect ? offsetIn(text!) : 0,
                heroTitleHeight: textRect ? textRect.height : 0,
                // While loading there is no actions row; Play stays hidden until one exists.
                actionsBottom: actions ? offsetIn(actions) + actions.getBoundingClientRect().height : Number.POSITIVE_INFINITY,
            }
        }
        const apply = () => {
            frame = 0
            const f = heroCollapseState(scroller.scrollTop, geo)
            bar.style.setProperty('--bar-bg', String(f.bg))
            bar.style.setProperty('--bar-title', String(f.barTitleOpacity))
            bar.style.setProperty('--bar-thumb', String(f.thumb))
            bar.style.setProperty('--bar-play', String(f.play))
            // A sticky section header pinned right under the bar joins it into one
            // block: no shadow or line between the two.
            const stuckHeader = scroller.querySelector<HTMLElement>(isPerson ? '[data-person-pills]' : '[data-episodes-bar]')
            const joined = !!stuckHeader && stuckHeader.getBoundingClientRect().top - bar.getBoundingClientRect().bottom < 1
            if ((bar.dataset.joined === 'true') !== joined) bar.dataset.joined = joined ? 'true' : 'false'
            if (joined !== joinedRef.current) {
                joinedRef.current = joined
                setBarJoined(joined)
            }
            heroTitleRef.current?.style.setProperty('--tt-o', String(f.heroTitleOpacity))
            personHeroTitleRef.current?.style.setProperty('--tt-o', String(f.heroTitleOpacity))
            const next = { title: f.barTitleOpacity > 0.5, play: f.play > 0.5, pinned: f.bg > 0.5 }
            if (next.title !== shown.title || next.play !== shown.play || next.pinned !== shown.pinned) {
                if (shown.play && !next.play && document.activeElement === barPlayRef.current) {
                    (heroPlayRef.current ?? barCloseRef.current)?.focus({ preventScroll: true })
                }
                shown = next
                setBarShown(next)
            }
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
        if (heroTitleRef.current) ro?.observe(heroTitleRef.current)
        if (heroActionsRef.current) ro?.observe(heroActionsRef.current)
        if (personHeroRef.current) ro?.observe(personHeroRef.current)
        if (personHeroTitleRef.current) ro?.observe(personHeroTitleRef.current)
        // The title block has a fixed height: watch the title itself, which grows when a logo
        // loads and is swapped when metadata swaps the text title for a logo.
        let observedTitle: Element | null = null
        const watchTitle = () => {
            const next = heroTitleRef.current?.firstElementChild ?? null
            if (next === observedTitle) return
            if (observedTitle) ro?.unobserve(observedTitle)
            observedTitle = next
            if (next) ro?.observe(next)
        }
        watchTitle()
        const mo = typeof MutationObserver === 'undefined' || !heroTitleRef.current ? null : new MutationObserver(() => {
            watchTitle()
            measure()
            apply()
        })
        if (heroTitleRef.current) mo?.observe(heroTitleRef.current, { childList: true })
        return () => {
            scroller.removeEventListener('scroll', onScroll)
            ro?.disconnect()
            mo?.disconnect()
            if (frame) cancelAnimationFrame(frame)
        }
    }, [open, currentEntry?.kind, detailContentKey, detailScrollEl, loading])

    const otherWatchers = useMemo(() => {
        if (!renderItem?.itemId) return []
        const showIdentity: WatcherItemIdentity = { itemId: renderItem.itemId, name: renderItem.name, type: renderItem.type }
        const seen = new Map<string, { id: string; name: string; emoji?: string; avatar?: string; lastWatched: Date }>()
        for (const h of allWatchHistory) {
            // Cross-source identity: the same show can be addressed by tt ids on one
            // account and a platform-scoped id on another, so exact itemId equality
            // undercounts watchers. watcherMatchesItem falls back to tt and title.
            if (!watcherMatchesItem({ itemId: h.itemId, name: h.name, type: h.type }, showIdentity)) continue
            if (h.accountId === renderItem?.accountId) continue
            const acc = accounts.find(a => a.id === h.accountId)
            if (!acc || acc.hideLastWatched) continue
            const prev = seen.get(h.accountId)
            if (!prev || h.timestamp > prev.lastWatched) {
                seen.set(h.accountId, { id: acc.id, name: acc.name || 'Account', emoji: acc.emoji, avatar: acc.avatar, lastWatched: h.timestamp })
            }
        }
        return [...seen.values()].sort((a, b) => b.lastWatched.getTime() - a.lastWatched.getTime())
    }, [allWatchHistory, renderItem?.itemId, renderItem?.name, renderItem?.type, renderItem?.accountId, accounts])

    const watchersByItemId = useMemo(() => {
        const map = new Map<string, RailWatcher[]>()
        const identityByKey = new Map<string, WatcherItemIdentity>()
        for (const h of allWatchHistory) {
            if (!h.itemId) continue
            const acc = accounts.find(a => a.id === h.accountId)
            if (!acc || acc.hideLastWatched) continue
            const watcher: RailWatcher = { id: acc.id, name: acc.name || 'Account', emoji: acc.emoji, avatar: acc.avatar }
            const list = map.get(h.itemId)
            if (list) {
                if (!list.some(w => w.id === watcher.id)) list.push(watcher)
            } else {
                map.set(h.itemId, [watcher])
                identityByKey.set(h.itemId, { itemId: h.itemId, name: h.name, type: h.type })
            }
        }
        // Same show, different source identities (tt vs platform-scoped ids): share watchers.
        crossLinkWatcherIndex(map, identityByKey)
        return map
    }, [allWatchHistory, accounts])

    // Actually-watched episodes for the rendered series, scoped to the same account/login so
    // other logins' flags never bleed in. An episode only counts with positive completion
    // evidence: a verified bitfield recovery (backfill), the per-episode confirmation flag
    // stamped from the checksum-verified bitfield, or a measured completion of a known
    // duration (>= 95%). A partial watch — even 20% of a known duration — is NOT a
    // completion, and watch-time/aggregate counts never qualify (no duration, no count).
    // Powers the season browser's watched markers — per-episode chronology stays
    // deliberately unavailable for recovered episodes.
    const seriesWatchedEpisodes = useMemo(() => {
        const seriesLike = renderItem?.type === 'series' || renderItem?.type === 'anime' || renderItem?.type === 'episode'
        if (!renderItem?.itemId || !seriesLike) return undefined
        const wantedConnection = renderItem.sourceConnectionId ?? undefined
        const episodes: Array<{ season: number; episode: number }> = []
        for (const h of allWatchHistory) {
            if (h.itemId !== renderItem.itemId) continue
            if (h.season == null || h.episode == null) continue
            if (!Number.isInteger(h.season) || !Number.isInteger(h.episode) || h.episode < 1) continue
            if (renderItem.accountId && h.accountId !== renderItem.accountId) continue
            if ((h.sourceConnectionId ?? undefined) !== wantedConnection) continue
            const confirmed = h.backfill === true
                || (h.flaggedWatched ?? 0) > 0
                || (h.duration > 0 && h.progress >= 95)
            if (!confirmed) continue
            episodes.push({ season: h.season, episode: h.episode })
        }
        return episodes.length > 0 ? episodes : undefined
    }, [allWatchHistory, renderItem?.itemId, renderItem?.type, renderItem?.accountId, renderItem?.sourceConnectionId])

    // Who actually watched each episode of the rendered series, household-wide
    // (every account, every connection, deduped per managed account). Uses the same
    // evidence bar as seriesWatchedEpisodes above, but answers a different question:
    // not "is it marked for this login" but "which people completed it". Built in one
    // history pass plus per-episode ordering; rows use direct lookups and cap their DOM.
    // Deleted/unowned accounts and hideLastWatched opt-outs never leak in, and names
    // carry the privacy name level.
    const seriesEpisodeWatchers = useMemo(() => {
        const seriesLike = renderItem?.type === 'series' || renderItem?.type === 'anime' || renderItem?.type === 'episode'
        if (!renderItem?.itemId || !seriesLike) return undefined
        return buildEpisodeWatcherIndex({
            itemId: renderItem.itemId,
            history: allWatchHistory,
            accounts,
            privacyLevelNames: isPrivacyModeEnabled ? privacyLevelNames : 0,
        })
    }, [allWatchHistory, accounts, renderItem?.itemId, renderItem?.type, isPrivacyModeEnabled, privacyLevelNames])

    const savedEpisodeRanges = useMemo(
        () => renderItem?.importedSavedState ? formatSavedEpisodeRanges(renderItem.savedEpisodes) : [],
        [renderItem?.importedSavedState, renderItem?.savedEpisodes],
    )

    const accountFilms = useMemo(() => {
        if (currentEntry?.kind !== 'account') return null
        const films = new Map<string, { id: string; title: string; poster?: string; type: string; lastWatched: Date }>()
        for (const h of allWatchHistory) {
            if (h.accountId !== currentEntry.accountId) continue
            const type = h.type === 'episode' ? 'series' : (h.type || 'movie')
            const existing = films.get(h.itemId)
            if (!existing || h.timestamp > existing.lastWatched) {
                films.set(h.itemId, { id: h.itemId, title: h.name || 'Unknown', poster: h.poster || undefined, type, lastWatched: h.timestamp })
            }
        }
        const all = [...films.values()].sort((a, b) => b.lastWatched.getTime() - a.lastWatched.getTime())
        return {
            movies: all.filter(f => f.type === 'movie'),
            series: all.filter(f => f.type === 'series'),
            anime: all.filter(f => f.type === 'anime'),
            all,
            count: all.length,
        }
    }, [allWatchHistory, currentEntry])

    useEffect(() => {
        if (!open || !renderItem?.itemId) return
        let active = true
        const itemId = renderItem.itemId
        Promise.all([
            getWatchlist().catch(() => []),
            ...accounts.map(a => getWatchlist(a.id).catch(() => [] as Awaited<ReturnType<typeof getWatchlist>>))
        ]).then(([globalList, ...accountLists]) => {
            if (!active) return
            const targets = new Set<string>()
            if (globalList.some(i => i.itemId === itemId)) targets.add('')
            accounts.forEach((a, i) => {
                if (accountLists[i]?.some(i => i.itemId === itemId)) targets.add(a.id)
            })
            setWatchlistTargets(targets)
        }).catch(() => { })
        return () => { active = false }
    }, [open, renderItem?.itemId, accounts])

    const handleToggleWatchlistTarget = useCallback(async (target: string) => {
        if (!renderItem?.itemId || watchlistLoading) return
        const itemId = renderItem.itemId
        const itemType = renderItem.type === 'anime' ? 'series' : renderItem.type
        const itemName = renderItem.name
        const itemPoster = renderItem.poster
        const accountId = target === '' ? undefined : target
        setWatchlistLoading(true)
        try {
            if (watchlistTargets.has(target)) {
                await traceAsync('watchlist-remove', () => removeFromWatchlist(itemId, accountId))
                setWatchlistTargets(prev => { const s = new Set(prev); s.delete(target); return s })
                toast({ title: 'Removed from Watchlist' })
            } else {
                await traceAsync('watchlist-add', () => addToWatchlist(itemId, itemType, itemName, itemPoster, accountId))
                setWatchlistTargets(prev => new Set(prev).add(target))
                const targetAccount = accounts.find(a => a.id === target)
                toast({ title: 'Added to Watchlist', description: target === '' ? 'Available in your universal catalog' : `Added to ${maskedAccountLabel(targetAccount)} watchlist` })
            }
        } catch {
            toast({ variant: 'destructive', title: 'Watchlist update failed' })
        } finally {
            setWatchlistLoading(false)
        }
    }, [renderItem?.itemId, renderItem?.type, renderItem?.name, renderItem?.poster, watchlistTargets, watchlistLoading, accounts, maskedAccountLabel])

    const jfFavoritePeople = useMemo(() => {
        const seen = new Set<string>()
        const out: JellyfinFavoritePerson[] = []
        for (const account of accounts) {
            const connections: Connection[] = []
            for (const connection of account.connections ?? []) {
                if (connection.platform !== 'jellyfin' || !connection.enabled) continue
                if (!jellyfinFavoritesCapable(connection.mediaServer?.product)) continue
                if (seen.has(connection.id)) continue
                seen.add(connection.id)
                connections.push(connection)
            }
            if (connections.length > 0) out.push({ account, connections })
        }
        return out
    }, [accounts])

    const jfFavoriteIds = useMemo(() => {
        const ids: string[] = []
        const push = (value: string | null | undefined) => {
            if (!value) return
            if (!/^(?:tt\d{5,}|(?:tmdb|tvdb):\d+)$/i.test(value)) return
            if (!ids.includes(value)) ids.push(value)
        }
        push(renderItem?.itemId)
        push(resolvedImdbId)
        if (seriesTmdbId) push(`tmdb:${seriesTmdbId}`)
        if (typeof renderItem?.tmdbId === 'number' && renderItem.tmdbId > 0) push(`tmdb:${renderItem.tmdbId}`)
        return ids
    }, [renderItem?.itemId, renderItem?.tmdbId, resolvedImdbId, seriesTmdbId])
    const jfFavoriteSeries = renderItem?.type !== 'movie'

    // ── Back/forward history ─────────────────────────────────────────────────
    // The stack is bounded (12 like the sheet-history mockup); a back moves the
    // popped entry onto the forward stack, a new push clears it, and the hero
    // Back chip keeps its pop-one behaviour through the same handleGoBack.
    const MAX_NAV_STACK = 12

    const handleGoBack = () => {
        if (navStack.length > 1) {
            setForwardStack(prev => [...prev, navStack[navStack.length - 1]])
            setNavStack(prev => prev.slice(0, -1))
            setBioExpanded(false)
        }
    }

    const handleGoForward = () => {
        if (forwardStack.length === 0) return
        const entry = forwardStack[forwardStack.length - 1]
        setForwardStack(prev => prev.slice(0, -1))
        setNavStack(prev => [...prev, entry])
        setBioExpanded(false)
    }

    const pushNavEntry = useCallback((entry: NavEntry) => {
        setForwardStack([])
        setNavStack(prev => (prev.length >= MAX_NAV_STACK ? [...prev.slice(prev.length - MAX_NAV_STACK + 1), entry] : [...prev, entry]))
    }, [])

    // Alt+Left/Right inside the sheet runs through the shared DialogAltHistory
    // stack, so the sheet's history participates in the same per-dialog
    // arbitration as every other sheet (deepest owner, nested dialogs suspend).
    const handleEpisodeClick = useCallback((data: {
        episodeNumber: number
        episodeName: string
        episodeOverview?: string
        airDate?: string
        still?: string
        seasonNumber: number
        seriesTmdbId: number | null
    }) => {
        pushNavEntry({
            kind: 'episode',
            seriesName: renderItem?.name || 'Series',
            seriesImdbId: renderItem?.itemId?.startsWith('tt') ? renderItem.itemId : undefined,
            seasonNumber: data.seasonNumber,
            episodeNumber: data.episodeNumber,
            episodeName: data.episodeName,
            episodeOverview: data.episodeOverview,
            airDate: data.airDate,
            still: data.still,
            seriesTmdbId: data.seriesTmdbId,
            seriesPoster: renderItem?.poster,
        })
    }, [renderItem?.name, renderItem?.poster, renderItem?.itemId, pushNavEntry])

    const handleAccountClick = useCallback((accountId: string) => {
        pushNavEntry({ kind: 'account', accountId })
        setBioExpanded(false)
    }, [pushNavEntry])

    const handlePersonClick = useCallback((person: { name: string; photo?: string }, role: string) => {
        const personEntry: NavEntry = {
            kind: 'person',
            name: person.name,
            photo: person.photo,
            role,
            movies: [],
            series: [],
            anime: [],
            loading: true,
            activeTab: 'all',
        }

        pushNavEntry(personEntry)
        setBioExpanded(false)

        fetchPersonFilmography(person.name, filmographyFallbackFor(renderItem, role))
            .then(res => applyPersonResult(person.name, res))
            .catch(() => markPersonLoadFailed(person.name))
    }, [renderItem, applyPersonResult, markPersonLoadFailed, pushNavEntry])

    const handleSelectFilmFromFilmography = (film: FilmographyItem) => {
        const newItem: DetailItem = {
            itemId: film.id,
            type: film.type,
            name: film.title,
            poster: film.poster,
            year: film.year,
            voteAverage: film.voteAverage,
        }
        setActiveItem(newItem)
        pushNavEntry({ kind: 'item', item: newItem })
    }

    const handleSetFilmographyTab = (tab: 'all' | 'movies' | 'series' | 'anime') => {
        setNavStack(prev => {
            const next = [...prev]
            const lastIdx = next.length - 1
            if (lastIdx >= 0 && next[lastIdx].kind === 'person') {
                next[lastIdx] = { ...next[lastIdx], activeTab: tab }
            }
            return next
        })
    }

    const handleNextTrailer = () => {
        if (!meta?.videoList || meta.videoList.length === 0) return
        const currentIndex = meta.videoList.findIndex(v => v.key === trailer?.youTubeId)
        const nextIndex = (currentIndex + 1) % meta.videoList.length
        const nextVid = meta.videoList[nextIndex]
        if (nextVid) {
            setTrailer({ youTubeId: nextVid.key, source: 'tmdb' })
            toast({
                title: 'Switched Clip',
                description: `Now playing: ${nextVid.name || nextVid.type}`,
            })
        }
    }

    useEffect(() => {
        if (!open || !renderItem) return
        let active = true
        performance.mark('detail:metadata:start')
        const markMetaEnd = () => {
            performance.mark('detail:metadata:end')
            performance.measure('detail:metadata', 'detail:metadata:start', 'detail:metadata:end')
        }
        setMeta(null)
        setResolvedImdbId(null)
        setLoading(true)
        setFailed(false)
        setDescExpanded(false)
        setTrailer(null)
        setProviderRatings([])
        setSeriesTmdbId(null)

        const ratings: ProviderRating[] = []
        const isImdbId = renderItem.itemId.startsWith('tt')
        const tmdbMatch = renderItem.itemId.match(/^tmdb:(\d+)$/i)

        // Helper: fetch TMDB enrichment (ratings + rich cast with photos)
        const enrichFromTmdb = async (tmdbNumericId: number, mediaType: 'movie' | 'tv') => {
            const result = await traceAsync('tmdb-enrich', () => fetchTmdbDetailsAsMeta(tmdbNumericId, mediaType))
            const m = result.meta
            if (!active || !m) return
            if (result.imdbId) setResolvedImdbId(previous => previous ?? result.imdbId)
            if (m.imdbRating) {
                const tmdbScore = parseFloat(m.imdbRating)
                if (!isNaN(tmdbScore) && tmdbScore > 0 && !ratings.some(r => r.source === 'tmdb')) {
                    ratings.push({ source: 'tmdb', value: tmdbScore.toFixed(1) })
                    setProviderRatings([...ratings])
                }
            }
            setMeta(prev => {
                const merged: CinemetaMeta = prev ? { ...prev } : {} as CinemetaMeta
                if (m.cast && m.cast.length > 0) merged.cast = m.cast
                if (m.crew && m.crew.length > 0) merged.crew = m.crew
                if (m.background && !merged.background) merged.background = m.background
                if (m.poster && !merged.poster) merged.poster = m.poster
                if (m.name && !merged.name) merged.name = m.name
                if (m.description && !merged.description) merged.description = m.description
                if (m.genre && !merged.genre) merged.genre = m.genre
                if (m.runtime && !merged.runtime) merged.runtime = m.runtime
                if (m.released && !merged.released) merged.released = m.released
                if (m.year && !merged.year) merged.year = m.year
                if (m.director && !merged.director) merged.director = m.director
                if (m.certification) merged.certification = m.certification
                if (m.videoList) merged.videoList = m.videoList
                if (m.relatedList) merged.relatedList = m.relatedList
                if (m.reviewsList) merged.reviewsList = m.reviewsList
                if (m.status) merged.status = m.status
                if (m.originalLanguage) merged.originalLanguage = m.originalLanguage
                if (m.productionCompanies) merged.productionCompanies = m.productionCompanies
                if (m.networks) merged.networks = m.networks
                if (m.galleryBackdrops) merged.galleryBackdrops = m.galleryBackdrops
                if (m.watchProviders) merged.watchProviders = m.watchProviders
                return merged
            })
            // Trailer: prefer TMDB key if available
            if (result.trailerYouTubeId && active) {
                setTrailer({ youTubeId: result.trailerYouTubeId, source: 'tmdb' })
            }
        }

        if (tmdbMatch) {
            // Path A: tmdb:ID — fetch directly from TMDB
            const tmdbId = Number(tmdbMatch[1])
            const mediaType = renderItem.type === 'series' || renderItem.type === 'anime' ? 'tv' : 'movie'
            if (mediaType === 'tv') setSeriesTmdbId(tmdbId)
            traceAsync('tmdb-direct', () => fetchTmdbDetailsAsMeta(tmdbId, mediaType))
                .then(result => {
                    if (!active) return
                    if (result.meta && Object.keys(result.meta).length > 0) {
                        const fullMeta: CinemetaMeta = {
                            id: renderItem.itemId,
                            type: mediaType === 'tv' ? 'series' : 'movie',
                            ...result.meta,
                        } as CinemetaMeta
                        setMeta(fullMeta)
                        setFailed(false)
                        if (result.trailerYouTubeId) {
                            setTrailer({ youTubeId: result.trailerYouTubeId, source: 'tmdb' })
                        }
                        if (result.imdbId) {
                            setResolvedImdbId(result.imdbId)
                            if (!result.trailerYouTubeId) {
                                resolveTrailerAsync({ imdbId: result.imdbId, type: renderItem.type })
                                    .then(res => { if (active) setTrailer(res) })
                                    .catch(() => { })
                            }
                            fetchAdditionalRatings(result.imdbId)
                                .then(extra => {
                                    if (active && extra.length > 0) {
                                        setProviderRatings(prev => mergeRatingsKeepExisting(prev, extra))
                                    }
                                })
                                .catch(() => { })
                        }
                    } else {
                        throw new Error('TMDB returned empty')
                    }
                })
                .catch(async (err) => {
                    if (!active) return
                    if (import.meta.env.DEV) console.warn('[ActivityDetail] TMDB path failed, trying Cinemeta fallback:', err)

                    try {
                        const fallbackImdb = await fetchTmdbImdbId(tmdbId, mediaType).catch(() => null)
                        const cinemetaId = fallbackImdb || null

                        if (cinemetaId && cinemetaId.startsWith('tt')) {
                            setResolvedImdbId(cinemetaId)
                            const cinemetaResult = await traceAsync('cinemeta-fallback', () => fetchCinemetaDetail(cinemetaId, renderItem.type))
                            if (active && cinemetaResult) {
                                setMeta(cinemetaResult)
                                setFailed(false)
                                resolveTrailerAsync({ imdbId: cinemetaId, type: renderItem.type, cinemetaMeta: cinemetaResult })
                                    .then(res => { if (active) setTrailer(res) })
                                    .catch(() => { })
                                fetchAdditionalRatings(cinemetaId)
                                    .then(extra => {
                                        if (active && extra.length > 0) {
                                            setProviderRatings(prev => mergeRatingsKeepExisting(prev, extra))
                                        }
                                    })
                                    .catch(() => { })
                            } else {
                                if (active) setFailed(true)
                            }
                        } else if (renderItem.name) {
                            const searchType = mediaType === 'tv' ? 'series' : 'movie'
                            const metas = await searchCinemeta(renderItem.name, undefined, searchType)
                            if (!active) return
                            const normalizedName = renderItem.name.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
                            const matches = metas.filter(m => m.type === searchType
                                && m.name.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '') === normalizedName)
                            const uniqueMatches = [...new Map(matches.map(match => [match.id, match])).values()]
                            const match = uniqueMatches.length === 1 ? uniqueMatches[0] : undefined
                            if (!active) return
                            if (match?.id && String(match.id).startsWith('tt')) {
                                setResolvedImdbId(String(match.id))
                                const cinemetaResult = await traceAsync('cinemeta-search', () =>
                                    fetchCinemetaDetail(String(match.id), renderItem.type)
                                )
                                if (!active) return
                                if (cinemetaResult) {
                                    setMeta(cinemetaResult)
                                    setFailed(false)
                                    resolveTrailerAsync({ imdbId: String(match.id), type: renderItem.type, cinemetaMeta: cinemetaResult })
                                        .then(res => { if (active) setTrailer(res) })
                                        .catch(() => { })
                                    fetchAdditionalRatings(String(match.id))
                                        .then(extra => {
                                            if (active && extra.length > 0) {
                                                setProviderRatings(prev => mergeRatingsKeepExisting(prev, extra))
                                            }
                                        })
                                        .catch(() => { })
                                } else {
                                    setFailed(true)
                                }
                            } else {
                                setFailed(true)
                            }
                        } else {
                            if (active) setFailed(true)
                        }
                    } catch {
                        if (active) setFailed(true)
                    }
                })
                .finally(() => { if (active) { markMetaEnd(); setLoading(false) } })

        } else if (isImdbId) {
            // Path B: tt* — Cinemeta baseline + TMDB enrichment in parallel
            const cinemetaPromise = traceAsync('cinemeta', () => fetchCinemetaDetail(renderItem.itemId, renderItem.type))

            // Start TMDB lookup in parallel (with auth headers). The row's own TMDB id
            // wins over find-by-IMDb: a stub IMDb id must not pin the artwork to nothing.
            const preferTv = renderItem.type === 'series' || renderItem.type === 'anime'
            const rowTmdbId = typeof renderItem.tmdbId === 'number' && renderItem.tmdbId > 0 ? renderItem.tmdbId : undefined
            const tmdbEnrichPromise = rowTmdbId
                ? (async () => {
                    const mediaType = preferTv ? 'tv' as const : 'movie' as const
                    if (mediaType === 'tv') setSeriesTmdbId(rowTmdbId)
                    return enrichFromTmdb(rowTmdbId, mediaType)
                })().catch(() => { })
                : proxyFetch<TmdbFindPayload>(
                    `find/${encodeURIComponent(renderItem.itemId)}?external_source=imdb_id`
                ).then(data => {
                    if (!data || !active) return
                    const picked = pickTmdbIdFromFind(data, preferTv)
                    if (!picked) return
                    if (picked.via !== 'movie') setSeriesTmdbId(picked.tmdbId)
                    return enrichFromTmdb(picked.tmdbId, picked.mediaType)
                })
                    .catch(() => { })

            // Kick off PMDB and additional ratings (MDBList / RT / Metacritic) in parallel
            traceAsync('pmdb', () => getPmdbRatingFromImdb(renderItem.itemId, renderItem.type))
                .then(r => {
                    if (import.meta.env?.DEV) console.log('[trace] pmdb result:', r ? `score=${r.score}` : 'null')
                    if (!active || !r || r.score === null) return
                    ratings.push({
                        source: 'pmdb',
                        value: r.score.toFixed(1),
                    })
                    setProviderRatings([...ratings])
                })
                .catch(() => { })

            traceAsync('ratings', () => fetchAdditionalRatings(renderItem.itemId))
                .then(extra => {
                    if (!active || extra.length === 0) return
                    ratings.push(...extra)
                    setProviderRatings([...ratings])
                })
                .catch(() => { })

            apiGet<CinemetaReview[]>(`/metadata/comments?imdbId=${encodeURIComponent(renderItem.itemId)}&type=${encodeURIComponent(renderItem.type || '')}`)
                .then(serverComments => {
                    if (!active || !Array.isArray(serverComments) || serverComments.length === 0) return
                    setMeta(prev => {
                        const base = prev ?? {} as CinemetaMeta
                        const existing = base.reviewsList || []
                        const combined = [...existing]
                        for (const r of serverComments) {
                            if (!combined.some(x => x.id === r.id || (x.author === r.author && x.content === r.content))) {
                                combined.push(r)
                            }
                        }
                        return { ...base, reviewsList: combined }
                    })
                })
                .catch(() => { })

            cinemetaPromise
                .then(result => {
                    if (!active) return
                    if (result?.tmdbId && (renderItem.type === 'series' || renderItem.type === 'anime' || renderItem.type === 'episode')) {
                        setSeriesTmdbId(result.tmdbId!)
                    }
                    setMeta(prev => {
                        if (!prev) return result
                        return {
                            ...result,
                            cast: prev.cast && prev.cast.length > 3 ? prev.cast : (result?.cast || prev.cast),
                            crew: prev.crew && prev.crew.length > 0 ? prev.crew : (result?.crew || prev.crew),
                            director: prev.director && prev.director.length > 0 ? prev.director : (result?.director || prev.director),
                            videoList: prev.videoList || result?.videoList,
                            relatedList: prev.relatedList || result?.relatedList,
                            reviewsList: prev.reviewsList || result?.reviewsList,
                            status: prev.status || result?.status,
                            originalLanguage: prev.originalLanguage || result?.originalLanguage,
                            productionCompanies: prev.productionCompanies || result?.productionCompanies,
                            networks: prev.networks || result?.networks,
                        }
                    })
                    setFailed(result === null)
                    resolveTrailerAsync({ imdbId: renderItem.itemId, type: renderItem.type, cinemetaMeta: result })
                        .then(res => { if (!active) return; setTrailer(prev => prev ?? res) })
                        .catch(() => { })
                })
                .catch(() => { if (!active) return; setFailed(true) })
                .finally(() => {
                    if (active) { markMetaEnd(); setLoading(false) }
                    return tmdbEnrichPromise
                })

        } else {
            // Path C: unknown ID format — try Cinemeta fallback
            fetchCinemetaDetail(renderItem.itemId, renderItem.type)
                .then(result => {
                    if (!active) return
                    setMeta(result)
                    setFailed(result === null)
                    resolveTrailerAsync({ imdbId: renderItem.itemId, type: renderItem.type, cinemetaMeta: result })
                        .then(res => { if (!active) return; setTrailer(res) })
                        .catch(() => { })
                })
                .catch(() => { if (!active) return; setFailed(true) })
                .finally(() => { if (active) { markMetaEnd(); setLoading(false) } })
        }

        return () => { active = false }
    }, [open, renderItem])

    const cast = useMemo(() => getCast(meta), [meta])
    const crew = useMemo(() => getCrew(meta), [meta])

    const artwork = renderItem ? detailArtwork({
        itemId: renderItem.itemId,
        itemPoster: renderItem.poster,
        itemBackdrop: renderItem.backdrop,
        metaPoster: meta?.poster,
        metaBackground: meta?.background,
        resolvedImdbId: resolvedImdbId ?? undefined,
        tmdbId: renderItem.tmdbId,
    }) : undefined
    // Production year from resolved metadata; only a real release year may gate the search.
    const titleSearchYear = useMemo(() => {
        const parsed = Number.parseInt(`${meta?.released ?? meta?.year ?? ''}`.slice(0, 4), 10)
        return Number.isFinite(parsed) && parsed > 1900 ? parsed : undefined
    }, [meta?.released, meta?.year])
    // Hero art's own strict last resort: the title search backdrop joins only after
    // the row backdrop and metadata enrichment (including the row TMDB id) came
    // back with nothing, and only as the final candidate in the error chain.
    useEffect(() => {
        const title = renderItem?.name?.trim()
        if (!open || !renderItem || !title || loading || meta?.background || renderItem.backdrop) {
            setTitleBackdrop(undefined)
            return
        }
        let active = true
        void fetchTmdbArtworkByTitle(title, titleSearchYear, renderItem.type).then(match => {
            if (active) setTitleBackdrop(match?.backdropUrl)
        })
        return () => { active = false }
    }, [open, renderItem, loading, meta?.background, titleSearchYear])
    const backgroundCandidates = artwork
        ? [...artwork.backgroundCandidates, ...(titleBackdrop && !artwork.backgroundCandidates.includes(titleBackdrop) ? [titleBackdrop] : [])]
        : []
    const backgroundKey = backgroundCandidates.join('|')
    // A new candidate list (e.g. the TMDB backdrop landing) restarts the hero chain.
    useEffect(() => { setHeroAttempt(0) }, [backgroundKey])

    // Artwork colour: the pinned bar tint, Play pill and section accents take the
    // poster's dominant colour, muted into the card (title contrast kept >= 4.5:1).
    // No-CORS poster hosts leave the neutral card chrome.
    const [artworkChrome, setArtworkChrome] = useState<ArtworkChrome | null>(null)
    const posterUrl = artwork?.posterSrc ?? null
    // The bar tint follows the CURRENT nav entry only: a person view resolves its own
    // photo (neutral when there is none) and never keeps the previous entry's poster colour.
    const personPhotoUrl = currentEntry?.kind === 'person' && currentEntry.photo
        ? (currentEntry.photo.startsWith('http') ? currentEntry.photo : `${TMDB_PROFILE_BASE}${currentEntry.photo}`)
        : null
    const chromeSourceUrl = currentEntry?.kind === 'person' ? personPhotoUrl : posterUrl
    useEffect(() => {
        if (!open) { setArtworkChrome(null); return }
        if (!chromeSourceUrl) { setArtworkChrome(null); return }
        let active = true
        void dominantColorFromImageUrl(chromeSourceUrl).then(dominant => {
            if (!active) return
            if (!dominant) { setArtworkChrome(null); return }
            const { card, fg } = themeSurfaceColors()
            setArtworkChrome(deriveArtworkChrome(dominant, card, fg))
        })
        return () => { active = false }
    }, [open, chromeSourceUrl])

    // Pinned-bar controls: the solid card bar always takes the theme foreground
    // with its contrasting focus ring.
    const barControlTone = 'text-foreground focus-visible:ring-ring/60'

    if (!renderItem) return null

    const title = meta?.name?.trim() || renderItem.name || 'Unknown Title'
    const { posterSrc, posterItemId, posterTmdbId } = artwork!
    const background = backgroundCandidates[heroAttempt]
    const heroReady = !!background && heroReadySrc === background
    // Artwork-coloured section accent; null keeps the theme's primary.
    const sectionAccent = artworkChrome ? { color: rgbCss(artworkChrome.accent) } : undefined
    // Each hero renders the same src twice (glow + image); a failure advances past that candidate once.
    const advanceHero = () => setHeroAttempt(value => (value === heroAttempt ? value + 1 : value))
    const year = getYear(meta, renderItem)
    const genres = getGenres(meta, renderItem)
    const description = meta?.description?.trim() || renderItem.description?.trim() || ''
    const rawVoteAverage = typeof renderItem.voteAverage === 'number' && renderItem.voteAverage > 0
        ? renderItem.voteAverage.toFixed(1)
        : undefined

    const imdbRating = meta?.imdbRating?.trim() || rawVoteAverage
    const runtime = meta?.runtime?.trim()
    const normalizedType = renderItem.type === 'anime' ? 'series' : renderItem.type

    const ratingMap = new Map<string, ProviderRating>()
    if (imdbRating) {
        ratingMap.set('imdb', { source: 'imdb', value: imdbRating })
    }
    if (rawVoteAverage && !ratingMap.has('imdb')) {
        ratingMap.set('tmdb', { source: 'tmdb', value: rawVoteAverage })
    }
    for (const r of providerRatings) {
        if (!ratingMap.has(r.source)) {
            ratingMap.set(r.source, r)
        }
    }
    const allRatings = Array.from(ratingMap.values())

    const dataSources: string[] = []
    if (meta) dataSources.push('Cinemeta')
    if (meta?.videoList || meta?.relatedList || meta?.reviewsList || meta?.crew) dataSources.push('TMDB')
    const hasTraktOrLetterboxd = providerRatings.some(r => r.source === 'trakt' || r.source === 'letterboxd')
    if (hasTraktOrLetterboxd) dataSources.push('MDBList')

    const canCollapse = description.length > DESCRIPTION_COLLAPSE_LENGTH

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent
                className={cn(
                    // Override the built-in DialogContent base styles (grid, gap-4, p-4/p-6, max-w-lg, max-h)
                    '!grid-cols-none !gap-0 !p-0',
                    // Structure
                    'flex flex-col overflow-hidden',
                    '!h-[92vh] !max-h-[92vh] rounded-t-3xl',
                    'sm:!max-w-6xl sm:!max-h-[92vh] sm:!h-auto text-card-foreground',
                )}
                hideClose
            >
                <DialogBack active={navStack.length > 1} onBack={handleGoBack} />
                <DialogAltHistory
                    active={open && (navStack.length > 1 || forwardStack.length > 0)}
                    canBack={navStack.length > 1}
                    canForward={forwardStack.length > 0}
                    onBack={handleGoBack}
                    onForward={handleGoForward}
                />
                {currentEntry?.kind === 'person' ? (
                    /* ══ PERSON FILMOGRAPHY VIEW (Separated Movies, Series & Anime) ══════════════════ */
                    // pt-0.5 keeps scrolled content off the sheet's top edge row, mirroring the title sheet.
                    <div className="relative flex min-h-0 flex-1 flex-col pt-0.5">
                        {/* Pinned person bar: the title sheet's machinery (sheet history, iOS handoff, joined pills) */}
                        <div
                            ref={barRef}
                            data-slim-bar=""
                            data-person-bar=""
                            className="group/bar pointer-events-none absolute inset-x-0 top-0 z-40 flex h-14 items-center gap-2 pl-2 pr-3 sm:pl-3"
                            style={{ '--bar-bg': 0, '--bar-title': 0 } as CSSProperties}
                        >
                            <PinnedBarMaterial />
                            {/* Round back/forward pair, reachable at any scroll depth */}
                            {(navStack.length > 1 || forwardStack.length > 0) && (
                                <div className="relative flex shrink-0 items-center gap-1">
                                    <button
                                        type="button"
                                        data-theme-part="button"
                                        data-bar-back=""
                                        onClick={handleGoBack}
                                        disabled={navStack.length <= 1}
                                        aria-label={previousEntry ? `Back to ${previousTitle}` : 'Back'}
                                        className={cn('pointer-events-auto relative flex h-11 w-11 items-center justify-center rounded-full transition-all hover:scale-105 active:scale-95 motion-reduce:transition-none motion-reduce:hover:scale-100 focus-visible:outline-none focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-35 sm:h-9 sm:w-9', barControlTone)}
                                    >
                                        <ArrowLeft className="h-4 w-4" />
                                        <span className="sr-only">{previousEntry ? `Back to ${previousTitle}` : 'Back'}</span>
                                    </button>
                                    <button
                                        type="button"
                                        data-theme-part="button"
                                        data-bar-forward=""
                                        onClick={handleGoForward}
                                        disabled={forwardStack.length === 0}
                                        aria-label="Forward"
                                        className={cn('pointer-events-auto relative flex h-11 w-11 items-center justify-center rounded-full transition-all hover:scale-105 active:scale-95 motion-reduce:transition-none motion-reduce:hover:scale-100 focus-visible:outline-none focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-35 sm:h-9 sm:w-9', barControlTone)}
                                    >
                                        <ArrowRight className="h-4 w-4" />
                                        <span className="sr-only">Forward</span>
                                    </button>
                                </div>
                            )}
                            {/* Small photo and name fade in only after the large name fades out */}
                            <div aria-hidden={!barShown.title} className="relative flex min-w-0 flex-1 items-center gap-2">
                                <div
                                    data-bar-photo=""
                                    className="relative h-7 w-7 shrink-0 overflow-hidden rounded-full bg-muted ring-1 ring-border/40"
                                    style={{ opacity: 'var(--bar-title)', transform: 'scale(calc(0.85 + 0.15 * var(--bar-title)))' } as CSSProperties}
                                >
                                    {currentEntry.photo ? (
                                        <img
                                            src={currentEntry.photo.startsWith('http') ? currentEntry.photo : `${TMDB_PROFILE_BASE}${currentEntry.photo}`}
                                            alt=""
                                            className="h-full w-full object-cover"
                                            loading="lazy"
                                        />
                                    ) : (
                                        <CastInitials name={currentEntry.name} />
                                    )}
                                </div>
                                <p ref={barTitleRef} data-bar-title="" className="min-w-0 flex-1 truncate text-xs font-bold text-foreground sm:text-sm" style={{ opacity: 'var(--bar-title)' }}>{currentEntry.name}</p>
                            </div>
                            <button
                                ref={barCloseRef}
                                type="button"
                                data-theme-part="button"
                                onClick={() => onOpenChange(false)}
                                aria-label="Close"
                                className={cn('pointer-events-auto relative flex h-11 w-11 shrink-0 items-center justify-center rounded-full border shadow-md backdrop-blur-sm transition-all hover:scale-105 active:scale-95 motion-reduce:transition-none motion-reduce:hover:scale-100 focus-visible:outline-none focus-visible:ring-2 sm:h-9 sm:w-9', isLight ? 'border-border/60 bg-card/90 text-foreground hover:bg-muted focus-visible:ring-ring/40' : 'border-white/15 bg-black/50 text-white/90 hover:bg-black/75 focus-visible:ring-white/40')}
                            >
                                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                                </svg>
                                <span className="sr-only">Close</span>
                            </button>
                        </div>

                        <div ref={setDetailScrollEl} className="scrollbar-hide min-h-0 flex-1 overflow-y-auto overscroll-contain" data-detail-scroll="">
                            <div className="overflow-x-clip">
                        {/* Person Header scrolls; the bar replaces it once the name fades out */}
                        <div className={cn('relative px-4 pb-4 pt-14 sm:px-8 sm:pb-5 sm:pt-[60px]', isLight ? 'bg-muted/50 text-foreground' : 'bg-card text-white')}>
                            <div ref={personHeroRef} className="flex items-start gap-3 sm:gap-6">
                                {/* Person Avatar */}
                                <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-full border-2 border-primary/60 bg-muted shadow-2xl sm:h-24 sm:w-24">
                                    {currentEntry.photo ? (
                                        <img
                                            src={currentEntry.photo.startsWith('http') ? currentEntry.photo : `${TMDB_PROFILE_BASE}${currentEntry.photo}`}
                                            alt={currentEntry.name}
                                            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                                        />
                                    ) : (
                                        <CastInitials name={currentEntry.name} />
                                    )}
                                </div>

                                <div className="flex-1 min-w-0">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span data-theme-part="badge" className="rounded-md bg-primary/85 px-2 py-0.5 text-[11px] font-bold uppercase tracking-widest text-primary-foreground">
                                            {currentEntry.knownFor || currentEntry.role || 'Filmography'}
                                        </span>
                                    </div>
                                    <div ref={personHeroTitleRef}>
                                        <h2 style={heroTitleFadeStyle} className={cn('mt-1 text-xl font-extrabold sm:text-2xl tracking-tight sm:text-4xl', isLight ? 'text-foreground' : 'text-white')}>
                                            {currentEntry.name}
                                        </h2>
                                    </div>

                                    {/* Birth / Age / Place Info */}
                                    {(() => {
                                        const birthInfo = formatPersonBirthInfo(currentEntry.birthday, currentEntry.placeOfBirth, currentEntry.deathday)
                                        return birthInfo ? (
                                            <p className={cn('mt-1 text-xs font-medium', isLight ? 'text-muted-foreground' : 'text-white/80')}>
                                                {birthInfo}
                                            </p>
                                        ) : null
                                    })()}

                                    <p className={cn('mt-1 text-xs', isLight ? 'text-muted-foreground/70' : 'text-white/60')}>
                                        {currentEntry.loading
                                            ? 'Loading filmography...'
                                            : `${currentEntry.movies.length} Movies · ${currentEntry.series.length} TV Series${currentEntry.anime.length > 0 ? ` · ${currentEntry.anime.length} Anime` : ''}`
                                        }
                                    </p>
                                </div>
                            </div>

                            {/* Biography Card */}
                            {currentEntry.biography && (
                                <div data-theme-part="panel" className={cn('mt-4 rounded-xl border p-2.5 sm:p-3.5 text-xs leading-relaxed backdrop-blur-sm sm:text-sm', isLight ? 'border-border/40 bg-muted/30 text-muted-foreground' : 'border-white/10 bg-white/5 text-white/90')}>
                                    <p className={cn(!bioExpanded && 'line-clamp-3 sm:line-clamp-4')}>
                                        {currentEntry.biography}
                                    </p>
                                    {currentEntry.biography.length > 220 && (
                                        <button
                                            type="button"
                                            data-theme-part="button"
                                            onClick={() => setBioExpanded(!bioExpanded)}
                                            className="mt-1.5 inline-flex items-center gap-1 text-xs font-bold text-primary hover:underline"
                                        >
                                            {bioExpanded ? (
                                                <>Show Less <ChevronUp className="h-3 w-3" /></>
                                            ) : (
                                                <>Read Biography <ChevronDown className="h-3 w-3" /></>
                                            )}
                                        </button>
                                    )}
                                </div>
                            )}
                        </div>

                        {/* Category Filter Tabs: stick under the pinned bar and join it, like the episodes header */}
                        {!currentEntry.loading && (currentEntry.movies.length > 0 || currentEntry.series.length > 0 || currentEntry.anime.length > 0) && (
                            <div
                                data-person-pills=""
                                data-joined={barJoined ? 'true' : undefined}
                                className={cn(
                                    'sticky top-[3.25rem] z-20 -mx-4 flex items-center gap-2 overflow-x-auto px-4 pb-3 pt-3 scrollbar-hide sm:-mx-6 sm:px-6',
                                    barJoined
                                        ? 'border-b border-[color:var(--chrome-line)] bg-card shadow-[0_10px_24px_-12px_rgba(0,0,0,0.45)]'
                                        : 'border-b border-border/50 bg-card',
                                )}
                            >
                                <button
                                    type="button"
                                    data-theme-part="tab"
                                    data-state={currentEntry.activeTab === 'all' ? 'active' : 'inactive'}
                                    onClick={() => handleSetFilmographyTab('all')}
                                    className={cn(
                                        'flex min-h-[40px] flex-none items-center whitespace-nowrap rounded-full px-4 text-xs font-bold transition-all',
                                        currentEntry.activeTab === 'all'
                                            ? heroTabActive
                                            : heroTabInactive
                                    )}
                                >
                                    All ({currentEntry.movies.length + currentEntry.series.length + currentEntry.anime.length})
                                </button>
                                {currentEntry.movies.length > 0 && (
                                    <button
                                        type="button"
                                        data-theme-part="tab"
                                        data-state={currentEntry.activeTab === 'movies' ? 'active' : 'inactive'}
                                        onClick={() => handleSetFilmographyTab('movies')}
                                        className={cn(
                                            'flex min-h-[40px] flex-none items-center whitespace-nowrap rounded-full px-4 text-xs font-bold transition-all',
                                            currentEntry.activeTab === 'movies'
                                                ? heroTabActive
                                                : heroTabInactive
                                        )}
                                    >
                                        Movies ({currentEntry.movies.length})
                                    </button>
                                )}
                                {currentEntry.series.length > 0 && (
                                    <button
                                        type="button"
                                        data-theme-part="tab"
                                        data-state={currentEntry.activeTab === 'series' ? 'active' : 'inactive'}
                                        onClick={() => handleSetFilmographyTab('series')}
                                        className={cn(
                                            'flex min-h-[40px] flex-none items-center whitespace-nowrap rounded-full px-4 text-xs font-bold transition-all',
                                            currentEntry.activeTab === 'series'
                                                ? heroTabActive
                                                : heroTabInactive
                                        )}
                                    >
                                        TV Series ({currentEntry.series.length})
                                    </button>
                                )}
                                {currentEntry.anime.length > 0 && (
                                    <button
                                        type="button"
                                        data-theme-part="tab"
                                        data-state={currentEntry.activeTab === 'anime' ? 'active' : 'inactive'}
                                        onClick={() => handleSetFilmographyTab('anime')}
                                        className={cn(
                                            'flex min-h-[40px] flex-none items-center whitespace-nowrap rounded-full px-4 text-xs font-bold transition-all',
                                            currentEntry.activeTab === 'anime'
                                                ? heroTabActive
                                                : heroTabInactive
                                        )}
                                    >
                                        Anime ({currentEntry.anime.length})
                                    </button>
                                )}
                            </div>
                        )}

                        {/* Filmography Posters Grid Body */}
                        <div className="space-y-6 px-4 py-4 sm:space-y-8 sm:px-6 sm:py-6">
                            {currentEntry.loading ? (
                                <div className="grid grid-cols-2 gap-3 sm:gap-4 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
                                    {Array.from({ length: 12 }).map((_, i) => (
                                        <div key={i} className="space-y-2">
                                            <Skeleton className="aspect-[2/3] w-full rounded-xl" />
                                            <Skeleton className="h-3 w-3/4 rounded" />
                                        </div>
                                    ))}
                                </div>
                            ) : currentEntry.movies.length === 0 && currentEntry.series.length === 0 && currentEntry.anime.length === 0 ? (
                                <div className="flex h-64 flex-col items-center justify-center text-center">
                                    <User className="h-10 w-10 text-muted-foreground/40 mb-2" />
                                    <p className="text-sm font-medium text-muted-foreground">No filmography entries found for this person.</p>
                                </div>
                            ) : (
                                <>
                                    {/* ── MOVIES SECTION ───────────────────────────────────── */}
                                    {(currentEntry.activeTab === 'all' || currentEntry.activeTab === 'movies') && currentEntry.movies.length > 0 && (
                                        <div>
                                            <h3 className="mb-3.5 flex items-center gap-2 border-b border-[color:var(--chrome-line)] pb-2 text-xs font-bold uppercase tracking-widest text-muted-foreground/80">
                                                <Film className="h-4 w-4 text-primary" style={sectionAccent} />
                                                Movies ({currentEntry.movies.length})
                                            </h3>
                                            <div className="grid grid-cols-2 gap-3 sm:gap-4 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
                                                {currentEntry.movies.map((film, idx) => (
                                                    <FilmPosterCard key={`movie-${film.id}-${idx}`} film={film} watchers={watchersByItemId.get(film.id) ?? []} onClick={() => handleSelectFilmFromFilmography(film)} />
                                                ))}
                                            </div>
                                        </div>
                                    )}

                                    {/* ── TV SERIES SECTION ────────────────────────────────── */}
                                    {(currentEntry.activeTab === 'all' || currentEntry.activeTab === 'series') && currentEntry.series.length > 0 && (
                                        <div>
                                            <h3 className="mb-3.5 flex items-center gap-2 border-b border-[color:var(--chrome-line)] pb-2 text-xs font-bold uppercase tracking-widest text-muted-foreground/80">
                                                <Clapperboard className="h-4 w-4 text-primary" style={sectionAccent} />
                                                TV Series ({currentEntry.series.length})
                                            </h3>
                                            <div className="grid grid-cols-2 gap-3 sm:gap-4 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
                                                {currentEntry.series.map((film, idx) => (
                                                    <FilmPosterCard key={`series-${film.id}-${idx}`} film={film} watchers={watchersByItemId.get(film.id) ?? []} onClick={() => handleSelectFilmFromFilmography(film)} />
                                                ))}
                                            </div>
                                        </div>
                                    )}

                                    {/* ── ANIME SECTION ────────────────────────────────────── */}
                                    {(currentEntry.activeTab === 'all' || currentEntry.activeTab === 'anime') && currentEntry.anime.length > 0 && (
                                        <div>
                                            <h3 className="mb-3.5 flex items-center gap-2 border-b border-[color:var(--chrome-line)] pb-2 text-xs font-bold uppercase tracking-widest text-muted-foreground/80">
                                                <Star className="h-4 w-4 text-amber-400" />
                                                Anime ({currentEntry.anime.length})
                                            </h3>
                                            <div className="grid grid-cols-2 gap-3 sm:gap-4 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
                                                {currentEntry.anime.map((film, idx) => (
                                                    <FilmPosterCard key={`anime-${film.id}-${idx}`} film={film} watchers={watchersByItemId.get(film.id) ?? []} onClick={() => handleSelectFilmFromFilmography(film)} />
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                </>
                            )}
                        </div>
                            </div>
                        </div>
                    </div>
                ) : currentEntry?.kind === 'episode' ? (
                    <EpisodeDetailPage
                        seriesName={currentEntry.seriesName}
                        seriesImdbId={currentEntry.seriesImdbId}
                        seasonNumber={currentEntry.seasonNumber}
                        episodeNumber={currentEntry.episodeNumber}
                        episodeName={currentEntry.episodeName}
                        episodeOverview={currentEntry.episodeOverview}
                        airDate={currentEntry.airDate}
                        still={currentEntry.still}
                        seriesTmdbId={currentEntry.seriesTmdbId}
                        isAnime={renderItem?.type === 'anime'}
                        isLight={isLight}
                        maxEpisodesInSeason={episodeSeasonBounds?.maxEpisodes || null}
                        hasPrevSeason={episodeSeasonBounds?.hasPrev ?? false}
                        hasNextSeason={episodeSeasonBounds?.hasNext ?? false}
                        onPersonClick={handlePersonClick}
                        onAccountClick={handleAccountClick}
                        episodeWatchers={seriesEpisodeWatchers}
                        onGoBack={handleGoBack}
                        onGoForward={handleGoForward}
                        canForward={forwardStack.length > 0}
                        onClose={() => onOpenChange(false)}
                        onNavigateEpisode={(season, episode) => {
                            const applyNav = (s: number, e: number) => {
                                setNavStack(prev => {
                                    const next = [...prev]
                                    const lastIdx = next.length - 1
                                    if (lastIdx >= 0 && next[lastIdx].kind === 'episode') {
                                        const cur = next[lastIdx]
                                        next[lastIdx] = {
                                            ...cur,
                                            seasonNumber: s,
                                            episodeNumber: e,
                                            episodeName: `Loading S${s}E${e}...`,
                                            episodeOverview: undefined,
                                            airDate: undefined,
                                            still: undefined,
                                        }
                                    }
                                    return next
                                })
                            }
                            if (episode < 0) {
                                const targetSeason = season
                                const tid = currentEntry?.kind === 'episode' ? currentEntry.seriesTmdbId : null
                                if (tid) {
                                    fetchSeasonEpisodes(tid, targetSeason)
                                        .then(eps => {
                                            const last = eps.length > 0 ? Math.max(...eps.map(x => x.episodeNumber)) : 1
                                            applyNav(targetSeason, last)
                                        })
                                        .catch(() => applyNav(targetSeason, 1))
                                } else {
                                    applyNav(targetSeason, 1)
                                }
                            } else {
                                applyNav(season, episode)
                            }
                        }}
                    />
                ) : currentEntry?.kind === 'account' ? (
                    <div className="flex h-[92vh] sm:h-[88vh] flex-col overflow-hidden bg-card text-card-foreground">
                        <div className={cn('relative shrink-0 border-b border-border/40 px-4 py-4 sm:px-8 sm:py-5', isLight ? 'bg-muted/50 text-foreground' : 'bg-card text-white')}>
                            <button
                                type="button"
                                data-theme-part="button"
                                onClick={() => onOpenChange(false)}
                                aria-label="Close"
                                className={cn('absolute right-4 top-4 z-30 flex h-9 w-9 items-center justify-center rounded-full border shadow-lg backdrop-blur-md transition-all hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 active:scale-95', heroFrostedBtn)}
                            >
                                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                                </svg>
                                <span className="sr-only">Close</span>
                            </button>

                            {/* Round back/forward pair beside the Back chip */}
                            {(navStack.length > 1 || forwardStack.length > 0) && (
                                <div className="mb-3 flex items-center gap-1">
                                    <button
                                        type="button"
                                        data-theme-part="button"
                                        onClick={handleGoBack}
                                        disabled={navStack.length <= 1}
                                        aria-label={previousEntry ? `Back to ${previousTitle}` : 'Back'}
                                        className="flex h-9 w-9 items-center justify-center rounded-full border shadow-lg backdrop-blur-md transition-all hover:scale-105 active:scale-95 motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 disabled:pointer-events-none disabled:opacity-35"
                                    >
                                        <ArrowLeft className="h-4 w-4" />
                                        <span className="sr-only">{previousEntry ? `Back to ${previousTitle}` : 'Back'}</span>
                                    </button>
                                    <button
                                        type="button"
                                        data-theme-part="button"
                                        onClick={handleGoForward}
                                        disabled={forwardStack.length === 0}
                                        aria-label="Forward"
                                        className="flex h-9 w-9 items-center justify-center rounded-full border shadow-lg backdrop-blur-md transition-all hover:scale-105 active:scale-95 motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 disabled:pointer-events-none disabled:opacity-35"
                                    >
                                        <ArrowRight className="h-4 w-4" />
                                        <span className="sr-only">Forward</span>
                                    </button>
                                </div>
                            )}
                            {previousEntry && (
                                <button
                                    type="button"
                                    data-theme-part="button"
                                    onClick={handleGoBack}
                                    className={cn('mb-3 inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-xs font-bold backdrop-blur-md transition-all active:scale-95', heroGhostBtn)}
                                >
                                    <ArrowLeft className="h-4 w-4" />
                                    Back to {previousTitle}
                                </button>
                            )}

                            <div className="flex items-start gap-3 sm:gap-6">
                                <div className="h-20 w-20 shrink-0 sm:h-24 sm:w-24">
                                    {(() => {
                                        const acc = accounts.find(a => a.id === currentEntry.accountId)
                                        return acc
                                            ? <AccountAvatar account={acc} size="lg" className="!h-20 !w-20 sm:!h-24 sm:!w-24 rounded-full border-2 border-primary/60 shadow-2xl overflow-hidden" />
                                            : <div className="flex h-20 w-20 items-center justify-center rounded-full border-2 border-primary/60 bg-muted sm:h-24 sm:w-24"><Users className="h-8 w-8 text-muted-foreground" /></div>
                                    })()}
                                </div>

                                <div className="flex-1 min-w-0">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span data-theme-part="badge" className="rounded-md bg-primary/85 px-2 py-0.5 text-[11px] font-bold uppercase tracking-widest text-primary-foreground">
                                            Watch History
                                        </span>
                                    </div>
                                    <h2 className={cn('mt-1 text-xl font-extrabold sm:text-2xl tracking-tight sm:text-4xl', isLight ? 'text-foreground' : 'text-white')}>
                                        {maskedAccountLabel(accounts.find(a => a.id === currentEntry.accountId))}
                                    </h2>
                                    <p className={cn('mt-1 text-xs', isLight ? 'text-muted-foreground/70' : 'text-white/60')}>
                                        {accountFilms ? `${accountFilms.count} ${accountFilms.count === 1 ? 'title' : 'titles'} watched` : 'Loading history...'}
                                    </p>
                                </div>
                            </div>
                        </div>

                        <div className="flex-1 overflow-y-auto px-4 py-4 sm:px-6 sm:py-6 space-y-6 sm:space-y-8">
                            {!accountFilms || accountFilms.count === 0 ? (
                                <div className="flex h-64 flex-col items-center justify-center text-center">
                                    <Users className="h-10 w-10 text-muted-foreground/40 mb-2" />
                                    <p className="text-sm font-medium text-muted-foreground">No watch history found for this account.</p>
                                </div>
                            ) : (
                                <>
                                    {accountFilms.movies.length > 0 && (
                                        <div>
                                            <h3 className="mb-3.5 flex items-center gap-2 border-b border-[color:var(--chrome-line)] pb-2 text-xs font-bold uppercase tracking-widest text-muted-foreground/80">
                                                <Film className="h-4 w-4 text-primary" style={sectionAccent} />
                                                Movies ({accountFilms.movies.length})
                                            </h3>
                                            <div className="grid grid-cols-2 gap-3 sm:gap-4 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
                                                {accountFilms.movies.map(film => (
                                                    <FilmPosterCard key={`acc-movie-${film.id}`} film={{ id: film.id, title: film.title, poster: film.poster, type: film.type as 'movie' | 'series' | 'anime' }} watchers={watchersByItemId.get(film.id) ?? []} showSubtitle={false} onClick={() => handleSelectFilmFromFilmography({ id: film.id, title: film.title, poster: film.poster, type: film.type as 'movie' | 'series' | 'anime' })} />
                                                ))}
                                            </div>
                                        </div>
                                    )}

                                    {accountFilms.series.length > 0 && (
                                        <div>
                                            <h3 className="mb-3.5 flex items-center gap-2 border-b border-[color:var(--chrome-line)] pb-2 text-xs font-bold uppercase tracking-widest text-muted-foreground/80">
                                                <Clapperboard className="h-4 w-4 text-primary" style={sectionAccent} />
                                                TV Series ({accountFilms.series.length})
                                            </h3>
                                            <div className="grid grid-cols-2 gap-3 sm:gap-4 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
                                                {accountFilms.series.map(film => (
                                                    <FilmPosterCard key={`acc-series-${film.id}`} film={{ id: film.id, title: film.title, poster: film.poster, type: film.type as 'movie' | 'series' | 'anime' }} watchers={watchersByItemId.get(film.id) ?? []} showSubtitle={false} onClick={() => handleSelectFilmFromFilmography({ id: film.id, title: film.title, poster: film.poster, type: film.type as 'movie' | 'series' | 'anime' })} />
                                                ))}
                                            </div>
                                        </div>
                                    )}

                                    {accountFilms.anime.length > 0 && (
                                        <div>
                                            <h3 className="mb-3.5 flex items-center gap-2 border-b border-[color:var(--chrome-line)] pb-2 text-xs font-bold uppercase tracking-widest text-muted-foreground/80">
                                                <Star className="h-4 w-4 text-amber-400" />
                                                Anime ({accountFilms.anime.length})
                                            </h3>
                                            <div className="grid grid-cols-2 gap-3 sm:gap-4 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
                                                {accountFilms.anime.map(film => (
                                                    <FilmPosterCard key={`acc-anime-${film.id}`} film={{ id: film.id, title: film.title, poster: film.poster, type: film.type as 'movie' | 'series' | 'anime' }} watchers={watchersByItemId.get(film.id) ?? []} showSubtitle={false} onClick={() => handleSelectFilmFromFilmography({ id: film.id, title: film.title, poster: film.poster, type: film.type as 'movie' | 'series' | 'anime' })} />
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                </>
                            )}
                        </div>
                    </div>
                ) : (
                    /* ══ MOVIE DETAIL VIEW ══════════════════════════════════════════ */
                    // pt-0.5 keeps scrolled content off the sheet's top edge row: a centered sheet can sit on a
                    // half pixel, and the composited scroller then snaps one row above what the pinned bar covers.
                    <div className="relative flex min-h-0 flex-1 flex-col pt-0.5">
                        {/* Large-title bar: fades in piece by piece as the hero passes under it */}
                        <div
                            ref={barRef}
                            data-slim-bar=""
                            className="group/bar pointer-events-none absolute inset-x-0 top-0 z-40 flex h-14 items-center gap-2 pl-2 pr-3 sm:pl-3"
                            style={{ '--bar-bg': 0, '--bar-title': 0 } as CSSProperties}
                        >
                            {/* Overshoots the sheet's top and side edges (the sheet clips it) so no border or fractional display scaling leaves a strip of content above the pinned bar. While a section header is stuck under the bar the two join into one block: the bar's own bottom line, rim and shadow drop out (the header's surface carries them at the block's bottom edge). */}
                            <PinnedBarMaterial />
                            {/* Round back/forward pair, reachable at any scroll depth */}
                            {(navStack.length > 1 || forwardStack.length > 0) && (
                                <div className="relative flex shrink-0 items-center gap-1">
                                    <button
                                        type="button"
                                        data-theme-part="button"
                                        data-bar-back=""
                                        onClick={handleGoBack}
                                        disabled={navStack.length <= 1}
                                        aria-label={previousEntry ? `Back to ${previousTitle}` : 'Back'}
                                        className={cn('pointer-events-auto relative flex h-11 w-11 items-center justify-center rounded-full transition-all hover:scale-105 active:scale-95 motion-reduce:transition-none motion-reduce:hover:scale-100 focus-visible:outline-none focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-35 sm:h-9 sm:w-9', barControlTone)}
                                    >
                                        <ArrowLeft className="h-4 w-4" />
                                        <span className="sr-only">{previousEntry ? `Back to ${previousTitle}` : 'Back'}</span>
                                    </button>
                                    <button
                                        type="button"
                                        data-theme-part="button"
                                        data-bar-forward=""
                                        onClick={handleGoForward}
                                        disabled={forwardStack.length === 0}
                                        aria-label="Forward"
                                        className={cn('pointer-events-auto relative flex h-11 w-11 items-center justify-center rounded-full transition-all hover:scale-105 active:scale-95 motion-reduce:transition-none motion-reduce:hover:scale-100 focus-visible:outline-none focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-35 sm:h-9 sm:w-9', barControlTone)}
                                    >
                                        <ArrowRight className="h-4 w-4" />
                                        <span className="sr-only">Forward</span>
                                    </button>
                                </div>
                            )}
                            <div aria-hidden={!barShown.title} className="relative flex min-w-0 flex-1 items-center gap-2">
                                <div
                                    data-bar-thumb=""
                                    className="relative h-10 w-7 shrink-0 overflow-hidden rounded-md bg-muted ring-1 ring-border/40"
                                    style={{ opacity: 'var(--bar-thumb)', transform: 'scale(calc(0.85 + 0.15 * var(--bar-thumb)))', ...(artworkChrome ? { '--tw-ring-color': `rgb(${artworkChrome.dominant.r} ${artworkChrome.dominant.g} ${artworkChrome.dominant.b} / 0.55)` } : {}) } as CSSProperties}
                                >
                                    <Poster src={posterSrc} itemId={posterItemId} tmdbId={posterTmdbId} itemType={renderItem.type} name={renderItem.name} year={titleSearchYear} preferredSrc={preferredPoster} alt="" className="h-full w-full object-cover" loading="lazy" />
                                </div>
                                <p ref={barTitleRef} data-bar-title="" className="min-w-0 flex-1 truncate text-xs font-bold text-foreground sm:text-sm" style={{ opacity: 'var(--bar-title)' }}>{title}</p>
                            </div>
                            {isStremioFriendlyType(normalizedType) && (
                                <button
                                    ref={barPlayRef}
                                    type="button"
                                    data-theme-part="button"
                                    aria-hidden={!barShown.play}
                                    disabled={!barShown.play}
                                    style={{ opacity: 'var(--bar-play)', ...(artworkChrome ? { background: rgbCss(artworkChrome.pill), color: rgbCss(artworkChrome.pillForeground) } : null) }}
                                    className={cn('relative inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-4 text-xs font-bold shadow-md transition-transform active:scale-95 sm:h-9 sm:px-5', barShown.play && 'pointer-events-auto', !artworkChrome && heroPrimaryBtn)}
                                    onClick={() => openStremioDetail(renderItem.type, renderItem.itemId)}
                                >
                                    <Play className="h-3.5 w-3.5 fill-current" />
                                    Play
                                    <span className="sr-only">{title}</span>
                                </button>
                            )}
                            <button
                                ref={barCloseRef}
                                type="button"
                                data-theme-part="button"
                                onClick={() => onOpenChange(false)}
                                aria-label="Close"
                                className={cn('pointer-events-auto relative flex h-11 w-11 shrink-0 items-center justify-center rounded-full border shadow-md backdrop-blur-sm transition-all hover:scale-105 active:scale-95 motion-reduce:transition-none motion-reduce:hover:scale-100 focus-visible:outline-none focus-visible:ring-2 sm:h-9 sm:w-9', isLight ? 'border-border/60 bg-card/90 text-foreground hover:bg-muted focus-visible:ring-ring/40' : 'border-white/15 bg-black/50 text-white/90 hover:bg-black/75 focus-visible:ring-white/40')}
                            >
                                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                                </svg>
                                <span className="sr-only">Close</span>
                            </button>
                        </div>

                        <div ref={setDetailScrollEl} className="scrollbar-hide min-h-0 flex-1 overflow-y-auto overscroll-contain" data-detail-scroll="">
                            <div className="overflow-x-clip">
                                <div ref={heroMediaRef} className="relative w-full overflow-hidden bg-black text-white -mb-1 h-[clamp(110px,22vh,200px)] sm:h-[clamp(180px,24vh,380px)] lg:h-[clamp(220px,38vh,380px)]" style={{ transform: 'translateZ(0)' }}>
                            <div className="absolute inset-0 bg-black" aria-hidden="true" />
                            {background && (
                                <img
                                    src={background}
                                    alt=""
                                    aria-hidden="true"
                                    onError={advanceHero}
                                    className={cn(
                                        'absolute inset-0 h-full w-full object-cover filter blur-3xl scale-125 transition-opacity duration-300 motion-reduce:transition-none',
                                        heroReady ? 'opacity-40' : 'opacity-0',
                                    )}
                                />
                            )}

                            {loading && !background ? (
                                <Skeleton className="absolute inset-0 h-full w-full rounded-none" />
                            ) : background ? (
                                <img
                                    src={background}
                                    alt=""
                                    aria-hidden="true"
                                    loading="eager"
                                    decoding="async"
                                    onError={advanceHero}
                                    onLoad={() => setHeroReadySrc(background)}
                                    className={cn(
                                        'media-ring absolute inset-0 h-full w-full object-cover transition-opacity duration-300 motion-reduce:transition-none',
                                        heroReady ? 'opacity-95' : 'opacity-0',
                                    )}
                                    style={{
                                        maskImage: 'linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,0.9) 70%, rgba(0,0,0,0) 100%)',
                                        WebkitMaskImage: 'linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,0.9) 70%, rgba(0,0,0,0) 100%)',
                                    }}
                                />
                            ) : (
                                <div className="absolute inset-0 bg-black/90" />
                            )}

                            <div className="pointer-events-none absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-black/50 via-black/15 to-transparent" />
                            <div className="pointer-events-none absolute inset-y-0 left-0 w-3/5 bg-gradient-to-r from-black/60 via-black/20 to-transparent" />

                        </div>

                        {/* ══ POSTER + TITLE ROW (overlaps hero) ═══════════════════ */}
                        <div className="relative -mt-16 px-4 sm:px-8">
                            <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:gap-6">

                                {/* Poster — taller on desktop */}
                                <div className="relative hidden aspect-[2/3] w-24 sm:block sm:w-32 shrink-0 overflow-hidden rounded-xl shadow-2xl ring-1 ring-white/10 sm:w-40 sm:rounded-2xl">
                                    {loading ? (
                                        <Skeleton className="h-full w-full rounded-none" />
                                    ) : (
                                        <Poster
                                            src={posterSrc}
                                            itemId={posterItemId}
                                            tmdbId={posterTmdbId}
                                            itemType={renderItem.type}
                                            name={renderItem.name}
                                            year={titleSearchYear}
                                            preferredSrc={preferredPoster}
                                            alt={title}
                                            className="media-ring h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                                            loading="eager"
                                        />
                                    )}
                                </div>

                                {/* Title + meta block */}
                                <div className="min-w-0 flex-1 pb-1 sm:pb-2">
                                    {loading ? (
                                        <div className="space-y-2.5">
                                            <Skeleton className="h-8 w-3/4 rounded-lg" />
                                            <Skeleton className="h-4 w-1/2 rounded-lg" />
                                            <Skeleton className="h-4 w-1/3 rounded-lg" />
                                        </div>
                                    ) : (
                                        <>

                                            {/* Title — HD logo if available, text fallback */}
                                            <div ref={heroTitleRef} data-hero-title="" className="flex h-16 items-end sm:h-24">
                                                {meta?.logo ? (
                                                    <img
                                                        src={meta.logo}
                                                        alt={title}
                                                        style={heroTitleFadeStyle}
                                                        className="relative max-h-16 w-auto max-w-[90%] object-contain drop-shadow-lg sm:max-h-24"
                                                    />
                                                ) : (
                                                    <h2
                                                        style={heroTitleFadeStyle}
                                                        className="relative text-xl font-extrabold sm:text-2xl leading-tight tracking-tight text-white drop-shadow-sm sm:text-4xl"
                                                    >
                                                        {title}
                                                    </h2>
                                                )}
                                            </div>

                                            {/* Meta pills row */}
                                            <div className="mt-2 flex flex-wrap items-center gap-1.5">
                                                {year && (
                                                    <span className={cn('inline-flex items-center gap-1 text-sm font-medium', isLight ? 'text-muted-foreground' : 'text-white/80')}>
                                                        <Calendar className="h-3.5 w-3.5" />
                                                        {year}
                                                    </span>
                                                )}
                                                {runtime && (
                                                    <>
                                                        <span className={isLight ? 'text-border' : 'text-white/30'}>.</span>
                                                        <span className={cn('inline-flex items-center gap-1 text-sm font-medium', isLight ? 'text-muted-foreground' : 'text-white/80')}>
                                                            <Clock className="h-3.5 w-3.5" />
                                                            {formatRuntime(runtime)}
                                                        </span>
                                                    </>
                                                )}
                                                {meta?.certification && (
                                                    <span data-theme-part="badge" className={cn('ml-1 rounded-md border px-2 py-0.5 font-mono text-[11px] font-bold shadow-sm backdrop-blur-md', isLight ? 'border-border/40 bg-muted/40 text-foreground' : 'border-white/20 bg-white/10 text-white')}>
                                                        {meta.certification}
                                                    </span>
                                                )}
                                            </div>

                                            {/* Rating row — Platform Branded Badges */}
                                            {allRatings.length > 0 && (
                                                <div className="mt-2.5 flex flex-wrap items-center gap-2">
                                                    {allRatings.map((r, idx) => (
                                                        <Tooltip key={`${r.source}-${idx}`} content={RATING_LABELS[r.source] || `${r.source} Rating`}>
                                                            <RatingBadge rating={r} />
                                                        </Tooltip>
                                                    ))}
                                                </div>
                                            )}

                                            {/* Action buttons row — Authentic Apple TV Action Pills */}
                                            <div ref={heroActionsRef} className="mt-4 flex flex-row flex-wrap items-center gap-2 sm:gap-3">
                                                {isStremioFriendlyType(normalizedType) && (
                                                    <button
                                                        ref={heroPlayRef}
                                                        type="button"
                                                        data-theme-part="button"
                                                        style={artworkChrome ? { background: rgbCss(artworkChrome.pill), color: rgbCss(artworkChrome.pillForeground) } : undefined}
                                                        className={cn('inline-flex h-11 flex-1 justify-center items-center gap-2.5 rounded-full px-7 text-sm font-bold shadow-xl transition-all active:scale-95 focus-visible:outline-none focus-visible:ring-2 sm:flex-none sm:w-auto sm:justify-start', !artworkChrome && heroPrimaryBtn)}
                                                        onClick={() => openStremioDetail(renderItem.type, renderItem.itemId)}
                                                    >
                                                        <Play className="h-4 w-4 fill-current" />
                                                        Play
                                                    </button>
                                                )}
                                                <WatchlistPicker
                                                    accounts={accounts}
                                                    watchlistTargets={watchlistTargets}
                                                    onToggle={handleToggleWatchlistTarget}
                                                    loading={watchlistLoading}
                                                />
                                                <JellyfinFavoriteControl
                                                    key={`${renderItem?.accountId ?? ''}:${renderItem?.itemId ?? ''}:${renderItem?.sourceConnectionId ?? ''}`}
                                                    open={open}
                                                    people={jfFavoritePeople}
                                                    canonicalIds={jfFavoriteIds}
                                                    series={jfFavoriteSeries}
                                                />
                                            </div>
                                        </>
                                    )}
                                </div>

                                {otherWatchers.length > 0 && (
                                    <div className="flex w-full items-center gap-2 pt-2 sm:w-auto sm:shrink-0 sm:flex-col sm:items-end sm:gap-2 sm:pb-2">
                                        <span className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground/80 flex items-center gap-1.5">
                                            <Users className="h-3.5 w-3.5" /> Also watched
                                        </span>
                                        <div className="flex items-center -space-x-2">
                                            {otherWatchers.slice(0, 8).map(({ id }) => {
                                                const acc = accounts.find(a => a.id === id)
                                                if (!acc) return null
                                                const maskedName = maskedDisplayName(acc.name, acc.email, isPrivacyModeEnabled ? privacyLevelNames : 0)
                                                return (
                                                    <Tooltip key={id} content={maskedName}>
                                                        <button
                                                            type="button"
                                                            onClick={() => handleAccountClick(id)}
                                                            className="relative flex h-9 w-9 items-center justify-center rounded-full border-2 border-background bg-card overflow-hidden transition-transform hover:scale-110 hover:z-10"
                                                        >
                                                            <AccountAvatar
                                                                account={{ ...acc, name: maskedName }}
                                                                size="md"
                                                                showStatus={false}
                                                                className="!h-full !w-full rounded-full"
                                                            />
                                                        </button>
                                                    </Tooltip>
                                                )
                                            })}
                                        </div>
                                        {otherWatchers.length > 8 && <span className="text-[11px] text-muted-foreground">+{otherWatchers.length - 8}</span>}
                                    </div>
                                )}
                            </div>
                        </div>

                            </div>

                            {/* ══ SCROLLABLE BODY ════════════════════════════════════════ */}
                            <div className="px-5 py-5 sm:px-8">
                            <div className="space-y-6">

                                {/* Loading skeletons */}
                                {loading && (
                                    <div className="space-y-2.5">
                                        <Skeleton className="h-3 w-full rounded" />
                                        <Skeleton className="h-3 w-11/12 rounded" />
                                        <Skeleton className="h-3 w-9/12 rounded" />
                                        <div className="flex flex-wrap gap-1.5 pt-1">
                                            <Skeleton className="h-6 w-16 rounded-full" />
                                            <Skeleton className="h-6 w-20 rounded-full" />
                                            <Skeleton className="h-6 w-14 rounded-full" />
                                        </div>
                                    </div>
                                )}

                                {/* Metadata unavailable notice */}
                                {failed && !loading && !meta && (
                                    <div data-theme-part="panel" data-theme-tone="status" className="rounded-xl border border-warning/25 bg-warning/10 px-3 py-2.5 text-xs text-warning">
                                        Detailed metadata unavailable. Showing basic info.
                                    </div>
                                )}

                                {/* Description - series-level, spoiler-free */}
                                {!loading && description && (
                                    <div className="space-y-1.5">
                                        {renderItem.season !== undefined && renderItem.episode !== undefined && (
                                            <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50">
                                                Series Overview
                                            </p>
                                        )}
                                        <p className={cn(
                                            'text-sm leading-relaxed text-muted-foreground sm:text-base',
                                            !descExpanded && 'line-clamp-3 sm:line-clamp-4',
                                        )}>
                                            {description}
                                        </p>
                                        {canCollapse && (
                                            <button
                                                type="button"
                                                data-theme-part="button"
                                                className="mt-1.5 inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline"
                                                onClick={() => setDescExpanded(v => !v)}
                                            >
                                                {descExpanded
                                                    ? <><ChevronUp className="h-3 w-3" />Show less</>
                                                    : <><ChevronDown className="h-3 w-3" />Show more</>
                                                }
                                            </button>
                                        )}
                                    </div>
                                )}

                                {/* Genre pills */}
                                {!loading && genres.length > 0 && (
                                    <div className="flex flex-wrap gap-1.5">
                                        {genres.map(g => (
                                            <span
                                                key={g}
                                                data-theme-part="badge"
                                                className="rounded-full border border-border/50 bg-muted/40 px-2.5 py-0.5 text-xs font-medium text-foreground/70"
                                            >
                                                {g}
                                            </span>
                                        ))}
                                    </div>
                                )}

                                {/* ── SEASON / EPISODE BROWSER ─────────────────────────────────── */}
                                {!loading && renderItem.importedSavedState && (renderItem.type === 'series' || renderItem.type === 'anime' || renderItem.type === 'episode') && (
                                    <div data-theme-part="panel" className="rounded-xl border border-border/40 bg-muted/30 px-3 py-2.5 text-xs text-muted-foreground">
                                        <span className="font-semibold text-foreground/80">
                                            {renderItem.savedEpisodes
                                                ? `${renderItem.savedEpisodes.episodeCount} episodes saved`
                                                : 'Saved episode history'}
                                        </span>
                                        {savedEpisodeRanges.length > 0 && (
                                            <span className="ml-2 font-mono font-bold text-muted-foreground/70">
                                                {savedEpisodeRanges.join(' · ')}
                                            </span>
                                        )}
                                        <span className="ml-2 opacity-70">watch dates unavailable (imported saved state)</span>
                                    </div>
                                )}
                                <SeasonBrowser
                                    seriesTmdbId={seriesTmdbId}
                                    activeItem={activeItem}
                                    watchedEpisodes={seriesWatchedEpisodes}
                                    episodeWatchers={seriesEpisodeWatchers}
                                    isLight={isLight}
                                    loading={loading}
                                    joined={barJoined}
                                    onEpisodeClick={handleEpisodeClick}
                                />

                                {/* ── WHERE TO WATCH ───────────────────────────────────── */}
                                {!loading && meta?.watchProviders && meta.watchProviders.length > 0 && (
                                    <div>
                                        <h3 className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-muted-foreground/80">
                                            <Play className="h-3.5 w-3.5 text-primary" />
                                            Where to Watch
                                        </h3>
                                        <div className="flex flex-wrap gap-2">
                                            {meta.watchProviders.map((p, i) => (
                                                <div key={i} className="flex items-center gap-1.5 rounded-lg border border-border/40 bg-muted/30 px-2.5 py-1.5">
                                                    {p.logo && (
                                                        <img src={p.logo} alt="" className="h-5 w-5 rounded object-cover" loading="lazy" />
                                                    )}
                                                    <span className="text-xs font-semibold text-foreground/80">{p.name}</span>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                {/* ── BACKDROP GALLERY ──────────────────────────────────── */}
                                {!loading && meta?.galleryBackdrops && meta.galleryBackdrops.length > 0 && (
                                    <div>
                                        <div className="mb-2 flex items-center justify-between">
                                            <h3 className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-muted-foreground/80">
                                                <Film className="h-3.5 w-3.5 text-primary" />
                                                Gallery
                                            </h3>
                                            <div className="flex items-center gap-1">
                                                <button
                                                    type="button"
                                                    data-theme-part="button"
                                                    onClick={() => scrollGalleryRef.current?.scrollBy({ left: -320, behavior: 'smooth' })}
                                                    aria-label="Scroll gallery left"
                                                    className="flex h-7 w-7 items-center justify-center rounded-full border border-border/40 bg-muted/60 text-muted-foreground shadow-sm transition-all hover:bg-accent hover:text-foreground active:scale-95"
                                                >
                                                    <ChevronLeft className="h-4 w-4" />
                                                </button>
                                                <button
                                                    type="button"
                                                    data-theme-part="button"
                                                    onClick={() => scrollGalleryRef.current?.scrollBy({ left: 320, behavior: 'smooth' })}
                                                    aria-label="Scroll gallery right"
                                                    className="flex h-7 w-7 items-center justify-center rounded-full border border-border/40 bg-muted/60 text-muted-foreground shadow-sm transition-all hover:bg-accent hover:text-foreground active:scale-95"
                                                >
                                                    <ChevronRight className="h-4 w-4" />
                                                </button>
                                            </div>
                                        </div>
                                        <div ref={scrollGalleryRef} className="scrollbar-hide -mx-1 flex gap-2 overflow-x-auto px-1 pb-1 scroll-smooth">
                                            {meta.galleryBackdrops.map((img, i) => (
                                                <button
                                                    key={i}
                                                    type="button"
                                                    onClick={() => { setLightboxIndex(i); setLightboxZoom(false) }}
                                                    className="group relative aspect-video w-48 shrink-0 overflow-hidden rounded-lg border border-border/30 bg-muted shadow-sm transition-all hover:border-border/60 hover:shadow-md sm:w-64"
                                                >
                                                    <img src={img} alt="" loading="lazy" className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105" />
                                                    <div className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-all group-hover:bg-black/20 group-hover:opacity-100">
                                                        <span className="rounded-full bg-black/60 px-2 py-1 text-[10px] font-bold text-white backdrop-blur-sm">Expand</span>
                                                    </div>
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                {!loading && (cast.length > 0 || crew.length > 0) && (
                                    <CastSection
                                        cast={cast}
                                        crew={crew}
                                        isLight={isLight}
                                        onPersonClick={handlePersonClick}
                                    />
                                )}

                                {/* ── TRAILER ────────────────────────────────────────── */}
                                {!loading && trailer && (
                                    <div id="modal-trailer-section" ref={trailerSectionRef}>
                                        <div className="mb-2.5 flex items-center justify-between">
                                            <h3 className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-muted-foreground/80">
                                                <Film className="h-3.5 w-3.5 text-primary" />
                                                Trailer
                                                {trailer.source === 'tmdb' && (
                                                    <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-semibold uppercase text-primary">
                                                        TMDB
                                                    </span>
                                                )}
                                            </h3>
                                            {meta?.videoList && meta.videoList.length > 1 && (
                                                <button
                                                    type="button"
                                                    data-theme-part="button"
                                                    onClick={handleNextTrailer}
                                                    className="inline-flex items-center gap-1.5 rounded-full border border-border/50 bg-muted/40 px-3 py-1 text-xs font-bold text-muted-foreground transition-all hover:bg-primary/10 hover:text-primary active:scale-95"
                                                >
                                                    <Film className="h-3 w-3" />
                                                    Try Next Video
                                                </button>
                                            )}
                                        </div>
                                        <div className="relative aspect-video w-full overflow-hidden rounded-2xl border border-border/40 bg-black shadow-xl">
                                            <Tooltip content={`${title} trailer`}>
                                                <iframe
                                                    src={`https://www.youtube.com/embed/${trailer.youTubeId}?enablejsapi=1`}
                                                    className="absolute inset-0 h-full w-full"
                                                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                                                    allowFullScreen
                                                    loading="lazy"
                                                    referrerPolicy="strict-origin-when-cross-origin"
                                                    sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
                                                />
                                            </Tooltip>
                                        </div>
                                        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
                                            <span className="truncate max-w-sm text-muted-foreground/70">
                                                Having trouble? Private or unavailable videos can be searched directly on YouTube.
                                            </span>
                                            <div className="flex items-center gap-2 shrink-0">
                                                {meta?.videoList && meta.videoList.length > 1 && (
                                                    <button
                                                        type="button"
                                                        data-theme-part="button"
                                                        onClick={handleNextTrailer}
                                                        className="inline-flex items-center gap-1 text-xs font-bold text-primary hover:underline"
                                                    >
                                                        ⏭ Switch Clip
                                                    </button>
                                                )}
                                                <a
                                                    data-theme-part="button"
                                                    href={`https://www.youtube.com/results?search_query=${encodeURIComponent(`${title} ${year || ''} trailer`)}`}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="inline-flex items-center gap-1 text-xs font-bold text-primary hover:underline"
                                                >
                                                    <ExternalLink className="h-3 w-3" />
                                                    Search YouTube
                                                </a>
                                            </div>
                                        </div>
                                    </div>
                                )}

                                {/* No trailer */}
                                {!loading && !trailer && (
                                    <div className="flex items-center gap-3 rounded-xl border border-dashed border-border/50 bg-muted/20 px-4 py-3">
                                        <Film className="h-4 w-4 shrink-0 text-muted-foreground/40" />
                                        <span className="text-xs text-muted-foreground">No trailer found.</span>
                                        <a
                                            data-theme-part="button"
                                            href={`https://www.youtube.com/results?search_query=${encodeURIComponent(`${title} ${year} trailer`)}`}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="ml-auto inline-flex items-center gap-1 rounded-lg border border-border/40 bg-background/60 px-2.5 py-1 text-[11px] font-medium text-primary transition-colors hover:border-primary/30 hover:bg-primary/10"
                                        >
                                            <ExternalLink className="h-3 w-3" />
                                            Search YouTube
                                        </a>
                                    </div>
                                )}

                                {/* ── TRAILERS & EXTRA CLIPS CAROUSEL ─────────────────── */}
                                {!loading && meta?.videoList && meta.videoList.length > 1 && (
                                    <div className="mt-6">
                                        <div className="mb-3 flex items-center justify-between">
                                            <h3 className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-muted-foreground/80">
                                                <Film className="h-3.5 w-3.5 text-primary" />
                                                Trailers & Extra Clips ({meta.videoList.length})
                                            </h3>
                                            <div className="flex items-center gap-1">
                                                <button
                                                    type="button"
                                                    data-theme-part="button"
                                                    onClick={() => scrollTrailersRef.current?.scrollBy({ left: -320, behavior: 'smooth' })}
                                                    className="flex h-7 w-7 items-center justify-center rounded-full border border-border/40 bg-muted/60 text-muted-foreground hover:text-foreground"
                                                >
                                                    <ChevronLeft className="h-4 w-4" />
                                                </button>
                                                <button
                                                    type="button"
                                                    data-theme-part="button"
                                                    onClick={() => scrollTrailersRef.current?.scrollBy({ left: 320, behavior: 'smooth' })}
                                                    className="flex h-7 w-7 items-center justify-center rounded-full border border-border/40 bg-muted/60 text-muted-foreground hover:text-foreground"
                                                >
                                                    <ChevronRight className="h-4 w-4" />
                                                </button>
                                            </div>
                                        </div>

                                        <div ref={scrollTrailersRef} className="scrollbar-hide -mx-1 flex gap-4 overflow-x-auto px-1 pb-1 scroll-smooth">
                                            {meta.videoList.map((vid, idx) => (
                                                <button
                                                    type="button"
                                                    key={`vid-${vid.key}-${idx}`}
                                                    onClick={() => {
                                                        setTrailer({ youTubeId: vid.key, source: 'tmdb' })
                                                        trailerSectionRef.current?.scrollIntoView({ behavior: 'smooth' })
                                                    }}
                                                    className="group relative flex w-56 shrink-0 flex-col gap-2 rounded-2xl border border-border/40 bg-card/60 p-2.5 shadow-md transition-all hover:border-primary/50 hover:shadow-xl text-left"
                                                >
                                                    <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-muted">
                                                        <img
                                                            src={`https://img.youtube.com/vi/${vid.key}/mqdefault.jpg`}
                                                            alt={vid.name}
                                                            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                                                            loading="lazy"
                                                        />
                                                        <div className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-80 group-hover:opacity-100 transition-opacity">
                                                            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg">
                                                                <Play className="h-4 w-4 fill-current ml-0.5" />
                                                            </div>
                                                        </div>
                                                        <span className="absolute bottom-2 left-2 rounded-md bg-black/80 px-2 py-0.5 text-[10px] font-extrabold uppercase text-white backdrop-blur-md">
                                                            {vid.type}
                                                        </span>
                                                    </div>
                                                    <Tooltip content={vid.name}>
                                                        <p className="line-clamp-1 text-xs font-bold text-foreground group-hover:text-primary">
                                                            {vid.name}
                                                        </p>
                                                    </Tooltip>
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                {/* ── CONTENT-AWARE MORE LIKE THIS CAROUSEL ─────────────── */}
                                {!loading && meta?.relatedList && meta.relatedList.length > 0 && (
                                    <div className="mt-6">
                                        <div className="mb-3 flex items-center justify-between">
                                            <h3 className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-muted-foreground/80">
                                                <Sparkles className="h-3.5 w-3.5 text-primary" />
                                                Related ({meta.relatedList.length})
                                            </h3>
                                            <div className="flex items-center gap-1">
                                                <button
                                                    type="button"
                                                    data-theme-part="button"
                                                    onClick={() => scrollRelatedRef.current?.scrollBy({ left: -320, behavior: 'smooth' })}
                                                    className="flex h-7 w-7 items-center justify-center rounded-full border border-border/40 bg-muted/60 text-muted-foreground hover:text-foreground"
                                                >
                                                    <ChevronLeft className="h-4 w-4" />
                                                </button>
                                                <button
                                                    type="button"
                                                    data-theme-part="button"
                                                    onClick={() => scrollRelatedRef.current?.scrollBy({ left: 320, behavior: 'smooth' })}
                                                    className="flex h-7 w-7 items-center justify-center rounded-full border border-border/40 bg-muted/60 text-muted-foreground hover:text-foreground"
                                                >
                                                    <ChevronRight className="h-4 w-4" />
                                                </button>
                                            </div>
                                        </div>

                                        <div ref={scrollRelatedRef} className="scrollbar-hide -mx-1 flex gap-4 overflow-x-auto px-1 pb-1 scroll-smooth">
                                            {meta.relatedList.map((rel, idx) => (
                                                <FilmPosterCard
                                                    key={`rel-${rel.id}-${idx}`}
                                                    className="group flex w-32 shrink-0 flex-col items-center text-center focus:outline-none sm:w-36"
                                                    film={{ id: rel.id.startsWith('tmdb:') ? rel.id : `tmdb:${rel.id}`, title: rel.title, poster: rel.poster, year: rel.year ? Number(rel.year) : undefined, type: (rel.type === 'series' || rel.type === 'anime') ? 'series' : 'movie', voteAverage: rel.voteAverage }}
                                                    watchers={watchersByItemId.get(rel.id.startsWith('tmdb:') ? rel.id : `tmdb:${rel.id}`) ?? []}
                                                    showSubtitle={false}
                                                    onClick={() => {
                                                        const newItem: DetailItem = {
                                                            itemId: rel.id.startsWith('tmdb:') ? rel.id : `tmdb:${rel.id}`,
                                                            type: rel.type,
                                                            name: rel.title,
                                                            poster: rel.poster,
                                                            year: rel.year ? Number(rel.year) : undefined,
                                                            voteAverage: rel.voteAverage,
                                                        }
                                                        setActiveItem(newItem)
                                                        setNavStack(prev => [...prev, { kind: 'item', item: newItem }])
                                                    }}
                                                />
                                            ))}
                                        </div>
                                    </div>
                                )}

                                {/* ── AUDIENCE REVIEWS & DISCUSSIONS ─────────────────── */}
                                {!loading && <ReviewsSection reviews={meta?.reviewsList ?? []} />}

                                {/* ── PRODUCTION & NETWORK INFO PILLS ───────────────── */}
                                {!loading && (meta?.status || meta?.originalLanguage || (meta?.productionCompanies && meta.productionCompanies.length > 0) || (meta?.networks && meta.networks.length > 0) || meta?.collection) && (
                                    <div className="mt-6 flex flex-wrap items-center gap-2 pt-4 border-t border-border/40">
                                        {meta.collection && (
                                            <span data-theme-part="badge" className="rounded-full border border-amber-500/40 bg-amber-500/10 px-3 py-1 text-xs font-bold text-amber-600 dark:text-amber-400 flex items-center gap-1.5">
                                                <Layers className="h-3 w-3" />
                                                {meta.collection.name}
                                            </span>
                                        )}
                                        {meta.status && (
                                            <span data-theme-part="badge" className="rounded-full border border-primary/40 bg-primary/10 px-3 py-1 text-xs font-bold text-primary">
                                                Status: {meta.status}
                                            </span>
                                        )}
                                        {meta.originalLanguage && (
                                            <span data-theme-part="badge" className="rounded-full border border-border/50 bg-muted/40 px-3 py-1 text-xs font-bold text-muted-foreground flex items-center gap-1.5">
                                                <Languages className="h-3 w-3 text-primary" />
                                                Language: {meta.originalLanguage}
                                            </span>
                                        )}
                                        {meta.networks && meta.networks.length > 0 && (
                                            <span data-theme-part="badge" className="rounded-full border border-border/50 bg-muted/40 px-3 py-1 text-xs font-bold text-muted-foreground flex items-center gap-1.5">
                                                <Tv className="h-3 w-3 text-primary" />
                                                Network: {meta.networks.join(', ')}
                                            </span>
                                        )}
                                        {meta.productionCompanies && meta.productionCompanies.length > 0 && (
                                            <span data-theme-part="badge" className="rounded-full border border-border/50 bg-muted/40 px-3 py-1 text-xs font-bold text-muted-foreground flex items-center gap-1.5">
                                                <Building2 className="h-3 w-3 text-primary" />
                                                Studio: {meta.productionCompanies.slice(0, 2).join(', ')}
                                            </span>
                                        )}
                                    </div>
                                )}

                                <div className="h-2" />

                                {dataSources.length > 0 && (
                                    <div className="flex flex-wrap items-center gap-1.5 py-1">
                                        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/40">Data from</span>
                                        {dataSources.map(src => (
                                            <span key={src} data-theme-part="badge" className="rounded bg-muted/40 px-1.5 py-0.5 text-[10px] font-bold text-muted-foreground/60">
                                                {src}
                                            </span>
                                        ))}
                                    </div>
                                )}

                                <div className="h-2" />
                            </div>
                            </div>
                        </div>
                    </div>
                )}
            </DialogContent>

            <LightboxViewer
                images={meta?.galleryBackdrops ?? []}
                index={lightboxIndex}
                zoom={lightboxZoom}
                onClose={() => { setLightboxIndex(null); setLightboxZoom(false) }}
                onNavigate={(i) => { setLightboxIndex(i); setLightboxZoom(false) }}
                onToggleZoom={() => setLightboxZoom(z => !z)}
            />
        </Dialog>
    )
}
