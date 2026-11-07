import type { Connection } from '@/types/connection'
import type { createNuvioDriver } from '@/lib/drivers/nuvio'
import type { NuvioAvatar } from './nuvio-avatars.ts'
import { readAvatarCatalogCached } from './nuvio-avatar-catalog-cache.ts'

type NuvioDriver = ReturnType<typeof createNuvioDriver>

export interface NuvioLibraryItem {
    content_id: string
    content_type?: string
    name?: string
    poster?: string
    poster_shape?: string
    background?: string
    description?: string
    release_info?: string
    imdb_rating?: string | number
    genres?: string[]
    addon_base_url?: string
    added_at?: number
}

export interface NuvioCollection {
    id?: string
    title?: string
    backdropImageUrl?: string
    pinToTop?: boolean
    viewMode?: string
    showAllTab?: boolean
    folders?: Array<Record<string, unknown>>
}

// Keeps the first value seen for a read identity, so a rewrite of the same target reuses it.
export function holdForReadIdentity<T>(held: { identity: string; value: T } | null, identity: string, value: T): { identity: string; value: T } {
    return held && held.identity === identity ? held : { identity, value }
}

async function withNuvio<T>(
    accountId: string,
    conn: Connection,
    fn: (driver: NuvioDriver, accessToken: string, profileId?: string | number) => Promise<T>,
): Promise<T> {
    const { fetchConnectionToken, hashRejectedToken, isNuvioJwtAuthError } = await import('@/api/connection')
    const { nuvioDriverFor } = await import('@/lib/drivers/factory')
    const { getOrFetchNuvioToken } = await import('@/lib/nuvio-token-cache')
    const scope = { accountId, baseUrl: conn.credentials?.baseUrl }
    let token = await getOrFetchNuvioToken(conn.id, () => fetchConnectionToken(accountId, conn.id, 'nuvio', conn.credentials?.baseUrl), scope)
    const driver = nuvioDriverFor(conn)
    try {
        return await fn(driver, token.accessToken, token.profileId ?? conn.credentials?.profileId)
    } catch (error) {
        const { isAuthError } = await import('@/store/accountStore')
        if (!isAuthError(error)) throw error
        // A JWT-type 401 names the exact rejected token by hash so the server force-revalidates it.
        const forcedHash = isNuvioJwtAuthError(error) ? await hashRejectedToken(token.accessToken) : undefined
        const { invalidateNuvioToken } = await import('@/lib/nuvio-token-cache')
        invalidateNuvioToken(conn.id, scope)
        token = await getOrFetchNuvioToken(conn.id, () => fetchConnectionToken(accountId, conn.id, 'nuvio', conn.credentials?.baseUrl, forcedHash ? { rejectedTokenHash: forcedHash } : undefined), scope)
        return fn(driver, token.accessToken, token.profileId ?? conn.credentials?.profileId)
    }
}

export function readNuvioLibrary(accountId: string, conn: Connection): Promise<NuvioLibraryItem[]> {
    return withNuvio(accountId, conn, (d, t, p) => d.readLibrary(t, p)) as Promise<NuvioLibraryItem[]>
}

export function readNuvioCollections(accountId: string, conn: Connection): Promise<NuvioCollection[]> {
    return withNuvio(accountId, conn, (d, t, p) => d.readCollections(t, p)) as Promise<NuvioCollection[]>
}

export interface NuvioProfileRow {
    id: string
    profile_index: number
    name: string
    avatar_color_hex?: string
    avatar_id?: string
}

export function readNuvioProfiles(accountId: string, conn: Connection, opts: { fresh?: boolean } = {}): Promise<NuvioProfileRow[]> {
    return withNuvio(accountId, conn, async (d, t) => {
        const rows = await d.pullProfiles(t, { fresh: opts.fresh })
        return rows.map(r => ({
            id: String(r.id ?? ''),
            profile_index: Number(r.profile_index ?? r.profileIndex ?? 0),
            name: String(r.name ?? 'Profile'),
            avatar_color_hex: typeof r.avatar_color_hex === 'string' ? r.avatar_color_hex : undefined,
            avatar_id: typeof r.avatar_id === 'string' ? r.avatar_id : undefined,
        }))
    })
}

export function renameNuvioProfile(accountId: string, conn: Connection, profileId: string, name: string, avatarId?: string): Promise<unknown> {
    return withNuvio(accountId, conn, (d, t) => d.renameProfile(t, profileId, name, avatarId))
}

export function createNuvioProfile(accountId: string, conn: Connection, params: { profileIndex: number; name: string; avatarColorHex?: string; avatarId?: string }): Promise<unknown> {
    return withNuvio(accountId, conn, (d, t) => d.createProfile(t, params))
}

// The avatar catalog is a key-only public RPC, so no connection token is needed.
// Memoized per backend baseUrl with single-flight; failures are not cached.
export function readNuvioAvatars(_accountId: string, conn: Pick<Connection, 'credentials'>): Promise<NuvioAvatar[]> {
    return readAvatarCatalogCached(conn.credentials?.baseUrl, () =>
        import('@/lib/drivers/factory').then(({ nuvioDriverFor }) => nuvioDriverFor(conn).getAvatarCatalog()))
}

export function deleteNuvioProfile(accountId: string, conn: Connection, profileId: string | number): Promise<unknown> {
    return withNuvio(accountId, conn, (d, t) => d.deleteProfile(t, profileId))
}

export function readNuvioMemberAccess(accountId: string, conn: Connection): Promise<unknown> {
    return withNuvio(accountId, conn, (d, t) => d.getMemberAccess(t))
}
