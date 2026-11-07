/**
 * Client-side formatters for Dashboard raw values. The server sends raw numbers
 * and ISO strings; every label the UI shows is built here so labels follow the
 * viewer's time zone and never go stale inside server caches.
 * Deliberately dependency-free (mirrors lib/utils getTimeAgo) so the API
 * mappers using this module stay loadable under node:test.
 */

export function formatCount(n: number | null | undefined): string {
    if (n === null || n === undefined || Number.isNaN(n)) return '0'
    return Number(n).toLocaleString('en-US')
}

export function formatBytes(n: number | null | undefined): string {
    if (n === null || n === undefined || Number.isNaN(n)) return 'unknown'
    if (n < 1024) return `${Math.round(n)} B`
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
    return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

export function formatDurationMs(ms: number | null | undefined): string {
    if (ms === null || ms === undefined || Number.isNaN(ms)) return 'unknown'
    if (ms < 1000) return `${Math.round(ms)} ms`
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
    const m = Math.floor(ms / 60_000)
    const s = Math.round((ms % 60_000) / 1000)
    return s ? `${m} m ${s} s` : `${m} m`
}

/** Epoch ms or ISO input; renders relative labels into the past or the future. */
export function relTime(value: number | string | null | undefined): string {
    if (value === null || value === undefined || value === '') return 'never'
    const t = typeof value === 'number' ? value : Date.parse(value)
    if (Number.isNaN(t)) return 'unknown'
    const seconds = Math.floor((Date.now() - t) / 1000)
    if (seconds < 0) {
        const s = -seconds
        if (s < 60) return `in ${s} s`
        if (s < 3600) return `in ${Math.floor(s / 60)} m`
        if (s < 86_400) return `in ${Math.floor(s / 3600)} h`
        return `in ${Math.floor(s / 86_400)} d`
    }
    if (seconds < 60) return seconds <= 5 ? 'just now' : `${seconds} s ago`
    const interval = seconds / 31536000
    if (interval > 1) return `${Math.floor(interval)}y ago`
    if (seconds / 2592000 > 1) return `${Math.floor(seconds / 2592000)}mo ago`
    if (seconds / 86400 > 1) return `${Math.floor(seconds / 86400)}d ago`
    if (seconds / 3600 > 1) return `${Math.floor(seconds / 3600)}h ago`
    if (seconds / 60 > 1) return `${Math.floor(seconds / 60)}m ago`
    return 'just now'
}

export function formatClock(iso: string | null | undefined): string {
    if (!iso) return 'unknown'
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return 'unknown'
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}

export function formatDateTime(value: number | string | null | undefined): string {
    if (value === null || value === undefined || value === '') return 'unknown'
    const d = typeof value === 'number' ? new Date(value) : new Date(value)
    if (Number.isNaN(d.getTime())) return 'unknown'
    return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
}

/** 'YYYY-MM-DD' (server day granularity) into a short label with today/yesterday. */
export function formatDay(day: string | null | undefined): string {
    if (!day) return 'never'
    const t = Date.parse(`${day}T00:00:00`)
    if (Number.isNaN(t)) return day
    const now = new Date()
    const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
    const days = Math.round((startOfDay(now) - t) / 86_400_000)
    if (days === 0) return 'today'
    if (days === 1) return 'yesterday'
    return new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

/** 'YYYY-MM' (first-seen month) into 'Aug 2025'. */
export function formatMonth(month: string | null | undefined): string {
    if (!month) return 'unknown'
    const t = Date.parse(`${month}-01T00:00:00`)
    if (Number.isNaN(t)) return month
    return new Date(t).toLocaleDateString([], { month: 'short', year: 'numeric' })
}

/** Interval milliseconds into a schedule label; null reads as "not configured". */
export function formatIntervalMs(ms: number | null | undefined): string {
    if (ms === null || ms === undefined || ms <= 0) return 'not configured'
    if (ms < 60_000) return `every ${Math.round(ms / 1000)} s`
    if (ms < 3_600_000) {
        const m = Math.round(ms / 60_000)
        return m === 60 ? 'hourly' : `every ${m} min`
    }
    if (ms < 86_400_000) return `every ${Math.round(ms / 3_600_000)} h`
    return `every ${Math.round(ms / 86_400_000)} d`
}

export function formatUptime(sec: number | null | undefined): string {
    if (sec === null || sec === undefined || Number.isNaN(sec)) return 'unknown'
    const d = Math.floor(sec / 86_400)
    const h = Math.floor((sec % 86_400) / 3600)
    const m = Math.floor((sec % 3600) / 60)
    if (d > 0) return `${d} d ${h} h`
    if (h > 0) return `${h} h ${m} m`
    return `${m} m`
}
