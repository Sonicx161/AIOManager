// Platform derivation for addon surfaces. An account's addon collection lives on every
// platform the account is connected to, so the source set is derived from its connections.
// This says nothing about any individual addon being verified as installed: the details
// surface describes sync targets and their last synced state, never confirmed presence.
// Pure helpers also run directly in the node:test suite.
// The account-scope section at the bottom additionally counts media platforms
// (Jellyfin) for the overall account chip; it never feeds addon sync.
import { isExcludedFromDestinations } from '../../lib/addon-destinations.ts'
import { normalizeAddonUrl } from '../../lib/addon-url.ts'
import type { AddonDescriptor } from '../../types/addon.ts'

// Display-safe subset of the media-server identity (src/types/connection.ts
// MediaServerIdentity): only names and timestamps. Credentials, user IDs, auth methods,
// and token-bearing addresses never enter this shape, so nothing downstream can render
// them. Structurally compatible with the real identity; no runtime import so
// node --test keeps working.
export interface PlatformMediaServerIdentity {
    product?: string
    productName?: string
    serverName?: string
    version?: string
    userName?: string
    lastCheckedAt?: number | Date | string
}

export interface PlatformSourceConnection {
    id?: string
    platform: string
    connectionType?: string
    driverType?: string
    enabled?: boolean
    status?: PlatformSyncStatus
    lastSync?: number | Date | string
    lastError?: string
    mediaServer?: PlatformMediaServerIdentity
}

export type PlatformSyncStatus = 'active' | 'expired' | 'error' | 'degraded' | 'pending'

export interface PlatformSourceAccount {
    id?: string
    addons?: Array<Pick<AddonDescriptor, 'transportUrl' | 'destinations'>>
    authKey?: string
    status?: 'active' | 'error' | 'expired'
    lastSync?: number | Date | string
    connections?: PlatformSourceConnection[]
}

// Saved-addon badges aggregate each account's OWN saved policy. Filtering out
// explicit Stremio rows must never revive their top-level legacy authKey mirror.
export function accountForAddonTargets(account: PlatformSourceAccount, addon: Pick<AddonDescriptor, 'transportUrl' | 'destinations'>): PlatformSourceAccount {
    const ownAddon = account.addons?.find(row => normalizeAddonUrl(row.transportUrl) === normalizeAddonUrl(addon.transportUrl)) ?? addon
    const connections = (account.connections || []).filter(connection => !isExcludedFromDestinations(ownAddon.destinations, {
        platform: connectionPlatform(connection), connectionId: connection.id,
    }))
    const hadExplicitStremio = (account.connections || []).some(connection => connectionPlatform(connection) === 'stremio')
    const implicitExcluded = isExcludedFromDestinations(ownAddon.destinations, {
        platform: 'stremio', connectionId: account.id ? `${account.id}:stremio` : undefined,
    })
    return { ...account, connections, authKey: hadExplicitStremio || implicitExcluded ? undefined : account.authKey }
}

// Hydra connections key on an app-specific platform slug; the source is Hydra itself, so
// they resolve to the same registry id as the other platforms.
function connectionPlatform(conn: PlatformSourceConnection): string {
    return (conn.connectionType || conn.driverType) === 'hydra-outbound' ? 'hydra-outbound' : conn.platform
}

// Ordered unique platform ids the addon collection lives on. Paused connections still
// count as sources: pausing sync never removes existing addons, so the collection keeps
// living on the platform. the chip's details say the sync is paused. A legacy Stremio
// session (authKey) only implies Stremio when NO explicit native Stremio connection
// exists; a paused explicit connection must not be resurrected as an active implicit one.
export function addonPlatformSources(account: PlatformSourceAccount | null | undefined): string[] {
    if (!account) return []
    const sources: string[] = []
    let hasExplicitStremio = false
    for (const conn of account.connections || []) {
        if (conn.platform === 'jellyfin') continue
        const platform = connectionPlatform(conn)
        if (platform === 'stremio') hasExplicitStremio = true
        if (!sources.includes(platform)) sources.push(platform)
    }
    if (!hasExplicitStremio && account.authKey && !sources.includes('stremio')) sources.push('stremio')
    return sources
}

