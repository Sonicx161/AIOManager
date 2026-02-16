import { create } from 'zustand'
import localforage from 'localforage'
import { useAccountStore } from '@/store/accountStore'
import axios from 'axios'
import { decrypt, encrypt, loadSessionKey } from '@/lib/crypto'
import { normalizeAddonUrl } from '@/lib/utils'
import { useAuthStore } from '@/store/authStore'

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
    updatedAt?: number
    isEncrypted?: boolean // Flag to indicate if URL is stored encrypted
}

interface FailoverStore {
    rules: FailoverRule[]
    webhook: WebhookConfig
    loading: boolean
    isMonitoring: boolean // Global automation switch
    isChecking: boolean // Re-entrancy guard
    lastWorkerRun?: Date // In-memory heartbeat from server

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
    importRules: (data: any, strategy?: 'merge' | 'mirror', isSilent?: boolean) => Promise<void>
    importWebhook: (config: WebhookConfig, isSilent?: boolean) => Promise<void>
    syncRulesForAccount: (accountId: string) => Promise<void>
    removeUrlFromRules: (accountId: string, url: string) => Promise<void>
    replaceUrlInRules: (oldUrl: string, newUrl: string, accountId?: string) => Promise<void>
    toggleAllRulesForAccount: (accountId: string, isActive: boolean) => Promise<void>
    toggleAllRulesForAccounts: (isActive: boolean) => Promise<void>
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
        const apiPath = baseUrl.startsWith('http') ? `${baseUrl.replace(/\/$/, '')} /api` : '/api'

        const addonList = account.addons || []

