import { create } from 'zustand'
import { ProviderHealth, ProviderState } from '@/types/provider'
import { useVaultStore } from './vaultStore'
import localforage from 'localforage'
import { ACCOUNT_CONTEXT_SYSTEM_CHECK } from '@/lib/account-contexts'

const PROVIDER_COOLDOWN = 12 * 60 * 60 * 1000 // debrid subscription expiry only moves day-to-day; 12h is plenty
const CACHE_KEY = 'aio_provider_health'
const LAST_REFRESHED_KEY = 'aio_provider_lastRefreshed'

async function boundedAll<T>(tasks: (() => Promise<T>)[], limit: number): Promise<void> {
    let idx = 0
    const next = async (): Promise<void> => {
        if (idx >= tasks.length) return
        const i = idx++
        await tasks[i]()
        await next()
    }
    await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => next()))
}

const persistHealth = (health: Record<string, ProviderHealth>, lastRefreshed: number) => {
    localforage.setItem(CACHE_KEY, JSON.stringify(health)).catch(() => {})
    localforage.setItem(LAST_REFRESHED_KEY, String(lastRefreshed)).catch(() => {})
}

const loadCachedHealth = async (): Promise<{ health: Record<string, ProviderHealth>; lastRefreshed: number }> => {
    try {
        const [rawHealth, rawLastRefreshed] = await Promise.all([
            localforage.getItem<string>(CACHE_KEY),
            localforage.getItem<string>(LAST_REFRESHED_KEY),
        ])
        return {
            health: rawHealth ? JSON.parse(rawHealth) : {},
            lastRefreshed: rawLastRefreshed ? Number(rawLastRefreshed) : 0,
        }
    } catch {
        return { health: {}, lastRefreshed: 0 }
    }
}

interface ProviderStore extends ProviderState {
    lastRefreshed: number
    _hydrated: boolean
    hydrateFromCache: () => Promise<void>
    hydrateAndRefresh: () => Promise<void>
    refreshAll: () => Promise<void>
    forceRefreshAll: () => Promise<void>
    refreshProvider: (id: string) => Promise<void>
}

export const getDaysRemaining = (dateString: string | null): number | null => {
    if (!dateString) return null
    const expirationDate = new Date(dateString)
    if (Number.isNaN(expirationDate.getTime())) return null
    const today = new Date()
    const timeDiff = expirationDate.getTime() - today.getTime()
    const days = Math.ceil(timeDiff / (1000 * 3600 * 24))
    return Math.max(0, days)
}

