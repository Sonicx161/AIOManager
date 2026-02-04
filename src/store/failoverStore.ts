import { create } from 'zustand'
import localforage from 'localforage'
import { checkAddonHealth } from '@/lib/addon-health'
import { useAccountStore } from '@/store/accountStore'
import { toast } from '@/hooks/use-toast'
import { useHistoryStore } from '@/store/historyStore'
import axios from 'axios'
import { decrypt, loadSessionKey } from '@/lib/crypto'

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
    stabilization?: Record<string, number> // URL -> consecutive success count
    // Migration helpers
    primaryUrl?: string
    backupUrl?: string
    primaryAddonId?: string
    backupAddonId?: string
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
    testRule: (ruleId: string) => Promise<{ primary: any, backup: any }>
    startAutomation: () => void
    stopAutomation: () => void
    importRules: (rules: FailoverRule[]) => Promise<void>
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
        const baseUrl = serverUrl || 'http://localhost:3000'

        await axios.post(`${baseUrl}/api/autopilot/sync`, {
            id: rule.id,
            accountId: rule.accountId,
            authKey,
            priorityChain: rule.priorityChain,
            activeUrl: rule.activeUrl,
            isActive: rule.isActive
        })
        console.log(`[Autopilot] Rule ${rule.id} synced to server.`)
    } catch (err) {
        console.error('[Autopilot] Server sync failed:', err)
    }
}

