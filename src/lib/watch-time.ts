// Stremio sends 0001-01-01T00:00:00Z (.NET DateTime.MinValue) for unknown watch dates; pre-1995 means undated.

import type { LibraryItem } from '../types/activity.ts'

export const MIN_PLAUSIBLE_WATCH_MS = Date.UTC(1995, 0, 1)

const DISMISSAL_MTIME_LEAD_MS = 10 * 60 * 1000
const DISMISSAL_CLOCK_SLACK_MS = 1000

export interface ResumeDismissalPrior {
    mtime?: number
    video_id?: string
    timeOffset?: number
    overallTimeWatched?: number
    timeWatched?: number
}

/** Plausible-watch-time guard: a real watch date is finite and on/after the 1995 floor. */
export function isPlausibleWatchMs(time: unknown): boolean {
    return typeof time === 'number' && Number.isFinite(time) && time >= MIN_PLAUSIBLE_WATCH_MS
}

/** String variant for raw provider fields (`state.lastWatched`, `_mtime`). */
export function isPlausibleWatchDateString(value: unknown): boolean {
    if (typeof value !== 'string' || value.trim() === '') return false
    return isPlausibleWatchMs(new Date(value).getTime())
}

/** True when a watch row carries a real watch date; undated rows join no dated stat. */
export function isDatedWatchTimestamp(timestamp: unknown): boolean {
    const time = timestamp instanceof Date ? timestamp.getTime() : new Date(timestamp as string | number).getTime()
    return isPlausibleWatchMs(time)
}

/** Event merge/load rule: implausible timestamps (placeholders, JSON null round-trips) become NaN. */
export function plausibleWatchEventTs(ts: unknown): number {
    return isPlausibleWatchMs(ts) ? (ts as number) : NaN
}

/**
 * Stremio's Continue Watching dismiss zeroes the resume offset and bumps _mtime while
 * lastWatched stays put. Without a prior snapshot the signal is _mtime running well past
 * lastWatched at a zero offset; with one, a resume offset dropping to zero with no new
 * watch time and no lastWatched advance past the prior scan.
 */
export function isResumeDismissal(item: LibraryItem, prior?: ResumeDismissalPrior): boolean {
    const s = item.state
    if ((s?.timeOffset ?? 0) > 0) return false
    const lwRaw = s?.lastWatched ? new Date(s.lastWatched).getTime() : NaN
    const lw = Number.isFinite(lwRaw) && lwRaw >= MIN_PLAUSIBLE_WATCH_MS ? lwRaw : undefined

    if (prior) {
        if (prior.video_id && s?.video_id && prior.video_id !== s.video_id) return false
        const overallDelta = (s?.overallTimeWatched ?? 0) - (prior.overallTimeWatched ?? 0)
        const watchedDelta = (s?.timeWatched ?? 0) - (prior.timeWatched ?? 0)
        if (overallDelta > 0 || watchedDelta > 0) return false
        if ((prior.timeOffset ?? 0) > 0 && prior.mtime) {
            return lw === undefined || lw <= prior.mtime + DISMISSAL_CLOCK_SLACK_MS
        }
    }

    if (lw === undefined || !item._mtime) return false
    const mt = new Date(item._mtime).getTime()
    return Number.isFinite(mt) && mt - lw > DISMISSAL_MTIME_LEAD_MS
}

/**
 * Watch date of a library row: the newest plausible candidate among state.lastWatched and
 * _mtime (when the mtime is not a dismiss artifact), future-clamped to now. When candidates
 * exist but all are placeholders, the row is undated (invalid Date). Rows with no candidate
 * at all keep the observation-time fallback.
 */
export function getWatchTimestamp(item: LibraryItem): Date {
    const now = Date.now()
    const futureSlack = now + 5 * 60 * 1000
    const candidates: number[] = []
    if (item.state?.lastWatched) {
        candidates.push(new Date(item.state.lastWatched).getTime())
    }
    if (item._mtime && !isResumeDismissal(item)) {
        candidates.push(new Date(item._mtime).getTime())
    }

    // This protects against Stremio sending bad timestamps (e.g. 12h future)
    // which would otherwise be clamped to "now" and appear as "Just now"
    const validTimes = candidates.filter(t => isPlausibleWatchMs(t) && t <= futureSlack)
    if (
        candidates.length > 0 && validTimes.length === 0
        && !candidates.some(t => Number.isFinite(t) && t > futureSlack)
    ) return new Date(NaN)

    const maxTime = validTimes.length > 0 ? Math.max(...validTimes) : now

    return new Date(Math.min(maxTime, now))
}

/**
 * Cache hydration rule for a persisted watch timestamp: the future clamp is unchanged and
 * anything pre-1995 or non-finite (placeholders, JSON null round-trips of invalid Dates)
 * rehydrates as undated instead of surfacing as an ancient or epoch date.
 */
export function normalizeWatchTimestamp(value: unknown, now: number): Date {
    const time = value instanceof Date ? value.getTime() : new Date(value as string | number).getTime()
    if (time > now) return new Date(now)
    return isPlausibleWatchMs(time) ? new Date(time) : new Date(NaN)
}
