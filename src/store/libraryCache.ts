import { create } from 'zustand'
import localforage from 'localforage'
import { ActivityItem, LibraryItem } from '@/types/activity'
import { stremioClient } from '@/api/stremio-client'
import { encrypt, decrypt as decryptData } from '@/lib/crypto'
import { useAuthStore } from '@/store/authStore'
import { StremioAccount } from '@/types/account'

const CACHE_KEY = 'aio_library_cache'
const CACHE_TTL = 5 * 60 * 1000 // 5 minutes

interface CacheData {
    items: ActivityItem[]
    lastFetched: number
    lastMtimeByAccount: Record<string, string>
}

interface LibraryCacheState {
    items: ActivityItem[]
    lastFetched: number
    lastMtimeByAccount: Record<string, string>
    loading: boolean
    loadingProgress: { current: number; total: number }
    isStale: boolean

    ensureLoaded: (accounts: StremioAccount[]) => Promise<void>
    invalidate: () => void
    clear: () => Promise<void>
}

import { isActuallyWatched, transformLibraryItemToActivityItem } from '@/lib/activity-utils'


export const useLibraryCache = create<LibraryCacheState>((set, get) => ({
    items: [],
    lastFetched: 0,
    lastMtimeByAccount: {},
    loading: false,
    loadingProgress: { current: 0, total: 0 },
    isStale: false,

    invalidate: () => {
        set({ isStale: true })
        localforage.removeItem(CACHE_KEY)
    },

    clear: async () => {
        set({ items: [], lastFetched: 0, lastMtimeByAccount: {}, isStale: true })
        await localforage.removeItem(CACHE_KEY)
    },

    ensureLoaded: async (accounts: StremioAccount[]) => {
        const state = get()
        const now = Date.now()

        // 1. Check if already loaded in memory and fresh
        if (!state.isStale && state.items.length > 0 && (now - state.lastFetched < CACHE_TTL)) {
            return
        }

        // 2. Try to load from IndexedDB
        if (state.items.length === 0) {
            const encrypted = await localforage.getItem<string>(CACHE_KEY)
            const { encryptionKey } = useAuthStore.getState()

            if (encrypted && encryptionKey && !state.isStale) {
                try {
                    const decrypted = await decryptData(encrypted, encryptionKey)
                    const cached = JSON.parse(decrypted) as CacheData
                    if (now - cached.lastFetched < CACHE_TTL) {
                        set({
                            items: cached.items.map(i => {
                                const t = new Date(i.timestamp)
                                return {
                                    ...i,
                                    // Clamp cached items to 'now' to fix any lingering future dates
                                    timestamp: t.getTime() > now ? new Date(now) : t
                                }
                            }),
                            lastFetched: cached.lastFetched,
                            lastMtimeByAccount: cached.lastMtimeByAccount,
                            isStale: false
                        })
                        return
                    }
                } catch (e) {
                    console.error('[LibraryCache] Failed to decrypt cache:', e)
                    localforage.removeItem(CACHE_KEY)
                }
            }
        }

        // 3. Mock Data Generator (conditional)
        if (import.meta.env.DEV && import.meta.env.VITE_MOCK_ACTIVITY === 'true') {
            console.log('[LibraryCache] Generating mock data...')
            set({ loading: true, loadingProgress: { current: 0, total: 30 } })

            const mockItems: ActivityItem[] = []
            const accountCount = 30
            const itemsPerAccount = 500 // Increased for stress test (15k items total)

            for (let a = 0; a < accountCount; a++) {
                const accountId = `mock-acc-${a}`
                const accountName = `Mock User ${a}`
                for (let i = 0; i < itemsPerAccount; i++) {
                    const timestamp = new Date(now - (Math.random() * 365 * 24 * 60 * 60 * 1000))
                    mockItems.push({
                        id: `${accountId}:tt${i}`,
                        accountId,
                        accountName,
                        accountColorIndex: a % 10,
                        itemId: `tt${i}`,
                        uniqueItemId: `tt${i}`,
                        name: `Mock Content ${i}`,
                        type: Math.random() > 0.5 ? 'movie' : 'series',
                        poster: `https://picsum.photos/seed/${i}/200/300`,
                        timestamp,
                        duration: 3600000,
                        watched: 1800000,
                        progress: 50,
                        season: 1,
                        episode: i % 20
                    })
                }
                set({ loadingProgress: { current: a + 1, total: accountCount } })
                // Yield to UI
                await new Promise(r => setTimeout(r, 0))
            }

            mockItems.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
            set({
                items: mockItems,
                lastFetched: now,
                loading: false,
                isStale: false,
                loadingProgress: { current: accountCount, total: accountCount }
            })
            const { encryptionKey } = useAuthStore.getState()
            if (encryptionKey) {
                const encrypted = await encrypt(JSON.stringify({ items: mockItems, lastFetched: now, lastMtimeByAccount: {} }), encryptionKey)
                await localforage.setItem(CACHE_KEY, encrypted)
            }
            return
        }

        // 4. Real Fetch (Sequential but Batched Update)
        set({ loading: true, loadingProgress: { current: 0, total: accounts.length } })

        const { encryptionKey } = useAuthStore.getState()
        if (!encryptionKey) {
            set({ loading: false })
            throw new Error('App is locked')
        }

        const allItems: ActivityItem[] = []
        const newMtimes: Record<string, string> = { ...state.lastMtimeByAccount }

        for (let i = 0; i < accounts.length; i++) {
            const account = accounts[i]
            try {
                const authKey = await decryptData(account.authKey, encryptionKey)
                const libraryItems = await stremioClient.getLibraryItems(authKey, account.id) as LibraryItem[]

                const accountActivity = libraryItems
                    .filter(item => isActuallyWatched(item))
                    .map(item => transformLibraryItemToActivityItem(item, account, accounts))

                // Memory Optimization: Push in place instead of creating new arrays with spread
                // allItems.push(...accountActivity)
                for (let k = 0; k < accountActivity.length; k++) {
                    allItems.push(accountActivity[k])
                }

                // Track latest mtime
                const latestMtime = libraryItems.reduce((max, item) => {
                    if (!item._mtime) return max
                    return item._mtime > max ? item._mtime : max
                }, '0')
                newMtimes[account.id] = latestMtime

                // ONLY update progress, NOT the huge items list
                set({
                    loadingProgress: { current: i + 1, total: accounts.length }
                })

            } catch (err) {
                console.error(`[LibraryCache] Failed to fetch account ${account.name || account.id}:`, err)
            }

            // Small delay to allow UI to breathe (progress bar update)
            if (i < accounts.length - 1) {
                await new Promise(r => setTimeout(r, 50))
            }
        }

        // ONE SINGLE SORT & UPDATE AT THE END
        const finalItems = allItems.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())

        set({
            items: finalItems,
            lastFetched: now,
            lastMtimeByAccount: newMtimes,
            loading: false,
            isStale: false
        })

        if (encryptionKey) {
            const encrypted = await encrypt(JSON.stringify({
                items: finalItems,
                lastFetched: now,
                lastMtimeByAccount: newMtimes
            }), encryptionKey)
            await localforage.setItem(CACHE_KEY, encrypted)
        }
    }
}))
