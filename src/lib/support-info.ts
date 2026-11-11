// Builds the one-block "Copy support info" summary for bug reports (crash
// screen and the settings Repair list). Pure and dependency-free so it can be
// unit tested with plain `node --test`; the browser-side facts are gathered by
// src/lib/support-info-gather.ts, which maps free-text sync failures to fixed
// categories BEFORE this builder ever sees them. The builder accepts only
// structured, known-safe fields: sync error text is dropped by contract, crash
// fields are allowlisted against built-in error names, approved message
// templates, known component names and the build's actually-loaded assets,
// and routes against the app's route table. Everything still exits through
// redactCopyText as a last pass.

import { redactCopyText } from './redact-copy.ts'

const MAX_ERROR_LINES = 5
const MAX_STACK_FRAMES = 8
const MAX_COMPONENTS = 12

export type SyncErrorCategory = 'network' | 'auth' | 'conflict' | 'server' | 'unknown'

/** Fixed-category sync failure; the free-text message never reaches this type. */
export interface SupportSyncEntry {
    timestamp: string
    type: string
    category: SyncErrorCategory
    httpStatus: number | null
}

export interface SupportPendingPush {
    markedAt: number
}

export interface SupportPlatform {
    platform: string
    enabledCount: number
    disabledCount: number
}

export interface SupportCrashFacts {
    errorName: string
    message: string | null
    stack: string | null
    components: string[]
    route: string
}

export interface SupportInfoFacts {
    generatedAt: string
    appVersion: string
    serverVersion: string | null
    serverReachable: boolean
    browser: string
    device: string
    pwa: boolean
    storage: string | null
    recentErrors: SupportSyncEntry[]
    pendingPushes: SupportPendingPush[]
    platforms: SupportPlatform[]
    crash?: SupportCrashFacts | null
}

// ---- enum allowlists shared with the diagnostics copy ----

export const ACCOUNT_STATUS_VALUES = ['active', 'error', 'expired'] as const
export const CONNECTION_STATUS_VALUES = ['active', 'expired', 'error', 'degraded', 'pending'] as const
export const CONNECTION_PLATFORM_VALUES = ['stremio', 'nuvio', 'realstream', 'jellyfin', 'aiostreams', 'aiometadata', 'hydra'] as const

/** Returns the canonical allowed value (case-insensitive), or the fallback. */
export function knownValue(value: unknown, allowed: readonly string[], fallback: string): string {
    const text = typeof value === 'string' ? value.trim() : ''
    if (!text) return fallback
    const hit = allowed.find(a => a.toLowerCase() === text.toLowerCase())
    return hit ?? fallback
}

/** Manifest versions become bounded numeric major.minor.patch; suffixes and metadata drop. */
export function boundVersion(value: unknown): string {
    const m = /^v?(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![.\d])/.exec(typeof value === 'string' ? value.trim() : '')
    if (!m) return 'unknown'
    return `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}`
}

/** App, server and last-seen versions become bounded numeric major.minor; else unknown. */
export function boundMajorMinor(value: unknown): string {
    const m = /^v?(\d{1,3})\.(\d{1,3})(?:\.\d{1,3})?(?![.\d])/.exec(typeof value === 'string' ? value.trim() : '')
    if (!m) return 'unknown'
    return `${Number(m[1])}.${Number(m[2])}`
}

/** Counts must be in-range integers before they reach support text. */
export function boundCount(value: unknown): string {
    const n = typeof value === 'number'
        ? value
        : (typeof value === 'string' && /^\d{1,7}$/.test(value) ? Number(value) : Number.NaN)
    if (!Number.isInteger(n) || n < 0 || n > 1000000) return 'unknown'
    return String(n)
}

/** Browser and OS major versions must be short digits; anything else is 'unknown'. */
function boundMajor(value: unknown): string {
    const s = String(value ?? '').trim()
    return /^\d{1,4}$/.test(s) ? String(Number(s)) : 'unknown'
}

/** Coarse browser and OS family, e.g. "Chrome 153, Windows"; never the raw UA. */
export function describeBrowser(ua: string): string {
    let m: RegExpExecArray | null
    let os = 'Unknown OS'
    if ((m = /Android (\d+)/.exec(ua))) os = `Android ${boundMajor(m[1])}`
    else if ((m = /(?:iPhone|iPad).*?OS (\d+)/.exec(ua))) os = `iOS ${boundMajor(m[1])}`
    else if (/Windows NT/.test(ua)) os = 'Windows'
    else if (/Mac OS X/.test(ua)) os = 'macOS'
    else if (/Linux/.test(ua)) os = 'Linux'
    let browser = 'Unknown browser'
    if ((m = /Edg\/(\d+)/.exec(ua))) browser = `Edge ${boundMajor(m[1])}`
    else if ((m = /(?:Chrome|HeadlessChrome)\/(\d+)/.exec(ua))) browser = `Chrome ${boundMajor(m[1])}`
    else if ((m = /Firefox\/(\d+)/.exec(ua))) browser = `Firefox ${boundMajor(m[1])}`
    else if ((m = /Version\/(\d+).*Safari/.exec(ua))) browser = `Safari ${boundMajor(m[1])}`
    return `${browser}, ${os}`
}

