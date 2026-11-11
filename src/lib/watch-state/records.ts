import type { MigrationRow, WatchMediaType, WatchStateRecord } from './types.ts'

export function canonicalWatchIdentity(type: WatchMediaType, providerId: string, season?: number, episode?: number): string | null {
    const match = providerId.match(/^(?:(imdb):)?(tt\d{5,})$/) || providerId.match(/^(tmdb|tvdb):(\d+)$/)
    if (!match) return null
    const provider = match[1] || 'imdb'
    if (type === 'movie') return `movie:${provider}:${match[2]}`
    if (!Number.isSafeInteger(season) || season! < 0 || !Number.isSafeInteger(episode) || episode! < 1) return null
    return `episode:${provider}:${match[2]}:${season}:${episode}`
}

export function sourceTime(value: unknown): number | null {
    const time = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN
    return Number.isFinite(time) && time >= 100_000_000_000 && time <= Date.now() + 60_000 ? time : null
}

function ordered(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(ordered)
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, ordered(item)]))
    }
    return value
}

export async function watchFingerprint(value: unknown): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(ordered(value))))
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export function sameWatchTitle(left: WatchStateRecord, right: WatchStateRecord): boolean {
    if (left.type !== right.type || !left.identities.some(id => right.identities.includes(id))) return false
    const all = [left.identities, right.identities]
    for (const identities of all) {
        const seen = new Map<string, string>()
        for (const id of identities) {
            const provider = id.split(':').slice(0, 2).join(':')
            if (seen.has(provider) && seen.get(provider) !== id) return false
            seen.set(provider, id)
        }
    }
    const byProvider = new Map(left.identities.map(id => [id.split(':').slice(0, 2).join(':'), id]))
    return right.identities.every(id => {
        const existing = byProvider.get(id.split(':').slice(0, 2).join(':'))
        return !existing || existing === id
    })
}

export function hasSavedWatchState(record: WatchStateRecord): boolean {
    return record.unmodified !== true || record.watched !== false || record.positionMs !== 0 || record.playedAt !== null || record.playCount !== 0
}

export function matchesWatchPatch(record: WatchStateRecord, patch: { watched?: true; positionMs?: number; rating?: number; favorite?: true }): boolean {
    return (patch.watched === undefined || record.watched === patch.watched)
        && (patch.positionMs === undefined || record.positionMs === patch.positionMs)
        && (patch.rating === undefined || record.rating === patch.rating)
        && (patch.favorite === undefined || record.favorite === true)
}

export function formatWatchPosition(value: number): string {
    const seconds = Math.floor(value / 1_000)
    const hours = Math.floor(seconds / 3_600)
    const minutes = Math.floor(seconds / 60) % 60
    const rest = String(seconds % 60).padStart(2, '0')
    return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`
}

export function watchRecordTitle(record: WatchStateRecord): string {
    return record.type === 'episode' && record.seriesTitle ? record.seriesTitle : record.title
}

export function watchRecordSubtitle(record: WatchStateRecord): string {
    if (record.type !== 'episode') return record.type === 'movie' ? 'Movie' : 'Unidentified title'
    const episodeTitle = record.episodeTitle || (record.seriesTitle && record.title !== record.seriesTitle ? record.title : '')
    const coordinates = `Season ${record.season ?? '?'} · Episode ${record.episode ?? '?'}`
    return episodeTitle && episodeTitle !== watchRecordTitle(record) ? `${episodeTitle} · ${coordinates}` : coordinates
}

export function undatedRowCount(rows: readonly MigrationRow[], selected?: ReadonlySet<string>): number {
    return rows.filter(row => row.undated === true && row.status === 'ready' && (selected === undefined || selected.has(row.id))).length
}
