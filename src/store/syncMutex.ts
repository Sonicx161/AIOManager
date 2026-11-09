// Per-account sync mutex. Leaf module (no imports) so the semantics stay loadable by
// the node:test runner; accountStore re-exports these for the rest of the app.

export const syncMutexes = new Map<string, Promise<void>>()

const takeMutex = (accountId: string): (() => void) => {
    let resolveMutex!: () => void
    syncMutexes.set(accountId, new Promise<void>((r) => { resolveMutex = r }))
    return () => {
        resolveMutex()
        syncMutexes.delete(accountId)
    }
}

export const acquireSyncMutex = async (accountId: string): Promise<() => void> => {
    while (syncMutexes.has(accountId)) {
        await syncMutexes.get(accountId)
    }
    return takeMutex(accountId)
}

// Non-blocking: null when another sync already holds the account.
export const tryAcquireSyncMutex = (accountId: string): (() => void) | null => {
    return syncMutexes.has(accountId) ? null : takeMutex(accountId)
}
