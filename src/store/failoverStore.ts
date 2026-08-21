import { triggerSync } from '@/lib/sync-trigger'
import { mapConcurrent } from '@/lib/concurrency'
import { create } from 'zustand'
import localforage from 'localforage'
import { useAccountStore, getCachedAuthKey, getStremioAuthKey, hasPlatformConnection } from '@/store/accountStore'
import { decrypt, encrypt, loadSessionKey } from '@/lib/crypto'
import { normalizeAddonUrl } from '@/lib/utils'
import { resilientFetch } from '@/lib/api-resilience'
import { useAuthStore } from '@/store/authStore'
import { toast } from '@/hooks/use-toast'
import { isSyncEligibleConnection } from '@/types/connection'

const STORAGE_KEY = 'aioman:failover-rules'

export interface AutopilotCycleStats {
    scanned: number
    cursor: string
    budgetHit: boolean
    durationMs: number
}

export interface AutopilotStabilizationEntry {
    failures?: number
    successes?: number
    latencyMs?: number | null
}

export interface FailoverRule {
    id: string
    accountId: string
    name?: string
    priorityChain: string[] // URLs in order of preference
    isActive: boolean
    lastCheck?: Date
    lastFailover?: Date
    status: 'idle' | 'monitoring' | 'failed-over'
    activeUrl?: string // Track which one is currently pushed to the platform
    isAutomatic?: boolean
    stabilization?: Record<string, number | AutopilotStabilizationEntry>
    cooldown_ms?: number // Custom webhook cooldown for this rule
    webhookUrl?: string      // Per-rule override URL. Empty string = use global default.
    notifyEnabled?: boolean  // Per-rule notification toggle. Undefined/true = enabled.
    messageTemplate?: string // Custom notification message. Supports {account} {addon} {status} {from} {to} {rule}
    customCheckUrls?: CustomCheckEntry[] // Additional URLs to health-check alongside specific addons
    platform?: string
    connectionId?: string
}

export interface CustomCheckEntry {
    url: string
    appliesTo: string[]
}

export interface WebhookConfig {
    url: string
    enabled: boolean
    updatedAt?: number
    isEncrypted?: boolean
}

interface FailoverStore {
    rules: FailoverRule[]
    webhook: WebhookConfig
    loading: boolean
    isMonitoring: boolean
    isChecking: boolean // Re-entrancy guard
    lastWorkerRun?: Date // In-memory heartbeat from server
    lastCycle?: AutopilotCycleStats

    initialize: () => Promise<void>
    syncServerState: () => Promise<void>
    setWebhook: (url: string, enabled: boolean) => Promise<void>
    addRule: (accountId: string, priorityChain: string[], name?: string, cooldown_ms?: number, webhookUrl?: string, notifyEnabled?: boolean, messageTemplate?: string, customCheckUrls?: CustomCheckEntry[]) => Promise<void>
    updateRule: (ruleId: string, updates: Partial<FailoverRule>) => Promise<void>
    removeRule: (ruleId: string) => Promise<void>
    reorderRules: (accountId: string, orderedRuleIds: string[]) => Promise<void>
    toggleRuleActive: (ruleId: string, isActive: boolean) => Promise<void>
    checkRules: () => Promise<void>
    pullServerState: () => Promise<void>
    pulse: () => Promise<void>
    testRule: (ruleId: string) => Promise<{ primary: unknown, backup: unknown }>
    startAutomation: () => void
    stopAutomation: () => void
    importRules: (data: unknown, strategy?: 'merge' | 'mirror', isSilent?: boolean) => Promise<void>
    importWebhook: (config: WebhookConfig, isSilent?: boolean) => Promise<void>
    syncRulesForAccount: (accountId: string) => Promise<void>
    removeUrlFromRules: (accountId: string, url: string) => Promise<void>
    replaceUrlInRules: (oldUrl: string, newUrl: string, accountId?: string) => Promise<void>
    toggleAllRulesForAccount: (accountId: string, isActive: boolean) => Promise<void>
    toggleAllRulesForAccounts: (isActive: boolean) => Promise<void>
    mirrorRulesToAccounts: (sourceAccountId: string, targetAccountIds: string[]) => Promise<{ mirrored: number; skipped: number }>
    deleteProfileRules: (accountId: string, profileId: string) => Promise<void>
    awakenProfileRules: (accountId: string, rules: FailoverRule[]) => Promise<void>
    pruneServerRulesToActive: (accountId: string, activeRuleIds: string[]) => Promise<void>
    reset: () => Promise<void>
}

let automationInterval: number | null = null
let _lastWorkerRun: number = 0
let _isPulling = false
let _adaptiveIntervalMs = 60000
let _stableCheckCount = 0
const _pendingRuleUpdates = new Set<string>()
const BASE_INTERVAL_MS = 60000
const MAX_INTERVAL_MS = 600000
const STABLE_THRESHOLD = 3

type AddonEnabledSnapshot = {
    transportUrl: string
    flags?: { enabled?: boolean }
}

const findAddonByNormalizedUrl = (addons: AddonEnabledSnapshot[] | undefined, normalizedUrl: string) =>
    addons?.find(addon => normalizeAddonUrl(addon.transportUrl) === normalizedUrl)

const hasEnabledMismatch = (addons: AddonEnabledSnapshot[] | undefined, normalizedUrl: string, shouldBeEnabled: boolean) => {
    const addon = findAddonByNormalizedUrl(addons, normalizedUrl)
    if (!addon) return false
    return (addon.flags?.enabled !== false) !== shouldBeEnabled
}

const normalizeCustomChecks = (checks: Array<CustomCheckEntry | string> | undefined): CustomCheckEntry[] => {
    if (!Array.isArray(checks)) return []
    return checks
        .map(c => {
            if (typeof c === 'string') return { url: c.trim(), appliesTo: [] }
            if (c && typeof c === 'object' && typeof c.url === 'string') {
                return {
                    url: c.url.trim(),
                    appliesTo: Array.isArray(c.appliesTo) ? c.appliesTo.filter((u: unknown) => typeof u === 'string') : [],
                }
            }
            return null
        })
        .filter((c): c is CustomCheckEntry => c !== null && c.url.length > 0)
        .slice(0, 5)
}

