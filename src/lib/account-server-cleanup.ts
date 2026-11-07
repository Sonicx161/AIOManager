// Server-side residue of removed accounts (autopilot rules, credentials, canonical
// addon rows) can outlive a local delete when a device was offline. Reconcile it
// against explicit tombstones, the pending set and the merged cloud account list.
import { trace } from './trace.ts'

export interface AccountServerResidueEntry {
    accountId: string
    rules: number
    credentials: number
    canonical: number
    newestUpdatedAt: number
}

export interface AccountServerResidue {
    accounts: AccountServerResidueEntry[]
}

export const SERVER_RESIDUE_MIN_AGE_MS = 24 * 60 * 60 * 1000
export const SERVER_RESIDUE_RECONCILE_MIN_INTERVAL_MS = 10 * 60 * 1000

const PENDING_KEY = 'aioman:pending-account-server-cleanup'
const STREMIO_PENDING_KEY = 'aioman:pending-stremio-credential-cleanup'

export interface PendingCleanup {
    id: string
    /** When this device's delete failed; server rows changed after it are a newer generation. */
    at: number
}

export interface PendingCleanupStore {
    load(): Promise<PendingCleanup[]>
    save(entries: PendingCleanup[]): Promise<void>
}

const readPending = (value: unknown): PendingCleanup[] => (Array.isArray(value) ? value : []).flatMap(item => {
    if (typeof item === 'string' && item) return [{ id: item, at: 0 }]
    if (item && typeof item === 'object' && typeof (item as PendingCleanup).id === 'string' && Number.isFinite((item as PendingCleanup).at)) return [item as PendingCleanup]
    return []
})

const localforageStore = (key: string): PendingCleanupStore => ({
    load: async () => {
        try {
            const localforage = (await import('localforage')).default
            return readPending(await localforage.getItem(key))
        } catch {
            return []
        }
    },
    save: async (entries) => {
        try {
            const localforage = (await import('localforage')).default
            await localforage.setItem(key, entries)
        } catch {
            // Best effort: the next reconcile retries.
        }
    },
})

const defaultPendingStore = localforageStore(PENDING_KEY)
let pendingStore: PendingCleanupStore = defaultPendingStore

export function setPendingAccountServerCleanupStore(store: PendingCleanupStore | null) {
    pendingStore = store ?? defaultPendingStore
}

export async function queuePendingAccountServerCleanup(id: string, now = Date.now()): Promise<void> {
    const entries = await pendingStore.load()
    if (entries.some(entry => entry.id === id)) return
    await pendingStore.save([...entries, { id, at: now }])
}

// Client and server clocks can disagree; a row written this long after a deletion still counts as older.
export const SERVER_RESIDUE_CLOCK_SKEW_MS = 10 * 60 * 1000

export interface OrphanResidueContext {
    presentIds: ReadonlySet<string>
    blobAccountIds: ReadonlySet<string> | null
    deletedAccounts: Record<string, number>
    restoredAccounts: Record<string, number>
    pending: ReadonlyMap<string, number>
    now: number
}

export function isOrphanServerResidue(entry: AccountServerResidueEntry, ctx: OrphanResidueContext): boolean {
    // A locally present account is never server-deleted from this path.
    if (ctx.presentIds.has(entry.accountId)) return false
    // Without the merged cloud account list, nothing proves the account is gone.
    if (ctx.blobAccountIds === null || ctx.blobAccountIds.has(entry.accountId)) return false
    const deletedAt = Object.hasOwn(ctx.deletedAccounts, entry.accountId) ? ctx.deletedAccounts[entry.accountId] : undefined
    const restoredAt = Object.hasOwn(ctx.restoredAccounts, entry.accountId) ? ctx.restoredAccounts[entry.accountId] : undefined
    if (restoredAt !== undefined && (deletedAt === undefined || restoredAt >= deletedAt)) return false
    // Tombstones and queued retries cover only the generation they deleted: server rows written
    // after that deletion belong to a re-created or restored account. A marker older than the
    // minimum age wins regardless. Rule residue ages by user saves, never by engine commits.
    const markerAt = deletedAt ?? ctx.pending.get(entry.accountId)
    if (markerAt !== undefined) {
        return entry.newestUpdatedAt <= markerAt + SERVER_RESIDUE_CLOCK_SKEW_MS || ctx.now - markerAt >= SERVER_RESIDUE_MIN_AGE_MS
    }
    return ctx.now - entry.newestUpdatedAt >= SERVER_RESIDUE_MIN_AGE_MS
}