const deleteRuleFromServer = async (ruleId: string) => {
    try {
        const { useSyncStore } = await import('@/store/syncStore')
        const { auth, serverUrl } = useSyncStore.getState()
        if (!auth.isAuthenticated) return

        const baseUrl = serverUrl || 'http://localhost:3000'
        await axios.delete(`${baseUrl}/api/autopilot/${ruleId}`)
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

        const account = useAccountStore.getState().accounts.find(a => a.id === rule.accountId)
        if (!account) throw new Error("Account not found")

        const primary = account.addons.find(a => a.transportUrl === rule.primaryUrl)
        const backup = account.addons.find(a => a.transportUrl === rule.backupUrl)

        if (!primary || !backup) throw new Error("Addons missing")

        // Import dynamically to avoid circular dependency issues if any
        const { checkAddonFunctionality } = await import('@/lib/addon-health')

        const primaryHealth = await checkAddonFunctionality(primary.transportUrl)
        const backupHealth = await checkAddonFunctionality(backup.transportUrl)

        return {
            primary: { name: primary.manifest.name, ...primaryHealth },
            backup: { name: backup.manifest.name, ...backupHealth }
        }
    },

    initialize: async () => {
        try {
            const storedRules = await localforage.getItem<FailoverRule[]>(STORAGE_KEY)
            const storedWebhook = await localforage.getItem<WebhookConfig>(STORAGE_KEY + ':webhook')

            if (storedRules) {
                const accounts = useAccountStore.getState().accounts
                const migrated = storedRules.map(r => {
                    const ruleData = r as unknown as Record<string, string | undefined>
                    let primaryUrl = ruleData.primaryUrl || ''
                    let backupUrl = ruleData.backupUrl || ''
                    const { primaryAddonId, backupAddonId, accountId } = ruleData

                    if (!primaryUrl && primaryAddonId) {
                        const acc = accounts.find(a => a.id === accountId)
                        primaryUrl = acc?.addons.find(a => a.manifest.id === primaryAddonId)?.transportUrl || ''
                    }
                    if (!backupUrl && backupAddonId) {
                        const acc = accounts.find(a => a.id === accountId)
                        backupUrl = acc?.addons.find(a => a.manifest.id === backupAddonId)?.transportUrl || ''
                    }
                    return {
                        ...r,
                        primaryUrl,
                        backupUrl,
                        lastCheck: r.lastCheck ? new Date(r.lastCheck) : undefined,
                        lastFailover: r.lastFailover ? new Date(r.lastFailover) : undefined
                    }
                })
                set({ rules: migrated })
            }

            if (storedWebhook) {
                set({ webhook: storedWebhook })
            }
        } catch (error) {
            console.error('Failed to load failover rules:', error)
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
        const newRule: FailoverRule = {
            id: crypto.randomUUID(),
            accountId,
            priorityChain,
            isActive: true,
            status: 'idle',
            activeUrl: priorityChain[0]
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
            const { rules, webhook } = get()
            const activeRules = rules.filter(r => r.isActive)
            const accounts = useAccountStore.getState().accounts

            for (const rule of activeRules) {
                const account = accounts.find(a => a.id === rule.accountId)
                if (!account) continue

                const chain = rule.priorityChain || []
                if (chain.length === 0) continue

                let bestCandidate: string | null = null
                const stabilization = { ...(rule.stabilization || {}) }
                const updatedRule = { ...rule, lastCheck: new Date(), stabilization }

                // Check each addon in the chain in priority order
                for (let i = 0; i < chain.length; i++) {
                    const url = chain[i]
                    const isOnline = await checkAddonHealth(url)

                    if (isOnline) {
                        stabilization[url] = (stabilization[url] || 0) + 1

                        // ANTI-FLAPPING: To move "up" (index < current) or stay at top, we need stability
                        const currentActiveIndex = chain.indexOf(rule.activeUrl || '')
                        const isImproving = currentActiveIndex === -1 || i < currentActiveIndex

                        // If it's a better one (higher priority) or if we are not set yet, it needs stability (2 checks).
                        // If it's the current one OR lower priority, we accept it if it's online.
                        const isStable = !isImproving || stabilization[url] >= 2

                        if (isStable) {
                            bestCandidate = url
                            break // Found the best stable worker
                        }
                    } else {
                        stabilization[url] = 0 // Reset on failure
                    }
                }

                // If no healthy addons found, we stay on the current one or first one (last resort)
                if (!bestCandidate) {
                    console.warn(`[Failover] Rule ${rule.id}: All addons in chain are DOWN.`)
                    bestCandidate = rule.activeUrl || chain[0]
                }

                // ACTION: If bestCandidate differs from activeUrl, perform the swap
                if (bestCandidate !== rule.activeUrl) {
                    console.log(`[Failover] Rule ${rule.id} swapping: ${rule.activeUrl} -> ${bestCandidate}`)

                    try {
                        // 1. Find all addons in chain for this account and enable/disable as needed
                        for (const url of chain) {
                            const isCandidate = url === bestCandidate
                            const addon = account.addons.find(a => a.transportUrl === url)
                            if (!addon) continue

                            // Only update if state change is needed
                            if ((addon.flags?.enabled !== false) !== isCandidate) {
                                await useAccountStore.getState().toggleAddonEnabled(account.id, url, isCandidate, true)
                            }
                        }

                        // 2. Update Rule State
                        const isPrimary = bestCandidate === chain[0]
                        updatedRule.activeUrl = bestCandidate
                        updatedRule.status = isPrimary ? 'monitoring' : 'failed-over'
                        updatedRule.lastFailover = isPrimary ? rule.lastFailover : new Date()

                        // 3. Log Event
                        const candidateName = account.addons.find(a => a.transportUrl === bestCandidate)?.manifest.name || 'Unknown'
                        await useHistoryStore.getState().addLog({
                            type: isPrimary ? 'recovery' : 'failover',
                            ruleId: rule.id,
                            message: isPrimary
                                ? `System recovered. Switched back to primary addon: ${candidateName}`
                                : `Priority shift! primary failed or inferior. Switched to backup: ${candidateName}`,
                            metadata: { chain, activeUrl: bestCandidate }
                        })

                        // 4. Webhook Notification
                        if (webhook.enabled && webhook.url) {
                            fetch(webhook.url, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    username: "AIOManager Autopilot",
                                    embeds: [{
                                        title: isPrimary ? "🟢 Autopilot Recovery" : "🚨 Autopilot Handover",
                                        color: isPrimary ? 3066993 : 15158332,
                                        description: `**Account:** ${account.id}\n**Active Addon:** ${candidateName}\n**Action:** Switched from ${rule.activeUrl || 'None'} to ${bestCandidate}`,
                                        timestamp: new Date().toISOString()
                                    }]
                                })
                            }).catch(err => console.error("Webhook failed", err))
                        }

                        // 5. Toast notification
                        toast({
                            title: isPrimary ? "Autopilot Recovered" : "Autopilot Handover",
                            description: `Now using: ${candidateName}`,
                            variant: isPrimary ? "default" : "destructive"
                        })

                    } catch (err) {
                        console.error(`[Failover] Rule ${rule.id} swap failed:`, err)
                    }
                }

                // Update store with new rule state
                set(state => ({
                    rules: state.rules.map(r => r.id === rule.id ? updatedRule : r)
                }))
            }

            // Persist rules
            await localforage.setItem(STORAGE_KEY, get().rules)
        } finally {
            set({ isChecking: false })
        }
    },

    startAutomation: () => {
        if (automationInterval) return
        console.log('[Failover] Starting automation engine...')
        set({ isMonitoring: true })

        // Initial check
        get().checkRules()

        // Interval check (every 1 minute)
        automationInterval = setInterval(() => {
            // Idle Optimization: Skip autopilot checks if tab is hidden
            if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
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
    },

    importRules: async (rulesToImport: FailoverRule[]) => {
        if (!rulesToImport || !Array.isArray(rulesToImport)) return

        const currentRules = [...get().rules]
        let updatedCount = 0
        let addedCount = 0

        const accounts = useAccountStore.getState().accounts
        rulesToImport.forEach(newRule => {
            const ruleData = newRule as unknown as Record<string, string | undefined>
            let primaryUrl = ruleData.primaryUrl || ''
            let backupUrl = ruleData.backupUrl || ''
            const { primaryAddonId, backupAddonId, accountId } = ruleData

            if (!primaryUrl && primaryAddonId) {
                const acc = accounts.find(a => a.id === accountId)
                primaryUrl = acc?.addons.find(a => a.manifest.id === primaryAddonId)?.transportUrl || ''
            }
            if (!backupUrl && backupAddonId) {
                const acc = accounts.find(a => a.id === accountId)
                backupUrl = acc?.addons.find(a => a.manifest.id === backupAddonId)?.transportUrl || ''
            }

            const migratedRule: FailoverRule = {
                ...newRule,
                primaryUrl,
                backupUrl,
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

        console.log(`[Failover] Import sync: ${addedCount} added, ${updatedCount} updated.`)
    }
}))
