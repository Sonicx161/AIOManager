// Leaf helpers shared by the Activity artwork chain: no network, no alias imports,
// so the node --test suite can execute them directly.

import { proxyImageUrl } from './image-proxy.ts'

const IMDB_ID = /^tt\d+$/i
const METAHUB_POSTER_TT = /metahub\.space\/poster\/[^/]+\/(tt\d+)(?:\/|$)/i

export type CinemetaMediaType = 'movie' | 'series'

/** Public, key-free poster by IMDb id; the same path the Poster component falls back to. */
export function metahubPosterUrl(imdbId: string, size: 'small' | 'medium' = 'medium'): string {
    return `https://live.metahub.space/poster/${size}/${imdbId}/img`
}

/** Public, key-free background by IMDb id for hero art rendered in a plain img. */
export function metahubBackgroundUrl(imdbId: string): string {
    return `https://live.metahub.space/background/medium/${imdbId}/img`
}

export const isImdbId = (value: unknown): value is string => typeof value === 'string' && IMDB_ID.test(value)

/** The IMDb id a metahub poster URL is addressed by, if any. */
export function imdbIdFromPosterUrl(url: string | undefined): string | undefined {
    return url ? METAHUB_POSTER_TT.exec(url)?.[1].toLowerCase() : undefined
}

const PROXIED_ARTWORK_HOSTS = ['metahub.space', 'strem.io']

/** Hero artwork renders in a plain img, so metahub and strem.io hosts go through the image proxy. */
export function proxiedArtworkUrl(url: string | undefined): string | undefined {
    if (!url) return undefined
    let host: string
    try { host = new URL(url).hostname } catch { return url }
    return PROXIED_ARTWORK_HOSTS.some(h => host === h || host.endsWith(`.${h}`)) ? proxyImageUrl(url) : url
}

export interface DetailArtworkInput {
    itemId: string
    itemPoster?: string
    itemBackdrop?: string
    metaPoster?: string
    metaBackground?: string
    /** The IMDb id a Cinemeta resolution established for this row, when the row id is not one. */
    resolvedImdbId?: string
    /** The row's TMDB id (Jellyfin ProviderIds.Tmdb): last-resort artwork through the keyed TMDB proxy. */
    tmdbId?: number
}

export interface DetailArtwork {
    posterSrc?: string
    posterItemId: string
    /** Row TMDB id backing Poster's last-resort TMDB image lookup. */
    posterTmdbId?: number
    /** Background candidates in try order; the hero hides its image once every entry has errored. */
    backgroundCandidates: string[]
}

/**
 * Artwork choice for the detail modal. Poster order is the row poster, then the
 * Cinemeta/metahub answer for the IMDb id (Poster derives that fallback from
 * posterItemId), then TMDB art from the row's TMDB id. A stub IMDb id without
 * artwork therefore still reaches the real title's TMDB images.
 */
export function detailArtwork(input: DetailArtworkInput): DetailArtwork {
    const imdbId = isImdbId(input.resolvedImdbId) ? input.resolvedImdbId : isImdbId(input.itemId) ? input.itemId : undefined
    const posterSrc = input.itemPoster || input.metaPoster || (imdbId ? metahubPosterUrl(imdbId) : undefined)
    // Real backgrounds first; the key-free metahub derivation is a last resort that
    // only applies when none exists, so a stub id never lingers behind real TMDB art.
    const rawBackgrounds = [input.metaBackground, input.itemBackdrop]
    if (rawBackgrounds.every(url => !url) && imdbId) rawBackgrounds.push(metahubBackgroundUrl(imdbId))
    const backgroundCandidates = [...new Set(rawBackgrounds.flatMap(url => (url ? [proxiedArtworkUrl(url)!] : [])))]
    return {
        ...(posterSrc ? { posterSrc } : {}),
        posterItemId: imdbId || input.itemId,
        ...(typeof input.tmdbId === 'number' && input.tmdbId > 0 ? { posterTmdbId: input.tmdbId } : {}),
        backgroundCandidates,
    }
}

export interface TmdbTitleCandidate {
    id?: number
    title?: string
    name?: string
    release_date?: string
    first_air_date?: string
    poster_path?: string | null
    backdrop_path?: string | null
}

export interface TmdbTitleMatch {
    tmdbId: number
    posterUrl?: string
    backdropUrl?: string
}

const TMDB_TITLE_IMAGE_BASE = 'https://image.tmdb.org/t/p'

/**
 * Strict last-resort title match: exactly one result may carry the row title
 * (case-insensitive after trimming) and, when the row year is known, that
 * release year. Zero results, several, a year mismatch or a near title stay
 * unresolved so a wrong poster is never shown.
 */
export function pickUniqueTmdbTitleMatch(
    rowName: string,
    year: number | undefined,
    results: TmdbTitleCandidate[] | null | undefined,
): TmdbTitleMatch | undefined {
    if (!Array.isArray(results)) return undefined
    const wanted = rowName.trim().toLowerCase()
    if (!wanted) return undefined
    const matches = results.filter(result => {
        const title = (result.title ?? result.name ?? '').trim().toLowerCase()
        if (!title || title !== wanted) return false
        if (typeof year === 'number' && year > 0) {
            const date = result.release_date ?? result.first_air_date
            const releaseYear = typeof date === 'string' && date.length >= 4 ? Number.parseInt(date.slice(0, 4), 10) : Number.NaN
            if (!Number.isFinite(releaseYear) || releaseYear !== year) return false
        }
        return true
    })
    const [match] = matches
    if (matches.length !== 1 || typeof match.id !== 'number' || match.id <= 0) return undefined
    return {
        tmdbId: match.id,
        posterUrl: match.poster_path ? `${TMDB_TITLE_IMAGE_BASE}/w500${match.poster_path}` : undefined,
        backdropUrl: match.backdrop_path ? `${TMDB_TITLE_IMAGE_BASE}/original${match.backdrop_path}` : undefined,
    }
}

/**
 * Cinemeta endpoints to try for a row type, in order. A known type queries only its own
 * endpoint (the other one is empty for that id); an unknown type tries both.
 */
export function cinemetaMediaTypes(type?: string | null): CinemetaMediaType[] {
    if (type === 'movie') return ['movie']
    if (type === 'series' || type === 'anime' || type === 'episode' || type === 'tv') return ['series']
    return ['series', 'movie']
}
