import { parseWatchIdentity } from './jellyfin-records.ts'
import type { ParsedWatchIdentity, WatchProvider } from './jellyfin-records.ts'

const AIOSTREAMS_NONE16 = 0xffff
const AIOSTREAMS_MAX48 = 2 ** 48 - 1
const AIOSTREAMS_KIND = { movie: 1, series: 2, episode: 4 }
const AIOSTREAMS_PROVIDER: Record<WatchProvider, number> = { imdb: 1, tmdb: 2, tvdb: 3 }
const AIOSTREAMS_MEDIA = { movie: 1, series: 2 }

function numericId(provider: WatchProvider, value: string): number | null {
    const digits = provider === 'imdb' ? value.replace(/^tt/, '') : value
    if (!/^\d+$/.test(digits)) return null
    const numeric = Number(digits)
    return Number.isSafeInteger(numeric) && numeric <= AIOSTREAMS_MAX48 ? numeric : null
}

function aiostreamsItemId(parsed: ParsedWatchIdentity, form: 'leaf' | 'series'): string | null {
    const numeric = numericId(parsed.provider, parsed.value)
    if (numeric === null) return null
    const kind = form === 'series' ? AIOSTREAMS_KIND.series : AIOSTREAMS_KIND[parsed.type]
    const media = parsed.type === 'movie' ? AIOSTREAMS_MEDIA.movie : AIOSTREAMS_MEDIA.series
    let season = AIOSTREAMS_NONE16
    let episode = AIOSTREAMS_NONE16
    if (form === 'leaf' && parsed.type === 'episode') {
        if (parsed.season === undefined || parsed.episode === undefined) return null
        if (!Number.isSafeInteger(parsed.season) || parsed.season < 0 || parsed.season >= AIOSTREAMS_NONE16) return null
        if (!Number.isSafeInteger(parsed.episode) || parsed.episode < 0 || parsed.episode >= AIOSTREAMS_NONE16) return null
        season = parsed.season
        episode = parsed.episode
    }
    const byte1 = ((kind << 4) | AIOSTREAMS_PROVIDER[parsed.provider]).toString(16).padStart(2, '0')
    return `a1${byte1}${media.toString(16).padStart(2, '0')}${numeric.toString(16).padStart(12, '0')}${season.toString(16).padStart(4, '0')}${episode.toString(16).padStart(4, '0')}000000`
}

export function aiostreamsLeafItemId(identity: string): string | null {
    const parsed = parseWatchIdentity(identity)
    return parsed === null ? null : aiostreamsItemId(parsed, 'leaf')
}

export function aiostreamsSeriesItemId(identity: string): string | null {
    const parsed = parseWatchIdentity(identity)
    return parsed === null || parsed.type !== 'episode' ? null : aiostreamsItemId(parsed, 'series')
}