function pad(n: number): string {
    return String(n).padStart(2, '0')
}

function clock(iso: string): string {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return '--:--:--'
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function clockMinutes(ms: number): string {
    const d = new Date(ms)
    if (Number.isNaN(d.getTime())) return '--:--'
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function stamp(generatedAt: string): string {
    const d = new Date(generatedAt)
    if (Number.isNaN(d.getTime())) return '--'
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/**
 * Maps a raw sync failure message to a fixed category plus HTTP status, so no
 * free text needs to survive. Ordered most specific first; anything not
 * recognised stays 'unknown'.
 */
export function classifySyncError(message: string): { category: SyncErrorCategory; httpStatus: number | null } {
    const text = message || ''
    const statusMatch = /\b([45]\d{2})\b/.exec(text)
    const httpStatus = statusMatch ? Number(statusMatch[1]) : null
    const lower = text.toLowerCase()
    let category: SyncErrorCategory = 'unknown'
    if (/conflict|revision|\b409\b/.test(lower)) category = 'conflict'
    else if (/401|403|token|sign-?in|sign-?out|unauthor|expired|credentials?|password|forbidden|\b404\b/.test(lower)) category = 'auth'
    else if (httpStatus !== null && httpStatus >= 500) category = 'server'
    else if (/econnrefused|enotfound|econnaborted|fetch failed|network|timeout|timed out|unreachable|offline|socket|dns|epipe|certificate|bad gateway|server error/.test(lower)) category = 'network'
    return { category, httpStatus }
}

/** The app's own route table, expressed as shapes; nothing outside it is printed. */
const KNOWN_ROUTES = [
    '/',
    '/saved-addons',
    '/account/:accountId',
    '/account/:accountId/aiostreams/:uuid',
    '/account/:accountId/aiometadata/:uuid',
    '/activity',
    '/metrics',
    '/replay',
    '/replay/share/:token',
    '/settings',
    '/settings/theme/editor',
    '/notes',
    '/vault',
    '/dashboard',
    '/dashboard/:section',
    '/dashboard/users/:userId',
    '/kronorium',
]

export function matchRouteShape(pathname: string): string {
    if (!pathname || /[#?]/.test(pathname)) return '[route]'
    const parts = pathname.split('/').filter(s => s.length > 0)
    for (const route of KNOWN_ROUTES) {
        const routeParts = route.split('/').filter(s => s.length > 0)
        if (route === '/') {
            if (parts.length === 0) return '/'
            continue
        }
        if (routeParts.length !== parts.length) continue
        const ok = routeParts.every((rp, i) => rp.startsWith(':') || rp === parts[i])
        if (ok) return route
    }
    return '[route]'
}

// ---- crash-field allowlists ----

const BUILT_IN_ERROR_NAMES = ['Error', 'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError', 'TypeError', 'URIError', 'AggregateError', 'DOMException', 'AbortError']

/** Built-in error names only; anything else becomes the generic 'Error'. */
function allowlistedErrorName(name: unknown): string {
    const first = String(name || '').split(/[:(]/)[0].trim()
    const hit = BUILT_IN_ERROR_NAMES.find(b => b.toLowerCase() === first.toLowerCase())
    return hit ?? 'Error'
}

/**
 * Approved message templates; substitutions must be plain digits captured by
 * the template itself, so arbitrary prose can never ride along. Returns the
 * safe render or null (withheld).
 */
export function sanitizeCrashMessage(message: unknown): string | null {
    if (typeof message !== 'string') return null
    const text = message.trim()
    let m: RegExpExecArray | null
    if ((m = /^Failed to fetch\.?$/i.exec(text))) return 'Failed to fetch'
    if ((m = /^Failed to fetch after (\d{1,4}) attempts\.?$/i.exec(text))) return `Failed to fetch after ${Number(m[1])} attempts`
    if ((m = /^Network timeout after (\d{2,6}) ?ms\.?$/i.exec(text))) return `Network timeout after ${Number(m[1])} ms`
    if ((m = /^Load failed\.?$/i.exec(text))) return 'Load failed'
    if ((m = /^NetworkError when attempting to fetch resource\.?$/i.exec(text))) return 'NetworkError when attempting to fetch resource'
    if ((m = /^The network connection was lost\.?$/i.exec(text))) return 'The network connection was lost'
    if ((m = /^Aborted\.?$/i.exec(text))) return 'Aborted'
    if ((m = /^Session expired\.?$/i.exec(text))) return 'Session expired'
    return null
}

/** Component names this app actually defines (pages, shells, key sections). */
const KNOWN_COMPONENT_NAMES = new Set([
    'AccountsPage', 'SavedAddonsPage', 'AccountDetailPage', 'AIOStreamsPage', 'AIOMetadataPage',
    'ActivityPage', 'MetricsPage', 'ReplayPage', 'ReplaySharePage', 'SettingsPage', 'ThemeEditorPage',
    'NotesPage', 'VaultPage', 'DashboardPage', 'KronoriumPage', 'KronoriumDocsLayout', 'NotFoundPage',
    'AuthenticatedShell', 'LoginPage', 'ErrorBoundary', 'AppRoutes', 'App', 'Layout', 'BrandLogo',
    'SyncDiagnostics', 'RepairTools', 'RememberedDevicesSection', 'DangerZone', 'Header', 'SquircleOverlay',
])

/** Frames are locations only: line and column digits, never a file name. */
function crashStackLines(stack: string | null): string[] {
    if (!stack) return []
    const frames: string[] = []
    for (const match of stack.matchAll(/\.js:(\d{1,7}):(\d{1,7})(?!\d)/g)) {
        const [, line, col] = match
        frames.push(`app code:${line}:${col}`)
        if (frames.length >= MAX_STACK_FRAMES) break
    }
    return [...new Set(frames)]
}

function crashLines(crash: SupportCrashFacts): string[] {
    const lines: string[] = ['Crash:', `Error: ${allowlistedErrorName(crash.errorName)}`]
    const message = sanitizeCrashMessage(crash.message)
    lines.push(message ? `Message: ${message}` : 'Message: [message withheld]')
    const frames = crashStackLines(crash.stack)
    if (frames.length > 0) {
        lines.push('Stack:')
        for (const frame of frames) lines.push(`  ${frame}`)
    }
    const components = [...new Set((crash.components || []).filter(c => typeof c === 'string' && KNOWN_COMPONENT_NAMES.has(c)))].slice(0, MAX_COMPONENTS)
    if (components.length > 0) lines.push(`Components: ${components.join(', ')}`)
    lines.push(`Route: ${matchRouteShape(crash.route || '')}`)
    return lines
}

export function buildSupportInfoText(facts: SupportInfoFacts): string {
    const lines: string[] = [
        'AIOManager support info',
        `Generated: ${stamp(facts.generatedAt)}`,
        `App: ${boundMajorMinor(facts.appVersion)}`,
        facts.serverReachable
            ? `Server: ${boundMajorMinor(facts.serverVersion)} (reachable)`
            : 'Server: unreachable',
        `Browser: ${facts.browser}`,
        `Device: ${facts.device}`,
        facts.pwa ? 'Mode: Installed PWA' : 'Mode: Browser tab',
        `Storage: ${facts.storage || 'unavailable'}`,
        '',
    ]

    if (facts.crash) lines.push(...crashLines(facts.crash), '')

    lines.push('Recent sync errors:')
    const errors = facts.recentErrors.slice(0, MAX_ERROR_LINES)
    if (errors.length === 0) {
        lines.push('  none in the last 50 events')
    } else {
        for (const e of errors) {
            lines.push(`  ${clock(e.timestamp)} ${e.type} ${e.category}${e.httpStatus !== null ? ` (HTTP ${e.httpStatus})` : ''}`)
        }
    }

    if (facts.pendingPushes.length === 0) {
        lines.push('Pending pushes: none')
    } else {
        const oldest = Math.min(...facts.pendingPushes.map(p => p.markedAt))
        const n = facts.pendingPushes.length
        lines.push('Pending pushes:')
        lines.push(n === 1
            ? `  1 push did not confirm, marked ${clockMinutes(oldest)}, retry queued`
            : `  ${n} pushes did not confirm, oldest marked ${clockMinutes(oldest)}, retry queued`)
    }

    const platforms = [...facts.platforms]
        .map(p => ({
            platform: knownValue(p.platform, CONNECTION_PLATFORM_VALUES, 'other'),
            enabled: boundCount(p.enabledCount),
            disabled: boundCount(p.disabledCount),
        }))
        .sort((a, b) => a.platform.localeCompare(b.platform))
        .map(p => `${p.platform} (${p.enabled} on, ${p.disabled} off)`)
    lines.push(`Connection platforms: ${platforms.length > 0 ? platforms.join(', ') : 'none'}`)
    lines.push('')
    lines.push('Sensitive values are removed before copying. Sync error text is dropped; the crash message appears only when it matches an approved template.')
    return redactCopyText(lines.join('\n'))
}