const reconcileAccountAddonsWithActiveRule = async (rule: FailoverRule) => {
    if (!rule.isActive || !rule.priorityChain.length) return false

    const account = useAccountStore.getState().accounts.find(a => a.id === rule.accountId)
    if (!account) return false

    const activeUrl = rule.activeUrl || rule.priorityChain[0]
    const normActive = normalizeAddonUrl(activeUrl)
    const activeProfile = account.activeProfileId
        ? account.profiles?.find(profile => profile.id === account.activeProfileId)
        : undefined

    let reconciled = false
    let activeAddonMissing = false

    for (const url of rule.priorityChain) {
        const normUrl = normalizeAddonUrl(url)
        const shouldBeEnabled = normUrl === normActive
        const accountAddon = findAddonByNormalizedUrl(account.addons, normUrl)
        const profileMissingActive = !!activeProfile && shouldBeEnabled && !findAddonByNormalizedUrl(activeProfile.addons, normUrl)

        if (!accountAddon) {
            if (shouldBeEnabled) activeAddonMissing = true
            continue
        }

        const accountMismatch = hasEnabledMismatch(account.addons, normUrl, shouldBeEnabled)
        const profileMismatch = !!activeProfile && (
            profileMissingActive ||
            hasEnabledMismatch(activeProfile.addons, normUrl, shouldBeEnabled)
        )

        if (!accountMismatch && !profileMismatch) continue

        await useAccountStore.getState().toggleAddonEnabled(
            rule.accountId,
            url,
            shouldBeEnabled,
            false,
            undefined,
            true
        )
        reconciled = true
    }

    if (activeAddonMissing) {
        await useAccountStore.getState().syncAccount(rule.accountId, false)
        reconciled = true
    }

    if (reconciled) {
        await syncRuleToServer(rule)
    }

    return reconciled
}

const scheduleNextPoll = () => {
    if (automationInterval) window.clearTimeout(automationInterval)
    const state = useFailoverStore.getState()
    if (!state.isMonitoring) {
        automationInterval = window.setTimeout(scheduleNextPoll, 60000)
        return
    }
    if (state.rules.length === 0) {
        automationInterval = window.setTimeout(scheduleNextPoll, 300000)
        return
    }
    automationInterval = window.setTimeout(async () => {
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
            scheduleNextPoll()
            return
        }
        const currentState = useFailoverStore.getState()
        if (!currentState.isMonitoring) {
            scheduleNextPoll()
            return
        }

        const hadActiveUrlBefore = new Map(currentState.rules.map(r => [r.id, r.activeUrl]))
        await currentState.pulse()
        const afterState = useFailoverStore.getState()

        let switched = false
        for (const rule of afterState.rules) {
            if (hadActiveUrlBefore.get(rule.id) !== rule.activeUrl) {
                switched = true
                break
            }
        }

        if (switched) {
            _stableCheckCount = 0
            _adaptiveIntervalMs = BASE_INTERVAL_MS
        } else {
            _stableCheckCount++
            if (_stableCheckCount >= STABLE_THRESHOLD) {
                _adaptiveIntervalMs = Math.min(_adaptiveIntervalMs * 2, MAX_INTERVAL_MS)
                _stableCheckCount = 0
            }
        }

        scheduleNextPoll()
    }, _adaptiveIntervalMs)
}

const syncRuleToServer = async (rule: FailoverRule) => {
    try {
        const { useSyncStore } = await import('@/store/syncStore')
        const { auth, serverUrl } = useSyncStore.getState()
        if (!auth.isAuthenticated) return

        const account = useAccountStore.getState().accounts.find(a => a.id === rule.accountId)
        if (!account) return

        const sessionKey = await loadSessionKey()
        if (!sessionKey) throw new Error('Encryption key not found')

        let authKey = ''
        let connectionId: string | undefined
        let credentialType: string | undefined
        let platform: string | undefined = rule.platform
        const stremioKey = getStremioAuthKey(account)
        if (stremioKey) {
            try { authKey = await getCachedAuthKey(stremioKey, sessionKey) } catch { authKey = '' }
        }
        if (authKey) {
            if (!platform) platform = 'stremio'
        } else {
            const fallbackConn = account.connections?.find(c => c.enabled && isSyncEligibleConnection(c))
            connectionId = rule.connectionId || fallbackConn?.id
            credentialType = fallbackConn?.connectionType
            if (!platform || platform === 'stremio') platform = fallbackConn?.platform
        }
        if (!authKey && !connectionId) throw new Error('Failed to decrypt auth key')
        const baseUrl = serverUrl || ''
        const apiPath = baseUrl.startsWith('http') ? `${baseUrl.replace(/\/$/, '')}/api` : '/api'

        const addonList = account.addons || []
        const syncPassword = useSyncStore.getState().auth.password
        const { deriveSyncToken } = await import('@/lib/crypto')
        const syncToken = await deriveSyncToken(syncPassword)

        await resilientFetch(`${apiPath}/autopilot/sync`, {
            method: 'POST',
            retries: 0,
            headers: {
                'Content-Type': 'application/json',
                'x-sync-password': syncToken,
                'x-sync-user': auth.id
            },
            body: JSON.stringify({
                id: rule.id,
                accountId: rule.accountId,
                name: rule.name,
                authKey,
                connectionId,
                credentialType,
                platform,
                priorityChain: rule.priorityChain,
                activeUrl: rule.activeUrl || rule.priorityChain?.[0],
                is_active: rule.isActive ? 1 : 0,
                is_automatic: rule.isAutomatic !== false ? 1 : 0,
                addonList,
                webhookUrl: rule.notifyEnabled === false
                    ? ''
                    : (rule.webhookUrl || useFailoverStore.getState().webhook.url),
                cooldown_ms: rule.cooldown_ms,
                messageTemplate: rule.messageTemplate || null,
                customCheckUrls: normalizeCustomChecks(rule.customCheckUrls),
            })
        })
        if (import.meta.env.DEV) console.log(`[Autopilot] Rule ${rule.id} synced to server (Live Mode).`)
    } catch (err) {
        if (import.meta.env.DEV) console.error('[Autopilot] Server sync failed:', err)
    }
}

