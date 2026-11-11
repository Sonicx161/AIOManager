// Undated rows feed hours (counter baselines, like Metrics) but join no period.
import type { ActivityItem } from '../types/activity.ts'
import { isDatedWatchTimestamp } from './watch-time.ts'

export interface ReplayHistoryPartition {
    /** Every row: feeds the watch-hours credit so counter baselines keep working. */
    context: ActivityItem[]
    /** Dated rows only: period membership, year/month options and every period filter. */
    dated: ActivityItem[]
}

export function partitionReplayHistory(history: ActivityItem[]): ReplayHistoryPartition {
    const dated = history.filter(item => isDatedWatchTimestamp(item.timestamp))
    return { context: history, dated }
}
