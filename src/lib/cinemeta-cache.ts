// Share metadata results and in-flight requests across episode rows.

import { cinemetaMediaTypes } from './activity-artwork.ts'
import { setBounded } from './jellyfin/media-cache.ts'
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
const cinemetaInFlight = new Map<string, Promise<CinemetaLookup>>()
// Overload and upstream failures are not answers: they back off briefly in memory and
// are never recorded as misses or persisted as absent.
const cinemetaTransient = new Map<string, number>()
const CINEMETA_TTL = 24 * 60 * 60 * 1000
const CINEMETA_NULL_TTL = 5 * 60 * 1000
const CINEMETA_TRANSIENT_BACKOFF_MS = 15_000

interface CinemetaLookup { meta: CinemetaMeta | null; transient: boolean }
// A large feed (tens of thousands of events, mostly distinct ids) walks far more
// metas than a few hundred; the fat cache holds the ones the session actually
// revisits while the slim persisted store carries the long tail.
const CINEMETA_CACHE_MAX = 5000
const CINEMETA_MISS_MAX = 20000

interface CinemetaLiteEntry {
    name?: string
    tmdbId?: number
    runtimeMs?: number
    fetchedAt: number
}
// Synchronous lookups (Activity title search, tmdb aliasing, runtime badges) must
// keep answering for every title fetched this session, matching the unbounded
// origin cache even after the fat objects are evicted. These three-field records
// are tiny, so they live in their own generously bounded index that never follows
// the fat meta out the door.
const cinemetaLite = new Map<string, CinemetaLiteEntry>()
const CINEMETA_LITE_MAX = 50000

export function parseCinemetaGenres(meta: CinemetaMeta | undefined | null): string[] {
    if (!meta || typeof meta.genre !== 'string' || !meta.genre.trim()) return []
    return meta.genre.split(',').map(g => g.trim()).filter(Boolean)
}

function runtimeToMs(runtime: string | undefined): number | undefined {
    const value = runtime?.trim().toLowerCase()
    if (!value) return undefined
    const hours = value.match(/(\d+)\s*h/)
    const minutes = value.match(/(\d+)\s*m/)
    const bare = !hours && !minutes ? value.match(/^(\d+)$/) : null
    const total = (hours ? Number(hours[1]) * 60 : 0) + (minutes ? Number(minutes[1]) : 0) + (bare ? Number(bare[1]) : 0)
    return total > 0 ? total * 60000 : undefined
}

const remember = (imdbId: string, meta: CinemetaMeta) => {
    const fetchedAt = Date.now()
    setBounded(cinemetaCache, imdbId, { meta, fetchedAt }, CINEMETA_CACHE_MAX)
    setBounded(cinemetaLite, imdbId, { name: meta.name, tmdbId: meta.tmdbId, runtimeMs: runtimeToMs(meta.runtime), fetchedAt }, CINEMETA_LITE_MAX)
}

