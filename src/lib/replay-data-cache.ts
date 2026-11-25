import type { HistoryEntry } from '../hooks/useWatchHistory.ts'
import type { ActivityItem } from '../types/activity.ts'
import type { ActivityRowsMemo } from './activity-utils.ts'
import { computeReplayData, type ReplayDataWithEstimate } from './compute-replay-data.ts'
import { ReplayResultCache, replayClockKey } from './replay-result-cache.ts'
import { createWorkspaceResetSubscription } from './workspace-reset-subscription.ts'
import { onSharedHistoryRowsLock, sharedHistoryRows } from './shared-history-rows.ts'

let itemsMemo: ActivityRowsMemo | null = null
let accountItems = new WeakMap<ActivityItem[], Map<string, ActivityItem[]>>()
const results = new ReplayResultCache<ReplayDataWithEstimate>()

export function resetReplayDataCache(): void {
    itemsMemo = null
    accountItems = new WeakMap()
    results.clear()
    workspaceSubscription.release()
}

const workspaceSubscription = createWorkspaceResetSubscription(resetReplayDataCache, import.meta.hot)
onSharedHistoryRowsLock(resetReplayDataCache)

export function replayItems(history: ReadonlyArray<HistoryEntry>): ActivityItem[] {
    if (itemsMemo?.source === history) return itemsMemo.items
    workspaceSubscription.ensure()
    itemsMemo = sharedHistoryRows(history, itemsMemo)
    results.setRows(itemsMemo.items)
    return itemsMemo.items
}

export function replayItemsForAccount(items: ActivityItem[], accountId: string): ActivityItem[] {
    if (accountId === 'all') return items
    let byAccount = accountItems.get(items)
    if (!byAccount) {
        byAccount = new Map()
        accountItems.set(items, byAccount)
    }
    let filtered = byAccount.get(accountId)
    if (!filtered) {
        filtered = items.filter(item => item.accountId === accountId)
        byAccount.set(accountId, filtered)
    }
    return filtered
}

export function cachedReplayData(
    items: ActivityItem[],
    period: number | string,
    canonical: ReadonlyMap<string, string | undefined>,
    now = new Date(),
): ReplayDataWithEstimate {
    workspaceSubscription.ensure()
    return results.get(items, period, canonical, replayClockKey(now), () => computeReplayData(items, period, { canonicalConnections: canonical, now }))
}

export type ReplayViewState = 'loading' | 'empty' | 'ready'

/** What Replay shows. No rows once history has settled is empty, for all accounts or for the selected one. */
export function replayViewState(input: { historySettled: boolean; itemCount: number; accountSelected: boolean; selectedCount: number; hasResults: boolean }): ReplayViewState {
    if (!input.historySettled && input.itemCount === 0) return 'loading'
    if (input.itemCount === 0) return 'empty'
    if (input.accountSelected && input.selectedCount === 0) return 'empty'
    if (!input.hasResults) return 'loading'
    return 'ready'
}
