import { stremioClient } from '@/api/stremio-client'
import { getSyncPasswordHeader } from '@/lib/sync-auth'
import { useSyncStore } from '@/store/syncStore'
import type { AddonDescriptor } from '@/types/addon'
import { stremioVideoOrder } from './stremio-video-order'
import type { MetaVideo } from './watched-episodes'
import { createCollectionCache } from './stremio-collection-cache'
import { fetchSeriesBatch, SeriesLookupRateLimitError } from './series-batch-retry'

type Result = { kind: 'list'; videos: MetaVideo[]; source: string; fetchedAt: number; writeGrade: boolean } | { kind: 'not-found' } | { kind: 'unknown' }
type Lookup = { kind: 'list'; videos: MetaVideo[]; fetchedAt: number } | { kind: 'not-found' } | { kind: 'unknown' }
type Candidate = { base: string; fallback: boolean; addon: AddonDescriptor }

const fallbackAddons: AddonDescriptor[] = [
    { transportUrl: 'https://v3-cinemeta.strem.io/manifest.json', manifest: { id: 'com.linvo.cinemeta', name: 'Cinemeta', version: '1', description: '', resources: ['meta'], types: ['movie', 'series'], idPrefixes: ['tt'] } },
    { transportUrl: 'https://anime-kitsu.strem.fun/manifest.json', manifest: { id: 'org.stremio.kitsu', name: 'Kitsu', version: '1', description: '', resources: ['meta'], types: ['anime', 'movie', 'series'], idPrefixes: ['kitsu:', 'mal:', 'anilist:', 'anidb:'] } },
]

export function supportsMeta(addon: AddonDescriptor, type: string, id: string): boolean {
    const manifest = addon?.manifest
    if (!Array.isArray(manifest?.resources)) return false
    const resource = manifest.resources.find(entry => typeof entry === 'string' ? entry === 'meta' : entry?.name === 'meta')
    if (!resource) return false
    const types = typeof resource === 'string' ? manifest.types : resource.types
    const prefixes = typeof resource === 'string' ? manifest.idPrefixes : resource.idPrefixes
    return Array.isArray(types) && types.includes(type) && (prefixes === undefined || (Array.isArray(prefixes) && (prefixes.length === 0 || prefixes.some(prefix => typeof prefix === 'string' && id.startsWith(prefix)))))
}

function validManifest(addon: AddonDescriptor): boolean {
    const manifest = addon?.manifest
    if (!manifest || !Array.isArray(manifest.resources) || typeof addon.transportUrl !== 'string' || !addon.transportUrl) return false
    const validStrings = (value: unknown) => value === undefined || (Array.isArray(value) && value.every(item => typeof item === 'string'))
    if (!validStrings(manifest.types) || !validStrings(manifest.idPrefixes)) return false
    return manifest.resources.every(resource => typeof resource === 'string' || (resource && typeof resource.name === 'string' && validStrings(resource.types) && validStrings(resource.idPrefixes)))
}

export function createSeriesVideosResolver(deps: {
    readCollection: (authKey: string, context: string) => Promise<AddonDescriptor[] | null>
    lookup: (base: string, type: string, id: string, fresh?: boolean, signal?: AbortSignal) => Promise<Lookup>
    now?: () => number
}) {
    const now = deps.now || Date.now
    const collection = createCollectionCache(deps.readCollection, { now })
    return async (authKey: string, context: string, type: string, id: string, fresh = false, signal?: AbortSignal): Promise<Result> => {
        signal?.throwIfAborted()
        const addons = fresh ? await deps.readCollection(authKey, context).catch(() => null) : await collection(authKey, context)
        signal?.throwIfAborted()
        if (!addons || addons.some(addon => !validManifest(addon))) return { kind: 'unknown' }
        const candidates: Candidate[] = addons.filter(a => supportsMeta(a, type, id)).map(addon => ({ base: addon.transportUrl, fallback: false, addon }))
        for (const addon of fallbackAddons) {
            if (!supportsMeta(addon, type, id)) continue
            if (!candidates.some(candidate => candidate.addon.manifest.id === addon.manifest.id || candidate.base === addon.transportUrl)) candidates.push({ base: addon.transportUrl, fallback: true, addon })
        }
        let failed = false
        for (const candidate of candidates) {
            let answer: Lookup
            try { answer = await deps.lookup(candidate.base, type, id, fresh, signal) } catch (error) { signal?.throwIfAborted(); if (error instanceof SeriesLookupRateLimitError) throw error; answer = { kind: 'unknown' } }
            if (answer.kind === 'unknown') { failed = true; continue }
            if (answer.kind === 'list') return { ...answer, videos: stremioVideoOrder(answer.videos), source: candidate.base, writeGrade: !candidate.fallback && !failed && answer.fetchedAt <= now() && now() - answer.fetchedAt <= 300000 }
        }
        return { kind: failed ? 'unknown' : 'not-found' }
    }
}

type BatchItem = { base: string; type: string; id: string; fresh?: boolean }
type BatchRequest = { item: BatchItem; resolve: (result: Lookup) => void; reject: (error: unknown) => void }
const pendingBatches = new Map<string, { headers: Record<string, string>; requests: BatchRequest[] }>()

