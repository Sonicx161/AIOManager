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
    watchRecordFromItem,
} from './jellyfin-records.ts'
import type { ParsedWatchIdentity } from './jellyfin-records.ts'
import { createWatchStateRequestGate } from './request-gate.ts'

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
        return { watched: true, resume: true, dates: true, counts: true, combined: true, notes: [] }
    }
    const notes: string[] = [EPISODE_LIMIT_NOTE]
    if (product === 'aiostreams') {
        notes.push('AIOStreams keeps exact watch dates only for titles with a known runtime, and cannot store play counts.')
        notes.push('Watched marks may be forwarded to the watch-state sinks this AIOStreams server reports to.')
        return { watched: true, resume: true, dates: true, counts: false, combined: false, notes }
    } else if (product === 'aiometadata') {
        notes.push('AIOMetadata keeps watched flags and resume points but ignores original watch dates and cannot store play counts.')
        notes.push('Watched marks may be forwarded to the trackers this AIOMetadata profile reports to.')
    } else {
        notes.push('The server product could not be verified, so original watch dates and play counts are not copied.')
    }
    return { watched: true, resume: true, dates: false, counts: false, combined: false, notes }
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
            const byId = new Map<string, JellyfinItem>()
            for (const item of played.items) if (isWatchableLeaf(item)) byId.set(item.Id, item)
            for (const item of resume.items) if (isWatchableLeaf(item) && !byId.has(item.Id)) byId.set(item.Id, item)
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
                    const providers = await readVerifiedSeriesProviders(binding, key, readSignal, parent => {
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
            const positive = records.filter(record => record.watched === true || (record.positionMs ?? 0) > 0)
            const notes: string[] = []
            if (!played.complete) notes.push(`Watched history: ${played.items.length.toLocaleString()} ${played.total === null ? 'entries returned; the source did not provide a verifiable total' : `of ${played.total.toLocaleString()} reported entries returned`}. The source listing could not be verified as complete.`)
            if (!resume.complete) notes.push('The resume read is partial; more resume points may exist.')
            const unmatched = positive.filter(record => record.identities.length === 0).length
            if (unmatched > 0) notes.push(`${unmatched.toLocaleString()} titles have no verifiable identifier and will be skipped.`)
            return {
                connectionId: connection.id,
                label: binding.label,
                subject: binding.subject,
                scope: binding.scope,
                records: positive,
                complete: played.complete && resume.complete,
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
    }
    const gatedBinding: JellyfinBinding = { ...binding, client }
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
        const alreadyDesired =
            (patch.watched === undefined || freshRecord.watched === true)
            && (patch.positionMs === undefined || freshRecord.positionMs === patch.positionMs)
            && (!capabilities.dates || patch.playedAt === undefined || freshRecord.playedAt === patch.playedAt)
            && (!capabilities.counts || patch.playCount === undefined || freshRecord.playCount === patch.playCount)
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
        if (Object.keys(body).length === 0) {
            return { status: 'unchanged', message: 'Nothing was selected to import for this title.', record: freshRecord }
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
        const written = await gatedBinding.client.writeUserData(gatedBinding.secret.accessToken, gatedBinding.secret.userId, expected.id, body, applySignal)
        const check = await gatedBinding.client.readWatchItem(gatedBinding.secret.accessToken, gatedBinding.secret.userId, expected.id, applySignal)
        if (!isWatchableLeaf(check)) throw new Error(READBACK_FAILED)
        const checkKey = seriesKeyOf(check)
        const checkRecord = await watchRecordFromItem(check, checkKey !== undefined ? await applyParent(checkKey, applySignal) : undefined)
        if (!sameWatchTitle(expected, checkRecord)) throw new Error(READBACK_FAILED)
        const userData = check.UserData
        if ((body.Played !== undefined || backdatedStop) && userData?.Played !== true) throw new Error(READBACK_FAILED)
        if (body.PlaybackPositionTicks !== undefined && !backdatedStop) {
            const ticks = userData?.PlaybackPositionTicks
            if (typeof ticks !== 'number' || !Number.isFinite(ticks) || ticks !== body.PlaybackPositionTicks) throw new Error(READBACK_FAILED)
        }
        let dateKept = true
        if (body.LastPlayedDate !== undefined && sourceTime(userData?.LastPlayedDate) !== Date.parse(body.LastPlayedDate)) {
            if (!aioStreams) throw new Error(READBACK_FAILED)
            dateKept = false
        }
        if (body.PlayCount !== undefined && written?.via !== 'played-items' && userData?.PlayCount !== body.PlayCount) throw new Error(READBACK_FAILED)
        const message = runtimeUnknown ? 'Saved and verified. The runtime was unknown, so no original date was sent.'
            : !dateKept ? 'Saved and verified. The server kept its own watch date.'
                : 'Saved and verified by an exact readback.'
        return { status: 'applied', message, record: checkRecord }
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
