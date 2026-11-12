import type { Connection } from '../../types/connection.ts'
import { createJellyfinClient, JellyfinError } from './client.ts'
import { openJellyfinSecret } from './connection-data.ts'
import type { JellyfinItem, JellyfinItemQuery, JellyfinProduct } from './types.ts'
import { JELLYFIN_CAPABILITIES } from './capabilities.ts'
import { canonicalWatchIdentity } from '../watch-state/records.ts'
import { providerIdsOf, parseWatchIdentity, packedFacadeItemId, packedFacadeSeriesId, looksLikeFacadeStub } from '../watch-state/jellyfin-records.ts'


type Cipher = (value: string) => Promise<string>

export interface JellyfinFavoriteLookup {
    canonicalIds: string[]
    series: boolean
}

export type JellyfinFavoriteStatus =
    | { state: 'found'; itemId: string; favorite: boolean }
    | { state: 'absent' }

const FAVORITES_FEATURE = 'Favorites and likes'
const NATIVE_TARGETED_LIMIT = 500
const NATIVE_TARGETED_MAX_PAGES = 10

export function jellyfinFavoritesCapable(product: JellyfinProduct | undefined): boolean {
    if (product === undefined) return false
    return JELLYFIN_CAPABILITIES[product]?.rows.some(row => row.feature === FAVORITES_FEATURE && row.status === 'works') ?? false
}

function isTargetType(item: JellyfinItem, series: boolean): boolean {
    return series ? item.Type === 'Series' : item.Type === 'Movie'
}

export interface JellyfinProviderIds {
    imdb?: string
    tmdb?: string
    tvdb?: string
}

export function wantedProviderIds(canonicalIds: string[]): JellyfinProviderIds {
    const out: JellyfinProviderIds = {}
    for (const canonical of canonicalIds) {
        const imdb = /^(tt\d{5,})$/i.exec(canonical)
        if (imdb) { out.imdb = imdb[1].toLowerCase(); continue }
        const named = /^(tmdb|tvdb):(\d+)$/i.exec(canonical)
        if (named) out[named[1].toLowerCase() as 'tmdb' | 'tvdb'] = named[2]
    }
    return out
}

export function providerIdEqualsValues(ids: JellyfinProviderIds): string[] {
    const values: string[] = []
    if (ids.imdb) values.push(`imdb.${ids.imdb}`)
    if (ids.tmdb) values.push(`tmdb.${ids.tmdb}`)
    if (ids.tvdb) values.push(`tvdb.${ids.tvdb}`)
    return values
}

export function providerIdsOverlap(item: Pick<JellyfinItem, 'ProviderIds'>, wanted: JellyfinProviderIds): boolean {
    const itemIds = providerIdsOf(item.ProviderIds)
    return (['imdb', 'tmdb', 'tvdb'] as const).some(key => {
        const itemValue = itemIds[key]
        const wantedValue = wanted[key]
        return itemValue !== undefined && wantedValue !== undefined && itemValue.toLowerCase() === wantedValue
    })
}

interface FavoriteCacheEntry { at: number; status: JellyfinFavoriteStatus }
const favoriteCache = new Map<string, FavoriteCacheEntry>()
const FAVORITE_CACHE_LIMIT = 256
const FAVORITE_CACHE_TTL_MS = 30_000

/** A reused connection id must never read another subject's cached answer. */
export interface FavoriteCacheScope {
    connectionId: string
    workspaceId?: string
    credential?: string
    serverId?: string
    userId?: string
}

export function favoriteCacheScope(
    connection: Pick<Connection, 'id' | 'credentials' | 'mediaServer'>,
    workspaceId?: string,
): FavoriteCacheScope {
    return {
        connectionId: connection.id,
        workspaceId,
        credential: connection.credentials?.jellyfin,
        serverId: connection.mediaServer?.serverId,
        userId: connection.mediaServer?.userId,
    }
}

export function favoriteCacheKey(scope: FavoriteCacheScope, wanted: JellyfinFavoriteLookup): string {
    return `${scope.connectionId}|${scope.workspaceId ?? ''}|${scope.credential ?? ''}|${scope.serverId ?? ''}|${scope.userId ?? ''}|${wanted.series ? 's' : 'm'}|${[...wanted.canonicalIds].sort().join('|')}`
}

export function favoriteLookupSignature(
    connections: Array<Pick<Connection, 'id' | 'credentials' | 'mediaServer'>>,
    wanted: JellyfinFavoriteLookup,
    prefix: string[] = [],
): string {
    const subjects = connections.map(conn => `${conn.id}~${conn.credentials?.jellyfin ?? ''}~${conn.mediaServer?.serverId ?? ''}~${conn.mediaServer?.userId ?? ''}`)
    return `${prefix.join('|')}|${subjects.join(',')}|${wanted.series ? 's' : 'm'}|${[...wanted.canonicalIds].sort().join('|')}`
}

