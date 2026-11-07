import type { HistoryEntry } from '@/hooks/useWatchHistory'

/**
 * Final display merge: one card per account, watch day, normalized name and episode.
 * Entries arrive newest first; when two feeds (event log, live library row) describe
 * the same watch, the richer row wins (progress, poster, duration, completion state).
 */
export function dedupWatchEntries(
    entries: readonly HistoryEntry[],
    ctxOf: (accountId: string, sourceConnectionId?: string) => string,
): HistoryEntry[] {
    const normalizeName = (s: string) => s.normalize('NFC').toLowerCase().replace(/[^a-z0-9]/g, '')
    // Completion outranks presentation: for the same watch, a watched/completed row is
    // the truthful state even when the sibling event looks richer (poster, duration).
    const score = (e: HistoryEntry) =>
        (e.progress || 0)
        + (e.poster ? 50 : 0)
        + (e.duration ? 50 : 0)
        + ((e.flaggedWatched ?? 0) > 0 ? 150 : 0)
        + ((e.timesWatched ?? 0) > 0 ? 50 : 0)
    const byKey = new Map<string, HistoryEntry>()
    for (const entry of entries) {
        const normalizedName = normalizeName(entry.name || '')
        const isSeries = entry.type === 'series' || entry.type === 'anime' || entry.type === 'episode'
        const entryCtx = ctxOf(entry.accountId, entry.sourceConnectionId)
        // Correlate platform duplicates within a watch day, preserving earlier watches.
        const watchDay = entry.timestamp.toDateString()
        const episodeKey = isSeries && entry.episode != null
            ? `${entryCtx}:${watchDay}:${normalizedName}:${entry.season ?? 1}:${entry.episode}`
            : `${entryCtx}:${watchDay}:${normalizedName}`

        const existing = byKey.get(episodeKey)
        if (!existing || score(entry) > score(existing)) byKey.set(episodeKey, entry)
    }
    return [...byKey.values()]
}
