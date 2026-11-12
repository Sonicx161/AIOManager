import { useMemo, useState, useEffect, useDeferredValue, useRef } from 'react'
import { useWatchEventStore, filterTombstonedEvents } from '@/store/watchEventStore'
import { useLibraryCache } from '@/store/libraryCache'
import { useAccountStore } from '@/store/accountStore'
import { ActivityItem, SavedEpisodesSummary } from '@/types/activity'
import { getEpisodeIdentity, historyEntryToActivityItem } from '@/lib/activity-utils'
import { fetchCinemetaSlimResult } from '@/lib/cinemeta-cache'
import { resolveUnrecordedEpisodes } from '@/lib/episode-resolution'
import { summarizeSavedEpisodes } from '@/lib/imported-watch-state'
import { useJellyfinActivity, type MediaReadIssue } from '@/hooks/useJellyfinActivity'
import { activityNowStatus, collapseImportedCopies, mergeMediaHistory, mergeMediaItems } from '@/lib/jellyfin/activity'
import { reconcileRailProgress } from '@/lib/rail-progress'
import { trace } from '@/lib/trace'
import { usePacedValue } from '@/hooks/usePacedValue'
import { hasSeriesEventIdentity } from '@/lib/watch-event-cap'
import { isUnresolvedActivityName } from '@/lib/activity-metadata-overlay'
import { collapseHistoryEvents } from '@/lib/watch-history-collapse'
import { newestLiveOverlayEventIds, liveOverlayIdentityMatches } from '@/lib/watch-history-live-overlay'
import { canonicalEpisodeIdentity, tmdbAliasVersion, aliasDeletedAt } from '@/lib/activity-id-alias'
import { stremioScopeResolver } from '@/lib/connection-identity'
import { dedupWatchEntries } from '@/lib/watch-history-final-dedup'

const GENRE_CACHE_STORAGE_KEY = 'aio-genre-map-v1'
let _genreCache: Map<string, string[]> | null = null

// Cold-load derivation pacing: per-account watch-event diffs publish in a burst
// while the library loads, and every intermediate publication used to trigger a
// full history derivation. While a library load is active the
// events input to the big derivation is re-derived at most this often; the
// trailing edge always carries the newest events and the load ending delivers
// the final state immediately, so partial results stay usable and incremental
// single-change publications outside a load are unaffected.
const HISTORY_LOAD_PACE_MS = 1200
const NO_WATCH_EVENTS: ReturnType<typeof useWatchEventStore.getState>['events'] = []
const NO_LIBRARY_ITEMS: ReturnType<typeof useLibraryCache.getState>['items'] = []
const NO_HISTORY_ACCOUNTS: ReturnType<typeof useAccountStore.getState>['accounts'] = []
const NO_DELETED_EVENT_KEYS: ReturnType<typeof useWatchEventStore.getState>['deletedEventKeys'] = {}

/** Reference equality over a deps tuple (for the interrupted-render caches below). */
function depsEqual(a: unknown[], b: unknown[]): boolean {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
    return true
}

const LIVE_SESSION_FRESH_MS = 120_000

/**
 * Continue Watching order: actively playing sessions, then paused live sessions and
 * recently active progress, then everything else. Newest first within a tier; full
 * ties (tier, timestamp) break on id so the order is deterministic across loads.
 * Ordering only, nothing is dropped.
 */
export function orderContinueWatching(items: readonly ActivityItem[], now = Date.now()): ActivityItem[] {
    const byId = (a: ActivityItem, b: ActivityItem) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    const ranked = items.map(item => {
        const status = activityNowStatus(item, now)
        const observation = item.mediaObservation
        const liveAge = observation?.kind === 'live' ? now - (observation.reportedAt ?? observation.checkedAt) : NaN
        const tier = status === 'playing' ? 0
            : status === 'recent' || (liveAge >= -5_000 && liveAge < LIVE_SESSION_FRESH_MS) ? 1
            : 2
        const time = item.timestamp.getTime()
        return { item, tier, time: Number.isFinite(time) ? time : 0 }
    })
    ranked.sort((a, b) => a.tier - b.tier || b.time - a.time || byId(a.item, b.item))
    return ranked.map(entry => entry.item)
}

