export const CLIENT_WRITE_WINDOW_MS = 20000
const SHARED_CONTEXTS = new Set(['Bulk Op', 'Profile Swap', 'Clear All'])
const writes = new Map()

const keyOf = (owner, context) => `${owner || ''}\u0000${context}`

export function recordClientCollectionWrite(owner, context, now = Date.now()) {
    for (const [key, entry] of writes) {
        if (now - entry.at < CLIENT_WRITE_WINDOW_MS) break
        writes.delete(key)
    }
    const key = keyOf(owner, String(context))
    writes.delete(key)
    writes.set(key, { context: String(context), at: now })
}

export function hasRecentClientCollectionWrite(owner, accountId, now = Date.now()) {
    const live = (entry) => !!entry && now - entry.at < CLIENT_WRITE_WINDOW_MS
    if (!owner) {
        // An ownerless legacy rule cannot be matched to a workspace, so any live pause that could cover it holds it.
        for (const entry of writes.values()) {
            if (live(entry) && (entry.context === accountId || SHARED_CONTEXTS.has(entry.context))) return true
        }
        return false
    }
    if (live(writes.get(keyOf(owner, accountId)))) return true
    for (const context of SHARED_CONTEXTS) if (live(writes.get(keyOf(owner, context)))) return true
    return false
}
