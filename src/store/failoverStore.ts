import { create } from 'zustand'
import localforage from 'localforage'
import { useAccountStore } from '@/store/accountStore'
import { useAuthStore } from '@/store/authStore'
import axios from 'axios'
import { decrypt, loadSessionKey } from '@/lib/crypto'
import { normalizeAddonUrl } from '@/lib/utils'

const STORAGE_KEY = 'stremio-manager:failover-rules'

export interface FailoverRule {
    id: string
    accountId: string
    priorityChain: string[] // URLs in order of preference
    isActive: boolean
    lastCheck?: Date
    lastFailover?: Date
    status: 'idle' | 'monitoring' | 'failed-over'
    activeUrl?: string // Track which one is currently pushed to Stremio
    isAutomatic?: boolean // Toggle for automatic health-based switching
    stabilization?: Record<string, number> // Addon health score
}

export interface WebhookConfig {
    url: string
    enabled: boolean
}

interface FailoverStore {
    rules: FailoverRule[]
    webhook: WebhookConfig
    loading: boolean
    isMonitoring: boolean // Global automation switch
    isChecking: boolean // Re-entrancy guard

    initialize: () => Promise<void>
    setWebhook: (url: string, enabled: boolean) => Promise<void>
    addRule: (accountId: string, priorityChain: string[]) => Promise<void>
    updateRule: (ruleId: string, updates: Partial<FailoverRule>) => Promise<void>
    removeRule: (ruleId: string) => Promise<void>
    toggleRuleActive: (ruleId: string, isActive: boolean) => Promise<void>
    checkRules: () => Promise<void>
    pullServerState: () => Promise<void>
    testRule: (ruleId: string) => Promise<{ primary: any, backup: any }>
    startAutomation: () => void
    stopAutomation: () => void
    importRules: (rules: FailoverRule[], strategy?: 'merge' | 'mirror') => Promise<void>
    syncRulesForAccount: (accountId: string) => Promise<void>
    reset: () => Promise<void>
}

let automationInterval: number | null = null

const syncRuleToServer = async (rule: FailoverRule) => {
    try {
        const { useSyncStore } = await import('@/store/syncStore')
        const { auth, serverUrl } = useSyncStore.getState()
        if (!auth.isAuthenticated) return

        const account = useAccountStore.getState().accounts.find(a => a.id === rule.accountId)
        if (!account) return

        const sessionKey = await loadSessionKey()
        if (!sessionKey) throw new Error('Encryption key not found')

        const authKey = await decrypt(account.authKey, sessionKey)
        const baseUrl = serverUrl || ''
        const apiPath = baseUrl.startsWith('http') ? `${baseUrl.replace(/\/$/, '')}/api` : '/api'

        const addonList = account.addons || []

        await axios.post(`${apiPath}/autopilot/sync`, {
            id: rule.id,
            accountId: rule.accountId,
            authKey,
            priorityChain: rule.priorityChain,
            activeUrl: rule.activeUrl,
            is_active: rule.isActive ? 1 : 0,
            is_automatic: rule.isAutomatic !== false ? 1 : 0,
            addonList
        })
        console.log(`[Autopilot] Rule ${rule.id} synced to server (Live Mode).`)
    } catch (err) {
        console.error('[Autopilot] Server sync failed:', err)
    }
}

const deleteRuleFromServer = async (ruleId: string) => {
    try {
        const { useSyncStore } = await import('@/store/syncStore')
        const { auth, serverUrl } = useSyncStore.getState()
        if (!auth.isAuthenticated) return

        const baseUrl = serverUrl || ''
        const apiPath = baseUrl.startsWith('http') ? `${baseUrl.replace(/\/$/, '')}/api` : '/api'

        await axios.delete(`${apiPath}/autopilot/${ruleId}`)
        console.log(`[Autopilot] Rule ${ruleId} deleted from server.`)
    } catch (err) {
        console.error('[Autopilot] Server deletion failed:', err)
    }
}

