import { getSyncAuthHeaders, invalidateSyncAuthCache } from '@/lib/sync-auth'
import { proxyFetch, pickTmdbIdFromFind, type TmdbFindPayload } from '@/api/metadata/adapters/tmdb'
import { loadImdbTmdbCache, saveImdbTmdbCache } from '@/lib/utils'

export { invalidateSyncAuthCache as _invalidateAuthCache }

export interface PmdbRailItem {
    id: string
    type: string
    name: string
    poster?: string
}

export interface PmdbRail {
    railName: string
    railKey: string
    items: PmdbRailItem[]
}

export interface PmdbPublishResult {
    railName: string
    railKey: string
    listId: string | null
    added: number
    removed: number
    failed: number
    unresolved: number
    skipped: boolean
    error?: string
    lastError?: string
}

export interface PmdbListInfo {
    id: string
    name: string
    description?: string
    is_public?: boolean
}

const REGISTRY_KEY = 'aiomanager-pmdb-list-registry'
const CONCURRENCY = 2
const BATCH_DELAY_MS = 1200
const RETRY_DELAY_MS = 2000
const RAIL_DELAY_MS = 2000
const LIST_ITEMS_PER_PAGE = 500

interface ListRegistryEntry {
    listId: string
    listName: string
    lastPublishedAt: number
}

type ListRegistry = Record<string, ListRegistryEntry>

function loadRegistry(): ListRegistry {
    try {
        const raw = localStorage.getItem(REGISTRY_KEY)
        if (!raw) return {}
        const parsed = JSON.parse(raw)
        return typeof parsed === 'object' && parsed !== null ? parsed as ListRegistry : {}
    } catch {
        return {}
    }
}

function saveRegistry(registry: ListRegistry): void {
    try {
        localStorage.setItem(REGISTRY_KEY, JSON.stringify(registry))
    } catch {}
}

export function getLastPublishTime(scope: string): number | null {
    const registry = loadRegistry()
    const prefix = `${scope}:`
    let latest: number | null = null
    for (const key in registry) {
        if (!key.startsWith(prefix)) continue
        const ts = registry[key]?.lastPublishedAt
        if (typeof ts === 'number' && (latest === null || ts > latest)) {
            latest = ts
        }
    }
    return latest
}

function scopeKey(scope: string, railKey: string): string {
    return `${scope}:${railKey}`
}

function listName(scopeLabel: string, railName: string): string {
    return `AIOManager · ${scopeLabel} · ${railName}`
}

function itemHash(item: PmdbRailItem): string {
    const normalizedType = item.type === 'anime' ? 'series' : item.type
    return `${item.id}:${normalizedType}`
}

async function pmdbGet(path: string): Promise<Record<string, unknown> | null> {
    try {
        const res = await fetch(`/api/metadata/pmdb/${path}`, { headers: await getSyncAuthHeaders() })
        if (!res.ok) {
            if (import.meta.env?.DEV) console.warn(`[PMDB] GET ${path} failed: ${res.status}`)
            return null
        }
        const text = await res.text()
        if (!text) return null
        return JSON.parse(text) as Record<string, unknown>
    } catch (err) {
        if (import.meta.env?.DEV) console.warn(`[PMDB] GET ${path} threw:`, err)
        return null
    }
}

interface PmdbPostResult {
    data: Record<string, unknown> | null
    status: number
}

async function pmdbPost(path: string, body?: unknown, retries = 2): Promise<PmdbPostResult> {
    try {
        const res = await fetch(`/api/metadata/pmdb/${path}`, {
            method: 'POST',
            headers: await getSyncAuthHeaders(),
            body: body !== undefined ? JSON.stringify(body) : undefined,
        })
        if (res.status === 429 && retries > 0) {
            const retryAfter = Number(res.headers.get('retry-after')) || 3
            await sleep(jitter(retryAfter * 1000))
            return pmdbPost(path, body, retries - 1)
        }
        if (!res.ok) {
            const errorText = await res.text().catch(() => '')
            if (import.meta.env?.DEV) console.warn(`[PMDB] POST ${path} failed: ${res.status}`, errorText)
            return { data: null, status: res.status }
        }
        const text = await res.text()
        return { data: text ? JSON.parse(text) as Record<string, unknown> : {}, status: res.status }
    } catch (err) {
        if (import.meta.env?.DEV) console.warn(`[PMDB] POST ${path} threw:`, err)
        return { data: null, status: 0 }
    }
}

