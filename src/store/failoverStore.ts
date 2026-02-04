import { create } from 'zustand'
import localforage from 'localforage'
import { checkAddonHealth } from '@/lib/addon-health'
import { useAccountStore } from '@/store/accountStore'
import { toast } from '@/hooks/use-toast'
import { useHistoryStore } from '@/store/historyStore'

const STORAGE_KEY = 'stremio-manager:failover-rules'

export interface FailoverRule {
    id: string
    accountId: string
    primaryUrl: string
    backupUrl: string
    isActive: boolean
    lastCheck?: Date
    lastFailover?: Date
    status: 'idle' | 'monitoring' | 'failed-over'
    // Legacy support for migration
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
    addRule: (accountId: string, primaryUrl: string, backupUrl: string) => Promise<void>
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

    addRule: async (accountId, primaryUrl, backupUrl) => {
        const newRule: FailoverRule = {
            id: crypto.randomUUID(),
            accountId,
            primaryUrl,
            backupUrl,
            isActive: true,
            status: 'idle'
        }

        const rules = [...get().rules, newRule]
        set({ rules })
        await localforage.setItem(STORAGE_KEY, rules)

        // Immediate sync
        const { useSyncStore } = await import('@/store/syncStore')
        useSyncStore.getState().syncToRemote(true).catch(console.error)
    },

