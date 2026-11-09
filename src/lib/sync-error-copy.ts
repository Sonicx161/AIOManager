// Maps a raw sync error string to user-facing copy. Pure and dependency-free so
// it can be unit tested with plain `node --test` and reused by cards and the
// history notification. Classification is based on the real error strings the
// sync pipeline throws (src/api/connection.ts, src/api/stremio-client.ts,
// src/lib/drivers/nuvio.ts, src/lib/drivers/realstream.ts,
// src/lib/api-resilience.ts, src/store/account/accountSync.ts); anything not
// recognised stays 'unknown' and keeps the generic fallback copy.

export type SyncErrorKind = 'signin-lost' | 'signin-expired' | 'unreachable' | 'unknown'

export type SyncErrorTone = 'warning' | 'destructive'

export interface SyncErrorPanelCopy {
    kind: SyncErrorKind
    tone: SyncErrorTone
    title: string
    body: string
    /** 'signin': one amber "Sign in to X" button. 'retry': one red "Try again now" button. 'retry-or-edit': red "Try again" plus neutral "Edit account". */
    action: 'signin' | 'retry' | 'retry-or-edit'
    actionLabel: string
    secondaryActionLabel?: string
}

export interface HistoryNoticeCopy {
    kind: SyncErrorKind
    variant: SyncErrorTone
    title: string
    body: string
    action: 'signin' | 'open'
    actionLabel: string
}

/** Structured auth facts a caught driver error may carry (src/lib/drivers/*): preferred over string matching. */
export interface SyncErrorHint {
    status?: number | null | undefined
    isAuthError?: boolean | null | undefined
}

// Ordered most specific first. 'Token fetch failed (404)' means the server no
// longer has the credential row for the connection, which is a lost sign-in,
// not an expired one.
const isSignInLost = (message: string): boolean =>
    message.includes('token fetch failed') && message.includes('404')

