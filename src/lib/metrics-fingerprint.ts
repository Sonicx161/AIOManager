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

// Module-scope hash state: hashing is synchronous, so no reentrancy is possible.
let h = 0

function endField(): void {
    h ^= 31
    h = Math.imul(h, FNV_PRIME)
}

function mixString(value: string): void {
    // Corrupt rows can carry non-strings in string fields; the old gate hashed
    // String(value ?? ''), so fall back to exactly that for anything else.
    const text = typeof value === 'string' ? value : String(value ?? '')
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i)
        h = Math.imul(h, FNV_PRIME)
    }
    endField()
}

function mixU32(word: number): void {
    h ^= word
    h = Math.imul(h, FNV_PRIME)
    h = Math.imul(h ^ (word >>> 16), FNV_PRIME)
}

const numberBits = new Float64Array(1)
const numberWords = new Uint32Array(numberBits.buffer)

// Bit-pattern mixing replaces the old String(value ?? '') per field: no allocation
// and no decimal formatting. -0 folds onto 0 and NaN onto one pattern, matching the
// collapses the old string form already had; every other distinct double stays
// distinct, which is at least as discriminating as the decimal string.
function mixNumber(value: number): void {
    if (value === 0) {
        mixU32(0x30)
        endField()
        return
    }
    if (Number.isNaN(value)) {
        mixU32(0x7ff80000)
        mixU32(0)
        endField()
        return
    }
    numberBits[0] = value
    mixU32(numberWords[0])
    mixU32(numberWords[1])
    endField()
}

function mixField(value: unknown): void {
    if (value === null || value === undefined) {
        endField()
        return
    }
    if (typeof value === 'string') {
        mixString(value)
        return
    }
    if (typeof value === 'number') {
        mixNumber(value)
        return
    }
    if (typeof value === 'boolean') {
        mixU32(value ? 0x31 : 0x30)
        endField()
        return
    }
    mixString(String(value ?? ''))
}

export function timestampMs(value: FingerprintItem['timestamp']): number {
    const time = value instanceof Date ? value.getTime() : new Date(value).getTime()
    return Number.isFinite(time) ? time : 0
}

/** Per-item hash over the exact fields the old gate mixed, usable as a memo value. */
export function hashMetricsWorkerItem(item: FingerprintItem): number {
    h = FNV_OFFSET
    mixString(item.id)
    mixString(item.accountId)
    mixString(item.accountName)
    mixString(item.itemId)
    mixString(item.counterKey)
    mixString(item.name)
    mixString(item.type)
    mixString(item.poster)
    mixNumber(timestampMs(item.timestamp))
    mixField(item.watched)
    mixField(item.progress)
    mixField(item.season)
    mixField(item.episode)
    mixField(item.overallTimeWatched)
    mixField(item.backfill)
    mixField(item.importedSavedState)
    mixField(item.duration)
    mixField(item.mediaServer)
    mixField(item.mediaPlayed)
    mixField(item.mediaPositionMs)
    const result = h >>> 0
    h = 0
    return result
}

interface ItemHashMemo { canonical: unknown; hash: number }
const itemHashCache = new WeakMap<object, ItemHashMemo>()

/**
 * Array fingerprint: length prefix plus a running mix of each item's hash and its
 * period bit, exactly the inputs the old gate keyed on. Same items (any identity)
 * produce the same key; any field change produces a different one.
 */
export function createItemsFingerprint(items: ReadonlyArray<FingerprintItem>, periodStart: number | null | undefined): string {
    let hash = FNV_OFFSET
    const mix = (word: number) => {
        hash ^= word
        hash = Math.imul(hash, FNV_PRIME)
    }
    mix(items.length)
    for (const item of items) {
        mix(hashMetricsWorkerItem(item))
        mix(periodStart == null || timestampMs(item.timestamp) >= periodStart ? 1 : 0)
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
    let hash = FNV_OFFSET
    const mix = (word: number) => {
        hash ^= word
        hash = Math.imul(hash, FNV_PRIME)
    }
    mix(mapped.length)
    for (let i = 0; i < mapped.length; i++) {
        const source = sources[i]
        let itemHash: number
        if (source !== null && typeof source === 'object') {
            const cached = itemHashCache.get(source)
            if (cached && cached.canonical === canonical) itemHash = cached.hash
            else {
                itemHash = itemHashOf(mapped[i])
                itemHashCache.set(source, { canonical, hash: itemHash })
            }
        } else {
            itemHash = itemHashOf(mapped[i])
        }
        mix(itemHash)
        mix(periodStart == null || timestampMs(mapped[i].timestamp) >= periodStart ? 1 : 0)
    }
    return `${mapped.length}-${hash >>> 0}`
}