// One detail row per enabled sync target, for the chip's accessible details popover.
// `implicit` marks the legacy Stremio session derived from the authKey; its state comes
// from the account itself because there is no Connection record to read.
export interface PlatformSyncTarget {
    platform: string
    implicit: boolean
    status: PlatformSyncStatus
    // ms epoch of the last successful sync; null = never synced (presence unverified).
    lastSync: number | null
    lastError?: string
    // Set by aggregation only: how many accounts contribute an enabled connection here.
    accountCount?: number
}

export interface AccountSyncTargets {
    targets: PlatformSyncTarget[]
    // Platforms whose connections are all switched off. Sync is paused there; existing
    // installations are unchanged and will not receive updates until re-enabled.
    paused: string[]
}

// Persisted JSON reloads can turn Date fields into ISO strings; accept all three shapes.
function toMs(value: number | Date | string | undefined | null): number | null {
    if (value === undefined || value === null) return null
    let ms: number
    if (typeof value === 'number') ms = value
    else if (typeof value === 'string') ms = Date.parse(value)
    else ms = value.getTime()
    return Number.isFinite(ms) && ms > 0 ? ms : null
}

// Honesty-first ordering: a failing or stale connection outranks a healthy-looking one.
const STATUS_RANK: Record<PlatformSyncStatus, number> = {
    expired: 0,
    error: 1,
    degraded: 2,
    pending: 3,
    active: 4,
}

function worstStatus(a: PlatformSyncStatus, b: PlatformSyncStatus): PlatformSyncStatus {
    return STATUS_RANK[a] <= STATUS_RANK[b] ? a : b
}

// Merge two same-platform targets: keep the freshest sync data, surface the worst status,
// and carry the lastError that BELONGS to that worst status, so a failing connection's
// reason is never dropped when a newer healthy connection wins the timestamp.
function mergeTargets(a: PlatformSyncTarget, b: PlatformSyncTarget): PlatformSyncTarget {
    const fresher = (b.lastSync ?? -1) > (a.lastSync ?? -1) ? b : a
    const worst = worstStatus(a.status, b.status)
    const errorCarrier =
        STATUS_RANK[a.status] < STATUS_RANK[b.status] ? a
        : STATUS_RANK[b.status] < STATUS_RANK[a.status] ? b
        : a.lastError ? a
        : b
    return { ...fresher, status: worst, lastError: errorCarrier.lastError }
}

export function accountSyncTargets(account: PlatformSourceAccount | null | undefined): AccountSyncTargets {
    if (!account) return { targets: [], paused: [] }
    const byPlatform = new Map<string, PlatformSyncTarget>()
    const pausedCandidates = new Set<string>()
    const enabledPlatforms = new Set<string>()
    let hasExplicitStremio = false

    for (const conn of account.connections || []) {
        if (conn.platform === 'jellyfin') continue
        const platform = connectionPlatform(conn)
        if (platform === 'stremio') hasExplicitStremio = true
        if (conn.enabled === false) {
            // A paused connection is not a sync target while paused, but the platform
            // keeps its existing addons. remember it so the details can say so.
            pausedCandidates.add(platform)
            continue
        }
        enabledPlatforms.add(platform)
        const target: PlatformSyncTarget = {
            platform,
            implicit: false,
            status: conn.status || 'pending',
            lastSync: toMs(conn.lastSync),
            lastError: conn.lastError,
        }
        const existing = byPlatform.get(platform)
        byPlatform.set(platform, existing ? mergeTargets(existing, target) : target)
    }

    // The legacy session only implies Stremio when no explicit native Stremio connection
    // exists at all (enabled or paused).
    if (!hasExplicitStremio && account.authKey) {
        byPlatform.set('stremio', {
            platform: 'stremio',
            implicit: true,
            status: account.status === 'expired' ? 'expired' : account.status === 'error' ? 'error' : 'active',
            lastSync: toMs(account.lastSync),
        })
    }

    // Coherence: a platform with both enabled and paused connections is actively syncing;
    // report it as paused only when every connection for it is paused.
    const paused = Array.from(pausedCandidates).filter(platform => !enabledPlatforms.has(platform))
    return { targets: Array.from(byPlatform.values()), paused }
}

export interface AddonPlatformChipState {
    reached: number
    total: number
    failing: boolean
}

