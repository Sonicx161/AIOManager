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

export interface RatingFavoriteFieldCounts {
    /** Written and confirmed by the destination's own readback. */
    copied: number
    /** The destination already had the requested value; nothing was written. */
    alreadyHere: number
    /** The destination kept a different existing value instead of the source's. */
    keptExisting: number
    /** The destination cannot store the value, or declined the write outright. */
    notStored: number
    /** Dispatched but never confirmed by a readback, or the row failed. */
    unconfirmed: number
    /** Not selected, not reached, or kept for review. */
    notRun: number
}

export interface RatingFavoriteCounts {
    ratings: RatingFavoriteFieldCounts
    favorites: RatingFavoriteFieldCounts
}

/**
 * Ratings and favorites tallies for the result summary. Every source value is
 * classified with its own reason: confirmed copies come only from applied
 * results whose verified readback carries the field; rows without a patch are
 * split into unsupported (capability or episode kind), kept-existing and
 * not-run using the planner's notes; applied rows whose verified record lacks
 * the field count as attempted-but-unconfirmed, never as copied.
 */
export function ratingFavoriteCounts(plan: { rows: ReadonlyArray<{ id: string; source: { rating?: number; favorite?: true }; status?: string; patch?: { rating?: number; favorite?: true }; notes?: readonly string[] }> }, results: ReadonlyArray<Pick<MigrationResult, 'rowId' | 'status' | 'verified' | 'dispatched' | 'keptExisting' | 'ratingNotStored' | 'favoriteNotStored'>>): RatingFavoriteCounts {
    const byResult = new Map(results.map(result => [result.rowId, result]))
    const counts: RatingFavoriteCounts = {
        ratings: { copied: 0, alreadyHere: 0, keptExisting: 0, notStored: 0, unconfirmed: 0, notRun: 0 },
        favorites: { copied: 0, alreadyHere: 0, keptExisting: 0, notStored: 0, unconfirmed: 0, notRun: 0 },
    }
    for (const row of plan.rows) {
        for (const field of ['rating', 'favorite'] as const) {
            const offered = field === 'rating' ? row.source.rating !== undefined : row.source.favorite === true
            if (!offered) continue
            const bucket = field === 'rating' ? counts.ratings : counts.favorites
            const inPatch = field === 'rating' ? row.patch?.rating !== undefined : row.patch?.favorite === true
            const notes = (row.notes ?? []).join(' ')
            const result = byResult.get(row.id)
            if (row.status === 'unchanged' && inPatch) {
                bucket.alreadyHere++
            } else if (!inPatch) {
                if (field === 'rating' && notes.includes('already has a different rating')) bucket.keptExisting++
                else if (field === 'rating' && notes.includes('Ratings cannot be preserved')) bucket.notStored++
                else if (field === 'favorite' && (notes.includes('Favorites cannot be preserved') || notes.includes('cannot favorite episodes'))) bucket.notStored++
                else bucket.notRun++
            } else if (result?.status === 'applied') {
                const confirmed = field === 'rating' ? result.verified?.rating !== undefined : result.verified?.favorite === true
                if (confirmed) bucket.copied++
                else if (field === 'rating' && result.keptExisting === true) bucket.keptExisting++
                else if (field === 'rating' && result.ratingNotStored === true) bucket.notStored++
                else if (field === 'favorite' && result.favoriteNotStored === true) bucket.notStored++
                else bucket.unconfirmed++
            } else if (result?.status === 'unchanged') {
                const alreadyPresent = field === 'rating' ? result.verified?.rating !== undefined : result.verified?.favorite === true
                if (alreadyPresent) bucket.alreadyHere++
                else bucket.notStored++
            } else if (result?.status === 'failed') {
                bucket.unconfirmed++
            } else if (result?.status === 'conflict' && result.dispatched === true) {
                // A mutation went out and its outcome needs review: attempted, not confirmed.
                bucket.unconfirmed++
            } else {
                // Stale-kept, never selected or not reached: not run.
                bucket.notRun++
            }
        }
    }
    return counts
}

/** One summary sentence each for ratings and favorites, or null when no source value was offered. */
export function ratingFavoriteSummary(counts: RatingFavoriteCounts): { ratings: string | null; favorites: string | null } {
    const sentence = (label: string, c: RatingFavoriteFieldCounts): string | null => {
        const offered = c.copied + c.alreadyHere + c.keptExisting + c.notStored + c.unconfirmed + c.notRun
        if (offered === 0) return null
        const parts: string[] = []
        const noun = (n: number) => `${n.toLocaleString()} ${n === 1 ? label : `${label}s`}`
        if (c.copied > 0) parts.push(`${noun(c.copied)} ${c.copied === 1 ? 'was' : 'were'} saved`)
        if (c.alreadyHere > 0) parts.push(`${c.alreadyHere.toLocaleString()} ${c.alreadyHere === 1 ? 'was' : 'were'} already on this destination`)
        if (c.keptExisting > 0) parts.push(`${noun(c.keptExisting)} kept the destination's existing ${label}`)
        if (c.notStored > 0) parts.push(`${noun(c.notStored)} could not be stored by this destination`)
        if (c.unconfirmed > 0) parts.push(`${noun(c.unconfirmed)} ${c.unconfirmed === 1 ? 'was' : 'were'} attempted but could not be confirmed`)
        if (c.notRun > 0) parts.push(`${noun(c.notRun)} ${c.notRun === 1 ? 'was' : 'were'} not selected or not reached`)
        return `${label === 'rating' ? 'Ratings' : 'Favorites'}: ${parts.join('; ')}.`
    }
    return {
        ratings: sentence('rating', counts.ratings),
        favorites: sentence('favorite', counts.favorites),
    }
}
