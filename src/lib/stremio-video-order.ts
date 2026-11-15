import type { MetaVideo } from './watched-episodes.ts'

const hasSeriesInfo = (video: MetaVideo): boolean =>
    Number.isInteger(video.season) && Number.isInteger(video.episode)
    && video.season! >= 0 && video.episode! >= 0

const releasedAt = (video: MetaVideo): number | null => {
    const value = typeof video.released === 'string' ? Date.parse(video.released) : NaN
    return Number.isFinite(value) ? value : null
}

/** Matches the meta video's stable order followed by LibraryItemState's bitfield order. */
export function stremioVideoOrder(videos: readonly MetaVideo[]): MetaVideo[] {
    const seen = new Set<string>()
    const unique = videos.filter(video => typeof video.id === 'string' && !!video.id && !seen.has(video.id) && !!seen.add(video.id))
    const isSeries = unique.some(hasSeriesInfo)
    const metaOrder = [...unique].sort((a, b) => {
        const aInfo = hasSeriesInfo(a), bInfo = hasSeriesInfo(b)
        if (aInfo && bInfo) {
            const seasonA = a.season === 0 ? (2 ** 32) - 1 : a.season!
            const seasonB = b.season === 0 ? (2 ** 32) - 1 : b.season!
            return seasonA - seasonB || a.episode! - b.episode!
        }
        if (aInfo !== bInfo) return aInfo ? -1 : 1
        const aDate = releasedAt(a), bDate = releasedAt(b)
        if (aDate !== null && bDate !== null) return isSeries ? aDate - bDate : bDate - aDate
        if (aDate !== null) return -1
        if (bDate !== null) return 1
        return 0
    })
    return metaOrder.sort((a, b) => {
        const aInfo = hasSeriesInfo(a), bInfo = hasSeriesInfo(b)
        if (aInfo !== bInfo) return aInfo ? 1 : -1
        if (aInfo && bInfo) {
            const delta = a.season! - b.season! || a.episode! - b.episode!
            if (delta) return delta
        }
        const aDate = releasedAt(a), bDate = releasedAt(b)
        if (aDate === bDate) return 0
        if (aDate === null) return -1
        if (bDate === null) return 1
        return aDate - bDate
    })
}
