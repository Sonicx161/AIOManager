import type { Connection } from '../../types/connection.ts'
import { createJellyfinClient, JellyfinError, normalizeJellyfinUrl } from '../jellyfin/client.ts'
import type { JellyfinWatchClient } from '../jellyfin/client.ts'
import { openJellyfinSecret } from '../jellyfin/connection-data.ts'
import type { JellyfinSecret } from '../jellyfin/connection-data.ts'
import type { JellyfinItem, JellyfinProduct, JellyfinServerDetails, JellyfinUser, JellyfinUserDataUpdate } from '../jellyfin/types.ts'
import { hasSavedWatchState, sameWatchTitle, sourceTime, watchFingerprint } from './records.ts'
import type { MigrationProgress, MigrationWriteResult, WatchStateDestination, WatchStatePatch, WatchStateRecord, WatchStateSnapshot, WatchStateSource } from './types.ts'
import {
    episodeWatchIdentities,
    looksLikeFacadeStub,
    movieWatchIdentities,
    msToTicks,
    packedFacadeItemId,
    packedFacadeSeriesId,
    parseWatchIdentity,
    seriesKeyOf,
    watchRating,
    watchRecordFromItem,
} from './jellyfin-records.ts'
import type { ParsedWatchIdentity } from './jellyfin-records.ts'
import { createWatchStateRequestGate } from './request-gate.ts'
import { assertFreshChecks, StaleChecksError } from './prewrite-fresh.ts'

const SERIES_READ_WORKERS = 4
const EPISODE_CHILDREN_PAGE = 500
const EPISODE_CHILDREN_MAX = 2500
const READBACK_FAILED = 'The write could not be verified by reading the item back. Preview again to check whether it was saved.'
const EPISODE_LIMIT_NOTE = 'Series longer than 2,500 listed episodes cannot be verified episode by episode on this destination.'

export type { JellyfinSecret }

interface JellyfinBinding {
    client: JellyfinWatchClient
    secret: JellyfinSecret
    user: JellyfinUser
    details: JellyfinServerDetails
    scope: string
    subject: string
    label: string
}

async function jellyfinScope(baseUrl: string, userId: string, details: JellyfinServerDetails): Promise<string> {
    const identity = details.product === 'jellyfin'
        ? [userId, details.serverId ?? details.serverName ?? '']
        : [normalizeJellyfinUrl(baseUrl), userId, details.serverId ?? details.serverName ?? '']
    return `jellyfin:${await watchFingerprint([details.product, ...identity])}`
}

async function verifyJellyfinBinding(connection: Connection, open: (value: string) => Promise<string>, signal: AbortSignal): Promise<JellyfinBinding> {
    if (connection.platform !== 'jellyfin') throw new Error('This connection is not a Jellyfin-family media connection.')
    const secret = await openJellyfinSecret(connection, open)
    const client = createJellyfinClient(secret.baseUrl, { deviceId: secret.deviceId })
    const user = await client.getUser(secret.accessToken, secret.userId, signal)
    const details = await client.inspect(secret.accessToken, user, signal)
    const saved = connection.mediaServer
    if (saved?.serverId) {
        if (!details.serverId) throw new Error('The server identity could not be verified. Reconnect this connection, then try again.')
        if (saved.serverId !== details.serverId) {
            throw new Error('Reconnect to the same server for this remote user. Use Add Connection for a different server.')
        }
    }
    const subject = typeof user.Name === 'string' && user.Name.trim() !== '' ? user.Name.trim() : secret.userId
    return {
        client,
        secret,
        user,
        details,
        scope: await jellyfinScope(secret.baseUrl, secret.userId, details),
        subject,
        label: details.serverName ?? details.productName,
    }
}

async function reverifyJellyfinScope(binding: JellyfinBinding, signal: AbortSignal): Promise<void> {
    const user = await binding.client.getUser(binding.secret.accessToken, binding.secret.userId, signal)
    if (user.Id !== binding.secret.userId) throw new Error('The remote user changed. Preview again.')
    const details = await binding.client.inspect(binding.secret.accessToken, user, signal)
    if (details.product !== binding.details.product) throw new Error('The remote server product changed. Preview again.')
    if ((details.serverId ?? undefined) !== (binding.details.serverId ?? undefined)) throw new Error('The remote server changed. Preview again.')
    if (await jellyfinScope(binding.secret.baseUrl, binding.secret.userId, details) !== binding.scope) {
        throw new Error('The remote server or user changed. Preview again.')
    }
}

function capabilitiesForProduct(product: JellyfinProduct): WatchStateDestination['capabilities'] {
    if (product === 'jellyfin') {
        return { watched: true, resume: true, dates: true, counts: true, combined: true, ratings: true, favorites: true, notes: [] }
    }
    const notes: string[] = [EPISODE_LIMIT_NOTE]
    if (product === 'aiostreams') {
        notes.push('AIOStreams keeps exact watch dates only for titles with a known runtime, and cannot store play counts.')
        notes.push('Watched marks may be forwarded to the watch-state sinks this AIOStreams server reports to.')
        return { watched: true, resume: true, dates: true, counts: false, combined: false, ratings: true, favorites: true, notes }
    } else if (product === 'aiometadata') {
        notes.push('AIOMetadata keeps watched flags and resume points but ignores original watch dates and cannot store play counts.')
        notes.push('Watched marks may be forwarded to the trackers this AIOMetadata profile reports to.')
        notes.push('Favorites can only be stored for movies and series, not for episodes.')
    } else {
        notes.push('The server product could not be verified, so original watch dates and play counts are not copied.')
    }
    return { watched: true, resume: true, dates: false, counts: false, combined: false, ratings: true, favorites: true, notes }
}

