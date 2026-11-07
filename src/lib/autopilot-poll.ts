export const POLL_BASE_MS = 60_000
export const POLL_MAX_MS = 300_000
export const POLL_STABLE_THRESHOLD = 3
export const STATE_PULL_MAX_AGE_MS = 270_000

export interface PollCadence {
    intervalMs: () => number
    recordCycle: (switched: boolean) => void
    reset: () => void
}

/** Adaptive poll interval: backs off while nothing changes, snaps back to the base cadence on reset. */
export function createPollCadence(): PollCadence {
    let interval = POLL_BASE_MS
    let stable = 0
    return {
        intervalMs: () => interval,
        recordCycle: switched => {
            if (switched) {
                stable = 0
                interval = POLL_BASE_MS
                return
            }
            stable++
            if (stable >= POLL_STABLE_THRESHOLD) {
                interval = Math.min(interval * 2, POLL_MAX_MS)
                stable = 0
            }
        },
        reset: () => {
            interval = POLL_BASE_MS
            stable = 0
        },
    }
}

/** A heartbeat that never advances (stopped worker) must still refresh rule state periodically. */
export function isStatePullDue(lastPullAt: number, now: number): boolean {
    return now - lastPullAt >= STATE_PULL_MAX_AGE_MS
}
