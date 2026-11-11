// Shared display-metadata overlay for Activity rows whose source only provided a
// raw provider identifier as the title (e.g. a second connection reporting
// "kitsu:43248" while its sibling already shows the real name). Id fetching
// lives in cinemeta-cache.ts / kitsu-meta.ts; the title search is injected.
//
// Leaf module by design: only type-only imports, so the local node --test suite
// can execute it directly.

import type { ActivityItem } from '../types/activity.ts'
import { isImdbId, metahubPosterUrl } from './activity-artwork.ts'
import { parseKitsuId } from './kitsu-meta.ts'
import { normalizeWatcherTitle, watcherIdentityKeys } from './watcher-identity.ts'

// Same shape as the inline regex kept in useWatchHistory.ts / ActivityPage.tsx:
// an anchored, full-match raw provider id is a placeholder, not a title.
const RAW_IDENTIFIER_NAME_RE = /^(tt\d{7,}|kitsu:\d+(?::\d+){0,2}|mv:\d+|show:\d+|tmdb:\d+|mal:\d+|anilist:\d+|anidb:\d+|tvdb:\d+)$/i

export interface ResolvedMetadata {
    name: string
    poster?: string
    genres?: string[]
}

export function isUnresolvedActivityName(name: string | undefined | null): boolean {
    if (!name || typeof name !== 'string') return true
    const trimmed = name.trim()
    return !trimmed || trimmed === 'Unknown Title' || RAW_IDENTIFIER_NAME_RE.test(trimmed)
}

export type PendingMetadataTarget =
    | { kind: 'imdb'; itemId: string; type?: string }
    | { kind: 'tmdb'; itemId: string; tmdbId: string; type: 'movie' | 'series'; name: string }
    | { kind: 'kitsu'; itemId: string; kitsuId: string }
    | { kind: 'title'; itemId: string; identity: string; name: string; type: string }

/** Bookkeeping key for a target: title targets by identity, id targets by itemId. */
export function metadataTargetKey(target: PendingMetadataTarget): string {
    return target.kind === 'title' ? target.identity : target.itemId
}

/**
 * Collect the unresolved rows a resolver pass should work on, in feed order,
 * deduped by itemId (two connections watching the same id resolve once) and,
 * for title targets, by identity. `resolved` is keyed by metadataTargetKey.
 * Rows with configured names are never collected: resolution only ever fills
 * blank/identifier titles and never overrides real metadata.
 *
 * The candidate list is pure in `history` alone (the `resolved` filter is
 * applied by the caller per pass), so it is memoized by input identity: the
 * resolver commits once per batch and used to rescan every row each time.
 */
const unresolvedCandidatesCache = new WeakMap<object, PendingMetadataTarget[]>()

export function collectUnresolvedMetadataTargets(
    history: Array<Pick<ActivityItem, 'itemId' | 'uniqueItemId' | 'name' | 'poster' | 'type'>>,
    resolved: { has(itemId: string): boolean },
): PendingMetadataTarget[] {
    let candidates = unresolvedCandidatesCache.get(history)
    if (!candidates) {
        candidates = []
        const seen = new Set<string>()
        for (const item of history) {
            if (!item?.itemId || seen.has(item.itemId) || resolved.has(item.itemId)) continue
            if (!isUnresolvedActivityName(item.name) && item.poster) continue
            if (item.itemId.startsWith('tt')) {
                seen.add(item.itemId)
                candidates.push(item.type ? { kind: 'imdb', itemId: item.itemId, type: item.type } : { kind: 'imdb', itemId: item.itemId })
                continue
            }
            const tmdbId = /^tmdb:(\d+)$/i.exec(item.itemId)?.[1]
            if (tmdbId && (item.type === 'movie' || item.type === 'series' || item.type === 'anime' || item.type === 'episode')) {
                seen.add(item.itemId)
                candidates.push({ kind: 'tmdb', itemId: item.itemId, tmdbId, type: item.type === 'movie' ? 'movie' : 'series', name: item.name })
                continue
            }
            // Episode rows can carry the provider id on the episode-aware unique id
            // (e.g. itemId "kitsu:43248", uniqueItemId "kitsu:43248:1:6"); accept both.
            const kitsuId = parseKitsuId(item.itemId) ?? parseKitsuId(item.uniqueItemId)
            if (kitsuId) {
                seen.add(item.itemId)
                candidates.push({ kind: 'kitsu', itemId: item.itemId, kitsuId })
                continue
            }
            if (!isUnresolvedActivityName(item.name)
                && !item.poster
                && (item.type === 'movie' || item.type === 'series' || item.type === 'anime')) {
                const identity = watcherIdentityKeys(item).find(key => key.startsWith('m:') || key.startsWith('s:'))
                if (identity && !seen.has(identity) && !resolved.has(identity)) {
                    seen.add(identity)
                    candidates.push({ kind: 'title', itemId: item.itemId, identity, name: item.name, type: item.type })
                }
            }
        }
        unresolvedCandidatesCache.set(history, candidates)
    }
    // The memo above skipped already-resolved itemIds when it was built; a later
    // pass must still skip ids and title identities resolved since, without
    // rebuilding the ordering. Both exclusion keys are checked every call: title
    // targets are recorded under their identity, not their itemId.
    return candidates.some(target => resolved.has(target.itemId) || (target.kind === 'title' && resolved.has(target.identity)))
        ? candidates.filter(target => !resolved.has(target.itemId) && (target.kind !== 'title' || !resolved.has(target.identity)))
        : candidates
}

