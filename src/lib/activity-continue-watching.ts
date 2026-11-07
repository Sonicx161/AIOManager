import type { ActivityItem } from '@/types/activity'

type RailItem = Pick<ActivityItem, 'accountId' | 'progress' | 'mediaObservation'>

/** Continue Watching rows for a viewer: dismissed rows and rows that would read 0% are left out. */
export function continueWatchingRail<T extends RailItem>(items: readonly T[], userFilter: string, isDismissed: (item: T) => boolean): T[] {
    return items.filter(item =>
        (userFilter === 'all' || item.accountId === userFilter)
        && (Math.round(item.progress) >= 1 || item.mediaObservation?.kind === 'live')
        && !isDismissed(item))
}
