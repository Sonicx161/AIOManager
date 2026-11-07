// Presentation semantics for imported saved watch state (Jellyfin/AIOM → Stremio imports).
//
// The importer writes watched episodes as Stremio's saved bitfield (`state.watched` +
// `state.timesWatched`) with no resume anchor and no watch dates: `lastWatched` is empty,
// `video_id` is empty and no time is accounted. Those rows are real, verifiable watch state
// (the bitfield decodes against Cinemeta's episode list with a checksum), but they carry
// neither a watch date nor a playback position, so the UI must never present them as a
// dated watch, a percent, or a completed show.

import type { LibraryItem, SavedEpisodesSummary, SavedSeasonSummary, SavedEpisodeRange } from '../types/activity.ts'

const SERIES_TYPES = new Set(['series', 'anime', 'episode'])

export function isSeriesType(type: string | undefined): boolean {
    return SERIES_TYPES.has(type ?? '')
}

/**
 * A series row that only carries the imported saved-bitfield aggregate: no episode anchor
 * (video_id), no resume (timeOffset), no accounted time, no watch date, but a positive
 * saved-episode count (Stremio's timesWatched on aggregates counts saved episodes).
 */
export function isSavedOnlySeriesRow(item: LibraryItem): boolean {
    if (!isSeriesType(item.type)) return false
    const s = item.state
    if (!s) return false
    if (s.video_id && s.video_id.trim() !== '') return false
    if ((s.timeOffset ?? 0) > 0) return false
    if ((s.timeWatched ?? 0) > 0 || (s.overallTimeWatched ?? 0) > 0) return false
    if (typeof s.lastWatched === 'string' && s.lastWatched.trim() !== '') return false
    return (s.timesWatched ?? 0) > 0 || (s.flaggedWatched ?? 0) > 0
}

/**
 * A movie row whose only watch evidence is Stremio's watched flag: no counts, no resume,
 * no accounted time, no watch date. The flag is a positive watched marker, so the movie is
 * presented as watched — but never as a dated or timed watch.
 */
export function isFlaggedOnlyMovieRow(item: LibraryItem): boolean {
    if (isSeriesType(item.type)) return false
    const s = item.state
    if (!s) return false
    if ((s.flaggedWatched ?? 0) <= 0) return false
    if ((s.timesWatched ?? 0) > 0) return false
    if ((s.timeOffset ?? 0) > 0) return false
    if ((s.timeWatched ?? 0) > 0 || (s.overallTimeWatched ?? 0) > 0) return false
    if (typeof s.lastWatched === 'string' && s.lastWatched.trim() !== '') return false
    return true
}

/**
 * Rows that hold saved watch state without any date or time evidence. The diff seed path
 * skips these (a seed would fabricate a dated watch event from the import mtime); they stay
 * live-only rows presented through the imported-saved surfaces below.
 */
export function isDatelessSavedWatchState(item: LibraryItem): boolean {
    return isSavedOnlySeriesRow(item) || isFlaggedOnlyMovieRow(item)
}

/**
 * Compress verified per-episode recoveries (backfill events decoded from the watched
 * bitfield) into a stable summary: total count plus per-season episode ranges. Input order
 * does not matter; episodes without a usable season/episode pair are ignored.
 */
export function summarizeSavedEpisodes(episodes: Array<{ season?: number; episode?: number }>): SavedEpisodesSummary | undefined {
    const bySeason = new Map<number, Set<number>>()
    let episodeCount = 0
    for (const ep of episodes) {
        if (ep?.season == null || ep?.episode == null) continue
        if (!Number.isFinite(ep.season) || !Number.isFinite(ep.episode)) continue
        const set = bySeason.get(ep.season) ?? new Set<number>()
        if (set.size === 0) bySeason.set(ep.season, set)
        if (!set.has(ep.episode)) {
            set.add(ep.episode)
            episodeCount++
        }
    }
    if (episodeCount === 0) return undefined
    const seasons: SavedSeasonSummary[] = [...bySeason.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([season, set]) => ({ season, count: set.size, ranges: compressRanges([...set].sort((a, b) => a - b)) }))
    return { episodeCount, seasons }
}

