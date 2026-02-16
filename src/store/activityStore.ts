import { stremioClient } from '@/api/stremio-client'
import { decrypt } from '@/lib/crypto'
import { useAccountStore } from '@/store/accountStore'
import { useAuthStore } from '@/store/authStore'
import localforage from 'localforage'
import { create } from 'zustand'
import { ActivityItem, LibraryItem } from '@/types/activity'

const STORAGE_KEY = 'stremio-manager:activity'
const DELETED_IDS_KEY = 'stremio-manager:activity-deleted'

interface ActivityState {
    history: ActivityItem[]
    deletedItemIds: Set<string> // Blacklist: Set of "accountId:uniqueItemId"
    loading: boolean
    error: string | null
    initialized: boolean
    lastUpdated: Date | null

    initialize: () => Promise<void>
    fetchActivity: (silent?: boolean) => Promise<void>
    repairHistory: () => Promise<void>
    clearHistory: () => Promise<void>
    deleteItems: (itemIds: string[], removeFromLibrary?: boolean) => Promise<void>
    deleteActivityForAccount: (accountId: string) => Promise<void>
    clearDeletedBlacklist: () => Promise<void>
    reset: () => Promise<void>
}

import { isActuallyWatched, getUniqueItemId, transformLibraryItemToActivityItem } from '@/lib/activity-utils'


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
                    const libraryItems = await stremioClient.getLibraryItems(authKey, account.id) as LibraryItem[]

                    console.log(`[Activity] Fetched ${libraryItems.length} library items for ${account.name || account.id}`)

                    // Build History (watched items only)
                    const activityItems = libraryItems
                        .filter(item => {
                            if (!isActuallyWatched(item)) return false
                            const uniqueId = getUniqueItemId(item)
                            const blacklistKey = `${account.id}:${uniqueId}`
                            return !deletedItemIds.has(blacklistKey)
                        })
                        .map(item => transformLibraryItemToActivityItem(item, account, accounts))

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

    // Intelligent repair: Scans history for glitches (e.g. >24h duration) and fixes them
    // WITHOUT wiping the entire history.
    repairHistory: async () => {
        set({ loading: true, error: null })
        try {
            const { history } = get()
            let repairedCount = 0

            // 1. Sanitize existing history
            const sanitizedHistory = history.map(item => {
                // Sanity check: Duration > 24 hours (86400000 ms) is likely a bug/glitch
                const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000
                if (item.duration > TWENTY_FOUR_HOURS_MS) {
                    console.warn(`[Smart Repair] Fixed glitchy duration for ${item.name}: ${item.duration}ms -> 0ms`)
                    repairedCount++
                    return { ...item, duration: 0, progress: 0, watched: 0 }
                }
                // Sanity check: Negative duration
                if (item.duration < 0) {
                    console.warn(`[Smart Repair] Fixed negative duration for ${item.name}: ${item.duration}ms -> 0ms`)
                    repairedCount++
                    return { ...item, duration: 0 }
                }
                return item
            })

            // 2. Save sanitized version
            set({ history: sanitizedHistory, lastUpdated: new Date() })
            await localforage.setItem(STORAGE_KEY, sanitizedHistory)

            console.log(`[Smart Repair] Complete. Fixed ${repairedCount} items.`)

            // 3. Fetch latest data to ensure we are up to date
            await get().fetchActivity(true) // silent fetch

        } catch (err) {
            console.error('Smart Repair failed:', err)
            set({ error: err instanceof Error ? err.message : 'Repair failed' })
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
    },

    reset: async () => {
        set({ history: [], deletedItemIds: new Set(), initialized: false, lastUpdated: null, error: null, loading: false })
        await localforage.removeItem(STORAGE_KEY)
        await localforage.removeItem(DELETED_IDS_KEY)
    }
}))
