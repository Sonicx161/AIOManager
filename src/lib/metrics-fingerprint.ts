// Fingerprints for the metrics worker gate. Kept import-free so node tests and the
// perf benches load it without the hook's React/store graph.

/** Every row field the worker reads; MetricsWorkerItem is structurally assignable. */
export interface FingerprintItem {
    id: string
    accountId: string
    accountName: string
    itemId: string
    counterKey: string
    name: string
    type: string
    poster: string
    timestamp: Date | string | number
    watched: number
    progress: number
    season?: number | null
    episode?: number | null
    overallTimeWatched?: number
    backfill?: boolean
    importedSavedState?: boolean
    duration?: number
    mediaServer?: boolean
    mediaPlayed?: boolean
    mediaPositionMs?: number
}

const FNV_OFFSET = 2166136261
const FNV_PRIME = 16777619

// Hash state stays in locals: a 32-bit value in a module or closure variable is boxed on every write.
function mixString(h: number, value: string): number {
    // Corrupt rows can carry non-strings in string fields; the old gate hashed
    // String(value ?? ''), so fall back to exactly that for anything else.
    const text = typeof value === 'string' ? value : String(value ?? '')
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), FNV_PRIME)
    return Math.imul(h ^ 31, FNV_PRIME)
}

export function fnvText(h: number, text: string): number {
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), FNV_PRIME)
    return h
}

function mixU32(h: number, word: number): number {
    h = Math.imul(h ^ word, FNV_PRIME)
    return Math.imul(h ^ (word >>> 16), FNV_PRIME)
}

const numberBits = new Float64Array(1)
const numberWords = new Uint32Array(numberBits.buffer)

// Bit-pattern mixing replaces the old String(value ?? '') per field: no allocation
// and no decimal formatting. -0 folds onto 0 and NaN onto one pattern, matching the
// collapses the old string form already had; every other distinct double stays
// distinct, which is at least as discriminating as the decimal string.
function mixNumber(h: number, value: number): number {
    if (value === 0) return Math.imul(mixU32(h, 0x30) ^ 31, FNV_PRIME)
    if (Number.isNaN(value)) return Math.imul(mixU32(mixU32(h, 0x7ff80000), 0) ^ 31, FNV_PRIME)
    numberBits[0] = value
    return Math.imul(mixU32(mixU32(h, numberWords[0]), numberWords[1]) ^ 31, FNV_PRIME)
}

function mixField(h: number, value: unknown): number {
    if (value === null || value === undefined) return Math.imul(h ^ 31, FNV_PRIME)
    if (typeof value === 'string') return mixString(h, value)
    if (typeof value === 'number') return mixNumber(h, value)
    if (typeof value === 'boolean') return Math.imul(mixU32(h, value ? 0x31 : 0x30) ^ 31, FNV_PRIME)
    return mixString(h, String(value ?? ''))
}

export function timestampMs(value: FingerprintItem['timestamp']): number {
    const time = value instanceof Date ? value.getTime() : new Date(value).getTime()
    return Number.isFinite(time) ? time : 0
}

/** Per-item hash over the exact fields the old gate mixed, usable as a memo value. */
export function hashMetricsWorkerItem(item: FingerprintItem): number {
    let h = FNV_OFFSET
    h = mixString(h, item.id)
    h = mixString(h, item.accountId)
    h = mixString(h, item.accountName)
    h = mixString(h, item.itemId)
    h = mixString(h, item.counterKey)
    h = mixString(h, item.name)
    h = mixString(h, item.type)
    h = mixString(h, item.poster)
    h = mixNumber(h, timestampMs(item.timestamp))
    h = mixField(h, item.watched)
    h = mixField(h, item.progress)
    h = mixField(h, item.season)
    h = mixField(h, item.episode)
    h = mixField(h, item.overallTimeWatched)
    h = mixField(h, item.backfill)
    h = mixField(h, item.importedSavedState)
    h = mixField(h, item.duration)
    h = mixField(h, item.mediaServer)
    h = mixField(h, item.mediaPlayed)
    h = mixField(h, item.mediaPositionMs)
    return h >>> 0
}
interface ItemHashMemo { canonical: unknown; hash: number }
const itemHashCache = new WeakMap<object, ItemHashMemo>()

