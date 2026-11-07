import { normalizeSyncError } from '../account-sync-chip.ts'
import type { PendingPushReason } from './pending-push.ts'

const PLATFORM_LABELS: Record<string, string> = { stremio: 'Stremio', nuvio: 'Nuvio', realstream: 'RealStream' }

export function platformLabel(platform: string): string {
    return PLATFORM_LABELS[platform] ?? (platform ? platform.charAt(0).toUpperCase() + platform.slice(1) : 'platform')
}

const SKIP_REASON_TEXT: Record<string, string> = {
    backoff: 'after repeated errors',
    'auth-cooldown': 'sign-in failed recently',
    'recent-write': 'another change was still saving',
    'overlay-fail-closed': 'an Autopilot rule could not be read',
    'empty-canonical': 'nothing to send',
    'no-driver': 'not supported',
}

const SKIP_SEPARATOR = ':'

/** Carries the server's skip reason on the pending reason so the line can name it. */
export function skippedReason(platform: string, reason?: string): PendingPushReason {
    return reason && SKIP_REASON_TEXT[reason] ? `push-skipped-${platform}${SKIP_SEPARATOR}${reason}` : `push-skipped-${platform}`
}

const SCOPED_PREFIXES = ['removed-', 'push-blocked-', 'push-skipped-', 'read-failed-'] as const

/** The platform a reason is about, or null for account-wide reasons. */
export function pendingReasonPlatform(reason: PendingPushReason): string | null {
    for (const prefix of SCOPED_PREFIXES) if (reason.startsWith(prefix)) return reason.slice(prefix.length).split(SKIP_SEPARATOR)[0]
    return null
}

export function resurrectedLine(count: number | undefined): string {
    if (!count || count < 1) return 'Removed addons are back on Stremio'
    return `${count} removed addon${count === 1 ? ' is' : 's are'} back on Stremio`
}

export type SyncHeaderState = 'offline' | 'syncing' | 'refreshing' | 'error' | 'idle' | 'synced'

export interface SyncHeaderInput {
    isAuthenticated: boolean
    isSyncing: boolean
    isRefreshing: boolean
    hasRecentError: boolean
    latestSyncAt: number | null
    failedAccounts: number
}

/** Pending work and decisions never change the header; only a real failure turns it to error. */
export function resolveSyncHeaderState({ isAuthenticated, isSyncing, isRefreshing, hasRecentError, latestSyncAt, failedAccounts }: SyncHeaderInput): SyncHeaderState {
    if (!isAuthenticated) return 'offline'
    if (isSyncing) return 'syncing'
    if (isRefreshing) return 'refreshing'
    if (hasRecentError || failedAccounts > 0) return 'error'
    return latestSyncAt === null ? 'idle' : 'synced'
}

const FAILURE_PREFIXES = ['push-blocked-', 'read-failed-'] as const

/** A rejected or guard-blocked push, a failed connection read, or a failed outcome the server reported. */
export const isSyncFailureReason = (reason: PendingPushReason): boolean =>
    reason === 'push-blocked' || FAILURE_PREFIXES.some(prefix => reason.startsWith(prefix))

export function syncFailureCause(reason: PendingPushReason): string {
    if (reason === 'push-blocked') return 'Stremio returned fewer addons than expected, so nothing was pushed.'
    const platform = platformLabel(pendingReasonPlatform(reason) ?? '')
    return reason.startsWith('read-failed-') ? `Couldn't read ${platform}, so nothing was pushed there.` : `${platform} did not accept the push.`
}

export const syncFailureHeadline = (accounts: number): string => `Sync failed for ${accounts} account${accounts === 1 ? '' : 's'}`

export interface SyncFailure {
    accountId: string
    name: string
    causes: string[]
}

/** One row per known account with a real failure; pending work and decisions are left out. */
export function summarizeSyncFailures(
    entries: ReadonlyArray<readonly [string, readonly PendingPushReason[]]>,
    names: ReadonlyMap<string, string>,
    accountErrors: ReadonlyMap<string, string | null | undefined> = new Map(),
): SyncFailure[] {
    const causes = new Map<string, string[]>()
    for (const [accountId, error] of accountErrors) causes.set(accountId, [normalizeSyncError(error)])
    for (const [accountId, reasons] of entries) {
        const found = reasons.filter(isSyncFailureReason).map(syncFailureCause)
        if (found.length > 0) causes.set(accountId, [...new Set([...(causes.get(accountId) ?? []), ...found])])
    }
    const failures: SyncFailure[] = []
    for (const [accountId, list] of causes) {
        const name = names.get(accountId)
        if (name !== undefined) failures.push({ accountId, name, causes: list })
    }
    return failures.sort((a, b) => a.name.localeCompare(b.name) || a.accountId.localeCompare(b.accountId))
}
