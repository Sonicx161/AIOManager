import { create } from 'zustand'
import type { ProviderHealth, ProviderState } from '@/types/provider'
import { useVaultStore } from './vaultStore'
import localforage from 'localforage'
import { ACCOUNT_CONTEXT_SYSTEM_CHECK } from '@/lib/account-contexts'
import { getActiveWorkspaceId } from '@/lib/workspace-persistence'

const PROVIDER_COOLDOWN = 12 * 60 * 60 * 1000 // debrid subscription expiry only moves day-to-day; 12h is plenty
const ERROR_RETRY_MS = 30 * 60 * 1000
const CACHE_KEY = 'aio_provider_health'
const LAST_REFRESHED_KEY = 'aio_provider_lastRefreshed'

// Hash, never the raw value: the fingerprint only has to prove THIS key text was
// already checked, so a stale health entry cannot silence a rotated or re-entered key.
const keyFingerprint = (key: { provider: string; value: string; customExpiry?: string | null }): string => {
    const basis = `${key.provider}|${key.value}|${key.customExpiry ?? ''}`
    let h = 0x811c9dc5
    for (let i = 0; i < basis.length; i++) {
        h ^= basis.charCodeAt(i)
        h = Math.imul(h, 0x01000193) >>> 0
    }
    return `${h.toString(16)}:${basis.length}`
}

const providerNeedsCheck = (entry: ProviderHealth | undefined, fp: string): boolean => {
    if (!entry || entry.fp !== fp) return true
    if (entry.loading) return false
    const age = Date.now() - (entry.lastChecked || 0)
    if (entry.status === 'error') return age >= ERROR_RETRY_MS
    return age >= PROVIDER_COOLDOWN
}

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

// Bulk refresh rows publish in ~150ms waves instead of one store update per row. Only the
// newest check of a key in the workspace that started it may publish.
type ProviderSet = (partial: (state: ProviderStore) => Partial<ProviderStore>) => void
const BATCH_WAVE_MS = 150
interface CheckTicket { id: string; seq: number; ws: string }
let checkSeq = 0
const latestCheck: Record<string, number> = {}
let batchDepth = 0
let pendingHealth: Record<string, { entry: ProviderHealth; ticket: CheckTicket }> | null = null
let waveTimer: ReturnType<typeof setTimeout> | null = null

const beginCheck = (id: string): CheckTicket => {
    const seq = ++checkSeq
    latestCheck[id] = seq
    return { id, seq, ws: getActiveWorkspaceId() }
}

const ticketCurrent = (ticket: CheckTicket) =>
    latestCheck[ticket.id] === ticket.seq && getActiveWorkspaceId() === ticket.ws

const healthNow = (get: () => ProviderStore): Record<string, ProviderHealth> => {
    if (!pendingHealth) return get().health
    const merged = { ...get().health }
    for (const [id, { entry }] of Object.entries(pendingHealth)) merged[id] = entry
    return merged
}

const publishHealth = (set: ProviderSet, ticket: CheckTicket, entry: ProviderHealth, defer: boolean) => {
    if (!ticketCurrent(ticket)) return
    if (defer && batchDepth > 0) {
        pendingHealth ??= {}
        pendingHealth[ticket.id] = { entry, ticket }
        if (waveTimer === null) {
            waveTimer = setTimeout(() => {
                waveTimer = null
                drainHealth(set)
            }, BATCH_WAVE_MS)
        }
        return
    }
    if (pendingHealth) delete pendingHealth[ticket.id]
    set((state) => ({ health: { ...state.health, [ticket.id]: entry } }))
}

const drainHealth = (set: ProviderSet) => {
    if (!pendingHealth) return
    const pending = pendingHealth
    pendingHealth = null
    set((state) => {
        const liveIds = new Set(useVaultStore.getState().keys.map((k) => k.id))
        let health: Record<string, ProviderHealth> | null = null
        for (const [id, { entry, ticket }] of Object.entries(pending)) {
            if (!liveIds.has(id) || !ticketCurrent(ticket)) continue
            health ??= { ...state.health }
            health[id] = entry
        }
        return health ? { health } : {}
    })
}

