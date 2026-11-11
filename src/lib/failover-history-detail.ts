import { format, isToday } from 'date-fns'

export interface SwitchReason {
    addon: string
    misses?: number
    checks?: number
    error?: number | string | null
    timeoutMs?: number
}

export interface PlatformResult {
    id: string
    platform: string
    ok: boolean
    error?: string
}

export interface HistoryDetail {
    reason: SwitchReason | null
    platforms: PlatformResult[] | null
    notified: 'rule' | 'global' | null | undefined
    notifiedOk: boolean
    retryAt: number | null
    from: string | null
}

const STATUS_TEXT: Record<number, string> = {
    400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 410: 'Gone', 429: 'Too Many Requests',
    500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout',
    521: 'Web Server Is Down', 522: 'Connection Timed Out', 523: 'Origin Is Unreachable', 524: 'A Timeout Occurred',
}

const ROW_TEXT: Record<string, string> = {
    'ping-timeout': 'timeout', 'connect-timeout': 'timeout', 'response-timeout': 'timeout',
    'connect-refused': 'connection refused', 'connect-reset': 'connection reset', 'dns-nxdomain': 'host not found',
    tls: 'TLS error', 'cf-tunnel': 'Cloudflare tunnel down', 'paas-no-app': 'app not deployed', 'traefik-404': '404 Not Found',
    'route-gone': '404 Not Found', blocked: 'blocked address', 'invalid-url': 'invalid URL', 'transport-other': 'network error',
}

const PUSH_ERROR_TEXT: Record<string, string> = {
    timeout: 'timeout', auth: 'sign-in expired', network: 'network error', skipped: 'skipped', error: 'error',
}

export function statusText(code: number): string {
    return STATUS_TEXT[code] ? `${code} ${STATUS_TEXT[code]}` : `HTTP ${code}`
}

export function checkErrorText(error: SwitchReason['error']): string | null {
    if (error == null || error === '') return null
    if (typeof error === 'number') return statusText(error)
    if (/^\d{3}$/.test(error)) return statusText(Number(error))
    return ROW_TEXT[error] ?? null
}

export function pushErrorText(error: string | undefined): string {
    if (!error) return 'error'
    if (/^\d{3}$/.test(error)) return statusText(Number(error))
    return PUSH_ERROR_TEXT[error] ?? 'error'
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

export function readHistoryDetail(metadata: Record<string, unknown> | undefined): HistoryDetail | null {
    if (!metadata || !('notified' in metadata || 'platforms' in metadata || 'reason' in metadata)) return null
    const r = metadata.reason
    const reason = isObject(r) && typeof r.addon === 'string' ? {
        addon: r.addon,
        misses: typeof r.misses === 'number' ? r.misses : undefined,
        checks: typeof r.checks === 'number' ? r.checks : undefined,
        error: typeof r.error === 'number' || typeof r.error === 'string' ? r.error : null,
        timeoutMs: typeof r.timeoutMs === 'number' ? r.timeoutMs : undefined,
    } : null
    const platforms = Array.isArray(metadata.platforms)
        ? metadata.platforms.filter(isObject).filter(p => typeof p.platform === 'string').map(p => ({
            id: String(p.id ?? p.platform),
            platform: String(p.platform),
            ok: p.ok === true,
            error: typeof p.error === 'string' ? p.error : undefined,
        }))
        : null
    const notified = metadata.notified === 'rule' || metadata.notified === 'global' ? metadata.notified : null
    return {
        reason,
        platforms,
        notified,
        notifiedOk: metadata.notifiedOk !== false,
        retryAt: typeof metadata.retryAt === 'number' ? metadata.retryAt : null,
        from: typeof metadata.from === 'string' ? metadata.from : null,
    }
}

const times = (n: number) => (n === 2 ? 'twice' : `${n} times`)

export function reasonSentence(type: string, reason: SwitchReason | null, addonName: string, targetName: string): string | null {
    if (!reason) return null
    if (type === 'recovery' && reason.checks != null) {
        return `${addonName} passed ${reason.checks} checks in a row. Switched back to ${targetName}.`
    }
    if (type === 'failover' && reason.misses != null) {
        if (reason.timeoutMs && checkErrorText(reason.error) === 'timeout') {
            return `${addonName} did not answer within ${Math.round(reason.timeoutMs / 1000)} s, ${times(reason.misses)}. Switched to ${targetName}.`
        }
        const err = checkErrorText(reason.error)
        return `${addonName} missed ${reason.misses} checks in a row${err ? ` (${err})` : ''}. Switched to ${targetName}.`
    }
    return null
}

export function missedNote(platformName: string, error: string | undefined, previousName: string | null, retryAt: number | null, now: number): string {
    const parts = [`${platformName} did not take the change (${pushErrorText(error)}).`]
    if (previousName) parts.push(`${previousName} may still be on in ${platformName}.`)
    if (retryAt && retryAt > now) parts.push(`AIOManager retries ${platformName} automatically at ${format(retryAt, 'HH:mm')}.`)
    else if (retryAt) parts.push(`Retry was due at ${format(retryAt, 'HH:mm')}.`)
    return parts.join(' ')
}

export function notificationText(notified: HistoryDetail['notified'], delivered: boolean): string {
    if (notified === 'global') return `Global webhook, ${delivered ? 'sent' : 'failed to send'}`
    if (notified === 'rule') return `Rule webhook, ${delivered ? 'sent' : 'failed to send'}`
    return 'No notification'
}

export function eventTimeText(date: Date): string {
    return isToday(date) ? `Today, ${format(date, 'HH:mm')}` : format(date, 'MMM d, HH:mm')
}