function loadGenreCache(): Map<string, string[]> {
    if (_genreCache) return _genreCache
    try {
        const raw = localStorage.getItem(GENRE_CACHE_STORAGE_KEY)
        _genreCache = raw ? new Map(JSON.parse(raw) as Array<[string, string[]]>) : new Map()
    } catch {
        _genreCache = new Map()
    }
    return _genreCache
}

function saveGenreCache(map: Map<string, string[]>) {
    _genreCache = map
    try { localStorage.setItem(GENRE_CACHE_STORAGE_KEY, JSON.stringify([...map])) } catch {}
}

/**
 * A unified watch history entry combining the richness of WatchEvents
 * (real timestamps, per-episode history) with live ActivityItem state
 * (current progress, poster, account metadata).
 */
export interface HistoryEntry {
    id: string
    itemId: string
    video_id: string      // episode-aware ID (distinct from the base itemId)
    accountId: string
    accountName: string
    accountColorIndex: number

    name: string
    type: string
    poster: string
    season?: number
    episode?: number

    timestamp: Date
    firstWatched?: Date    // maps to Stremio's _ctime
    detectedAt?: Date

    duration: number
    watched: number        // ms watched this session
    progress: number
    overallTimeWatched?: number
    timesWatched?: number
    flaggedWatched?: number

    isInProgress: boolean
    isFromEventLog: boolean
    source?: string
    /** Exact remote login this entry came from (same-platform multiplicity); absent = canonical/legacy. */
    sourceConnectionId?: ActivityItem['sourceConnectionId']
    readOnly?: ActivityItem['readOnly']
    mediaObservation?: ActivityItem['mediaObservation']
    mediaSources?: string[]
    mediaTargets?: ActivityItem['mediaTargets']
    backfill?: boolean     // recovered from the watched-bitfield (synthetic timestamp)
    /** Imported saved watch state: no real watch dates; presented as saved state, never a dated watch. */
    importedSavedState?: boolean
    timeApproximate?: boolean
    /** Verified saved-episode summary recovered from the watched bitfield (series aggregates). */
    savedEpisodes?: SavedEpisodesSummary
    genres?: string[]

    // Live overlay (only on the newest event of this play identity when it is also in the
    // current library; live-only entries always carry it)
    liveProgress?: number
    liveWatched?: number
    liveEpisode?: string
}

export interface WatchHistoryResult {
    refreshMedia: () => void
    mediaIssues: MediaReadIssue[]
    /** True while Jellyfin media reads (head, archive, sessions) or their identity enrichment are in flight. */
    mediaSettling: boolean
    history: HistoryEntry[]
    // Items currently in progress (timeOffset > 0, progress < 90) from live state
    inProgress: ActivityItem[]
    hasEventLog: boolean
    loading: boolean
}

export interface WatchHistoryOptions {
    /** Resolve missing genres from Cinemeta in the background. Default true; pages that never render genres opt out. */
    genres?: boolean
    /** Poll Jellyfin live sessions. Default true; pages that never show live playback opt out. */
    sessions?: boolean
    /** Jellyfin media reads (head, archive walks, sessions). Views that filter Jellyfin rows out opt out entirely. */
    media?: boolean
}

/** Cinemeta ids whose genres still need fetching; empty when the crawl is opted out. */
export function genreCrawlTargets(
    events: ReadonlyArray<{ itemId?: string; type?: string }> | undefined,
    genreMap: ReadonlyMap<string, string[]>,
    genresEnabled: boolean,
): { seen: Set<string>; needs: string[]; typeByItemId: Map<string, string | undefined> } {
    const seen = new Set<string>()
    const typeByItemId = new Map<string, string | undefined>()
    if (!genresEnabled || !events || events.length === 0) return { seen, needs: [], typeByItemId }
    for (const e of events) {
        const id = e.itemId
        if (id && id.startsWith('tt') && !seen.has(id)) {
            seen.add(id)
            typeByItemId.set(id, e.type)
        }
    }
    return { seen, needs: [...seen].filter(id => !genreMap.has(id)), typeByItemId }
}

const NO_SESSION_POLL = { sessions: false } as const
const DEFAULT_MEDIA_OPTIONS = {} as const

