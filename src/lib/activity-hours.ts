import { cumulativeWatchKey } from '@/lib/activity-utils'
import { computeWatchHours, hoursRowFromItem, type RuntimeIndex } from '@/lib/watch-hours'
import { localDayToken } from './local-time-token.ts'
import type { ActivityItem } from '@/types/activity'

const MONTH_KEY_RE = /^\d{4}-(0[1-9]|1[0-2])$/

export interface RollupMinutesSource {
    byMonth: Record<string, { count: number; minutes: number }>
}

/**
 * Hours for the Activity header. Runs the shared rule over the RAW watch rows (the same rows
 * and runtime source Metrics uses), restricted to the ids the current feed filters keep, so a
 * filtered or grouped feed never changes how counter growth or the runtime cap is credited.
 */
export function activityRowHours(
    raw: ReadonlyArray<ActivityItem>,
    runtimes: RuntimeIndex,
    canonical: ReadonlyMap<string, string | undefined> | undefined,
    include?: ReadonlySet<string>,
) {
    const rows = include ? raw.filter(item => include.has(item.id)) : raw
    const result = computeWatchHours(rows.map(item => hoursRowFromItem(item, cumulativeWatchKey(item, canonical))), runtimes)
    return { rows, ...result }
}

/**
 * Header totals for the visible feed. Credit is computed over every row in `scope` (viewer and
 * search) so a counter is never re-seeded by a time window, then summed over `visible` only.
 */
export function activityHeaderHours(
    raw: ReadonlyArray<ActivityItem>,
    runtimes: RuntimeIndex,
    canonical: ReadonlyMap<string, string | undefined> | undefined,
    now: number,
    scope: ReadonlySet<string> | undefined,
    visible: ReadonlySet<string>,
): { totalMs: number; todayMs: number; yesterdayMs: number } {
    const { rows, rowMs } = activityRowHours(raw, runtimes, canonical, scope)
    let totalMs = 0
    let todayMs = 0
    let yesterdayMs = 0
    // Calendar day boundaries, matching the feed's Today/Yesterday groups, so the
    // header hours never count a row the visible feed places under Yesterday.
    const nowDate = new Date(now)
    const startOfToday = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate()).getTime()
    const startOfYesterday = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate() - 1).getTime()
    rows.forEach((item, index) => {
        if (!visible.has(item.id)) return
        const ms = rowMs[index]
        totalMs += ms
        const at = new Date(item.timestamp).getTime()
        if (at >= startOfToday) todayMs += ms
        else if (at >= startOfYesterday) yesterdayMs += ms
    })
    return { totalMs, todayMs, yesterdayMs }
}

// The feed remounts on every route open and recomputes the same sums over the
// same rows. A last-call cache keyed on input identity (plus a minute bucket,
// which is finer than the day boundaries the result depends on) returns a
// bit-identical result while the inputs hold still. The local day/zone token
// rides the key like every other day-derived cache: today/yesterday partition
// by the runtime zone, and a zone switch within the same minute must not
// return the previous zone's sums.
interface HeaderHoursCache {
    raw: ReadonlyArray<ActivityItem>
    runtimes: RuntimeIndex
    canonical: ReadonlyMap<string, string | undefined> | undefined
    scope: ReadonlySet<string> | undefined
    visible: ReadonlySet<string>
    minute: number
    day: string
    result: { totalMs: number; todayMs: number; yesterdayMs: number }
}
let headerHoursCache: HeaderHoursCache | null = null

export function activityHeaderHoursCached(
    raw: ReadonlyArray<ActivityItem>,
    runtimes: RuntimeIndex,
    canonical: ReadonlyMap<string, string | undefined> | undefined,
    now: number,
    scope: ReadonlySet<string> | undefined,
    visible: ReadonlySet<string>,
): { totalMs: number; todayMs: number; yesterdayMs: number } {
    const minute = Math.floor(now / 60000)
    const day = localDayToken(now)
    const hit = headerHoursCache
    if (
        hit && hit.minute === minute && hit.day === day && hit.raw === raw && hit.runtimes === runtimes
        && hit.canonical === canonical && hit.scope === scope && hit.visible === visible
    ) return hit.result
    const result = activityHeaderHours(raw, runtimes, canonical, now, scope, visible)
    headerHoursCache = { raw, runtimes, canonical, scope, visible, minute, day, result }
    return result
}

/** Minutes folded out of the event log by the cap; Metrics adds these to its all-time hours. */
export function rollupMinutes(rollups: RollupMinutesSource | undefined, accountId: string): number {
    if (!rollups) return 0
    const prefix = accountId === 'all' ? '' : `${accountId}:`
    let minutes = 0
    for (const [key, entry] of Object.entries(rollups.byMonth)) {
        if (prefix && !key.startsWith(prefix)) continue
        if (!entry || typeof entry.count !== 'number' || typeof entry.minutes !== 'number') continue
        const lastColon = key.lastIndexOf(':')
        const firstColon = key.indexOf(':')
        if (lastColon <= 0 || firstColon === lastColon || !MONTH_KEY_RE.test(key.slice(lastColon + 1))) continue
        minutes += entry.minutes
    }
    return minutes
}
