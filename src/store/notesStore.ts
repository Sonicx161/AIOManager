import { create } from 'zustand'
import localforage from 'localforage'
import { triggerSync } from '@/lib/sync-trigger'
import { encrypt, decrypt } from '@/lib/crypto'
import { useAuthStore } from '@/store/authStore'
import { captureSyncOwnership, syncRuntime, type SyncOwnership } from './sync-store-helpers'

const OLD_STORAGE_KEY = 'aiom-notes'
export const NOTES_INDEX_KEY = 'aiom-notes-index'
export const NOTES_TRASH_KEY = 'aiom-notes-trash'
const TRASH_TTL = 30 * 24 * 60 * 60 * 1000
const MAX_NOTE_CONTENT = 50000
const MAX_NOTE_TITLE = 200
const NOTE_KEY_PREFIX = 'aiom-note:'
const CACHE_MAX = 10
const ENC_PREFIX = 'AIOMENC1:'

function noteKey(id: string): string {
    return `${NOTE_KEY_PREFIX}${id}`
}

function getEncryptionKey(): CryptoKey | null {
    return useAuthStore.getState().encryptionKey
}

async function encryptContent(content: string): Promise<string> {
    const key = getEncryptionKey()
    if (!key) return content
    return ENC_PREFIX + await encrypt(content, key)
}

async function readNoteFromStorage(id: string): Promise<Note | null> {
    const stored = await localforage.getItem<Note>(noteKey(id))
    if (!stored) return null
    const raw = String(stored.content ?? '')
    if (!raw.startsWith(ENC_PREFIX)) return { ...stored, content: raw }
    const key = getEncryptionKey()
    if (!key) return null
    try {
        return { ...stored, content: await decrypt(raw.slice(ENC_PREFIX.length), key) }
    } catch {
        return null
    }
}

export function extractTags(content: string): string[] {
    const matches = content.match(/(?:^|\s)#([a-zA-Z0-9_-]{2,30})/g)
    if (!matches) return []
    return [...new Set(matches.map(m => m.trim().slice(1)))]
}

export function extractWikilinks(content: string): string[] {
    const matches = content.match(/\[\[([^\]]+)\]\]/g)
    if (!matches) return []
    return [...new Set(matches.map(m => m.slice(2, -2)))]
}

export interface NoteMeta {
    id: string
    title: string
    createdAt: string
    updatedAt: string
    pinned?: boolean
    tags: string[]
    wikilinks: string[]
}

export interface Note extends NoteMeta {
    content: string
}

function toMeta(note: Note): NoteMeta {
    return {
        id: note.id,
        title: note.title,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
        pinned: note.pinned,
        tags: note.tags,
        wikilinks: note.wikilinks,
    }
}

function sanitizeNote(raw: Record<string, unknown>): Note {
    const content = String(raw.content || '').slice(0, MAX_NOTE_CONTENT)
    return {
        id: typeof raw.id === 'string' ? raw.id : crypto.randomUUID(),
        title: String(raw.title || 'Untitled').slice(0, MAX_NOTE_TITLE),
        content,
        createdAt: (raw.createdAt as string) || new Date().toISOString(),
        updatedAt: (raw.updatedAt as string) || new Date().toISOString(),
        pinned: Boolean(raw.pinned),
        tags: raw.tags && Array.isArray(raw.tags) ? raw.tags : extractTags(content),
        wikilinks: raw.wikilinks && Array.isArray(raw.wikilinks) ? raw.wikilinks : extractWikilinks(content),
    }
}

function noteTime(note: Pick<Note, 'updatedAt'> | Pick<NoteMeta, 'updatedAt'> | undefined): number {
    const ts = new Date(note?.updatedAt || 0).getTime()
    return Number.isFinite(ts) ? ts : 0
}

// Async imports carry an ownership fence through persistence.
async function persistIndex(metas: NoteMeta[], ownership?: SyncOwnership) {
    ownership?.assert()
    await localforage.setItem(NOTES_INDEX_KEY, metas)
}

