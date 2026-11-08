// Shared pre-write freshness guard for watch-state destinations.
//
// A background tab can be suspended between a destination's last pre-write check
// and its write (iOS Safari freezes hidden tabs without firing pagehide; Chrome can
// freeze long-hidden tabs), and a facade request gate can hold a write for its whole
// window. Another player can change the title in the meantime, so checks older than
// this bound must never authorize a write. Normal runs never trip it: gate waits are
// bounded by the gate's 30 s window.

export const PREWRITE_FRESH_MS = 60_000

export class StaleChecksError extends Error {
    // partial: an earlier write for the same row already landed before the checks went stale.
    readonly partial: boolean
    constructor(partial = false) {
        super('The pre-write checks are too old to write safely.')
        this.name = 'StaleChecksError'
        this.partial = partial
    }
}

export function assertFreshChecks(checkedAt: number, now: number = Date.now()): void {
    if (now - checkedAt > PREWRITE_FRESH_MS) throw new StaleChecksError()
}
