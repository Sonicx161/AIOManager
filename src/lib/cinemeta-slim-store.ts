// Persisted slim Cinemeta records (title, poster, genres, type) per IMDb id so a reload
// does not re-download full metadata. Titles reveal watch history, so the blob is sealed
// with the vault key before it reaches storage. Pure and injectable for node tests.

export interface SlimCinemeta {
    name: string
    poster?: string
    genres?: string[]
    type?: string
}

export interface SlimCipher {
    encrypt(plain: string): Promise<string>
    decrypt(sealed: string): Promise<string>
}

export interface SlimBackend {
    getItem(key: string): Promise<unknown>
    setItem(key: string, value: string): Promise<unknown>
    removeItem(key: string): Promise<unknown>
}

export interface SlimContext {
    scope: string
    keyRef: object
    cipher: SlimCipher
    backend: SlimBackend
}

export type SlimLookup = { kind: 'hit'; value: SlimCinemeta } | { kind: 'absent' } | null

export interface SlimStoreOptions {
    context: () => SlimContext | null
    storageKey?: string
    maxEntries?: number
    ttlMs?: number
    negativeTtlMs?: number
    flushDelayMs?: number
}

export interface SlimStore {
    get(imdbId: string, mediaType: string): Promise<SlimLookup>
    put(imdbId: string, value: SlimCinemeta): Promise<void>
    putAbsent(imdbId: string, mediaType: string): Promise<void>
    flush(): Promise<void>
    reset(): void
    clear(): Promise<void>
}

interface StoredRecord {
    at: number
    n?: string
    p?: string
    g?: string[]
    t?: string
}

interface StoreState {
    scope: string
    keyRef: object
    entries: Map<string, StoredRecord>
    loaded: Promise<void>
    dirty: boolean
}

export const SLIM_STORAGE_KEY = 'aio_cinemeta_slim_v1'
const SLIM_VERSION = 1
const DAY_MS = 24 * 60 * 60 * 1000

const absentKey = (mediaType: string, imdbId: string) => `x:${mediaType}:${imdbId}`

function isRecord(value: unknown): value is StoredRecord {
    if (!value || typeof value !== 'object') return false
    const record = value as StoredRecord
    return typeof record.at === 'number' && Number.isFinite(record.at)
        && (record.n === undefined || typeof record.n === 'string')
        && (record.p === undefined || typeof record.p === 'string')
        && (record.t === undefined || typeof record.t === 'string')
        && (record.g === undefined || (Array.isArray(record.g) && record.g.every(genre => typeof genre === 'string')))
}

export function createSlimStore(options: SlimStoreOptions): SlimStore {
    const storageKey = options.storageKey ?? SLIM_STORAGE_KEY
    const maxEntries = options.maxEntries ?? 2000
    const ttlMs = options.ttlMs ?? 7 * DAY_MS
    const negativeTtlMs = options.negativeTtlMs ?? DAY_MS
    const flushDelayMs = options.flushDelayMs ?? 2000
    let state: StoreState | null = null
    let timer: ReturnType<typeof setTimeout> | null = null

    const cancelTimer = () => {
        if (timer) { clearTimeout(timer); timer = null }
    }

    const load = async (context: SlimContext, target: StoreState) => {
        try {
            const sealed = await context.backend.getItem(storageKey)
            if (typeof sealed !== 'string' || !sealed) return
            const parsed = JSON.parse(await context.cipher.decrypt(sealed)) as { v?: number; e?: unknown }
            if (parsed?.v !== SLIM_VERSION || !Array.isArray(parsed.e)) return
            const now = Date.now()
            for (const pair of parsed.e) {
                if (!Array.isArray(pair) || typeof pair[0] !== 'string' || !isRecord(pair[1])) continue
                const limit = pair[0].startsWith('x:') ? negativeTtlMs : ttlMs
                if (now - pair[1].at < limit) target.entries.set(pair[0], pair[1])
            }
        } catch {
            // Unreadable under this key: drop the blob rather than serve or keep it.
            await Promise.resolve(context.backend.removeItem(storageKey)).catch(() => {})
        }
    }

    const bind = (): { context: SlimContext; state: StoreState } | null => {
        const context = options.context()
        if (!context) {
            state = null
            cancelTimer()
            return null
        }
        if (state && (state.scope !== context.scope || state.keyRef !== context.keyRef)) {
            state = null
            cancelTimer()
        }
        if (!state) {
            const fresh: StoreState = { scope: context.scope, keyRef: context.keyRef, entries: new Map(), loaded: Promise.resolve(), dirty: false }
            fresh.loaded = load(context, fresh)
            state = fresh
        }
        return { context, state }
    }

    const schedule = () => {
        if (timer) return
        timer = setTimeout(() => { timer = null; void store.flush() }, flushDelayMs)
        const unref = (timer as unknown as { unref?: () => void }).unref
        if (typeof unref === 'function') unref.call(timer)
    }

    const insert = (target: StoreState, key: string, record: StoredRecord) => {
        target.entries.delete(key)
        target.entries.set(key, record)
        while (target.entries.size > maxEntries) target.entries.delete(target.entries.keys().next().value!)
        target.dirty = true
        schedule()
    }

    const store: SlimStore = {
        async get(imdbId, mediaType) {
            const bound = bind()
            if (!bound) return null
            const target = bound.state
            await target.loaded
            if (state !== target) return null
            const now = Date.now()
            const record = target.entries.get(imdbId)
            if (record?.n) {
                if (now - record.at < ttlMs) {
                    target.entries.delete(imdbId)
                    target.entries.set(imdbId, record)
                    return { kind: 'hit', value: { name: record.n, poster: record.p, genres: record.g, type: record.t } }
                }
                target.entries.delete(imdbId)
            }
            const missing = target.entries.get(absentKey(mediaType, imdbId))
            if (missing && now - missing.at < negativeTtlMs) return { kind: 'absent' }
            return null
        },

        async put(imdbId, value) {
            if (!value.name) return
            const bound = bind()
            if (!bound) return
            const target = bound.state
            await target.loaded
            if (state !== target) return
            target.entries.delete(absentKey('movie', imdbId))
            target.entries.delete(absentKey('series', imdbId))
            insert(target, imdbId, {
                at: Date.now(),
                n: value.name,
                ...(value.poster ? { p: value.poster } : {}),
                ...(value.genres?.length ? { g: value.genres } : {}),
                ...(value.type ? { t: value.type } : {}),
            })
        },

        async putAbsent(imdbId, mediaType) {
            const bound = bind()
            if (!bound) return
            const target = bound.state
            await target.loaded
            if (state !== target) return
            if (target.entries.get(imdbId)?.n) return
            insert(target, absentKey(mediaType, imdbId), { at: Date.now() })
        },

        async flush() {
            cancelTimer()
            const bound = bind()
            if (!bound) return
            const target = bound.state
            await target.loaded
            if (state !== target || !target.dirty) return
            target.dirty = false
            try {
                const sealed = await bound.context.cipher.encrypt(JSON.stringify({ v: SLIM_VERSION, e: [...target.entries] }))
                if (state !== target) return
                await bound.context.backend.setItem(storageKey, sealed)
            } catch {
                target.dirty = true
            }
        },

        reset() {
            state = null
            cancelTimer()
        },

        async clear() {
            const context = options.context()
            state = null
            cancelTimer()
            if (context) await Promise.resolve(context.backend.removeItem(storageKey)).catch(() => {})
        },
    }
    return store
}
