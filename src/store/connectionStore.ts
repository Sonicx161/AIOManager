import { create } from 'zustand'
import { useAccountStore, persistAccounts, acquireSyncMutex } from './accountStore'
import { getConnectionStates } from '@/api/connection'
import type { Connection, ConnectionStatus } from '@/types/connection'
import type { Account } from '@/types/account'
import { toast } from '@/hooks/use-toast'

interface ConnectionStateEntry {
    consecutiveFailures: number
    lastError: string | null
    lastErrorAt: number | null
    lastSync: number
    status: ConnectionStatus
    skipCyclesRemaining: number
}

interface ConnectionStore {
    connectionStates: Record<string, Record<string, ConnectionStateEntry>>
    isSyncing: string | null

    addConnection: (accountId: string, connection: Omit<Connection, 'id' | 'lastSync' | 'lastKnownAddonCount' | 'consecutiveFailures'>) => void
    removeConnection: (accountId: string, connectionId: string) => void
    updateConnection: (accountId: string, connectionId: string, updates: Partial<Connection>) => void
    setPrimaryConnection: (accountId: string, connectionId: string) => void
    toggleConnection: (accountId: string, connectionId: string) => void
    syncConnections: (accountId: string) => Promise<void>
    refreshConnectionStates: (accountId: string) => Promise<void>
}

const safeUUID = () => {
    try { return crypto.randomUUID() } catch {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = crypto.getRandomValues(new Uint8Array(1))[0] % 16
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16)
        })
    }
}

async function updateAccount(accountId: string, updater: (account: Account) => Account) {
    const release = await acquireSyncMutex(accountId)
    try {
        const { accounts } = useAccountStore.getState()
        const updated = accounts.map(a => a.id === accountId ? updater(a) : a)
        useAccountStore.setState({ accounts: updated })
        persistAccounts(updated)
    } finally {
        release()
    }
}