async function pmdbDelete(path: string): Promise<boolean> {
    try {
        const headers = await getSyncAuthHeaders()
        delete headers['Content-Type']
        const res = await fetch(`/api/metadata/pmdb/${path}`, { method: 'DELETE', headers })
        return res.ok
    } catch {
        return false
    }
}

function normalizeName(s: string): string {
    return s.toLowerCase().replace(/\s+/g, ' ').trim()
}

function sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms))
}

// ±25% so concurrent item batches don't retry in lockstep against the shared rate bucket
function jitter(ms: number): number {
    return Math.round(ms * (0.75 + Math.random() * 0.5))
}

export async function findExistingLists(): Promise<PmdbListInfo[]> {
    const data = await pmdbGet('lists')
    if (!data) return []
    let raw: unknown[]
    if (Array.isArray(data)) {
        raw = data
    } else if (Array.isArray((data as Record<string, unknown[]>).lists)) {
        raw = (data as Record<string, unknown[]>).lists
    } else if (Array.isArray((data as Record<string, unknown[]>).items)) {
        raw = (data as Record<string, unknown[]>).items
    } else if (Array.isArray((data as Record<string, unknown[]>).data)) {
        raw = (data as Record<string, unknown[]>).data
    } else if (Array.isArray((data as Record<string, unknown[]>).result)) {
        raw = (data as Record<string, unknown[]>).result
    } else {
        raw = []
    }
    return raw
        .filter((l): l is Record<string, unknown> => {
            if (!l || typeof l !== 'object') return false
            const obj = l as Record<string, unknown>
            const id = obj.id ?? obj.list_id
            return typeof id === 'string' && typeof obj.name === 'string'
        })
        .map(l => {
            const obj = l as Record<string, unknown>
            return {
                id: (obj.id ?? obj.list_id) as string,
                name: obj.name as string,
                description: obj.description as string | undefined,
                is_public: obj.is_public as boolean | undefined,
            }
        })
}

async function createList(name: string): Promise<{ id: string | null; status: number }> {
    const existing = await findExistingLists()
    const match = existing.find(l => normalizeName(l.name) === normalizeName(name))
    if (match) return { id: match.id, status: 200 }

    const result = await pmdbPost('lists', { name, is_public: false })
    const body = result.data
    const item = body && typeof body.item === 'object' && body.item !== null ? body.item as Record<string, unknown> : null
    const rawId = item?.id ?? body?.list_id ?? body?.id
    if (typeof rawId === 'string' && rawId) return { id: rawId, status: result.status }
    if (typeof rawId === 'number' && rawId > 0) return { id: String(rawId), status: result.status }

    const retry = await findExistingLists()
    const retryMatch = retry.find(l => normalizeName(l.name) === normalizeName(name))
    if (retryMatch) return { id: retryMatch.id, status: 200 }
    return { id: null, status: result.status }
}

async function getListItems(listId: string): Promise<Array<{ id: string; tmdb_id: number; media_type: string }>> {
    const all: Array<{ id: string; tmdb_id: number; media_type: string }> = []
    for (let page = 1; page <= 20; page++) {
        const data = await pmdbGet(`lists/${encodeURIComponent(listId)}/items?page=${page}&perPage=${LIST_ITEMS_PER_PAGE}`)
        if (!data) break
        const raw = Array.isArray(data) ? data : (data.items || data.data || [])
        if (!Array.isArray(raw) || raw.length === 0) break
        for (const item of raw) {
            if (!item || typeof item !== 'object') continue
            const obj = item as Record<string, unknown>
            if (typeof obj.id !== 'string') continue
            all.push({
                id: obj.id,
                tmdb_id: Number(obj.tmdb_id) || 0,
                media_type: typeof obj.media_type === 'string' ? obj.media_type : '',
            })
        }
        if (raw.length < LIST_ITEMS_PER_PAGE) break
    }
    return all
}

