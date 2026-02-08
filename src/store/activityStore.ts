import { stremioClient } from '@/api/stremio-client'
import { decrypt } from '@/lib/crypto'
import { useAccountStore } from '@/store/accountStore'
import { useAuthStore } from '@/store/authStore'
import localforage from 'localforage'
import { create } from 'zustand'

const STORAGE_KEY = 'stremio-manager:activity'
const DELETED_IDS_KEY = 'stremio-manager:activity-deleted'

export interface LibraryItem {
    _id: string
    name: string
    type: string
    poster: string
    background?: string
    logo?: string
    state: {
        lastWatched?: string
        timeOffset?: number
        duration?: number
        flaggedWatched?: number
        timesWatched?: number
        timeWatched?: number
        overallTimeWatched?: number
        video_id?: string
        watched?: string
        season?: number
        episode?: number
    }
    _ctime?: string
    _mtime?: string
}

export interface ActivityItem {
    id: string // Unique ID: accountId:uniqueItemId (episode-aware)
    accountId: string
    accountName: string
    accountColorIndex: number
    itemId: string // Base item ID (e.g., tt123)
    uniqueItemId: string // Episode-aware ID (e.g., tt123:1:5 for series)
    name: string
    type: string
    poster: string
    timestamp: Date
    duration: number
    watched: number
    progress: number
    season?: number
    episode?: number
}

interface ActivityState {
    history: ActivityItem[]
    deletedItemIds: Set<string> // Blacklist: Set of "accountId:uniqueItemId"
    loading: boolean
    error: string | null
    initialized: boolean
    lastUpdated: Date | null

    initialize: () => Promise<void>
    fetchActivity: (silent?: boolean) => Promise<void>
    clearHistory: () => Promise<void>
    deleteItems: (itemIds: string[], removeFromLibrary?: boolean) => Promise<void>
    deleteActivityForAccount: (accountId: string) => Promise<void>
    clearDeletedBlacklist: () => Promise<void>
}

/**
 * Syncio-aligned filter: checks if item was actually watched, not just added to library.
 */
function isActuallyWatched(item: LibraryItem): boolean {
    const s = item.state || {}

    // Check for positive watch time
    if ((s.timeWatched ?? 0) > 0 || (s.overallTimeWatched ?? 0) > 0) {
        return true
    }

    // Check for a valid video_id (indicates specific content was played)
    if (s.video_id && s.video_id.trim() !== '') {
        return true
    }

    // Check for times watched > 0
    if ((s.timesWatched ?? 0) > 0) {
        return true
    }

    return false
}

/**
 * Generates a unique ID for an activity item, accounting for series episodes.
 */
function getUniqueItemId(item: LibraryItem): string {
    const baseId = item._id

    // Handle both series and anime types
    if ((item.type === 'series' || item.type === 'anime') && item.state?.video_id) {
        const videoId = item.state.video_id
        const parts = videoId.split(':')

        // Standard format: "tt123:season:episode" (3 parts) or Kitsu "kitsu:id:s:e" (4 parts)
        if (parts.length >= 3) {
            return videoId // Already unique per episode
        }
        // Format: "tt123:episode" (2 parts, no season)
        if (parts.length === 2) {
            return `${parts[0]}:1:${parts[1]}` // Normalize to season 1
        }
    }

    // For movies or items without video_id, use base ID
    return baseId
}

/**
 * Gets the best timestamp for an activity item.
 */
function getWatchTimestamp(item: LibraryItem): Date {
    const times: number[] = []

    if (item.state?.lastWatched) {
        const d = new Date(item.state.lastWatched)
        if (!isNaN(d.getTime())) times.push(d.getTime())
    }
    if (item._mtime) {
        const d = new Date(item._mtime)
        if (!isNaN(d.getTime())) times.push(d.getTime())
    }

    // Use the most recent timestamp
    return times.length > 0 ? new Date(Math.max(...times)) : new Date()
}

/**
 * Extracts season/episode from video_id.
 * Handles multiple formats:
 * - IMDB: "tt123:season:episode" (3 parts, starts with 'tt')
 * - Kitsu/MAL: "kitsu:12345:episode" (3 parts, provider prefix = no season)
 * - Kitsu with season: "kitsu:12345:season:episode" (4 parts)
 * - Simple: "id:episode" (2 parts, season defaults to 1)
 */