async function sendSeriesBatch(headers: Record<string, string>, requests: BatchRequest[], signal?: AbortSignal) {
    try {
        const response = await fetchSeriesBatch(() => fetch('/api/series-videos-batch', { method: 'POST', headers, body: JSON.stringify({ items: requests.map(request => request.item) }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) }), undefined, () => {
            if (requests.some(request => request.item.fresh) && typeof window !== 'undefined') window.dispatchEvent(new Event('aiom:series-lookup-wait'))
        }, signal)
        if (!response.ok) throw new Error('Series lookup failed')
        const data = await response.json()
        for (const [index, request] of requests.entries()) {
            const result = data?.results?.[index]
            if (result?.kind === 'not-found') request.resolve({ kind: 'not-found' })
            else if (result?.kind === 'list' && Array.isArray(result.videos) && Number.isFinite(result.fetchedAt)) request.resolve(result as Lookup)
            else request.resolve({ kind: 'unknown' })
        }
    } catch (error) {
        for (const request of requests) if (signal?.aborted || error instanceof SeriesLookupRateLimitError) request.reject(error); else request.resolve({ kind: 'unknown' })
    }
}

const signalIds = new WeakMap<AbortSignal, number>()
let nextSignalId = 0
function batchSeriesLookup(headers: Record<string, string>, item: BatchItem, signal?: AbortSignal): Promise<Lookup> {
    signal?.throwIfAborted()
    if (signal && !signalIds.has(signal)) signalIds.set(signal, ++nextSignalId)
    const key = JSON.stringify([headers, signal ? signalIds.get(signal) : null])
    let batch = pendingBatches.get(key)
    if (!batch) {
        batch = { headers, requests: [] }
        pendingBatches.set(key, batch)
        setTimeout(() => {
            const queued = pendingBatches.get(key)
            pendingBatches.delete(key)
            if (!queued) return
            for (let i = 0; i < queued.requests.length; i += 100) void sendSeriesBatch(queued.headers, queued.requests.slice(i, i + 100), signal)
        }, 0)
    }
    return new Promise((resolve, reject) => batch!.requests.push({ item, resolve, reject }))
}

const resolveUncachedSeriesVideos = createSeriesVideosResolver({
    readCollection: (authKey, context) => stremioClient.getLiveAddonCollectionForBitfield(authKey, context),
    lookup: async (base, type, id, fresh, signal) => {
        const { auth } = useSyncStore.getState()
        const headers: Record<string, string> = { 'Content-Type': 'application/json' }
        if (auth.isAuthenticated) {
            headers['x-sync-user'] = auth.id
            headers['x-sync-password'] = await getSyncPasswordHeader(auth)
        }
        return batchSeriesLookup(headers, { base, type, id, ...(fresh ? { fresh: true } : {}) }, signal)
    },
})

const READ_CACHE_CAP = 1000
const READ_CACHE_BYTES = 8 * 1024 * 1024
const readCache = new Map<string, { result: Result; expires: number; bytes: number }>()
let readCacheBytes = 0

function removeCacheEntry(key: string) {
    const entry = readCache.get(key)
    if (entry) readCacheBytes -= entry.bytes
    readCache.delete(key)
}

function pruneReadCache(now: number) {
    for (const [key, entry] of readCache) if (entry.expires <= now) removeCacheEntry(key)
    for (const [key, entry] of contextCredentials) if (entry.expires <= now) contextCredentials.delete(key)
    while (readCache.size > READ_CACHE_CAP || readCacheBytes > READ_CACHE_BYTES) {
        const key = readCache.keys().next().value
        if (key === undefined) break
        removeCacheEntry(key)
    }
}

function cacheResult(key: string, result: Result, expires: number) {
    const bytes = key.length * 2 + 128 + (result.kind === 'list'
        ? result.videos.reduce((n, video) => n + 128 + 2 * (video.id.length + (video.released?.length ?? 0)), result.source.length * 2)
        : 0)
    removeCacheEntry(key)
    readCache.set(key, { result, expires, bytes })
    readCacheBytes += bytes
    pruneReadCache(Date.now())
}

function readCached(key: string) {
    const entry = readCache.get(key)
    if (!entry) return undefined
    if (entry.expires <= Date.now()) { removeCacheEntry(key); return undefined }
    readCache.delete(key)
    readCache.set(key, entry)
    return entry
}
const readPending = new Map<string, Promise<Result>>()
const contextCredentials = new Map<string, { authKey: string; expires: number }>()
const readKey = (authKey: string, context: string, type: string, id: string) => JSON.stringify([authKey, context, type, id])

export function getCachedResolvedSeriesVideos(context: string, type: string, id: string): MetaVideo[] | null {
    const credential = contextCredentials.get(context)
    if (credential && credential.expires <= Date.now()) contextCredentials.delete(context)
    const entry = credential && credential.expires > Date.now() ? readCached(readKey(credential.authKey, context, type, id)) : undefined
    return entry && entry.result.kind === 'list' ? entry.result.videos : null
}

export async function resolveSeriesVideos(authKey: string, context: string, type: string, id: string, signal?: AbortSignal): Promise<Result> {
    signal?.throwIfAborted()
    if (signal) return resolveUncachedSeriesVideos(authKey, context, type, id, false, signal)
    pruneReadCache(Date.now())
    contextCredentials.delete(context)
    contextCredentials.set(context, { authKey, expires: Date.now() + 3600000 })
    while (contextCredentials.size > READ_CACHE_CAP) contextCredentials.delete(contextCredentials.keys().next().value!)
    const key = readKey(authKey, context, type, id)
    const cached = readCached(key)
    if (cached) return cached.result
    const pending = readPending.get(key)
    if (pending) return pending
    const work = resolveUncachedSeriesVideos(authKey, context, type, id).then(result => {
        if (result.kind !== 'unknown') {
            const expires = result.kind === 'not-found' ? Date.now() + 3600000 : Math.max(Date.now() + 1, result.fetchedAt + 300000)
            cacheResult(key, result, expires)
        }
        return result
    }).finally(() => readPending.delete(key))
    readPending.set(key, work)
    return work
}

export function resolveFreshSeriesVideos(authKey: string, context: string, type: string, id: string, signal?: AbortSignal): Promise<Result> {
    return resolveUncachedSeriesVideos(authKey, context, type, id, true, signal)
}
