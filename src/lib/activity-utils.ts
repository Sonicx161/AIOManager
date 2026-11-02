import { LibraryItem, ActivityItem } from '@/types/activity'
import { Account } from '@/types/account'
import type { HistoryEntry } from '@/hooks/useWatchHistory'
import { getAccountEmail } from '@/store/accountStore'
import { sanitizePosterUrl } from '@/lib/utils'

export { sanitizePosterUrl }

export function isActuallyWatched(item: LibraryItem): boolean {
    const s = item.state || {}
    if ((s.timesWatched ?? 0) > 0) return true
    if (s.video_id && s.video_id.trim() !== '') return true
    if ((s.timeOffset ?? 0) > 0) return true
    if ((s.timeWatched ?? 0) > 0 || (s.overallTimeWatched ?? 0) > 0) return true
    return false
}

export function getUniqueItemId(item: LibraryItem): string {
    const baseId = item._id
    if ((item.type === 'series' || item.type === 'anime' || item.type === 'episode') && item.state?.video_id) {
        const videoId = item.state.video_id
        const parts = videoId.split(':')
        // Standard format: "tt123:season:episode" (3 parts) or Kitsu "kitsu:id:s:e" (4 parts)
        if (parts.length >= 3) return videoId
        // Format: "tt123:episode" (2 parts, no season)
        if (parts.length === 2) return `${parts[0]}:1:${parts[1]}`
    }
    return baseId
}

export function getWatchTimestamp(item: LibraryItem): Date {
    const times: number[] = []
    if (item.state?.lastWatched) {
        const d = new Date(item.state.lastWatched)
        if (!isNaN(d.getTime())) times.push(d.getTime())
    }
    if (item._mtime) {
        const d = new Date(item._mtime)
        if (!isNaN(d.getTime())) times.push(d.getTime())
    }
    const now = Date.now()

    // This protects against Stremio sending bad timestamps (e.g. 12h future)
    // which would otherwise be clamped to "now" and appear as "Just now"
    const validTimes = times.filter(t => t <= now + 5 * 60 * 1000)

    const maxTime = validTimes.length > 0 ? Math.max(...validTimes) : now

    return new Date(Math.min(maxTime, now))
}

export function getSeasonEpisode(item: LibraryItem): { season?: number; episode?: number } {
    if ((item.type !== 'series' && item.type !== 'anime' && item.type !== 'episode') || !item.state?.video_id) {
        return {}
    }

    const parts = item.state.video_id.split(':')
    const firstPart = parts[0]?.toLowerCase() || ''
    const animeProviders = ['kitsu', 'mal', 'anilist', 'anidb']
    const isAnimeProvider = animeProviders.includes(firstPart)

    const safeParseInt = (val: string | undefined, fallback: number): number => {
        if (val === undefined) return fallback
        const stripped = val.replace(/^[^0-9]*/, '')
        const n = parseInt(stripped, 10)
        return Number.isNaN(n) ? fallback : n
    }

    if (parts.length >= 4) {
        return {
            season: safeParseInt(parts[parts.length - 2], 1),
            episode: safeParseInt(parts[parts.length - 1], 0)
        }
    }

    if (parts.length === 3 && isAnimeProvider) {
        return { season: 1, episode: safeParseInt(parts[2], 0) }
    }

    if (parts.length === 3) {
        return {
            season: safeParseInt(parts[1], 1),
            episode: safeParseInt(parts[2], 0)
        }
    }

    if (parts.length === 2 && !isAnimeProvider) {
        return { season: 1, episode: safeParseInt(parts[1], 0) }
    }

    return {
        season: item.state.season ?? 1,
        episode: item.state.episode
    }
}

