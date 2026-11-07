/** Shared rules for the season picker row in SeasonBrowser. */

export const COMPACT_SEASON_THRESHOLD = 8

/** Pills up to 8 seasons, the compact stepper control above that. */
export function shouldUseCompactSeasonPicker(seasonCount: number): boolean {
    return seasonCount > COMPACT_SEASON_THRESHOLD
}

/**
 * Prev steps to the next lower season number, next to the next higher one, null at the ends.
 */
export function seasonStepNeighbors(
    seasons: ReadonlyArray<{ seasonNumber: number }>,
    current: number | null,
): { prev: number | null; next: number | null } {
    // Steps by season number whatever the display order: left goes down, right goes up.
    const ordered = [...seasons].sort((a, b) => a.seasonNumber - b.seasonNumber)
    const idx = ordered.findIndex(s => s.seasonNumber === current)
    return {
        prev: idx > 0 ? ordered[idx - 1].seasonNumber : null,
        next: idx >= 0 && idx < ordered.length - 1 ? ordered[idx + 1].seasonNumber : null,
    }
}

/** Seasons that have at least one actually-watched episode. */
export function watchedSeasonNumbers(watchedBySeason: ReadonlyMap<number, ReadonlySet<number>>): Set<number> {
    const watched = new Set<number>()
    for (const [season, episodes] of watchedBySeason) {
        if (episodes.size > 0) watched.add(season)
    }
    return watched
}