export function favoriteCacheGet(key: string, now: number = Date.now()): JellyfinFavoriteStatus | undefined {
    const hit = favoriteCache.get(key)
    if (hit === undefined) return undefined
    if (now - hit.at > FAVORITE_CACHE_TTL_MS) {
        favoriteCache.delete(key)
        return undefined
    }
    favoriteCache.delete(key)
    favoriteCache.set(key, hit)
    return hit.status
}

export function favoriteCachePut(key: string, status: JellyfinFavoriteStatus): void {
    favoriteCache.delete(key)
    favoriteCache.set(key, { at: Date.now(), status })
    while (favoriteCache.size > FAVORITE_CACHE_LIMIT) {
        const oldest = favoriteCache.keys().next().value
        if (oldest === undefined) break
        favoriteCache.delete(oldest)
    }
}

export function favoriteCacheInvalidateConnection(connectionId: string): void {
    for (const key of [...favoriteCache.keys()]) {
        if (key.startsWith(`${connectionId}|`)) favoriteCache.delete(key)
    }
}

export function favoriteCacheClear(): void {
    favoriteCache.clear()
}

function assertCapable(product: JellyfinProduct | undefined): void {
    if (!jellyfinFavoritesCapable(product)) {
        throw new JellyfinError('unsupported', 'This server type has not verified favorite support')
    }
}

function facadePackedIdentities(wanted: JellyfinFavoriteLookup): Array<{ id: string; identity: string }> {
    const packed: Array<{ id: string; identity: string }> = []
    const seen = new Set<string>()
    for (const canonical of wanted.canonicalIds) {
        const identity = canonicalWatchIdentity('movie', canonical)
        if (identity === null) continue
        if (!wanted.series) {
            const id = packedFacadeItemId(identity)
            if (id !== null && !seen.has(id)) {
                seen.add(id)
                packed.push({ id, identity })
            }
            continue
        }
        const episodeIdentity = `episode:${identity.slice('movie:'.length)}`
        const id = packedFacadeSeriesId(episodeIdentity)
        if (id !== null && !seen.has(id)) {
            seen.add(id)
            packed.push({ id, identity: episodeIdentity })
        }
    }
    return packed
}

export interface JellyfinLookupClient {
    queryUserItems(accessToken: string, userId: string, query: JellyfinItemQuery, signal?: AbortSignal): Promise<JellyfinItem[]>
    queryUserItemsPage(accessToken: string, userId: string, query: JellyfinItemQuery, signal?: AbortSignal): Promise<{ items: JellyfinItem[]; total: number | null }>
    readWatchItem(accessToken: string, userId: string, itemId: string, signal?: AbortSignal): Promise<JellyfinItem>
    writeFavorite(accessToken: string, userId: string, itemId: string, favorite: boolean, signal?: AbortSignal): Promise<void>
    readAllLibrary(accessToken: string, userId: string, options?: unknown, signal?: AbortSignal): Promise<{ items: JellyfinItem[]; total: number | null; complete: boolean }>
}

async function facadeLookup(
    client: JellyfinLookupClient,
    auth: { accessToken: string; userId: string },
    wanted: JellyfinFavoriteLookup,
    wantedIds: JellyfinProviderIds,
    signal?: AbortSignal
): Promise<JellyfinFavoriteStatus> {
    const includeItemTypes = wanted.series ? 'Series' : 'Movie'
    for (const { id, identity } of facadePackedIdentities(wanted)) {
        const candidates = await client.queryUserItems(
            auth.accessToken,
            auth.userId,
            { ids: [id], includeItemTypes },
            signal
        )
        for (const candidate of candidates) {
            if (!isTargetType(candidate, wanted.series)) continue
            let fresh: JellyfinItem
            try {
                fresh = await client.readWatchItem(auth.accessToken, auth.userId, candidate.Id, signal)
            } catch (error) {
                if (error instanceof JellyfinError && error.status === 404) continue
                throw error
            }
            if (!isTargetType(fresh, wanted.series)) continue
            if (!providerIdsOverlap(fresh, wantedIds)) continue
            if (!wanted.series) {
                const parsed = parseWatchIdentity(identity)
                if (parsed !== null && looksLikeFacadeStub(fresh, parsed)) continue
            }
            return { state: 'found', itemId: fresh.Id, favorite: fresh.UserData?.IsFavorite === true }
        }
    }
    return { state: 'absent' }
}

