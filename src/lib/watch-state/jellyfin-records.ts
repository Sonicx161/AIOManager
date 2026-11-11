import type { JellyfinItem } from '../jellyfin/types.ts'
import { canonicalWatchIdentity, sourceTime, watchFingerprint } from './records.ts'
import type { WatchMediaType, WatchStateRecord } from './types.ts'

export type WatchProvider = 'imdb' | 'tmdb' | 'tvdb'

const PROVIDER_KEYS: Array<[WatchProvider, RegExp]> = [
    ['imdb', /^imdb$/i],
    ['tmdb', /^tmdb$/i],
    ['tvdb', /^tvdb$/i],
]
const PROVIDER_VALUE_PATTERNS: Record<WatchProvider, RegExp> = {
    imdb: /^tt\d{5,}$/,
    tmdb: /^\d+$/,
    tvdb: /^\d+$/,
}
const TICKS_PER_MS = 10_000
const FACADE_NONE16 = 0xffff
const FACADE_MAX48 = 2 ** 48 - 1
const FACADE_KIND = { movie: 1, series: 2, episode: 4 }
const FACADE_PROVIDER: Record<WatchProvider, number> = { imdb: 1, tmdb: 2, tvdb: 3 }
const FACADE_MEDIA = { movie: 1, series: 2 }

export interface ParsedWatchIdentity {
    type: 'movie' | 'episode'
    provider: WatchProvider
    value: string
    season?: number
    episode?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function providerIdsOf(providers: unknown): Partial<Record<WatchProvider, string>> {
    const out: Partial<Record<WatchProvider, string>> = {}
    const conflicted = new Set<WatchProvider>()
    if (!isRecord(providers)) return out
    for (const [key, value] of Object.entries(providers)) {
        if (typeof value !== 'string' || value === '') continue
        for (const [provider, pattern] of PROVIDER_KEYS) {
            if (!pattern.test(key)) continue
            if (!PROVIDER_VALUE_PATTERNS[provider].test(value)) continue
            if (conflicted.has(provider)) continue
            const existing = out[provider]
            if (existing === undefined) out[provider] = value
            else if (existing !== value) {
                delete out[provider]
                conflicted.add(provider)
            }
        }
    }
    if (conflicted.size > 0) return {}
    return out
}

export function movieWatchIdentities(providers: unknown): string[] {
    const identities: string[] = []
    for (const [provider, value] of Object.entries(providerIdsOf(providers))) {
        const identity = canonicalWatchIdentity('movie', provider === 'imdb' ? value! : `${provider}:${value}`)
        if (identity !== null && !identities.includes(identity)) identities.push(identity)
    }
    return identities.sort()
}

export function episodeWatchIdentities(seriesProviders: unknown, season: unknown, episode: unknown): string[] {
    if (!Number.isSafeInteger(season) || !Number.isSafeInteger(episode)) return []
    const identities: string[] = []
    for (const [provider, value] of Object.entries(providerIdsOf(seriesProviders))) {
        const identity = canonicalWatchIdentity('episode', provider === 'imdb' ? value! : `${provider}:${value}`, season as number, episode as number)
        if (identity !== null && !identities.includes(identity)) identities.push(identity)
    }
    return identities.sort()
}

export function ticksToMs(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value / TICKS_PER_MS) : undefined
}

export function msToTicks(value: number): number | null {
    if (!Number.isSafeInteger(value) || value <= 0) return null
    const ticks = value * TICKS_PER_MS
    return Number.isSafeInteger(ticks) ? ticks : null
}

function explicitlyBlankUserData(userData: Record<string, unknown>): boolean {
    if (userData.Played !== false) return false
    if (userData.PlaybackPositionTicks !== 0) return false
    if (userData.LastPlayedDate !== undefined && userData.LastPlayedDate !== null) return false
    if (userData.PlayCount !== undefined && userData.PlayCount !== 0) return false
    return true
}

