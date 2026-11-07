// Connection pictures: derive the picture-target rows for one account
// (owner spec 2026-11-05 option C, scope change 2026-11-05). Pure over its
// inputs; IO lives in the account editor component.
//
// Scope: the Jellyfin family only. Native Jellyfin users (facades excluded,
// they have their own rows) plus one link-only row per AIOStreams and
// AIOMetadata instance the account is signed into through a Jellyfin
// connection (a plain Stremio addon alone has no Jellyfin login picture). Stremio, Nuvio and
// RealStream rows were removed with their write paths; pull apps (Hydra,
// Fusion) never appear because they have no picture surface.

import type { Account } from '../../types/account.ts'
import type { Connection } from '../../types/connection.ts'
import type { PictureRow } from './types.ts'

export interface FacadeInstanceHint {
    baseUrl: string
    uuid: string
    /** Config password resolvable (vault unlocked); without it the row stays but cannot write. */
    passwordResolved: boolean
    /**
     * Instance secret capability confirmed. AIOMetadata: verified with a
     * read-only authenticated load. AIOStreams (CP-R3-001): the user supplied
     * the access key or declared the instance keyless; the row unlocks and the
     * user-confirmed write performs the only key check upstream offers.
     * Unconfirmed rows are read-only so a protected instance never receives a
     * silent write.
     */
    accessConfirmed?: boolean
    /** Global facade write switch (facade-avatar.ts FACADE_AVATAR_WRITE_ENABLED). */
    writeEnabled?: boolean
}

/** A Jellyfin login on an AIOStreams/AIOMetadata facade, from its decrypted credentials. */
export interface FacadeLoginHint {
    product: 'aiostreams' | 'aiometadata'
    /** Lower-cased origin of the facade server the login points at. */
    origin: string
    /** Jellyfin user id and name of the login; a facade may key them on the config uuid. */
    userKeys: string[]
}

export function facadeOrigin(baseUrl: string): string | null {
    try { return new URL(baseUrl).origin.toLowerCase() } catch { return null }
}

/**
 * True when the account has a Jellyfin login on this facade instance's server. When
 * several instances of the product share that server, the login must name this
 * instance's uuid, so a row never attaches to someone else's config on a shared host.
 */
export function facadeInstanceHasLogin(
    product: FacadeLoginHint['product'],
    instance: { baseUrl: string; uuid: string },
    logins: readonly FacadeLoginHint[],
    sameProductInstances: ReadonlyArray<{ baseUrl: string; uuid: string }>,
): boolean {
    const origin = facadeOrigin(instance.baseUrl)
    if (!origin) return false
    const matches = logins.filter(l => l.product === product && l.origin === origin)
    if (matches.length === 0) return false
    const sharing = sameProductInstances.filter(i => facadeOrigin(i.baseUrl) === origin)
    if (sharing.length <= 1) return true
    return matches.some(l => l.userKeys.includes(instance.uuid))
}

export interface PictureTargetsInput {
    account: Pick<Account, 'connections' | 'addons'>
    /** AIOStreams instances parsed from this account's addons, passwords pre-resolved. */
    aiostreamsInstances?: FacadeInstanceHint[]
    /** AIOMetadata instances parsed from this account's addons, passwords pre-resolved. */
    aiometadataInstances?: FacadeInstanceHint[]
}

const connectionEnabled = (c: Connection) => c.enabled !== false && c.status !== 'expired' && c.status !== 'pending'

/** One row per picture target: native Jellyfin users and the AIOS/AIOM Jellyfin logins. */
export function buildPictureTargets(input: PictureTargetsInput): PictureRow[] {
    const rows: PictureRow[] = []
    const connections = input.account.connections ?? []

    for (const c of connections) {
        if (!connectionEnabled(c)) continue
        if (c.platform !== 'jellyfin') continue
        // Native Jellyfin servers only: the facade products (aiostreams/aiometadata)
        // accept no image uploads and are covered by their own config rows.
        if (c.mediaServer?.product !== 'jellyfin') continue
        rows.push({
            id: `jellyfin:${c.id}`,
            platform: 'jellyfin',
            label: 'Jellyfin',
            sub: c.mediaServer.userName || c.displayName || 'User',
            linkOnly: false,
        })
    }

    function facadeReadOnlyReason(inst: FacadeInstanceHint, needsKey: string): string | undefined {
        if (inst.writeEnabled === false) return 'Connection picture writes are off for this platform'
        if (!inst.passwordResolved) return 'Unlock the vault to change this picture'
        if (!inst.accessConfirmed) return needsKey
        return undefined
    }

    for (const inst of input.aiostreamsInstances ?? []) {
        rows.push({
            id: `aiostreams:${inst.baseUrl}|${inst.uuid}`,
            platform: 'aiostreams',
            label: 'AIOStreams',
            sub: 'Jellyfin login picture',
            linkOnly: true,
            readOnlyReason: facadeReadOnlyReason(inst, 'Needs the AIOStreams instance access key'),
        })
    }
    for (const inst of input.aiometadataInstances ?? []) {
        rows.push({
            id: `aiometadata:${inst.baseUrl}|${inst.uuid}`,
            platform: 'aiometadata',
            label: 'AIOMetadata',
            sub: 'Jellyfin login picture',
            linkOnly: true,
            readOnlyReason: facadeReadOnlyReason(inst, 'Needs the AIOMetadata addon password'),
        })
    }

    return rows
}