/**
 * Array fingerprint: length prefix plus a running mix of each item's hash and its
 * period bit, exactly the inputs the old gate keyed on. Same items (any identity)
 * produce the same key; any field change produces a different one.
 */
export function createItemsFingerprint(items: ReadonlyArray<FingerprintItem>, periodStart: number | null | undefined): string {
    let hash = Math.imul(FNV_OFFSET ^ items.length, FNV_PRIME)
    for (const item of items) {
        hash = Math.imul(hash ^ hashMetricsWorkerItem(item), FNV_PRIME)
        hash = Math.imul(hash ^ (periodStart == null || timestampMs(item.timestamp) >= periodStart ? 1 : 0), FNV_PRIME)
    }
    return `${items.length}-${hash >>> 0}`
}

/**
 * Same key as createItemsFingerprint, memoized per source row: mapped worker items
 * are pure functions of their source row and the canonical map, so re-derivations
 * that reuse rows (account/period switches) skip re-hashing every field.
 */
export function createItemsFingerprintMemo(
    sources: ReadonlyArray<object>,
    mapped: ReadonlyArray<FingerprintItem>,
    canonical: unknown,
    periodStart: number | null | undefined,
    itemHashOf: (item: FingerprintItem) => number = hashMetricsWorkerItem,
): string {
    return itemsFingerprintBody(sources, mapped, canonical, periodStart, itemHashCache, itemHashOf)
}

export interface IsolatedItemsFingerprintMemo {
    (sources: ReadonlyArray<object>, mapped: ReadonlyArray<FingerprintItem>, canonical: unknown, periodStart: number | null | undefined): string
}

/**
 * Memo with its own private cache. Every cache entry is produced by one hash
 * contract (one itemHashOf over one mapped representation), so a second caller
 * with a different representation can never poison another caller's entries.
 */
export function createIsolatedItemsFingerprintMemo(itemHashOf: (item: FingerprintItem) => number = hashMetricsWorkerItem): IsolatedItemsFingerprintMemo {
    const cache = new WeakMap<object, ItemHashMemo>()
    return (sources, mapped, canonical, periodStart) => itemsFingerprintBody(sources, mapped, canonical, periodStart, cache, itemHashOf)
}

function itemsFingerprintBody(
    sources: ReadonlyArray<object>,
    mapped: ReadonlyArray<FingerprintItem>,
    canonical: unknown,
    periodStart: number | null | undefined,
    cache: WeakMap<object, ItemHashMemo>,
    itemHashOf: (item: FingerprintItem) => number,
): string {
    let hash = Math.imul(FNV_OFFSET ^ mapped.length, FNV_PRIME)
    for (let i = 0; i < mapped.length; i++) {
        const source = sources[i]
        let itemHash: number
        if (source !== null && typeof source === 'object') {
            const cached = cache.get(source)
            if (cached && cached.canonical === canonical) itemHash = cached.hash
            else {
                itemHash = itemHashOf(mapped[i])
                cache.set(source, { canonical, hash: itemHash })
            }
        } else {
            itemHash = itemHashOf(mapped[i])
        }
        hash = Math.imul(hash ^ itemHash, FNV_PRIME)
        hash = Math.imul(hash ^ (periodStart == null || timestampMs(mapped[i].timestamp) >= periodStart ? 1 : 0), FNV_PRIME)
    }
    return `${mapped.length}-${hash >>> 0}`
}

export type WorkerSupersedeAction = 'terminate' | 'queue'

/**
 * A request whose underlying data differs from the one still computing must
 * supersede it: the stale run's full-history clone would only stack up behind
 * the new one (the sync-churn path that OOMs WebKit tabs). A selection-only
 * change (same data) keeps queueing, so the in-flight result still lands.
 */
export function workerSupersedeAction(hasWorker: boolean, pendingCount: number, previousDataKey: string, nextDataKey: string): WorkerSupersedeAction {
    return hasWorker && pendingCount > 0 && nextDataKey !== previousDataKey ? 'terminate' : 'queue'
}
