import type { HistoryEntry } from '../hooks/useWatchHistory.ts'
import type { ActivityItem } from '../types/activity.ts'
import type { ActivityRowsMemo } from './activity-utils.ts'
import { enrichActivityItemsByIdentity } from './activity-cross-source-enrichment.ts'
import { createWorkspaceResetSubscription } from './workspace-reset-subscription.ts'
import { onSharedHistoryRowsLock, sharedHistoryRows, sharedWatchRows } from './shared-history-rows.ts'

export interface ActivityHistoryRows {
    sourceHistory: ActivityItem[]
    hoursSource: ActivityItem[]
}

let memo: { rows: ActivityRowsMemo; value: ActivityHistoryRows } | null = null

export function resetActivityHistoryRows(): void {
    memo = null
    workspaceSubscription.release()
}

const workspaceSubscription = createWorkspaceResetSubscription(resetActivityHistoryRows, import.meta.hot)
onSharedHistoryRowsLock(resetActivityHistoryRows)

export function activityHistoryRows(history: ReadonlyArray<HistoryEntry>): ActivityHistoryRows {
    if (memo?.rows.source === history) return memo.value
    workspaceSubscription.ensure()
    const rows = sharedHistoryRows(history, memo?.rows ?? null)
    if (memo && rows.items === memo.rows.items) {
        memo = { rows, value: memo.value }
        return memo.value
    }
    const value = {
        sourceHistory: enrichActivityItemsByIdentity(rows.items.filter(item => !item.backfill || item.importedSavedState)),
        hoursSource: sharedWatchRows(rows.items),
    }
    memo = { rows, value }
    return value
}