export function selectOrphanServerAccounts(residue: unknown, ctx: Omit<OrphanResidueContext, 'pending'> & { pending: Iterable<PendingCleanup> }): string[] {
    const pending = new Map<string, number>()
    for (const entry of ctx.pending) pending.set(entry.id, entry.at)
    const list = Array.isArray((residue as AccountServerResidue | null)?.accounts) ? (residue as AccountServerResidue).accounts : []
    const out: string[] = []
    for (const raw of list) {
        if (!raw || typeof raw !== 'object' || typeof raw.accountId !== 'string' || !raw.accountId) continue
        const entry: AccountServerResidueEntry = {
            accountId: raw.accountId,
            rules: Number(raw.rules) || 0,
            credentials: Number(raw.credentials) || 0,
            canonical: Number(raw.canonical) || 0,
            newestUpdatedAt: Number(raw.newestUpdatedAt) || 0,
        }
        if (isOrphanServerResidue(entry, { ...ctx, pending })) out.push(entry.accountId)
    }
    return out
}

export interface AccountServerCleanupCall {
    (path: string, init?: { method?: string }): Promise<Response>
}

let lastReconcileAt = 0

export function resetAccountServerCleanupThrottle() {
    lastReconcileAt = 0
}

export async function reconcileAccountServerCleanup(options: {
    call: AccountServerCleanupCall
    presentIds: Iterable<string>
    blobAccountIds: Iterable<string> | null
    deletedAccounts: Record<string, number>
    restoredAccounts: Record<string, number>
    now?: number
    minIntervalMs?: number
}): Promise<number> {
    const now = options.now ?? Date.now()
    if (options.blobAccountIds === null) return 0
    if (now - lastReconcileAt < (options.minIntervalMs ?? SERVER_RESIDUE_RECONCILE_MIN_INTERVAL_MS)) return 0
    lastReconcileAt = now
    try {
        const pending = await pendingStore.load()
        const res = await options.call('/accounts/server-residue')
        if (!res.ok) return 0
        const residue = await res.json()
        const targets = selectOrphanServerAccounts(residue, {
            presentIds: new Set(options.presentIds),
            blobAccountIds: new Set(options.blobAccountIds),
            deletedAccounts: options.deletedAccounts ?? {},
            restoredAccounts: options.restoredAccounts ?? {},
            pending,
            now,
        })
        const cleared = new Set<string>()
        for (const accountId of targets) {
            const deleted = await options.call(`/accounts/${encodeURIComponent(accountId)}/server-state`, { method: 'DELETE' })
            if (deleted.ok) cleared.add(accountId)
        }
        // A queued retry is done once its account has no residue left or its delete succeeded.
        const residueIds = new Set((Array.isArray(residue?.accounts) ? residue.accounts : []).map((a: { accountId?: unknown }) => a?.accountId))
        const remaining = pending.filter(entry => residueIds.has(entry.id) && !cleared.has(entry.id))
        if (remaining.length !== pending.length) await pendingStore.save(remaining)
        if (targets.length > 0) trace('account', 'server-cleanup.applied', { count: targets.length })
        return targets.length
    } catch (err) {
        trace('account', 'server-cleanup.failed', { error: err instanceof Error ? err.message : 'unknown' })
        return 0
    }
}

