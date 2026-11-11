// Single definition of watch hours for Activity, Metrics and Replay. Pure and import-free so
// the Metrics worker and node tests can load it directly.

const HOUR_MS = 3600000
// Per-row sanity bound (50,000 minutes); a larger credit is a corrupt counter, not a watch.
const MAX_ROW_MS = 50000 * 60000

export interface WatchHoursRow {
    itemId: string
    type: string
    timestamp: number
    /** ms watched in this session. */
    watched?: number
    /** Title or episode runtime in ms. */
    duration?: number
    /** 0-100. */
    progress?: number
    /** Cumulative per-viewer counter; each row is credited only its growth. */
    overallTimeWatched?: number
    /** Scope of the cumulative counter (account, platform, login, title). */
    counterKey?: string
    /** Media-server row: `watched` is a resume position, not elapsed time. A confirmed play counts its runtime. */
    mediaServer?: boolean
    mediaPlayed?: boolean
    /** Resume position in ms of an unplayed media-server row; credited, as estimated, up to the runtime. */
    mediaPositionMs?: number
    /** Identity of one media-server item, so a later confirmed play replaces its earlier resume credit. */
    mediaKey?: string
    /** Backfilled or imported saved state: no real watch date, never timed. */
    excluded?: boolean
}

export interface RuntimeIndex {
    /** Median known runtime per title, used to fill rows that carry none. */
    typical: ReadonlyMap<string, number>
    /** Longest known runtime per title, the bound for runtime x plays. */
    longest: ReadonlyMap<string, number>
}

export interface WatchHoursResult {
    rowMs: Float64Array
    rowEstimatedMs: Float64Array
    totalMs: number
    estimatedMs: number
}

const isSeriesType = (type: string) => type === 'series' || type === 'anime' || type === 'episode'

export function msToHours(ms: number): number {
    return Math.round(ms / HOUR_MS)
}

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b)
    const mid = sorted.length >> 1
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * Runtime per title from durations the rows already carry. `extra` lets a caller add
 * metadata it already holds in memory (never a fetch) for titles with no row duration.
 */
export function buildRuntimeIndex(
    rows: ReadonlyArray<Pick<WatchHoursRow, 'itemId' | 'duration'>>,
    extra?: (itemId: string) => number | undefined,
): RuntimeIndex {
    const durations = new Map<string, number[]>()
    for (const row of rows) {
        if (!row.itemId || !(row.duration && row.duration > 0)) continue
        const list = durations.get(row.itemId)
        if (list) list.push(row.duration)
        else durations.set(row.itemId, [row.duration])
    }
    const typical = new Map<string, number>()
    const longest = new Map<string, number>()
    for (const [itemId, list] of durations) {
        typical.set(itemId, median(list))
        longest.set(itemId, Math.max(...list))
    }
    if (extra) {
        const seen = new Set<string>()
        for (const row of rows) {
            if (!row.itemId || typical.has(row.itemId) || seen.has(row.itemId)) continue
            seen.add(row.itemId)
            const known = extra(row.itemId)
            if (known && known > 0) {
                typical.set(row.itemId, known)
                longest.set(row.itemId, known)
            }
        }
    }
    return { typical, longest }
}

/**
 * Hours per row, oldest first. Order of evidence: confirmed media-server play, an unplayed
 * media-server resume position up to the runtime (estimated; skipped once the same item is
 * played later), growth of the viewer's cumulative counter (series), session watch time,
 * runtime x progress, and last a title's typical runtime (counted as estimated). Unknown
 * runtime contributes 0, never a flat hour. Credit not backed by a platform counter can never exceed the title's longest
 * known runtime x plays; counter growth is the platform's own total and is never capped.
 */
