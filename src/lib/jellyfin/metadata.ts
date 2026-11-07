import { JellyfinError } from './client.ts'
import type { JellyfinItem, JellyfinNowPlayingItem } from './types.ts'

type MediaItem = JellyfinItem | JellyfinNowPlayingItem

export function jellyfinImdbId(providers: unknown): string | undefined {
    if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return undefined
    const value = Object.entries(providers).find(([key]) => key.toLowerCase() === 'imdb')?.[1]
    return typeof value === 'string' && /^tt\d+$/.test(value) ? value : undefined
}

/** TMDB provider id when present; artwork fallback only, never canonical identity. */
export function jellyfinTmdbId(providers: unknown): number | undefined {
    if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return undefined
    const value = Object.entries(providers).find(([key]) => key.toLowerCase() === 'tmdb')?.[1]
    if (typeof value !== 'string' || !/^\d+$/.test(value)) return undefined
    const id = Number(value)
    return Number.isSafeInteger(id) && id > 0 ? id : undefined
}

/** Prefer the most interoperable provider identity available for a title. */
export function jellyfinCanonicalId(providers: unknown): string | undefined {
    if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return undefined
    const entries = Object.entries(providers)
    const read = (provider: string, pattern: RegExp) => {
        const value = entries.find(([key]) => key.toLowerCase() === provider)?.[1]
        return typeof value === 'string' && pattern.test(value) ? value : undefined
    }
    const imdb = read('imdb', /^tt\d+$/)
    if (imdb) return imdb
    const tmdb = read('tmdb', /^\d+$/)
    if (tmdb) return `tmdb:${tmdb}`
    const tvdb = read('tvdb', /^\d+$/)
    return tvdb ? `tvdb:${tvdb}` : undefined
}

function sameProviderIds(a: Record<string, string> | undefined, b: Record<string, string> | undefined): boolean {
    if (a === b) return true
    if (!a || !b) return false
    const aKeys = Object.keys(a)
    const bKeys = Object.keys(b)
    if (aKeys.length !== bKeys.length) return false
    return aKeys.every(key => a[key] === b[key])
}

const LOOKUP_CONCURRENCY = 4
/** Lookups one library pass may issue; the rest resume from the cache on the next pass. */
export const SERIES_LOOKUPS_PER_PASS = 512
/** Series ids per Ids query; 50 dashed GUIDs keep the URL well under typical limits. */
export const SERIES_BATCH_SIZE = 50
const PARENT_SERIES_MAX = 4096
const NO_PROVIDER_ID_TTL_MS = 60 * 60_000

const hasSeriesId = (item: MediaItem): item is MediaItem & { SeriesId: string } =>
    item.Type === 'Episode' && typeof item.SeriesId === 'string' && !!item.SeriesId && !/^tt\d+$/.test(item.SeriesId)

export interface ParentSeriesLookup {
    /** Whether the answer is already cached (found, or confirmed provider-less and unexpired). */
    has(key: string): boolean
    /** Provider ids of an already resolved series; refreshes its recency. */
    peek(key: string): Record<string, string> | undefined
    /** Records ids learned from an item that already carries its verified parent ids. */
    learn(key: string, id: string, providerIds: Record<string, string>): void
    /** Records a confirmed Series answer that carries no canonical provider id. */
    learnAbsent(key: string): void
    /** Cached positive or confirmed-negative answer, otherwise one shared network read. */
    read(key: string, id: string, readItem: (id: string, signal: AbortSignal) => Promise<JellyfinItem>, signal: AbortSignal): Promise<JellyfinItem>
    clear(): void
}

/**
 * Bounded parent-series answers for one scope. A negative entry is recorded only
 * when the server answered with the Series itself and it carries no canonical
 * provider id; a failure, timeout or abort is never remembered.
 */
