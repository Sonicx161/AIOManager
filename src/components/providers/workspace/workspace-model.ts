import type { Connection } from '../../../types/connection.ts'
import type { NuvioMemberStatus } from '../../../lib/nuvio-tier.ts'

export type WorkspaceKind = 'stremio' | 'nuvio' | 'realstream' | 'hydra-outbound' | 'jellyfin' | 'hydra-pull' | 'other'

export interface WorkspaceTabDef {
    id: string
    label: string
    readOnly?: boolean
    count?: number
}

export const DEFAULT_WORKSPACE_TAB = 'overview'

// Outbound targets carry a slug of their display name as `platform`, so a
// target named "Nuvio" must still resolve to the outbound workspace.
export function workspaceKind(connection: Pick<Connection, 'platform' | 'connectionType'>): WorkspaceKind {
    if (connection.connectionType === 'hydra-outbound') return 'hydra-outbound'
    if (connection.connectionType === 'hydra-inbound') return 'other'
    switch (connection.platform) {
        case 'stremio':
        case 'nuvio':
        case 'realstream':
        case 'jellyfin':
            return connection.platform
        default:
            return 'other'
    }
}

export function workspaceTabsFor(kind: WorkspaceKind, options: { supportersProfiles?: boolean } = {}): WorkspaceTabDef[] {
    const overview = { id: DEFAULT_WORKSPACE_TAB, label: 'Overview' }
    const connection = { id: 'connection', label: 'Connection' }
    switch (kind) {
        case 'stremio':
            return [
                overview,
                { id: 'library', label: 'Library' },
                ...(options.supportersProfiles ? [{ id: 'profiles', label: 'Profiles' }] : []),
                connection,
            ]
        case 'nuvio':
            return [
                overview,
                { id: 'profiles', label: 'Profiles' },
                { id: 'plugins', label: 'Plugins' },
                { id: 'library', label: 'Library', readOnly: true },
                { id: 'collections', label: 'Collections', readOnly: true },
                { id: 'backup', label: 'Backup' },
                connection,
            ]
        case 'realstream':
            return [overview, connection]
        case 'jellyfin':
            return [overview, { id: 'history', label: 'Watch history' }, connection]
        case 'hydra-outbound':
        case 'hydra-pull':
        case 'other':
            return [overview, connection]
    }
}

export function resolveWorkspaceTab(tabs: readonly Pick<WorkspaceTabDef, 'id'>[], value: string | null | undefined): string {
    return value && tabs.some(tab => tab.id === value) ? value : DEFAULT_WORKSPACE_TAB
}

export type SessionState = 'Re-auth required' | 'Sign in required' | 'Auth key stored' | 'Session stored' | 'Silent re-auth ready' | 'Manual re-auth' | 'Static API key' | 'No session'

// A stored key or token proves a session is saved, not that the platform is
// reachable, so the label never claims live presence.
export function sessionState(connection: Pick<Connection, 'platform' | 'connectionType' | 'credentials'>, display: string): SessionState {
    const kind = workspaceKind(connection)
    const creds = connection.credentials || {}
    if (kind === 'hydra-outbound') return 'Static API key'
    if (kind === 'stremio') {
        if (display === 'expired') return 'Re-auth required'
        return creds.authKey ? 'Auth key stored' : 'Sign in required'
    }
    if (kind === 'nuvio') {
        if (display === 'expired' || display === 'error') return 'Re-auth required'
        return creds.accessToken ? 'Session stored' : 'Sign in required'
    }
    if (kind === 'realstream') {
        if (display === 'expired' || display === 'error') return 'Re-auth required'
        return creds.password ? 'Silent re-auth ready' : 'Manual re-auth'
    }
    return creds.accessToken ? 'Session stored' : 'No session'
}

export function needsReauth(session: SessionState): boolean {
    return session === 'Re-auth required' || session === 'Sign in required'
}

// A paused connection is not expected to sync, so it never reads "Not synced yet".
export function syncSummary(enabled: boolean, lastSync: number | null | undefined, ago: (ts: number) => string): { value: string; sub: string } {
    if (!enabled) return { value: 'Paused', sub: 'Enable to sync again' }
    if (!lastSync) return { value: 'Not synced yet', sub: 'Runs on the next sync' }
    return { value: ago(lastSync), sub: new Date(lastSync).toLocaleString() }
}

// Nuvio perks as listed on nuvio.tv/support. Static copy, not read from the API.
export const NUVIO_PERKS: ReadonlyArray<{ id: string; label: string; detail: string; tier: 'supporter' | 'supporter-plus' }> = [
    { id: 'themes', label: 'Gradient themes', detail: 'In the Nuvio app', tier: 'supporter' },
    { id: 'backgrounds', label: 'Profile backgrounds', detail: 'In the Nuvio app', tier: 'supporter' },
    { id: 'avatars', label: 'Avatar collection', detail: 'Pick them for profiles here', tier: 'supporter' },
    { id: 'badge', label: 'Supporter badge', detail: 'Shown on your Nuvio profile', tier: 'supporter' },
    { id: 'discord', label: 'Discord role', detail: 'Claim it on nuvio.tv', tier: 'supporter' },
    { id: 'voting', label: 'Feature voting', detail: 'Vote on what Nuvio builds next', tier: 'supporter-plus' },
    { id: 'plus-role', label: 'Plus role', detail: 'Discord role for Plus members', tier: 'supporter-plus' },
]

export function nuvioPerkUnlocked(member: Pick<NuvioMemberStatus, 'tier' | 'supporter'> | undefined, perkTier: 'supporter' | 'supporter-plus'): boolean {
    if (!member?.supporter) return false
    if (member.tier === 'supporter-plus') return true
    if (member.tier === 'supporter') return perkTier === 'supporter'
    return false
}