// The addon card always shows its platforms; partial reach and failing targets are called out.
export function addonPlatformChipState(
    account: PlatformSourceAccount | null | undefined,
    addon: Pick<AddonDescriptor, 'transportUrl' | 'destinations'>,
): AddonPlatformChipState {
    if (!account) return { reached: 0, total: 0, failing: false }
    const total = addonPlatformSources(account).length
    const scoped = accountForAddonTargets(account, addon)
    const reached = addonPlatformSources(scoped).length
    const failing = accountSyncTargets(scoped).targets.some(t => t.status === 'error' || t.status === 'expired' || t.status === 'degraded')
    return { reached, total, failing }
}

// Hover text for the zero-reach chip: the account has platforms but this addon reaches
// none, so the empty list must never be interpolated into a "Syncs to ..." sentence.
export const ZERO_PLATFORM_REACH_HOVER_TEXT = "Not synced to any of this account's platforms"

export interface PlatformSourceSummary {
    // Union of platforms the collections live on, in first-seen order.
    platforms: string[]
    // Per-platform merged sync target state across all accounts.
    targets: PlatformSyncTarget[]
    // Platforms paused on every account that has them (not actively synced anywhere).
    paused: string[]
}

// Aggregate the sync-target state of several accounts. e.g. every account whose recorded
// list contains one saved addon. Per platform: freshest last sync as the base, the worst
// status (with its own lastError) so failures stay visible, and how many accounts
// contribute an enabled connection.
export function aggregatePlatformSources(accounts: Array<PlatformSourceAccount | null | undefined>): PlatformSourceSummary {
    const platforms: string[] = []
    const byPlatform = new Map<string, PlatformSyncTarget>()
    const counts = new Map<string, number>()
    const pausedCandidates = new Set<string>()

    for (const account of accounts) {
        if (!account) continue
        for (const platform of addonPlatformSources(account)) {
            if (!platforms.includes(platform)) platforms.push(platform)
        }
        const { targets, paused } = accountSyncTargets(account)
        for (const target of targets) {
            counts.set(target.platform, (counts.get(target.platform) || 0) + 1)
            const existing = byPlatform.get(target.platform)
            byPlatform.set(target.platform, existing ? mergeTargets(existing, target) : { ...target })
        }
        for (const platform of paused) pausedCandidates.add(platform)
    }

    // Coherence: a platform any account actively syncs is not paused overall.
    for (const platform of byPlatform.keys()) pausedCandidates.delete(platform)

    return {
        platforms,
        targets: Array.from(byPlatform.entries()).map(([platform, target]) => ({
            ...target,
            platform,
            accountCount: counts.get(platform) || 1,
        })),
        paused: Array.from(pausedCandidates),
    }
}

// ---------------------------------------------------------------------------
// Account-scope derivation (overall platform count/chip for ONE account).
//
// Everything above stays addon-only on purpose: addon sync must never treat a media
// platform as an addon target. The helpers below layer media platforms (Jellyfin-
// compatible servers) on top for account surfaces only: Jellyfin IS a platform there,
// counted once alongside Stremio/RealStream/Nuvio, and it provides playback/library
// for the signed-in remote user rather than receiving addons.
// ---------------------------------------------------------------------------

// Media connections are Jellyfin-compatible servers. They never join addonPlatformSources
// or accountSyncTargets; they surface through the helpers below instead.
function isMediaConnection(conn: PlatformSourceConnection): boolean {
    return conn.platform === 'jellyfin'
}

// Short chip display name. The registry's Jellyfin entry is a long setup-compatibility
// label ("Jellyfin, AIOStreams, AIOMetadata & more") meant to explain what you can
// connect, not to name a connected platform; connected surfaces want plain "Jellyfin".
export function platformShortName(platform: string): string {
    return platform === 'jellyfin' ? 'Jellyfin' : platform
}

// Media platforms connected to the account, deduped. Paused media connections still
// count: pausing a connection never disconnects the platform.
export function mediaPlatformSources(account: PlatformSourceAccount | null | undefined): string[] {
    if (!account) return []
    const platforms: string[] = []
    for (const conn of account.connections || []) {
        if (!isMediaConnection(conn)) continue
        if (!platforms.includes(conn.platform)) platforms.push(conn.platform)
    }
    return platforms
}

// Overall account-scope platform list: every addon platform plus every media platform,
// each counted once no matter how many connections exist (two Jellyfin servers are still
// one Jellyfin platform in the count). Paused connections of either kind still count as
// connected. Non-empty result = the account has connected platforms worth a chip.
// Addon sync must keep using addonPlatformSources instead.
export function accountPlatformSources(account: PlatformSourceAccount | null | undefined): string[] {
    if (!account) return []
    const platforms = addonPlatformSources(account)
    for (const platform of mediaPlatformSources(account)) {
        if (!platforms.includes(platform)) platforms.push(platform)
    }
    return platforms
}