function watchPlayCount(userData: Record<string, unknown>): number | undefined {
    const value = userData.PlayCount
    if (value === undefined || value === null) return undefined
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/** A user rating is 0-10; a present rating is greater than zero and finite. */
export function watchRating(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 10 ? value : undefined
}

export function seriesKeyOf(item: JellyfinItem): string | undefined {
    if (item.Type !== 'Episode' || typeof item.SeriesId !== 'string' || item.SeriesId === '') return undefined
    return /^tt\d+$/.test(item.SeriesId) ? undefined : item.SeriesId
}

export function watchStateFields(record: Omit<WatchStateRecord, 'fingerprint'>): Record<string, unknown> {
    return {
        id: record.id,
        type: record.type,
        identities: record.identities,
        season: record.season,
        episode: record.episode,
        watched: record.watched,
        positionMs: record.positionMs,
        durationMs: record.durationMs,
        playedAt: record.playedAt,
        playCount: record.playCount,
        rating: record.rating,
        favorite: record.favorite,
        unmodified: record.unmodified,
    }
}

export async function watchRecordFromItem(item: JellyfinItem, seriesProviders?: unknown): Promise<WatchStateRecord> {
    const userData = isRecord(item.UserData) ? item.UserData : undefined
    const type: WatchMediaType | 'unknown' =
        item.Type === 'Movie' ? 'movie' : item.Type === 'Episode' ? 'episode' : 'unknown'
    const notes: string[] = []
    let identities: string[] = []
    if (type === 'movie') {
        identities = movieWatchIdentities(item.ProviderIds)
        if (!identities.length) notes.push('This movie has no verifiable IMDb, TMDB or TVDB identifier.')
    } else if (type === 'episode') {
        identities = episodeWatchIdentities(seriesProviders, item.ParentIndexNumber, item.IndexNumber)
        if (!identities.length) {
            const hasCoords = Number.isSafeInteger(item.ParentIndexNumber) && Number.isSafeInteger(item.IndexNumber)
            if (!hasCoords) notes.push('The season or episode number of this episode is not verifiable.')
            else if (seriesProviders === undefined) notes.push('The parent series of this episode could not be verified.')
            else notes.push('The parent series of this episode has no verifiable IMDb, TMDB or TVDB identifier.')
        }
    } else {
        notes.push('Only movies and episodes can be matched.')
    }
    const record: Omit<WatchStateRecord, 'fingerprint'> = {
        id: item.Id,
        title: typeof item.Name === 'string' && item.Name !== '' ? item.Name : typeof item.SeriesName === 'string' && item.SeriesName !== '' ? item.SeriesName : item.Id,
        seriesTitle: type === 'episode' && item.SeriesName ? item.SeriesName : undefined,
        episodeTitle: type === 'episode' && item.Name ? item.Name : undefined,
        type,
        identities,
        season: type === 'episode' && Number.isSafeInteger(item.ParentIndexNumber) ? item.ParentIndexNumber : undefined,
        episode: type === 'episode' && Number.isSafeInteger(item.IndexNumber) ? item.IndexNumber : undefined,
        watched: userData === undefined ? undefined : userData.Played === true ? true : userData.Played === false ? false : undefined,
        positionMs: userData === undefined ? undefined : ticksToMs(userData.PlaybackPositionTicks),
        durationMs: ticksToMs(item.RunTimeTicks),
        playedAt: userData === undefined ? null : sourceTime(userData.LastPlayedDate),
        playCount: userData === undefined ? undefined : watchPlayCount(userData),
        rating: userData === undefined ? undefined : watchRating(userData.Rating),
        favorite: userData?.IsFavorite === true ? true : undefined,
        unmodified: userData !== undefined && explicitlyBlankUserData(userData) ? true : undefined,
        notes,
    }
    const fingerprint = await watchFingerprint(watchStateFields(record))
    return { ...record, fingerprint } as WatchStateRecord
}

export function parseWatchIdentity(identity: string): ParsedWatchIdentity | null {
    const match = identity.match(/^(movie|episode):(imdb|tmdb|tvdb):([^:]+?)(?::(\d+):(\d+))?$/)
    if (!match) return null
    const provider = match[2] as WatchProvider
    const value = match[3]
    if (provider === 'imdb' ? !/^tt\d{5,}$/.test(value) : !/^\d+$/.test(value)) return null
    const season = match[4] !== undefined ? Number(match[4]) : undefined
    const episode = match[5] !== undefined ? Number(match[5]) : undefined
    if (episode !== undefined && episode < 1) return null
    return { type: match[1] as 'movie' | 'episode', provider, value, season, episode }
}

function facadeNumeric(provider: WatchProvider, value: string): number | null {
    const digits = provider === 'imdb' ? value.replace(/^tt/, '') : value
    if (!/^\d+$/.test(digits)) return null
    const numeric = Number(digits)
    return Number.isSafeInteger(numeric) && numeric <= FACADE_MAX48 ? numeric : null
}

function facadePackedId(parsed: ParsedWatchIdentity, form: 'leaf' | 'series'): string | null {
    const numeric = facadeNumeric(parsed.provider, parsed.value)
    if (numeric === null) return null
    const kind = form === 'series' ? FACADE_KIND.series : FACADE_KIND[parsed.type]
    const media = parsed.type === 'movie' ? FACADE_MEDIA.movie : FACADE_MEDIA.series
    let season = FACADE_NONE16
    let episode = FACADE_NONE16
    if (form === 'leaf' && parsed.type === 'episode') {
        if (parsed.season === undefined || parsed.episode === undefined) return null
        if (!Number.isSafeInteger(parsed.season) || parsed.season < 0 || parsed.season >= FACADE_NONE16) return null
        if (!Number.isSafeInteger(parsed.episode) || parsed.episode < 0 || parsed.episode >= FACADE_NONE16) return null
        season = parsed.season
        episode = parsed.episode
    }
    const byte1 = ((kind << 4) | FACADE_PROVIDER[parsed.provider]).toString(16).padStart(2, '0')
    return `a1${byte1}${media.toString(16).padStart(2, '0')}${numeric.toString(16).padStart(12, '0')}${season.toString(16).padStart(4, '0')}${episode.toString(16).padStart(4, '0')}000000`
}

export function packedFacadeItemId(identity: string): string | null {
    const parsed = parseWatchIdentity(identity)
    return parsed === null ? null : facadePackedId(parsed, 'leaf')
}

export function packedFacadeSeriesId(identity: string): string | null {
    const parsed = parseWatchIdentity(identity)
    return parsed === null || parsed.type !== 'episode' ? null : facadePackedId(parsed, 'series')
}

export function looksLikeFacadeStub(item: Pick<JellyfinItem, 'Name'>, expected: ParsedWatchIdentity): boolean {
    const name = typeof item.Name === 'string' ? item.Name.trim() : ''
    if (name === '') return false
    if (expected.type === 'movie') return name === expected.value
    return expected.episode !== undefined && name === `Episode ${expected.episode}`
}