export function createParentSeriesLookup(options: { max?: number; noProviderIdTtlMs?: number; now?: () => number } = {}): ParentSeriesLookup {
    const max = options.max ?? PARENT_SERIES_MAX
    const ttl = options.noProviderIdTtlMs ?? NO_PROVIDER_ID_TTL_MS
    const now = options.now ?? Date.now
    const found = new Map<string, JellyfinItem>()
    const absent = new Map<string, number>()
    const inflight = new Map<string, { promise: Promise<JellyfinItem>; signal: AbortSignal }>()
    const remember = <V>(map: Map<string, V>, key: string, value: V) => {
        map.delete(key)
        map.set(key, value)
        while (map.size > max) {
            const oldest = map.keys().next().value
            if (oldest === undefined) break
            map.delete(oldest)
        }
    }
    const peek = (key: string) => {
        const hit = found.get(key)
        if (!hit) return undefined
        found.delete(key)
        found.set(key, hit)
        return hit.ProviderIds
    }
    return {
        peek,
        has: key => found.has(key) || (absent.get(key) ?? 0) > now(),
        learn(key, id, providerIds) {
            if (!found.has(key)) remember(found, key, { Id: id, Type: 'Series', ProviderIds: providerIds })
        },
        learnAbsent(key) {
            if (!found.has(key)) remember(absent, key, now() + ttl)
        },
        async read(key, id, readItem, signal) {
            signal.throwIfAborted()
            const hit = found.get(key)
            if (hit) {
                peek(key)
                return hit
            }
            const expiry = absent.get(key)
            if (expiry !== undefined) {
                if (expiry > now()) return { Id: id, Type: 'Series' }
                absent.delete(key)
            }
            const existing = inflight.get(key)
            if (existing && !existing.signal.aborted) return existing.promise
            if (existing) inflight.delete(key)
            const request = (async () => {
                const parent = await readItem(id, signal)
                if (parent.Id === id && parent.Type === 'Series') {
                    if (jellyfinCanonicalId(parent.ProviderIds)) remember(found, key, { Id: id, Type: 'Series', ProviderIds: parent.ProviderIds })
                    else remember(absent, key, now() + ttl)
                }
                return parent
            })()
            inflight.set(key, { promise: request, signal })
            try {
                return await request
            } finally {
                if (inflight.get(key)?.promise === request) inflight.delete(key)
            }
        },
        clear() {
            found.clear()
            absent.clear()
            inflight.clear()
        },
    }
}

/**
 * Applies already known parent ids synchronously so a republished raw read keeps
 * the identity an earlier lookup established. Items that already carry verified
 * parent ids teach the lookup. Returns the input array when nothing changed.
 */
export function applyKnownParents<T extends MediaItem>(items: T[], lookup: Pick<ParentSeriesLookup, 'peek' | 'learn'>, keyOf: (seriesId: string) => string): T[] {
    let changed = false
    const out = items.map(item => {
        if (!hasSeriesId(item)) return item
        const key = keyOf(item.SeriesId)
        if (jellyfinCanonicalId(item.SeriesProviderIds)) {
            lookup.learn(key, item.SeriesId, item.SeriesProviderIds!)
            return item
        }
        const providerIds = lookup.peek(key)
        if (!providerIds) return item
        changed = true
        return { ...item, SeriesProviderIds: providerIds }
    })
    return changed ? out : items
}

/**
 * Batched parent-series resolution through one Ids query per chunk. Only rows
 * with an exact requested Id and Type Series are accepted; an id the batch
 * omitted stays unknown and is retried per-item, never negative-cached.
 */
export interface SeriesBatchReader {
    read(ids: string[], signal: AbortSignal): Promise<JellyfinItem[]>
    /** Records one accepted row into the caller's cache. */
    learn?(item: JellyfinItem, canonical: boolean): void
    /** Marks the Ids query unusable for this scope (facade answered outside the requested set). */
    onUnsupported?(): void
}