async function persistNote(note: Note, ownership?: SyncOwnership) {
    const stored: Note = { ...note, content: await encryptContent(note.content) }
    ownership?.assert()
    await localforage.setItem(noteKey(note.id), stored)
}

async function removeNoteKey(id: string, ownership?: SyncOwnership) {
    ownership?.assert()
    await localforage.removeItem(noteKey(id))
}

async function persistTrash(trash: Note[], ownership?: SyncOwnership) {
    ownership?.assert()
    try {
        await localforage.setItem(NOTES_TRASH_KEY, trash)
    } catch (err) {
        if (import.meta.env.DEV) console.error('[NotesStore] Failed to persist trash:', err)
        throw err
    }
}

async function migrateFromOldFormat(): Promise<{ metas: NoteMeta[]; notes: Note[] } | null> {
    const old = await localforage.getItem<Note[]>(OLD_STORAGE_KEY)
    if (!old || !Array.isArray(old)) return null

    const notes: Note[] = []
    const metas: NoteMeta[] = []

    for (const raw of old) {
        const content = String(raw.content || '').slice(0, MAX_NOTE_CONTENT)
        const note: Note = {
            id: typeof raw.id === 'string' ? raw.id : crypto.randomUUID(),
            title: String(raw.title || 'Untitled').slice(0, MAX_NOTE_TITLE),
            content,
            createdAt: raw.createdAt || new Date().toISOString(),
            updatedAt: raw.updatedAt || new Date().toISOString(),
            pinned: Boolean(raw.pinned),
            tags: extractTags(content),
            wikilinks: extractWikilinks(content),
        }
        notes.push(note)
        metas.push(toMeta(note))
        await persistNote(note)
    }

    await localforage.setItem(NOTES_INDEX_KEY, metas)
    await localforage.removeItem(OLD_STORAGE_KEY)
    return { metas, notes }
}

let migrationDone = false

async function migratePlaintextNotes(): Promise<void> {
    if (migrationDone) return
    const key = getEncryptionKey()
    if (!key) return
    try {
        const index = await localforage.getItem<NoteMeta[]>(NOTES_INDEX_KEY)
        if (!index || !Array.isArray(index)) {
            migrationDone = true
            return
        }
        for (const meta of index) {
            try {
                const stored = await localforage.getItem<Note>(noteKey(meta.id))
                if (!stored) continue
                const raw = String(stored.content ?? '')
                if (raw.startsWith(ENC_PREFIX)) continue
                const encryptedContent = ENC_PREFIX + await encrypt(raw, key)
                await localforage.setItem(noteKey(meta.id), { ...stored, content: encryptedContent })
            } catch (e) {
                if (import.meta.env.DEV) console.error('[NotesStore] Failed to migrate note ' + meta.id + ':', e)
            }
        }
        migrationDone = true
    } catch (e) {
        if (import.meta.env.DEV) console.error('[NotesStore] Content encryption migration failed:', e)
    }
}

interface NotesStore {
    notes: NoteMeta[]
    trash: Note[]
    loading: boolean
    activeNote: Note | null
    initialize: () => Promise<void>
    loadNoteContent: (id: string) => Promise<Note | null>
    setActiveNote: (note: Note | null) => void
    createNote: (title: string, content: string) => Promise<Note>
    updateNote: (id: string, data: Partial<Pick<Note, 'title' | 'content' | 'pinned'>>) => Promise<void>
    deleteNote: (id: string) => Promise<void>
    trashAllNotes: () => Promise<void>
    restoreNote: (id: string) => Promise<void>
    emptyTrash: () => Promise<void>
    importNotes: (notes: Note[], ownership?: SyncOwnership) => Promise<void>
    importTrash: (trash: Note[], ownership?: SyncOwnership) => Promise<void>
    // Throws (fail-closed) when any indexed note is unreadable, so a full-array
    // cloud push can never drop the cloud copy of a partially unreadable note.
    getAllNotesWithContent: () => Promise<Note[]>
    resetLocal: () => void
    saveFailed: boolean
}