function isWatchableLeaf(item: JellyfinItem): boolean {
    return item.Type === 'Movie' || item.Type === 'Episode'
}

async function readVerifiedSeriesProviders(binding: JellyfinBinding, seriesId: string, signal: AbortSignal, onSeries?: (item: JellyfinItem) => void): Promise<unknown> {
    try {
        const parent = await binding.client.readWatchItem(binding.secret.accessToken, binding.secret.userId, seriesId, signal)
        if (parent.Type !== 'Series') return undefined
        onSeries?.(parent)
        return parent.ProviderIds
    } catch {
        signal.throwIfAborted()
        return undefined
    }
}

export async function createJellyfinWatchSource(connection: Connection, open: (value: string) => Promise<string>, signal: AbortSignal): Promise<WatchStateSource> {
    const binding = await verifyJellyfinBinding(connection, open, signal)
    signal.throwIfAborted()
    // Facade products pace the source's own parent-series lookups through one
    // rolling 220/30s request budget (the burst a favorites-only library produces).
    // The gate reserves a slot BEFORE the client call, so a budget wait never
    // consumes the request's transport timeout, and cancellation behaves exactly
    // as on beta. Listing walks (played, resume, favorites) page at 500 rows and
    // stay single-digit requests at migration scale, so they keep their beta path.
    const useFacadeBudget = binding.details.product === 'aiostreams' || binding.details.product === 'aiometadata'
    const facadeBudget = useFacadeBudget ? createWatchStateRequestGate() : null
    const sourceBinding: JellyfinBinding = facadeBudget === null ? binding : {
        ...binding,
        client: {
            ...binding.client,
            readWatchItem: (accessToken: string, userId: string, itemId: string, requestSignal?: AbortSignal) => facadeBudget.run(requestSignal ?? signal, () => binding.client.readWatchItem(accessToken, userId, itemId, requestSignal)),
        },
    }
    return {
        async read(readSignal: AbortSignal, progress?: MigrationProgress): Promise<WatchStateSnapshot> {
            await reverifyJellyfinScope(binding, readSignal)
            readSignal.throwIfAborted()
            progress?.('Reading the watched history…')
            const played = await binding.client.readAllPlayed(binding.secret.accessToken, binding.secret.userId, undefined, readSignal)
            readSignal.throwIfAborted()
            progress?.('Reading the resume points…')
            const resume = await binding.client.readAllResume(binding.secret.accessToken, binding.secret.userId, undefined, readSignal)
            readSignal.throwIfAborted()
            progress?.('Reading favorites and ratings…')
            const favorites = await binding.client.readAllFavorites(binding.secret.accessToken, binding.secret.userId, undefined, readSignal)
            readSignal.throwIfAborted()
            const byId = new Map<string, JellyfinItem>()
            for (const item of played.items) if (isWatchableLeaf(item)) byId.set(item.Id, item)
            for (const item of resume.items) if (isWatchableLeaf(item) && !byId.has(item.Id)) byId.set(item.Id, item)
            for (const item of favorites.items) if (isWatchableLeaf(item) && !byId.has(item.Id)) byId.set(item.Id, item)
            const missing: string[] = []
            const seriesKeys = new Set<string>()
            for (const item of byId.values()) {
                const key = seriesKeyOf(item)
                if (key === undefined || seriesKeys.has(key)) continue
                seriesKeys.add(key)
                missing.push(key)
            }
            const seriesProviders = new Map<string, unknown>()
            const seriesNames = new Map<string, string>()
            for (let start = 0; start < missing.length; start += SERIES_READ_WORKERS) {
                readSignal.throwIfAborted()
                await Promise.all(missing.slice(start, start + SERIES_READ_WORKERS).map(async key => {
                    const providers = await readVerifiedSeriesProviders(sourceBinding, key, readSignal, parent => {
                        if (parent.Name) seriesNames.set(key, parent.Name)
                    })
                    if (providers !== undefined) seriesProviders.set(key, providers)
                }))
            }
            readSignal.throwIfAborted()
            const records: WatchStateRecord[] = []
            for (const item of byId.values()) {
                const key = seriesKeyOf(item)
                const displayItem = item.Type === 'Episode' && !item.SeriesName && key !== undefined ? { ...item, SeriesName: seriesNames.get(key) } : item
                records.push(await watchRecordFromItem(displayItem, key !== undefined ? seriesProviders.get(key) : undefined))
            }
            const positive = records.filter(record => record.watched === true || (record.positionMs ?? 0) > 0 || record.favorite === true || record.rating !== undefined)
            const notes: string[] = []
            if (!played.complete) notes.push(`Watched history: ${played.items.length.toLocaleString()} ${played.total === null ? 'entries returned; the source did not provide a verifiable total' : `of ${played.total.toLocaleString()} reported entries returned`}. The source listing could not be verified as complete.`)
            if (!resume.complete) notes.push('The resume read is partial; more resume points may exist.')
            if (!favorites.complete) notes.push('The favorites read is partial; some favorites or ratings may be missing.')
            const unmatched = positive.filter(record => record.identities.length === 0).length
            if (unmatched > 0) notes.push(`${unmatched.toLocaleString()} titles have no verifiable identifier and will be skipped.`)
            return {
                connectionId: connection.id,
                label: binding.label,
                subject: binding.subject,
                scope: binding.scope,
                records: positive,
                complete: played.complete && resume.complete && favorites.complete,
                notes,
            }
        },
    }
}

