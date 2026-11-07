/**
 * Pure helpers for the Dashboard host metrics view (DP-02): threshold tones,
 * the honest sampling label, sparkline aria text and worker freshness rows.
 * Deliberately dependency-free apart from admin-format, so node tests load
 * them directly.
 */
import type { Tone } from '../api/admin.ts'

/** Higher is worse: bad at badAt, warn at warnAt, otherwise no tone. */
export function thresholdTone(value: number | null | undefined, warnAt: number, badAt: number): Tone | undefined {
    if (value === null || value === undefined) return undefined
    if (value >= badAt) return 'bad'
    if (value >= warnAt) return 'warn'
    return undefined
}

/** Lower is worse (percent free): bad below badBelow, warn below warnBelow. */
export function freeShareTone(pctFree: number | null | undefined, warnBelow: number, badBelow: number): Tone | undefined {
    if (pctFree === null || pctFree === undefined) return undefined
    if (pctFree < badBelow) return 'bad'
    if (pctFree < warnBelow) return 'warn'
    return undefined
}

/** Error rate in percent, one decimal; null when nothing was answered. */
export function errorRatePct(answered: number, failed: number): number | null {
    if (answered <= 0) return null
    return Math.round((failed / answered) * 1000) / 10
}

/** '60 s' / '5 min' / '1 h': the cadence part of the sampling label. */
export function cadenceLabel(ms: number): string {
    if (ms < 120_000) return `${Math.max(1, Math.round(ms / 1000))} s`
    if (ms < 3_600_000) return `${Math.max(1, Math.round(ms / 60_000))} min`
    return `${Math.round(ms / 3_600_000)} h`
}

/** The window part of the sampling label, from the actual point count. */
export function samplingWindowLabel(points: number, sampledEveryMs: number): string {
    const minutes = Math.round((points * sampledEveryMs) / 60_000)
    return minutes >= 1 ? `last ${minutes} min` : 'last under 1 min'
}

/**
 * The label every metrics panel repeats, generated from the actual cadence and
 * point count so a shorter window can never lie about its coverage.
 */
export function samplingLabel(sampledEveryMs: number, points: number): string {
    return `Sampled every ${cadenceLabel(sampledEveryMs)}, ${samplingWindowLabel(points, sampledEveryMs)}, kept in memory; nothing is written by watching.`
}

/** Sparkline aria text: the latest value plus the observed range. */
export function sparkAria(label: string, values: number[], unit: string, windowText: string): string {
    if (!values.length) return `${label}: no samples yet`
    const fmt = (n: number) => (unit === '%' ? `${n}%` : `${n} ${unit}`)
    return `${label}, ${windowText}: latest ${fmt(values[values.length - 1])}, lowest ${fmt(Math.min(...values))}, highest ${fmt(Math.max(...values))}`
}

export interface WorkerFreshnessInput {
    enabled: boolean
    running: boolean
    lastCycle: { endedAt: number | null; error: string | null } | null
}

export interface WorkerFreshnessRow {
    id: string
    label: string
    tone: Tone
    title: string
    detail: string
    section: string
}

/** A cycle older than this warns, per the approved design. */
export const WORKER_FRESH_MS = 10 * 60_000

const shortAgo = (ms: number): string => {
    const s = Math.max(0, Math.floor(ms / 1000))
    if (s < 5) return 'just now'
    if (s < 60) return `${s} s ago`
    const m = Math.floor(s / 60)
    if (m < 60) return `${m}m ago`
    const h = Math.floor(m / 60)
    if (h < 24) return `${h}h ago`
    return `${Math.floor(h / 24)}d ago`
}

function workerRow(id: string, label: string, section: string, worker: WorkerFreshnessInput, nowMs: number): WorkerFreshnessRow {
    if (!worker.enabled) {
        return { id, label, tone: 'info', title: `${label} is off`, detail: 'Disabled on this instance; nothing is scheduled.', section }
    }
    if (!worker.lastCycle) {
        return { id, label, tone: 'warn', title: `${label} has not finished a cycle yet`, detail: 'No cycle has ended since the last server start.', section }
    }
    if (worker.lastCycle.error) {
        return { id, label, tone: 'bad', title: `${label} last cycle failed`, detail: worker.lastCycle.error, section }
    }
    const ago = worker.lastCycle.endedAt !== null ? shortAgo(nowMs - worker.lastCycle.endedAt) : 'never'
    const stale = worker.lastCycle.endedAt !== null && nowMs - worker.lastCycle.endedAt > WORKER_FRESH_MS
    return {
        id,
        label,
        tone: stale ? 'warn' : 'ok',
        title: `${label} last cycle ${ago}`,
        detail: stale ? 'Older than the usual cadence.' : 'Completed within the usual cadence.',
        section,
    }
}

/**
 * Freshness rows for the two background workers: trouble first (errors, stale,
 * disabled), then healthy rows, the least recent cycle first.
 */
export function workerFreshnessRows(autopilot: WorkerFreshnessInput, activity: WorkerFreshnessInput | null, nowMs: number): WorkerFreshnessRow[] {
    const rows = [
        workerRow('autopilot', 'Autopilot worker', 'autopilot', autopilot, nowMs),
        ...(activity ? [workerRow('activity', 'Activity engine', 'activity-engine', activity, nowMs)] : []),
    ]
    const rank: Record<string, number> = { bad: 0, warn: 1, info: 2, ok: 3 }
    // Ties read oldest endedAt first (the smallest epoch), as in the approved mockup.
    const ended = (r: WorkerFreshnessRow): number => {
        const cycle = r.id === 'autopilot' ? autopilot.lastCycle : activity?.lastCycle
        return cycle?.endedAt ?? Number.MAX_SAFE_INTEGER
    }
    return rows.sort((a, b) => rank[a.tone] - rank[b.tone] || ended(a) - ended(b))
}