// True when the persisted notes index resolves no entries. The pull path uses
// it for the empty-local force-apply: a wiped index plus an unchanged-cloud
// 304 would strand the view at zero until the content changed.
export async function isLocalNotesStoreEmpty(): Promise<boolean> {
    try {
        const index = await localforage.getItem<NoteMeta[]>(NOTES_INDEX_KEY)
        return !index || !Array.isArray(index) || index.length === 0
    } catch {
        return true
    }
}

// Cache entries belong to a session epoch; stale reads cannot refill a reset cache.
const noteCache = new Map<string, { note: Note; ts: number; epoch: number }>()
let cacheEpoch = 0

function cachePut(note: Note, epoch = cacheEpoch) {
    noteCache.set(note.id, { note, ts: Date.now(), epoch })
    if (noteCache.size > CACHE_MAX) {
        let oldest = ''
        let oldestTs = Infinity
        for (const [id, entry] of noteCache) {
            if (entry.ts < oldestTs) { oldestTs = entry.ts; oldest = id }
        }
        if (oldest) noteCache.delete(oldest)
    }
}

// Only entries minted by the live session are readable.
function cacheGet(id: string): Note | null {
    const entry = noteCache.get(id)
    if (!entry || entry.epoch !== cacheEpoch) return null
    entry.ts = Date.now()
    return entry.note
}

function cacheInvalidate(id: string, epoch?: number) {
    // Scoped invalidation (imports): only drop an entry this import could have
    // written, so a stale import never evicts the live session's cached note.
    if (epoch !== undefined) {
        const entry = noteCache.get(id)
        if (!entry || entry.epoch !== epoch) return
    }
    noteCache.delete(id)
}

let persistTimer: ReturnType<typeof setTimeout> | null = null
let pendingPersist: { note: Note; notes: NoteMeta[] } | null = null

async function flushPendingPersist(ownership?: SyncOwnership) {
    if (persistTimer) {
        clearTimeout(persistTimer)
        persistTimer = null
    }
    const pending = pendingPersist
    if (!pending) return
    pendingPersist = null
    await persistNote(pending.note, ownership)
    await persistIndex(pending.notes, ownership)
}

function schedulePersist(note: Note, notes: NoteMeta[]) {
    pendingPersist = { note, notes }
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = setTimeout(async () => {
        const pending = pendingPersist
        pendingPersist = null
        persistTimer = null
        if (!pending) return
        try {
            await persistNote(pending.note)
            await persistIndex(pending.notes)
            useNotesStore.setState({ saveFailed: false })
        } catch (e) {
            useNotesStore.setState({ saveFailed: true })
            if (import.meta.env.DEV) console.error(e)
        }
    }, 1000)
}