interface JellyfinLibraryIndex {
    byIdentity: Map<string, JellyfinItem[]>
    seriesProviders: Map<string, unknown>
    complete: boolean
}

async function buildJellyfinLibraryIndex(binding: JellyfinBinding, signal: AbortSignal): Promise<JellyfinLibraryIndex> {
    const read = await binding.client.readAllLibrary(binding.secret.accessToken, binding.secret.userId, undefined, signal)
    const seriesProviders = new Map<string, unknown>()
    for (const item of read.items) {
        if (item.Type === 'Series' && item.Id !== '') seriesProviders.set(item.Id, item.ProviderIds)
    }
    const byIdentity = new Map<string, JellyfinItem[]>()
    for (const item of read.items) {
        const identities = item.Type === 'Movie'
            ? movieWatchIdentities(item.ProviderIds)
            : item.Type === 'Episode'
                ? episodeWatchIdentities(seriesProviders.get(item.SeriesId ?? ''), item.ParentIndexNumber, item.IndexNumber)
                : []
        for (const identity of identities) {
            const existing = byIdentity.get(identity)
            if (existing === undefined) byIdentity.set(identity, [item])
            else if (!existing.some(other => other.Id === item.Id)) existing.push(item)
        }
    }
    return { byIdentity, seriesProviders, complete: read.complete }
}