// Stremio credential rows left behind when an account's last Stremio login was removed
// while the server was unreachable.
const defaultStremioPendingStore = localforageStore(STREMIO_PENDING_KEY)
let stremioPendingStore: PendingCleanupStore = defaultStremioPendingStore

export function setPendingStremioCredentialCleanupStore(store: PendingCleanupStore | null) {
    stremioPendingStore = store ?? defaultStremioPendingStore
}

export async function queuePendingStremioCredentialCleanup(id: string, now = Date.now()): Promise<void> {
    const entries = await stremioPendingStore.load()
    if (entries.some(entry => entry.id === id)) return
    await stremioPendingStore.save([...entries, { id, at: now }])
}

export async function cancelPendingStremioCredentialCleanup(id: string): Promise<void> {
    const entries = await stremioPendingStore.load()
    if (entries.some(entry => entry.id === id)) await stremioPendingStore.save(entries.filter(entry => entry.id !== id))
}

export async function drainPendingStremioCredentialCleanup(options: {
    call: AccountServerCleanupCall
    presentIds: Iterable<string>
    stremioAccountIds: Iterable<string>
}): Promise<number> {
    const entries = await stremioPendingStore.load()
    if (entries.length === 0) return 0
    const present = new Set(options.presentIds)
    const withLogin = new Set(options.stremioAccountIds)
    const remaining: PendingCleanup[] = []
    let cleared = 0
    for (const entry of entries) {
        // A deleted account is the server-state cleanup's job; a re-added login owns its rows again.
        if (!present.has(entry.id) || withLogin.has(entry.id)) continue
        try {
            const res = await options.call(`/accounts/${encodeURIComponent(entry.id)}/server-state/stremio-credentials?removedAt=${entry.at}&sentAt=${Date.now()}`, { method: 'DELETE' })
            if (res.ok) { cleared++; continue }
        } catch {
            // Retried after the next certified pull.
        }
        remaining.push(entry)
    }
    await stremioPendingStore.save(remaining)
    return cleared
}

// Server-side residue of a removed connection: the Autopilot rules bound to it (their
// stored addon_list and priority chain included) and its credential rows. The removal
// call deletes them in one owner-scoped operation; when that call fails, this queue
// retries it with the tombstone lift's backoff. Cleanup happens once, at removal time
// or on its retry, never per Autopilot cycle.
const CONNECTION_CLEANUP_KEY = 'aioman:pending-connection-server-cleanup'
const CONNECTION_CLEANUP_BACKOFF_BASE_MS = 30_000
const CONNECTION_CLEANUP_BACKOFF_MAX_MS = 60 * 60 * 1000

export interface PendingConnectionCleanup {
    /** Immutable identity of this entry: a drain applies its network result to the latest queue by this id. */
    entryId: string
    accountId: string
    connectionId: string
    /** Incarnation token of the removed connection: the retry carries it so the delete only claims that generation's rows. */
    generation?: string
    notBefore: number
    attempts?: number
}

// 403 will not change on retry and this cleanup has no 404 case: both drop the entry.
// Everything else retries with backoff, up to this cap.
export const MAX_CONNECTION_CLEANUP_ATTEMPTS = 8

export interface PendingConnectionCleanupStore {
    load(): Promise<unknown>
    save(entries: PendingConnectionCleanup[]): Promise<void>
}

const connectionCleanupKey = (accountId: string, connectionId: string) => `${accountId}:${connectionId}`
const connectionCleanupDedupeKey = (accountId: string, connectionId: string, generation?: string) => `${accountId}:${connectionId}:${generation ?? ''}`

const newQueueEntryId = () => {
    try { return crypto.randomUUID() } catch {
        return `entry-${Date.now()}-${Math.random().toString(36).slice(2)}`
    }
}

