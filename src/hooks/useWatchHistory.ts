import { useMemo, useState, useEffect, useDeferredValue } from 'react'
import { useWatchEventStore } from '@/store/watchEventStore'
import { useLibraryCache } from '@/store/libraryCache'
import { useAccountStore } from '@/store/accountStore'
import { ActivityItem } from '@/types/activity'
import { getLocalDayKey, getEpisodeIdentity, fetchCinemetaDetail } from '@/lib/activity-utils'
import { reconcileRailProgress } from '@/lib/rail-progress'
import { trace } from '@/lib/trace'

const GENRE_CACHE_STORAGE_KEY = 'aio-genre-map-v1'
let _genreCache: Map<string, string[]> | null = null

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
    backfill?: boolean     // recovered from the watched-bitfield (synthetic timestamp)
    genres?: string[]

    // Live overlay (only set when this item is also in current library)
    liveProgress?: number
    liveWatched?: number
    liveEpisode?: string
}

export interface WatchHistoryResult {
    history: HistoryEntry[]
    // Items currently in progress (timeOffset > 0, progress < 90) from live state
    inProgress: ActivityItem[]
    hasEventLog: boolean
    loading: boolean
}

export function useWatchHistory(accountId?: string): WatchHistoryResult {
    const rawEvents = useWatchEventStore(s => s.events)
    const rawLiveItems = useLibraryCache(s => s.items)
    const events = useDeferredValue(rawEvents)
    const liveItems = useDeferredValue(rawLiveItems)
    const loading = useLibraryCache(s => s.loading)
    const accounts = useAccountStore(s => s.accounts)
    const deletedEventKeys = useWatchEventStore(s => s.deletedEventKeys)
    const [genreMap, setGenreMap] = useState<Map<string, string[]>>(loadGenreCache)

    const eventsKey = `${events.length}:${events.length > 0 ? events[0].id : ''}`

    const { history, inProgress, hasEventLog } = useMemo(() => {
        const normalizeName = (s: string) => s.normalize('NFC').toLowerCase().replace(/[^a-z0-9]/g, '')

        const liveByAccountItem = new Map<string, ActivityItem>()
        for (const item of liveItems) {
            liveByAccountItem.set(`${item.accountId}:${item.uniqueItemId || item.itemId}`, item)
            if (item.episode !== undefined) {
                liveByAccountItem.set(
                    `${item.accountId}:${getEpisodeIdentity(item.itemId, item.uniqueItemId, item.season, item.episode, item.type)}`,
                    item
                )
            }
        }

        const seriesOverallTime = new Map<string, number>()
        for (const item of liveItems) {
            if (item.overallTimeWatched && item.overallTimeWatched > 0) {
                const key = `${item.accountId}:${item.itemId}`
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

        const filteredEvents = (accountId
            ? events.filter(e => e.accountId === accountId)
            : events
        ).filter(e => {
            const isSeries = e.type === 'series' || e.type === 'anime' || e.type === 'episode'
            if (!isSeries) return true
            if (e.episode != null) return true
            if (e.season != null) return true
            if (e.video_id !== e.itemId) return true
            return false
        })

        const dedupedEvents = Array.from(
            filteredEvents.reduce((map, e) => {
                const existing = map.get(e.id)
                if (!existing || e.detected_ts > existing.detected_ts) {
                    map.set(e.id, e)
                }
                return map
            }, new Map<string, typeof filteredEvents[0]>()).values()
        )

        const sessionEvents = Array.from(
            dedupedEvents.reduce((map, event) => {
                const episodeKey = getEpisodeIdentity(event.itemId, event.video_id, event.season, event.episode, event.type)
                const key = `${event.accountId}:${episodeKey}:${getLocalDayKey(event.event_ts)}`
                const existing = map.get(key)
                if (
                    !existing ||
                    event.event_ts > existing.event_ts ||
                    (event.event_ts === existing.event_ts && event.detected_ts > existing.detected_ts)
                ) {
                    map.set(key, event)
                }
                return map
            }, new Map<string, (typeof dedupedEvents)[number]>()).values()
        )

        const EPISODE_DEDUP_WINDOW_MS = 172800000
        type SessionEvent = (typeof sessionEvents)[number]

        const seriesGroups = new Map<string, SessionEvent[]>()
        const nonSeriesEvents: SessionEvent[] = []
        for (const event of sessionEvents) {
            const isSeries = event.type === 'series' || event.type === 'anime' || event.type === 'episode'
            if (!isSeries) {
                nonSeriesEvents.push(event)
                continue
            }
            const episodeKey = getEpisodeIdentity(event.itemId, event.video_id, event.season, event.episode, event.type)
            const key = `${event.accountId}:${episodeKey}`
            const arr = seriesGroups.get(key)
            if (arr) arr.push(event)
            else seriesGroups.set(key, [event])
        }

        const seriesDeduped: SessionEvent[] = []
        for (const arr of seriesGroups.values()) {
            arr.sort((a, b) => a.event_ts - b.event_ts || a.detected_ts - b.detected_ts)
            let kept: SessionEvent | null = null
            for (const event of arr) {
                if (kept === null) {
                    kept = event
                } else if (event.event_ts - kept.event_ts <= EPISODE_DEDUP_WINDOW_MS) {
                    if (
                        event.event_ts > kept.event_ts ||
                        (event.event_ts === kept.event_ts && event.detected_ts > kept.detected_ts)
                    ) {
                        kept = event
                    }
                } else {
                    seriesDeduped.push(kept)
                    kept = event
                }
            }
            if (kept) seriesDeduped.push(kept)
        }

        const seriesDedupedEvents = [...nonSeriesEvents, ...seriesDeduped]

        const eventEntries: HistoryEntry[] = seriesDedupedEvents.map(event => {
            const live = liveByAccountItem.get(
                `${event.accountId}:${getEpisodeIdentity(event.itemId, event.video_id, event.season, event.episode, event.type)}`
            )
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
                overallTimeWatched: seriesOverallTime.get(`${event.accountId}:${event.itemId}`),
                timesWatched: live?.timesWatched ?? event.timesWatched,
                flaggedWatched: event.flaggedWatched,
                isInProgress: live?.isInProgress ?? false,
                isFromEventLog: true,
                source: event.source || live?.source || 'stremio',
                backfill: event.backfill,
                genres: genreMap.get(event.itemId),
                liveProgress: live?.progress,
                liveWatched: live?.watched,
                liveEpisode: live?.uniqueItemId,
            }
        })

        // Find live items not represented in the event log yet
        // (new items added since last diff, or first-run before any events)
        const eventItemIds = new Set(seriesDedupedEvents.map(e =>
            `${e.accountId}:${getEpisodeIdentity(e.itemId, e.video_id, e.season, e.episode, e.type)}`
        ))
        const eventIdentityKeys = new Set<string>()
        for (const entry of seriesDedupedEvents) {
            const name = normalizeName(entry.name || '')
            const episode = entry.episode
            if (name && episode != null) {
                eventIdentityKeys.add(`${entry.accountId}:${name}:${episode}`)
            }
        }
        const liveOnlyItems = (accountId
            ? liveItems.filter(i => i.accountId === accountId)
            : liveItems
        ).filter(item => {
            const deletedTs = deletedEventKeys[`${item.accountId}:${getEpisodeIdentity(item.itemId, item.uniqueItemId, item.season, item.episode, item.type)}`]
            if (deletedTs !== undefined && item.timestamp.getTime() <= deletedTs) {
                trace('useWatchHistory', 'liveonly.tombstoned', { accountId: item.accountId, itemId: item.itemId, source: item.source, name: item.name, ts: item.timestamp.getTime(), deletedTs })
                return false
            }
            if (item.source && item.source !== 'stremio') return true
            if (eventItemIds.has(
                `${item.accountId}:${getEpisodeIdentity(item.itemId, item.uniqueItemId, item.season, item.episode, item.type)}`
            )) return false
            const name = normalizeName(item.name || '')
            if (name && item.episode != null && eventIdentityKeys.has(`${item.accountId}:${name}:${item.episode}`)) return false
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
            isInProgress: item.isInProgress,
            isFromEventLog: false,
            source: item.source,
            liveProgress: item.progress,
            liveWatched: item.watched,
            liveEpisode: item.uniqueItemId,
        }))

        // Merge: event log entries first (richer history), then live-only
        const allEntries = [...eventEntries, ...liveOnlyEntries]
            .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())

        const finalDedup = new Map<string, HistoryEntry>()
        for (const entry of allEntries) {
            const normalizedName = normalizeName(entry.name || '')
            const isSeries = entry.type === 'series' || entry.type === 'anime' || entry.type === 'episode'
            const episodeKey = isSeries && entry.episode != null
                ? `${entry.accountId}:${normalizedName}:${entry.season || 1}:${entry.episode}`
                : `${entry.accountId}:${normalizedName}`

            const existing = finalDedup.get(episodeKey)
            if (!existing) {
                finalDedup.set(episodeKey, entry)
            } else {
                const existingScore = (existing.progress || 0) + (existing.poster ? 50 : 0) + (existing.duration ? 50 : 0)
                const newScore = (entry.progress || 0) + (entry.poster ? 50 : 0) + (entry.duration ? 50 : 0)
                if (newScore > existingScore) {
                    finalDedup.set(episodeKey, entry)
                }
            }
        }
        const dedupedList = Array.from(finalDedup.values())

        const BAD_NAME_RE = /^(tt\d{7,}|kitsu:\d+|mv:\d+|show:\d+|tmdb:\d+|mal:\d+|anilist:\d+|anidb:\d+|tvdb:\d+)$/i
        const isBadName = (n: string) => !n || n === 'Unknown Title' || BAD_NAME_RE.test(n)

        const bestNamesByItemId = new Map<string, { name: string; poster?: string }>()
        for (const entry of dedupedList) {
            if (isBadName((entry.name || '').trim())) continue
            const existing = bestNamesByItemId.get(entry.itemId)
            if (!existing || entry.name.length > existing.name.length) {
                bestNamesByItemId.set(entry.itemId, { name: entry.name, poster: entry.poster || undefined })
            }
        }

        const enrichedHistory = bestNamesByItemId.size > 0
            ? dedupedList.map(entry => {
                if (!isBadName((entry.name || '').trim())) return entry
                const best = bestNamesByItemId.get(entry.itemId)
                if (!best) return entry
                return { ...entry, name: best.name, poster: entry.poster || best.poster || entry.poster }
            })
            : dedupedList

        const railEvents = eventEntries
            .filter(entry => !entry.backfill)
            .map(entry => ({
                key: `${entry.accountId}:${getEpisodeIdentity(entry.itemId, entry.video_id, entry.season, entry.episode, entry.type)}`,
                timestamp: entry.timestamp.getTime(),
                progress: entry.progress,
            }))

        const inProgress = reconcileRailProgress(
            (accountId
                ? liveItems.filter(i => i.accountId === accountId)
                : liveItems
            ).filter(i => i.isInProgress)
                .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
                .map(item => ({
                    ...item,
                    key: `${item.accountId}:${getEpisodeIdentity(item.itemId, item.uniqueItemId, item.season, item.episode, item.type)}`,
                })),
            railEvents
        ).map(({ key: _key, ...item }) => item)

        return {
            history: enrichedHistory,
            inProgress,
            hasEventLog: events.length > 0,
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [eventsKey, liveItems, accounts, accountId, genreMap, deletedEventKeys])

    useEffect(() => {
        if (!events || events.length === 0) return
        const seen = new Set<string>()
        const typeByItemId = new Map<string, string | undefined>()
        for (const e of events) {
            const id = e.itemId
            if (id && id.startsWith('tt') && !seen.has(id)) {
                seen.add(id)
                typeByItemId.set(id, e.type)
            }
        }
        const needsGenres = [...seen].filter(id => !genreMap.has(id))
        if (needsGenres.length === 0) return
        let cancelled = false
        const BATCH = 5
        const results = new Map<string, string[]>()
        const failed = new Set<string>()
        ;(async () => {
            if (import.meta.env?.DEV) console.log('[GenreResolve] processing', needsGenres.length, 'items,', seen.size, 'tt items found')
            for (let i = 0; i < needsGenres.length; i += BATCH) {
                if (cancelled) return
                const batch = needsGenres.slice(i, i + BATCH)
                await Promise.all(batch.map(async id => {
                    const meta = await fetchCinemetaDetail(id, typeByItemId.get(id))
                    if (meta && typeof meta.genre === 'string' && meta.genre.trim()) {
                        const genres = meta.genre.split(',').map(g => g.trim()).filter(Boolean)
                        if (genres.length > 0) results.set(id, genres)
                        else failed.add(id)
                    } else {
                        failed.add(id)
                    }
                }))
            }
            if (!cancelled) {
                if (import.meta.env?.DEV) console.log('[GenreResolve] resolved', results.size, 'failed', failed.size, 'of', needsGenres.length)
                const merged = new Map(genreMap)
                for (const [id, g] of results) merged.set(id, g)
                for (const id of failed) if (!merged.has(id)) merged.set(id, [])
                for (const id of merged.keys()) {
                    if (!seen.has(id)) merged.delete(id)
                }
                saveGenreCache(merged)
                setGenreMap(merged)
            }
        })()
        return () => { cancelled = true }
    }, [events, genreMap])

    return { history, inProgress, hasEventLog, loading }
}