function getSeasonEpisode(item: LibraryItem): { season?: number; episode?: number } {
    // Handle both series and anime types
    if ((item.type !== 'series' && item.type !== 'anime') || !item.state?.video_id) {
        return {}
    }

    const parts = item.state.video_id.split(':')
    const firstPart = parts[0]?.toLowerCase() || ''

    // Known anime providers that use format: provider:id:episode (no season)
    const animeProviders = ['kitsu', 'mal', 'anilist', 'anidb', 'tmdb']
    const isAnimeProvider = animeProviders.includes(firstPart)

    // 4 parts: "kitsu:12345:season:episode" - extract last two
    if (parts.length >= 4) {
        return {
            season: parseInt(parts[parts.length - 2], 10) || 1,
            episode: parseInt(parts[parts.length - 1], 10) || 0
        }
    }

    // 3 parts with anime provider: "kitsu:12345:episode" - NO season info
    if (parts.length === 3 && isAnimeProvider) {
        return {
            season: 1, // Anime with provider prefix = season 1 by default
            episode: parseInt(parts[2], 10) || 0
        }
    }

    // 3 parts with IMDB format: "tt123:season:episode"
    if (parts.length === 3) {
        return {
            season: parseInt(parts[1], 10) || 1,
            episode: parseInt(parts[2], 10) || 0
        }
    }

    // 2 parts: "id:episode" (no season info)
    if (parts.length === 2) {
        return {
            season: 1,
            episode: parseInt(parts[1], 10) || 0
        }
    }

    // Fallback to state values if available
    return {
        season: item.state.season ?? 1,
        episode: item.state.episode
    }
}