export function computeWatchHours(rows: ReadonlyArray<WatchHoursRow>, runtimes: RuntimeIndex): WatchHoursResult {
    const count = rows.length
    const rowMs = new Float64Array(count)
    const rowEstimatedMs = new Float64Array(count)
    const fromCounter = new Uint8Array(count)
    const order = Array.from({ length: count }, (_, i) => i)
        .sort((a, b) => rows[a].timestamp - rows[b].timestamp || a - b)
    const seen = new Map<string, number>()
    const sums = new Map<string, number>()
    const plays = new Map<string, number>()
    const lastPlayed = new Map<string, number>()
    const resumed = new Set<string>()
    for (const row of rows) {
        if (row.excluded || !row.mediaServer || !row.mediaPlayed || !row.mediaKey) continue
        if (row.timestamp > (lastPlayed.get(row.mediaKey) ?? -Infinity)) lastPlayed.set(row.mediaKey, row.timestamp)
    }

    for (const index of order) {
        const row = rows[index]
        if (row.excluded) continue
        const progress = row.progress && row.progress > 0 ? Math.min(100, row.progress) : 0
        const typical = runtimes.typical.get(row.itemId) ?? 0
        let ms = 0
        let estimated = 0
        if (row.mediaServer) {
            if (row.mediaPlayed) {
                if (row.duration && row.duration > 0) ms = row.duration
                else ms = estimated = typical
            } else if (row.mediaPositionMs && row.mediaPositionMs > 0) {
                const superseded = row.mediaKey !== undefined
                    && (resumed.has(row.mediaKey) || (lastPlayed.get(row.mediaKey) ?? -Infinity) >= row.timestamp)
                const runtime = row.duration && row.duration > 0 ? row.duration : typical
                if (!superseded && runtime > 0) {
                    ms = estimated = Math.min(row.mediaPositionMs, runtime)
                    if (row.mediaKey !== undefined) resumed.add(row.mediaKey)
                }
            }
        } else if (isSeriesType(row.type) && row.overallTimeWatched && row.overallTimeWatched > 0) {
            const key = row.counterKey || row.itemId
            const prev = seen.get(key) || 0
            if (row.overallTimeWatched > prev) {
                ms = row.overallTimeWatched - prev
                seen.set(key, row.overallTimeWatched)
                fromCounter[index] = 1
            }
        } else if (row.watched && row.watched > 0) {
            ms = row.watched
        } else if (row.duration && row.duration > 0 && progress > 0) {
            ms = row.duration * (progress / 100)
        } else if (progress > 0) {
            ms = estimated = typical * (progress / 100)
        }
        if (!(ms > 0) || ms > MAX_ROW_MS) continue
        rowMs[index] = ms
        rowEstimatedMs[index] = estimated
        if (!fromCounter[index]) sums.set(row.itemId, (sums.get(row.itemId) || 0) + ms)
    }
    for (const row of rows) {
        if (!row.excluded) plays.set(row.itemId, (plays.get(row.itemId) || 0) + 1)
    }

    const factors = new Map<string, number>()
    for (const [itemId, sum] of sums) {
        const longest = runtimes.longest.get(itemId) ?? 0
        if (longest <= 0) continue
        const cap = longest * (plays.get(itemId) || 0)
        if (sum > cap) factors.set(itemId, cap / sum)
    }

    let totalMs = 0
    let estimatedMs = 0
    for (let i = 0; i < count; i++) {
        if (rowMs[i] === 0) continue
        const factor = fromCounter[i] ? undefined : factors.get(rows[i].itemId)
        if (factor !== undefined) {
            rowMs[i] *= factor
            rowEstimatedMs[i] *= factor
        }
        totalMs += rowMs[i]
        estimatedMs += rowEstimatedMs[i]
    }
    return { rowMs, rowEstimatedMs, totalMs, estimatedMs }
}

interface HoursItemLike {
    itemId: string
    type: string
    timestamp: Date | number | string
    watched?: number
    duration?: number
    progress?: number
    overallTimeWatched?: number
    flaggedWatched?: number
    mediaObservation?: { kind?: string; positionMs?: number }
    id?: string
    uniqueItemId?: string
    season?: number
    episode?: number
    backfill?: boolean
    importedSavedState?: boolean
}

/** Resume position of an unplayed media-server row; live sessions and played rows carry none. */
export function mediaResumePositionMs(
    item: { watched?: number; mediaObservation?: { kind?: string; positionMs?: number } },
): number {
    const observation = item.mediaObservation
    if (!observation || observation.kind !== 'resume') return 0
    const position = observation.positionMs ?? item.watched
    return typeof position === 'number' && position > 0 && Number.isFinite(position) ? position : 0
}

export function hoursRowFromItem(item: HoursItemLike, counterKey: string): WatchHoursRow {
    const time = item.timestamp instanceof Date ? item.timestamp.getTime() : new Date(item.timestamp).getTime()
    const observation = item.mediaObservation
    const played = !!observation && (observation.kind === 'played' || (item.flaggedWatched ?? 0) > 0)
    return {
        itemId: item.itemId,
        type: item.type,
        timestamp: Number.isFinite(time) ? time : 0,
        watched: item.watched,
        duration: item.duration,
        progress: item.progress,
        overallTimeWatched: item.overallTimeWatched,
        counterKey,
        mediaServer: !!observation,
        mediaPlayed: played,
        mediaPositionMs: played ? 0 : mediaResumePositionMs(item),
        mediaKey: observation ? item.id || item.uniqueItemId || `${item.itemId}:${item.season ?? ''}:${item.episode ?? ''}` : undefined,
        excluded: !!item.backfill || !!item.importedSavedState,
    }
}

// Stable fingerprint of the full runtime index, so a runtime change in any
// viewer's history is visible to identity checks without enumerating rows.
export function runtimeIndexFingerprint(index: RuntimeIndex): string {
    let hash = 2166136261
    const mix = (text: string) => {
        for (let i = 0; i < text.length; i++) {
            hash ^= text.charCodeAt(i)
            hash = Math.imul(hash, 16777619)
        }
    }
    for (const [itemId, typical] of index.typical) {
        mix(`${itemId}:${typical}:${index.longest.get(itemId) ?? ''};`)
    }
    for (const [itemId, longest] of index.longest) {
        if (!index.typical.has(itemId)) mix(`${itemId}::${longest};`)
    }
    return `${index.typical.size}-${hash >>> 0}`
}