const miss = (imdbId: string, mediaType: string) => {
    setBounded(cinemetaMisses, `${mediaType}:${imdbId}`, Date.now(), CINEMETA_MISS_MAX)
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

// Per-row lookups ride one server batch instead of one browser fetch per meta: the
// queue coalesces everything requested inside a short window into POSTs of at most
// CINEMETA_BATCH_SIZE ids, with a hard cap on concurrent POSTs, so a page can never
// put an unbounded number of Cinemeta requests in flight at once.
const CINEMETA_BATCH_SIZE = 100
const CINEMETA_BATCH_INFLIGHT_MAX = 2
const CINEMETA_BATCH_FLUSH_MS = 15
const CINEMETA_DIRECT_BASE = 'https://cinemeta-live.strem.io'

interface CinemetaBatchResult { status: number; meta: Record<string, unknown> | null; transient?: boolean }

interface CinemetaBatchEntry {
    imdbId: string
    mediaType: string
    attempts: number
    resolve: (entry: CinemetaBatchResult) => void
}

const cinemetaBatchQueue: CinemetaBatchEntry[] = []
let cinemetaBatchTimer: ReturnType<typeof setTimeout> | null = null
let cinemetaBatchInflight = 0
let cinemetaBatchBlockedUntil = 0
const CINEMETA_BATCH_MAX_ATTEMPTS = 3
const CINEMETA_RETRY_AFTER_MAX_MS = 30_000

const retryAfterMs = (header: string | null, fallbackMs: number): number => {
    const seconds = Number(header)
    if (header && Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, CINEMETA_RETRY_AFTER_MAX_MS)
    const at = header ? Date.parse(header) : NaN
    if (Number.isFinite(at)) return Math.min(Math.max(0, at - Date.now()), CINEMETA_RETRY_AFTER_MAX_MS)
    return fallbackMs
}

// A rejected or failed batch goes back to the front of the queue until its attempts run
// out; then its ids resolve as transient, which no caller records or persists.
const requeueCinemetaBatch = (batch: CinemetaBatchEntry[], waitMs: number) => {
    cinemetaBatchBlockedUntil = Math.max(cinemetaBatchBlockedUntil, Date.now() + waitMs)
    const retry: CinemetaBatchEntry[] = []
    for (const entry of batch) {
        entry.attempts++
        if (entry.attempts >= CINEMETA_BATCH_MAX_ATTEMPTS) entry.resolve({ status: 0, meta: null, transient: true })
        else retry.push(entry)
    }
    cinemetaBatchQueue.unshift(...retry)
}

const CINEMETA_META_ID_RE = /^tt\d{5,10}$/

const directCinemetaMeta = async (imdbId: string, mediaType: string): Promise<{ status: number; meta: Record<string, unknown> | null }> => {
    const res = await fetch(`${CINEMETA_DIRECT_BASE}/meta/${mediaType}/${imdbId}.json`, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) return { status: res.status, meta: null }
    const data = await res.json()
    const raw = data?.meta ?? null
    return raw && typeof raw === 'object' ? { status: 200, meta: raw as Record<string, unknown> } : { status: 404, meta: null }
}

const scheduleCinemetaFlush = () => {
    if (cinemetaBatchTimer !== null || cinemetaBatchInflight >= CINEMETA_BATCH_INFLIGHT_MAX || cinemetaBatchQueue.length === 0) return
    cinemetaBatchTimer = setTimeout(() => {
        cinemetaBatchTimer = null
        void flushCinemetaBatch()
    }, Math.max(CINEMETA_BATCH_FLUSH_MS, cinemetaBatchBlockedUntil - Date.now()))
}

async function flushCinemetaBatch(): Promise<void> {
    if (Date.now() < cinemetaBatchBlockedUntil) {
        scheduleCinemetaFlush()
        return
    }
    while (cinemetaBatchQueue.length > 0 && cinemetaBatchInflight < CINEMETA_BATCH_INFLIGHT_MAX) {
        const batch = cinemetaBatchQueue.splice(0, CINEMETA_BATCH_SIZE)
        cinemetaBatchInflight++
        void postCinemetaBatch(batch).finally(() => {
            cinemetaBatchInflight--
            scheduleCinemetaFlush()
        })
    }
}

async function postCinemetaBatch(batch: CinemetaBatchEntry[]): Promise<void> {
    let posted = false
    try {
        const { getSyncAuthHeaders } = await import('./sync-auth.ts')
        const res = await fetch('/api/cinemeta-meta-batch', {
            method: 'POST',
            headers: await getSyncAuthHeaders(),
            body: JSON.stringify({ metas: batch.map(entry => ({ id: entry.imdbId, type: entry.mediaType })) }),
            signal: AbortSignal.timeout(30000),
        })
        posted = true
        if (!res.ok && res.status !== 404 && res.status !== 401) {
            requeueCinemetaBatch(batch, retryAfterMs(res.headers.get('retry-after'), res.status === 429 ? 2000 : 5000))
            return
        }
        if (!res.ok) throw Object.assign(new Error(`cinemeta-meta-batch ${res.status}`), { status: res.status })
        const data = await res.json()
        const byKey = new Map<string, { status: number; meta: Record<string, unknown> | null }>()
        for (const item of Array.isArray(data?.metas) ? data.metas : []) {
            if (!item || typeof item.id !== 'string' || !CINEMETA_META_ID_RE.test(item.id)) continue
            if (item.type !== 'movie' && item.type !== 'series') continue
            const meta = item.meta && typeof item.meta === 'object' ? item.meta as Record<string, unknown> : null
            byKey.set(`${item.type}:${item.id}`, { status: typeof item.status === 'number' ? item.status : 0, meta })
        }
        for (const entry of batch) {
            entry.resolve(byKey.get(`${entry.mediaType}:${entry.imdbId}`) ?? { status: 0, meta: null })
        }
    } catch (error) {
        const status = (error as { status?: number })?.status
        // Only an absent route (older server), a missing session, or no response at
        // all breaks the batch transport; those fall back to the exact direct fetch
        // the batch replaced. A bad payload is retried like an overloaded server.
        if (posted && status !== 404 && status !== 401) {
            requeueCinemetaBatch(batch, 5000)
            return
        }
        await Promise.all(batch.map(async entry => {
            try {
                entry.resolve(await directCinemetaMeta(entry.imdbId, entry.mediaType))
            } catch {
                entry.resolve({ status: 0, meta: null })
            }
        }))
    }
}

function queueCinemetaMeta(imdbId: string, mediaType: string): Promise<CinemetaBatchResult> {
    return new Promise(resolve => {
        cinemetaBatchQueue.push({ imdbId, mediaType, attempts: 0, resolve })
        scheduleCinemetaFlush()
    })
}

const markTransient = (imdbId: string, mediaType: string): CinemetaLookup => {
    setBounded(cinemetaTransient, `${mediaType}:${imdbId}`, Date.now(), CINEMETA_MISS_MAX)
    return { meta: null, transient: true }
}

async function fetchCinemetaUncached(imdbId: string, mediaType: string): Promise<CinemetaLookup> {
    try {
        const { status, meta: raw, transient } = await queueCinemetaMeta(imdbId, mediaType)
        if (!raw) {
            if (import.meta.env?.DEV) console.warn(`[Cinemeta] ${status} for ${imdbId} (${mediaType})`)
            if (transient || status !== 404) return markTransient(imdbId, mediaType)
            miss(imdbId, mediaType)
            persistAbsent(imdbId, mediaType)
            return { meta: null, transient: false }
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
        cinemetaTransient.delete(`${mediaType}:${imdbId}`)
        return { meta, transient: false }
    } catch {
        return markTransient(imdbId, mediaType)
    }
}

export async function fetchCinemetaDetail(imdbId: string, type?: string): Promise<CinemetaMeta | null> {
    return (await lookupCinemetaDetail(imdbId, type)).meta
}

async function lookupCinemetaDetail(imdbId: string, type?: string): Promise<CinemetaLookup> {
    if (!imdbId || !imdbId.startsWith('tt')) return { meta: null, transient: false }
    const cached = cinemetaCache.get(imdbId)
    if (cached && Date.now() - cached.fetchedAt < CINEMETA_TTL) {
        setBounded(cinemetaCache, imdbId, cached, CINEMETA_CACHE_MAX)
        return { meta: cached.meta, transient: false }
    }
    let transient = false
    for (const mediaType of cinemetaMediaTypes(type)) {
        const missedAt = cinemetaMisses.get(`${mediaType}:${imdbId}`)
        if (missedAt !== undefined && Date.now() - missedAt < CINEMETA_NULL_TTL) continue
        const failedAt = cinemetaTransient.get(`${mediaType}:${imdbId}`)
        if (failedAt !== undefined && Date.now() - failedAt < CINEMETA_TRANSIENT_BACKOFF_MS) {
            transient = true
            continue
        }
        const flightKey = `${mediaType}:${imdbId}`
        let flight = cinemetaInFlight.get(flightKey)
        if (!flight) {
            flight = fetchCinemetaUncached(imdbId, mediaType).finally(() => {
                cinemetaInFlight.delete(flightKey)
            })
            cinemetaInFlight.set(flightKey, flight)
        }
        const result = await flight
        if (result.meta) return result
        if (result.transient) transient = true
    }
    return { meta: null, transient }
}

/** Name, poster and genres only: memory, then the encrypted persisted record, then the network. */
export async function fetchCinemetaSlim(imdbId: string, type?: string): Promise<SlimCinemeta | null> {
    return (await fetchCinemetaSlimResult(imdbId, type)).slim
}

/** Like fetchCinemetaSlim, but says whether a null came from a failure worth retrying. */
export async function fetchCinemetaSlimResult(imdbId: string, type?: string): Promise<{ slim: SlimCinemeta | null; transient: boolean }> {
    if (!imdbId || !imdbId.startsWith('tt')) return { slim: null, transient: false }
    const cached = cinemetaCache.get(imdbId)
    if (cached && Date.now() - cached.fetchedAt < CINEMETA_TTL) {
        setBounded(cinemetaCache, imdbId, cached, CINEMETA_CACHE_MAX)
        return { slim: toSlimCinemeta(cached.meta), transient: false }
    }
    const mediaTypes = cinemetaMediaTypes(type)
    try {
        const store = await resolveSlimPersistence()
        let absent = 0
        for (const mediaType of mediaTypes) {
            const persisted = await store?.get(imdbId, mediaType)
            if (persisted?.kind === 'hit') return { slim: persisted.value, transient: false }
            if (persisted?.kind === 'absent') absent++
        }
        if (absent === mediaTypes.length) return { slim: null, transient: false }
    } catch {
        // Persistence is an optimization: fall through to the network.
    }
    const { meta, transient } = await lookupCinemetaDetail(imdbId, type)
    return { slim: toSlimCinemeta(meta), transient: !meta && transient }
}

// A hit promotes the entry (recency) without touching fetchedAt (the TTL never slides).
const liteEntry = (imdbId: string): CinemetaLiteEntry | null => {
    const lite = cinemetaLite.get(imdbId)
    if (!lite || Date.now() - lite.fetchedAt > CINEMETA_TTL) return null
    setBounded(cinemetaLite, imdbId, lite, CINEMETA_LITE_MAX)
    return lite
}

export function getCachedCinemetaName(imdbId: string): string | null {
    if (!imdbId || !imdbId.startsWith('tt')) return null
    return liteEntry(imdbId)?.name?.trim() || null
}

/** TMDB id from the in-memory lookup index only; never fetches. */
export function getCachedCinemetaTmdbId(imdbId: string): number | undefined {
    if (!imdbId || !imdbId.startsWith('tt')) return undefined
    return liteEntry(imdbId)?.tmdbId
}

/** Runtime from the in-memory lookup index only (the slim store keeps none); never fetches. */
export function getCachedCinemetaRuntimeMs(imdbId: string): number | undefined {
    if (!imdbId || !imdbId.startsWith('tt')) return undefined
    return liteEntry(imdbId)?.runtimeMs
}