export const useNotesStore = create<NotesStore>((set, get) => ({
    notes: [],
    trash: [],
    loading: false,
    activeNote: null,
    saveFailed: false,

    initialize: async () => {
        // The reads below span storage awaits: a boot initialization that
        // outlives its session must not repopulate the cache or active note of
        // the session that replaced it.
        const bootEpoch = cacheEpoch
        set({ loading: true })
        try {
            const migrated = await migrateFromOldFormat()

            let metas: NoteMeta[]
            if (migrated) {
                metas = migrated.metas
            } else {
                const stored = await localforage.getItem<NoteMeta[]>(NOTES_INDEX_KEY)
                metas = stored && Array.isArray(stored) ? stored : []
            }
            if (bootEpoch !== cacheEpoch) return
            set({ notes: metas })

            await migratePlaintextNotes()

            try {
                const emergencyRaw = localStorage.getItem('aiom-note-emergency-save')
                if (emergencyRaw) {
                    localStorage.removeItem('aiom-note-emergency-save')
                    const emergency = JSON.parse(emergencyRaw) as { id?: string; recovered?: boolean }
                    if (emergency.recovered && emergency.id) {
                        const note = await readNoteFromStorage(emergency.id)
                        if (note && bootEpoch === cacheEpoch) {
                            cachePut(note)
                            set({ activeNote: note })
                        }
                    }
                }
            } catch (e) { if (import.meta.env.DEV) console.error(e) }

            const storedTrash = await localforage.getItem<Note[]>(NOTES_TRASH_KEY)
            if (bootEpoch !== cacheEpoch) return
            if (storedTrash && Array.isArray(storedTrash)) {
                const now = Date.now()
                const pruned = storedTrash.filter(n => now - new Date(n.updatedAt).getTime() < TRASH_TTL)
                set({ trash: pruned })
                if (pruned.length !== storedTrash.length) await persistTrash(pruned)
            }
        } catch (e) {
            if (import.meta.env.DEV) console.error('[NotesStore] Failed to load notes', e)
        } finally {
            set({ loading: false })
        }
    },

    loadNoteContent: async (id) => {
        const cached = cacheGet(id)
        if (cached) {
            set({ activeNote: cached })
            return cached
        }
        try {
            // Capture the session epoch before reading; recheck it before caching decrypted content.
            const readEpoch = cacheEpoch
            const note = await readNoteFromStorage(id)
            if (note) {
                if (readEpoch !== cacheEpoch) return null
                cachePut(note)
                set({ activeNote: note })
                return note
            }
        } catch (e) {
            if (import.meta.env.DEV) console.error('[NotesStore] Failed to load note content:', e)
        }
        return null
    },

    setActiveNote: (note) => {
        set({ activeNote: note })
    },

    createNote: async (title, content) => {
        const trimmedContent = content.slice(0, MAX_NOTE_CONTENT)
        const note: Note = {
            id: crypto.randomUUID(),
            title: (title.trim() || 'Untitled').slice(0, MAX_NOTE_TITLE),
            content: trimmedContent,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            tags: extractTags(trimmedContent),
            wikilinks: extractWikilinks(trimmedContent),
        }
        const meta = toMeta(note)
        const notes = [meta, ...get().notes]
        cachePut(note)
        set({ notes, activeNote: note })
        await persistNote(note)
        await persistIndex(notes)
        triggerSync()
        return note
    },

    updateNote: async (id, data) => {
        const current = get().activeNote?.id === id ? get().activeNote! : await get().loadNoteContent(id)
        if (!current) return

        const updated: Note = {
            ...current,
            ...(data.title !== undefined ? { title: data.title.slice(0, MAX_NOTE_TITLE) } : {}),
            ...(data.content !== undefined ? { content: data.content.slice(0, MAX_NOTE_CONTENT) } : {}),
            ...(data.pinned !== undefined ? { pinned: data.pinned } : {}),
            updatedAt: new Date().toISOString(),
        }

        if (data.content !== undefined) {
            updated.tags = extractTags(updated.content)
            updated.wikilinks = extractWikilinks(updated.content)
        }
        if (data.title !== undefined) {
            updated.wikilinks = extractWikilinks(updated.content)
        }

        const meta = toMeta(updated)
        const notes = get().notes.map(n => n.id === id ? meta : n)
        cachePut(updated)
        set({ notes, activeNote: updated })
        schedulePersist(updated, notes)
        triggerSync()
    },

    deleteNote: async (id) => {
        // Scope the trailing invalidation to this operation's epoch: the deletes
        // below span awaits, and a stale one must not evict the next session's
        // live entry.
        const opEpoch = cacheEpoch
        const meta = get().notes.find(n => n.id === id)
        const notes = get().notes.filter(n => n.id !== id)
        set({ notes })

        let fullNote: Note | null = null
        const cached = cacheGet(id)
        if (cached) {
            fullNote = cached
        } else {
            fullNote = await readNoteFromStorage(id)
        }

        if (fullNote) {
            const trashItem: Note = { ...fullNote, updatedAt: new Date().toISOString() }
            const trash = [trashItem, ...get().trash]
            set({ trash })
            await removeNoteKey(id)
            await persistTrash(trash)
            await persistIndex(notes)
        } else if (meta) {
            const trashItem: Note = {
                ...meta,
                content: '',
                updatedAt: new Date().toISOString(),
            }
            const trash = [trashItem, ...get().trash]
            set({ trash })
            await persistIndex(notes)
            await persistTrash(trash)
        } else {
            await persistIndex(notes)
        }

        triggerSync()
        cacheInvalidate(id, opEpoch)
        if (get().activeNote?.id === id) set({ activeNote: null })
    },

    trashAllNotes: async () => {
        const notes = get().notes
        if (notes.length === 0) return
        // Same epoch scoping as deleteNote: the removals below span awaits.
        const opEpoch = cacheEpoch
        const timestamp = new Date().toISOString()
        const trashItems: Note[] = []
        for (const meta of notes) {
            const cached = cacheGet(meta.id)
            const fullNote = cached ?? await readNoteFromStorage(meta.id)
            trashItems.push(fullNote
                ? { ...fullNote, updatedAt: timestamp }
                : { ...meta, content: '', updatedAt: timestamp })
        }
        const trash = [...trashItems, ...get().trash]
        set({ notes: [], trash })
        await persistIndex([])
        await persistTrash(trash)
        for (const meta of notes) {
            await removeNoteKey(meta.id)
            cacheInvalidate(meta.id, opEpoch)
        }
        if (get().activeNote) set({ activeNote: null })
        triggerSync()
    },

    restoreNote: async (id) => {
        const note = get().trash.find(n => n.id === id)
        const trash = get().trash.filter(n => n.id !== id)
        set({ trash })
        await persistTrash(trash)

        if (note) {
            const restored: Note = { ...note, updatedAt: new Date().toISOString() }
            const meta = toMeta(restored)
            const notes = [meta, ...get().notes]
            cachePut(restored)
            set({ notes })
            await persistNote(restored)
            await persistIndex(notes)
            triggerSync()
        }
    },

    emptyTrash: async () => {
        // Remove purged IDs from the fallback snapshot while this session still owns it.
        const ownership = captureSyncOwnership()
        const purgedIds = new Set(get().trash.map(n => n.id))
        set({ trash: [] })
        await persistTrash([], ownership)
        ownership.assert()
        if (purgedIds.size > 0) {
            if (syncRuntime.lastPulledNotes) {
                syncRuntime.lastPulledNotes = syncRuntime.lastPulledNotes.filter(n => !purgedIds.has(n.id))
            }
            if (syncRuntime.lastPulledNotesTrash) {
                syncRuntime.lastPulledNotesTrash = syncRuntime.lastPulledNotesTrash.filter(n => !purgedIds.has(n.id))
            }
        }
        triggerSync()
    },

    importNotes: async (incoming, ownership) => {
        // Capture ownership before the first await, including cached-content reads.
        const own = ownership ?? captureSyncOwnership()
        // The epoch this import mints cache entries under: a resumed import must
        // never repopulate the cache of the session that replaced it.
        const importEpoch = cacheEpoch
        await flushPendingPersist(own)
        own.assert()
        const sanitized = incoming
            .filter(n => n && typeof n.content === 'string' && n.content.length <= MAX_NOTE_CONTENT)
            .map(n => sanitizeNote(n as unknown as Record<string, unknown>))
        if (sanitized.length === 0) return

        const metaMap = new Map(get().notes.map(n => [n.id, n]))
        const trashMap = new Map(get().trash.map(n => [n.id, n]))
        let notesChanged = false
        let trashChanged = false
        let activeNote = get().activeNote

        for (const note of sanitized) {
            // Fence at the top of every iteration: it guards the cache mutation
            // below and re-arms after the previous iteration's awaited persist.
            own.assert()
            const trashed = trashMap.get(note.id)
            if (trashed) {
                if (noteTime(note) > noteTime(trashed)) {
                    trashMap.delete(note.id)
                    trashChanged = true
                } else {
                    continue
                }
            }

            const existing = metaMap.get(note.id)
            if (existing && noteTime(existing) >= noteTime(note)) continue

            metaMap.set(note.id, toMeta(note))
            cachePut(note, importEpoch)
            if (activeNote?.id === note.id) activeNote = note
            await persistNote(note, own)
            notesChanged = true
        }

        if (!notesChanged && !trashChanged) return

        const nextState: Partial<Pick<NotesStore, 'notes' | 'trash' | 'activeNote'>> = {}
        if (notesChanged) {
            const notes = Array.from(metaMap.values())
            nextState.notes = notes
            nextState.activeNote = activeNote
            await persistIndex(notes, own)
            own.assert()
        }
        if (trashChanged) {
            const trash = Array.from(trashMap.values())
            nextState.trash = trash
            await persistTrash(trash, own)
            own.assert()
        }
        set(nextState)

        triggerSync()
    },

    importTrash: async (incoming, ownership) => {
        const own = ownership ?? captureSyncOwnership()
        const importEpoch = cacheEpoch
        await flushPendingPersist(own)
        own.assert()
        const sanitized = incoming
            .filter(n => n && typeof n.content === 'string' && n.content.length <= MAX_NOTE_CONTENT)
            .map(n => sanitizeNote(n as unknown as Record<string, unknown>))
        if (sanitized.length === 0) return

        const trashMap = new Map(get().trash.map(n => [n.id, n]))
        const metaMap = new Map(get().notes.map(n => [n.id, n]))
        let changed = false
        let activeNote = get().activeNote

        for (const note of sanitized) {
            own.assert()
            const existingTrash = trashMap.get(note.id)
            if (!existingTrash || noteTime(note) > noteTime(existingTrash)) {
                trashMap.set(note.id, note)
                changed = true
            }

            const active = metaMap.get(note.id)
            if (active && noteTime(note) >= noteTime(active)) {
                metaMap.delete(note.id)
                cacheInvalidate(note.id, importEpoch)
                await removeNoteKey(note.id, own)
                if (activeNote?.id === note.id) activeNote = null
                changed = true
            }
        }

        if (!changed) return

        const notes = Array.from(metaMap.values())
        const trash = Array.from(trashMap.values())
        // Persist under the ownership fence before publishing state.
        own.assert()
        await persistIndex(notes, own)
        await persistTrash(trash, own)
        own.assert()
        set({ notes, trash, activeNote })

        triggerSync()
    },

    getAllNotesWithContent: async () => {
        await flushPendingPersist()
        const metas = get().notes
        const results: Note[] = []
        const unreadableIds: string[] = []
        for (const meta of metas) {
            const cached = cacheGet(meta.id)
            if (cached) {
                results.push({ ...meta, content: cached.content })
                continue
            }
            const note = await readNoteFromStorage(meta.id)
            if (note) {
                results.push({ ...meta, content: note.content })
            } else {
                unreadableIds.push(meta.id)
            }
        }
        // Fail closed: a full export replaces the whole cloud notes array, so an
        // unreadable note (missing record or undecryptable after a key change) must
        // abort here instead of silently dropping the note and deleting its cloud
        // copy. Callers surface the error; nothing has been sent or exported.
        if (unreadableIds.length > 0) {
            throw new Error(`Notes could not be fully read (${unreadableIds.length} unreadable). Nothing was sent or exported; unlock the vault (or restore the encryption key) and retry.`)
        }
        return results
    },

    resetLocal: () => {
        if (persistTimer) {
            clearTimeout(persistTimer)
            persistTimer = null
        }
        pendingPersist = null
        noteCache.clear()
        // Invalidate every entry the previous session minted, including ones a
        // held import may still write after this reset.
        cacheEpoch++
        migrationDone = false
        set({ notes: [], trash: [], activeNote: null, saveFailed: false })
    },
}))

if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', () => {
        flushPendingPersist()
        const store = useNotesStore.getState()
        if (store.activeNote) {
            try {
                localStorage.setItem('aiom-note-emergency-save', JSON.stringify({ id: store.activeNote.id, recovered: true }))
            } catch (e) { if (import.meta.env.DEV) console.error(e) }
        }
    })
}

useAuthStore.subscribe((state, prevState) => {
    const prevKey = prevState.encryptionKey
    const currentKey = state.encryptionKey
    if (prevKey && currentKey && prevKey !== currentKey) {
        noteCache.clear()
        useNotesStore.setState({ activeNote: null })
        migrationDone = false
    } else if (currentKey && !prevKey) {
        migratePlaintextNotes().catch(() => {})
    } else if (!currentKey && prevKey) {
        noteCache.clear()
        useNotesStore.setState({ activeNote: null })
    }
})
