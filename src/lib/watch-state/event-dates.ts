import { sourceTime } from './records.ts'

export interface WatchEventDateLike {
    accountId: string
    sourceConnectionId?: string
    scopeKey?: string
    itemId: string
    video_id?: string
    event_ts: number
    type?: string
    season?: number
    episode?: number
    source?: string
    backfill?: boolean
}

/** Episode key in the same shape as getEpisodeIdentity, without its UI-bound imports. */
export function eventEpisodeKey(event: Pick<WatchEventDateLike, 'itemId' | 'video_id' | 'season' | 'episode'>): string | null {
    if (event.episode !== undefined) return `${event.itemId}:s${event.season ?? 1}:e${event.episode}`
    const parts = (event.video_id && event.video_id !== event.itemId ? event.video_id : '').split(':')
    if (parts.length >= 3) {
        const season = parseInt(parts[parts.length - 2])
        const episode = parseInt(parts[parts.length - 1])
        if (!isNaN(episode)) return `${event.itemId}:s${isNaN(season) ? 1 : season}:e${episode}`
    }
    if (parts.length === 2) {
        const episode = parseInt(parts[1])
        if (!isNaN(episode)) return `${event.itemId}:s1:e${episode}`
    }
    return null
}

export function episodeDateKey(itemId: string, season: number, episode: number): string {
    return `${itemId}:s${season}:e${episode}`
}

/** Scope an event belongs to: the frozen scopeKey, else the connection attribution. */
function eventScope(event: Pick<WatchEventDateLike, 'accountId' | 'sourceConnectionId' | 'scopeKey'>): string {
    return event.scopeKey ?? (event.sourceConnectionId ? `${event.accountId}::${event.sourceConnectionId}` : event.accountId)
}

/** Real Stremio events of one account login: external-platform and unattributed-scope rows are excluded. */
export function stremioScopedEvents(events: readonly WatchEventDateLike[], accountId: string, connectionId: string, canonical: boolean): WatchEventDateLike[] {
    const own = `${accountId}::${connectionId}`
    return events.filter(event => {
        if (event.source !== undefined && event.source !== 'stremio') return false
        const scope = eventScope(event)
        return scope === own || (canonical && scope === accountId)
    })
}

/** Latest real (non-backfill) event time per episode; backfill rows carry no true time. */
export function exactEpisodeDates(events: readonly WatchEventDateLike[], notAfter: number): Map<string, number> {
    const latest = new Map<string, number>()
    for (const event of events) {
        if (event.backfill === true) continue
        const time = sourceTime(event.event_ts)
        if (time === null || time > notAfter) continue
        const key = eventEpisodeKey(event)
        if (key === null) continue
        const known = latest.get(key)
        if (known === undefined || time > known) latest.set(key, time)
    }
    return latest
}