/** Next resolver batch, skipping targets whose last failed attempt is within retryMs. */
export function selectMetadataBatch(
    history: Array<Pick<ActivityItem, 'itemId' | 'uniqueItemId' | 'name' | 'poster' | 'type'>>,
    resolved: { has(key: string): boolean },
    failedAt: ReadonlyMap<string, number>,
    now: number,
    retryMs: number,
    limit: number,
): PendingMetadataTarget[] {
    return collectUnresolvedMetadataTargets(history, resolved)
        .filter(target => now - (failedAt.get(metadataTargetKey(target)) ?? -Infinity) >= retryMs)
        .slice(0, limit)
}

export interface TitleSearchCandidate {
    id: string
    type: string
    name: string
    poster?: string
}

/**
 * Cached, in-flight-deduped title search that only accepts a single exact
 * same-type match, so ambiguous same-title remakes resolve to nothing.
 * Misses are cached for ttlMs only.
 */
export function createTitleMetadataSearch(
    search: (name: string, mediaType: 'movie' | 'series') => Promise<TitleSearchCandidate[]>,
    { ttlMs, max }: { ttlMs: number; max: number },
): (name: string, type: string) => Promise<ResolvedMetadata | null> {
    const cache = new Map<string, { at: number; value: ResolvedMetadata | null }>()
    const inflight = new Map<string, Promise<ResolvedMetadata | null>>()
    return async (name, type) => {
        const mediaType = type === 'series' || type === 'anime' ? 'series' : 'movie'
        const normalized = normalizeWatcherTitle(name)
        const key = `${mediaType}:${normalized}`
        const cached = cache.get(key)
        if (cached && Date.now() - cached.at < ttlMs) return cached.value
        const existing = inflight.get(key)
        if (existing) return existing
        const request = (async () => {
            try {
                const results = await search(name, mediaType)
                const matches = results.filter(candidate => candidate.type === mediaType && normalizeWatcherTitle(candidate.name) === normalized)
                const ids = new Set(matches.map(candidate => candidate.id).filter(Boolean))
                if (ids.size !== 1) return null
                const match = matches[0]
                // Metahub by IMDb id is the canonical, proxied, key-free source; the catalog poster is a third-party host.
                const poster = isImdbId(match?.id) ? metahubPosterUrl(match.id) : match?.poster
                return match?.name ? { name: match.name, poster } : null
            } catch {
                return null
            }
        })()
        inflight.set(key, request)
        try {
            const value = await request
            cache.delete(key)
            cache.set(key, { at: Date.now(), value })
            while (cache.size > max) cache.delete(cache.keys().next().value!)
            return value
        } finally {
            inflight.delete(key)
        }
    }
}

// The title-conflict scan is pure in `items` (it never looks at `resolved`), but
// the overlay runs once per resolver commit and used to rescan every row twice
// each time. Keyed by input identity, same contract as the feed's row caches.
interface TitleConflictIndex {
    titleKeyByItem: Map<ActivityItem, string | undefined>
    conflictingTitles: Set<string>
}
const titleConflictCache = new WeakMap<ActivityItem[], TitleConflictIndex>()

function titleConflictIndex(items: ActivityItem[]): TitleConflictIndex {
    const cached = titleConflictCache.get(items)
    if (cached) return cached
    const titleKeyByItem = new Map<ActivityItem, string | undefined>()
    const titleIds = new Map<string, Set<string>>()
    for (const item of items) {
        // Every row keeps its computed title key, even without an IMDb id: the
        // apply pass must suppress alias matching for a non-IMDb row whose title
        // is ambiguous across IMDb ids, exactly like the original inline scan.
        const titleKey = watcherIdentityKeys(item).find(key => key.startsWith('m:') || key.startsWith('s:'))
        titleKeyByItem.set(item, titleKey)
        const tt = /^tt\d+/i.exec(item.itemId || '')?.[0].toLowerCase()
        if (!titleKey || !tt) continue
        const ids = titleIds.get(titleKey) || new Set<string>()
        ids.add(tt)
        titleIds.set(titleKey, ids)
    }
    const conflictingTitles = new Set([...titleIds].filter(([, ids]) => ids.size > 1).map(([key]) => key))
    const index = { titleKeyByItem, conflictingTitles }
    titleConflictCache.set(items, index)
    return index
}

/**
 * Apply resolved metadata over feed items: replace only bad names, fill only
 * missing poster/genres. IDs, provenance and watch state are untouched, and the
 * input array/objects are never mutated. Returns the same array reference when
 * nothing changed so downstream memoization stays stable.
 */
export function applyResolvedMetadataOverlay(
    items: ActivityItem[],
    resolved: Map<string, ResolvedMetadata>,
): ActivityItem[] {
    if (resolved.size === 0) return items
    let changed = false
    const { titleKeyByItem, conflictingTitles } = titleConflictIndex(items)
    const next = items.map(item => {
        const keys = watcherIdentityKeys(item)
        const titleKey = titleKeyByItem.get(item)
        const safeKeys = titleKey && conflictingTitles.has(titleKey) ? keys.filter(key => key.startsWith('tt:')) : keys
        const entry = resolved.get(item.itemId) || safeKeys.map(key => resolved.get(key)).find(Boolean)
        if (!entry) return item
        const name = isUnresolvedActivityName(item.name) ? entry.name || item.name : item.name
        const poster = item.poster || entry.poster
        const genres = item.genres?.length ? item.genres : entry.genres
        if (name === item.name && poster === item.poster && genres === item.genres) return item
        changed = true
        return {
            ...item,
            name,
            ...(poster ? { poster } : {}),
            ...(genres ? { genres } : {}),
        }
    })
    return changed ? next : items
}