export function useWatchHistory(accountId?: string, enabled = true, options?: WatchHistoryOptions): WatchHistoryResult {
    const genresEnabled = options?.genres !== false
    const media = useJellyfinActivity(accountId, enabled && options?.media !== false, options?.sessions === false ? NO_SESSION_POLL : DEFAULT_MEDIA_OPTIONS)
    const rawEvents = useWatchEventStore(s => enabled ? s.events : NO_WATCH_EVENTS)
    const rawLiveItems = useLibraryCache(s => enabled ? s.items : NO_LIBRARY_ITEMS)
    const loading = useLibraryCache(s => enabled && s.loading)
    const accounts = useAccountStore(s => enabled ? s.accounts : NO_HISTORY_ACCOUNTS)
    const deletedEventKeys = useWatchEventStore(s => enabled ? s.deletedEventKeys : NO_DELETED_EVENT_KEYS)
    // Ownership, canonical-login changes and deletions invalidate a paced snapshot
    // immediately. A delayed event array must never outlive its identity context.
    const pacingScope = useMemo(() => [accounts, accountId, deletedEventKeys], [accounts, accountId, deletedEventKeys])
    const pacedEvents = usePacedValue(rawEvents, HISTORY_LOAD_PACE_MS, loading, pacingScope)
    const historyInput = useMemo(() => ({ events: pacedEvents, liveItems: rawLiveItems, scope: pacingScope }), [pacedEvents, rawLiveItems, pacingScope])
    const deferredInput = useDeferredValue(historyInput)
    const { events, liveItems } = deferredInput.scope === pacingScope
        ? deferredInput
        : { events: rawEvents, liveItems: rawLiveItems }
    const [genreMap, setGenreMap] = useState<Map<string, string[]>>(loadGenreCache)
    const [genreRetryTick, setGenreRetryTick] = useState(0)

    // Canonical-aware origin context: the CURRENT canonical login's items/events share the
    // bare account scope with legacy and server-merged canonical rows (so one watch never
    // shows twice), while every other login keeps its `accountId::connectionId` scope.
    // Post-promotion, the demoted login's frozen scopeKeys (rewritten by the migration)
    // agree with this computation. The legacy `${accountId}:stremio` marker is the
    // attribution of a possibly removed login and never folds onto a stored connection.
    const ctxOf = useMemo(() => stremioScopeResolver(accounts), [accounts])

    const baseDerivationRef = useRef<{ deps: unknown[]; value: { history: HistoryEntry[]; inProgress: ActivityItem[]; hasEventLog: boolean } } | null>(null)

    // Verified saved-episode recoveries per series scope. Derived from the RAW event stream
    // (not the paced/deferred input): the aggregate live items arrive as soon as the library
    // loads, while the paced events snapshot can lag a beat — deriving the index from the
    // paced input would blank the counts on every load. The cache is keyed by backfill
    // content, so publications that don't touch backfill events reuse the same Map and never
    // re-run the big derivation below.
    // An episode counts as confirmed-watched when it is a bitfield recovery, carries the
    // positive per-episode flag (recordBackfillEpisodes stamps it onto real events the
    // verified bitfield covers), or measurably completed a known duration (>= 95%). Mere
    // watch time or aggregate counts never qualify — a 20% partial is not a completion.
    const isConfirmedSavedEpisode = (e: typeof rawEvents[number]): boolean => {
        if (e.backfill) return true
        if ((e.flaggedWatched ?? 0) > 0) return true
        return e.duration > 0 && (e.time_watched || 0) >= 0.95 * e.duration
    }
    const hasValidEpisodeAnchor = (e: { season?: number; episode?: number }): boolean =>
        e.season != null && e.episode != null
        && Number.isInteger(e.season) && Number.isInteger(e.episode)
        && e.episode > 0
    const buildSavedEpisodeIndex = (evs: typeof rawEvents) => {
        const index = new Map<string, Array<{ season?: number; episode?: number }>>()
        for (const e of evs) {
            if (!hasValidEpisodeAnchor(e) || !isConfirmedSavedEpisode(e)) continue
            const key = `${ctxOf(e.accountId, e.sourceConnectionId)}:${e.itemId}`
            const arr = index.get(key)
            if (arr) arr.push({ season: e.season, episode: e.episode })
            else index.set(key, [{ season: e.season, episode: e.episode }])
        }
        return index
    }
    // Content key over every field the index derives from: identity plus WHY an event
    // counts (backfill detection, stamped flag, measured completion). Annotations land
    // without touching detected_ts, so the flag token is what forces the rebuild; plain
    // progress wiggle below the completion threshold never churns the key.
    const savedEpisodeContentKey = useMemo(() => {
        let k = ''
        for (const e of rawEvents) {
            if (!hasValidEpisodeAnchor(e)) continue
            if (e.backfill) { k += `${e.id}:b:${e.detected_ts};`; continue }
            if ((e.flaggedWatched ?? 0) > 0) { k += `${e.id}:f;`; continue }
            if (e.duration > 0 && (e.time_watched || 0) >= 0.95 * e.duration) k += `${e.id}:m;`
        }
        return k
    }, [rawEvents])
    const savedIndexCacheRef = useRef<{ key: string; ctx: typeof ctxOf; value: Map<string, Array<{ season?: number; episode?: number }>> } | null>(null)
    if (!savedIndexCacheRef.current || savedIndexCacheRef.current.key !== savedEpisodeContentKey || savedIndexCacheRef.current.ctx !== ctxOf) {
        savedIndexCacheRef.current = { key: savedEpisodeContentKey, ctx: ctxOf, value: buildSavedEpisodeIndex(rawEvents) }
    }
    const savedEpisodeEvents = savedIndexCacheRef.current.value
    const { history, inProgress, hasEventLog } = useMemo(() => {
        // Interrupted-render cache: concurrent React restarts in-progress deferred
        // renders when higher-priority store publications arrive mid-derivation,
        // discarding the memoized result and re-executing this full-history pass.
        // Keying the result by its input references in a ref makes every restart a
        // reference comparison instead of a second O(events + live items) derivation.
        // The body is a pure derivation of the deps, so an abandoned attempt's value
        // is exactly what the committed attempt produces for the same inputs.
        const deps = [events, liveItems, accounts, accountId, genreMap, deletedEventKeys, savedEpisodeEvents, ctxOf, tmdbAliasVersion()]
        const cached = baseDerivationRef.current
        if (cached && depsEqual(cached.deps, deps)) return cached.value
        const normalizeName = (s: string) => s.normalize('NFC').toLowerCase().replace(/[^a-z0-9]/g, '')

        const liveByAccountItem = new Map<string, ActivityItem>()
        for (const item of liveItems) {
            const ctx = ctxOf(item.accountId, item.sourceConnectionId)
            liveByAccountItem.set(`${ctx}:${item.uniqueItemId || item.itemId}`, item)
            if (item.episode !== undefined) {
                liveByAccountItem.set(
                    `${ctx}:${getEpisodeIdentity(item.itemId, item.uniqueItemId, item.season, item.episode, item.type)}`,
                    item
                )
            }
        }

        const seriesOverallTime = new Map<string, number>()
        for (const item of liveItems) {
            if (item.overallTimeWatched && item.overallTimeWatched > 0) {
                const key = `${ctxOf(item.accountId, item.sourceConnectionId)}:${item.itemId}`
                const existing = seriesOverallTime.get(key)
                if (!existing || item.overallTimeWatched > existing) {
                    seriesOverallTime.set(key, item.overallTimeWatched)
                }
            }
        }

        const accountMeta = new Map(accounts.map((a, i) => [
            a.id,
            {
                name: a.name || a.email?.split('@')[0] || a.id || 'Unknown',
                colorIndex: i % 10,
            }
        ]))

        // Tombstones apply again at render: an alias learned after the delete still hides the sibling.
        const filteredEvents = filterTombstonedEvents(accountId
            ? events.filter(e => e.accountId === accountId)
            : events, deletedEventKeys
        ).filter(hasSeriesEventIdentity)

        const dedupedEvents = Array.from(
            filteredEvents.reduce((map, e) => {
                const existing = map.get(e.id)
                if (!existing || e.detected_ts > existing.detected_ts) {
                    map.set(e.id, e)
                }
                return map
            }, new Map<string, typeof filteredEvents[0]>()).values()
        )

        const seriesDedupedEvents = collapseHistoryEvents(dedupedEvents, ctxOf)

        // The live overlay mirrors the library's CURRENT row, so only the newest event of
        // that exact play identity may borrow it (#85/F-01); historical rows keep their
        // own event progress.
        const newestLiveEventIds = newestLiveOverlayEventIds(seriesDedupedEvents, ctxOf)

        const eventEntries: HistoryEntry[] = seriesDedupedEvents.map(event => {
            const ctx = ctxOf(event.accountId, event.sourceConnectionId)
            const live = liveByAccountItem.get(
                `${ctx}:${getEpisodeIdentity(event.itemId, event.video_id, event.season, event.episode, event.type)}`
            )
            const liveOverlay = live !== undefined && newestLiveEventIds.has(event.id) && liveOverlayIdentityMatches(event, live)
                ? live
                : undefined
            const meta = accountMeta.get(event.accountId)
            const duration = event.duration || live?.duration || 0
            const watchedProgress = event.time_watched || 0
            const watched = event.time_watched_delta ?? event.time_watched ?? 0
            const progress = duration > 0
                ? Math.min(100, Math.max(0, (watchedProgress / duration) * 100))
                : Math.min(live?.progress ?? 0, 100)

            return {
                id: event.id,
                itemId: event.itemId,
                video_id: event.video_id,
                accountId: event.accountId,
                accountName: meta?.name ?? event.accountId,
                accountColorIndex: meta?.colorIndex ?? 0,
                name: event.name,
                type: event.type,
                poster: live?.poster || event.poster,
                season: event.season,
                episode: event.episode,
                timestamp: new Date(event.event_ts),
                firstWatched: live?.firstWatched,
                detectedAt: new Date(event.detected_ts),
                duration,
                watched,
                progress,
                overallTimeWatched: seriesOverallTime.get(`${ctx}:${event.itemId}`),
                timesWatched: live?.timesWatched ?? event.timesWatched,
                // Per-episode confirmation stamped on the event wins; the live overlay
                // (Stremio's own flaggedWatched marker, e.g. marked-watched movies) stays
                // the fallback when the event itself carries no flag.
                flaggedWatched: event.flaggedWatched ?? live?.flaggedWatched,
                isInProgress: live?.isInProgress ?? false,
                isFromEventLog: true,
                source: event.source || live?.source || 'stremio',
                sourceConnectionId: event.sourceConnectionId ?? live?.sourceConnectionId,
                backfill: event.backfill,
                genres: genreMap.get(event.itemId),
                liveProgress: liveOverlay?.progress,
                liveWatched: liveOverlay?.watched,
                liveEpisode: liveOverlay?.uniqueItemId,
            }
        })

        // Find live items not represented in the event log yet
        // (new items added since last diff, or first-run before any events)
        const eventItemIds = new Set(seriesDedupedEvents.map(e =>
            `${ctxOf(e.accountId, e.sourceConnectionId)}:${canonicalEpisodeIdentity(e.itemId, e.video_id, e.season, e.episode, e.type)}`
        ))
        const eventIdentityKeys = new Set<string>()
        for (const entry of seriesDedupedEvents) {
            const name = normalizeName(entry.name || '')
            const episode = entry.episode
            if (name && episode != null) {
                eventIdentityKeys.add(`${ctxOf(entry.accountId, entry.sourceConnectionId)}:${name}:${episode}`)
            }
        }
        const liveOnlyItems = (accountId
            ? liveItems.filter(i => i.accountId === accountId)
            : liveItems
        ).filter(item => {
            const ctx = ctxOf(item.accountId, item.sourceConnectionId)
            const deletedTs = aliasDeletedAt(deletedEventKeys, ctx, item.itemId, item.uniqueItemId, item.season, item.episode, item.type)
            if (deletedTs !== undefined && item.timestamp.getTime() <= deletedTs) {
                trace('useWatchHistory', 'liveonly.tombstoned', { accountId: item.accountId, itemId: item.itemId, source: item.source, name: item.name, ts: item.timestamp.getTime(), deletedTs })
                return false
            }
            if (item.source && item.source !== 'stremio') return true
            if (eventItemIds.has(
                `${ctx}:${canonicalEpisodeIdentity(item.itemId, item.uniqueItemId, item.season, item.episode, item.type)}`
            )) return false
            const name = normalizeName(item.name || '')
            if (name && item.episode != null && eventIdentityKeys.has(`${ctx}:${name}:${item.episode}`)) return false
            return true
        })

        const liveOnlyEntries: HistoryEntry[] = liveOnlyItems.map(item => ({
            id: item.id,
            itemId: item.itemId,
            video_id: item.uniqueItemId,
            accountId: item.accountId,
            accountName: item.accountName,
            accountColorIndex: item.accountColorIndex,
            name: item.name,
            type: item.type,
            poster: item.poster,
            season: item.season,
            episode: item.episode,
            timestamp: item.timestamp,
            firstWatched: item.firstWatched,
            duration: item.duration,
            watched: item.watched,
            progress: Math.min(item.progress, 100),
            overallTimeWatched: item.overallTimeWatched,
            timesWatched: item.timesWatched,
            flaggedWatched: item.flaggedWatched,
            isInProgress: item.isInProgress,
            isFromEventLog: false,
            source: item.source,
            sourceConnectionId: item.sourceConnectionId,
            liveProgress: item.progress,
            liveWatched: item.watched,
            liveEpisode: item.uniqueItemId,
            // Imported saved watch state (bitfield-aggregate series / flagged-only movie):
            // no real watch dates, so it is excluded from the dated chronology and time-based
            // stats exactly like the per-episode backfill recoveries it summarizes. The
            // timestamp stays the honest import/observation time for ordering and labels only.
            ...(item.importedSavedState ? {
                importedSavedState: true,
                backfill: true,
                savedEpisodes: summarizeSavedEpisodes(
                    savedEpisodeEvents.get(`${ctxOf(item.accountId, item.sourceConnectionId)}:${item.itemId}`) ?? [],
                ),
            } : {}),
        }))

        // Merge: event log entries first (richer history), then live-only
        const allEntries = [...eventEntries, ...liveOnlyEntries]
            .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())

        const dedupedList = dedupWatchEntries(allEntries, ctxOf)

        const bestNamesByItemId = new Map<string, { name: string; poster?: string }>()
        for (const entry of dedupedList) {
            if (isUnresolvedActivityName(entry.name)) continue
            const existing = bestNamesByItemId.get(entry.itemId)
            if (!existing || entry.name.length > existing.name.length) {
                bestNamesByItemId.set(entry.itemId, { name: entry.name, poster: entry.poster || undefined })
            }
        }

        const enrichedHistory = bestNamesByItemId.size > 0
            ? dedupedList.map(entry => {
                if (!isUnresolvedActivityName(entry.name)) return entry
                const best = bestNamesByItemId.get(entry.itemId)
                if (!best) return entry
                return { ...entry, name: best.name, poster: entry.poster || best.poster || entry.poster }
            })
            : dedupedList

        const railEvents = eventEntries
            .filter(entry => !entry.backfill)
            .map(entry => ({
                key: `${ctxOf(entry.accountId, entry.sourceConnectionId)}:${getEpisodeIdentity(entry.itemId, entry.video_id, entry.season, entry.episode, entry.type)}`,
                timestamp: entry.timestamp.getTime(),
                progress: entry.progress,
            }))

        const inProgress = reconcileRailProgress(
            (accountId
                ? liveItems.filter(i => i.accountId === accountId)
                : liveItems
            ).filter(i => i.isInProgress)
                .map(item => ({
                    ...item,
                    key: `${ctxOf(item.accountId, item.sourceConnectionId)}:${getEpisodeIdentity(item.itemId, item.uniqueItemId, item.season, item.episode, item.type)}`,
                })),
            railEvents
        ).map(({ key: _key, ...item }) => item)

        const value = {
            history: enrichedHistory,
            inProgress,
            hasEventLog: events.length > 0,
        }
        baseDerivationRef.current = { deps, value }
        return value
    }, [events, liveItems, accounts, accountId, genreMap, deletedEventKeys, savedEpisodeEvents, ctxOf])

    useEffect(() => {
        const { seen, needs: needsGenres, typeByItemId } = genreCrawlTargets(events, genreMap, genresEnabled)
        if (needsGenres.length === 0) return
        let cancelled = false
        let retryTimer: ReturnType<typeof setTimeout> | undefined
        let anyTransient = false
        const BATCH = 100
        const results = new Map<string, string[]>()
        const failed = new Set<string>()
        ;(async () => {
            if (import.meta.env?.DEV) console.log('[GenreResolve] processing', needsGenres.length, 'items,', seen.size, 'tt items found')
            for (let i = 0; i < needsGenres.length; i += BATCH) {
                if (cancelled) return
                const batch = needsGenres.slice(i, i + BATCH)
                await Promise.all(batch.map(async id => {
                    const { slim: meta, transient } = await fetchCinemetaSlimResult(id, typeByItemId.get(id))
                    if (meta?.genres?.length) results.set(id, meta.genres)
                    else if (transient) anyTransient = true
                    else failed.add(id)
                }))
            }
            if (!cancelled) {
                if (import.meta.env?.DEV) console.log('[GenreResolve] resolved', results.size, 'failed', failed.size, 'of', needsGenres.length)
                const merged = new Map(genreMap)
                let changed = false
                for (const [id, g] of results) { merged.set(id, g); changed = true }
                for (const id of failed) if (!merged.has(id)) { merged.set(id, []); changed = true }
                for (const id of merged.keys()) {
                    if (!seen.has(id)) { merged.delete(id); changed = true }
                }
                // Publishing an unchanged map re-runs this effect, which would spin while transient ids sit in backoff.
                if (changed) {
                    saveGenreCache(merged)
                    setGenreMap(merged)
                }
                if (anyTransient) retryTimer = setTimeout(() => setGenreRetryTick(t => t + 1), 30_000)
            }
        })()
        return () => {
            cancelled = true
            if (retryTimer) clearTimeout(retryTimer)
        }
    }, [events, genreMap, genresEnabled, genreRetryTick])

    const combinedHistoryCacheRef = useRef<{ deps: unknown[]; value: HistoryEntry[] } | null>(null)
    const combinedHistory = useMemo(() => {
        // Same interrupted-render cache as the base derivation: the merge below walks
        // every history + media row and restarts pay full price without it.
        const deps = [history, media.history, deletedEventKeys, ctxOf]
        const cached = combinedHistoryCacheRef.current
        if (cached && depsEqual(cached.deps, deps)) return cached.value
        const byId = new Map(history.map(entry => [entry.id, entry]))
        const notDeleted = (item: ActivityItem) => {
            const deletedAt = deletedEventKeys[`${ctxOf(item.accountId, item.sourceConnectionId)}:${getEpisodeIdentity(item.itemId, item.uniqueItemId, item.season, item.episode, item.type)}`]
            return deletedAt === undefined || item.timestamp.getTime() > deletedAt
        }
        const merged = resolveUnrecordedEpisodes(collapseImportedCopies(mergeMediaHistory(history.map(historyEntryToActivityItem), media.history.filter(notDeleted))))
        const entries: HistoryEntry[] = merged.map(item => {
            const existing = byId.get(item.id)
            return existing
                ? { ...existing, poster: item.poster || existing.poster, mediaSources: item.mediaSources, mediaTargets: item.mediaTargets }
                : {
                    ...item, video_id: item.uniqueItemId, isFromEventLog: false,
                }
        })
        entries.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
        combinedHistoryCacheRef.current = { deps, value: entries }
        return entries
    }, [history, media.history, deletedEventKeys, ctxOf])
    const combinedInProgress = useMemo(() => {
        const notDeleted = (item: ActivityItem) => {
            const deletedAt = deletedEventKeys[`${ctxOf(item.accountId, item.sourceConnectionId)}:${getEpisodeIdentity(item.itemId, item.uniqueItemId, item.season, item.episode, item.type)}`]
            return deletedAt === undefined || item.timestamp.getTime() > deletedAt
        }
        return orderContinueWatching(mergeMediaItems(inProgress, media.inProgress.filter(notDeleted)))
    }, [inProgress, media.inProgress, deletedEventKeys, ctxOf])
    return { history: combinedHistory, inProgress: combinedInProgress, hasEventLog, loading: loading || media.initialLoading, mediaSettling: media.mediaSettling, refreshMedia: media.refresh, mediaIssues: media.readIssues }
}