async function nativeLookup(
    client: JellyfinLookupClient,
    auth: { accessToken: string; userId: string },
    wanted: JellyfinFavoriteLookup,
    wantedIds: JellyfinProviderIds,
    signal?: AbortSignal
): Promise<JellyfinFavoriteStatus> {
    const values = providerIdEqualsValues(wantedIds)
    if (values.length > 0) {
        const collected: JellyfinItem[] = []
        const seen = new Set<string>()
        let total: number | null = null
        // Servers may clamp the page size, so page until the reported total is covered.
        for (let page = 0; page < NATIVE_TARGETED_MAX_PAGES && collected.length < NATIVE_TARGETED_LIMIT; page++) {
            const result = await client.queryUserItemsPage(
                auth.accessToken,
                auth.userId,
                {
                    anyProviderIdEquals: values,
                    includeItemTypes: wanted.series ? 'Series' : 'Movie',
                    recursive: true,
                    limit: NATIVE_TARGETED_LIMIT,
                    startIndex: collected.length,
                },
                signal
            )
            if (result.total !== null) total = Math.max(total ?? 0, result.total)
            const before = collected.length
            for (const item of result.items) {
                if (seen.has(item.Id)) continue
                seen.add(item.Id)
                collected.push(item)
            }
            if (result.items.length === 0) break
            if (collected.length === before) break
            if (total !== null && collected.length >= total) break
        }
        for (const candidate of collected) {
            if (!isTargetType(candidate, wanted.series)) continue
            if (!providerIdsOverlap(candidate, wantedIds)) continue
            return { state: 'found', itemId: candidate.Id, favorite: candidate.UserData?.IsFavorite === true }
        }
        // Absence is only reported when the collected items provably cover the reported total.
        if (total !== null && collected.length >= total) {
            return { state: 'absent' }
        }
    }
    const read = await client.readAllLibrary(auth.accessToken, auth.userId, undefined, signal)
    if (!read.complete) {
        throw new JellyfinError('server', 'The library listing could not be verified as complete, so the title could not be matched safely')
    }
    for (const item of read.items) {
        if (!isTargetType(item, wanted.series)) continue
        if (!providerIdsOverlap(item, wantedIds)) continue
        return { state: 'found', itemId: item.Id, favorite: item.UserData?.IsFavorite === true }
    }
    return { state: 'absent' }
}

export async function lookupFavoriteWithClient(
    client: JellyfinLookupClient,
    auth: { accessToken: string; userId: string },
    wanted: JellyfinFavoriteLookup,
    options: { facade: boolean; cache?: FavoriteCacheScope },
    signal?: AbortSignal
): Promise<JellyfinFavoriteStatus> {
    if (options.cache !== undefined) {
        const cached = favoriteCacheGet(favoriteCacheKey(options.cache, wanted))
        if (cached) return cached
    }
    const wantedIds = wantedProviderIds(wanted.canonicalIds)
    const status = options.facade
        ? await facadeLookup(client, auth, wanted, wantedIds, signal)
        : await nativeLookup(client, auth, wanted, wantedIds, signal)
    if (options.cache !== undefined) favoriteCachePut(favoriteCacheKey(options.cache, wanted), status)
    return status
}

export async function writeFavoriteWithClient(
    client: JellyfinLookupClient,
    auth: { accessToken: string; userId: string },
    itemId: string,
    favorite: boolean,
    signal?: AbortSignal,
    cache?: FavoriteCacheScope,
): Promise<void> {
    // Dropped at dispatch: an uncertain write may still have landed server-side.
    if (cache !== undefined) favoriteCacheInvalidateConnection(cache.connectionId)
    await client.writeFavorite(auth.accessToken, auth.userId, itemId, favorite, signal)
    const fresh = await client.readWatchItem(auth.accessToken, auth.userId, itemId, signal)
    if (fresh.UserData?.IsFavorite !== favorite) {
        throw new JellyfinError('server', 'The server did not save the favorite for this item')
    }
}

interface Binding {
    client: JellyfinLookupClient
    auth: { accessToken: string; userId: string }
}

async function bind(connection: Pick<Connection, 'credentials' | 'mediaServer'>, open: Cipher): Promise<Binding> {
    const secret = await openJellyfinSecret(connection, open)
    return { client: createJellyfinClient(secret.baseUrl, { deviceId: secret.deviceId }), auth: { accessToken: secret.accessToken, userId: secret.userId } }
}

export async function readJellyfinFavorite(
    connection: Pick<Connection, 'id' | 'credentials' | 'mediaServer'>,
    open: Cipher,
    wanted: JellyfinFavoriteLookup,
    signal: AbortSignal,
    workspaceId?: string,
): Promise<JellyfinFavoriteStatus> {
    const product = connection.mediaServer?.product
    assertCapable(product)
    const binding = await bind(connection, open)
    const facade = product === 'aiostreams' || product === 'aiometadata'
    return lookupFavoriteWithClient(
        binding.client,
        binding.auth,
        wanted,
        { facade, cache: favoriteCacheScope(connection, workspaceId) },
        signal
    )
}

export async function writeJellyfinFavorite(
    connection: Pick<Connection, 'id' | 'credentials' | 'mediaServer'>,
    open: Cipher,
    itemId: string,
    favorite: boolean,
    signal: AbortSignal,
    workspaceId?: string,
): Promise<void> {
    assertCapable(connection.mediaServer?.product)
    const binding = await bind(connection, open)
    await writeFavoriteWithClient(binding.client, binding.auth, itemId, favorite, signal, favoriteCacheScope(connection, workspaceId))
}