/** Resolve parent series in the same authenticated user scope; never use an episode's IMDb ID as its parent. */
export async function resolveJellyfinSeries<T extends MediaItem>(
    items: T[],
    readItem: (id: string, signal: AbortSignal) => Promise<JellyfinItem>,
    signal: AbortSignal,
    previous: MediaItem[] = [],
    limit = 32,
    settled?: (id: string) => boolean,
    batch?: SeriesBatchReader,
): Promise<T[]> {
    const parents = new Map<string, Record<string, string>>()
    for (const item of previous) {
        if (item.SeriesId && jellyfinCanonicalId(item.SeriesProviderIds)) parents.set(item.SeriesId, item.SeriesProviderIds!)
    }
    const wanted = [...new Set(items.filter(item => hasSeriesId(item) && !parents.has(item.SeriesId)).map(item => item.SeriesId!))]
    // Cached answers cost nothing, so only network lookups spend the pass budget.
    const cached = settled ? wanted.filter(settled) : []
    const lookup = settled ? wanted.filter(id => !settled(id)).slice(0, limit) : wanted.slice(0, limit)
    const ordered = [...lookup, ...cached]
    // Cached ids still go through readItem, which answers them from the cache without a request.
    const fallback = new Set<string>(ordered)
    if (batch && lookup.length > 1) {
        let useBatch = true
        for (let start = 0; start < lookup.length && useBatch;) {
            signal.throwIfAborted()
            const chunk = lookup.slice(start, start + SERIES_BATCH_SIZE)
            const deadline = AbortSignal.any([signal, AbortSignal.timeout(5_000)])
            let returned: JellyfinItem[]
            try {
                returned = await batch.read(chunk, deadline)
            } catch (err) {
                if (err instanceof JellyfinError && err.status === 400) {
                    useBatch = false
                    batch.onUnsupported?.()
                }
                signal.throwIfAborted()
                start += chunk.length
                continue
            }
            const requested = new Set(chunk)
            if (returned.some(row => !requested.has(row.Id))) {
                useBatch = false
                batch.onUnsupported?.()
                start += chunk.length
                continue
            }
            for (const row of returned) {
                if (row.Type !== 'Series') continue
                const canonical = jellyfinCanonicalId(row.ProviderIds)
                batch.learn?.(row, !!canonical)
                if (canonical) parents.set(row.Id, row.ProviderIds!)
                fallback.delete(row.Id)
            }
            start += chunk.length
        }
    }
    const ids = ordered.filter(id => fallback.has(id))
    // Each small batch has its own deadline, so a long list is bounded by
    // concurrency rather than one shared clock. Playback data is never held back.
    for (let start = 0; start < ids.length; start += LOOKUP_CONCURRENCY) {
        signal.throwIfAborted()
        const batchSignal = AbortSignal.any([signal, AbortSignal.timeout(5_000)])
        const outcomes = await Promise.all(ids.slice(start, start + LOOKUP_CONCURRENCY).map(async id => {
            try {
                const parent = await readItem(id, batchSignal)
                if (parent.Id === id && parent.Type === 'Series' && jellyfinCanonicalId(parent.ProviderIds)) parents.set(id, parent.ProviderIds!)
                return true
            } catch {
                // Missing or unsupported metadata must not discard valid playback/library reads.
                signal.throwIfAborted()
                return false
            }
        }))
        // A batch where every read failed ends this pass; the next one resumes from the cache.
        if (!outcomes.some(Boolean)) break
    }
    signal.throwIfAborted()
    let changed = false
    const resolved = items.map(item => {
        if (item.Type === 'Episode' && item.SeriesId && parents.has(item.SeriesId)) {
            const providerIds = parents.get(item.SeriesId)
            if (!sameProviderIds(item.SeriesProviderIds, providerIds)) {
                changed = true
                return { ...item, SeriesProviderIds: providerIds }
            }
        }
        return item
    })
    // Preserve input identity when enrichment found nothing new so callers can
    // skip a display-identical query publication and cache write.
    return changed ? resolved : items
}
