/**
 * Pure helpers for the DP-03 Logs screen: filter-to-query mapping, regex
 * validation, tail matching, error grouping, list merging and export naming.
 * Type-only dependency on the API module so node:test can load this file
 * without the client chain.
 */
import type { LogLine, LogLevel } from '../api/admin.ts'

/** Search text and regex pattern length cap; longer input is rejected before the request. */
export const LOGS_Q_MAX = 256
/** Max lines per page (the server accepts up to 500). */
export const LOGS_PAGE_LIMIT = 200
/** Client view cap, matching the server ring capacity. */
export const LOGS_TAIL_CAP = 1000

export type LogsWindowId = '15m' | '1h' | '6h' | 'all'

export const LOGS_WINDOWS: { id: LogsWindowId; label: string; ms: number | null }[] = [
    { id: '15m', label: '15 m', ms: 15 * 60_000 },
    { id: '1h', label: '1 h', ms: 3_600_000 },
    { id: '6h', label: '6 h', ms: 6 * 3_600_000 },
    { id: 'all', label: 'All buffered', ms: null },
]

export interface LogFilters {
    q: string
    regex: boolean
    level: LogLevel | 'all'
    /** 'all' or one module id from the ring. */
    module: string
    window: LogsWindowId
}

export const NO_LOG_FILTERS: LogFilters = { q: '', regex: false, level: 'all', module: 'all', window: 'all' }

export interface LogsRequestFilters {
    q?: string
    regex?: boolean
    level?: LogLevel | 'all'
    /** 'all' or one module id from the ring. */
    module?: string
    window?: LogsWindowId
    /** Cutoff captured once when the window or filters changed (epoch ms); shared by every page, refetch and export of that set. */
    since?: number
    /** Seq of the oldest line already loaded; the server returns older lines only. */
    cursor?: number
    limit?: number
}

/**
 * Compiles the pattern for the inline error only. The cleaned engine message
 * is returned so the screen can show why the pattern is invalid; data is never
 * matched against user regex on the client.
 */
export function validateLogPattern(pattern: string): string | null {
    if (!pattern) return null
    try {
        new RegExp(pattern)
        return null
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        return message.replace(/^Invalid regular expression:\s*/, '')
    }
}

/**
 * The window's epoch-ms cutoff at capture time, or null for 'all'. The screen
 * calls this once per filter set; every request of the set then carries the
 * same explicit `since`, so cursor pages, refetches and exports cannot open a
 * gap at the window boundary as the clock moves.
 */
export function logWindowCutoff(window: LogsWindowId, now = Date.now()): number | null {
    const win = LOGS_WINDOWS.find(w => w.id === window)
    return win?.ms ? now - win.ms : null
}

/** Filter set to GET /api/admin/logs query string, mirroring the server contract. */
export function logsQueryParams(filters: LogsRequestFilters, now = Date.now()): URLSearchParams {
    const params = new URLSearchParams()
    const q = (filters.q ?? '').trim()
    if (q) params.set('q', q)
    if (filters.regex && q) params.set('regex', '1')
    if (filters.level && filters.level !== 'all') params.set('level', filters.level)
    if (filters.module && filters.module !== 'all') params.set('module', filters.module)
    const win = LOGS_WINDOWS.find(w => w.id === (filters.window ?? 'all'))
    if (win?.ms) params.set('since', String(filters.since ?? now - win.ms))
    if (filters.cursor !== undefined && filters.cursor > 0) params.set('cursor', String(filters.cursor))
    params.set('limit', String(Math.min(500, Math.max(1, filters.limit ?? LOGS_PAGE_LIMIT))))
    return params
}

/**
 * Whether a buffered tail line may increment the N-new pill. Only lines the
 * active filters accept count: lines hidden by level, module, window or search
 * never reach the view. Regex lines with text cannot be confirmed locally, so
 * they stay uncounted until the quiet refetch folds them into the page; the
 * pill therefore shows confirmed matches only.
 */
export function tailLineCountsAsNew(line: LogLine, filters: LogFilters, now = Date.now()): boolean {
    return tailLineMatches(line, filters, now)
}

/**
 * Whether a live tail line belongs in the current filtered view. Regex mode can
 * only be resolved by the server (the caller refetches there), so those lines
 * answer false here and reach the view through the next page fetch.
 */
export function tailLineMatches(line: LogLine, filters: LogFilters, now = Date.now()): boolean {
    if (filters.level !== 'all' && line.level !== filters.level) return false
    if (filters.module !== 'all' && line.module !== filters.module) return false
    const win = LOGS_WINDOWS.find(w => w.id === filters.window)
    if (win?.ms && Date.parse(line.at) < now - win.ms) return false
    // The pattern runs server-side only: with text the caller refetches so the
    // server folds new lines in; without text the mode is inert, exactly like
    // a request that omits regex=1.
    if (filters.regex) return filters.q.trim() === ''
    const q = filters.q.trim().toLowerCase()
    if (q && !line.message.toLowerCase().includes(q)) return false
    return true
}

export interface LogErrorGroup {
    /** The redacted message template; only what the ring stores is grouped. */
    signature: string
    count: number
    lastAt: string
    firstSeq: number
}

/** Groups the error lines of the loaded view by their redacted message. */
export function groupLogErrors(lines: LogLine[]): LogErrorGroup[] {
    const groups = new Map<string, LogErrorGroup>()
    for (const line of lines) {
        if (line.level !== 'error') continue
        const group = groups.get(line.message)
        if (group) {
            group.count += 1
            if (line.at > group.lastAt) group.lastAt = line.at
        } else {
            groups.set(line.message, { signature: line.message, count: 1, lastAt: line.at, firstSeq: line.seq })
        }
    }
    return [...groups.values()].sort((a, b) => b.count - a.count || a.firstSeq - b.firstSeq)
}

/**
 * Older pages, the current page and fresh tail lines merged into one ascending,
 * seq-deduped list capped at the ring capacity so the client view stays bounded.
 */
export function mergeLogLines(pages: LogLine[][], cap = LOGS_TAIL_CAP): LogLine[] {
    const bySeq = new Map<number, LogLine>()
    for (const page of pages) {
        for (const line of page) bySeq.set(line.seq, line)
    }
    const merged = [...bySeq.values()].sort((a, b) => a.seq - b.seq)
    return merged.length > cap ? merged.slice(merged.length - cap) : merged
}

/** Number of filters currently active (level, module, window, regex, search). */
export function activeLogFilterCount(filters: LogFilters): number {
    return (filters.level !== 'all' ? 1 : 0)
        + (filters.module !== 'all' ? 1 : 0)
        + (filters.window !== 'all' ? 1 : 0)
        + (filters.regex ? 1 : 0)
        + (filters.q.trim() ? 1 : 0)
}

/** Text copied per line: the wire shape only, always redacted. */
export function logLineText(line: LogLine): string {
    return `${line.timeLabel} ${line.level.toUpperCase()} ${line.module} ${line.message}`
}

/** Dated export file name, e.g. dashboard-logs-2026-11-03.log. */
export function logsExportName(format: 'log' | 'ndjson', date = new Date()): string {
    const y = date.getFullYear()
    const m = String(date.getMonth() + 1).padStart(2, '0')
    const d = String(date.getDate()).padStart(2, '0')
    return `dashboard-logs-${y}-${m}-${d}.${format}`
}