async function addListItem(listId: string, tmdbId: number, mediaType: string): Promise<{ ok: boolean; status: number }> {
    let status = 0
    for (let attempt = 0; attempt < 2; attempt++) {
        const result = await pmdbPost(`lists/${encodeURIComponent(listId)}/items`, {
            tmdb_id: tmdbId,
            media_type: mediaType,
        }, 1)
        if (result.data !== null) return { ok: true, status: result.status }
        status = result.status
        if (status === 401 || status === 403) break
        await sleep(jitter(RETRY_DELAY_MS * (attempt + 1)))
    }
    return { ok: false, status }
}

async function removeListItem(listId: string, itemId: string): Promise<boolean> {
    return pmdbDelete(`lists/${encodeURIComponent(listId)}/items/${encodeURIComponent(itemId)}`)
}

async function resolveImdbToTmdb(imdbId: string, type: string): Promise<number | null> {
    const data = await proxyFetch<TmdbFindPayload>(
        `find/${encodeURIComponent(imdbId)}?external_source=imdb_id`
    )
    return pickTmdbIdFromFind(data, type !== 'movie')?.tmdbId ?? null
}

export async function publishRail(
    scope: string,
    scopeLabel: string,
    rail: PmdbRail,
    onProgress?: (added: number, removed: number) => void,
    getExistingLists?: () => Promise<PmdbListInfo[]>,
    signal?: AbortSignal
): Promise<PmdbPublishResult> {
    const result: PmdbPublishResult = {
        railName: rail.railName,
        railKey: rail.railKey,
        listId: null,
        added: 0,
        removed: 0,
        failed: 0,
        unresolved: 0,
        skipped: false,
    }

    if (rail.items.length === 0) {
        result.skipped = true
        return result
    }

    const registry = loadRegistry()
    const sKey = scopeKey(scope, rail.railKey)
    const expectedName = listName(scopeLabel, rail.railName)

    let entry = registry[sKey]
    if (!entry) {
        const existing = getExistingLists ? await getExistingLists() : await findExistingLists()
        const match = existing.find(l => normalizeName(l.name) === normalizeName(expectedName))
        if (match) {
            entry = { listId: match.id, listName: match.name, lastPublishedAt: 0 }
        } else {
            const created = await createList(expectedName)
            if (!created.id) {
                result.error = 'Failed to create PMDB list'
                result.lastError = `create: HTTP ${created.status}`
                return result
            }
            entry = { listId: created.id, listName: expectedName, lastPublishedAt: 0 }
        }
        registry[sKey] = entry
        saveRegistry(registry)
    }
    result.listId = entry.listId

    const existingItems = await getListItems(entry.listId)
    const existingMap = new Map<string, { id: string; tmdb_id: number; media_type: string }>()
    for (const item of existingItems) {
        const key2 = `${item.tmdb_id}:${item.media_type}`
        if (!existingMap.has(key2)) existingMap.set(key2, item)
    }

    const resolvedItems: PmdbRailItem[] = []
    const imdbCache = loadImdbTmdbCache()
    let cacheDirty = false
    for (const item of rail.items) {
        if (item.id.startsWith('tmdb:')) {
            resolvedItems.push(item)
        } else if (item.id.startsWith('tt')) {
            const cached = imdbCache[item.id]
            if (cached) {
                resolvedItems.push({ ...item, id: cached })
            } else {
                const tmdbId = await resolveImdbToTmdb(item.id, item.type)
                if (tmdbId) {
                    const tmdbKey = `tmdb:${tmdbId}`
                    imdbCache[item.id] = tmdbKey
                    cacheDirty = true
                    resolvedItems.push({ ...item, id: tmdbKey })
                } else {
                    result.unresolved++
                }
            }
        } else {
            result.unresolved++
        }
    }
    if (cacheDirty) saveImdbTmdbCache(imdbCache)

    const newItemHashes = new Set(resolvedItems.map(itemHash))
    // All-unresolved reconciliation wipes the list to nothing; leave it untouched instead.
    if (resolvedItems.length === 0) {
        result.unresolved = rail.items.length
        result.error = 'No rail items could be resolved to TMDB ids - list left unchanged'
        return result
    }
    const toAdd: PmdbRailItem[] = []
    for (const item of resolvedItems) {
        const tmdbId = Number(item.id.replace('tmdb:', ''))
        if (!Number.isFinite(tmdbId) || tmdbId <= 0) continue
        const mediaType = (item.type === 'series' || item.type === 'anime') ? 'tv' : 'movie'
        const key = `${tmdbId}:${mediaType}`
        if (!existingMap.has(key)) {
            toAdd.push(item)
        }
    }

    const toRemove: Array<{ id: string; tmdb_id: number; media_type: string }> = []
    for (const [, item] of existingMap) {
        const hash = `tmdb:${item.tmdb_id}:${item.media_type === 'tv' ? 'series' : 'movie'}`
        if (!newItemHashes.has(hash)) {
            toRemove.push(item)
        }
    }

    let added = 0
    let removed = 0
    let failedAdds = 0
    let lastError: string | undefined

    for (let i = 0; i < toRemove.length; i += CONCURRENCY) {
        if (signal?.aborted) break
        const chunk = toRemove.slice(i, i + CONCURRENCY)
        await Promise.allSettled(chunk.map(async (item) => {
            const ok = await removeListItem(entry!.listId, item.id)
            if (ok) removed++
        }))
        if (onProgress) onProgress(added, removed)
        await sleep(jitter(BATCH_DELAY_MS))
    }

    for (let i = 0; i < toAdd.length; i += CONCURRENCY) {
        if (signal?.aborted) break
        const chunk = toAdd.slice(i, i + CONCURRENCY)
        await Promise.allSettled(chunk.map(async (item) => {
            const tmdbId = Number(item.id.replace('tmdb:', ''))
            const mediaType = (item.type === 'series' || item.type === 'anime') ? 'tv' : 'movie'
            const add = await addListItem(entry!.listId, tmdbId, mediaType)
            if (add.ok) added++
            else {
                failedAdds++
                lastError = `add: HTTP ${add.status}`
            }
        }))
        if (onProgress) onProgress(added, removed)
        await sleep(jitter(BATCH_DELAY_MS))
    }

    result.added = added
    result.removed = removed
    result.failed = failedAdds
    if (lastError) result.lastError = lastError

    entry.lastPublishedAt = Date.now()
    registry[sKey] = entry
    saveRegistry(registry)

    return result
}