export const useFailoverStore = create<FailoverStore>((set, get) => ({
    rules: [],
    webhook: { url: '', enabled: false },
    loading: false,
    isMonitoring: false,
    isChecking: false,

    testRule: async (ruleId) => {
        const rule = get().rules.find(r => r.id === ruleId)
        if (!rule) throw new Error("Rule not found")

        const chain = rule.priorityChain || []
        if (chain.length === 0) throw new Error("Chain is empty")

        // Test the first two in the chain as "Primary" and "Backup" for the UI
        const primaryUrl = chain[0]
        const backupUrl = chain[1]

        // Import dynamically
        const { checkAddonFunctionality } = await import('@/lib/addon-health')

        const primaryHealth = await checkAddonFunctionality(primaryUrl)
        const backupHealth = backupUrl ? await checkAddonFunctionality(backupUrl) : { status: 'offline', message: 'No backup configured' }

        return {
            primary: { name: 'Primary Addon', ...primaryHealth },
            backup: { name: backupUrl ? 'Backup Addon' : 'None', ...backupHealth }
        }
    },

    initialize: async () => {
        try {
            const storedRules = await localforage.getItem<FailoverRule[]>(STORAGE_KEY)
            const storedWebhook = await localforage.getItem<WebhookConfig>(STORAGE_KEY + ':webhook')

            let rules: FailoverRule[] = []

            if (storedRules) {
                rules = storedRules.map(r => ({
                    ...r,
                    lastCheck: r.lastCheck ? new Date(r.lastCheck) : undefined,
                    lastFailover: r.lastFailover ? new Date(r.lastFailover) : undefined
                }))
            }

            // Fetch server's current activeUrl for each rule and merge
            // This ensures frontend reflects what the server-side Autopilot has set
            try {
                const { useSyncStore } = await import('@/store/syncStore')
                const { auth, serverUrl } = useSyncStore.getState()

                if (auth.isAuthenticated && rules.length > 0) {
                    const accountIds = [...new Set(rules.map(r => r.accountId))]
                    const baseUrl = serverUrl || ''
                    const apiPath = baseUrl.startsWith('http') ? `${baseUrl.replace(/\/$/, '')}/api` : '/api'

                    for (const accountId of accountIds) {
                        try {
                            const resp = await axios.get(`${apiPath}/autopilot/state/${accountId}`)
                            const serverStates = resp.data?.states || []

                            // Merge server's activeUrl into local rules
                            for (const serverRule of serverStates) {
                                const localRule = rules.find(r => r.id === serverRule.id)
                                if (localRule && serverRule.activeUrl) {
                                    console.log(`[Failover] Syncing activeUrl from server: ${localRule.id} -> ${serverRule.activeUrl.substring(0, 40)}...`)
                                    localRule.activeUrl = serverRule.activeUrl
                                    localRule.isActive = serverRule.isActive !== undefined ? serverRule.isActive : localRule.isActive
                                    localRule.isAutomatic = serverRule.isAutomatic !== undefined ? serverRule.isAutomatic : localRule.isAutomatic

                                    const normServerActive = normalizeAddonUrl(serverRule.activeUrl).toLowerCase()
                                    const normPrimary = normalizeAddonUrl(localRule.priorityChain?.[0] || '').toLowerCase()
                                    localRule.status = normServerActive === normPrimary ? 'monitoring' : 'failed-over'

                                    // CRITICAL: Also update account addon enabled states to match
                                    // This ensures frontend addons reflect server Autopilot state
                                    const chain = localRule.priorityChain || []
                                    for (const url of chain) {
                                        const normUrl = normalizeAddonUrl(url).toLowerCase()
                                        const shouldBeEnabled = normUrl === normServerActive
                                        // Use silent toggle to avoid triggering redundant syncs
                                        await useAccountStore.getState().toggleAddonEnabled(
                                            localRule.accountId,
                                            url,
                                            shouldBeEnabled,
                                            true, // silent
                                            undefined, // targetIndex
                                            true // isAutopilot
                                        )
                                    }
                                }
                            }
                        } catch (e) {
                            console.warn(`[Failover] Could not fetch server state for ${accountId}:`, e)
                        }
                    }
                }
            } catch (e) {
                console.warn('[Failover] Server state fetch failed:', e)
            }

            set({ rules })

            // CLEANUP: Prune rules for accounts that no longer exist
            // This prevents "Account not found" errors if a backup was restored or accounts deleted
            const currentAccountIds = new Set(useAccountStore.getState().accounts.map(a => a.id))
            const validRules = rules.filter(r => currentAccountIds.has(r.accountId))

            if (validRules.length !== rules.length) {
                console.log(`[Failover] Pruning ${rules.length - validRules.length} orphan rules.`)
                set({ rules: validRules })
                await localforage.setItem(STORAGE_KEY, validRules)
            }

            // Pull latest state from Stremio so the UI reflects the server's autopilot decisions
            // We use false for forceRefresh to avoid a redundant deep sync/push back to Stremio
            const isLocked = useAuthStore.getState().isLocked
            if (validRules.length > 0 && !isLocked) {
                const affectedAccountIds = [...new Set(validRules.map(r => r.accountId))]
                for (const accountId of affectedAccountIds) {
                    try {
                        // Double check existence to be safe
                        if (useAccountStore.getState().accounts.some(a => a.id === accountId)) {
                            await useAccountStore.getState().syncAccount(accountId, false)
                        }
                    } catch (e) {
                        console.warn(`[Failover] Local UI sync failed for ${accountId}:`, e)
                    }
                }
            } else if (isLocked) {
                console.log('[Failover] Skipping startup UI sync (Vault is locked). Refresh will trigger after unlock.')
            }



            if (storedWebhook) {
                set({ webhook: storedWebhook })
            }
        } catch (error) {
            console.error('Failed to load failover rules:', error)
        }
    },

    pullServerState: async () => {
        const { rules } = get()
        if (rules.length === 0) return

        try {
            const { useSyncStore } = await import('@/store/syncStore')
            const { auth, serverUrl } = useSyncStore.getState()

            if (!auth.isAuthenticated) return

            const accountIds = [...new Set(rules.map(r => r.accountId))]
            const baseUrl = serverUrl || ''
            const apiPath = baseUrl.startsWith('http') ? `${baseUrl.replace(/\/$/, '')}/api` : '/api'

            let hasUpdates = false
            const updatedRules = [...rules]

            for (const accountId of accountIds) {
                try {
                    const resp = await axios.get(`${apiPath}/autopilot/state/${accountId}`)
                    const serverStates = resp.data?.states || []

                    for (const serverRule of serverStates) {
                        const ruleIndex = updatedRules.findIndex(r => r.id === serverRule.id)
                        if (ruleIndex !== -1) {
                            const localRule = updatedRules[ruleIndex]

                            if (serverRule.activeUrl) {
                                const normServerActive = normalizeAddonUrl(serverRule.activeUrl).toLowerCase()
                                const normLocalActive = normalizeAddonUrl(localRule.activeUrl || '').toLowerCase()

                                if (normServerActive !== normLocalActive) {
                                    console.log(`[Failover] Server-side swap detected: ${localRule.id} -> ${serverRule.activeUrl}`)
                                    const normPrimary = normalizeAddonUrl(localRule.priorityChain?.[0] || '').toLowerCase()

                                    updatedRules[ruleIndex] = {
                                        ...localRule,
                                        activeUrl: serverRule.activeUrl,
                                        isActive: serverRule.isActive !== undefined ? serverRule.isActive : localRule.isActive,
                                        isAutomatic: serverRule.isAutomatic !== undefined ? serverRule.isAutomatic : localRule.isAutomatic,
                                        status: normServerActive === normPrimary ? 'monitoring' : 'failed-over'
                                    }
                                    hasUpdates = true

                                    // Update local account addons to reflect the enabled state
                                    const chain = localRule.priorityChain || []
                                    for (const url of chain) {
                                        const normUrl = normalizeAddonUrl(url).toLowerCase()
                                        const shouldBeEnabled = normUrl === normServerActive
                                        await useAccountStore.getState().toggleAddonEnabled(
                                            localRule.accountId,
                                            url,
                                            shouldBeEnabled,
                                            true, // silent
                                            undefined, // targetIndex
                                            true // isAutopilot
                                        )
                                    }
                                }
                            }
                        }
                    }
                } catch (e) {
                    // Fail silently for background sync
                }
            }

            if (hasUpdates) {
                set({ rules: updatedRules })
                await localforage.setItem(STORAGE_KEY, updatedRules)
            }
        } catch (e) {
            console.warn('[Failover] pullServerState failed:', e)
        }
    },


    setWebhook: async (url, enabled) => {
        const config = { url, enabled }
        set({ webhook: config })
        await localforage.setItem(STORAGE_KEY + ':webhook', config)

        // Immediate sync
        const { useSyncStore } = await import('@/store/syncStore')
        useSyncStore.getState().syncToRemote(true).catch(console.error)
    },

    addRule: async (accountId, priorityChain) => {
        const safeChain = Array.isArray(priorityChain) ? priorityChain : []
        const newRule: FailoverRule = {
            id: crypto.randomUUID(),
            accountId,
            priorityChain: safeChain,
            isActive: true,
            isAutomatic: true,
            status: 'idle',
            activeUrl: safeChain[0]
        }

        const rules = [...get().rules, newRule]
        set({ rules })
        await localforage.setItem(STORAGE_KEY, rules)

        // Sync to server for Autopilot
        await syncRuleToServer(newRule)

        // Immediate sync
        const { useSyncStore } = await import('@/store/syncStore')
        useSyncStore.getState().syncToRemote(true).catch(console.error)
    },

    removeRule: async (ruleId) => {
        const rules = get().rules.filter(r => r.id !== ruleId)
        set({ rules })
        await localforage.setItem(STORAGE_KEY, rules)

        // Remote deletion from Autopilot
        await deleteRuleFromServer(ruleId)

        // Immediate sync
        const { useSyncStore } = await import('@/store/syncStore')
        useSyncStore.getState().syncToRemote(true).catch(console.error)
    },

    updateRule: async (ruleId, updates) => {
        const rules = get().rules.map(r => r.id === ruleId ? { ...r, ...updates } : r)
        set({ rules })
        await localforage.setItem(STORAGE_KEY, rules)

        // Update server Autopilot
        const rule = rules.find(r => r.id === ruleId)
        if (rule) await syncRuleToServer(rule)

        // Immediate sync
        const { useSyncStore } = await import('@/store/syncStore')
        useSyncStore.getState().syncToRemote(true).catch(console.error)
    },

    toggleRuleActive: async (ruleId, isActive) => {
        const rules = get().rules.map(r =>
            r.id === ruleId ? { ...r, isActive } : r
        )
        set({ rules })
        await localforage.setItem(STORAGE_KEY, rules)

        // Update server Autopilot
        const rule = rules.find(r => r.id === ruleId)
        if (rule) await syncRuleToServer(rule)

        // Immediate sync
        const { useSyncStore } = await import('@/store/syncStore')
        useSyncStore.getState().syncToRemote(true).catch(console.error)
    },

    checkRules: async () => {
        if (get().isChecking) return
        set({ isChecking: true })

        try {
            const { rules } = get()
            const activeRules = rules.filter(r => r.isActive)
            const accounts = useAccountStore.getState().accounts

            for (const rule of activeRules) {
                const account = accounts.find(a => a.id === rule.accountId)
                if (!account) continue

                const chain = rule.priorityChain || []
                if (chain.length === 0) continue

                // Phase 1 Clean Slate: Just check health and find which one *should* be active
                // (Logic will be implemented in Phase 2)
                console.log(`[Autopilot] Rule ${rule.id} checking health for chain of ${chain.length}...`)

                set(state => ({
                    rules: state.rules.map(r => r.id === rule.id ? { ...r, lastCheck: new Date() } : r)
                }))
            }

            await localforage.setItem(STORAGE_KEY, get().rules)
        } finally {
            set({ isChecking: false })
        }
    },

    startAutomation: () => {
        if (automationInterval) return

        // 1. Initial Immediate Pull & Check (No delay)
        get().pullServerState()
        get().checkRules()

        console.log('[Failover] Starting automation engine...')
        set({ isMonitoring: true })

        // 2. Scheduled Background Updates
        automationInterval = setInterval(() => {
            // Idle Optimization: Skip autopilot checks if tab is hidden
            if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return

            // 1. Pull latest state from server (Single Source of Truth)
            get().pullServerState()

            // 2. Perform local health checks (as fallback/double-check)
            get().checkRules()
        }, 1 * 60 * 1000)
    },

    stopAutomation: () => {
        if (automationInterval) {
            window.clearInterval(automationInterval)
            automationInterval = null
        }
        set({ isMonitoring: false })
        console.log('[Failover] Automation stopped.')
    },

    reset: async () => {
        get().stopAutomation()
        set({ rules: [], webhook: { url: '', enabled: false }, isMonitoring: false })
        if (automationInterval) {
            clearInterval(automationInterval)
            automationInterval = null
        }
        await Promise.all([
            localforage.removeItem(STORAGE_KEY),
            localforage.removeItem(STORAGE_KEY + ':webhook')
        ])
        // Immediate sync after reset
        const { useSyncStore } = await import('@/store/syncStore')
        useSyncStore.getState().syncToRemote(true).catch(console.error)
    },

    importRules: async (data: any, strategy: 'merge' | 'mirror' = 'merge') => {
        if (!data) return

        // Scavenge rules and webhook
        let scavengedRules: FailoverRule[] = []
        let scavengedWebhook: WebhookConfig | null = null

        if (Array.isArray(data)) {
            scavengedRules = data
        } else if (typeof data === 'object') {
            // 1. Check for standard keys
            const failoverData = data.failover || {}
            if (Array.isArray(failoverData)) {
                scavengedRules = failoverData
            } else if (failoverData.rules) {
                scavengedRules = failoverData.rules
                if (failoverData.webhook) scavengedWebhook = failoverData.webhook
            }

            // 2. Check for ADB Dump keys
            if (data['stremio-manager:failover-rules']) {
                scavengedRules = data['stremio-manager:failover-rules']
            }
            if (data['stremio-manager:failover-rules:webhook']) {
                scavengedWebhook = data['stremio-manager:failover-rules:webhook']
            }
        }

        // Convert object-map rules to array if found (ADB dump style)
        if (scavengedRules && !Array.isArray(scavengedRules) && typeof scavengedRules === 'object') {
            scavengedRules = Object.values(scavengedRules)
        }

        if (!scavengedRules || !Array.isArray(scavengedRules)) {
            console.warn('[FailoverStore] No valid failover rules found in import object.')
            scavengedRules = []
        }

        // Apply webhook if discovered
        if (scavengedWebhook) {
            get().setWebhook(scavengedWebhook.url, scavengedWebhook.enabled)
        }

        const rulesToImport = scavengedRules
        const currentRules = [...get().rules]
        let updatedCount = 0
        let addedCount = 0
        if (strategy === 'mirror') {
            // 1. Identification
            const finalRules: FailoverRule[] = []

            // 2. Process Imports (Add/Update)
            rulesToImport.forEach(newRule => {
                const migratedRule: FailoverRule = {
                    ...newRule,
                    priorityChain: Array.isArray(newRule.priorityChain) ? newRule.priorityChain : [],
                    status: newRule.status || 'idle'
                }

                const existing = currentRules.find(r => r.id === migratedRule.id)
                if (existing) {
                    finalRules.push({
                        ...existing,
                        ...migratedRule,
                        lastCheck: migratedRule.lastCheck ? new Date(migratedRule.lastCheck) : existing.lastCheck,
                        lastFailover: migratedRule.lastFailover ? new Date(migratedRule.lastFailover) : existing.lastFailover
                    })
                } else {
                    finalRules.push({
                        ...migratedRule,
                        lastCheck: migratedRule.lastCheck ? new Date(migratedRule.lastCheck) : undefined,
                        lastFailover: migratedRule.lastFailover ? new Date(migratedRule.lastFailover) : undefined
                    })
                }
            })

            set({ rules: finalRules })
            await localforage.setItem(STORAGE_KEY, finalRules)
            console.log(`[Failover] Mirror sync complete. ${finalRules.length} rules active.`)
            // Immediate sync after mirror import
            const { useSyncStore } = await import('@/store/syncStore')
            useSyncStore.getState().syncToRemote(true).catch(console.error)
            return
        }

        // --- MERGE STRATEGY (Legacy) ---
        rulesToImport.forEach(newRule => {
            const migratedRule: FailoverRule = {
                ...newRule,
                priorityChain: Array.isArray(newRule.priorityChain) ? newRule.priorityChain : [],
                status: newRule.status || 'idle'
            }

            const index = currentRules.findIndex(r => r.id === migratedRule.id)
            if (index !== -1) {
                // Update existing
                currentRules[index] = {
                    ...currentRules[index],
                    ...migratedRule,
                    // Ensure dates are parsed
                    lastCheck: migratedRule.lastCheck ? new Date(migratedRule.lastCheck) : currentRules[index].lastCheck,
                    lastFailover: migratedRule.lastFailover ? new Date(migratedRule.lastFailover) : currentRules[index].lastFailover
                }
                updatedCount++
            } else {
                // Add new
                currentRules.push({
                    ...migratedRule,
                    lastCheck: migratedRule.lastCheck ? new Date(migratedRule.lastCheck) : undefined,
                    lastFailover: migratedRule.lastFailover ? new Date(migratedRule.lastFailover) : undefined
                })
                addedCount++
            }
        })

        if (updatedCount === 0 && addedCount === 0) return

        set({ rules: currentRules })
        await localforage.setItem(STORAGE_KEY, currentRules)

        // Immediate sync after merge import
        const { useSyncStore } = await import('@/store/syncStore')
        useSyncStore.getState().syncToRemote(true).catch(console.error)

        console.log(`[Failover] Import sync: ${addedCount} added, ${updatedCount} updated.`)
    },

    syncRulesForAccount: async (accountId: string) => {
        const rules = get().rules.filter(r => r.accountId === accountId)
        if (rules.length === 0) return

        console.log(`[Failover] Syncing ${rules.length} rules for account ${accountId} to update addon list on server.`)
        for (const rule of rules) {
            await syncRuleToServer(rule)
        }
    }
}))