export type PlatformMediaStatus = PlatformSyncStatus | 'paused'

export interface PlatformMediaTarget {
    platform: string
    // Actual product the server reports about itself (Jellyfin, AIOStreams, AIOMetadata…).
    product: string
    serverName?: string
    // Verified remote user's display name. User IDs are never carried here.
    userName?: string
    status: PlatformMediaStatus
    // ms epoch of the last successful verification; null = never verified.
    lastVerified: number | null
    lastError?: string
    // Set by aggregation only: how many connections contribute to this row.
    connectionCount?: number
}

// One detail row per media connection, for the account chip's "Playback & library"
// group. Reads only display-safe identity fields; falls back to the platform's short
// name when a server did not report a product name.
export function accountMediaTargets(account: PlatformSourceAccount | null | undefined): PlatformMediaTarget[] {
    if (!account) return []
    const media: PlatformMediaTarget[] = []
    for (const conn of account.connections || []) {
        if (!isMediaConnection(conn)) continue
        const identity = conn.mediaServer
        media.push({
            platform: conn.platform,
            product: identity?.productName || platformShortName(conn.platform),
            serverName: identity?.serverName || undefined,
            userName: identity?.userName || undefined,
            status: conn.enabled === false ? 'paused' : conn.status || 'pending',
            lastVerified: toMs(identity?.lastCheckedAt) ?? toMs(conn.lastSync),
            lastError: conn.lastError,
        })
    }
    return media
}

// Honesty-first ordering for media rows: a failing or stale connection outranks a
// healthy-looking one; a deliberately paused one is a fact, not a failure.
const MEDIA_STATUS_RANK: Record<PlatformMediaStatus, number> = {
    expired: 0,
    error: 1,
    degraded: 2,
    pending: 3,
    paused: 4,
    active: 5,
}

// Merge two media rows for the same platform/product/user/server: keep the freshest
// verification, surface the worst status with its own lastError, and count connections.
function mergeMediaTargets(a: PlatformMediaTarget, b: PlatformMediaTarget): PlatformMediaTarget {
    const fresher = (b.lastVerified ?? -1) > (a.lastVerified ?? -1) ? b : a
    // Pausing one connection does not pause a still-enabled sibling.
    const worst = a.status === 'paused' ? b.status : b.status === 'paused' ? a.status
        : MEDIA_STATUS_RANK[a.status] <= MEDIA_STATUS_RANK[b.status] ? a.status : b.status
    const errorCarrier =
        MEDIA_STATUS_RANK[a.status] < MEDIA_STATUS_RANK[b.status] ? a
        : MEDIA_STATUS_RANK[b.status] < MEDIA_STATUS_RANK[a.status] ? b
        : a.lastError ? a
        : b
    return {
        ...fresher,
        status: worst,
        lastError: errorCarrier.lastError,
        connectionCount: (a.connectionCount ?? 1) + (b.connectionCount ?? 1),
    }
}

export interface PlatformAccountSummary extends PlatformSourceSummary {
    // Media connection rows for the "Playback & library" group (account scope only).
    media: PlatformMediaTarget[]
}

// Account-scope summary for the platform chip: the overall platform set (addon +
// media, each platform once) plus the untouched addon-only sync-target detail and the
// media rows. aggregatePlatformSources semantics are reused verbatim, never changed.
export function aggregateAccountPlatforms(accounts: Array<PlatformSourceAccount | null | undefined>): PlatformAccountSummary {
    const summary = aggregatePlatformSources(accounts)
    const platforms = [...summary.platforms]
    const byMedia = new Map<string, PlatformMediaTarget>()
    for (const account of accounts) {
        if (!account) continue
        for (const platform of mediaPlatformSources(account)) {
            if (!platforms.includes(platform)) platforms.push(platform)
        }
        for (const target of accountMediaTargets(account)) {
            const key = `${target.platform}\u0000${target.product}\u0000${target.serverName ?? ''}\u0000${target.userName ?? ''}`
            const existing = byMedia.get(key)
            byMedia.set(key, existing ? mergeMediaTargets(existing, target) : { ...target, connectionCount: 1 })
        }
    }
    return { ...summary, platforms, media: Array.from(byMedia.values()) }
}