export function getLocalDayKey(timestamp: number): string {
    const date = new Date(timestamp)
    if (isNaN(date.getTime())) return 'unknown'
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${date.getFullYear()}-${month}-${day}`
}

export function getEpisodeIdentity(
    itemId: string,
    videoId: string | undefined,
    season: number | undefined,
    episode: number | undefined,
    type: string
): string {
    const isSeries = type === 'series' || type === 'anime' || type === 'episode'
    if (!isSeries) return itemId
    if (episode !== undefined) return `${itemId}:s${season ?? 1}:e${episode}`
    if (videoId && videoId !== itemId) {
        const parts = videoId.split(':')
        if (parts.length >= 3) {
            const s = parseInt(parts[parts.length - 2])
            const e = parseInt(parts[parts.length - 1])
            if (!isNaN(e)) return `${itemId}:s${isNaN(s) ? 1 : s}:e${e}`
        }
        if (parts.length === 2) {
            const e = parseInt(parts[1])
            if (!isNaN(e)) return `${itemId}:s1:e${e}`
        }
    }
    return videoId || itemId
}

export function parseStremioDate(dateStr: string | undefined): Date | undefined {
    if (!dateStr) return undefined
    const d = new Date(dateStr)
    if (isNaN(d.getTime())) return undefined
    return d.getTime() > Date.now() + 5 * 60 * 1000 ? new Date() : d
}

export function transformLibraryItemToActivityItem(
    item: LibraryItem,
    account: Account,
    accounts: Account[]
): ActivityItem {
    const uniqueItemId = getUniqueItemId(item)
    const timestamp = getWatchTimestamp(item)
    const firstWatched = parseStremioDate(item._ctime)
    const { season, episode } = getSeasonEpisode(item)
    let duration = item.state?.duration || 0
    const timeOffset = item.state?.timeOffset || 0
    const overallTimeWatched = item.state?.overallTimeWatched
    const timesWatched = item.state?.timesWatched
    const flaggedWatched = item.state?.flaggedWatched

    const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000

    if (duration > TWENTY_FOUR_HOURS_MS) {
        duration = 0
    }

    const progress = duration > 0 ? Math.min(100, Math.max(0, (timeOffset / duration) * 100)) : 0
    const isInProgress = (timeOffset > 3000 || progress > 0.5) && progress < 95
    const accountColorIndex = accounts.indexOf(account) % 10

    return {
        id: `${account.id}:${uniqueItemId}`,
        accountId: account.id,
        accountName: account.name || getAccountEmail(account)?.split('@')[0] || account.id || 'Unknown',
        accountColorIndex,
        itemId: item._id,
        uniqueItemId,
        name: item.name || 'Unknown Title',
        type: item.type || 'other',
        poster: sanitizePosterUrl(item.poster) || '',
        timestamp,
        firstWatched,
        duration,
        watched: timeOffset,
        progress,
        timesWatched,
        flaggedWatched,
        isInProgress,
        season,
        episode,
        overallTimeWatched,
        source: 'stremio',
    }
}

interface NuvioWatchedItem {
    content_id: string
    content_type?: string
    title?: string
    season?: number | null
    episode?: number | null
    watched_at?: number
}

interface NuvioProgressItem {
    content_id: string
    content_type?: string
    video_id?: string
    season?: number | null
    episode?: number | null
    position?: number
    duration?: number
    last_watched?: number
}

export interface CinemetaCastMember {
    name?: string
    character?: string
    photo?: string
}

export interface CinemetaDirectorMember {
    name?: string
    photo?: string
}

export interface CinemetaCrewMember {
    name: string
    role: string
    photo?: string
}

export interface CinemetaVideo {
    key: string
    name: string
    type: string
    official?: boolean
}

export interface CinemetaRelatedItem {
    id: string
    title: string
    type: string
    poster?: string
    backdrop?: string
    year?: string
    voteAverage?: number
}

export interface CinemetaReview {
    id?: string
    author: string
    avatar?: string
    rating?: number
    content: string
    createdAt?: string
    source?: string
}

export interface CinemetaMeta {
    id?: string
    type?: string
    name?: string
    poster?: string
    background?: string
    logo?: string
    description?: string
    genre?: string
    runtime?: string
    cast?: CinemetaCastMember[]
    director?: Array<string | CinemetaDirectorMember> | string
    crew?: CinemetaCrewMember[]
    imdbRating?: string
    released?: string
    year?: string
    trailers?: Array<{ source: string; type: string }>
    videoList?: CinemetaVideo[]
    relatedList?: CinemetaRelatedItem[]
    reviewsList?: CinemetaReview[]
    status?: string
    originalLanguage?: string
    productionCompanies?: string[]
    networks?: string[]
    certification?: string
    keywords?: number[]
    collection?: { id: number; name: string }
    galleryBackdrops?: string[]
    watchProviders?: Array<{ name: string; logo?: string }>
    tmdbId?: number
}

interface CinemetaCacheEntry {
    meta: CinemetaMeta | null
    fetchedAt: number
}

const cinemetaCache = new Map<string, CinemetaCacheEntry>()
const CINEMETA_TTL = 24 * 60 * 60 * 1000
const CINEMETA_NULL_TTL = 5 * 60 * 1000

function parseCinemetaGenres(meta: CinemetaMeta | undefined | null): string[] {
    if (!meta || typeof meta.genre !== 'string' || !meta.genre.trim()) return []
    return meta.genre.split(',').map(g => g.trim()).filter(Boolean)
}

export async function fetchCinemetaDetail(imdbId: string, type?: string): Promise<CinemetaMeta | null> {
    if (!imdbId || !imdbId.startsWith('tt')) return null
    const cached = cinemetaCache.get(imdbId)
    if (cached && Date.now() - cached.fetchedAt < (cached.meta ? CINEMETA_TTL : CINEMETA_NULL_TTL)) {
        return cached.meta
    }
    try {
        const mediaType = type === 'movie' ? 'movie' : 'series'
        const res = await fetch(`https://cinemeta-live.strem.io/meta/${mediaType}/${imdbId}.json`, { signal: AbortSignal.timeout(8000) })
        if (!res.ok) {
            if (import.meta.env?.DEV) console.warn(`[Cinemeta] ${res.status} for ${imdbId} (${mediaType})`)
            cinemetaCache.set(imdbId, { meta: null, fetchedAt: Date.now() })
            return null
        }
        const data = await res.json()
        const raw: Record<string, unknown> | null = data?.meta ?? null
        if (!raw) {
            cinemetaCache.set(imdbId, { meta: null, fetchedAt: Date.now() })
            return null
        }

        const TMDB_IMG = 'https://image.tmdb.org/t/p/w185'
        const creditsCast = Array.isArray(raw.credits_cast) ? raw.credits_cast : []
        const cast: CinemetaCastMember[] = creditsCast
            .filter((c): c is Record<string, unknown> => c && typeof c === 'object')
            .map(c => ({
                name: typeof c.name === 'string' ? c.name : undefined,
                character: typeof c.character === 'string' ? c.character : undefined,
                photo: typeof c.profile_path === 'string' && c.profile_path ? `${TMDB_IMG}${c.profile_path}` : undefined,
            }))

        const creditsCrew = Array.isArray(raw.credits_crew) ? raw.credits_crew : []
        const crew: CinemetaCrewMember[] = creditsCrew
            .filter((c): c is Record<string, unknown> => c && typeof c === 'object')
            .map(c => ({
                name: typeof c.name === 'string' ? c.name : '',
                role: typeof c.job === 'string' ? c.job : (typeof c.role === 'string' ? c.role : ''),
                photo: typeof c.profile_path === 'string' && c.profile_path ? `${TMDB_IMG}${c.profile_path}` : undefined,
            }))

        const rawDirector = raw.director
        let director: CinemetaMeta['director']
        if (Array.isArray(rawDirector)) {
            director = rawDirector.map(d => {
                if (typeof d === 'string') return d
                if (d && typeof d === 'object') {
                    const obj = d as Record<string, unknown>
                    return { name: String(obj.name ?? ''), photo: typeof obj.profile_path === 'string' && obj.profile_path ? `${TMDB_IMG}${obj.profile_path}` : undefined }
                }
                return String(d)
            })
        } else if (typeof rawDirector === 'string') {
            director = rawDirector
        }

        const trailers = Array.isArray(raw.trailers) ? raw.trailers : []
        const videoList: CinemetaVideo[] = trailers
            .filter((t): t is Record<string, unknown> => t && typeof t === 'object')
            .filter(t => t.type === 'Trailer' || t.type === 'Teaser')
            .map(t => ({
                key: String(t.source ?? ''),
                name: String(t.name ?? t.type ?? 'Trailer'),
                type: String(t.type ?? 'Trailer'),
            }))
            .filter(v => v.key)

        const rawRelated = Array.isArray(raw.related) ? raw.related : []
        const relatedList: CinemetaRelatedItem[] = rawRelated
            .filter((r): r is Record<string, unknown> => r && typeof r === 'object')
            .map(r => ({
                id: String(r.id ?? ''),
                title: String(r.name ?? 'Unknown'),
                type: String(r.type ?? 'movie'),
                poster: typeof r.poster === 'string' ? r.poster : undefined,
            }))
            .filter(r => r.id)

        const meta: CinemetaMeta = {
            id: typeof raw.id === 'string' ? raw.id : imdbId,
            type: typeof raw.type === 'string' ? raw.type : mediaType,
            name: typeof raw.name === 'string' ? raw.name : undefined,
            poster: typeof raw.poster === 'string' ? raw.poster : undefined,
            background: typeof raw.background === 'string' ? raw.background : undefined,
            logo: typeof raw.logo === 'string' ? raw.logo : undefined,
            description: typeof raw.description === 'string' ? raw.description : undefined,
            genre: typeof raw.genre === 'string' ? raw.genre : (Array.isArray(raw.genres) ? raw.genres.join(', ') : undefined),
            runtime: typeof raw.runtime === 'string' ? raw.runtime : undefined,
            cast: cast.length > 0 ? cast : undefined,
            director,
            crew: crew.length > 0 ? crew : undefined,
            imdbRating: typeof raw.imdbRating === 'string' ? raw.imdbRating : undefined,
            released: typeof raw.released === 'string' ? raw.released : (typeof raw.releaseInfo === 'string' ? raw.releaseInfo.slice(0, 4) : undefined),
            year: typeof raw.year === 'string' ? raw.year : (typeof raw.releaseInfo === 'string' ? raw.releaseInfo.slice(0, 4) : undefined),
            trailers,
            videoList: videoList.length > 0 ? videoList : undefined,
            relatedList: relatedList.length > 0 ? relatedList : undefined,
            reviewsList: Array.isArray(raw.reviews) ? raw.reviews as CinemetaReview[] : undefined,
            status: typeof raw.status === 'string' ? raw.status : undefined,
            originalLanguage: typeof raw.language === 'string' ? raw.language : undefined,
            productionCompanies: Array.isArray(raw.production_companies) ? raw.production_companies.map(String) : undefined,
            tmdbId: typeof raw.moviedb_id === 'number' ? raw.moviedb_id : undefined,
        }

        cinemetaCache.set(imdbId, { meta, fetchedAt: Date.now() })
        return meta
    } catch (e) {
        if (import.meta.env?.DEV) console.warn(`[Cinemeta] fetch failed for ${imdbId}:`, e instanceof Error ? e.message : e)
        cinemetaCache.set(imdbId, { meta: null, fetchedAt: Date.now() })
        return null
    }
}

