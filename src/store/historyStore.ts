import { create } from 'zustand'
import localforage from 'localforage'
import axios from 'axios'

const STORAGE_KEY = 'stremio-manager:failover-history'
const MAX_LOGS = 25

export interface HistoryLog {
    id: string
    timestamp: Date
    type: 'failover' | 'recovery' | 'self-healing' | 'info'
    ruleId: string
    primaryName?: string
    backupName?: string
    message: string
    metadata?: any
}

interface HistoryStore {
    logs: HistoryLog[]
    loading: boolean
    initialize: () => Promise<void>
    addLog: (log: Omit<HistoryLog, 'id' | 'timestamp'>) => Promise<void>
    clearLogs: () => Promise<void>
}

export const useHistoryStore = create<HistoryStore>((set, get) => ({
    logs: [],
    loading: false,

    initialize: async () => {
        try {
            const { useSyncStore } = await import('@/store/syncStore')
            const { auth, serverUrl } = useSyncStore.getState()

            let allLogs: HistoryLog[] = []

            // 1. Load from Local Cache
            const storedLogs = await localforage.getItem<HistoryLog[]>(STORAGE_KEY)
            if (storedLogs) {
                allLogs = storedLogs.map(l => ({ ...l, timestamp: new Date(l.timestamp) }))
            }

            // 2. Fetch from Server if authenticated
            if (auth.isAuthenticated) {
                try {
                    const baseUrl = serverUrl || ''
                    const apiPath = baseUrl.startsWith('http') ? `${baseUrl.replace(/\/$/, '')}/api` : '/api'

                    // Fetch for all accounts via Promise.all
                    const accountStore = (await import('@/store/accountStore')).useAccountStore.getState()
                    const promiseResults = await Promise.all(accountStore.accounts.map(account =>
                        axios.get(`${apiPath}/autopilot/history/${account.id}`).catch(() => null)
                    ))

                    promiseResults.forEach((response) => {
                        if (response?.data?.history) {
                            const serverLogs = response.data.history.map((h: any) => ({
                                id: h.id,
                                timestamp: new Date(Number(h.timestamp)),
                                type: h.type,
                                ruleId: h.rule_id,
                                primaryName: h.primary_name,
                                backupName: h.backup_name,
                                message: h.message,
                                metadata: h.metadata ? JSON.parse(h.metadata) : undefined
                            }))
                            allLogs = [...allLogs, ...serverLogs]
                        }
                    })
                } catch (serverErr) {
                    console.error('Failed to fetch server history logs:', serverErr)
                }
            }

            // 3. Deduplicate and Sort
            const logMap = new Map<string, HistoryLog>()
            allLogs.forEach(l => logMap.set(l.id, l))
            const sortedLogs = Array.from(logMap.values())
                .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
                .slice(0, MAX_LOGS)

            set({ logs: sortedLogs })
            await localforage.setItem(STORAGE_KEY, sortedLogs)
        } catch (error) {
            console.error('Failed to initialize history logs:', error)
        }
    },

    addLog: async (logInfo) => {
        const newLog: HistoryLog = {
            id: crypto.randomUUID(),
            timestamp: new Date(),
            ...logInfo
        }

        const currentLogs = get().logs
        const newLogs = [newLog, ...currentLogs].slice(0, MAX_LOGS) // Limit to MAX_LOGS

        set({ logs: newLogs })
        await localforage.setItem(STORAGE_KEY, newLogs)
    },

    clearLogs: async () => {
        try {
            const { useSyncStore } = await import('@/store/syncStore')
            const { auth, serverUrl } = useSyncStore.getState()

            if (auth.isAuthenticated) {
                const baseUrl = serverUrl || ''
                const apiPath = baseUrl.startsWith('http') ? `${baseUrl.replace(/\/$/, '')}/api` : '/api'

                const accountStore = (await import('@/store/accountStore')).useAccountStore.getState()
                await Promise.all(accountStore.accounts.map(account =>
                    axios.delete(`${apiPath}/autopilot/history/${account.id}`, {
                        headers: { 'x-sync-password': auth.password }
                    }).catch(console.warn)
                ))
            }
        } catch (err) {
            console.warn('Server log clear failed, clearing locally anyway:', err)
        }

        // Always clear local state
        set({ logs: [] })
        await localforage.setItem(STORAGE_KEY, [])
    }
}))
