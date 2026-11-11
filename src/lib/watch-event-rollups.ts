import type { WatchEvent } from '@/types/activity'
import { capWatchEvents } from './watch-event-cap.ts'

// All-time aggregates for events evicted by the cap. An evicted event exists ONLY here,
// so all-time stats sum events + rollups without double counting. Remote sync merge takes
// the max per key because both devices derived aggregates from overlapping event sets.
export interface EventRollups {
    byMonth: Record<string, { count: number; minutes: number }>
    daysByAccount: Record<string, string[]>
    // accountId -> newest event_ts already folded; guards against re-folding the same
    // evicted events on repeated sync merges (which would inflate minutes).
    foldedThrough: Record<string, number>
}

export function emptyRollups(): EventRollups {
    return { byMonth: {}, daysByAccount: {}, foldedThrough: {} }
}

const DAY_MS = 86_400_000
const DATE_RANGE_MS = 8.64e15
const DAY_CACHE_MAX = 8192

interface DaySegment { start: number; ymd: string; ym: string }

// Local month/day keys, one segment cache per UTC day instead of two Date objects
// per evicted event. The local date inside a UTC day moves monotonically forward
// and changes at most a couple of times, so each day is split by bisection on the
// exact Date-derived parts: keys are identical to the per-event Date computation
// across DST transitions, half-hour zones and offset jumps.
const daySegments = new Map<number, DaySegment[]>()

function dateParts(ts: number): { ymd: string; ym: string } {
    const date = new Date(ts)
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const ym = `${date.getFullYear()}-${month}`
    return { ymd: `${ym}-${String(date.getDate()).padStart(2, '0')}`, ym }
}

function boundaryBetween(lo: number, hi: number, ymd: string): number {
    while (hi - lo > 1) {
        const mid = lo + ((hi - lo) >> 1)
        if (dateParts(mid).ymd === ymd) lo = mid
        else hi = mid
    }
    return hi
}

function buildDaySegments(start: number): DaySegment[] {
    const end = start + DAY_MS
    const segments: DaySegment[] = []
    let segStart = start
    let segParts = dateParts(segStart)
    for (;;) {
        const lastParts = dateParts(end - 1)
        if (lastParts.ymd === segParts.ymd || end - segStart <= 1) {
            segments.push({ start: segStart, ...segParts })
            return segments
        }
        const boundary = boundaryBetween(segStart, end, segParts.ymd)
        segments.push({ start: segStart, ...segParts })
        segStart = boundary
        segParts = dateParts(boundary)
    }
}

function localKeys(ts: number): { ymd: string; ym: string } {
    // Matches the per-event Date forms: Date() truncates fractional ms toward zero
    // before resolving local parts, and out-of-range/NaN timestamps keep the legacy
    // keys ('unknown' day, 'NaN-NaN' month) the old builders produced.
    if (!Number.isFinite(ts)) return { ymd: 'unknown', ym: 'NaN-NaN' }
    const ms = Math.trunc(ts)
    if (ms < -DATE_RANGE_MS || ms > DATE_RANGE_MS) return { ymd: 'unknown', ym: 'NaN-NaN' }
    const index = Math.floor(ms / DAY_MS)
    let segments = daySegments.get(index)
    if (!segments) {
        segments = buildDaySegments(index * DAY_MS)
        if (daySegments.size >= DAY_CACHE_MAX) daySegments.clear()
        daySegments.set(index, segments)
    }
    if (segments.length === 1 || ms < segments[1].start) return segments[0]
    return segments.length === 2 || ms < segments[2].start ? segments[1] : segments[2]
}

