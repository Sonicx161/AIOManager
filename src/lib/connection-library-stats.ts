import { isUnresolvedActivityName } from './activity-metadata-overlay.ts'
import { buildRuntimeIndex, computeWatchHours, hoursRowFromItem } from './watch-hours.ts'

export interface LibraryStatsEntry {
    itemId: string
    name: string
    type: string
    season?: number
    episode?: number
    timestamp: Date | number | string
    duration: number
    watched: number
    progress: number
    overallTimeWatched?: number
    flaggedWatched?: number
    mediaObservation?: { kind?: string }
    backfill?: boolean
    importedSavedState?: boolean
    savedEpisodes?: { episodeCount: number }
}

export interface LibraryStats {
    movies: number
    episodes: number
    watchMs: number
    topShows: Array<{ itemId: string; name: string; episodes: number }>
}

const isSeries = (type: string) => type === 'series' || type === 'anime' || type === 'episode'

export function computeLibraryStats<T extends LibraryStatsEntry>(entries: readonly T[], counterKeyOf: (entry: T) => string): LibraryStats {
    let movies = 0
    let episodes = 0
    const shows = new Map<string, { episodes: number; names: Map<string, number>; seriesNames: Map<string, number> }>()
    for (const entry of entries) {
        if (!isSeries(entry.type)) {
            movies++
            continue
        }
        const count = entry.importedSavedState && entry.savedEpisodes ? entry.savedEpisodes.episodeCount : 1
        episodes += count
        let show = shows.get(entry.itemId)
        if (!show) shows.set(entry.itemId, show = { episodes: 0, names: new Map(), seriesNames: new Map() })
        show.episodes += count
        if (isUnresolvedActivityName(entry.name)) continue
        show.names.set(entry.name, (show.names.get(entry.name) || 0) + 1)
        // An episode row's name can be the episode's own title; only a row without an
        // episode anchor reliably names the series (parent) itself.
        if (entry.episode === undefined) show.seriesNames.set(entry.name, (show.seriesNames.get(entry.name) || 0) + 1)
    }
    const mostCommonName = (names: Map<string, number>): string => {
        let name = ''
        let best = 0
        for (const [candidate, uses] of names) {
            if (uses > best) {
                name = candidate
                best = uses
            }
        }
        return name
    }
    const topShows: LibraryStats['topShows'] = []
    for (const [itemId, show] of shows) {
        const name = mostCommonName(show.seriesNames) || mostCommonName(show.names)
        if (name) topShows.push({ itemId, name, episodes: show.episodes })
    }
    topShows.sort((a, b) => b.episodes - a.episodes)

    const runtimes = buildRuntimeIndex(entries)
    const watchMs = computeWatchHours(entries.map(entry => hoursRowFromItem(entry, counterKeyOf(entry))), runtimes).totalMs
    return { movies, episodes, watchMs, topShows: topShows.slice(0, 5) }
}