export function getCachedCinemetaName(imdbId: string): string | null {
    if (!imdbId || !imdbId.startsWith('tt')) return null
    const cached = cinemetaCache.get(imdbId)
    if (!cached || !cached.meta) return null
    if (Date.now() - cached.fetchedAt > CINEMETA_TTL) return null
    return cached.meta.name?.trim() || null
}

async function resolveCinemeta(imdbId: string, type?: string): Promise<{ name: string; poster: string; genres: string[] }> {
    const meta = await fetchCinemetaDetail(imdbId, type)
    if (!meta) return { name: '', poster: '', genres: [] }
    return {
        name: meta.name || '',
        poster: sanitizePosterUrl(meta.poster) || '',
        genres: parseCinemetaGenres(meta),
    }
}

function nuvioUniqueId(contentId: string, season?: number | null, episode?: number | null): string {
    if (episode != null) return `${contentId}:${season ?? 1}:${episode}`
    return contentId
}

function stripNuvioEpisodeTag(title: string, episode?: number | null): string {
    if (episode == null) return title
    return title.replace(/[\s-]*s\d{1,3}\s*e\d{1,3}\s*$/i, '').trim()
}

export function nuvioProgressKey(contentId: string, season?: number | null, episode?: number | null): string {
    if (episode != null) return `${contentId}_s${season ?? 1}e${episode}`
    return contentId
}