function compressRanges(sortedEpisodes: number[]): SavedEpisodeRange[] {
    const ranges: SavedEpisodeRange[] = []
    let start = sortedEpisodes[0]
    let prev = sortedEpisodes[0]
    for (let i = 1; i <= sortedEpisodes.length; i++) {
        const current = sortedEpisodes[i]
        if (current === prev + 1) {
            prev = current
            continue
        }
        ranges.push({ start, end: prev })
        start = current
        prev = current
    }
    return ranges
}

/** Compact S/E labels for a saved summary: `S3 E1–E13`, `S5 E18–E22`, `S6 E1`. */
export function formatSavedEpisodeRanges(summary: SavedEpisodesSummary | undefined): string[] {
    if (!summary) return []
    const labels: string[] = []
    for (const season of summary.seasons) {
        for (const range of season.ranges) {
            labels.push(range.start === range.end
                ? `S${season.season} E${range.start}`
                : `S${season.season} E${range.start}–E${range.end}`)
        }
    }
    return labels
}

/** Structural badge input so pure tests can pass partial rows. */
export interface WatchBadgeShape {
    type?: string
    progress?: number
    timesWatched?: number
    flaggedWatched?: number
    overallTimeWatched?: number
    importedSavedState?: boolean
    /** Credited watch time (ms); for event rows this is historical credit, not a resume. */
    watched?: number
    /** Known runtime (ms); turns a resume position into a percent. */
    duration?: number
    /**
     * Authoritative current resume position (ms); present only when the current library
     * state supplied one. When present it, not `watched`, is the resume evidence: a
     * near-zero supplied resume is a reset artifact and must fall through to completion
     * instead of borrowing historical credit (Sol R2-10).
     */
    liveResume?: number
}

// 95% or more is a finished watch; below that the percent never rounds up to a false 95.
const COMPLETED_PCT = 95
const badgeFromPct = (pct: number): number => (pct >= COMPLETED_PCT ? 100 : Math.min(COMPLETED_PCT - 1, Math.round(pct)))

// Mirrors the row model's own in-progress floor (transformLibraryItemToActivityItem):
// a resume below it is a reset artifact (Stremio writes a ~1 ms offset on a completed
// rewatch), not a real partial watch, so authoritative completion wins over it.
const NEAR_ZERO_RESUME_PCT = 0.5

/**
 * Watch badge resolution. Saved-only imported series never resolve a percent or a completed
 * mark: with no duration and no resume there is nothing measurable to report. A real resume
 * progress still wins when present, and a positive watched flag (flaggedWatched, i.e. a
 * marked-watched movie) legitimately resolves to 100. A near-zero resume (below the row
 * model's in-progress floor) never defeats authoritative completion evidence.
 */
export function resolveWatchBadgePct(item: WatchBadgeShape): number | undefined {
    const progress = item.progress ?? 0
    if (progress >= NEAR_ZERO_RESUME_PCT) return badgeFromPct(progress)
    if (item.importedSavedState && isSeriesType(item.type)) return undefined
    const runtime = item.duration ?? 0
    if (item.liveResume !== undefined) {
        // The current state supplied a resume: it is the only resume evidence. A real
        // partial rewatch keeps its percent; a near-zero reset falls through so
        // completion evidence wins without consulting historical credit (#85, Sol R2-10).
        if (item.liveResume > 0 && runtime > 0) {
            const resumePct = Math.min(100, (item.liveResume / runtime) * 100)
            if (resumePct >= NEAR_ZERO_RESUME_PCT) return badgeFromPct(resumePct)
        }
    } else {
        // No current resume: credited time may still describe a genuine partial watch.
        const resume = item.watched ?? 0
        if (resume > 0 && runtime > 0) {
            const resumePct = Math.min(100, (resume / runtime) * 100)
            if (resumePct >= NEAR_ZERO_RESUME_PCT) return badgeFromPct(resumePct)
        }
    }
    if ((item.timesWatched ?? 0) > 0 || (item.flaggedWatched ?? 0) > 0) return 100
    if (!isSeriesType(item.type) && (item.overallTimeWatched ?? 0) > 0) return 100
    return 0
}
