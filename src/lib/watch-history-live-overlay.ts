import { getEpisodeIdentity } from '@/lib/activity-utils'
import { canonicalEpisodeIdentity } from '@/lib/activity-id-alias'

export interface LiveOverlayEvent {
    id: string
    accountId: string
    sourceConnectionId?: string
    itemId: string
    video_id?: string
    season?: number
    episode?: number
    type: string
    event_ts: number
    detected_ts: number
}

export interface LiveOverlayMatch {
    itemId: string
    uniqueItemId?: string
    season?: number
    episode?: number
    type: string
}

const newer = (a: LiveOverlayEvent, b: LiveOverlayEvent) =>
    a.event_ts > b.event_ts
    || (a.event_ts === b.event_ts && (a.detected_ts > b.detected_ts || (a.detected_ts === b.detected_ts && a.id > b.id)))

/**
 * Newest event id per scope and play identity (movies by itemId, series by episode
 * identity; tmdb: and tt plays of one title share it). #85's live-resume borrow is
 * limited to these rows so a historical play never wears the current resume.
 */
export function newestLiveOverlayEventIds<T extends LiveOverlayEvent>(
    events: readonly T[],
    ctxOf: (accountId: string, sourceConnectionId?: string) => string,
): Set<string> {
    const newest = new Map<string, T>()
    for (const event of events) {
        const key = `${ctxOf(event.accountId, event.sourceConnectionId)}:${canonicalEpisodeIdentity(event.itemId, event.video_id, event.season, event.episode, event.type)}`
        const current = newest.get(key)
        if (!current || newer(event, current)) newest.set(key, event)
    }
    return new Set([...newest.values()].map(event => event.id))
}

/** True when the live row the event matched mirrors its exact play identity: same episode for series, same title id for movies. */
export function liveOverlayIdentityMatches(event: LiveOverlayEvent, live: LiveOverlayMatch): boolean {
    return getEpisodeIdentity(event.itemId, event.video_id, event.season, event.episode, event.type)
        === getEpisodeIdentity(live.itemId, live.uniqueItemId, live.season, live.episode, live.type)
}