    removeRule: async (ruleId) => {
        const rules = get().rules.filter(r => r.id !== ruleId)
        set({ rules })
        await localforage.setItem(STORAGE_KEY, rules)

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

                console.log(`[Failover] Rule ${rule.id}: Checking primary health...`)

                const primary = account.addons.find(a => a.transportUrl === rule.primaryUrl)
                const backup = account.addons.find(a => a.transportUrl === rule.backupUrl)

                if (!primary || !backup) {
                    console.warn(`Rule ${rule.id} references missing addons`)
                    continue
                }

                // Check Primary Health
                const isPrimaryOnline = await checkAddonHealth(primary.transportUrl)

                // Update Rule State
                const updatedRule = { ...rule, lastCheck: new Date() }

                // LOGIC MATRIX
                // 1. Primary DOWN && Backup DISABLED => FAILOVER TRIGGER
                // 2. Primary UP && Backup ENABLED && Primary DISABLED => RECOVERY (Optional, maybe manual for now?)

                const isPrimaryEnabled = primary.flags?.enabled !== false
                const isBackupEnabled = backup.flags?.enabled !== false

                if (!isPrimaryOnline) {
                    // Primary is DOWN
                    if (isPrimaryEnabled && !isBackupEnabled && rule.status !== 'failed-over') {
                        // FAILOVER TRIGGER
                        console.log(`[Failover] Rule ${rule.id} triggering! Primary ${primary.manifest.name} is DOWN.`)

                        try {
                            // 1. Disable Primary
                            await useAccountStore.getState().toggleAddonEnabled(account.id, primary.transportUrl, false, true)

                            // 2. Enable Backup
                            await useAccountStore.getState().toggleAddonEnabled(account.id, backup.transportUrl, true, true)

                            updatedRule.status = 'failed-over'
                            updatedRule.lastFailover = new Date()

                            // LOG EVENT
                            await useHistoryStore.getState().addLog({
                                type: 'failover',
                                ruleId: rule.id,
                                primaryName: primary.manifest.name,
                                backupName: backup.manifest.name,
                                message: `Primary addon "${primary.manifest.name}" failed health check. Switched to backup "${backup.manifest.name}".`
                            })

                            // WEBHOOK NOTIFICATION
                            const { webhook } = get()
                            if (webhook.enabled && webhook.url) {
                                fetch(webhook.url, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({
                                        username: "AIOManager Failover",
                                        avatar_url: "https://raw.githubusercontent.com/sonicx161/AIOManager/main/public/logo.png",
                                        embeds: [{
                                            title: "🚨 Failover Triggered",
                                            color: 15158332, // Red
                                            description: `**Primary:** ${primary.manifest.name}\n**Backup:** ${backup.manifest.name}\n**Account:** ${account.email || 'Unknown'}\n\nPrimary addon failed health check. Switched to backup.`,
                                            timestamp: new Date().toISOString()
                                        }]
                                    })
                                }).catch(e => console.error("Webhook failed", e))
                            }

                            toast({
                                title: "Failover Triggered",
                                description: `Primary "${primary.manifest.name}" failed! Switched to "${backup.manifest.name}".`,
                                variant: "destructive"
                            })

                        } catch (err) {
                            console.error("Failover execution failed", err)
                        }
                    } else if (rule.status === 'failed-over') {
                        // Primary is still down, and we are in failed-over state.
                        // MAINTAIN status.
                        updatedRule.status = 'failed-over'
                    } else {
                        // Primary is down, but we haven't failed over (maybe backup is also down? or manual override?)
                        updatedRule.status = 'monitoring'
                    }
                } else {
                    // Primary is ONLINE
                    if (rule.status === 'failed-over') {
                        // RECOVERY TRIGGER
                        // Primary is back online! Switch back.
                        console.log(`[Failover] Rule ${rule.id} recovering! Primary ${primary.manifest.name} is UP.`)

                        try {
                            // 1. Enable Primary
                            await useAccountStore.getState().toggleAddonEnabled(account.id, primary.transportUrl, true, true)

                            // 2. Disable Backup
                            await useAccountStore.getState().toggleAddonEnabled(account.id, backup.transportUrl, false, true)

                            updatedRule.status = 'monitoring'

                            // LOG EVENT
                            await useHistoryStore.getState().addLog({
                                type: 'recovery',
                                ruleId: rule.id,
                                primaryName: primary.manifest.name,
                                backupName: backup.manifest.name,
                                message: `Primary addon "${primary.manifest.name}" is back online. Switched back to primary.`
                            })

                            // WEBHOOK NOTIFICATION
                            const { webhook } = get()
                            if (webhook.enabled && webhook.url) {
                                fetch(webhook.url, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({
                                        username: "AIOManager Failover",
                                        avatar_url: "https://raw.githubusercontent.com/sonicx161/AIOManager/main/public/logo.png",
                                        embeds: [{
                                            title: "🟢 Failover Recovery",
                                            color: 3066993, // Green
                                            description: `**Primary:** ${primary.manifest.name}\n**Backup:** ${backup.manifest.name}\n**Account:** ${account.email || 'Unknown'}\n\nPrimary addon is back online. Switched back from backup.`,
                                            timestamp: new Date().toISOString()
                                        }]
                                    })
                                }).catch(e => console.error("Webhook failed", e))
                            }

                            toast({
                                title: "Failover Recovery",
                                description: `Primary "${primary.manifest.name}" is back online! Switched back.`,
                                className: "bg-green-500/10 border-green-500/50 text-green-900 dark:text-green-100"
                            })

                        } catch (err) {
                            console.error("Recovery execution failed", err)
                            // Stay in failed-over if recovery fails? Or force monitoring?
                            // Let's force monitoring to try again later or assume partial success.
                            updatedRule.status = 'monitoring'
                        }
                    } else {
                        // Normal monitoring
                        updatedRule.status = 'monitoring'

                        // SELF-HEALING: Ensure state consistent with monitoring (Primary UP = Primary Enabled & Backup Disabled)
                        // If user Manually toggled things, this might override them, but "Failover" implies rigorous policy.
                        if (!isPrimaryEnabled || isBackupEnabled) {
                            console.log(`[Failover] Rule ${rule.id} self-healing: Primary is UP but state is inconsistent. Resetting to nominal.`)
                            try {
                                if (!isPrimaryEnabled) await useAccountStore.getState().toggleAddonEnabled(account.id, primary.transportUrl, true, true)
                                if (isBackupEnabled) await useAccountStore.getState().toggleAddonEnabled(account.id, backup.transportUrl, false, true)

                                // LOG EVENT
                                await useHistoryStore.getState().addLog({
                                    type: 'self-healing',
                                    ruleId: rule.id,
                                    primaryName: primary.manifest.name,
                                    backupName: backup.manifest.name,
                                    message: `Detected inconsistent state (Split Brain). Resetting to nominal (Primary On, Backup Off).`
                                })
                            } catch (err) {
                                console.error("Self-healing failed", err)
                            }
                        }
                    }
                }

                // Update store with new rule state
                set(state => ({
                    rules: state.rules.map(r => r.id === rule.id ? updatedRule : r)
                }))
            }

            // Persist checking timestamps
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
