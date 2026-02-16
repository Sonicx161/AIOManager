import { LibraryItem, ActivityItem } from '@/types/activity'
import { StremioAccount } from '@/types/account'

/**
 * Syncio-aligned filter: checks if item was actually watched, not just added to library.
 */
export function isActuallyWatched(item: LibraryItem): boolean {
    const s = item.state || {}
    // Check for positive watch time
    if ((s.timeWatched ?? 0) > 0 || (s.overallTimeWatched ?? 0) > 0) return true
    // Check for a valid video_id (indicates specific content was played)
    if (s.video_id && s.video_id.trim() !== '') return true
    // Check for times watched > 0
    if ((s.timesWatched ?? 0) > 0) return true
    return false
}

/**
 * Generates a unique ID for an activity item, accounting for series episodes.
 */
export function getUniqueItemId(item: LibraryItem): string {
    const baseId = item._id
    // Handle both series and anime types
    if ((item.type === 'series' || item.type === 'anime') && item.state?.video_id) {
        const videoId = item.state.video_id
        const parts = videoId.split(':')
        // Standard format: "tt123:season:episode" (3 parts) or Kitsu "kitsu:id:s:e" (4 parts)
        if (parts.length >= 3) return videoId
        // Format: "tt123:episode" (2 parts, no season)
        if (parts.length === 2) return `${parts[0]}:1:${parts[1]}`
    }
    return baseId
}

/**
 * Gets the best timestamp for an activity item.
 * Clamps to 'now' to prevent future dates.
 */
export function getWatchTimestamp(item: LibraryItem): Date {
    const times: number[] = []
    if (item.state?.lastWatched) {
        const d = new Date(item.state.lastWatched)
        if (!isNaN(d.getTime())) times.push(d.getTime())
    }
    if (item._mtime) {
        const d = new Date(item._mtime)
        if (!isNaN(d.getTime())) times.push(d.getTime())
    }
    const now = Date.now()

    // Filter out dates that are significantly in the future (> 5 mins)
    // This protects against Stremio sending bad timestamps (e.g. 12h future) 
    // which would otherwise be clamped to "now" and appear as "Just now"
    const validTimes = times.filter(t => t <= now + 5 * 60 * 1000)

    // If we have valid past/present times, use the latest of them.
    // If all times were future (invalid), fall back to 'now' (safe default)
    const maxTime = validTimes.length > 0 ? Math.max(...validTimes) : now

    return new Date(Math.min(maxTime, now))
}

/**
 * Extracts season/episode from video_id.
 */
export function getSeasonEpisode(item: LibraryItem): { season?: number; episode?: number } {
    if ((item.type !== 'series' && item.type !== 'anime') || !item.state?.video_id) {
        return {}
    }

    const parts = item.state.video_id.split(':')
    const firstPart = parts[0]?.toLowerCase() || ''
    const animeProviders = ['kitsu', 'mal', 'anilist', 'anidb', 'tmdb']
    const isAnimeProvider = animeProviders.includes(firstPart)

    if (parts.length >= 4) {
        return {
            season: parseInt(parts[parts.length - 2], 10) || 1,
            episode: parseInt(parts[parts.length - 1], 10) || 0
        }
    }

    if (parts.length === 3 && isAnimeProvider) {
        return { season: 1, episode: parseInt(parts[2], 10) || 0 }
    }

    if (parts.length === 3) {
        return {
            season: parseInt(parts[1], 10) || 1,
            episode: parseInt(parts[2], 10) || 0
        }
    }

    if (parts.length === 2) {
        return { season: 1, episode: parseInt(parts[1], 10) || 0 }
    }

    return {
        season: item.state.season ?? 1,
        episode: item.state.episode
    }
}

/**
 * Transforms a raw Stremio library item into a normalized ActivityItem.
 * Including filtering out junk data and standardizing properties.
 */
export function transformLibraryItemToActivityItem(
    item: LibraryItem,
    account: StremioAccount,
    accounts: StremioAccount[]
): ActivityItem {
    const uniqueItemId = getUniqueItemId(item)
    const timestamp = getWatchTimestamp(item)
    const { season, episode } = getSeasonEpisode(item)
    let duration = item.state?.duration || 0
    const timeOffset = item.state?.timeOffset || 0
    const overallTimeWatched = item.state?.overallTimeWatched

    // SANITY CHECK: If duration > 24 hours, it's likely a timestamp/junk data
    const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000
    if (duration > TWENTY_FOUR_HOURS_MS) {
        // console.warn(`[Activity] Junk duration detected for ${item.name}: ${duration}. Resetting to 0.`)
        duration = 0
    }

    const progress = duration > 0 ? Math.min(100, Math.max(0, (timeOffset / duration) * 100)) : 0
    const accountColorIndex = accounts.indexOf(account) % 10

    return {
        id: `${account.id}:${uniqueItemId}`,
        accountId: account.id,
        accountName: account.name || account.email?.split('@')[0] || account.id || 'Unknown',
        accountColorIndex,
        itemId: item._id,
        uniqueItemId,
        name: item.name || 'Unknown Title',
        type: item.type || 'other',
        poster: item.poster || '',
        timestamp,
        duration,
        watched: timeOffset,
        progress,
        season,
        episode,
        overallTimeWatched
    }
}