        await axios.post(`${apiPath}/autopilot/sync`, {
            id: rule.id,
            accountId: rule.accountId,
            authKey,
            priorityChain: rule.priorityChain,
            activeUrl: rule.activeUrl,
            is_active: rule.isActive ? 1 : 0,
            is_automatic: rule.isAutomatic !== false ? 1 : 0,
            addonList,
            webhookUrl: useFailoverStore.getState().webhook.url
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
    webhook: { url: '', enabled: false, updatedAt: 0 },
    loading: false,
    isMonitoring: false,
    isChecking: false,
    lastWorkerRun: undefined,

    testRule: async (ruleId) => {
        const rule = get().rules.find(r => r.id === ruleId)
        if (!rule) throw new Error("Rule not found")

        const chain = rule.priorityChain || []
        if (chain.length === 0) throw new Error("Chain is empty")

        const primaryUrl = chain[0]
        const backupUrl = chain[1]

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

            try {
                const { useSyncStore } = await import('@/store/syncStore')
                const { auth, serverUrl } = useSyncStore.getState()

                if (auth.isAuthenticated) {
                    // Fetch rules for all accounts to ensure local state is complete
                    const accountIds = useAccountStore.getState().accounts.map(a => a.id)
                    const baseUrl = serverUrl || ''
                    const apiPath = baseUrl.startsWith('http') ? `${baseUrl.replace(/\/$/, '')}/api` : '/api'

                    for (const accountId of accountIds) {
                        try {
                            const resp = await axios.get(`${apiPath}/autopilot/state/${accountId}`)
                            const serverStates = resp.data?.states || []
                            const serverHeartbeat = resp.data?.lastWorkerRun

                            if (serverHeartbeat) {
                                set({ lastWorkerRun: new Date(serverHeartbeat) })
                            }

                            for (const serverRule of serverStates) {
                                // Check if we already have this rule in local 'rules'
                                const existsIndex = rules.findIndex(r => r.id === serverRule.id)

                                const processedRule: FailoverRule = {
                                    id: serverRule.id,
                                    accountId: accountId,
                                    priorityChain: serverRule.priorityChain || [],
                                    isActive: serverRule.isActive !== undefined ? serverRule.isActive : true,
                                    isAutomatic: serverRule.isAutomatic !== undefined ? serverRule.isAutomatic : true,
                                    activeUrl: serverRule.activeUrl,
                                    lastCheck: serverRule.lastCheck ? new Date(serverRule.lastCheck) : undefined,
                                    stabilization: serverRule.stabilization || {},
                                    status: 'idle'
                                }

                                if (processedRule.activeUrl) {
                                    const normServerActive = normalizeAddonUrl(processedRule.activeUrl).toLowerCase()
                                    const normPrimary = normalizeAddonUrl(processedRule.priorityChain?.[0] || '').toLowerCase()
                                    processedRule.status = normServerActive === normPrimary ? 'monitoring' : 'failed-over'
                                }

                                if (existsIndex !== -1) {
                                    rules[existsIndex] = { ...rules[existsIndex], ...processedRule }
                                } else {
                                    rules.push(processedRule)
                                }

                                // Also sync addon enabled/disabled states based on activeUrl
                                // CRITICAL BUGFIX: Only enforce if rule is ACTIVE
                                if (processedRule.isActive && serverRule.activeUrl && processedRule.priorityChain.length > 0) {
                                    const normServerActive = normalizeAddonUrl(serverRule.activeUrl).toLowerCase()
                                    for (const url of processedRule.priorityChain) {
                                        const normUrl = normalizeAddonUrl(url).toLowerCase()
                                        const shouldBeEnabled = normUrl === normServerActive
                                        await useAccountStore.getState().toggleAddonEnabled(
                                            accountId,
                                            url,
                                            shouldBeEnabled,
                                            true,
                                            undefined,
                                            true
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

            const currentAccountIds = new Set(useAccountStore.getState().accounts.map(a => a.id))
            const validRules = rules.filter(r => currentAccountIds.has(r.accountId))

            if (validRules.length !== rules.length) {
                console.log(`[Failover] Pruning ${rules.length - validRules.length} orphan rules.`)
                set({ rules: validRules })
                await localforage.setItem(STORAGE_KEY, validRules)
            }

            if (storedWebhook) {
                let webhook = storedWebhook
                // Decrypt if necessary
                if (webhook.isEncrypted && webhook.url) {
                    try {
                        const sessionKey = await loadSessionKey()
                        if (sessionKey) {
                            webhook = {
                                ...webhook,
                                url: await decrypt(webhook.url, sessionKey),
                                isEncrypted: false
                            }
                            console.log('[Failover] Webhook URL decrypted during initialization.')
                        } else {
                            console.warn('[Failover] Webhook is encrypted but no session key found. Link may appear broken until unlock.')
                        }
                    } catch (e) {
                        console.error('[Failover] Failed to decrypt webhook during initialize:', e)
                    }
                }
                set({ webhook })
            }
        } catch (error) {
            console.error('Failed to load failover rules:', error)
        }
    },

    pullServerState: async () => {
        const { rules } = get()
        if (rules.length === 0) return

        try {
            // Guard: Do not attempt to sync if locked (prevents "Database is locked" error)
            if (useAuthStore.getState().isLocked) return

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
                    const serverHeartbeat = resp.data?.lastWorkerRun

                    if (serverHeartbeat) {
                        set({ lastWorkerRun: new Date(serverHeartbeat) })
                    }

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
                                        stabilization: serverRule.stabilization || {},
                                        lastCheck: serverRule.lastCheck ? new Date(serverRule.lastCheck) : localRule.lastCheck,
                                        status: normServerActive === normPrimary ? 'monitoring' : 'failed-over'
                                    }
                                    hasUpdates = true

                                    // Sync addon states ONLY if rule is active
                                    if (updatedRules[ruleIndex].isActive) {
                                        const chain = localRule.priorityChain || []
                                        for (const url of chain) {
                                            const normUrl = normalizeAddonUrl(url).toLowerCase()
                                            const shouldBeEnabled = normUrl === normServerActive
                                            await useAccountStore.getState().toggleAddonEnabled(
                                                localRule.accountId,
                                                url,
                                                shouldBeEnabled,
                                                true,
                                                undefined,
                                                true
                                            )
                                        }
                                    }
                                }
                            }
                        }
                    }
                } catch (e) {
                    console.warn('[Failover] pullServerState item processing failed:', e)
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
        console.log(`[Failover] setWebhook called - Link length: ${url?.length || 0}, Enabled: ${enabled}`)

        const timestamp = Date.now()
        let configToStore: WebhookConfig = { url, enabled, updatedAt: timestamp }

        // Always keep plain URL in memory for the UI
        set({ webhook: { url, enabled, updatedAt: timestamp } })

        try {
            const sessionKey = await loadSessionKey()
            if (sessionKey && url) {
                const encryptedUrl = await encrypt(url, sessionKey)
                configToStore = { ...configToStore, url: encryptedUrl, isEncrypted: true }
                console.log('[Failover] Webhook URL encrypted for storage.')
            }
        } catch (e) {
            console.error('[Failover] Encryption failed during setWebhook:', e)
        }

        await localforage.setItem(STORAGE_KEY + ':webhook', configToStore)
        console.log(`[Failover] Webhook persisted to localforage at ${new Date(timestamp).toISOString()}`)

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
        await syncRuleToServer(newRule)
        const { useSyncStore } = await import('@/store/syncStore')
        useSyncStore.getState().syncToRemote(true).catch(console.error)
    },

    removeRule: async (ruleId) => {
        const rules = get().rules.filter(r => r.id !== ruleId)
        set({ rules })
        await localforage.setItem(STORAGE_KEY, rules)
        await deleteRuleFromServer(ruleId)
        const { useSyncStore } = await import('@/store/syncStore')
        useSyncStore.getState().syncToRemote(true).catch(console.error)
    },

    updateRule: async (ruleId, updates) => {
        const rules = get().rules.map(r => r.id === ruleId ? { ...r, ...updates } : r)
        set({ rules })
        await localforage.setItem(STORAGE_KEY, rules)
        const rule = rules.find(r => r.id === ruleId)
        if (rule) await syncRuleToServer(rule)
        const { useSyncStore } = await import('@/store/syncStore')
        useSyncStore.getState().syncToRemote(true).catch(console.error)
    },

    toggleRuleActive: async (ruleId, isActive) => {
        const rules = get().rules.map(r =>
            r.id === ruleId ? { ...r, isActive } : r
        )
        set({ rules })
        await localforage.setItem(STORAGE_KEY, rules)
        const rule = rules.find(r => r.id === ruleId)
        if (rule) await syncRuleToServer(rule)
        const { useSyncStore } = await import('@/store/syncStore')
        useSyncStore.getState().syncToRemote(true).catch(console.error)
    },

    checkRules: async () => {
        if (get().isChecking) return
        set({ isChecking: true })
        try {
            // ZERO-WRITE: We keep lastCheck in memory for the UI, but we don't 
            // force a localforage write unless a real change happens elsewhere.
            // This prevents "600,000 updates" issues on idle machines.

            // Guard: Do not check rules if locked
            if (useAuthStore.getState().isLocked) return
        } finally {
            set({ isChecking: false })
        }
    },

    startAutomation: () => {
        if (automationInterval) return
        get().pullServerState()
        get().checkRules()
        console.log('[Failover] Starting automation engine...')
        set({ isMonitoring: true })
        automationInterval = setInterval(() => {
            if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
            get().pullServerState()
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

    importRules: async (data: any, strategy: 'merge' | 'mirror' = 'merge', isSilent: boolean = false) => {
        if (!data) return
        let scavengedRules: FailoverRule[] = []
        let scavengedWebhook: WebhookConfig | null = null
        if (Array.isArray(data)) {
            scavengedRules = data
        } else if (typeof data === 'object') {
            const failoverData = data.failover || {}
            if (Array.isArray(failoverData)) {
                scavengedRules = failoverData
            } else if (failoverData.rules) {
                scavengedRules = failoverData.rules
                if (failoverData.webhook) scavengedWebhook = failoverData.webhook
            }
            if (data['stremio-manager:failover-rules']) {
                scavengedRules = data['stremio-manager:failover-rules']
            }
            if (data['stremio-manager:failover-rules:webhook']) {
                scavengedWebhook = data['stremio-manager:failover-rules:webhook']
            }
        }
        if (scavengedRules && !Array.isArray(scavengedRules) && typeof scavengedRules === 'object') {
            scavengedRules = Object.values(scavengedRules)
        }
        if (!scavengedRules || !Array.isArray(scavengedRules)) {
            scavengedRules = []
        }
        if (scavengedWebhook) {
            const currentWebhook = get().webhook
            const incomingTs = scavengedWebhook.updatedAt || 0
            const currentTs = currentWebhook.updatedAt || 0
            if (incomingTs >= currentTs) {
                set({ webhook: scavengedWebhook })
                await localforage.setItem(STORAGE_KEY + ':webhook', scavengedWebhook)
            }
        }
        const rulesToImport = scavengedRules
        const currentRules = [...get().rules]

        if (strategy === 'mirror') {
            // Anti-Wipe Guard: If remote has 0 rules but we have local rules, preserve local state.
            // This prevents cloud pull from wiping rules when the server has stale/empty data.
            if (rulesToImport.length === 0 && currentRules.length > 0) {
                console.warn('[Failover] Anti-Wipe Triggered: Remote has 0 rules but local has ' + currentRules.length + '. Preserving local rules.')
                return
            }
            const finalRules: FailoverRule[] = []
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
            if (!isSilent) {
                const { useSyncStore } = await import('@/store/syncStore')
                useSyncStore.getState().syncToRemote(true).catch(console.error)
            }
            return
        }

        let updatedCount = 0
        let addedCount = 0
        rulesToImport.forEach(newRule => {
            const migratedRule: FailoverRule = {
                ...newRule,
                priorityChain: Array.isArray(newRule.priorityChain) ? newRule.priorityChain : [],
                status: newRule.status || 'idle'
            }
            const index = currentRules.findIndex(r => r.id === migratedRule.id)
            if (index !== -1) {
                currentRules[index] = {
                    ...currentRules[index],
                    ...migratedRule,
                    lastCheck: migratedRule.lastCheck ? new Date(migratedRule.lastCheck) : currentRules[index].lastCheck,
                    lastFailover: migratedRule.lastFailover ? new Date(migratedRule.lastFailover) : currentRules[index].lastFailover
                }
                updatedCount++
            } else {
                currentRules.push({
                    ...migratedRule,
                    lastCheck: migratedRule.lastCheck ? new Date(migratedRule.lastCheck) : undefined,
                    lastFailover: migratedRule.lastFailover ? new Date(migratedRule.lastFailover) : undefined
                })
                addedCount++
            }
        })
        if ((updatedCount > 0 || addedCount > 0) && !isSilent) {
            set({ rules: currentRules })
            await localforage.setItem(STORAGE_KEY, currentRules)
            const { useSyncStore } = await import('@/store/syncStore')
            useSyncStore.getState().syncToRemote(true).catch(console.error)
        }
    },

    importWebhook: async (incoming, isSilent = false) => {
        if (!incoming) return
        const current = get().webhook
        const incomingTs = incoming.updatedAt || 0
        const currentTs = current.updatedAt || 0

        console.log(`[Failover] importWebhook - Incoming TS: ${incomingTs}, Local TS: ${currentTs}, Incoming URL Length: ${incoming.url?.length || 0}`)

        if (incomingTs >= currentTs) {
            let processedWebhook = incoming

            // Decrypt if incoming is encrypted
            if (incoming.isEncrypted && incoming.url) {
                try {
                    const sessionKey = await loadSessionKey()
                    if (sessionKey) {
                        processedWebhook = {
                            ...incoming,
                            url: await decrypt(incoming.url, sessionKey),
                            isEncrypted: false
                        }
                        console.log('[Failover] Incoming webhook decrypted during import.')
                    } else {
                        console.warn('[Failover] Incoming webhook is encrypted but no session key found.')
                    }
                } catch (e) {
                    console.error('[Failover] Failed to decrypt incoming webhook:', e)
                }
            }

            console.log(`[Failover] Updating webhook (Incoming: ${incomingTs}, Local: ${currentTs})`)
            set({ webhook: processedWebhook })

            // Store encrypted version
            let configToStore = processedWebhook
            try {
                const sessionKey = await loadSessionKey()
                if (sessionKey && processedWebhook.url && !processedWebhook.isEncrypted) {
                    const encryptedUrl = await encrypt(processedWebhook.url, sessionKey)
                    configToStore = { ...processedWebhook, url: encryptedUrl, isEncrypted: true }
                }
            } catch (e) {
                console.error('[Failover] Re-encryption failed during importWebhook:', e)
            }

            await localforage.setItem(STORAGE_KEY + ':webhook', configToStore)

            if (!isSilent) {
                const { useSyncStore } = await import('@/store/syncStore')
                useSyncStore.getState().syncToRemote(true).catch(console.error)
            }
        } else {
            console.log(`[Failover] Skipping stale webhook update (Incoming: ${incomingTs}, Local: ${currentTs})`)
        }
    },

    syncRulesForAccount: async (accountId: string) => {
        const rules = get().rules.filter(r => r.accountId === accountId)
        if (rules.length === 0) return
        for (const rule of rules) {
            await syncRuleToServer(rule)
        }
    },

    removeUrlFromRules: async (accountId: string, url: string) => {
        const normUrl = normalizeAddonUrl(url).toLowerCase()
        let hasChanges = false
        const updatedRules = get().rules.map(rule => {
            if (rule.accountId !== accountId) return rule
            const isMatching = rule.priorityChain.some(u => normalizeAddonUrl(u).toLowerCase() === normUrl)
            if (!isMatching) return rule
            hasChanges = true
            const newChain = rule.priorityChain.filter(u => normalizeAddonUrl(u).toLowerCase() !== normUrl)
            let newActiveUrl = rule.activeUrl
            if (normalizeAddonUrl(rule.activeUrl || '').toLowerCase() === normUrl) {
                newActiveUrl = newChain[0] || ''
            }
            return {
                ...rule,
                priorityChain: newChain,
                activeUrl: newActiveUrl,
                status: (newActiveUrl && newActiveUrl === newChain[0]) ? 'monitoring' : 'failed-over'
            } as FailoverRule
        })
        if (hasChanges) {
            set({ rules: updatedRules })
            await localforage.setItem(STORAGE_KEY, updatedRules)
            const finalRules = updatedRules.filter(r => r.priorityChain.length >= 1)
            if (finalRules.length !== updatedRules.length) {
                const deletedRules = updatedRules.filter(r => r.priorityChain.length < 1)
                for (const dr of deletedRules) {
                    await deleteRuleFromServer(dr.id)
                }
                set({ rules: finalRules })
                await localforage.setItem(STORAGE_KEY, finalRules)
            }
            for (const rule of get().rules) {
                if (rule.accountId === accountId) {
                    await syncRuleToServer(rule)
                }
            }
            const { useSyncStore } = await import('@/store/syncStore')
            useSyncStore.getState().syncToRemote(true).catch(console.error)
        }
    },

    replaceUrlInRules: async (oldUrl: string, newUrl: string, accountId?: string) => {
        const normOld = normalizeAddonUrl(oldUrl).toLowerCase()
        let hasChanges = false
        const updatedRules = get().rules.map(rule => {
            // If accountId is provided, only process rules for that account
            if (accountId && rule.accountId !== accountId) return rule

            const isMatching = rule.priorityChain.some(u => normalizeAddonUrl(u).toLowerCase() === normOld)
            if (!isMatching) return rule
            hasChanges = true
            const newChain = rule.priorityChain.map(u =>
                normalizeAddonUrl(u).toLowerCase() === normOld ? newUrl : u
            )
            let newActiveUrl = rule.activeUrl
            if (normalizeAddonUrl(rule.activeUrl || '').toLowerCase() === normOld) {
                newActiveUrl = newUrl
            }
            return {
                ...rule,
                priorityChain: newChain,
                activeUrl: newActiveUrl,
                status: (newActiveUrl && newActiveUrl === newChain[0]) ? 'monitoring' : 'failed-over'
            } as FailoverRule
        })
        if (hasChanges) {
            set({ rules: updatedRules })
            await localforage.setItem(STORAGE_KEY, updatedRules)
            for (const rule of updatedRules) {
                // Only sync the rules we actually touched (or match our target)
                if (accountId && rule.accountId !== accountId) continue

                if (rule.priorityChain.includes(newUrl)) {
                    await syncRuleToServer(rule)
                }
            }
            const { useSyncStore } = await import('@/store/syncStore')
            useSyncStore.getState().syncToRemote(true).catch(console.error)
        }
    },

    toggleAllRulesForAccount: async (accountId, isActive) => {
        const rules = get().rules.map(r =>
            r.accountId === accountId ? { ...r, isActive } : r
        )
        set({ rules })
        await localforage.setItem(STORAGE_KEY, rules)

        // Sync each modified rule
        for (const rule of rules) {
            if (rule.accountId === accountId) {
                await syncRuleToServer(rule)
            }
        }

        const { useSyncStore } = await import('@/store/syncStore')
        useSyncStore.getState().syncToRemote(true).catch(console.error)
    },

    toggleAllRulesForAccounts: async (isActive) => {
        const rules = get().rules.map(r => ({ ...r, isActive }))
        set({ rules })
        await localforage.setItem(STORAGE_KEY, rules)

        // Sync all rules
        for (const rule of rules) {
            await syncRuleToServer(rule)
        }

        const { useSyncStore } = await import('@/store/syncStore')
        useSyncStore.getState().syncToRemote(true).catch(console.error)
    },

    reset: async () => {
        get().stopAutomation()
        set({ rules: [], webhook: { url: '', enabled: false, updatedAt: 0 }, isMonitoring: false, lastWorkerRun: undefined })
        if (automationInterval) {
            clearInterval(automationInterval)
            automationInterval = null
        }
        await Promise.all([
            localforage.removeItem(STORAGE_KEY),
            localforage.removeItem(STORAGE_KEY + ':webhook')
        ])
    },
}))
