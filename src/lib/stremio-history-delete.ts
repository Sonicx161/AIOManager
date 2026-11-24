import type { LibraryItem } from '../types/activity.ts'

// Stremio's datastorePut replaces the whole row, so a history delete sends the row back
// with only its watch state reset; name, type, poster and the library flags are kept.
export function historyClearedRow(row: LibraryItem, now: Date = new Date()): LibraryItem {
    return {
        ...row,
        state: {
            ...row.state,
            lastWatched: '',
            timeWatched: 0,
            timeOffset: 0,
            overallTimeWatched: 0,
            timesWatched: 0,
            flaggedWatched: 0,
            duration: 0,
            video_id: '',
            watched: '',
            season: 0,
            episode: 0,
        },
        _mtime: now.toISOString(),
    }
}

export async function clearStremioRowHistory(
    itemId: string,
    readRows: () => Promise<LibraryItem[]>,
    writeRow: (row: LibraryItem) => Promise<void>,
): Promise<'cleared' | 'absent'> {
    const rows = await readRows()
    if (rows.length > 1 || (rows[0] && rows[0]._id !== itemId)) throw new Error('The item could not be verified')
    if (!rows[0]) return 'absent'
    await writeRow(historyClearedRow(rows[0]))
    return 'cleared'
}
