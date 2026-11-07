import type { Connection, ConnectionStatus } from '@/types/connection'

export function timeAgo(ts?: number | null): string {
    if (!ts) return 'never'
    const diff = Date.now() - ts
    if (diff < 60_000) return 'just now'
    const m = Math.floor(diff / 60_000)
    if (m < 60) return `${m}m ago`
    const h = Math.floor(m / 60)
    if (h < 24) return `${h}h ago`
    const d = Math.floor(h / 24)
    if (d < 30) return `${d}d ago`
    return `${Math.floor(d / 30)}mo ago`
}

export type ExpiryState = 'none' | 'ok' | 'expiring' | 'expired'

export interface TokenExpiry {
    state: ExpiryState
    daysLeft: number | null
    label: string | null
}

const AUTO_REFRESH_PLATFORMS = new Set(['nuvio', 'realstream'])

const EXPIRING_THRESHOLD_DAYS = 7

export function tokenExpiry(connection: Connection): TokenExpiry {
    if (AUTO_REFRESH_PLATFORMS.has(connection.platform)) return { state: 'none', daysLeft: null, label: null }
    const raw = connection.credentials?.expiresAt
    if (!raw) return { state: 'none', daysLeft: null, label: null }
    const ts = Number(raw)
    if (!Number.isFinite(ts) || ts <= 0) return { state: 'none', daysLeft: null, label: null }
    const diff = ts - Date.now()
    if (diff <= 0) return { state: 'expired', daysLeft: 0, label: 'Session expired' }
    const days = Math.ceil(diff / 86_400_000)
    if (days <= EXPIRING_THRESHOLD_DAYS) {
        return { state: 'expiring', daysLeft: days, label: days <= 1 ? 'Session expires today' : `Session expires in ${days} days` }
    }
    return { state: 'ok', daysLeft: days, label: `Session valid for ${days} days` }
}

// Connections that expose a refreshable server-side session token we can probe with a "Test"
// action via the token endpoint. Stremio reconciles through the account authKey and Hydra uses a
// static API key (tested at setup), so neither has a per-connection token to probe here.
export function canTestConnection(connection: Connection): boolean {
    return connection.platform === 'nuvio' || connection.platform === 'realstream'
}

export type DisplayStatus = ConnectionStatus | 'expiring'

// The sync path stores raw browser error strings (TypeError messages) as lastError. Map the
// generic network failure to a sentence that says what failed and what to try; anything already
// readable passes through untouched.
export function friendlyConnectionError(message: string | null | undefined): string {
    const text = (message || '').trim()
    if (/^failed to fetch$/i.test(text)) {
        return 'Could not reach the server. Check that the server is online and reachable from this device, then sync again.'
    }
    return text
}

export function displayStatus(status: ConnectionStatus, expiry: TokenExpiry): DisplayStatus {
    if (status === 'expired') return 'expired'
    if (status === 'active' && expiry.state === 'expiring') return 'expiring'
    if (status === 'active' && expiry.state === 'expired') return 'expired'
    return status
}

export interface ConnectionStatusLineParts {
    /** Row label; an identity identical to it is dropped instead of repeated. */
    name: string
    identity?: string
    addonCount?: number
    enabled: boolean
    platform: string
    lastSync?: number | null
    mediaServerLastCheckedAt?: number | null
}

export interface ConnectionStatusParts {
    identity?: string
    /** Addon count plus sync freshness, joined for display. */
    activity: string
}

/**
 * The parts behind the one status line under a connection row, split so narrow
 * layouts can wrap the identity away from the activity instead of truncating.
 */
export function connectionStatusParts({ name, identity, addonCount, enabled, platform, lastSync, mediaServerLastCheckedAt }: ConnectionStatusLineParts): ConnectionStatusParts {
    const shownIdentity = identity && identity !== name ? identity : undefined
    const syncedAt = platform === 'jellyfin' ? (mediaServerLastCheckedAt || lastSync) : lastSync
    const syncLabel = !enabled
        ? 'Sync paused'
        : !syncedAt
            ? 'Not synced yet'
            : platform === 'jellyfin'
                ? `Verified ${timeAgo(syncedAt)}`
                : `Synced ${timeAgo(syncedAt)}`
    return {
        identity: shownIdentity,
        activity: [
            addonCount !== undefined ? `${addonCount} addons` : undefined,
            syncLabel,
        ].filter(Boolean).join(' \u00b7 '),
    }
}

/**
 * The ONE status line under a connection row: signed-in identity, addon count,
 * sync freshness. Platform details (profiles, hints, expiry wording) live behind
 * the chevron in the edit panel instead.
 */
export function connectionStatusLine(parts: ConnectionStatusLineParts): string {
    const { identity, activity } = connectionStatusParts(parts)
    return [identity, activity].filter(Boolean).join(' \u00b7 ')
}
