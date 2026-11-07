// Share metadata results and in-flight requests across episode rows.

import { cinemetaMediaTypes } from './activity-artwork.ts'
import type { SlimCinemeta, SlimLookup } from './cinemeta-slim-store.ts'

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
    meta: CinemetaMeta
    fetchedAt: number
}

const cinemetaCache = new Map<string, CinemetaCacheEntry>()
// Misses are per endpoint: a series miss must never hide the movie answer for the same id.
const cinemetaMisses = new Map<string, number>()
const cinemetaInFlight = new Map<string, Promise<CinemetaMeta | null>>()
const CINEMETA_TTL = 24 * 60 * 60 * 1000
const CINEMETA_NULL_TTL = 5 * 60 * 1000

export function parseCinemetaGenres(meta: CinemetaMeta | undefined | null): string[] {
    if (!meta || typeof meta.genre !== 'string' || !meta.genre.trim()) return []
    return meta.genre.split(',').map(g => g.trim()).filter(Boolean)
}

const remember = (imdbId: string, meta: CinemetaMeta) => {
    cinemetaCache.set(imdbId, { meta, fetchedAt: Date.now() })
}

const miss = (imdbId: string, mediaType: string) => {
    cinemetaMisses.set(`${mediaType}:${imdbId}`, Date.now())
}

export interface CinemetaSlimPersistence {
    get(imdbId: string, mediaType: string): Promise<SlimLookup>
    put(imdbId: string, value: SlimCinemeta): Promise<void>
    putAbsent(imdbId: string, mediaType: string): Promise<void>
}

let slimPersistence: CinemetaSlimPersistence | null = null
let slimPersistenceLoad: Promise<void> | null = null

export function setCinemetaSlimPersistence(next: CinemetaSlimPersistence | null) {
    slimPersistence = next
}

async function resolveSlimPersistence(): Promise<CinemetaSlimPersistence | null> {
    if (slimPersistence) return slimPersistence
    if (typeof window === 'undefined') return null
    slimPersistenceLoad ??= import('./cinemeta-slim-persistence').then(module => {
        slimPersistence ??= module.cinemetaSlimStore
    }).catch(() => {})
    await slimPersistenceLoad
    return slimPersistence
}

export function toSlimCinemeta(meta: CinemetaMeta | null | undefined): SlimCinemeta | null {
    const name = meta?.name?.trim()
    if (!meta || !name) return null
    const genres = parseCinemetaGenres(meta)
    return { name, poster: meta.poster, genres: genres.length ? genres : undefined, type: meta.type }
}

const persistSlim = (imdbId: string, meta: CinemetaMeta) => {
    const slim = toSlimCinemeta(meta)
    if (slim) void resolveSlimPersistence().then(store => store?.put(imdbId, slim)).catch(() => {})
}

const persistAbsent = (imdbId: string, mediaType: string) => {
    void resolveSlimPersistence().then(store => store?.putAbsent(imdbId, mediaType)).catch(() => {})
}

async function fetchCinemetaUncached(imdbId: string, mediaType: string): Promise<CinemetaMeta | null> {
    try {
        const res = await fetch(`https://cinemeta-live.strem.io/meta/${mediaType}/${imdbId}.json`, { signal: AbortSignal.timeout(8000) })
        if (!res.ok) {
            if (import.meta.env?.DEV) console.warn(`[Cinemeta] ${res.status} for ${imdbId} (${mediaType})`)
            miss(imdbId, mediaType)
            if (res.status === 404) persistAbsent(imdbId, mediaType)
            return null
        }
        const data = await res.json()
        const raw: Record<string, unknown> | null = data?.meta ?? null
        if (!raw) {
            miss(imdbId, mediaType)
            persistAbsent(imdbId, mediaType)
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

        remember(imdbId, meta)
        if (meta.name?.trim()) persistSlim(imdbId, meta)
        else persistAbsent(imdbId, mediaType)
        return meta
    } catch {
        miss(imdbId, mediaType)
        return null
    }
}

export async function fetchCinemetaDetail(imdbId: string, type?: string): Promise<CinemetaMeta | null> {
    if (!imdbId || !imdbId.startsWith('tt')) return null
    const cached = cinemetaCache.get(imdbId)
    if (cached && Date.now() - cached.fetchedAt < CINEMETA_TTL) return cached.meta
    for (const mediaType of cinemetaMediaTypes(type)) {
        const missedAt = cinemetaMisses.get(`${mediaType}:${imdbId}`)
        if (missedAt !== undefined && Date.now() - missedAt < CINEMETA_NULL_TTL) continue
        const flightKey = `${mediaType}:${imdbId}`
        let flight = cinemetaInFlight.get(flightKey)
        if (!flight) {
            flight = fetchCinemetaUncached(imdbId, mediaType).finally(() => {
                cinemetaInFlight.delete(flightKey)
            })
            cinemetaInFlight.set(flightKey, flight)
        }
        const meta = await flight
        if (meta) return meta
    }
    return null
}

/** Name, poster and genres only: memory, then the encrypted persisted record, then the network. */
export async function fetchCinemetaSlim(imdbId: string, type?: string): Promise<SlimCinemeta | null> {
    if (!imdbId || !imdbId.startsWith('tt')) return null
    const cached = cinemetaCache.get(imdbId)
    if (cached && Date.now() - cached.fetchedAt < CINEMETA_TTL) return toSlimCinemeta(cached.meta)
    const mediaTypes = cinemetaMediaTypes(type)
    try {
        const store = await resolveSlimPersistence()
        let absent = 0
        for (const mediaType of mediaTypes) {
            const persisted = await store?.get(imdbId, mediaType)
            if (persisted?.kind === 'hit') return persisted.value
            if (persisted?.kind === 'absent') absent++
        }
        if (absent === mediaTypes.length) return null
    } catch {
        // Persistence is an optimization: fall through to the network.
    }
    return toSlimCinemeta(await fetchCinemetaDetail(imdbId, type))
}

export function getCachedCinemetaName(imdbId: string): string | null {
    if (!imdbId || !imdbId.startsWith('tt')) return null
    const cached = cinemetaCache.get(imdbId)
    if (!cached) return null
    if (Date.now() - cached.fetchedAt > CINEMETA_TTL) return null
    return cached.meta.name?.trim() || null
}

/** TMDB id from the in-memory detail cache only; never fetches. */
export function getCachedCinemetaTmdbId(imdbId: string): number | undefined {
    if (!imdbId || !imdbId.startsWith('tt')) return undefined
    const cached = cinemetaCache.get(imdbId)
    if (!cached || Date.now() - cached.fetchedAt > CINEMETA_TTL) return undefined
    return cached.meta.tmdbId
}

/** Runtime from the in-memory detail cache only (the slim store keeps none); never fetches. */
export function getCachedCinemetaRuntimeMs(imdbId: string): number | undefined {
    if (!imdbId || !imdbId.startsWith('tt')) return undefined
    const cached = cinemetaCache.get(imdbId)
    if (!cached || Date.now() - cached.fetchedAt > CINEMETA_TTL) return undefined
    const runtime = cached.meta.runtime?.trim().toLowerCase()
    if (!runtime) return undefined
    const hours = runtime.match(/(\d+)\s*h/)
    const minutes = runtime.match(/(\d+)\s*m/)
    const bare = !hours && !minutes ? runtime.match(/^(\d+)$/) : null
    const total = (hours ? Number(hours[1]) * 60 : 0) + (minutes ? Number(minutes[1]) : 0) + (bare ? Number(bare[1]) : 0)
    return total > 0 ? total * 60000 : undefined
}