const syncRulesToServerBatch = async (rules: FailoverRule[]) => {
    if (rules.length === 0) return
    try {
        const { useSyncStore } = await import('@/store/syncStore')
        const { auth, serverUrl } = useSyncStore.getState()
        if (!auth.isAuthenticated) return

        const sessionKey = await loadSessionKey()
        if (!sessionKey) throw new Error('Encryption key not found')

        const syncPassword = useSyncStore.getState().auth.password
        const { deriveSyncToken } = await import('@/lib/crypto')
        const syncToken = await deriveSyncToken(syncPassword)

        const baseUrl = serverUrl || ''
        const apiPath = baseUrl.startsWith('http') ? `${baseUrl.replace(/\/$/, '')}/api` : '/api'

        const payload = []
        for (const rule of rules) {
            const account = useAccountStore.getState().accounts.find(a => a.id === rule.accountId)
            if (!account) continue
            let authKey = ''
            let connectionId: string | undefined
            let credentialType: string | undefined
            let platform: string | undefined = rule.platform
            const stremioKey = getStremioAuthKey(account)
            if (stremioKey) {
                try { authKey = await getCachedAuthKey(stremioKey, sessionKey) } catch { authKey = '' }
            }
            if (authKey) {
                if (!platform) platform = 'stremio'
            } else {
                const fallbackConn = account.connections?.find(c => c.enabled && isSyncEligibleConnection(c))
                connectionId = rule.connectionId || fallbackConn?.id
                credentialType = fallbackConn?.connectionType
                if (!platform || platform === 'stremio') platform = fallbackConn?.platform
            }
            if (!authKey && !connectionId) continue
            const addonList = account.addons || []
            payload.push({
                id: rule.id,
                accountId: rule.accountId,
                name: rule.name,
                authKey,
                connectionId,
                credentialType,
                platform,
                priorityChain: rule.priorityChain,
                activeUrl: rule.activeUrl || rule.priorityChain?.[0],
                is_active: rule.isActive ? 1 : 0,
                is_automatic: rule.isAutomatic !== false ? 1 : 0,
                addonList,
                webhookUrl: rule.notifyEnabled === false
                    ? ''
                    : (rule.webhookUrl || useFailoverStore.getState().webhook.url),
                cooldown_ms: rule.cooldown_ms,
                messageTemplate: rule.messageTemplate || null,
                customCheckUrls: normalizeCustomChecks(rule.customCheckUrls),
            })
        }

        if (payload.length === 0) return

        await resilientFetch(`${apiPath}/autopilot/sync-batch`, {
            method: 'POST',
            retries: 0,
            headers: {
                'Content-Type': 'application/json',
                'x-sync-password': syncToken,
                'x-sync-user': auth.id
            },
            body: JSON.stringify(payload)
        })
        if (import.meta.env.DEV) console.log(`[Autopilot] Batch synced ${payload.length} rules to server.`)
    } catch (err) {
        if (import.meta.env.DEV) console.error('[Autopilot] Batch server sync failed:', err)
    }
}

const DELETED_RULES_MAX = 100
const DELETED_RULES_KEY = 'aioman:failover-deleted'

const trackDeletedRule = async (ruleId: string) => {
    try {
        const raw = await localforage.getItem<string[]>(DELETED_RULES_KEY)
        const deleted = raw || []
        if (!deleted.includes(ruleId)) {
            deleted.push(ruleId)
            if (deleted.length > DELETED_RULES_MAX) deleted.splice(0, deleted.length - DELETED_RULES_MAX)
            await localforage.setItem(DELETED_RULES_KEY, deleted)
        }
    } catch (e) { if (import.meta.env.DEV) console.error(e) }
}

const getDeletedRuleIds = async (): Promise<string[]> => {
    try {
        return (await localforage.getItem<string[]>(DELETED_RULES_KEY)) || []
    } catch { return [] }
}

const parseAutopilotCycleStats = (value: unknown): AutopilotCycleStats | undefined => {
    if (!value || typeof value !== 'object') return undefined
    const v = value as Record<string, unknown>
    const scanned = Number(v.scanned)
    const durationMs = Number(v.durationMs)
    return {
        scanned: Number.isFinite(scanned) ? scanned : 0,
        cursor: typeof v.cursor === 'string' ? v.cursor : '',
        budgetHit: Boolean(v.budgetHit),
        durationMs: Number.isFinite(durationMs) ? durationMs : 0,
    }
}

const clearDeletedRuleId = async (ruleId: string) => {
    try {
        const raw = await localforage.getItem<string[]>(DELETED_RULES_KEY)
        if (raw) {
            const updated = raw.filter(id => id !== ruleId)
            await localforage.setItem(DELETED_RULES_KEY, updated)
        }
    } catch (e) { if (import.meta.env.DEV) console.error(e) }
}

const deleteRuleFromServer = async (ruleId: string) => {
    try {
        const { useSyncStore } = await import('@/store/syncStore')
        const { auth, serverUrl } = useSyncStore.getState()
        if (!auth.isAuthenticated) return true

        const baseUrl = serverUrl || ''
        const apiPath = baseUrl.startsWith('http') ? `${baseUrl.replace(/\/$/, '')}/api` : '/api'

        const syncPassword = useSyncStore.getState().auth.password
        const { deriveSyncToken } = await import('@/lib/crypto')
        const syncToken = await deriveSyncToken(syncPassword)

        const res = await resilientFetch(`${apiPath}/autopilot/${ruleId}`, {
            method: 'DELETE',
            retries: 1,
            headers: { 'x-sync-password': syncToken, 'x-sync-user': auth.id }
        })
        if (res.ok) {
            await clearDeletedRuleId(ruleId)
            if (import.meta.env.DEV) console.log(`[Autopilot] Rule ${ruleId} deleted from server.`)
            return true
        }
        if (import.meta.env.DEV) console.error(`[Autopilot] Server deletion failed with status ${res.status}`)
        return false
    } catch (err) {
        if (import.meta.env.DEV) console.error('[Autopilot] Server deletion failed:', err)
        return false
    }
}

// gates the sync-time reconcile until rules have loaded from storage
let failoverHydrated = false

