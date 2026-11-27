type NuvioCachedItem = { uniqueItemId?: string; progress?: number; duration?: number; watched?: number }

// Watched rows are built with progress 100 and no duration or position; resume rows carry their own.
function isNuvioWatchedItem(item: NuvioCachedItem): boolean {
    return item.progress === 100 && item.duration === 0 && item.watched === 0
}

// Kept items pass the same checks as a full read: resume points by episode, show or alias; watched episodes by episode or alias.
export function keepStaleNuvioItems<T extends NuvioCachedItem>(
    stale: T[],
    existingKeys: Set<string>,
    originKey: (item: T, unique: boolean) => string,
    aliasedKeyHit: (item: T, includeShow: boolean) => boolean,
): T[] {
    const kept = new Set<T>()
    for (const watchedPass of [false, true]) {
        for (const item of stale) {
            if (isNuvioWatchedItem(item) !== watchedPass) continue
            const key = originKey(item, Boolean(item.uniqueItemId))
            if (existingKeys.has(key) || aliasedKeyHit(item, !watchedPass)) continue
            if (!watchedPass && existingKeys.has(originKey(item, false))) continue
            existingKeys.add(key)
            kept.add(item)
        }
    }
    return stale.filter(item => kept.delete(item))
}
