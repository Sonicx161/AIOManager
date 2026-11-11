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
