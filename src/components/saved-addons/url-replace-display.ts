// Display helpers for the Find & Replace URL dialog. Relative .ts imports keep this runnable under node:test.
import { maskSecretUrl } from '../../lib/mask-secret-url.ts'
import { maskUrlLevel } from '../../lib/utils.ts'

const OPAQUE_SEGMENT = /^[A-Za-z0-9_\-=%+~.]+$/
const SENSITIVE_KEY = /key|token|secret|pass|auth|sig|jwt|cred|session/i

function isOpaqueSegment(value: string): boolean {
    if (value === '') return false
    if (!OPAQUE_SEGMENT.test(value)) return value.length >= 20
    if (value.length >= 20) return true
    return value.length >= 12 && !value.includes('.') && /\d/.test(value) && /[A-Za-z]/.test(value)
}

function shortenSegment(value: string): string {
    return `${value.slice(0, 3)}...${value.slice(-3)}`
}

// Once a run starts the list must render the results snapshot taken when the run began, not the
// live preview, or every replaced row drops out the moment its URL stops matching the find text.
export function resolveReplaceDisplayItems<T extends { id: string }>(results: T[], previewItems: T[]): T[] {
    return results.length > 0 ? results : previewItems
}

export interface ReplaceRunSummary {
    replaced: number
    skipped: number
    failed: number
}

export function summarizeReplaceRun<T extends { status: string }>(items: T[]): ReplaceRunSummary {
    let replaced = 0
    let skipped = 0
    let failed = 0
    for (const item of items) {
        if (item.status === 'success') replaced++
        else if (item.status === 'error') failed++
        else skipped++
    }
    return { replaced, skipped, failed }
}

export function formatReplaceRunSummary(summary: ReplaceRunSummary): string {
    const parts: string[] = []
    if (summary.replaced > 0) parts.push(`${summary.replaced} replaced`)
    if (summary.skipped > 0) parts.push(`${summary.skipped} skipped`)
    if (summary.failed > 0) parts.push(`${summary.failed} failed`)
    return parts.length > 0 ? parts.join(', ') : 'Nothing to replace'
}

// Display-only: shortens secret-looking segments but keeps any segment holding the match readable
// so the highlight still shows. Under privacy the whole URL is masked by level instead.
export function maskReplaceUrl(url: string, match: string, urlPrivacyLevel: number): string {
    if (urlPrivacyLevel > 0) return maskUrlLevel(url, urlPrivacyLevel)
    if (!match) return maskSecretUrl(url)
    const matchLower = match.toLowerCase()
    try {
        const parsed = new URL(url)
        const userinfo = parsed.username || parsed.password ? '***:***@' : ''
        const path = parsed.pathname
            .split('/')
            .map(segment => segment.toLowerCase().includes(matchLower) || !isOpaqueSegment(segment) ? segment : shortenSegment(segment))
            .join('/')
        const query = parsed.search
            ? '?' + parsed.search.slice(1).split('&').map(pair => {
                if (pair.toLowerCase().includes(matchLower)) return pair
                const eq = pair.indexOf('=')
                if (eq < 0) return pair
                const key = pair.slice(0, eq)
                const value = pair.slice(eq + 1)
                return SENSITIVE_KEY.test(key) || isOpaqueSegment(value) ? `${key}=***` : pair
            }).join('&')
            : ''
        const hash = parsed.hash && !parsed.hash.toLowerCase().includes(matchLower) ? '#***' : parsed.hash
        return `${parsed.protocol}//${userinfo}${parsed.host}${path === '/' ? '' : path}${query}${hash}`
    } catch {
        return maskSecretUrl(url)
    }
}
