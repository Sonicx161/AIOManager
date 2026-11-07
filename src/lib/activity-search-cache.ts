// Per-item memo for the Activity feed search filter. Every committed search term
// re-scans the whole dated history (the input already debounces into searchTerm);
// these caches keep each scan exact while skipping the per-keystroke rebuild of
// haystacks and timestamp parses. Entries revalidate the only volatile inputs, so
// a scan through the cache returns exactly what the uncapped build would return.
import type { ActivityItem } from '@/types/activity'

export type CinemetaNameResolver = (itemId: string) => string | null | undefined

interface HaystackEntry { cinemeta: string | null | undefined; haystack: string }
interface TimeEntry { raw: unknown; ts: number }

const haystacks = new WeakMap<object, HaystackEntry>()
const times = new WeakMap<object, TimeEntry>()

export function activitySearchHaystack(item: ActivityItem, getCinemetaName: CinemetaNameResolver): string {
    const cinemeta = getCinemetaName(item.itemId) || ''
    const cached = haystacks.get(item)
    if (cached && cached.cinemeta === cinemeta) return cached.haystack
    const haystack = [
        item.name || '',
        item.itemId || '',
        item.source || '',
        cinemeta,
        item.season !== undefined ? `S${item.season}` : '',
        item.episode !== undefined ? `E${item.episode}` : '',
    ].join(' ').toLowerCase()
    haystacks.set(item, { cinemeta, haystack })
    return haystack
}

export function activityItemTimeMs(item: ActivityItem): number {
    const raw = item.timestamp
    if (raw instanceof Date) return raw.getTime()
    const cached = times.get(item)
    if (cached && cached.raw === raw) return cached.ts
    const ts = new Date(raw).getTime()
    times.set(item, { raw, ts })
    return ts
}