const defaultConnectionCleanupStore: PendingConnectionCleanupStore = {
    load: async () => {
        try {
            const localforage = (await import('localforage')).default
            return await localforage.getItem(CONNECTION_CLEANUP_KEY)
        } catch {
            return []
        }
    },
    save: async (entries) => {
        try {
            const localforage = (await import('localforage')).default
            await localforage.setItem(CONNECTION_CLEANUP_KEY, entries)
        } catch {
            // Best effort: the next drain retries what it can read.
        }
    },
}
let connectionCleanupStore: PendingConnectionCleanupStore = defaultConnectionCleanupStore

export function setPendingConnectionServerCleanupStore(store: PendingConnectionCleanupStore | null) {
    connectionCleanupStore = store ?? defaultConnectionCleanupStore
}

// One shared mutex for every read-modify-write on the queue array (SOL-R1-BETA-07): a
// drain waiting on its DELETE never holds this, so an enqueue during that wait lands
// in the same array instead of being erased by the drain's stale snapshot.
let connectionQueueTail: Promise<unknown> = Promise.resolve()
function serializeConnectionQueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = connectionQueueTail.then(operation, operation)
    connectionQueueTail = run.catch(() => { /* the tail only orders, it never fails */ })
    return run
}

const readConnectionCleanups = (value: unknown): PendingConnectionCleanup[] => (Array.isArray(value) ? value : []).flatMap(item => {
    if (!item || typeof item !== 'object') return []
    const raw = item as Partial<PendingConnectionCleanup>
    if (typeof raw.accountId !== 'string' || !raw.accountId || typeof raw.connectionId !== 'string' || !raw.connectionId) return []
    const entry: PendingConnectionCleanup = {
        // Entries persisted before entry ids existed keep a stable derived id.
        entryId: typeof raw.entryId === 'string' && raw.entryId ? raw.entryId : `legacy:${raw.accountId}:${raw.connectionId}:${Number(raw.notBefore) || 0}`,
        accountId: raw.accountId,
        connectionId: raw.connectionId,
        ...(typeof raw.generation === 'string' && raw.generation ? { generation: raw.generation } : {}),
        notBefore: Number(raw.notBefore) || 0,
        attempts: Number(raw.attempts) || 0,
    }
    return [entry]
})

export async function queuePendingConnectionServerCleanup(accountId: string, connectionId: string, now = Date.now(), generation?: string): Promise<void> {
    await serializeConnectionQueue(async () => {
        const entries = readConnectionCleanups(await connectionCleanupStore.load())
        const key = connectionCleanupDedupeKey(accountId, connectionId, generation)
        if (entries.some(entry => connectionCleanupDedupeKey(entry.accountId, entry.connectionId, entry.generation) === key)) return
        await connectionCleanupStore.save([...entries, {
            entryId: newQueueEntryId(),
            accountId,
            connectionId,
            ...(generation ? { generation } : {}),
            notBefore: now,
        }])
    })
}

// One drain at a time: a second certified pull during a drain's network wait does
// nothing instead of racing the first drain's result application.
let connectionDrainInFlight = false

