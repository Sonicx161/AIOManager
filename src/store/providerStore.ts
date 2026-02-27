import { create } from 'zustand'
import { ProviderHealth, ProviderState } from '@/types/provider'
import { useVaultStore } from './vaultStore'
import axios from 'axios'

interface ProviderStore extends ProviderState {
    refreshAll: () => Promise<void>
    refreshProvider: (id: string) => Promise<void>
}

const getDaysRemaining = (dateString: string | null) => {
    if (!dateString) return 0
    const expirationDate = new Date(dateString)
    const today = new Date()
    const timeDiff = expirationDate.getTime() - today.getTime()
    const days = Math.ceil(timeDiff / (1000 * 3600 * 24))
    return Math.max(0, days)
}

export const useProviderStore = create<ProviderStore>((set, get) => ({
    health: {},
    isRefreshing: false,

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

        try {
            let daysRemaining = 0
            let expiresAt: string | null = null
            let status: ProviderHealth['status'] = 'active'

            // We use a proxy to avoid CORS issues with provider APIs
            const proxyUrl = '/api/meta-proxy?url='

            if (key.provider === 'real-debrid') {
                const url = `${proxyUrl}${encodeURIComponent('https://api.real-debrid.com/rest/1.0/user')}`
                const res = await axios.get(url, {
                    headers: {
                        Authorization: `Bearer ${key.value}`,
                        'x-account-context': 'System Check'
                    },
                })
                const data = res.data
                if (data.type === 'premium' && data.expiration) {
                    expiresAt = data.expiration
                    daysRemaining = getDaysRemaining(expiresAt)
                } else {
                    status = 'expired'
                }
            } else if (key.provider === 'torbox') {
                const url = `${proxyUrl}${encodeURIComponent('https://api.torbox.app/v1/api/user/me?settings=true')}`
                const res = await axios.get(url, {
                    headers: {
                        Authorization: `Bearer ${key.value}`,
                        'x-account-context': 'System Check'
                    },
                })
                const data = res.data.data || res.data
                expiresAt = data.premium_expires_at || data.premium_until_iso
                const isSubscribed = data.is_subscribed || data.plan > 0
                if (isSubscribed && expiresAt) {
                    daysRemaining = getDaysRemaining(expiresAt)
                } else {
                    status = 'expired'
                }
            } else if (key.provider === 'premiumize') {
                const url = `${proxyUrl}${encodeURIComponent('https://www.premiumize.me/api/account/info')}?apikey=${key.value}`
                const res = await axios.get(url, {
                    headers: { 'x-account-context': 'System Check' }
                })
                const data = res.data
                if (data.status === 'success' && data.premium_until > 0) {
                    expiresAt = new Date(data.premium_until * 1000).toISOString()
                    daysRemaining = getDaysRemaining(expiresAt)
                } else {
                    status = 'expired'
                    daysRemaining = 0
                }
            } else if (key.provider === 'alldebrid') {
                const url = `${proxyUrl}${encodeURIComponent('https://api.alldebrid.com/v4/user/me')}?agent=AIOManager&apikey=${key.value}`
                const res = await axios.get(url, {
                    headers: { 'x-account-context': 'System Check' }
                })
                const data = res.data
                if (data.status === 'success' && data.data.user.isPremium) {
                    expiresAt = new Date(data.data.user.premiumUntil * 1000).toISOString()
                    daysRemaining = getDaysRemaining(expiresAt)
                } else {
                    status = 'expired'
                }
            } else if (key.provider === 'debrid-link') {
                const url = `${proxyUrl}${encodeURIComponent('https://debrid-link.com/api/v2/account/infos')}`
                const res = await axios.get(url, {
                    headers: {
                        Authorization: `Bearer ${key.value}`,
                        'x-account-context': 'System Check'
                    },
                })
                const data = res.data
                if (data.success && data.value?.premiumLeft > 0) {
                    const premiumSeconds = data.value.premiumLeft
                    daysRemaining = Math.ceil(premiumSeconds / 86400)
                    expiresAt = new Date(Date.now() + premiumSeconds * 1000).toISOString()
                } else {
                    status = 'expired'
                }
            } else {
                // Trakt or other - not implemented for expiry yet
                set((state) => ({
                    health: {
                        ...state.health,
                        [id]: { ...state.health[id], loading: false, status: 'none', lastChecked: Date.now() }
                    }
                }))
                return
            }

            if (daysRemaining <= 0) status = 'expired'

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
            console.error(`Failed to refresh health for ${key.name}:`, error)
            set((state) => ({
                health: {
                    ...state.health,
                    [id]: {
                        ...state.health[id],
                        status: 'error',
                        error: 'API Error',
                        loading: false,
                        lastChecked: Date.now(),
                    },
                },
            }))
        }
    },

    refreshAll: async () => {
        const keys = useVaultStore.getState().keys.filter(k =>
            ['real-debrid', 'torbox', 'premiumize', 'alldebrid', 'debrid-link'].includes(k.provider)
        )
        if (keys.length === 0) return

        set({ isRefreshing: true })
        await Promise.all(keys.map((k) => get().refreshProvider(k.id)))
        set({ isRefreshing: false })
    },
}))