function accountActivityMeta(account: Account, accounts: Account[]) {
    return {
        name: account.name || getAccountEmail(account)?.split('@')[0] || account.id || 'Unknown',
        colorIndex: accounts.indexOf(account) % 10,
    }
}

export async function transformNuvioWatchedItemToActivityItem(row: NuvioWatchedItem, account: Account, accounts: Account[]): Promise<ActivityItem> {
    const uniqueItemId = nuvioUniqueId(row.content_id, row.season, row.episode)
    const meta = accountActivityMeta(account, accounts)
    const watchedAt = Number(row.watched_at) || Date.now()
    const resolved = await resolveCinemeta(row.content_id, row.content_type)
    let name: string
    if (row.episode != null && resolved.name.trim()) {
        name = resolved.name
    } else {
        name = stripNuvioEpisodeTag(row.title || '', row.episode)
        if (!name.trim()) name = resolved.name
    }
    const poster = resolved.poster
    const genres = resolved.genres.length > 0 ? resolved.genres : undefined
    return {
        id: `${account.id}:nuvio:${uniqueItemId}`,
        accountId: account.id,
        accountName: meta.name,
        accountColorIndex: meta.colorIndex,
        itemId: row.content_id,
        uniqueItemId,
        name: name || 'Unknown Title',
        type: row.content_type || 'other',
        poster,
        timestamp: new Date(Math.min(watchedAt, Date.now())),
        duration: 0,
        watched: 0,
        progress: 100,
        isInProgress: false,
        season: row.season ?? undefined,
        episode: row.episode ?? undefined,
        source: 'nuvio',
        genres,
    }
}