const flushHealth = (set: ProviderSet) => {
    if (waveTimer !== null) {
        clearTimeout(waveTimer)
        waveTimer = null
    }
    if (batchDepth > 0 || !pendingHealth) return
    drainHealth(set)
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
    refreshProvider: (id: string, defer?: boolean, force?: boolean) => Promise<void>
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

    refreshProvider: async (id: string, defer = false, force = false) => {
        const key = useVaultStore.getState().keys.find((k) => k.id === id)
        if (!key) return
        const fp = keyFingerprint(key)
        if (!force && !providerNeedsCheck(healthNow(get)[id], fp)) return
        const ticket = beginCheck(id)

        publishHealth(set, ticket, {
            ...(healthNow(get)[id] || {
                id,
                name: key.name,
                provider: key.provider,
                status: 'none',
                daysRemaining: null,
                expiresAt: null,
                lastChecked: 0,
            }),
            loading: true,
        }, defer)


        if (key.provider === 'other') {
            if (key.customExpiry) {
                const expiresAt = key.customExpiry
                const daysRemaining = getDaysRemaining(expiresAt)
                publishHealth(set, ticket, {
                    ...healthNow(get)[id],
                    status: (daysRemaining ?? 0) > 0 ? 'active' : 'expired',
                    daysRemaining,
                    expiresAt,
                    loading: false,
                    lastChecked: Date.now(),
                    fp,
                }, defer)
            } else {
                publishHealth(set, ticket, {
                    ...healthNow(get)[id],
                    status: 'none',
                    daysRemaining: null,
                    expiresAt: null,
                    loading: false,
                    lastChecked: Date.now(),
                    fp,
                }, defer)
            }
            persistHealth(healthNow(get), get().lastRefreshed)
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
                publishHealth(set, ticket, { ...healthNow(get)[id], loading: false, status: 'none', lastChecked: Date.now() }, defer)
                persistHealth(healthNow(get), get().lastRefreshed)
                return
            }

            if ((daysRemaining ?? 0) <= 0) status = 'expired'

            publishHealth(set, ticket, {
                id,
                name: key.name,
                provider: key.provider,
                status,
                daysRemaining,
                expiresAt,
                lastChecked: Date.now(),
                loading: false,
                fp,
            }, defer)
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error)
            console.warn(`[ProviderStore] Health check failed for ${key.name}: ${msg}`)
            publishHealth(set, ticket, {
                ...healthNow(get)[id],
                status: 'error',
                error: msg,
                loading: false,
                lastChecked: Date.now(),
                fp,
            }, defer)
        }
        persistHealth(healthNow(get), get().lastRefreshed)
    },

    refreshAll: async () => {
        if (get().isRefreshing) return

        // Load the persisted cache first if we haven't yet, so a still-fresh result short-circuits
        // the check gate instead of re-hitting every debrid API on a cold store / page load.
        if (!get()._hydrated) await get().hydrateFromCache()

        const keys = useVaultStore.getState().keys.filter(k =>
            ['real-debrid', 'torbox', 'premiumize', 'alldebrid', 'debrid-link', 'other'].includes(k.provider)
        )
        if (keys.length === 0) return

        // Only changed, stale or retry-eligible keys hit the network; unchanged keys keep
        // their cached verdict, so revisits cost zero requests.
        const needingCheck = keys.filter(k => providerNeedsCheck(healthNow(get)[k.id], keyFingerprint(k)))
        if (needingCheck.length === 0) return

        set({ isRefreshing: true })
        try {
            batchDepth++
            try {
                await boundedAll(needingCheck.map((k) => () => get().refreshProvider(k.id, true)), 3)
                set({ lastRefreshed: Date.now() })
            } finally {
                batchDepth--
                flushHealth(set)
            }
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
            batchDepth++
            try {
                await boundedAll(keys.map((k) => () => get().refreshProvider(k.id, true, true)), 3)
                set({ lastRefreshed: Date.now() })
            } finally {
                batchDepth--
                flushHealth(set)
            }
        } finally {
            set({ isRefreshing: false })
        }
    },
}))
