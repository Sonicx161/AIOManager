import { mapConcurrent } from './concurrency.ts'

export const SYNC_NOW_CONCURRENCY = 5

export interface SyncNowDeps {
    pendingAccountIds: readonly string[]
    knownAccountIds: ReadonlySet<string>
    syncAccount: (id: string, forceRefresh: boolean, intent: 'user') => Promise<unknown>
    syncToRemote: () => Promise<unknown>
}

/** Pushes every account with pending changes (user intent), then the cloud vault. */
export async function syncPendingAndCloud(deps: SyncNowDeps): Promise<{ accounts: number; failed: number }> {
    const ids = [...new Set(deps.pendingAccountIds)].filter(id => deps.knownAccountIds.has(id))
    let failed = 0
    await mapConcurrent(ids, SYNC_NOW_CONCURRENCY, async (id) => {
        try {
            await deps.syncAccount(id, true, 'user')
        } catch {
            failed += 1
        }
    })
    await deps.syncToRemote()
    return { accounts: ids.length, failed }
}
