export interface RailProgressEvent {
    key: string
    timestamp: number | Date
    progress: number
    backfill?: boolean
}

export interface RailProgressItem {
    key: string
    timestamp: number | Date
    progress: number
}

const toMs = (value: number | Date): number => (value instanceof Date ? value.getTime() : value)

const FINISHED_PROGRESS = 95

// Rail (live library state) and the activity feed (event log) compute progress differently;
// the event log wins unless the live item is newer (actively being watched) or the event is
// a synthetic backfill, so both surfaces never disagree for the same movie.
export function reconcileRailProgress<T extends RailProgressItem>(
    liveItems: readonly T[],
    events: readonly RailProgressEvent[]
): T[] {
    const latestByKey = new Map<string, RailProgressEvent>()
    for (const event of events) {
        if (event.backfill) continue
        const current = latestByKey.get(event.key)
        if (!current || toMs(event.timestamp) > toMs(current.timestamp)) latestByKey.set(event.key, event)
    }

    return liveItems.flatMap(item => {
        const event = latestByKey.get(item.key)
        if (event && toMs(event.timestamp) >= toMs(item.timestamp)) {
            // A first snapshot can have unknown historical viewing time (zero) while
            // the same remote row supplies a real resume point. That tied event does
            // not establish a reset of the saved position.
            if (toMs(event.timestamp) === toMs(item.timestamp) && event.progress === 0 && item.progress > 0) return [item]
            const progress = Math.min(100, Math.max(0, event.progress))
            // The feed counts this as watched, so it is no longer something to continue.
            if (progress >= FINISHED_PROGRESS) return []
            return [{ ...item, progress }]
        }
        return [item]
    })
}
