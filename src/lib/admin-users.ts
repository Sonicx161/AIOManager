/**
 * Display rules for the Dashboard Users list: status from last seen, the tile
 * characters and the storage bar. Everything derives from the acct- handle,
 * dates and counts the server sends; never from account contents.
 * Relative imports for node:test.
 */

export type StatusTone = 'ok' | 'info' | 'muted' | 'idle' | 'warn'

export interface UserStatus {
    label: string
    tone: StatusTone
}

export const STATUS_LEGEND: (UserStatus & { detail: string })[] = [
    { label: 'Active today', tone: 'ok', detail: 'Seen in the last 24 h' },
    { label: 'This week', tone: 'info', detail: 'Seen in the last 7 days' },
    { label: 'This month', tone: 'muted', detail: 'Seen 7 to 29 days ago' },
    { label: 'Idle 30 d+', tone: 'idle', detail: 'No sync for 30 days' },
    { label: 'Inactive 180 d+', tone: 'warn', detail: 'No sync for 180 days' },
]

/** Never seen counts as inactive, as the server's inactive filter does. */
export function userStatus(inactiveDays: number | null): UserStatus {
    const d = inactiveDays
    const pick = (i: number) => ({ label: STATUS_LEGEND[i].label, tone: STATUS_LEGEND[i].tone })
    if (d === null || d >= 180) return pick(4)
    if (d < 1) return pick(0)
    if (d < 7) return pick(1)
    if (d < 30) return pick(2)
    return pick(3)
}

/** Two characters of the handle's hash part, never a name. */
export function tileChars(handle: string): string {
    const hex = handle.startsWith('acct-') ? handle.slice(5) : handle
    return hex.slice(0, 2)
}

/** Bar width relative to the largest loaded account, with a visible floor. */
export function storagePct(bytes: number, maxBytes: number): number {
    if (!maxBytes || maxBytes <= 0) return 0
    return Math.max(2, Math.min(100, (bytes / maxBytes) * 100))
}

export const PLATFORM_ORDER = ['stremio', 'nuvio', 'realstream', 'hydra', 'jellyfin', 'fusion', 'emby', 'other']

export function platformName(id: string): string {
    const names: Record<string, string> = {
        stremio: 'Stremio', nuvio: 'Nuvio', realstream: 'RealStream', hydra: 'Hydra', jellyfin: 'Jellyfin', fusion: 'Fusion', emby: 'Emby', other: 'Other',
    }
    return names[id] ?? id
}

export function sortPlatforms<T extends { platform: string }>(list: T[]): T[] {
    const rank = (p: string) => {
        const i = PLATFORM_ORDER.indexOf(p)
        return i === -1 ? PLATFORM_ORDER.length : i
    }
    return [...list].sort((a, b) => rank(a.platform) - rank(b.platform))
}
