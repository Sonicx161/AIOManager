import type { WatchEvent } from '@/types/activity'

// The global cap floats with account count so large installs (100+ accounts) are not
// strangled by a fixed budget sized for households; it derives from the events themselves.
export const MIN_EVENTS_GLOBAL = 25_000
export const EVENTS_PER_ACCOUNT_GLOBAL = 500
export const MAX_PER_ACCOUNT_GUARANTEE = 2_000

function globalCapFor(accountCount: number): number {
    return Math.max(MIN_EVENTS_GLOBAL, accountCount * EVENTS_PER_ACCOUNT_GLOBAL)
}

// Per-account share is a guaranteed floor reserved against eviction by heavy accounts,
// never a ceiling: an account may use any budget other accounts leave unclaimed.
function guaranteedShare(cap: number, accountCount: number): number {
    return Math.min(MAX_PER_ACCOUNT_GUARANTEE, Math.max(EVENTS_PER_ACCOUNT_GLOBAL, Math.floor(cap / accountCount)))
}

export function capWatchEvents(events: WatchEvent[]): WatchEvent[] {
    // The cap floats at >= MIN_EVENTS_GLOBAL for any account count, so a log at or
    // under the floor can never exceed it: skip the accountId scan entirely.
    if (events.length <= MIN_EVENTS_GLOBAL) return events
    const accountIds = new Set(events.map(e => e.accountId))
    const accountCount = accountIds.size
    const cap = globalCapFor(accountCount)
    if (events.length <= cap) return events

    const sorted = [...events].sort((a, b) => b.event_ts - a.event_ts)
    const share = guaranteedShare(cap, accountCount)

    // Walk newest-first giving every account its guaranteed share first; leftover
    // budget then flows to whoever has more history, so a quiet account's events can
    // never be crowded out and a solo binger can use the entire budget.
    const perAccountSeen = new Map<string, number>()
    const kept: WatchEvent[] = []
    let reserved = 0
    for (const e of sorted) {
        const seen = perAccountSeen.get(e.accountId) ?? 0
        if (seen < share) {
            perAccountSeen.set(e.accountId, seen + 1)
            kept.push(e)
            reserved++
        }
        if (reserved >= Math.min(cap, share * accountCount)) break
    }
    if (kept.length < cap) {
        const keptIds = new Set(kept.map(e => e.id))
        for (const e of sorted) {
            if (kept.length >= cap) break
            if (keptIds.has(e.id)) continue
            kept.push(e)
        }
    }

    return kept
}

const SEASON_EPISODE_SUFFIX = /:\d+:\d+$/

// Leftover series event from an older build: no season, episode 0/missing, video_id equal to
// the item id and no playback of any kind. It is a saved-state shadow, never a watch.
export function isBareSeriesEvent(e: Pick<WatchEvent, 'type' | 'itemId' | 'video_id' | 'season' | 'episode' | 'time_watched' | 'time_watched_delta' | 'duration' | 'backfill' | 'flaggedWatched'>): boolean {
    if (e.type !== 'series' && e.type !== 'anime' && e.type !== 'episode') return false
    if (e.backfill) return false
    if (e.season != null) return false
    if (e.episode != null && e.episode > 0) return false
    if (!e.video_id || e.video_id !== e.itemId || SEASON_EPISODE_SUFFIX.test(e.video_id)) return false
    if ((e.time_watched ?? 0) > 0 || (e.time_watched_delta ?? 0) > 0 || (e.duration ?? 0) > 0) return false
    if ((e.flaggedWatched ?? 0) > 0) return false
    return true
}

// Shared read-time identity gate for the store loaders and the history derivation: non-series
// events always pass; a series event needs a season/episode or a video_id beyond the bare item id.
export function hasSeriesEventIdentity(e: Parameters<typeof isBareSeriesEvent>[0]): boolean {
    const isSeries = e.type === 'series' || e.type === 'anime' || e.type === 'episode'
    if (!isSeries) return true
    if (isBareSeriesEvent(e)) return false
    if (e.episode != null) return true
    if (e.season != null) return true
    if (e.video_id !== e.itemId) return true
    return false
}