export const useProviderStore = create<ProviderStore>((set, get) => ({
    health: {},
    isRefreshing: false,
    lastRefreshed: 0,
    _hydrated: false,

    hydrateFromCache: async () => {
        if (get()._hydrated) return
        const cached = await loadCachedHealth()
        set({ ...cached, _hydrated: true })
    },

    hydrateAndRefresh: async () => {
        await get().hydrateFromCache()
        await get().refreshAll()
    },

    refreshProvider: async (id: string) => {
        const key = useVaultStore.getState().keys.find((k) => k.id === id)
        if (!key) return

        set((state) => ({
            health: {
                ...state.health,
                [id]: {
                    ...(state.health[id] || {
                        id,
                        name: key.name,
                        provider: key.provider,
                        status: 'none',
                        daysRemaining: null,
                        expiresAt: null,
                        lastChecked: 0,
                    }),
                    loading: true,
                },
            },
        }))


        if (key.provider === 'other') {
            if (key.customExpiry) {
                const expiresAt = key.customExpiry
                const daysRemaining = getDaysRemaining(expiresAt)
                set((state) => ({
                    health: {
                        ...state.health,
                        [id]: {
                            ...state.health[id],
                            status: (daysRemaining ?? 0) > 0 ? 'active' : 'expired',
                            daysRemaining,
                            expiresAt,
                            loading: false,
                            lastChecked: Date.now(),
                        },
                    },
                }))
            } else {
                set((state) => ({
                    health: {
                        ...state.health,
                        [id]: {
                            ...state.health[id],
                            status: 'none',
                            daysRemaining: null,
                            expiresAt: null,
                            loading: false,
                            lastChecked: Date.now(),
                        },
                    },
                }))
            }
            persistHealth(get().health, get().lastRefreshed)
            return
        }

        try {
            const { useSyncStore } = await import('./syncStore')
            const { auth: syncAuth } = useSyncStore.getState()
            const proxyAuthHeaders: Record<string, string> = {}
            if (syncAuth.isAuthenticated) {
                const { getSyncPasswordHeader } = await import('@/lib/sync-auth')
                proxyAuthHeaders['x-sync-user'] = syncAuth.id
                proxyAuthHeaders['x-sync-password'] = await getSyncPasswordHeader(syncAuth)
            }

            if (!proxyAuthHeaders['x-sync-user']) {
                throw new Error('Sync login required for health checks')
            }

            let daysRemaining: number | null = 0
            let expiresAt: string | null = null
            let status: ProviderHealth['status'] = 'active'

            const proxyUrl = '/api/meta-proxy?url='

            if (key.provider === 'real-debrid') {
                const url = `${proxyUrl}${encodeURIComponent('https://api.real-debrid.com/rest/1.0/user')}`
                const res = await fetch(url, {
                    headers: {
                        ...proxyAuthHeaders,
                        Authorization: `Bearer ${key.value}`,
                        'x-account-context': ACCOUNT_CONTEXT_SYSTEM_CHECK
                    },
                })
                if (!res.ok) throw new Error(`Provider API returned ${res.status}`)
                const data = await res.json()
                if (data.type === 'premium' && data.expiration) {
                    expiresAt = data.expiration
                    daysRemaining = getDaysRemaining(expiresAt)
                } else {
                    status = 'expired'
                }
            } else if (key.provider === 'torbox') {
                const url = `${proxyUrl}${encodeURIComponent('https://api.torbox.app/v1/api/user/me?settings=true')}`
                const res = await fetch(url, {
                    headers: {
                        ...proxyAuthHeaders,
                        Authorization: `Bearer ${key.value}`,
                        'x-account-context': ACCOUNT_CONTEXT_SYSTEM_CHECK
                    },
                })
                if (!res.ok) throw new Error(`Provider API returned ${res.status}`)
                const resJson = await res.json()
                const data = resJson.data || resJson
                expiresAt = data.premium_expires_at || data.premium_until_iso
                const isSubscribed = data.is_subscribed || data.plan > 0
                if (isSubscribed && expiresAt) {
                    daysRemaining = getDaysRemaining(expiresAt)
                } else {
                    status = 'expired'
                }
            } else if (key.provider === 'premiumize') {
                const url = `${proxyUrl}${encodeURIComponent('https://www.premiumize.me/api/account/info')}?apikey=${key.value}`
                const res = await fetch(url, {
                    headers: { ...proxyAuthHeaders, 'x-account-context': ACCOUNT_CONTEXT_SYSTEM_CHECK }
                })
                if (!res.ok) throw new Error(`Provider API returned ${res.status}`)
                const data = await res.json()
                if (data.status === 'success' && data.premium_until > 0) {
                    expiresAt = new Date(data.premium_until * 1000).toISOString()
                    daysRemaining = getDaysRemaining(expiresAt)
                } else {
                    status = 'expired'
                    daysRemaining = 0
                }
            } else if (key.provider === 'alldebrid') {
                const url = `${proxyUrl}${encodeURIComponent('https://api.alldebrid.com/v4/user?agent=AIOManager')}`
                const res = await fetch(url, {
                    headers: {
                        ...proxyAuthHeaders,
                        Authorization: `Bearer ${key.value}`,
                        'x-account-context': ACCOUNT_CONTEXT_SYSTEM_CHECK
                    }
                })
                if (!res.ok) throw new Error(`Provider API returned ${res.status}`)
                const data = await res.json()
                if (data.status === 'success' && data.data.user.isPremium) {
                    expiresAt = new Date(data.data.user.premiumUntil * 1000).toISOString()
                    daysRemaining = getDaysRemaining(expiresAt)
                } else {
                    status = 'expired'
                }
            } else if (key.provider === 'debrid-link') {
                const url = `${proxyUrl}${encodeURIComponent('https://debrid-link.com/api/v2/account/infos')}`
                const res = await fetch(url, {
                    headers: {
                        ...proxyAuthHeaders,
                        Authorization: `Bearer ${key.value}`,
                        'x-account-context': ACCOUNT_CONTEXT_SYSTEM_CHECK
                    },
                })
                if (!res.ok) throw new Error(`Provider API returned ${res.status}`)
                const data = await res.json()
                if (data.success && data.value?.premiumLeft > 0) {
                    const premiumSeconds = data.value.premiumLeft
                    daysRemaining = Math.ceil(premiumSeconds / 86400)
                    expiresAt = new Date(Date.now() + premiumSeconds * 1000).toISOString()
                } else {
                    status = 'expired'
                }
            } else {
                set((state) => ({
                    health: {
                        ...state.health,
                        [id]: { ...state.health[id], loading: false, status: 'none', lastChecked: Date.now() }
                    }
                }))
                persistHealth(get().health, get().lastRefreshed)
                return
            }

            if ((daysRemaining ?? 0) <= 0) status = 'expired'

            set((state) => ({
                health: {
                    ...state.health,
                    [id]: {
                        id,
                        name: key.name,
                        provider: key.provider,
                        status,
                        daysRemaining,
                        expiresAt,
                        lastChecked: Date.now(),
                        loading: false,
                    },
                },
            }))
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error)
            console.warn(`[ProviderStore] Health check failed for ${key.name}: ${msg}`)
            set((state) => ({
                health: {
                    ...state.health,
                    [id]: {
                        ...state.health[id],
                        status: 'error',
                        error: msg,
                        loading: false,
                        lastChecked: Date.now(),
                    },
                },
            }))
        }
        persistHealth(get().health, get().lastRefreshed)
    },

    refreshAll: async () => {
        if (get().isRefreshing) return

        // Load the persisted cache first if we haven't yet, so a still-fresh result short-circuits
        // the cooldown gate instead of re-hitting every debrid API on a cold store / page load.
        if (!get()._hydrated) await get().hydrateFromCache()

        const { lastRefreshed, health } = get()
        const hasErrors = Object.values(health).some(h => h.status === 'error' && h.lastChecked && (Date.now() - h.lastChecked < 30 * 60 * 1000))
        if (!hasErrors && lastRefreshed && (Date.now() - lastRefreshed < PROVIDER_COOLDOWN)) return

        const keys = useVaultStore.getState().keys.filter(k =>
            ['real-debrid', 'torbox', 'premiumize', 'alldebrid', 'debrid-link', 'other'].includes(k.provider)
        )
        if (keys.length === 0) return

        set({ isRefreshing: true })
        try {
            await boundedAll(keys.map((k) => () => get().refreshProvider(k.id)), 3)
            set({ lastRefreshed: Date.now() })
        } finally {
            set({ isRefreshing: false })
        }
    },

    forceRefreshAll: async () => {
        const { isRefreshing } = get()
        if (isRefreshing) return

        const keys = useVaultStore.getState().keys.filter(k =>
            ['real-debrid', 'torbox', 'premiumize', 'alldebrid', 'debrid-link', 'other'].includes(k.provider)
        )
        if (keys.length === 0) return

        set({ isRefreshing: true })
        try {
            await boundedAll(keys.map((k) => () => get().refreshProvider(k.id)), 3)
            set({ lastRefreshed: Date.now() })
        } finally {
            set({ isRefreshing: false })
        }
    },
}))
