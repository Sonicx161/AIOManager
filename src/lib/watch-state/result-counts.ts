// Pure result classification shared by the import dialog and its feedback panels.
//
// A row can be kept as a conflict only because its pre-write checks went stale: nothing was
// written to the destination, so it must never count or read as preserved destination state.
// It belongs with the rows that were not attempted: it needs a fresh preview again.
import type { MigrationResult } from './types.ts'

/** True only for a conflict that was never written: its checks went stale before the write. */
export function isStaleKeptResult(result: Pick<MigrationResult, 'status' | 'stale'>): boolean {
    return result.status === 'conflict' && result.stale === true
}

export interface MigrationResultCounts {
    imported: number
    kept: number
    unconfirmed: number
    stale: number
}

/** Outcome tallies for the results panel; a stale-kept row counts as not attempted, never as kept. */
export function migrationResultCounts(results: ReadonlyArray<Pick<MigrationResult, 'status' | 'stale'>>): MigrationResultCounts {
    let imported = 0
    let kept = 0
    let unconfirmed = 0
    let stale = 0
    for (const result of results) {
        if (result.status === 'applied') imported++
        else if (result.status === 'failed') unconfirmed++
        else if (isStaleKeptResult(result)) stale++
        else kept++
    }
    return { imported, kept, unconfirmed, stale }
}

const resultDescriptions = {
    applied: 'Saved and confirmed on this connection.',
    unchanged: 'Already saved here. No extra copy was needed.',
    conflict: 'Changed or existing watch information was kept.',
    failed: 'We couldn’t confirm this save. The title may already be saved; check a fresh preview before trying again.',
} as const

export function resultExplanation(result: MigrationResult): string {
    if (isStaleKeptResult(result)) return result.message
    if (result.status === 'failed' && result.failure) return result.message
    if (result.status === 'conflict' && result.message.includes('source record changed')) return 'The source changed after the preview. This title wasn’t copied; preview again to check its new state.'
    if (result.status === 'conflict' && result.message.includes('playing on the destination')) return 'This title is playing now, so it wasn’t copied. Try again after playback stops.'
    return resultDescriptions[result.status]
}