/** Applies queued connection cleanups; returns how many cleared. */
export async function drainPendingConnectionServerCleanup(options: {
    call: AccountServerCleanupCall
    presentAccountIds: Iterable<string> | (() => Iterable<string>)
    presentConnections: Iterable<string> | (() => Iterable<string>)
    now?: number
}): Promise<number> {
    if (connectionDrainInFlight) return 0
    connectionDrainInFlight = true
    try {
        const now = options.now ?? Date.now()
        const entries = await serializeConnectionQueue(async () => readConnectionCleanups(await connectionCleanupStore.load()))
        if (entries.length === 0) return 0
        const presentAccounts = new Set(typeof options.presentAccountIds === 'function' ? options.presentAccountIds() : options.presentAccountIds)
        const readPresentConnections = () => new Set(typeof options.presentConnections === 'function' ? options.presentConnections() : options.presentConnections)
        // Applies one entry's outcome to the latest queue under the shared mutex. A
        // null replacement removes the entry; anything else patches it in place.
        const applyResult = async (entryId: string, replace: PendingConnectionCleanup | null) => {
            await serializeConnectionQueue(async () => {
                const latest = readConnectionCleanups(await connectionCleanupStore.load())
                const index = latest.findIndex(entry => entry.entryId === entryId)
                if (index === -1) return
                if (!replace) latest.splice(index, 1)
                else latest[index] = replace
                await connectionCleanupStore.save(latest)
            })
        }
        let deferUntil = 0
        let cleared = 0
        for (const entry of entries) {
            // Live presence, re-read per entry so a connection that came back during an
            // earlier await is caught (a restore re-registered its rows), and a gone
            // account leaves its rows to the account server-state cleanup.
            if (readPresentConnections().has(connectionCleanupKey(entry.accountId, entry.connectionId)) || !presentAccounts.has(entry.accountId)) {
                await applyResult(entry.entryId, null)
                continue
            }
            if (deferUntil) { await applyResult(entry.entryId, { ...entry, notBefore: Math.max(entry.notBefore, deferUntil) }); continue }
            if (entry.notBefore > now) continue
            let status = 0
            try {
                const res = await options.call(`/accounts/${encodeURIComponent(entry.accountId)}/server-state/connection/${encodeURIComponent(entry.connectionId)}${entry.generation ? `?generation=${encodeURIComponent(entry.generation)}` : ''}`, { method: 'DELETE' })
                if (res.ok) { cleared++; await applyResult(entry.entryId, null); continue }
                status = res.status
                if (status === 403 || status === 404) {
                    trace('account', 'connection-cleanup.dropped', { status })
                    await applyResult(entry.entryId, null)
                    continue
                }
                if (status === 429) deferUntil = now + retryAfterMs(res, now)
            } catch {
                // Offline: retried like a 5xx.
            }
            const attempts = (entry.attempts || 0) + 1
            if (attempts >= MAX_CONNECTION_CLEANUP_ATTEMPTS) {
                trace('account', 'connection-cleanup.gave-up', { attempts })
                await applyResult(entry.entryId, null)
                continue
            }
            await applyResult(entry.entryId, {
                ...entry,
                attempts,
                notBefore: status === 429 ? deferUntil : now + Math.min(CONNECTION_CLEANUP_BACKOFF_BASE_MS * 2 ** (attempts - 1), CONNECTION_CLEANUP_BACKOFF_MAX_MS),
            })
        }
        if (cleared > 0) trace('account', 'connection-cleanup.applied', { count: cleared })
        return cleared
    } finally {
        connectionDrainInFlight = false
    }
}

// An explicit import or restore brings accounts back, so their server-side deletion guard
// is lifted before their rules and sign-ins sync again. Lifts persist until the server
// confirms them; a 429 defers this and every later lift until its Retry-After.
const TOMBSTONE_LIFT_KEY = 'aioman:pending-account-tombstone-lift'

export interface PendingTombstoneLift {
    id: string
    notBefore: number
    attempts?: number
}

// 403/404 will not change on retry: the lift is dropped and the server's guard keeps
// refusing writes with its 409. Everything else retries with backoff, up to this cap.
export const MAX_TOMBSTONE_LIFT_ATTEMPTS = 8
const LIFT_BACKOFF_BASE_MS = 30_000
const LIFT_BACKOFF_MAX_MS = 60 * 60 * 1000

type TombstoneLiftReporter = (accountId: string, status: number) => void | Promise<void>

const defaultLiftReporter: TombstoneLiftReporter = async (_accountId, status) => {
    const { useSyncStore } = await import('@/store/syncStore')
    useSyncStore.getState().addLogEntry({
        type: 'push',
        status: 'error',
        message: `An imported account could not be restored on the server${status ? ` (${status})` : ''}. Its Autopilot rules and sign-ins will not sync until it is restored again.`,
        isAuto: true,
    })
}
let liftReporter: TombstoneLiftReporter = defaultLiftReporter

export function setTombstoneLiftReporter(reporter: TombstoneLiftReporter | null) {
    liftReporter = reporter ?? defaultLiftReporter
}

