import { getLocalDayKey } from '@/lib/activity-utils'
import { canonicalEpisodeIdentity } from '@/lib/activity-id-alias'

export interface CollapsibleEvent {
    id?: string
    source?: string
    overall_time_watched?: number
    accountId: string
    sourceConnectionId?: string
    itemId: string
    video_id?: string
    season?: number
    episode?: number
    type: string
    event_ts: number
    detected_ts: number
    time_watched?: number
    time_watched_delta?: number
    duration?: number
}

const EPISODE_DEDUP_WINDOW_MS = 172800000
// Copies of an episode re-recorded without any watching chain onto the first copy while each
// follows the previous within this window.
const REPEAT_CHAIN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

const isExternal = (e: CollapsibleEvent) => !!e.id?.startsWith('ext:') || (e.source !== undefined && e.source !== 'stremio')

// Positive evidence only: a server row whose accumulated watch time did not move, or a client
// row that recorded zero watch-time growth, with the same measures as the copy before it.
// External (Nuvio etc.) rows and anything without that evidence are kept.
const isRepeat = (event: CollapsibleEvent, previous: CollapsibleEvent) => {
    if (isExternal(event) || isExternal(previous)) return false
    if ((event.time_watched || 0) !== (previous.time_watched || 0) || (event.duration || 0) !== (previous.duration || 0)) return false
    if (event.time_watched_delta === 0) return true
    return !!event.id?.startsWith('evt_') && event.overall_time_watched !== undefined
        && event.overall_time_watched === previous.overall_time_watched
}

const newer = (a: CollapsibleEvent, b: CollapsibleEvent) =>
    a.event_ts > b.event_ts || (a.event_ts === b.event_ts && a.detected_ts > b.detected_ts)

/**
 * Display-only collapse of the event log: one row per play per local day, and for series one
 * row per episode within a two-day window, with proven repeats kept at the first copy.
 * Stored events are never touched. Plays recorded under a tmdb: id and its IMDb id compare
 * as the same title.
 */
export function collapseHistoryEvents<T extends CollapsibleEvent>(events: T[], ctxOf: (accountId: string, sourceConnectionId?: string) => string): T[] {
    const sessions = new Map<string, T>()
    for (const event of events) {
        const episodeKey = canonicalEpisodeIdentity(event.itemId, event.video_id, event.season, event.episode, event.type)
        const key = `${ctxOf(event.accountId, event.sourceConnectionId)}:${episodeKey}:${getLocalDayKey(event.event_ts)}`
        const existing = sessions.get(key)
        if (!existing || newer(event, existing)) sessions.set(key, event)
    }

    const seriesGroups = new Map<string, T[]>()
    const nonSeriesEvents: T[] = []
    for (const event of sessions.values()) {
        const isSeries = event.type === 'series' || event.type === 'anime' || event.type === 'episode'
        if (!isSeries) {
            nonSeriesEvents.push(event)
            continue
        }
        const episodeKey = canonicalEpisodeIdentity(event.itemId, event.video_id, event.season, event.episode, event.type)
        const key = `${ctxOf(event.accountId, event.sourceConnectionId)}:${episodeKey}`
        const arr = seriesGroups.get(key)
        if (arr) arr.push(event)
        else seriesGroups.set(key, [event])
    }

    const seriesDeduped: T[] = []
    for (const arr of seriesGroups.values()) {
        arr.sort((a, b) => a.event_ts - b.event_ts || a.detected_ts - b.detected_ts)
        let kept: T | null = null
        let previous: T | null = null
        for (const event of arr) {
            if (kept === null || previous === null) {
                kept = event
            } else if (isRepeat(event, previous) && event.event_ts - previous.event_ts <= REPEAT_CHAIN_WINDOW_MS) {
                // Keep the first copy's date: a repeat is not a new watch.
            } else if (event.event_ts - kept.event_ts <= EPISODE_DEDUP_WINDOW_MS) {
                if (newer(event, kept)) kept = event
            } else {
                seriesDeduped.push(kept)
                kept = event
            }
            previous = event
        }
        if (kept) seriesDeduped.push(kept)
    }

    return [...nonSeriesEvents, ...seriesDeduped]
}
