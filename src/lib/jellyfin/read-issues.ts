import { describeMediaCause, type MediaReadCause, type MediaReadCauseCode } from './reads.ts'

export interface MediaReadIssueLike {
    accountId: string
    connectionId: string
    productName: string
    label: string
    message: string
    serverKey?: string
    cause?: MediaReadCause
}

export interface MediaIssueDetail {
    accountId: string
    accountName: string
    label: string
    text: string
    canReconnect: boolean
}

export interface MediaIssueEntry {
    key: string
    productName: string
    accountIds: string[]
    accountNames: string[]
    headline: string
    reconnectAccountId?: string
    details: MediaIssueDetail[]
}

export interface GroupedMediaIssues {
    entries: MediaIssueEntry[]
    hiddenCount: number
}

const MAX_ENTRIES = 3
const MAX_NAMES = 3
const RECONNECT_CAUSES: ReadonlySet<MediaReadCauseCode> = new Set(['auth-expired', 'denied', 'unlock'])
const CAUSE_PRIORITY: MediaReadCauseCode[] = ['auth-expired', 'unlock', 'denied', 'blocked', 'unreachable', 'timeout', 'server', 'rate-limited', 'not-found', 'unsupported', 'bad-response', 'unknown']

function joinNames(names: string[]): string {
    if (names.length <= MAX_NAMES) return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0]
    return `${names.slice(0, MAX_NAMES).join(', ')} +${names.length - MAX_NAMES} more`
}

/** Collapses per-read, per-connection failures into one entry per server. */
export function groupMediaReadIssues(issues: MediaReadIssueLike[], accountName: (accountId: string) => string): GroupedMediaIssues {
    const groups = new Map<string, { productName: string; issues: MediaReadIssueLike[] }>()
    const seen = new Set<string>()
    for (const issue of issues) {
        const cause = issue.cause ?? { code: 'unknown' as const }
        const dedupe = [issue.accountId, issue.connectionId, issue.label, cause.code, cause.httpStatus ?? ''].join('|')
        if (seen.has(dedupe)) continue
        seen.add(dedupe)
        const key = issue.serverKey ?? `${issue.productName}:${issue.connectionId}`
        const group = groups.get(key) ?? { productName: issue.productName, issues: [] }
        group.issues.push(issue)
        groups.set(key, group)
    }
    const all: MediaIssueEntry[] = []
    for (const [key, group] of groups) {
        const accountIds = [...new Set(group.issues.map(issue => issue.accountId))]
        const accountNames = [...new Set(accountIds.map(accountName))]
        const causes = group.issues.map(issue => issue.cause ?? { code: 'unknown' as const })
        const primary = causes.reduce((best, cause) => CAUSE_PRIORITY.indexOf(cause.code) < CAUSE_PRIORITY.indexOf(best.code) ? cause : best)
        const reconnectIssue = group.issues.find(issue => RECONNECT_CAUSES.has((issue.cause ?? { code: 'unknown' }).code))
        all.push({
            key,
            productName: group.productName,
            accountIds,
            accountNames,
            headline: `Couldn't refresh ${group.productName} for ${joinNames(accountNames)}. ${describeMediaCause(primary)} Your last saved history is still shown.`,
            ...(reconnectIssue ? { reconnectAccountId: reconnectIssue.accountId } : {}),
            details: group.issues.map(issue => ({
                accountId: issue.accountId,
                accountName: accountName(issue.accountId),
                label: issue.label,
                text: issue.cause ? describeMediaCause(issue.cause) : issue.message,
                canReconnect: RECONNECT_CAUSES.has((issue.cause ?? { code: 'unknown' }).code),
            })),
        })
    }
    return { entries: all.slice(0, MAX_ENTRIES), hiddenCount: Math.max(0, all.length - MAX_ENTRIES) }
}
