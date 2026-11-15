// Per-identity tombstones. A tombstone hides events at or before its deletion; a newer
// event_ts supersedes it (genuine re-watch). Timestamp-less events count as stale.

export function isIdentityDeleted(identityKey: string, tombstones: Record<string, number>, eventTs?: number): boolean {
    const deletedAt = tombstones[identityKey]
    if (deletedAt === undefined) return false
    // Undated events can't prove a newer re-watch, so their tombstone is absolute.
    return eventTs === undefined || !Number.isFinite(eventTs) || eventTs <= deletedAt
}

// Max-wins union used by BOTH sync directions: the pull path folds cloud tombstones into
// local state, and the push path folds local tombstones into the last-pulled cloud map so
// serialising the local map wholesale can never overwrite fresher cloud deletes.
export function mergeDeletedEventMaps(local: Record<string, number>, remote: Record<string, number>): Record<string, number> {
    const merged: Record<string, number> = { ...remote }
    for (const [key, ts] of Object.entries(local)) {
        if (!(key in merged) || ts > merged[key]) merged[key] = ts
    }
    return merged
}

export function isSyntheticBackfillEvent(event: { id?: unknown; backfill?: unknown; time_watched?: unknown; time_watched_delta?: unknown; duration?: unknown }): boolean {
    return typeof event.id === 'string' && event.id.startsWith('bf:')
        && event.backfill === true && event.time_watched === 0 && event.duration === 0
        && (event.time_watched_delta === undefined || event.time_watched_delta === null || event.time_watched_delta === 0)
}

export function mergeBackfillEvent<T extends object>(previous: T, next: T): T {
    const before = previous as Record<string, unknown>
    const after = next as Record<string, unknown>
    if (typeof after.id !== 'string' || !after.id.startsWith('bf:')) return next
    const keepBefore = (before.backfill === false && after.backfill !== false)
        || (after.backfill !== false && !isSyntheticBackfillEvent(before) && isSyntheticBackfillEvent(after))
    const merged: Record<string, unknown> = { ...(keepBefore ? before : after) }
    if (before.backfill === false || after.backfill === false) merged.backfill = false
    for (const field of ['time_watched', 'time_watched_delta', 'duration', 'bfConfirmedAt']) {
        const a = before[field], b = after[field]
        if (typeof a === 'number' && Number.isFinite(a) && typeof b === 'number' && Number.isFinite(b)) merged[field] = Math.max(a, b)
        else if (typeof a === 'number' && Number.isFinite(a)) merged[field] = a
        else if (typeof b === 'number' && Number.isFinite(b)) merged[field] = b
    }
    return merged as T
}

export function mergeWatchEventsById<T extends object>(events: readonly T[]): T[] {
    const merged = new Map<string, T>()
    for (const event of events) {
        const id = (event as { id?: unknown }).id
        if (typeof id !== 'string') continue
        const previous = merged.get(id)
        merged.set(id, previous ? mergeBackfillEvent(previous, event) : event)
    }
    return Array.from(merged.values())
}

export function mergeBackfillDuplicates<T extends { id: string }>(events: T[]): T[] {
    const positions = new Map<string, number>()
    let merged: T[] | undefined
    for (const [index, event] of events.entries()) {
        if (!event.id.startsWith('bf:')) { merged?.push(event); continue }
        const previous = positions.get(event.id)
        if (previous === undefined) {
            positions.set(event.id, merged ? merged.length : index)
            merged?.push(event)
        } else {
            if (!merged) merged = events.slice(0, index)
            merged[previous] = mergeBackfillEvent(merged[previous], event)
        }
    }
    return merged ?? events
}
