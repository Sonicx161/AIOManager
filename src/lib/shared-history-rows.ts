import type { HistoryEntry } from '../hooks/useWatchHistory.ts'
import type { ActivityItem } from '../types/activity.ts'
import { mapHistoryRows, type ActivityRowsMemo } from './activity-utils.ts'
import { createWorkspaceResetSubscription } from './workspace-reset-subscription.ts'
import { useAuthStore } from '@/store/authStore'

let latest: ActivityRowsMemo | null = null
let watchRows = new WeakMap<ActivityItem[], ActivityItem[]>()
const dependents = new Set<() => void>()
let lockBound = false

export function resetSharedHistoryRows(): void {
    latest = null
    watchRows = new WeakMap()
    workspaceSubscription.release()
}

const workspaceSubscription = createWorkspaceResetSubscription(resetSharedHistoryRows, import.meta.hot)

/** Page memos built on the shared rows drop with them when the vault key changes (lock, sign-out). */
export function onSharedHistoryRowsLock(reset: () => void): void {
    dependents.add(reset)
}

function bindLockReset(): void {
    if (lockBound) return
    lockBound = true
    useAuthStore.subscribe((state, prev) => {
        if (state.encryptionKey === prev.encryptionKey) return
        resetSharedHistoryRows()
        dependents.forEach(reset => reset())
    })
}

/** Activity, Replay and Metrics map a history through here, so one history keeps one set of row objects. */
export function sharedHistoryRows(history: ReadonlyArray<HistoryEntry>, previous: ActivityRowsMemo | null): ActivityRowsMemo {
    if (previous?.source === history) return previous
    if (latest?.source === history) return latest
    workspaceSubscription.ensure()
    bindLockReset()
    latest = mapHistoryRows(history, latest ?? previous)
    return latest
}

/** The rows with a watch date (no backfill), shared by Activity's header hours and Metrics. */
export function sharedWatchRows(items: ActivityItem[]): ActivityItem[] {
    let rows = watchRows.get(items)
    if (!rows) {
        rows = items.filter(item => !item.backfill)
        watchRows.set(items, rows)
    }
    return rows
}