// Nuvio RPC and RealStream HTTP failures end in 'returned 401'/'returned 403';
// token fetch/refresh failures write the status in parentheses or after a colon.
const AUTH_STATUS_TEXT = /\breturned\s+(401|403)\b|\bfailed\s*[(:]?\s*(401|403)\b/

const isSignInExpired = (message: string): boolean =>
    message.includes('session expired') ||
    message.includes('invalid or expired auth key') ||
    message.includes('invalid auth key') ||
    message.includes('session does not exist') ||
    message.includes('unauthorized') ||
    message.includes('re-authenticate') ||
    AUTH_STATUS_TEXT.test(message)

const isUnreachable = (message: string): boolean =>
    message.includes('network error') ||
    message.includes('failed to fetch') ||
    message.includes('timed out') ||
    message.includes('timeout') ||
    message.includes('could not reach') ||
    message.includes('econnreset') ||
    message.includes('etimedout') ||
    message.includes('proxy failed')

export function classifySyncError(rawError: string | null | undefined, hint?: SyncErrorHint): SyncErrorKind {
    // A structured status from the caught error (driver err.status/isAuthError)
    // is authoritative; string matching only fills in when it is absent.
    if (hint?.isAuthError === true) return 'signin-expired'
    if (hint?.status === 401 || hint?.status === 403) return 'signin-expired'
    const message = (rawError ?? '').toLowerCase()
    if (!message) return 'unknown'
    if (isSignInLost(message)) return 'signin-lost'
    if (isSignInExpired(message)) return 'signin-expired'
    if (isUnreachable(message)) return 'unreachable'
    return 'unknown'
}

/**
 * Copy for the account card's "Sync failed" panel. `platform` is a display name
 * like "Nuvio", or null when the failing connection cannot be identified: the
 * sign-in fix then stays platform-neutral instead of naming the wrong platform.
 */
export function syncErrorPanelCopy(rawError: string | null | undefined, platform: string | null, hint?: SyncErrorHint): SyncErrorPanelCopy {
    const kind = classifySyncError(rawError, hint)
    switch (kind) {
        case 'signin-lost':
            return {
                kind,
                tone: 'warning',
                title: platform ? `Sign in to ${platform} again` : 'Sign in again',
                body: platform
                    ? `AIOManager no longer has the ${platform} sign-in for this profile, so it can't sync. Your addons are safe.`
                    : "AIOManager no longer has the sign-in for this profile, so it can't sync. Your addons are safe.",
                action: 'signin',
                actionLabel: platform ? `Sign in to ${platform}` : 'Sign in again',
            }
        case 'signin-expired':
            return {
                kind,
                tone: 'warning',
                title: platform ? `${platform} sign-in expired` : 'Sign-in expired',
                body: platform
                    ? `${platform} signed this profile out. Sign in again and syncing picks up where it left off.`
                    : 'This profile was signed out. Sign in again and syncing picks up where it left off.',
                action: 'signin',
                actionLabel: platform ? `Sign in to ${platform}` : 'Sign in again',
            }
        case 'unreachable':
            return {
                kind,
                tone: 'destructive',
                title: platform ? `Can't reach ${platform} right now` : "Can't sync right now",
                body: platform
                    ? `${platform} or your connection may be down. Nothing to fix on your side; AIOManager tries again on its own.`
                    : 'The platform or your connection may be down. Nothing to fix on your side; AIOManager tries again on its own.',
                action: 'retry',
                actionLabel: 'Try again now',
            }
        default:
            return {
                kind: 'unknown',
                tone: 'destructive',
                title: 'Sync failed',
                body: `Something went wrong syncing this profile. Try again; if it keeps failing, check the account's sign-in.`,
                action: 'retry-or-edit',
                actionLabel: 'Try again',
                secondaryActionLabel: 'Edit account',
            }
    }
}

/**
 * Copy for the watch-history notification when a Nuvio or RealStream history
 * fetch fails. Returns null for unknown errors so callers keep their existing
 * generic text. `platform` and `profile` are display names. When the caught
 * error carries a structured status, pass it as `hint` so it wins over strings.
 */
export function historyNoticeCopy(rawError: string | null | undefined, platform: string, profile: string, hint?: SyncErrorHint): HistoryNoticeCopy | null {
    const kind = classifySyncError(rawError, hint)
    switch (kind) {
        case 'signin-lost':
        case 'signin-expired':
            return {
                kind,
                variant: 'warning',
                title: `Sign in to ${platform} again`,
                body: `${profile} lost its ${platform} sign-in, so new watch history can't load. Showing what was saved before.`,
                action: 'signin',
                actionLabel: `Sign in to ${platform}`,
            }
        case 'unreachable':
            return {
                kind,
                variant: 'destructive',
                title: `${platform} history is out of date`,
                body: `Couldn't reach ${platform} for ${profile}. Showing what was saved before; AIOManager keeps trying on its own.`,
                action: 'open',
                actionLabel: 'Open profile',
            }
        default:
            return null
    }
}

export interface ErrorAttributionConnection {
    id: string
    platform: string
    enabled?: boolean
    status?: string
    lastError?: string | null
}

export interface AccountErrorAttribution {
    /** The connection whose own failure produced the account error, when identifiable. */
    connectionId?: string
    /** That connection's platform id, for display via platformName(). */
    platformId?: string
}

/**
 * Binds the account error panel to one failure: the connection credited with
 * the account's lastError is the one whose own lastError matches it. When no
 * enabled failing connection (or more than one) carries that exact message the
 * attribution is uncertain and callers must stay platform-neutral. A root auth
 * key account has exactly one implicit sign-in, Stremio, when no connection
 * fails.
 */
export function attributeAccountError(
    lastError: string | null | undefined,
    connections: ErrorAttributionConnection[] | undefined,
    opts: { rootStremioAuthKey?: boolean } = {},
): AccountErrorAttribution {
    const failing = (connections ?? []).filter(c => c.enabled !== false && (c.status === 'error' || c.status === 'expired'))
    if (lastError) {
        const matches = failing.filter(c => (c.lastError ?? '') === lastError)
        if (matches.length === 1) return { connectionId: matches[0].id, platformId: matches[0].platform }
    }
    if (opts.rootStremioAuthKey && failing.length === 0) return { platformId: 'stremio' }
    return {}
}