export async function createJellyfinWatchDestination(connection: Connection, open: (value: string) => Promise<string>, signal: AbortSignal, assertCurrent: () => void = () => {}): Promise<WatchStateDestination> {
    const binding = await verifyJellyfinBinding(connection, open, signal)
    signal.throwIfAborted()
    const capabilities = capabilitiesForProduct(binding.details.product)
    const useNativeInventory = binding.details.product === 'jellyfin' || binding.details.product === 'compatible'
    const facadeGate = useNativeInventory ? null : createWatchStateRequestGate()
    const client = facadeGate === null ? binding.client : {
        ...binding.client,
        getUser: (accessToken: string, userId: string, requestSignal?: AbortSignal) => facadeGate.run(requestSignal ?? signal, () => binding.client.getUser(accessToken, userId, requestSignal)),
        inspect: (accessToken: string, user: JellyfinUser, requestSignal?: AbortSignal) => facadeGate.run(requestSignal ?? signal, () => binding.client.inspect(accessToken, user, requestSignal)),
        readWatchItem: (accessToken: string, userId: string, itemId: string, requestSignal?: AbortSignal) => facadeGate.run(requestSignal ?? signal, () => binding.client.readWatchItem(accessToken, userId, itemId, requestSignal)),
        queryUserItems: (accessToken: string, userId: string, query: Parameters<JellyfinWatchClient['queryUserItems']>[2], requestSignal?: AbortSignal) => facadeGate.run(requestSignal ?? signal, () => binding.client.queryUserItems(accessToken, userId, query, requestSignal)),
        readSessions: (accessToken: string, userId: string, requestSignal?: AbortSignal) => facadeGate.run(requestSignal ?? signal, () => binding.client.readSessions(accessToken, userId, requestSignal)),
        writeUserData: (accessToken: string, userId: string, itemId: string, update: Parameters<JellyfinWatchClient['writeUserData']>[3], requestSignal?: AbortSignal) => facadeGate.run(requestSignal ?? signal, () => binding.client.writeUserData(accessToken, userId, itemId, update, requestSignal)),
        writeFavorite: (accessToken: string, userId: string, itemId: string, favorite: boolean, requestSignal?: AbortSignal) => facadeGate.run(requestSignal ?? signal, () => binding.client.writeFavorite(accessToken, userId, itemId, favorite, requestSignal)),
    }
    const gatedBinding: JellyfinBinding = { ...binding, client }
    // The write's freshness must hold after any facade gate wait, so the check runs inside
    // the gated operation, immediately before the request is sent. The transport may answer
    // 404/405 and dispatch a PlayedItems fallback after another round trip, so the same
    // guard travels with the write and re-runs before each mutation request.
    const writeUserDataFresh = async (checkedAt: number, itemId: string, update: JellyfinUserDataUpdate, requestSignal: AbortSignal): Promise<{ via: 'userdata' | 'played-items' } | void> => {
        const beforeDispatch = () => assertFreshChecks(checkedAt)
        if (facadeGate === null) {
            assertFreshChecks(checkedAt)
            return binding.client.writeUserData(binding.secret.accessToken, binding.secret.userId, itemId, update, requestSignal, beforeDispatch)
        }
        return facadeGate.run(requestSignal, () => {
            assertFreshChecks(checkedAt)
            return binding.client.writeUserData(binding.secret.accessToken, binding.secret.userId, itemId, update, requestSignal, beforeDispatch)
        })
    }
    const writeFavoriteFresh = async (checkedAt: number, itemId: string, favorite: boolean, requestSignal: AbortSignal): Promise<void> => {
        const beforeDispatch = () => assertFreshChecks(checkedAt)
        if (facadeGate === null) {
            assertFreshChecks(checkedAt)
            return binding.client.writeFavorite(binding.secret.accessToken, binding.secret.userId, itemId, favorite, requestSignal, beforeDispatch)
        }
        return facadeGate.run(requestSignal, () => {
            assertFreshChecks(checkedAt)
            return binding.client.writeFavorite(binding.secret.accessToken, binding.secret.userId, itemId, favorite, requestSignal, beforeDispatch)
        })
    }
    let indexPromise: Promise<JellyfinLibraryIndex> | null = null
    const ensureIndex = (indexSignal: AbortSignal): Promise<JellyfinLibraryIndex> => {
        if (indexPromise === null) {
            const built = buildJellyfinLibraryIndex(gatedBinding, indexSignal)
            indexPromise = built
            built.catch(() => {
                if (indexPromise === built) indexPromise = null
            })
        }
        return indexPromise
    }
    const parentProviders = new Map<string, unknown>()
    const loadParent = async (key: string, parentSignal: AbortSignal): Promise<unknown> => {
        if (!parentProviders.has(key)) {
            const providers = await readVerifiedSeriesProviders(gatedBinding, key, parentSignal)
            parentProviders.set(key, providers)
        }
        return parentProviders.get(key)
    }
    const seriesChildren = new Map<string, { episodes: JellyfinItem[]; complete: boolean }>()
    const listEpisodeChildren = async (seriesId: string, listSignal: AbortSignal): Promise<{ episodes: JellyfinItem[]; complete: boolean }> => {
        const cached = seriesChildren.get(seriesId)
        if (cached !== undefined) return cached
        const seen = new Set<string>()
        const episodes: JellyfinItem[] = []
        let cursor = 0
        let sawDuplicate = false
        let limitIgnored = false
        let truncatedByCap = false
        let complete = false
        while (episodes.length < EPISODE_CHILDREN_MAX) {
            const page = await gatedBinding.client.queryUserItems(
                gatedBinding.secret.accessToken,
                gatedBinding.secret.userId,
                { parentId: seriesId, includeItemTypes: 'Episode', recursive: true, limit: EPISODE_CHILDREN_PAGE, startIndex: cursor },
                listSignal
            )
            if (page.length > EPISODE_CHILDREN_PAGE) {
                limitIgnored = true
                page.length = EPISODE_CHILDREN_PAGE
            }
            if (page.length === 0) {
                complete = true
                break
            }
            const before = episodes.length
            for (const item of page) {
                if (seen.has(item.Id)) {
                    sawDuplicate = true
                    continue
                }
                seen.add(item.Id)
                if (item.Type !== 'Episode') continue
                if (episodes.length < EPISODE_CHILDREN_MAX) episodes.push(item)
                else truncatedByCap = true
            }
            cursor += page.length
            if (episodes.length === before) break
            if (page.length < EPISODE_CHILDREN_PAGE) {
                complete = true
                break
            }
        }
        const listing = { episodes, complete: complete && !sawDuplicate && !limitIgnored && !truncatedByCap }
        seriesChildren.set(seriesId, listing)
        return listing
    }
    const seriesProvidersOfItem = async (item: JellyfinItem, itemSignal: AbortSignal): Promise<unknown> => {
        const key = seriesKeyOf(item)
        if (key === undefined) return undefined
        return loadParent(key, itemSignal)
    }
    const verifyFacadeCandidate = async (
        candidate: JellyfinItem,
        identity: string,
        parsed: ParsedWatchIdentity,
        verifySignal: AbortSignal
    ): Promise<WatchStateRecord | null> => {
        if (!isWatchableLeaf(candidate) || looksLikeFacadeStub(candidate, parsed)) return null
        let fresh: JellyfinItem
        try {
            fresh = await binding.client.readWatchItem(binding.secret.accessToken, binding.secret.userId, candidate.Id, verifySignal)
        } catch (error) {
            if (error instanceof JellyfinError && error.status === 404) return null
            throw error
        }
        if (!isWatchableLeaf(fresh) || looksLikeFacadeStub(fresh, parsed)) return null
        const seriesProviders = fresh.Type === 'Episode' ? await seriesProvidersOfItem(fresh, verifySignal) : undefined
        const record = await watchRecordFromItem(fresh, seriesProviders)
        if (!record.identities.includes(identity)) return null
        return record
    }
    const resolveNative = async (record: WatchStateRecord, resolveSignal: AbortSignal): Promise<WatchStateRecord[]> => {
        if (record.identities.length === 0) return []
        const index = await ensureIndex(resolveSignal)
        if (!index.complete) {
            throw new Error('The destination library could not be read completely, so matches cannot be verified safely. Try the preview again.')
        }
        const matches = new Map<string, JellyfinItem>()
        for (const identity of record.identities) {
            for (const item of index.byIdentity.get(identity) ?? []) matches.set(item.Id, item)
        }
        const resolved: WatchStateRecord[] = []
        for (const item of matches.values()) {
            const key = seriesKeyOf(item)
            resolved.push(await watchRecordFromItem(item, key !== undefined ? index.seriesProviders.get(key) : undefined))
        }
        return resolved
    }
    const resolveFacade = async (record: WatchStateRecord, resolveSignal: AbortSignal): Promise<WatchStateRecord[]> => {
        if (record.identities.length === 0) return []
        const verified = new Map<string, WatchStateRecord>()
        for (const identity of record.identities) {
            const parsed = parseWatchIdentity(identity)
            if (parsed === null) continue
            if (parsed.type === 'movie') {
                const id = packedFacadeItemId(identity)
                if (id === null) continue
                const items = await gatedBinding.client.queryUserItems(
                    gatedBinding.secret.accessToken,
                    gatedBinding.secret.userId,
                    { ids: [id], includeItemTypes: 'Movie' },
                    resolveSignal
                )
                for (const candidate of items) {
                    const checked = await verifyFacadeCandidate(candidate, identity, parsed, resolveSignal)
                    if (checked !== null) verified.set(checked.id, checked)
                }
            } else {
                const seriesId = packedFacadeSeriesId(identity)
                if (seriesId === null || parsed.season === undefined || parsed.episode === undefined) continue
                const seriesProviders = await loadParent(seriesId, resolveSignal)
                if (seriesProviders === undefined) continue
                const listing = await listEpisodeChildren(seriesId, resolveSignal)
                if (!listing.complete) continue
                for (const candidate of listing.episodes) {
                    if (candidate.ParentIndexNumber !== parsed.season || candidate.IndexNumber !== parsed.episode) continue
                    const checked = await verifyFacadeCandidate(candidate, identity, parsed, resolveSignal)
                    if (checked !== null) verified.set(checked.id, checked)
                }
            }
        }
        return [...verified.values()]
    }
    // Per-run state: the scope is verified once per run (re-verified after an auth failure) and a
    // series' ProviderIds are read once per run; only successful reads are cached.
    let scopeVerified = false
    const applyParents = new Map<string, unknown>()
    const applyParent = async (key: string, parentSignal: AbortSignal): Promise<unknown> => {
        const cached = applyParents.get(key)
        if (cached !== undefined) return cached
        const providers = await readVerifiedSeriesProviders(gatedBinding, key, parentSignal)
        if (providers !== undefined) applyParents.set(key, providers)
        return providers
    }
    const beginRun = async (): Promise<void> => {
        scopeVerified = false
        applyParents.clear()
    }
    const apply = async (expected: WatchStateRecord, patch: WatchStatePatch, applySignal: AbortSignal): Promise<MigrationWriteResult> => {
        try {
            return await applyOnce(expected, patch, applySignal)
        } catch (error) {
            if (error instanceof JellyfinError && error.kind === 'auth') scopeVerified = false
            throw error
        }
    }
    const applyOnce = async (expected: WatchStateRecord, patch: WatchStatePatch, applySignal: AbortSignal): Promise<MigrationWriteResult> => {
        assertCurrent()
        if (!scopeVerified) {
            await reverifyJellyfinScope(gatedBinding, applySignal)
            scopeVerified = true
        }
        applySignal.throwIfAborted()
        const fresh = await gatedBinding.client.readWatchItem(gatedBinding.secret.accessToken, gatedBinding.secret.userId, expected.id, applySignal)
        if (!isWatchableLeaf(fresh)) throw new Error('Only movie or episode items can receive imported watch state.')
        const freshKey = seriesKeyOf(fresh)
        const freshRecord = await watchRecordFromItem(fresh, freshKey !== undefined ? await applyParent(freshKey, applySignal) : undefined)
        const sameTitle = expected.type === freshRecord.type
            && sameWatchTitle(expected, freshRecord)
            && expected.season === freshRecord.season
            && expected.episode === freshRecord.episode
        if (!sameTitle) {
            return { status: 'conflict', message: 'The destination item changed since the preview. It will be kept; preview again.', record: freshRecord }
        }
        const isAiometadata = binding.details.product === 'aiometadata'
        const alreadyDesired =
            (patch.watched === undefined || freshRecord.watched === true)
            && (patch.positionMs === undefined || freshRecord.positionMs === patch.positionMs)
            && (!capabilities.dates || patch.playedAt === undefined || freshRecord.playedAt === patch.playedAt)
            && (!capabilities.counts || patch.playCount === undefined || freshRecord.playCount === patch.playCount)
            && (!capabilities.ratings || patch.rating === undefined || (freshRecord.rating !== undefined && (isAiometadata
                ? Math.round(freshRecord.rating) === Math.round(patch.rating)
                : freshRecord.rating === patch.rating)))
            && (!capabilities.favorites || patch.favorite === undefined || freshRecord.favorite === true)
        if (alreadyDesired) {
            return { status: 'unchanged', message: 'The destination already has the selected state. Nothing was written.', record: freshRecord }
        }
        if (freshRecord.fingerprint !== expected.fingerprint) {
            return { status: 'conflict', message: 'The destination item changed since the preview. It will be kept; preview again.', record: freshRecord }
        }
        if (hasSavedWatchState(freshRecord)) {
            return { status: 'conflict', message: 'The destination item has watch state the preview did not show. It will be kept.', record: freshRecord }
        }
        const sessions = await gatedBinding.client.readSessions(gatedBinding.secret.accessToken, gatedBinding.secret.userId, applySignal)
        if (sessions.some(session => session.NowPlayingItem?.Id === expected.id)) {
            return { status: 'conflict', message: 'This title is playing on the destination right now. Import it after playback stops.', record: freshRecord }
        }
        const checkedAt = Date.now()
        const body: JellyfinUserDataUpdate = {}
        if (patch.watched === true) body.Played = true
        if (patch.positionMs !== undefined && patch.positionMs > 0) {
            const ticks = msToTicks(patch.positionMs)
            if (ticks === null) return { status: 'conflict', message: 'The resume point is too large to copy exactly.', record: freshRecord }
            body.PlaybackPositionTicks = ticks
        }
        if (capabilities.dates && patch.playedAt !== undefined) body.LastPlayedDate = new Date(patch.playedAt).toISOString()
        if (capabilities.counts && patch.playCount !== undefined && patch.playCount > 0) body.PlayCount = patch.playCount
        if (body.Played !== undefined && body.PlaybackPositionTicks !== undefined && !capabilities.combined) {
            return { status: 'conflict', message: 'This destination cannot combine a watched flag with a resume point in one write.', record: freshRecord }
        }
        // Ratings and favorites travel in a separate write AFTER the watched state
        // is saved and verified, so a destination that cannot store them never
        // fails the watched state of the same row. The AIOMetadata facade takes
        // ratings in the UserData write but favorites only through its
        // FavoriteItems endpoints, and only for movies and series; every other
        // product takes IsFavorite in the UserData write.
        const favoriteOffered = patch.favorite === true && capabilities.favorites === true
        const favoriteViaEndpoint = isAiometadata && favoriteOffered && expected.type !== 'episode'
        const favoriteSkippedByKind = favoriteOffered && isAiometadata && expected.type === 'episode'
        const skipNotes: string[] = []
        if (favoriteSkippedByKind) skipNotes.push('This destination cannot favorite episodes, so the favorite was skipped.')
        let ratingOffered = capabilities.ratings === true && watchRating(patch.rating) !== undefined ? watchRating(patch.rating) : undefined
        let ratingKeptExisting = false
        // The preview can go stale: a destination rating that differs from the source's
        // is preserved, never overwritten.
        if (ratingOffered !== undefined && freshRecord.rating !== undefined && freshRecord.rating !== ratingOffered) {
            ratingOffered = undefined
            ratingKeptExisting = true
            skipNotes.push('This destination already has a different rating for this title, which was kept.')
        }
        const ratingOrFavoriteBody: JellyfinUserDataUpdate = {}
        if (ratingOffered !== undefined) ratingOrFavoriteBody.Rating = ratingOffered
        if (favoriteOffered && !favoriteViaEndpoint && !favoriteSkippedByKind) ratingOrFavoriteBody.IsFavorite = true
        const hasWatchState = Object.keys(body).length > 0
        if (!hasWatchState && Object.keys(ratingOrFavoriteBody).length === 0 && !favoriteViaEndpoint) {
            return { status: 'unchanged', message: favoriteSkippedByKind ? 'Nothing to import: this destination cannot favorite episodes.' : 'Nothing was selected to import for this title.', record: freshRecord }
        }
        // AIOStreams stores no played date, but a back-dated stop at the full runtime is turned
        // into a played mark carrying that date. Without a known runtime the date is dropped.
        const aioStreams = binding.details.product === 'aiostreams'
        let backdatedStop = false
        let runtimeUnknown = false
        if (aioStreams && body.Played === true && body.LastPlayedDate !== undefined) {
            const runtime = freshRecord.durationMs !== undefined ? msToTicks(freshRecord.durationMs) : null
            if (runtime !== null && runtime > 0) {
                delete body.Played
                body.PlaybackPositionTicks = runtime
                backdatedStop = true
            } else {
                delete body.LastPlayedDate
                runtimeUnknown = true
            }
        }
        assertCurrent()
        applySignal.throwIfAborted()

        // Phase 1: the watched write and its own readback. A failure here fails the
        // row exactly as before; nothing optional has been sent yet.
        let verifiedRecord: WatchStateRecord | undefined
        let baseMessage = 'Saved and verified by an exact readback.'
        if (hasWatchState) {
            const written = await writeUserDataFresh(checkedAt, expected.id, body, applySignal)
            const watchedCheck = await gatedBinding.client.readWatchItem(gatedBinding.secret.accessToken, gatedBinding.secret.userId, expected.id, applySignal)
            if (!isWatchableLeaf(watchedCheck)) throw new Error(READBACK_FAILED)
            const watchedKey = seriesKeyOf(watchedCheck)
            const watchedRecord = await watchRecordFromItem(watchedCheck, watchedKey !== undefined ? await applyParent(watchedKey, applySignal) : undefined)
            if (!sameWatchTitle(expected, watchedRecord)) throw new Error(READBACK_FAILED)
            const watchedData = watchedCheck.UserData
            if ((body.Played !== undefined || backdatedStop) && watchedData?.Played !== true) throw new Error(READBACK_FAILED)
            if (body.PlaybackPositionTicks !== undefined && !backdatedStop) {
                const ticks = watchedData?.PlaybackPositionTicks
                if (typeof ticks !== 'number' || !Number.isFinite(ticks) || ticks !== body.PlaybackPositionTicks) throw new Error(READBACK_FAILED)
            }
            let dateKept = true
            if (body.LastPlayedDate !== undefined && sourceTime(watchedData?.LastPlayedDate) !== Date.parse(body.LastPlayedDate)) {
                if (!aioStreams) throw new Error(READBACK_FAILED)
                dateKept = false
            }
            if (body.PlayCount !== undefined && written?.via !== 'played-items' && watchedData?.PlayCount !== body.PlayCount) throw new Error(READBACK_FAILED)
            baseMessage = runtimeUnknown ? 'Saved and verified. The runtime was unknown, so no original date was sent.'
                : !dateKept ? 'Saved and verified. The server kept its own watch date.'
                    : 'Saved and verified by an exact readback.'
            verifiedRecord = watchedRecord
        }

        // Re-evaluate the preference patch against the watched readback: a rating
        // saved on the destination by another client while the watched write ran is
        // preserved, never overwritten at the phase boundary.
        if (ratingOffered !== undefined && verifiedRecord?.rating !== undefined && verifiedRecord.rating !== ratingOffered) {
            ratingOffered = undefined
            ratingKeptExisting = true
            delete ratingOrFavoriteBody.Rating
            skipNotes.push('This destination already has a different rating for this title, which was kept.')
        }

        // Phase 2: the optional preference writes. Any failure here downgrades to a
        // note and keeps the verified watched outcome above; it can never undo that
        // outcome or mark the row failed. Auth failures additionally ask the engine
        // to stop the run after this row's result is reported.
        type PreferenceOutcome = 'confirmed' | 'notStored' | 'uncertain' | 'notConfirmed' | 'signOut' | 'idle'
        // Held in an object on purpose: callback-set outcomes must not be narrowed
        // away by control-flow analysis at the comparisons below.
        const preference: { rating: PreferenceOutcome; favorite: PreferenceOutcome } = { rating: 'idle', favorite: 'idle' }
        const authExpired = { value: false }
        let uncertainError: unknown = null
        const dispatchIsUncertain = (error: unknown): boolean => !(error instanceof JellyfinError) || error.kind === 'server' || error.kind === 'network' || error.kind === 'timeout' || error.kind === 'invalid-response'
        const noteFor = (field: 'rating' | 'favorite', outcome: PreferenceOutcome): string => {
            if (outcome === 'signOut') return 'The sign-in expired before the rating or favorite could be saved.'
            if (outcome === 'notStored') return `The ${field} could not be stored by this destination.`
            if (outcome === 'notConfirmed') return `The ${field} was not confirmed by the readback.`
            return `The ${field} could not be confirmed to have saved.`
        }
        const preferenceFailure = (setOutcome: (outcome: PreferenceOutcome) => void, error: unknown): void => {
            if (error instanceof JellyfinError && error.kind === 'auth') {
                // A refused dispatch provably stored nothing, so it counts as not
                // stored; the sign-in note keeps the reason visible and the
                // authExpired flag stops the run after this row's result.
                authExpired.value = true
                setOutcome('notStored')
                skipNotes.push('The sign-in expired before the rating or favorite could be saved.')
            } else if (applySignal.aborted) {
                setOutcome('uncertain')
                skipNotes.push('Stopped before the rating or favorite could be saved.')
            } else if (error instanceof StaleChecksError) {
                setOutcome('uncertain')
                skipNotes.push('Paused too long to save the rating or favorite safely. Preview again to copy them.')
            } else if (dispatchIsUncertain(error)) {
                uncertainError = error
                setOutcome('uncertain')
            } else {
                setOutcome('notStored')
            }
        }
        if (Object.keys(ratingOrFavoriteBody).length > 0) {
            try {
                await writeUserDataFresh(checkedAt, expected.id, ratingOrFavoriteBody, applySignal)
                preference.rating = 'confirmed'
                if (ratingOrFavoriteBody.IsFavorite === true) preference.favorite = 'confirmed'
            } catch (error) {
                preferenceFailure(outcome => { preference.rating = outcome }, error)
                if (preference.favorite !== 'confirmed' && ratingOrFavoriteBody.IsFavorite === true) preferenceFailure(outcome => { preference.favorite = outcome }, error)
            }
        }
        if (favoriteViaEndpoint && !authExpired.value && !applySignal.aborted) {
            try {
                await writeFavoriteFresh(checkedAt, expected.id, true, applySignal)
                preference.favorite = 'confirmed'
            } catch (error) {
                preferenceFailure(outcome => { preference.favorite = outcome }, error)
            }
        } else if (favoriteViaEndpoint && authExpired.value) {
            preference.favorite = 'notStored'
        }
        const anyDispatch = preference.rating !== 'idle' || preference.favorite !== 'idle'
        if (anyDispatch) {
            // Confirm dispatched preferences with their own readback. A readback
            // failure keeps the verified watched outcome and marks the preferences
            // unconfirmed; for a preference-only row it decides the result.
            let confirmedRecord: WatchStateRecord | null = null
            try {
                const check = await gatedBinding.client.readWatchItem(gatedBinding.secret.accessToken, gatedBinding.secret.userId, expected.id, applySignal)
                if (!isWatchableLeaf(check)) throw new Error(READBACK_FAILED)
                const checkKey = seriesKeyOf(check)
                const checkRecord = await watchRecordFromItem(check, checkKey !== undefined ? await applyParent(checkKey, applySignal) : undefined)
                if (!sameWatchTitle(expected, checkRecord)) throw new Error(READBACK_FAILED)
                confirmedRecord = checkRecord
                if (preference.rating === 'confirmed' || preference.rating === 'uncertain') {
                    const matched = checkRecord.rating !== undefined && (isAiometadata
                        ? Math.round(checkRecord.rating) === Math.round(ratingOffered!)
                        : checkRecord.rating === ratingOffered)
                    preference.rating = matched ? 'confirmed' : preference.rating === 'confirmed' ? 'notConfirmed' : 'uncertain'
                }
                if (preference.favorite === 'confirmed' || preference.favorite === 'uncertain') {
                    const favoriteEstablished = check.UserData?.IsFavorite === true
                    preference.favorite = favoriteEstablished ? 'confirmed' : preference.favorite === 'confirmed' ? 'notConfirmed' : 'uncertain'
                }
            } catch (error) {
                const isAuth = error instanceof JellyfinError && error.kind === 'auth'
                if (isAuth) authExpired.value = true
                if (isAuth) {
                    if (preference.rating !== 'confirmed' && preference.rating !== 'notStored') preference.rating = 'signOut'
                    if (preference.favorite !== 'confirmed' && preference.favorite !== 'notStored') preference.favorite = 'signOut'
                }
                if (preference.rating === 'confirmed') preference.rating = 'notConfirmed'
                if (preference.favorite === 'confirmed') preference.favorite = 'notConfirmed'
                const unresolved = isAuth || preference.rating === 'uncertain' || preference.favorite === 'uncertain'
                if (unresolved && !verifiedRecord) {
                    if (applySignal.aborted) {
                        return { status: 'unchanged', message: 'Stopped before the rating or favorite could be confirmed. Nothing was verified.', record: freshRecord }
                    }
                    throw error
                }
            }
            // Only a row with a confirmed preference (or a verified watched state)
            // adopts the readback record; a preference-only row whose writes were
            // all declined stays with the pre-write record below.
            if (confirmedRecord !== null && (verifiedRecord || preference.rating === 'confirmed' || preference.favorite === 'confirmed')) {
                verifiedRecord = confirmedRecord
            }
        }
        if (preference.rating !== 'idle' && preference.rating !== 'confirmed') skipNotes.push(noteFor('rating', preference.rating))
        if (preference.favorite !== 'idle' && preference.favorite !== 'confirmed') skipNotes.push(noteFor('favorite', preference.favorite))
        const finalNotes = [...new Set(skipNotes)]

        // Report only confirmed state: an unconfirmed rating or favorite is stripped
        // from the record so the engine's verified fields and the counts stay honest.
        let reportedRecord = verifiedRecord ?? freshRecord
        if (reportedRecord && preference.rating !== 'confirmed' && reportedRecord.rating !== undefined) {
            const reported = { ...reportedRecord }
            delete reported.rating
            reportedRecord = reported
        }
        if (reportedRecord && preference.favorite !== 'confirmed' && reportedRecord.favorite === true) {
            const reported = { ...reportedRecord }
            delete reported.favorite
            reportedRecord = reported
        }
        if (!verifiedRecord) {
            // Preference-only row: reaching here means nothing was confirmed (a
            // confirmed outcome adopts the readback record above), or the write
            // provably stored nothing, or the uncertainty is thrown below.
            const anyUncertain = preference.rating === 'uncertain' || preference.favorite === 'uncertain'
            if (anyUncertain) throw uncertainError ?? new JellyfinError('server', 'The rating or favorite could not be confirmed to have saved.')
            const isCleanRejection = (outcome: PreferenceOutcome): boolean => outcome === 'idle' || outcome === 'notStored' || outcome === 'signOut'
            const cleanRejected = isCleanRejection(preference.rating) && isCleanRejection(preference.favorite)
            if (cleanRejected) {
                return { status: 'unchanged', message: 'This destination could not store the rating or favorite. Nothing was written.', record: freshRecord, ...(authExpired.value ? { authExpired: true } : {}), ...(anyDispatch ? { dispatched: true } : {}), ...(ratingKeptExisting ? { keptExisting: true } : {}), ...(preference.rating === 'notStored' ? { ratingNotStored: true } : {}), ...(preference.favorite === 'notStored' ? { favoriteNotStored: true } : {}) }
            }
            // A dispatch went out and came back as something other than what was
            // requested: the destination holds an unverified value, so the row needs
            // review instead of counting as copied or untouched.
            return { status: 'conflict', message: `${finalNotes.join(' ')} Preview again to review what this destination saved.`, record: freshRecord, ...(anyDispatch ? { dispatched: true } : {}), ...(ratingKeptExisting ? { keptExisting: true } : {}), ...(preference.rating === 'notStored' ? { ratingNotStored: true } : {}), ...(preference.favorite === 'notStored' ? { favoriteNotStored: true } : {}), ...(favoriteSkippedByKind ? { favoriteNotStored: true } : {}) }
        }
        const message = `${baseMessage}${finalNotes.length > 0 ? ` ${finalNotes.join(' ')}` : ''}`
        return { status: 'applied', message, record: reportedRecord, ...(authExpired.value ? { authExpired: true } : {}), ...(anyDispatch ? { dispatched: true } : {}), ...(ratingKeptExisting ? { keptExisting: true } : {}), ...(preference.rating === 'notStored' ? { ratingNotStored: true } : {}), ...(preference.favorite === 'notStored' ? { favoriteNotStored: true } : {}), ...(favoriteSkippedByKind ? { favoriteNotStored: true } : {}) }
    }
    return {
        connectionId: connection.id,
        label: binding.label,
        subject: binding.subject,
        scope: binding.scope,
        capabilities,
        resolve: useNativeInventory ? resolveNative : resolveFacade,
        apply,
        beginRun,
    }
}