export function foldEvicted(events: WatchEvent[], rollups: EventRollups): EventRollups {
    if (events.length === 0) return rollups

    // Folded months accumulate in a Map: each key is seeded from the incoming
    // rollups on first touch and mutated in place afterwards, so an evicted event
    // costs no per-key object allocation. Merged back once at the end.
    const foldedByMonth = new Map<string, { count: number; minutes: number }>()
    const daysByAccount: Record<string, Set<string>> = {}
    // Guard compares against the pre-fold watermark only, so an unsorted batch never skips an event.
    const baseWatermark: Record<string, number> = {}
    const newWatermark: Record<string, number> = {}
    const foldedThrough = { ...rollups.foldedThrough }

    for (const event of events) {
        let highWater = baseWatermark[event.accountId]
        if (highWater === undefined) {
            const existing = rollups.foldedThrough[event.accountId]
            highWater = existing === undefined ? -Infinity : existing
            baseWatermark[event.accountId] = highWater
        }
        // NaN timestamps can't be ordered by the watermark and would re-fold on every write.
        if (!Number.isFinite(event.event_ts) || event.event_ts <= highWater) continue

        const keys = localKeys(event.event_ts)
        const key = `${event.accountId}:${event.itemId}:${keys.ym}`
        let entry = foldedByMonth.get(key)
        if (entry === undefined) {
            const existing = rollups.byMonth[key]
            entry = existing ? { count: existing.count, minutes: existing.minutes } : { count: 0, minutes: 0 }
            foldedByMonth.set(key, entry)
        }
        entry.count++
        entry.minutes += (event.time_watched || 0) / 60000

        let days = daysByAccount[event.accountId]
        if (!days) {
            days = new Set(rollups.daysByAccount[event.accountId] || [])
            daysByAccount[event.accountId] = days
        }
        days.add(keys.ymd)

        if (event.event_ts > (newWatermark[event.accountId] ?? -Infinity)) {
            newWatermark[event.accountId] = event.event_ts
        }
    }

    const byMonth = { ...rollups.byMonth }
    for (const [key, entry] of foldedByMonth) byMonth[key] = entry

    for (const [accountId, ts] of Object.entries(newWatermark)) {
        foldedThrough[accountId] = Math.max(foldedThrough[accountId] ?? -Infinity, ts)
    }

    const nextDaysByAccount: Record<string, string[]> = {}
    for (const [accountId, days] of Object.entries(daysByAccount)) {
        nextDaysByAccount[accountId] = Array.from(days).sort()
    }

    return { byMonth, daysByAccount: { ...rollups.daysByAccount, ...nextDaysByAccount }, foldedThrough }
}

export function capWatchEventsWithRollups(
    events: WatchEvent[],
    rollups: EventRollups
): { kept: WatchEvent[]; evicted: WatchEvent[]; rollups: EventRollups } {
    const kept = capWatchEvents(events)
    if (kept === events) return { kept, evicted: [], rollups }

    const keptIds = new Set(kept.map(e => e.id))
    const evicted = events.filter(e => !keptIds.has(e.id))
    return { kept, evicted, rollups: foldEvicted(evicted, rollups) }
}

export function mergeRollups(local: EventRollups, remote: EventRollups): EventRollups {
    if (Object.keys(remote.byMonth).length === 0 && Object.keys(remote.daysByAccount).length === 0 && Object.keys(remote.foldedThrough).length === 0) {
        return local
    }

    const byMonth: Record<string, { count: number; minutes: number }> = { ...local.byMonth }
    for (const [key, entry] of Object.entries(remote.byMonth)) {
        const existing = byMonth[key]
        if (!existing) {
            byMonth[key] = { ...entry }
        } else {
            byMonth[key] = {
                count: Math.max(existing.count, entry.count),
                minutes: Math.max(existing.minutes, entry.minutes),
            }
        }
    }

    const daysByAccount: Record<string, string[]> = { ...local.daysByAccount }
    for (const [accountId, remoteDays] of Object.entries(remote.daysByAccount)) {
        if (remoteDays.length === 0) continue
        const merged = new Set([...(daysByAccount[accountId] || []), ...remoteDays])
        daysByAccount[accountId] = Array.from(merged).sort()
    }

    const foldedThrough: Record<string, number> = { ...local.foldedThrough }
    for (const [accountId, ts] of Object.entries(remote.foldedThrough)) {
        if (!(accountId in foldedThrough) || ts > foldedThrough[accountId]) foldedThrough[accountId] = ts
    }

    return { byMonth, daysByAccount, foldedThrough }
}

export function hasRollupData(rollups: EventRollups | undefined): rollups is EventRollups {
    return !!rollups && (Object.keys(rollups.byMonth).length > 0 || Object.keys(rollups.daysByAccount).length > 0)
}