// Progress rows carry no title (only watched rows do), so the caller can pass a title resolved
// from the watched-items list for the same content_id to avoid showing a raw id as the name.
export async function transformNuvioProgressToActivityItem(row: NuvioProgressItem, account: Account, accounts: Account[], titleHint?: string): Promise<ActivityItem> {
    const uniqueItemId = row.video_id || nuvioUniqueId(row.content_id, row.season, row.episode)
    const meta = accountActivityMeta(account, accounts)
    const duration = Number(row.duration) || 0
    const position = Number(row.position) || 0
    const progress = duration > 0 ? Math.min(100, Math.max(0, (position / duration) * 100)) : 0
    const lastWatched = Number(row.last_watched) || Date.now()
    const resolved = await resolveCinemeta(row.content_id, row.content_type)
    let name: string
    if (row.episode != null && resolved.name.trim()) {
        name = resolved.name
    } else {
        name = stripNuvioEpisodeTag(titleHint?.trim() || '', row.episode)
        if (!name.trim()) name = resolved.name
    }
    const poster = resolved.poster
    const genres = resolved.genres.length > 0 ? resolved.genres : undefined
    return {
        id: `${account.id}:nuvio:${uniqueItemId}`,
        accountId: account.id,
        accountName: meta.name,
        accountColorIndex: meta.colorIndex,
        itemId: row.content_id,
        uniqueItemId,
        name: name || row.content_id,
        type: row.content_type || 'other',
        poster,
        timestamp: new Date(Math.min(lastWatched, Date.now())),
        duration,
        watched: position,
        progress,
        isInProgress: progress > 0 && progress < 90,
        season: row.season ?? undefined,
        episode: row.episode ?? undefined,
        source: 'nuvio',
        genres,
    }
}

export function historyEntryToActivityItem(entry: HistoryEntry): ActivityItem {
    return {
        id: entry.id,
        accountId: entry.accountId,
        accountName: entry.accountName,
        accountColorIndex: entry.accountColorIndex,
        itemId: entry.itemId,
        uniqueItemId: entry.video_id,
        name: entry.name,
        type: entry.type,
        poster: sanitizePosterUrl(entry.poster) || '',
        timestamp: entry.timestamp,
        firstWatched: entry.firstWatched,
        duration: entry.duration,
        watched: entry.isFromEventLog ? entry.watched : (entry.liveWatched ?? entry.watched),
        progress: Math.min(entry.isFromEventLog ? entry.progress : (entry.liveProgress ?? entry.progress), 100),
        timesWatched: entry.timesWatched,
        flaggedWatched: entry.flaggedWatched,
        isInProgress: entry.isInProgress,
        season: entry.season,
        episode: entry.episode,
        overallTimeWatched: entry.overallTimeWatched,
        source: entry.source,
        backfill: entry.backfill,
        genres: entry.genres,
    }
}

export function resolveWatchBadgePct(item: ActivityItem): number | undefined {
    if (item.progress > 0) return Math.round(item.progress)
    if ((item.timesWatched ?? 0) > 0 || (item.flaggedWatched ?? 0) > 0) return 100
    const isSeries = item.type === 'series' || item.type === 'anime' || item.type === 'episode'
    if (!isSeries && (item.overallTimeWatched ?? 0) > 0) return 100
    return 0
}
