import { create } from 'zustand'
import localforage from 'localforage'
import { getSyncPasswordHeader } from '@/lib/sync-auth'
import { resilientFetch } from '@/lib/api-resilience'

const parseSafe = (s: unknown): Record<string, unknown> | undefined => {
    if (!s || typeof s !== 'string') return undefined
    try { return JSON.parse(s) } catch { return undefined }
}

const STORAGE_KEY = 'aioman:failover-history'
const MAX_LOGS = 25

export interface HistoryLog {
    id: string
    timestamp: Date
    type: 'failover' | 'recovery' | 'self-healing' | 'info'
    ruleId: string
    accountId?: string
    primaryName?: string
    backupName?: string
    message: string
    metadata?: Record<string, unknown>
}

interface HistoryStore {
    logs: HistoryLog[]
    loading: boolean
    initialize: () => Promise<void>
    addLog: (log: Omit<HistoryLog, 'id' | 'timestamp'>) => Promise<void>
    clearLogs: (accountId: string) => Promise<void>
}


export const useHistoryStore = create<HistoryStore>((set, get) => ({
    logs: [],
    loading: false,

    initialize: async () => {
        try {
            const { useSyncStore } = await import('@/store/syncStore')
            const { auth, serverUrl } = useSyncStore.getState()

            let allLogs: HistoryLog[] = []

            const storedLogs = await localforage.getItem<HistoryLog[]>(STORAGE_KEY)
            if (storedLogs) {
                allLogs = storedLogs.map(l => ({ ...l, timestamp: new Date(l.timestamp) }))
            }


            if (auth.isAuthenticated) {
                try {
                    const baseUrl = serverUrl || ''
                    const apiPath = baseUrl.startsWith('http') ? `${baseUrl.replace(/\/$/, '')}/api` : '/api'

                    const accountStore = (await import('@/store/accountStore')).useAccountStore.getState()
                    const syncToken = await getSyncPasswordHeader(auth)
                    const promiseResults = await Promise.allSettled(
                        accountStore.accounts.map(account =>
                            resilientFetch(`${apiPath}/autopilot/history/${account.id}`, {
                                headers: { 'x-sync-password': syncToken, 'x-sync-user': auth.id }
                            }).then(r => r.ok ? r.json() : null).catch(() => null)
                            .then(response => ({ response, accountId: account.id }))
                        )
                    )

                    promiseResults.forEach(r => {
                        if (r.status !== 'fulfilled') return
                        const { response, accountId } = r.value
                        if (response?.history) {
                            const serverLogs = (response.history as Record<string, unknown>[]).map((h): HistoryLog => ({
                                id: h.id as string,
                                timestamp: new Date(Number(h.timestamp)),
                                type: h.type as HistoryLog['type'],
                                ruleId: h.rule_id as string,
                                accountId,
                                primaryName: h.primary_name as string,
                                backupName: h.backup_name as string,
                                message: h.message as string,
                                metadata: parseSafe(h.metadata)
                            }))
                            allLogs = [...allLogs, ...serverLogs]
                        }
                    })
                } catch (serverErr) {
                    if (import.meta.env.DEV) console.error('Failed to fetch server history logs:', serverErr)
                }
            }


            const logMap = new Map<string, HistoryLog>()
            allLogs.forEach(l => logMap.set(l.id, l))
            const sortedLogs = Array.from(logMap.values())
                .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
                .slice(0, MAX_LOGS)

            set({ logs: sortedLogs })
            await localforage.setItem(STORAGE_KEY, sortedLogs)
        } catch (error) {
            if (import.meta.env.DEV) console.error('Failed to initialize history logs:', error)
        }
    },

    addLog: async (logInfo) => {
        const newLog: HistoryLog = {
            id: crypto.randomUUID(),
            timestamp: new Date(),
            ...logInfo
        }

        const currentLogs = get().logs
        const newLogs = [newLog, ...currentLogs].slice(0, MAX_LOGS)

        set({ logs: newLogs })
        await localforage.setItem(STORAGE_KEY, newLogs)
    },

    clearLogs: async (accountId) => {
        const { useSyncStore } = await import('@/store/syncStore')
        const { auth, serverUrl } = useSyncStore.getState()

        if (auth.isAuthenticated) {
            const baseUrl = serverUrl || ''
            const apiPath = baseUrl.startsWith('http') ? `${baseUrl.replace(/\/$/, '')}/api` : '/api'
            const syncToken = await getSyncPasswordHeader(auth)
            const res = await resilientFetch(`${apiPath}/autopilot/history/${accountId}`, {
                method: 'DELETE',
                retries: 1,
                headers: { 'x-sync-password': syncToken, 'x-sync-user': auth.id }
            })
            // Keep the local logs so a failed server delete is not reported as cleared.
            if (!res.ok) throw new Error(`Server history delete failed (${res.status})`)
        }

        const remainingLogs = get().logs.filter(l => l.accountId !== accountId)
        set({ logs: remainingLogs })
        await localforage.setItem(STORAGE_KEY, remainingLogs)
    }
}))