export interface NuvioMembershipView {
    tier: NuvioMemberStatus['tier']
    label: string
    /** One detail line that never repeats the tier label. */
    detail: string
    /** Set only when Nuvio reported an end date. */
    endsAt: number | null
    perksUnlocked: number | null
    perksTotal: number
    discord: string
}

export function nuvioMembershipView(member: NuvioMemberStatus, formatDate: (ts: number) => string): NuvioMembershipView {
    const endsAt = typeof member.expiresAt === 'number' && Number.isFinite(member.expiresAt) ? member.expiresAt : null
    const known = member.tier === 'free' || member.tier === 'supporter' || member.tier === 'supporter-plus'
    const detail = !member.supporter
        ? 'No supporter perks on this account'
        : endsAt != null
            ? `Active until ${formatDate(endsAt)}`
            : 'Active. Nuvio reports no end date.'
    return {
        tier: member.tier,
        label: member.label,
        detail,
        endsAt,
        perksUnlocked: known ? NUVIO_PERKS.filter(p => nuvioPerkUnlocked(member, p.tier)).length : null,
        perksTotal: NUVIO_PERKS.length,
        discord: member.supporter ? 'Claim on nuvio.tv' : 'Not included',
    }
}

// Driver errors name the RPC; users get plain words instead.
export function membershipErrorMessage(error: unknown): string {
    const status = typeof error === 'object' && error !== null ? (error as { status?: unknown }).status : undefined
    if (status === 401 || status === 403) return 'Nuvio rejected the saved session. Re-authenticate this connection, then refresh.'
    if (typeof status === 'number' && status >= 500) return 'Nuvio is not answering right now. Try again in a moment.'
    return 'Could not read your membership from Nuvio. Check the connection and try again.'
}

export function backendLabel(baseUrl: string | undefined, defaultUrl: string): { host: string; custom: boolean } {
    const raw = (baseUrl || '').trim()
    const target = raw || defaultUrl
    let host = target
    try { host = new URL(target).host } catch { /* keep raw */ }
    const normalize = (url: string) => url.replace(/\/+$/, '').toLowerCase()
    return { host, custom: !!raw && normalize(raw) !== normalize(defaultUrl) }
}

// Pull apps read from AIOManager's own /hydra surface at the instance root.
export function hydraPullUrl(serverUrl: string | undefined, origin: string): string {
    const raw = (serverUrl || '').trim().replace(/\/+$/, '')
    const base = /^https?:\/\//i.test(raw) ? raw.replace(/\/api$/i, '') : origin.replace(/\/+$/, '')
    return `${base}/hydra`
}

export const PULL_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000

export function pullFreshness(lastSeenAt: number | null | undefined, now: number): 'synced' | 'stale' | 'never' {
    if (!lastSeenAt) return 'never'
    return now - lastSeenAt > PULL_STALE_AFTER_MS ? 'stale' : 'synced'
}

// The install URL needs the encrypted password the user endpoint returns
// beside userData, never inside it.
export function aiostreamsInstallUrl(baseUrl: string, uuid: string | undefined, encryptedPassword: string | null | undefined): string | null {
    if (!baseUrl || !uuid || !encryptedPassword) return null
    return `${baseUrl.replace(/\/+$/, '')}/stremio/${uuid}/${encryptedPassword}/manifest.json`
}

export function tokenExpiresIn(expiresAt: string | number | undefined, now: number): { label: string; expired: boolean } | null {
    const ts = Number(expiresAt)
    if (!Number.isFinite(ts) || ts <= 0) return null
    const ms = ts < 1e12 ? ts * 1000 : ts
    const diff = ms - now
    if (diff <= 0) return { label: 'Expired', expired: true }
    const days = Math.floor(diff / 86_400_000)
    if (days >= 1) return { label: `Expires in ${days} day${days === 1 ? '' : 's'}`, expired: false }
    const hours = Math.max(1, Math.floor(diff / 3_600_000))
    return { label: `Expires in ${hours} hour${hours === 1 ? '' : 's'}`, expired: false }
}

export function statusSentence(pill: string, kind: WorkspaceKind): string {
    const pushes = kind === 'jellyfin' ? 'AIOManager reads from this server.' : 'Addons push on every sync.'
    switch (pill) {
        case 'disabled': return kind === 'jellyfin' ? 'Paused. AIOManager skips this server.' : 'Paused. AIOManager skips this connection during sync.'
        case 'active': return `Working. ${pushes}`
        case 'expiring': return 'Working, but the session expires soon.'
        case 'expired': return 'Session expired. Sign in again to resume.'
        case 'error': return 'The last check or sync failed.'
        case 'degraded': return 'Working with errors. Some reads or pushes failed.'
        case 'pending': return 'Waiting for sign-in or a first sync.'
        default: return ''
    }
}

// Nuvio driver errors name the RPC or table; workspace tabs show plain words.
export function nuvioReadErrorMessage(error: unknown): string {
    const status = typeof error === 'object' && error !== null ? (error as { status?: unknown }).status : undefined
    if (status === 401 || status === 403) return 'Nuvio rejected the saved session. Re-authenticate this connection on the Connection tab.'
    if (typeof status === 'number' && status >= 500) return 'Nuvio is not answering right now. Try again in a moment.'
    const message = error instanceof Error ? error.message : ''
    if (typeof status === 'number' || /^Nuvio \w+/.test(message) && /returned \d+/.test(message)) return `Nuvio returned an error${typeof status === 'number' ? ` (${status})` : ''}. Try again.`
    return message || 'Could not load. Try re-authenticating this connection.'
}