export interface PendingTombstoneLiftStore {
    load(): Promise<unknown>
    save(entries: PendingTombstoneLift[]): Promise<void>
}

const defaultLiftStore: PendingTombstoneLiftStore = {
    load: async () => {
        try {
            const localforage = (await import('localforage')).default
            return await localforage.getItem(TOMBSTONE_LIFT_KEY)
        } catch {
            return []
        }
    },
    save: async (entries) => {
        try {
            const localforage = (await import('localforage')).default
            await localforage.setItem(TOMBSTONE_LIFT_KEY, entries)
        } catch {
            // Best effort: the next drain retries what it can read.
        }
    },
}
let liftStore: PendingTombstoneLiftStore = defaultLiftStore

export function setPendingAccountTombstoneLiftStore(store: PendingTombstoneLiftStore | null) {
    liftStore = store ?? defaultLiftStore
}

const readLifts = (value: unknown): PendingTombstoneLift[] => (Array.isArray(value) ? value : []).flatMap(item =>
    item && typeof item === 'object' && typeof (item as PendingTombstoneLift).id === 'string' && (item as PendingTombstoneLift).id
        ? [{ id: (item as PendingTombstoneLift).id, notBefore: Number((item as PendingTombstoneLift).notBefore) || 0, attempts: Number((item as PendingTombstoneLift).attempts) || 0 }]
        : [])

export function retryAfterMs(res: Response, now: number): number {
    const header = res.headers.get('Retry-After')
    if (!header) return 60_000
    const seconds = Number(header)
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
    const at = Date.parse(header)
    return Number.isFinite(at) ? Math.max(0, at - now) : 60_000
}

/** Returns the account ids whose server guard is still in place. */
export async function liftAccountServerTombstones(call: AccountServerCleanupCall, ids: Iterable<string>, now = Date.now()): Promise<string[]> {
    const pending = new Map(readLifts(await liftStore.load()).map(entry => [entry.id, entry]))
    for (const id of ids) if (id && !pending.has(id)) pending.set(id, { id, notBefore: 0 })
    if (pending.size === 0) return []
    await liftStore.save([...pending.values()])
    let deferUntil = 0
    const giveUp = async (entry: PendingTombstoneLift, status: number) => {
        pending.delete(entry.id)
        trace('account', 'server-tombstone.lift-dropped', { status })
        try { await liftReporter(entry.id, status) } catch { /* the error surface is best effort */ }
    }
    for (const entry of [...pending.values()]) {
        if (deferUntil) { entry.notBefore = Math.max(entry.notBefore, deferUntil); continue }
        if (entry.notBefore > now) continue
        let status = 0
        try {
            const res = await call(`/accounts/${encodeURIComponent(entry.id)}/server-tombstone`, { method: 'DELETE' })
            if (res.ok) { pending.delete(entry.id); continue }
            status = res.status
            if (status === 403 || status === 404) { await giveUp(entry, status); continue }
            if (status === 429) {
                deferUntil = now + retryAfterMs(res, now)
                entry.notBefore = deferUntil
            }
        } catch {
            // Offline: retried like a 5xx.
        }
        entry.attempts = (entry.attempts || 0) + 1
        if (entry.attempts >= MAX_TOMBSTONE_LIFT_ATTEMPTS) { await giveUp(entry, status); continue }
        if (status !== 429) entry.notBefore = now + Math.min(LIFT_BACKOFF_BASE_MS * 2 ** (entry.attempts - 1), LIFT_BACKOFF_MAX_MS)
    }
    const remaining = [...pending.values()]
    await liftStore.save(remaining)
    if (remaining.length > 0) trace('account', 'server-tombstone.lift-pending', { count: remaining.length })
    return remaining.map(entry => entry.id)
}

export function drainPendingAccountTombstoneLifts(call: AccountServerCleanupCall, now = Date.now()): Promise<string[]> {
    return liftAccountServerTombstones(call, [], now)
}
