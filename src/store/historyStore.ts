import { create } from 'zustand'
import localforage from 'localforage'

const STORAGE_KEY = 'stremio-manager:failover-history'
const MAX_LOGS = 100

export interface HistoryLog {
    id: string
    timestamp: Date
    type: 'failover' | 'recovery' | 'self-healing' | 'info'
    ruleId: string
    primaryName: string
    backupName: string
    message: string
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
            const storedLogs = await localforage.getItem<HistoryLog[]>(STORAGE_KEY)
            if (storedLogs) {
                // Restore Dates from strings if needed
                const parsedLogs = storedLogs.map(l => ({
                    ...l,
                    timestamp: new Date(l.timestamp)
                }))
                set({ logs: parsedLogs })
            }
        } catch (error) {
            console.error('Failed to load history logs:', error)
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
        set({ logs: [] })
        await localforage.removeItem(STORAGE_KEY)
    }
}))