export const useConnectionStore = create<ConnectionStore>((set, get) => ({
    connectionStates: {},
    isSyncing: null,

    addConnection: async (accountId, partial) => {
        const connection: Connection = {
            id: safeUUID(),
            platform: partial.platform,
            connectionType: partial.connectionType || partial.driverType || 'native',
            enabled: partial.enabled ?? true,
            status: partial.status ?? 'active',
            credentials: partial.credentials,
            profileMapping: partial.profileMapping,
            lastSync: 0,
            lastKnownAddonCount: 0,
            capabilities: partial.capabilities ?? ['addons'],
            consecutiveFailures: 0,
            pluginList: partial.pluginList,
            driverConfig: partial.driverConfig,
        }

        if (connection.connectionType === 'hydra-outbound' && connection.driverConfig?.baseUrl) {
            const { storeConnectionCredential } = await import('@/api/hydra-providers')
            const bundle = {
                authValue: connection.credentials?.apiKey || '',
                baseUrl: connection.driverConfig.baseUrl,
                authType: connection.driverConfig.authType,
                authHeader: connection.driverConfig.authHeader,
                enabled: connection.enabled,
            }
            storeConnectionCredential(accountId, connection.id, bundle, 'hydra').catch(() => {
                toast({ variant: 'destructive', title: 'Connection credential save failed', description: 'The connection will work until page reload.' })
            })
        }

        if (connection.platform === 'nuvio' && connection.credentials?.accessToken) {
            const { storeConnectionCredential } = await import('@/api/hydra-providers')
            const bundle = {
                accessToken: connection.credentials.accessToken,
                refreshToken: connection.credentials.refreshToken,
                expiresAt: connection.credentials.expiresAt,
                profileId: connection.credentials.profileId || null,
                baseUrl: connection.credentials?.baseUrl || null,
                publishableKey: connection.credentials?.publishableKey || null,
            }
            await storeConnectionCredential(accountId, connection.id, bundle, 'nuvio').catch(() => {
                toast({ variant: 'destructive', title: 'Connection credential save failed', description: 'The connection will work until page reload.' })
            })
        }

        if (connection.platform === 'realstream' && connection.credentials?.accessToken) {
            const { storeConnectionCredential } = await import('@/api/hydra-providers')
            const bundle = {
                accessToken: connection.credentials.accessToken,
                userId: connection.credentials.userId || null,
                expiresAt: connection.credentials.expiresAt,
                baseUrl: connection.credentials.baseUrl || null,
                email: connection.credentials.email || null,
                password: connection.credentials.password || null,
            }
            await storeConnectionCredential(accountId, connection.id, bundle, 'realstream').catch(() => {
                toast({ variant: 'destructive', title: 'Connection credential save failed', description: 'The connection will work until page reload.' })
            })
        }

        let duplicateFound = false
        let duplicateId = ''
        await updateAccount(accountId, account => {
            const existing = (account.connections || []).find(c => c.platform === partial.platform)
            if (existing) {
                duplicateFound = true
                duplicateId = existing.id
                return account
            }
            return {
                ...account,
                connections: [...(account.connections || []), connection],
                primaryConnectionId: account.primaryConnectionId || connection.id,
            }
        })
        if (duplicateFound) {
            const { invalidateConnectionCache } = await import('@/lib/connection-discovery')
            invalidateConnectionCache(duplicateId)
            const { updateConnection } = get()
            updateConnection(accountId, duplicateId, { ...partial, status: 'active' })
            return
        }

        toast({ title: `${connection.platform} connection added` })

        if (connection.enabled) {
            import('./accountStore').then(({ useAccountStore }) => {
                useAccountStore.getState().syncAccount(accountId).catch(() => {})
            })
        }
    },

    removeConnection: async (accountId, connectionId) => {
        const { accounts } = useAccountStore.getState()
        const account = accounts.find(a => a.id === accountId)
        const conn = account?.connections?.find(c => c.id === connectionId)
        if (conn?.connectionType === 'hydra-outbound' || conn?.platform === 'nuvio' || conn?.platform === 'realstream') {
            import('@/api/hydra-providers').then(({ deleteConnectionCredential }) => {
                deleteConnectionCredential(accountId, connectionId).catch(() => {})
            })
        }
        const { invalidateConnectionCache } = await import('@/lib/connection-discovery')
        invalidateConnectionCache(connectionId)
        const isStremioRemoval = conn?.platform === 'stremio' || connectionId === `${accountId}:stremio`
        await updateAccount(accountId, account => {
            const connections = (account.connections || []).filter(c => c.id !== connectionId)
            const primaryConnectionId = account.primaryConnectionId === connectionId
                ? connections[0]?.id
                : account.primaryConnectionId
            return {
                ...account,
                connections,
                primaryConnectionId,
                ...(isStremioRemoval ? { authKey: '' } : {}),
            }
        })
    },

    updateConnection: async (accountId, connectionId, updates) => {
        await updateAccount(accountId, account => ({
            ...account,
            connections: (account.connections || []).map(c =>
                c.id === connectionId ? { ...c, ...updates } : c
            ),
        }))
    },

    setPrimaryConnection: async (accountId, connectionId) => {
        await updateAccount(accountId, account => ({
            ...account,
            primaryConnectionId: connectionId,
        }))
    },

    toggleConnection: async (accountId, connectionId) => {
        let wasEnabled: boolean | undefined
        await updateAccount(accountId, account => {
            wasEnabled = account.connections?.find(c => c.id === connectionId)?.enabled
            return {
                ...account,
                connections: (account.connections || []).map(c =>
                    c.id === connectionId ? { ...c, enabled: !c.enabled } : c
                ),
            }
        })
        const toggled = useAccountStore.getState().accounts.find(a => a.id === accountId)?.connections?.find(c => c.id === connectionId)
        if (toggled?.connectionType === 'hydra-outbound' && toggled.driverConfig?.baseUrl) {
            const { storeConnectionCredential } = await import('@/api/hydra-providers')
            storeConnectionCredential(accountId, connectionId, {
                authValue: toggled.credentials?.apiKey || '',
                baseUrl: toggled.driverConfig.baseUrl,
                authType: toggled.driverConfig.authType,
                authHeader: toggled.driverConfig.authHeader,
                enabled: toggled.enabled,
            }, 'hydra').catch(() => {})
        }
        if (wasEnabled === false) {
            // Reconnecting a stale platform is not an explicit addon reinstall.
            // Keep deletion records while the normal sync reconciles its snapshot.
            import('./account/accountSync').then(({ scheduleSyncAccount }) => {
                scheduleSyncAccount(accountId)
            })
            import('./account/accountAddonOps').then(({ pushToConnections }) => {
                pushToConnections(accountId).catch(() => {})
            })
        }
    },

    syncConnections: async (accountId) => {
        if (get().isSyncing === accountId) return
        set({ isSyncing: accountId })

        try {
            const { useAccountStore } = await import('./accountStore')
            await useAccountStore.getState().syncAccount(accountId, true)
            await get().refreshConnectionStates(accountId)
        } catch (err) {
            toast({ title: 'Sync failed', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' })
        } finally {
            set({ isSyncing: null })
        }
    },

    refreshConnectionStates: async (accountId) => {
        try {
            const states = await getConnectionStates(accountId)
            set(state => ({
                connectionStates: {
                    ...state.connectionStates,
                    [accountId]: states,
                },
            }))
        } catch {}
    },
}))