export const useFailoverStore = create<FailoverStore>((set, get) => ({
    rules: [],
    webhook: { url: '', enabled: false, updatedAt: 0 },
    loading: false,
    isMonitoring: false,
    isChecking: false,
    lastWorkerRun: undefined,
    lastCycle: undefined,

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

            let migrated = false
            rules = rules.map(r => {
                if (r.notifyEnabled === undefined || r.notifyEnabled === null) {
                    migrated = true
                    return { ...r, webhookUrl: r.webhookUrl ?? '', notifyEnabled: true }
                }
                return r
            })
            if (migrated) await localforage.setItem(STORAGE_KEY, rules)

            set({ rules })

            const currentAccountIds = new Set(useAccountStore.getState().accounts.map(a => a.id))
            const validRules = rules.filter(r => currentAccountIds.has(r.accountId))

            if (validRules.length !== rules.length) {
                const orphanIds = rules.filter(r => !currentAccountIds.has(r.accountId)).map(r => r.id)
                if (import.meta.env.DEV) console.log(`[Failover] Pruning ${orphanIds.length} orphan rules.`)
                set({ rules: validRules })
                await localforage.setItem(STORAGE_KEY, validRules)
                for (const id of orphanIds) deleteRuleFromServer(id).catch(() => {})
            }

            failoverHydrated = true

            if (storedWebhook) {
                let webhook = storedWebhook
                if (webhook.isEncrypted && webhook.url) {
                    try {
                        const sessionKey = await loadSessionKey()
                        if (sessionKey) {
                            const decryptedUrl = await decrypt(webhook.url, sessionKey)
                            if (decryptedUrl) {
                                webhook = {
                                    ...webhook,
                                    url: decryptedUrl,
                                    isEncrypted: false
                                }
                                if (import.meta.env.DEV) console.log('[Failover] Webhook URL decrypted during initialization.')
                            } else {
                                if (import.meta.env.DEV) console.warn('[Failover] Webhook decryption returned null. Clearing webhook URL.')
                                webhook = { ...webhook, url: '', isEncrypted: false }
                            }
                        } else {
                            if (import.meta.env.DEV) console.warn('[Failover] Webhook is encrypted but no session key found. Link may appear broken until unlock.')
                        }
                    } catch (e) {
                        if (import.meta.env.DEV) console.error('[Failover] Failed to decrypt webhook during initialize:', e)
                        webhook = { ...webhook, url: '', isEncrypted: false }
                    }
                }
                set({ webhook })
            }

            const finalRules = get().rules
            if (finalRules.length > 0 && !get().isMonitoring && !automationInterval) {
                if (import.meta.env.DEV) console.log(`[Failover] Auto-starting monitoring for ${finalRules.length} rules`)
                get().startAutomation()
            }
        } catch (error) {
            if (import.meta.env.DEV) console.error('Failed to load failover rules:', error)
        }
    },

    syncServerState: async () => {
        const { auth } = (await import('@/store/syncStore')).useSyncStore.getState()
        if (!auth.isAuthenticated) return
        if (_isPulling) return

        _isPulling = true
        try {
        let rules = [...get().rules]
        let needsSync = false

        try {
            const { serverUrl } = (await import('@/store/syncStore')).useSyncStore.getState()
            const accountIds = useAccountStore.getState().accounts.map(a => a.id)
            const baseUrl = serverUrl || ''
            const apiPath = baseUrl.startsWith('http') ? `${baseUrl.replace(/\/$/, '')}/api` : '/api'

            const { deriveSyncToken } = await import('@/lib/crypto')
            const syncToken = await deriveSyncToken(auth.password)
            const resp = await resilientFetch(`${apiPath}/autopilot/states`, {
                method: 'POST',
                retries: 1,
                headers: {
                    'Content-Type': 'application/json',
                    'x-sync-password': syncToken,
                    'x-sync-user': auth.id
                },
                body: JSON.stringify({ accountIds })
            })
            if (resp.ok) {
                const respData = (await resp.json()) as Record<string, unknown>
                const batchedStates = (respData?.states || {}) as Record<string, Record<string, unknown>[]>
                const serverHeartbeat = respData?.lastWorkerRun as string | undefined
                const lastCycle = parseAutopilotCycleStats(respData?.lastCycle as Record<string, unknown> | undefined)
                const isPartialState = Boolean(respData?.partial)
                if (serverHeartbeat) {
                    set({ lastWorkerRun: new Date(serverHeartbeat) })
                }
                if (lastCycle) set({ lastCycle })

                const allServerRuleIds = new Set<string>()
                for (const accountId of Object.keys(batchedStates)) {
                    const serverStates = batchedStates[accountId]
                    for (const s of serverStates as Record<string, unknown>[]) allServerRuleIds.add(s.id as string)

                    if (!isPartialState) {
                        rules = rules.filter(r => r.accountId !== accountId || allServerRuleIds.has(r.id))
                    }

                    const processedRules: FailoverRule[] = []
                    for (const serverRule of serverStates as Record<string, unknown>[]) {
                        const sr = serverRule as Record<string, unknown>
                        const existsIndex = rules.findIndex(r => r.id === (sr.id as string))

                        const processedRule: FailoverRule = {
                            id: sr.id as string,
                            accountId,
                            name: sr.name as string,
                            cooldown_ms: sr.cooldownMs as number | undefined,
                            priorityChain: (sr.priorityChain as string[]) || [],
                            isActive: sr.isActive !== undefined ? (sr.isActive as boolean) : false,
                            isAutomatic: sr.isAutomatic != null ? Boolean(sr.isAutomatic) : true,
                            activeUrl: (sr.activeUrl as string) || ((sr.priorityChain as string[]) || [])[0] as string | undefined,
                            lastCheck: sr.lastCheck ? new Date(sr.lastCheck as string | number) : undefined,
                            stabilization: (sr.stabilization as Record<string, number | AutopilotStabilizationEntry>) || {},
                            webhookUrl: sr.webhookUrl as string | undefined,
                            messageTemplate: sr.messageTemplate as string | undefined,
                            customCheckUrls: (sr.customCheckUrls as CustomCheckEntry[]) || [],
                            status: 'idle'
                        }

                        if (processedRule.activeUrl) {
                            const normServerActive = normalizeAddonUrl(processedRule.activeUrl)
                            const normPrimary = normalizeAddonUrl(processedRule.priorityChain?.[0] || '')
                            processedRule.status = normServerActive === normPrimary ? 'monitoring' : 'failed-over'
                        }

                        if (existsIndex !== -1) {
                            rules[existsIndex] = { ...rules[existsIndex], ...processedRule }
                        } else {
                            rules.push(processedRule)
                        }
                        processedRules.push(processedRule)
                    }

                    const reconcileResults = await mapConcurrent(processedRules, 3, (rule) => reconcileAccountAddonsWithActiveRule(rule))
                    if (reconcileResults.some(Boolean)) {
                        needsSync = true
                    }
                }
            }
        } catch (e) {
            if (import.meta.env.DEV) console.warn('[Failover] Deferred server state fetch failed:', e)
            return
        }

        const trackedDeletions = await getDeletedRuleIds()
        if (trackedDeletions.length > 0) {
            for (const deletedId of trackedDeletions) {
                const deletedOnServer = await deleteRuleFromServer(deletedId)
                if (deletedOnServer) {
                    rules = rules.filter(r => r.id !== deletedId)
                }
            }
        }

        if (needsSync) {
            try {
                await useAccountStore.getState().syncAllAccounts(true)
            } catch (e) {
                if (import.meta.env.DEV) console.warn('[Failover] Post-sync-server-state sync failed:', e)
            }
        }

        set({ rules })
        await localforage.setItem(STORAGE_KEY, rules)
        } finally { _isPulling = false }
    },

    pullServerState: async () => {
        const { rules } = get()
        if (rules.length === 0 || _isPulling) return

        _isPulling = true
        try {
            if (useAuthStore.getState().isLocked) return

            const { useSyncStore } = await import('@/store/syncStore')
            const { auth, serverUrl } = useSyncStore.getState()
            if (!auth.isAuthenticated) return

            const accountIds = [...new Set(rules.map(r => r.accountId))]
            const baseUrl = serverUrl || ''
            const apiPath = baseUrl.startsWith('http') ? `${baseUrl.replace(/\/$/, '')}/api` : '/api'
            const syncPassword = useSyncStore.getState().auth.password
            const { deriveSyncToken } = await import('@/lib/crypto')
            const syncToken = await deriveSyncToken(syncPassword)

            const resp = await resilientFetch(`${apiPath}/autopilot/states`, {
                method: 'POST',
                retries: 1,
                headers: {
                    'Content-Type': 'application/json',
                    'x-sync-password': syncToken,
                    'x-sync-user': auth.id
                },
                body: JSON.stringify({ accountIds })
            })
            if (!resp.ok) {
                if (import.meta.env?.DEV) console.warn(`[Failover] pullServerState failed: ${resp.status} ${resp.statusText}`)
                _adaptiveIntervalMs = BASE_INTERVAL_MS
                _stableCheckCount = 0
                return
            }
            const respData = (await resp.json()) as Record<string, unknown>
            const batchedStates = (respData?.states || {}) as Record<string, Record<string, unknown>[]>
            const serverHeartbeat = respData?.lastWorkerRun as string | undefined
            const lastCycle = parseAutopilotCycleStats(respData?.lastCycle as Record<string, unknown> | undefined)

            if (serverHeartbeat) {
                set({ lastWorkerRun: new Date(serverHeartbeat) })
            }
            if (lastCycle) set({ lastCycle })

            let hasUpdates = false
            const updatedRules = [...rules]

            for (const accountId of Object.keys(batchedStates)) {
                const serverStates = batchedStates[accountId]
                for (const serverRuleRaw of serverStates) {
                    const serverRule = serverRuleRaw as Record<string, unknown>
                    const ruleIndex = updatedRules.findIndex(r => r.id === (serverRule.id as string))
                    if (ruleIndex !== -1) {
                        const localRule = updatedRules[ruleIndex]
                        const isPendingUpdate = _pendingRuleUpdates.has(localRule.id)
                        const nextPriorityChain = isPendingUpdate
                            ? localRule.priorityChain
                            : (Array.isArray(serverRule.priorityChain) ? (serverRule.priorityChain as string[]) : localRule.priorityChain)
                        const nextActiveUrl = (serverRule.activeUrl as string) || localRule.activeUrl || nextPriorityChain?.[0]
                        const normNextActive = normalizeAddonUrl(nextActiveUrl || '')
                        const normLocalActive = normalizeAddonUrl(localRule.activeUrl || '')

                        if (nextActiveUrl && normNextActive !== normLocalActive) {
                            if (import.meta.env.DEV) console.log(`[Failover] Server-side swap detected: ${localRule.id} -> ${nextActiveUrl}`)
                        }

                        const normPrimary = normalizeAddonUrl(nextPriorityChain?.[0] || '')
                        updatedRules[ruleIndex] = {
                            ...localRule,
                            name: (serverRule.name as string) ?? localRule.name,
                            cooldown_ms: (serverRule.cooldownMs as number) ?? localRule.cooldown_ms,
                            priorityChain: nextPriorityChain,
                            activeUrl: nextActiveUrl,
                            isActive: serverRule.isActive !== undefined ? (serverRule.isActive as boolean) : localRule.isActive,
                            isAutomatic: serverRule.isAutomatic != null ? Boolean(serverRule.isAutomatic) : localRule.isAutomatic,
                            stabilization: (serverRule.stabilization as Record<string, number | AutopilotStabilizationEntry>) || localRule.stabilization,
                            lastCheck: serverRule.lastCheck ? new Date(serverRule.lastCheck as string | number) : localRule.lastCheck,
                            status: nextActiveUrl
                                ? (normNextActive === normPrimary ? 'monitoring' : 'failed-over')
                                : localRule.status
                        }
                        hasUpdates = true

                        if (await reconcileAccountAddonsWithActiveRule(updatedRules[ruleIndex])) {
                            hasUpdates = true
                        }
                    }
                }
            }

            if (hasUpdates) {
                set({ rules: updatedRules })
                await localforage.setItem(STORAGE_KEY, updatedRules)
            }
        } catch (e) {
            if (import.meta.env.DEV) console.warn('[Failover] pullServerState failed:', e)
        } finally {
            _isPulling = false
        }
    },

    setWebhook: async (url, enabled) => {
        if (import.meta.env.DEV) console.log(`[Failover] setWebhook called - Link length: ${url?.length || 0}, Enabled: ${enabled}`)

        const timestamp = Date.now()
        let configToStore: WebhookConfig = { url, enabled, updatedAt: timestamp }

        set({ webhook: { url, enabled, updatedAt: timestamp } })

        try {
            const sessionKey = await loadSessionKey()
            if (sessionKey && url) {
                const encryptedUrl = await encrypt(url, sessionKey)
                configToStore = { ...configToStore, url: encryptedUrl, isEncrypted: true }
                if (import.meta.env.DEV) console.log('[Failover] Webhook URL encrypted for storage.')
            }
        } catch (e) {
            if (import.meta.env.DEV) console.error('[Failover] Encryption failed during setWebhook:', e)
        }

        await localforage.setItem(STORAGE_KEY + ':webhook', configToStore)
        if (import.meta.env.DEV) console.log(`[Failover] Webhook persisted to localforage at ${new Date(timestamp).toISOString()}`)

        triggerSync()

        // Re-sync all rules using default webhook mode so the server gets the updated URL.
        // Rules in "default" mode have notifyEnabled=true and no custom webhookUrl.
        // Their webhook_url on the server was baked in at last-sync time and is now stale.
        const defaultModeRules = get().rules.filter(
            r => r.notifyEnabled !== false && !r.webhookUrl
        )
        syncRulesToServerBatch(defaultModeRules).catch(e => { if (import.meta.env.DEV) console.error(e) })
    },

    addRule: async (accountId, priorityChain, name, cooldown_ms, webhookUrl, notifyEnabled, messageTemplate, customCheckUrls) => {
        const safeChain = Array.isArray(priorityChain) ? priorityChain : []
        const safeCustomChecks = normalizeCustomChecks(customCheckUrls)
        const newRule: FailoverRule = {
            id: crypto.randomUUID(),
            accountId,
            name,
            priorityChain: safeChain,
            isActive: true,
            isAutomatic: true,
            status: 'idle',
            activeUrl: safeChain[0],
            cooldown_ms,
            webhookUrl: webhookUrl || '',
            notifyEnabled: notifyEnabled !== false,
            messageTemplate: messageTemplate || undefined,
            customCheckUrls: safeCustomChecks,
        }

        const rules = [...get().rules, newRule]
        set({ rules })
        await localforage.setItem(STORAGE_KEY, rules)
        const reconciled = await reconcileAccountAddonsWithActiveRule(newRule)
        if (!reconciled) await syncRuleToServer(newRule)
        triggerSync()
    },

    removeRule: async (ruleId) => {
        await trackDeletedRule(ruleId)
        const deletedOnServer = await deleteRuleFromServer(ruleId)
        if (!deletedOnServer) {
            await clearDeletedRuleId(ruleId)
            toast({
                title: 'Unable to delete Autopilot rule',
                description: 'Server deletion failed. The local rule was kept so it does not reappear on sync.',
                variant: 'destructive'
            })
            return
        }
        const rules = get().rules.filter(r => r.id !== ruleId)
        set({ rules })
        await localforage.setItem(STORAGE_KEY, rules)
        triggerSync()
    },

    updateRule: async (ruleId, updates) => {
        _pendingRuleUpdates.add(ruleId)
        const timeoutId = setTimeout(() => _pendingRuleUpdates.delete(ruleId), 10000)
        try {
            const rules = get().rules.map(r => r.id === ruleId ? { ...r, ...updates } : r)
            set({ rules })
            await localforage.setItem(STORAGE_KEY, rules)
            const rule = rules.find(r => r.id === ruleId)
            if (rule) {
                const reconciled = await reconcileAccountAddonsWithActiveRule(rule)
                if (!reconciled) await syncRuleToServer(rule)
            }
        } finally {
            clearTimeout(timeoutId)
            _pendingRuleUpdates.delete(ruleId)
        }
        triggerSync()
    },

    reorderRules: async (accountId, orderedRuleIds) => {
        const rules = get().rules
        const otherRules = rules.filter(r => r.accountId !== accountId)
        const accountRuleMap = new Map(
            rules.filter(r => r.accountId === accountId).map(r => [r.id, r as FailoverRule])
        )
        const reorderedAccountRules = orderedRuleIds
            .map(id => accountRuleMap.get(id))
            .filter((r): r is FailoverRule => r !== undefined)
        const newRules = [...otherRules, ...reorderedAccountRules]
        set({ rules: newRules })
        await localforage.setItem(STORAGE_KEY, newRules)
        triggerSync()
    },

    toggleRuleActive: async (ruleId, isActive) => {
        const rules = get().rules.map(r =>
            r.id === ruleId ? { ...r, isActive } : r
        )
        set({ rules })
        await localforage.setItem(STORAGE_KEY, rules)
        const rule = rules.find(r => r.id === ruleId)
        if (rule) {
            const reconciled = await reconcileAccountAddonsWithActiveRule(rule)
            if (!reconciled) await syncRuleToServer(rule)
        }
        triggerSync()
    },

    checkRules: async () => {
        if (get().isChecking) return
        set({ isChecking: true })
        try {
            if (useAuthStore.getState().isLocked) return
            const { rules } = get()
            const activeRules = rules.filter(r => r.isActive !== false)
            if (activeRules.length === 0) return

            await get().pullServerState()
        } catch (e) {
            if (import.meta.env.DEV) console.warn('[Failover] checkRules failed:', e)
        } finally {
            set({ isChecking: false })
        }
    },

    pulse: async () => {
        const { rules } = get()
        if (rules.length === 0 || _isPulling) return

        try {
            if (useAuthStore.getState().isLocked) return
            const { useSyncStore } = await import('@/store/syncStore')
            const { auth, serverUrl } = useSyncStore.getState()
            if (!auth.isAuthenticated) return

            const baseUrl = serverUrl || ''
            const apiPath = baseUrl.startsWith('http') ? `${baseUrl.replace(/\/$/, '')}/api` : '/api'
            const syncPassword = useSyncStore.getState().auth.password
            const { deriveSyncToken } = await import('@/lib/crypto')
            const syncToken = await deriveSyncToken(syncPassword)

            const resp = await resilientFetch(`${apiPath}/autopilot/pulse`, {
                headers: { 'x-sync-password': syncToken, 'x-sync-user': auth.id }
            })
            if (!resp.ok) return
            const data = await resp.json()
            const serverLastRun = data?.lastWorkerRun
            const lastCycle = parseAutopilotCycleStats(data?.lastCycle)

            if (lastCycle) set({ lastCycle })

            if (serverLastRun && serverLastRun !== _lastWorkerRun) {
                _lastWorkerRun = serverLastRun
                set({ lastWorkerRun: new Date(serverLastRun) })
                if (data?.activeRuleCount > 0) {
                    await get().pullServerState()
                }
            }
        } catch (e) {
            if (import.meta.env.DEV) console.warn('[Failover] pulse failed:', e)
        }
    },

    startAutomation: () => {
        if (automationInterval) return
        const state = get()
        _lastWorkerRun = 0
        _adaptiveIntervalMs = BASE_INTERVAL_MS
        _stableCheckCount = 0
        state.pulse()
        set({ isMonitoring: true })
        scheduleNextPoll()
    },

    stopAutomation: () => {
        if (automationInterval) {
            window.clearTimeout(automationInterval)
            automationInterval = null
        }
        set({ isMonitoring: false })
    },

    importRules: async (data: unknown, strategy: 'merge' | 'mirror' = 'merge', isSilent: boolean = false) => {
        if (!data) return
        let scavengedRules: FailoverRule[] = []
        let scavengedWebhook: WebhookConfig | null = null
        const d = data as Record<string, unknown>
        if (Array.isArray(data)) {
            scavengedRules = data as FailoverRule[]
        } else if (typeof data === 'object') {
            const failoverData = (d.failover || {}) as Record<string, unknown>
            if (Array.isArray(failoverData)) {
                scavengedRules = failoverData as FailoverRule[]
            } else if (failoverData.rules) {
                scavengedRules = failoverData.rules as FailoverRule[]
                if (failoverData.webhook) scavengedWebhook = failoverData.webhook as WebhookConfig
            }
            if (d['stremio-manager:failover-rules']) {
                scavengedRules = d['stremio-manager:failover-rules'] as FailoverRule[]
            }
            if (d['stremio-manager:failover-rules:webhook']) {
                scavengedWebhook = d['stremio-manager:failover-rules:webhook'] as WebhookConfig
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
                try {
                    const parsed = new URL(scavengedWebhook.url)
                    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Invalid scheme')
                    set({ webhook: scavengedWebhook })
                    await localforage.setItem(STORAGE_KEY + ':webhook', scavengedWebhook)
                } catch {
                    if (import.meta.env.DEV) console.warn('[Failover] Skipping invalid webhook URL from import:', scavengedWebhook.url)
                }
            }
        }
        const rulesToImport = scavengedRules
        const currentRules = [...get().rules]

        if (strategy === 'mirror') {
            // Anti-Wipe Guard: If remote has 0 rules but we have local rules, preserve local state.
            // This prevents cloud pull from wiping rules when the server has stale/empty data.
            if (rulesToImport.length === 0 && currentRules.length > 0) {
                if (import.meta.env.DEV) console.warn('[Failover] Anti-Wipe Triggered: Remote has 0 rules but local has ' + currentRules.length + '. Preserving local rules.')
                return
            }
            const finalRules: FailoverRule[] = []
            rulesToImport.forEach(newRule => {
                const migratedRule: FailoverRule = {
                    id: String(newRule.id || crypto.randomUUID()),
                    accountId: String(newRule.accountId || ''),
                    name: typeof newRule.name === 'string' ? newRule.name.slice(0, 200) : undefined,
                    priorityChain: Array.isArray(newRule.priorityChain) ? (newRule.priorityChain as unknown[]).filter((u: unknown) => typeof u === 'string').slice(0, 50) as string[] : [],
                    isActive: Boolean(newRule.isActive),
                    status: newRule.status || 'idle',
                    activeUrl: typeof newRule.activeUrl === 'string' ? newRule.activeUrl : undefined,
                    isAutomatic: newRule.isAutomatic != null ? Boolean(newRule.isAutomatic) : undefined,
                    stabilization: newRule.stabilization && typeof newRule.stabilization === 'object' ? newRule.stabilization as Record<string, number | AutopilotStabilizationEntry> : undefined,
                    cooldown_ms: typeof newRule.cooldown_ms === 'number' ? newRule.cooldown_ms : undefined,
                    webhookUrl: typeof newRule.webhookUrl === 'string' ? newRule.webhookUrl : undefined,
                    notifyEnabled: newRule.notifyEnabled != null ? Boolean(newRule.notifyEnabled) : undefined,
                    messageTemplate: typeof newRule.messageTemplate === 'string' ? newRule.messageTemplate.slice(0, 1000) : undefined,
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
            if (!isSilent) triggerSync()
            return
        }

        let updatedCount = 0
        let addedCount = 0
        rulesToImport.forEach(newRule => {
            const migratedRule: FailoverRule = {
                id: String(newRule.id || crypto.randomUUID()),
                accountId: String(newRule.accountId || ''),
                name: typeof newRule.name === 'string' ? newRule.name.slice(0, 200) : undefined,
                priorityChain: Array.isArray(newRule.priorityChain) ? (newRule.priorityChain as unknown[]).filter((u: unknown) => typeof u === 'string').slice(0, 50) as string[] : [],
                isActive: Boolean(newRule.isActive),
                status: newRule.status || 'idle',
                activeUrl: typeof newRule.activeUrl === 'string' ? newRule.activeUrl : undefined,
                isAutomatic: newRule.isAutomatic != null ? Boolean(newRule.isAutomatic) : undefined,
                stabilization: newRule.stabilization && typeof newRule.stabilization === 'object' ? newRule.stabilization as Record<string, number | AutopilotStabilizationEntry> : undefined,
                cooldown_ms: typeof newRule.cooldown_ms === 'number' ? newRule.cooldown_ms : undefined,
                webhookUrl: typeof newRule.webhookUrl === 'string' ? newRule.webhookUrl : undefined,
                notifyEnabled: newRule.notifyEnabled != null ? Boolean(newRule.notifyEnabled) : undefined,
                messageTemplate: typeof newRule.messageTemplate === 'string' ? newRule.messageTemplate.slice(0, 1000) : undefined,
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
        if (updatedCount > 0 || addedCount > 0) {
            set({ rules: currentRules })
            await localforage.setItem(STORAGE_KEY, currentRules)

            if (!isSilent) {
                await syncRulesToServerBatch(currentRules)
                triggerSync()
            }
        }
    },

    importWebhook: async (incoming, isSilent = false) => {
        if (!incoming) return
        const current = get().webhook
        const incomingTs = incoming.updatedAt || 0
        const currentTs = current.updatedAt || 0

        if (import.meta.env.DEV) console.log(`[Failover] importWebhook - Incoming TS: ${incomingTs}, Local TS: ${currentTs}, Incoming URL Length: ${incoming.url?.length || 0}`)

        if (incomingTs >= currentTs) {
            let processedWebhook = incoming

            if (incoming.isEncrypted && incoming.url) {
                try {
                    const sessionKey = await loadSessionKey()
                    if (sessionKey) {
                        const decryptedUrl = await decrypt(incoming.url, sessionKey)
                        if (decryptedUrl) {
                            processedWebhook = {
                                ...incoming,
                                url: decryptedUrl,
                                isEncrypted: false
                            }
                            if (import.meta.env.DEV) console.log('[Failover] Incoming webhook decrypted during import.')
                        } else {
                            if (import.meta.env.DEV) console.warn('[Failover] Incoming webhook decryption returned null. Skipping webhook update.')
                            return
                        }
                    } else {
                        if (import.meta.env.DEV) console.warn('[Failover] Incoming webhook is encrypted but no session key found.')
                    }
                } catch (e) {
                    if (import.meta.env.DEV) console.error('[Failover] Failed to decrypt incoming webhook:', e)
                    return
                }
            }

            if (import.meta.env.DEV) console.log(`[Failover] Updating webhook (Incoming: ${incomingTs}, Local: ${currentTs})`)
            set({ webhook: processedWebhook })

            let configToStore = processedWebhook
            try {
                const sessionKey = await loadSessionKey()
                if (sessionKey && processedWebhook.url && !processedWebhook.isEncrypted) {
                    const encryptedUrl = await encrypt(processedWebhook.url, sessionKey)
                    configToStore = { ...processedWebhook, url: encryptedUrl, isEncrypted: true }
                }
            } catch (e) {
                if (import.meta.env.DEV) console.error('[Failover] Re-encryption failed during importWebhook:', e)
            }

            await localforage.setItem(STORAGE_KEY + ':webhook', configToStore)

            if (!isSilent) {
                triggerSync()
            }
        } else {
            if (import.meta.env.DEV) console.log(`[Failover] Skipping stale webhook update (Incoming: ${incomingTs}, Local: ${currentTs})`)
        }
    },

    syncRulesForAccount: async (accountId: string) => {
        const rules = get().rules.filter(r => r.accountId === accountId)
        for (const rule of rules) {
            await syncRuleToServer(rule)
        }
        // reconcile server active set so stale rules from another profile get deactivated
        if (failoverHydrated) {
            await get().pruneServerRulesToActive(accountId, rules.map(r => r.id))
        }
    },

    removeUrlFromRules: async (accountId: string, url: string) => {
        const normUrl = normalizeAddonUrl(url)
        let hasChanges = false
        const updatedRules = get().rules.map(rule => {
            if (rule.accountId !== accountId) return rule
            const isMatching = rule.priorityChain.some(u => normalizeAddonUrl(u) === normUrl)
            if (!isMatching) return rule
            hasChanges = true
            const newChain = rule.priorityChain.filter(u => normalizeAddonUrl(u) !== normUrl)
            let newActiveUrl = rule.activeUrl
            if (normalizeAddonUrl(rule.activeUrl || '') === normUrl) {
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
            triggerSync()
        }
    },

    replaceUrlInRules: async (oldUrl: string, newUrl: string, accountId?: string) => {
        const normOld = normalizeAddonUrl(oldUrl)
        let hasChanges = false
        const updatedRules = get().rules.map(rule => {
            if (accountId && rule.accountId !== accountId) return rule

            const isMatching = rule.priorityChain.some(u => normalizeAddonUrl(u) === normOld)
            if (!isMatching) return rule
            hasChanges = true
            const newChain = rule.priorityChain.map(u =>
                normalizeAddonUrl(u) === normOld ? newUrl : u
            )
            let newActiveUrl = rule.activeUrl
            if (normalizeAddonUrl(rule.activeUrl || '') === normOld) {
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
                if (accountId && rule.accountId !== accountId) continue

                if (rule.priorityChain.includes(newUrl)) {
                    await syncRuleToServer(rule)
                }
            }
            triggerSync()
        }
    },

    toggleAllRulesForAccount: async (accountId, isActive) => {
        const prevRules = get().rules
        const rules = prevRules.map(r =>
            r.accountId === accountId ? { ...r, isActive } : r
        )
        set({ rules })
        await localforage.setItem(STORAGE_KEY, rules)

        try {
            const accountRules = rules.filter(rule => rule.accountId === accountId)
            await syncRulesToServerBatch(accountRules)
        } catch (err) {
            if (import.meta.env.DEV) console.error('[Autopilot] toggleAllRulesForAccount batch failed, reconciling:', err)
            const preHash = JSON.stringify(get().rules.map(r => `${r.id}:${r.isActive}`))
            await get().pullServerState()
            const serverRules = get().rules
            if (serverRules.length !== rules.length || JSON.stringify(serverRules.map(r => `${r.id}:${r.isActive}`)) !== preHash) {
                await localforage.setItem(STORAGE_KEY, serverRules)
            }
        }

        triggerSync()
    },

    toggleAllRulesForAccounts: async (isActive) => {
        const prevRules = get().rules
        const rules = prevRules.map(r => ({ ...r, isActive }))
        set({ rules })
        await localforage.setItem(STORAGE_KEY, rules)

        try {
            await syncRulesToServerBatch(rules)
        } catch (err) {
            if (import.meta.env.DEV) console.error('[Autopilot] toggleAllRulesForAccounts batch failed, reconciling:', err)
            const preHash = JSON.stringify(get().rules.map(r => `${r.id}:${r.isActive}`))
            await get().pullServerState()
            const serverRules = get().rules
            if (serverRules.length !== rules.length || JSON.stringify(serverRules.map(r => `${r.id}:${r.isActive}`)) !== preHash) {
                await localforage.setItem(STORAGE_KEY, serverRules)
            }
        }

        triggerSync()
    },

    mirrorRulesToAccounts: async (sourceAccountId, targetAccountIds) => {
        const accounts = useAccountStore.getState().accounts
        const sourceRules = get().rules.filter(r =>
            r.accountId === sourceAccountId &&
            !r.connectionId &&
            r.priorityChain.length > 0
        )
        if (sourceRules.length === 0) return { mirrored: 0, skipped: 0 }

        const chainKey = (chain: string[]) => JSON.stringify(chain.map(normalizeAddonUrl))
        const created: FailoverRule[] = []
        let skipped = 0

        for (const targetId of targetAccountIds) {
            if (targetId === sourceAccountId) continue
            const targetAccount = accounts.find(a => a.id === targetId)
            if (!targetAccount || !hasPlatformConnection(targetAccount)) { skipped += sourceRules.length; continue }

            const existingKeys = new Set(
                get().rules.filter(r => r.accountId === targetId).map(r => chainKey(r.priorityChain))
            )
            for (const rule of sourceRules) {
                const key = chainKey(rule.priorityChain)
                if (existingKeys.has(key)) { skipped++; continue }
                existingKeys.add(key)
                created.push({
                    id: crypto.randomUUID(),
                    accountId: targetId,
                    name: rule.name,
                    priorityChain: [...rule.priorityChain],
                    isActive: rule.isActive,
                    isAutomatic: rule.isAutomatic,
                    status: 'idle',
                    activeUrl: rule.priorityChain[0],
                    cooldown_ms: rule.cooldown_ms,
                    webhookUrl: rule.webhookUrl,
                    notifyEnabled: rule.notifyEnabled,
                    messageTemplate: rule.messageTemplate,
                    platform: rule.platform || 'stremio',
                })
            }
        }

        if (created.length === 0) return { mirrored: 0, skipped }

        const next = [...get().rules, ...created]
        set({ rules: next })
        await localforage.setItem(STORAGE_KEY, next)
        await syncRulesToServerBatch(created)
        triggerSync()
        return { mirrored: created.length, skipped }
    },

    deleteProfileRules: async (accountId: string, _profileId: string) => {
        const { useAccountStore } = await import('./accountStore')
        const account = useAccountStore.getState().accounts.find(a => a.id === accountId)
        if (account && !account.profiles?.length) {
            const remaining = get().rules.filter(r => r.accountId !== accountId)
            for (const rule of get().rules.filter(r => r.accountId === accountId)) {
                await deleteRuleFromServer(rule.id).catch(e => { if (import.meta.env.DEV) console.error('[Failover] Failed to delete server rule:', rule.id, e) })
                await trackDeletedRule(rule.id)
            }
            set({ rules: remaining })
            await localforage.setItem(STORAGE_KEY, remaining)

            triggerSync()
        }
    },

    awakenProfileRules: async (accountId: string, rules: FailoverRule[]) => {
        const existingRules = get().rules.filter(r => r.accountId === accountId)

        if (rules.length === 0) {
            if (existingRules.length > 0 && import.meta.env.DEV) {
                if (import.meta.env.DEV) console.warn(`[Autopilot] awakenProfileRules called with empty rules for ${accountId} - preserving existing ${existingRules.length} rules`)
            }
            return
        }

        for (const rule of existingRules) {
            await deleteRuleFromServer(rule.id)
        }

        const remainingRules = get().rules.filter(r => r.accountId !== accountId)
        const updatedRules = [...remainingRules, ...rules]

        set({ rules: updatedRules })
        await localforage.setItem(STORAGE_KEY, updatedRules)

        for (const rule of rules) {
            await syncRuleToServer(rule)
        }

        triggerSync()
    },

    pruneServerRulesToActive: async (accountId, activeRuleIds) => {
        try {
            const { useSyncStore } = await import('@/store/syncStore')
            const { auth, serverUrl } = useSyncStore.getState()
            if (!auth.isAuthenticated) return
            const baseUrl = serverUrl || ''
            const apiPath = baseUrl.startsWith('http') ? `${baseUrl.replace(/\/$/, '')}/api` : '/api'
            const { deriveSyncToken } = await import('@/lib/crypto')
            const syncToken = await deriveSyncToken(auth.password)
            await resilientFetch(`${apiPath}/autopilot/active-rules`, {
                method: 'POST',
                retries: 0,
                headers: { 'Content-Type': 'application/json', 'x-sync-password': syncToken, 'x-sync-user': auth.id },
                body: JSON.stringify({ accountId, activeRuleIds }),
            })
        } catch (err) {
            if (import.meta.env.DEV) console.error('[Autopilot] pruneServerRulesToActive failed:', err)
        }
    },

    reset: async () => {
        get().stopAutomation()
        set({ rules: [], webhook: { url: '', enabled: false, updatedAt: 0 }, isMonitoring: false, lastWorkerRun: undefined, lastCycle: undefined })
        // Defensive: timer is a setTimeout handle, so clearTimeout (not clearInterval).
        if (automationInterval) {
            clearTimeout(automationInterval)
            automationInterval = null
        }
        await Promise.all([
            localforage.removeItem(STORAGE_KEY),
            localforage.removeItem(STORAGE_KEY + ':webhook')
        ])
    },
}))