export const useActivityStore = create<ActivityState>((set, get) => ({
    history: [],
    deletedItemIds: new Set(),
    loading: false,
    error: null,
    initialized: false,
    lastUpdated: null,

    initialize: async () => {
        if (get().initialized) return

        set({ loading: true })
        try {
            // Load deleted items blacklist
            const deletedIds = await localforage.getItem<string[]>(DELETED_IDS_KEY)
            if (deletedIds) {
                set({ deletedItemIds: new Set(deletedIds) })
            }

            // Load cached history
            const stored = await localforage.getItem<ActivityItem[]>(STORAGE_KEY)
            if (stored) {
                const parsed = stored.map(item => ({
                    ...item,
                    timestamp: new Date(item.timestamp)
                }))
                set({ history: parsed })
            }
        } catch (err) {
            console.error('Failed to load activity history:', err)
        } finally {
            set({ loading: false, initialized: true })
        }
    },

    fetchActivity: async (silent = false) => {
        if (!silent) set({ loading: true, error: null })
        try {
            const { accounts } = useAccountStore.getState()
            const { encryptionKey } = useAuthStore.getState()
            const { deletedItemIds } = get()

            if (!encryptionKey) throw new Error('App is locked')

            // Build fresh activity list from API - Parallelized for speed
            const accountPromises = accounts.map(async account => {
                try {
                    const authKey = await decrypt(account.authKey, encryptionKey)
                    const libraryItems = await stremioClient.getLibraryItems(authKey) as LibraryItem[]

                    console.log(`[Activity] Fetched ${libraryItems.length} library items for ${account.name || account.id}`)

                    // Build History (watched items only)
                    const activityItems = libraryItems
                        .filter(item => {
                            if (!isActuallyWatched(item)) return false
                            const uniqueId = getUniqueItemId(item)
                            const blacklistKey = `${account.id}:${uniqueId}`
                            return !deletedItemIds.has(blacklistKey)
                        })
                        .map(item => {
                            const uniqueItemId = getUniqueItemId(item)
                            const timestamp = getWatchTimestamp(item)
                            const { season, episode } = getSeasonEpisode(item)
                            const duration = item.state?.duration || 0
                            const timeOffset = item.state?.timeOffset || 0
                            const progress = duration > 0 ? (timeOffset / duration) * 100 : 0

                            const accountColorIndex = accounts.indexOf(account) % 10

                            return {
                                id: `${account.id}:${uniqueItemId}`,
                                accountId: account.id,
                                accountName: account.name || account.email?.split('@')[0] || account.id || 'Unknown',
                                accountColorIndex,
                                itemId: item._id,
                                uniqueItemId,
                                name: item.name,
                                type: item.type,
                                poster: item.poster,
                                timestamp,
                                duration,
                                watched: timeOffset,
                                progress,
                                season,
                                episode
                            }
                        })

                    return activityItems
                } catch (err) {
                    console.warn(`Failed to fetch library for account ${account.id}:`, err)
                    return []
                }
            })

            const results = await Promise.all(accountPromises)
            const freshItems = results.flat()

            // MERGE LOGIC: Combine fresh snapshots with existing history
            // We use item.id as the key, which for series includes the specific episode ID.
            const { history: existingHistory } = get()
            const historyMap = new Map<string, ActivityItem>()

            // 1. Populate map with existing history
            existingHistory.forEach(item => historyMap.set(item.id, item))

            // 2. Overwrite/Add fresh items from Stremio (always contains the LATEST state)
            freshItems.forEach(item => {
                historyMap.set(item.id, item)
            })

            const mergedHistory = Array.from(historyMap.values())

            // Sort history by timestamp (newest first)
            mergedHistory.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())

            // Save and update state
            set({ history: mergedHistory, lastUpdated: new Date() })
            await localforage.setItem(STORAGE_KEY, mergedHistory)

            console.log(`[Activity] Loaded ${freshItems.length} activity items`)

        } catch (err) {
            console.error('Fetch activity failed:', err)
            set({ error: err instanceof Error ? err.message : 'Failed to fetch activity' })
        } finally {
            set({ loading: false })
        }
    },

    clearHistory: async () => {
        // Clear both history and blacklist
        set({ history: [], deletedItemIds: new Set(), initialized: false })
        await localforage.removeItem(STORAGE_KEY)
        await localforage.removeItem(DELETED_IDS_KEY)
        // Re-fetch fresh data
        await get().initialize()
        await get().fetchActivity()
    },

    deleteItems: async (itemIds: string[], removeFromLibrary = false) => {
        const { history, deletedItemIds } = get()
        const itemsToDelete = history.filter(item => itemIds.includes(item.id))

        if (removeFromLibrary) {
            const { accounts } = useAccountStore.getState()
            const { encryptionKey } = useAuthStore.getState()

            if (encryptionKey) {
                // Group by account to minimize decryption calls
                const itemsByAccount: Record<string, ActivityItem[]> = {}
                itemsToDelete.forEach(item => {
                    if (!itemsByAccount[item.accountId]) {
                        itemsByAccount[item.accountId] = []
                    }
                    itemsByAccount[item.accountId].push(item)
                })

                // Process each account
                for (const [accountId, items] of Object.entries(itemsByAccount)) {
                    const account = accounts.find(a => a.id === accountId)
                    if (account) {
                        try {
                            const authKey = await decrypt(account.authKey, encryptionKey)
                            await Promise.all(items.map(item =>
                                stremioClient.removeLibraryItem(authKey, item.itemId)
                                    .catch(e => console.error(`Failed to remove item ${item.itemId} from Stremio library:`, e))
                            ))
                        } catch (err) {
                            console.error(`Failed to process deletions for account ${account.name}:`, err)
                        }
                    }
                }
            }
        }

        // Add to blacklist (these won't reappear on next fetch)
        const newDeletedIds = new Set(deletedItemIds)
        itemsToDelete.forEach(item => {
            newDeletedIds.add(`${item.accountId}:${item.uniqueItemId}`)
        })

        // Update history
        const newHistory = history.filter(item => !itemIds.includes(item.id))

        set({ history: newHistory, deletedItemIds: newDeletedIds })
        await localforage.setItem(STORAGE_KEY, newHistory)
        await localforage.setItem(DELETED_IDS_KEY, Array.from(newDeletedIds))
    },

    deleteActivityForAccount: async (accountId: string) => {
        const { history, deletedItemIds } = get()
        const newHistory = history.filter(item => item.accountId !== accountId)

        // Also clean up blacklist entries for this account
        const newDeletedIds = new Set(
            Array.from(deletedItemIds).filter(id => !id.startsWith(`${accountId}:`))
        )

        if (newHistory.length !== history.length || newDeletedIds.size !== deletedItemIds.size) {
            set({ history: newHistory, deletedItemIds: newDeletedIds })
            await localforage.setItem(STORAGE_KEY, newHistory)
            await localforage.setItem(DELETED_IDS_KEY, Array.from(newDeletedIds))
        }
    },

    clearDeletedBlacklist: async () => {
        set({ deletedItemIds: new Set() })
        await localforage.removeItem(DELETED_IDS_KEY)
        // Re-fetch to restore previously deleted items
        await get().fetchActivity()
    }
}))