export async function publishScope(
    scope: string,
    scopeLabel: string,
    rails: PmdbRail[],
    onRailComplete?: (result: PmdbPublishResult) => void,
    onProgress?: (railKey: string, added: number, removed: number) => void,
    signal?: AbortSignal
): Promise<PmdbPublishResult[]> {
    let cachedLists: PmdbListInfo[] | null = null
    const getExistingLists = async () => {
        if (!cachedLists) cachedLists = await findExistingLists()
        return cachedLists
    }
    const results: PmdbPublishResult[] = []
    for (let ri = 0; ri < rails.length; ri++) {
        if (signal?.aborted) break
        const rail = rails[ri]
        const result = await publishRail(
            scope,
            scopeLabel,
            rail,
            (added, removed) => onProgress?.(rail.railKey, added, removed),
            getExistingLists,
            signal
        )
        results.push(result)
        onRailComplete?.(result)
        if (ri < rails.length - 1 && !signal?.aborted) {
            await sleep(RAIL_DELAY_MS)
        }
    }
    return results
}

export async function checkPmdbKeyConfigured(): Promise<boolean> {
    try {
        const { useSyncStore } = await import('@/store/syncStore')
        const { getSyncPasswordHeader } = await import('@/lib/sync-auth')
        const auth = useSyncStore.getState().auth
        if (!auth.isAuthenticated) return false
        const headers: Record<string, string> = {
            'x-sync-user': auth.id,
            'x-sync-password': await getSyncPasswordHeader(auth),
        }
        const res = await fetch('/api/metadata-keys', { headers })
        if (!res.ok) return false
        const data = await res.json()
        const providers = Array.isArray(data?.providers) ? data.providers : []
        return providers.some((p: { provider?: string }) => p?.provider === 'pmdb')
    } catch {
        return false
    }
}

export function clearRegistry(scope?: string): void {
    if (!scope) {
        try { localStorage.removeItem(REGISTRY_KEY) } catch {}
        return
    }
    const registry = loadRegistry()
    for (const key of Object.keys(registry)) {
        if (key.startsWith(`${scope}:`)) delete registry[key]
    }
    saveRegistry(registry)
}
