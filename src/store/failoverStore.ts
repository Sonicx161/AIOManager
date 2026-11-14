import { passesRestoreGate, trackMissingSince, type CloudRuleSnapshot } from '@/lib/autopilot-restore-gate'
import { triggerSync } from '@/lib/sync-trigger'
import { mapConcurrent } from '@/lib/concurrency'
import {
    RESTORE_RATE_LIMIT_MESSAGE, createRestoreSession, liveAccountCheck, pickAutoRestore, readRuleBatchResponse, readRuleError, readSafeMode, readWorkerEnabledFlag, restoredToastCopy, rulesMissingOnServer, runAutoRestore,
    type AutopilotRuleError, type AutopilotSafeMode, type AutopilotSkipReason, type RuleBatchOutcome,
} from '@/lib/autopilot-freshness'
import { createPollCadence, isStatePullDue } from '@/lib/autopilot-poll'
import { didActiveTierChange, rebuildRuleFromServerState, stripUndefinedRuleFields } from '@/lib/failover-state-mapping'
import { create } from 'zustand'
import localforage from 'localforage'
import { useAccountStore, getCachedAuthKey, getStremioAuthKey } from '@/store/accountStore'
import { decrypt, encrypt, loadSessionKey } from '@/lib/crypto'
import { normalizeAddonUrl } from '@/lib/utils'
import { findScopedChecksAtRisk } from '@/lib/failover-scope'
import { resilientFetch } from '@/lib/api-resilience'
import { useAuthStore } from '@/store/authStore'
import { toast } from '@/hooks/use-toast'
import { resolveRuleSyncTarget, serverRuleBinding } from '@/lib/autopilot-binding'
import { captureSyncOwnership, type SyncOwnership } from './sync-store-helpers'
import { findRuleOverlaps, getRuleMissingConnection } from '@/lib/autopilot-conflicts'
import { reuseUnchanged } from '@/lib/reuse-unchanged'

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
    missingConnectionId?: string
    skipReason?: AutopilotSkipReason | null
    lastError?: AutopilotRuleError | null
    createdAt?: number
}

export interface RestoreIssue {
    message: string
    retryAt: number | null
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
    safeMode?: AutopilotSafeMode | null
    statePullFailed: boolean // Last server state pull could not be reached at all (network error or no response); local lastCheck is unverified
    statePullPartial: boolean // Server answered but only some rule states arrived; claims nothing about reachability
    pulseUnreachable: boolean // Last automatic pulse could not complete a check; independent evidence the server is unreachable
    workerEnabled: boolean // Global pulse flag: the server operator turned Autopilot checks off (AUTOPILOT_WORKER); true until a pulse says otherwise
    sessionGeneration: number // Bumped on reset: pulls started before it must not publish into the new session
    lastCompletePullAt: number // Session-scoped: when the last complete states pull was published (0 = none yet)
    restoreIssues: Record<string, RestoreIssue>

    initialize: () => Promise<void>
    syncServerState: () => Promise<void>
    setWebhook: (url: string, enabled: boolean) => Promise<void>
    addRule: (accountId: string, priorityChain: string[], name?: string, cooldown_ms?: number, webhookUrl?: string, notifyEnabled?: boolean, messageTemplate?: string, customCheckUrls?: CustomCheckEntry[]) => Promise<void>
    updateRule: (ruleId: string, updates: Partial<FailoverRule>) => Promise<void>
    removeRule: (ruleId: string, opts?: { strict?: boolean }) => Promise<boolean>
    pauseRule: (ruleId: string) => Promise<void>
    /** Retires the local rules bound to a removed connection; returns how many went. */
    removeConnectionRules: (accountId: string, connectionId: string) => Promise<number>
    retryRuleConflict: (ruleId: string) => Promise<void>
    reorderRules: (accountId: string, orderedRuleIds: string[]) => Promise<void>
    toggleRuleActive: (ruleId: string, isActive: boolean) => Promise<void>
    checkRules: () => Promise<void>
    pullServerState: (opts?: { skipRuleSync?: boolean }) => Promise<void>
    pulse: () => Promise<void>
    testRule: (ruleId: string) => Promise<{ primary: unknown, backup: unknown }>
    startAutomation: () => void
    stopAutomation: () => void
    importRules: (data: unknown, strategy?: 'merge' | 'mirror', isSilent?: boolean, ownership?: SyncOwnership) => Promise<void>
    importWebhook: (config: WebhookConfig, isSilent?: boolean, ownership?: SyncOwnership) => Promise<void>
    syncRulesForAccount: (accountId: string) => Promise<void>
    removeUrlFromRules: (accountId: string, url: string) => Promise<void>
    replaceUrlInRules: (oldUrl: string, newUrl: string, accountId?: string) => Promise<void>
    toggleAllRulesForAccount: (accountId: string, isActive: boolean) => Promise<void>
    toggleAllRulesForAccounts: (isActive: boolean) => Promise<void>
    mirrorRulesToAccounts: (sourceAccountId: string, targetAccountIds: string[]) => Promise<{ mirrored: number; skipped: number }>
    deleteProfileRules: (accountId: string, profileId: string) => Promise<void>
    awakenProfileRules: (accountId: string, rules: FailoverRule[]) => Promise<void>
    pruneServerRulesToActive: (accountId: string, activeRuleIds: string[]) => Promise<void>
    restoreRuleOnServer: (ruleId: string, opts?: { quiet?: boolean }) => Promise<boolean>
    autoRestoreMissingRules: () => Promise<void>
    reset: () => Promise<void>
}

let automationInterval: number | null = null
let _lastWorkerRun: number = 0
let _isPulling = false
let _lastStatePullAt = 0
let _lastCompletePullAt = 0
// Server-reported rule-state version from the last pulse (null until a server sends one).
let _lastStateVersion: string | null = null
// Only the most recently started pulse may write reachability, so a slow pulse cannot
// overwrite a newer one's fresher evidence. Held in an object so test extractions can share it.
const _pulseSeq = { next: 0 }
const _cadence = createPollCadence()
const _pendingRuleUpdates = new Set<string>()
// Local edit counter per rule: a state pull never publishes over a rule edited after it started.
const _ruleEditSeq = new Map<string, number>()
const markRuleEdited = (ruleId: string) => _ruleEditSeq.set(ruleId, (_ruleEditSeq.get(ruleId) ?? 0) + 1)
// Session-scoped: one automatic restore per rule, with backoff, and a 429 stops all restores until the server's retry time.
let _restoreSession = createRestoreSession()
let _restoreRateLimitedUntil = 0
// Zero-rule users still learn the global worker flag (read-only pulse), but
// never on an interval: one read at init or UI mount, then only when focus
// returns past this quiet window.
const WORKER_FLAG_QUIET_MS = 300_000
let _lastFlagReadAt = 0
let _autoRestoreRunning = false
const _missingSince = new Map<string, number>()
let _cloudRules: CloudRuleSnapshot | null = null
// The server caps this endpoint at 500 account ids per request. Public hosts
// commonly exceed that, so state pulls must be chunked instead of failing the
// entire refresh with a 400 and leaving every local rule stale.
const AUTOPILOT_STATE_BATCH_SIZE = 500

const readSkipReason = (serverRule: Record<string, unknown>): AutopilotSkipReason | null =>
    serverRule.skipReason === 'no_valid_chain' || serverRule.skipReason === 'no_credentials'
        ? serverRule.skipReason
        : null

const fetchAutopilotStates = async (
    apiPath: string,
    auth: { id: string; password: string },
    accountIds: string[],
) => {
    const { getSyncPasswordHeader } = await import('@/lib/sync-auth')
    const syncToken = await getSyncPasswordHeader(auth)
    const states: Record<string, Record<string, unknown>[]> = {}
    let lastWorkerRun: string | undefined
    let lastCycle: Record<string, unknown> | undefined
    let succeeded = 0
    let failed = 0
    let serverPartial = false

    for (let offset = 0; offset < accountIds.length; offset += AUTOPILOT_STATE_BATCH_SIZE) {
        const batch = accountIds.slice(offset, offset + AUTOPILOT_STATE_BATCH_SIZE)
        const resp = await resilientFetch(`${apiPath}/autopilot/states`, {
            method: 'POST',
            retries: 1,
            headers: {
                'Content-Type': 'application/json',
                'x-sync-password': syncToken,
                'x-sync-user': auth.id,
            },
            body: JSON.stringify({ accountIds: batch }),
        })
        if (!resp.ok) {
            failed++
            if (import.meta.env?.DEV) console.warn(`[Failover] autopilot state batch failed: ${resp.status} ${resp.statusText}`)
            continue
        }
        const data = (await resp.json()) as Record<string, unknown>
        const batchStates = (data.states || {}) as Record<string, Record<string, unknown>[]>
        for (const [accountId, accountRules] of Object.entries(batchStates)) {
            states[accountId] = accountRules
        }
        if (typeof data.lastWorkerRun === 'string') lastWorkerRun = data.lastWorkerRun
        if (data.lastCycle && typeof data.lastCycle === 'object') lastCycle = data.lastCycle as Record<string, unknown>
        serverPartial = serverPartial || Boolean(data.partial)
        succeeded++
    }

    if (succeeded === 0 && accountIds.length > 0) {
        _cadence.reset()
        throw new Error(`All ${failed || 1} autopilot state batches failed`)
    }
    return { states, lastWorkerRun, lastCycle, partial: serverPartial || failed > 0 }
}

type AddonEnabledSnapshot = {
    transportUrl: string
    flags?: { enabled?: boolean }
}

// URL-normalizer memo shared across a reconcile pass: chain lookups otherwise
// re-normalize the same addon transport URLs once per link per rule.
type UrlNormalizer = (url: string) => string

const memoizedAddonUrlNormalizer = (memo: Map<string, string>): UrlNormalizer => url => {
    const hit = memo.get(url)
    if (hit !== undefined) return hit
    const normalized = normalizeAddonUrl(url)
    memo.set(url, normalized)
    return normalized
}

const findAddonByNormalizedUrl = (addons: AddonEnabledSnapshot[] | undefined, normalizedUrl: string, norm: UrlNormalizer = normalizeAddonUrl) =>
    addons?.find(addon => norm(addon.transportUrl) === normalizedUrl)

const hasEnabledMismatch = (addons: AddonEnabledSnapshot[] | undefined, normalizedUrl: string, shouldBeEnabled: boolean, norm?: UrlNormalizer) => {
    const addon = findAddonByNormalizedUrl(addons, normalizedUrl, norm)
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

// localOnly (consumer mode): flip the local flags without pushing the local list back
// to the platform/connections (toggleAddonEnabled runs silent — no backgroundSync, no
// pushToConnections). Used whenever the source of truth is the server's enforced rule
// state: the engine already enforced it on the platform, so pushing our copy is at best
// redundant and at worst re-clobbers managed chains with an intermediate state.
// Manual user actions (addRule/updateRule/toggleRuleActive) omit it so intentional
// edits still propagate.
const reconcileAccountAddonsWithActiveRule = async (rule: FailoverRule, opts?: { localOnly?: boolean; urlMemo?: Map<string, string>; skipRuleSync?: boolean }) => {
    if (!rule.isActive || !rule.priorityChain.length) return false

    const account = useAccountStore.getState().accounts.find(a => a.id === rule.accountId)
    if (!account) return false
    if (getRuleMissingConnection(rule, account) || rule.lastError?.code === 'contested_by_other_writer') return false
    const norm = memoizedAddonUrlNormalizer(opts?.urlMemo ?? new Map())
    const overlaps = new Set(findRuleOverlaps(rule, useFailoverStore.getState().rules, account.addons).map(overlap => norm(overlap.url)))

    const activeUrl = rule.activeUrl || rule.priorityChain[0]
    const normActive = norm(activeUrl)
    if (overlaps.has(normActive)) return false
    const activeProfile = account.activeProfileId
        ? account.profiles?.find(profile => profile.id === account.activeProfileId)
        : undefined

    let reconciled = false
    let activeAddonMissing = false

    for (const url of rule.priorityChain) {
        const normUrl = norm(url)
        if (overlaps.has(normUrl)) continue
        const shouldBeEnabled = normUrl === normActive
        const accountAddon = findAddonByNormalizedUrl(account.addons, normUrl, norm)
        const profileMissingActive = !!activeProfile && shouldBeEnabled && !findAddonByNormalizedUrl(activeProfile.addons, normUrl, norm)

        if (!accountAddon) {
            if (shouldBeEnabled) activeAddonMissing = true
            continue
        }

        const accountMismatch = hasEnabledMismatch(account.addons, normUrl, shouldBeEnabled, norm)
        const profileMismatch = !!activeProfile && (
            profileMissingActive ||
            hasEnabledMismatch(activeProfile.addons, normUrl, shouldBeEnabled, norm)
        )

        if (!accountMismatch && !profileMismatch) continue

        await useAccountStore.getState().toggleAddonEnabled(
            rule.accountId,
            url,
            shouldBeEnabled,
            opts?.localOnly === true,
            undefined,
            true
        )
        reconciled = true
    }

    if (activeAddonMissing) {
        await useAccountStore.getState().syncAccount(rule.accountId, false)
        reconciled = true
    }

    if (reconciled && !opts?.skipRuleSync) {
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

        _cadence.recordCycle(switched)

        scheduleNextPoll()
    }, _cadence.intervalMs())
}

// A new, edited or re-enabled rule must not wait out a backed-off poll for its first check.
const resetPollCadence = () => {
    _cadence.reset()
    if (automationInterval && useFailoverStore.getState().isMonitoring) scheduleNextPoll()
}

// Tab-focus convergence: the poll loop skips hidden tabs by design, so a server-enforced
// swap that lands while hidden would otherwise wait out the adaptive backoff (up to 10
// min) after the tab regains focus. On visible, poke the existing loop once: pulse()
// only pulls states when the worker heartbeat advanced, and its own guards (_isPulling,
// vault lock, auth, and the zero-rule flag quiet window) prevent fighting an in-flight
// sync. Event edge, not a new timer.
let focusPulseRegistered = false
const handleFocusPulse = () => {
    if (document.visibilityState !== 'visible') return
    const state = useFailoverStore.getState()
    if (!state.isMonitoring) return
    void state.pulse()
}
const registerFocusPulse = () => {
    if (focusPulseRegistered || typeof document === 'undefined') return
    document.addEventListener('visibilitychange', handleFocusPulse)
    focusPulseRegistered = true
}
const unregisterFocusPulse = () => {
    if (!focusPulseRegistered || typeof document === 'undefined') return
    document.removeEventListener('visibilitychange', handleFocusPulse)
    focusPulseRegistered = false
}

// One wire shape for both rule-save paths. notifyEnabled travels beside webhookUrl so the
// server can store "notifications off" for this rule; webhookUrl alone cannot express it
// ('' already means "use the global webhook"). connectionGeneration carries the bound
// connection's incarnation token so the server stamps it on the rule row.
function ruleSyncPayload(rule: FailoverRule, ctx: { authKey: string, connectionId?: string, connectionGeneration?: string, credentialType?: string, platform?: string, addonList: unknown[] }) {
    return {
        id: rule.id,
        accountId: rule.accountId,
        name: rule.name,
        authKey: ctx.authKey,
        connectionId: ctx.connectionId,
        ...(ctx.connectionGeneration ? { connectionGeneration: ctx.connectionGeneration } : {}),
        credentialType: ctx.credentialType,
        platform: ctx.platform,
        priorityChain: rule.priorityChain,
        activeUrl: rule.activeUrl || rule.priorityChain?.[0],
        is_active: rule.isActive ? 1 : 0,
        is_automatic: rule.isAutomatic !== false ? 1 : 0,
        addonList: ctx.addonList,
        webhookUrl: rule.notifyEnabled === false ? '' : (rule.webhookUrl || ''),
        notifyEnabled: rule.notifyEnabled !== false,
        cooldown_ms: rule.cooldown_ms,
        messageTemplate: rule.messageTemplate || null,
        customCheckUrls: normalizeCustomChecks(rule.customCheckUrls),
    }
}

// Server bodies are owner-scoped text (addon and rule labels). Read defensively and
// never echo transport URLs back into the UI.
const readAutopilotServerError = async (resp: Response): Promise<string> => {
    let body: unknown = null
    try { body = await resp.json() } catch { /* 499 and other empty bodies */ }
    if (body && typeof body === 'object') {
        const record = body as Record<string, unknown>
        const text = typeof record.message === 'string' ? record.message.trim() : typeof record.error === 'string' ? record.error.trim() : ''
        if (text && text.length <= 240 && !/[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text
    }
    return `Autopilot request failed (status ${resp.status}).`
}

// strict (explicit editor saves and removal flows): failures throw with a safe message
// instead of being logged. Background and restore paths keep the silent swallow, so
// automatic and import restore behavior is unchanged.
const syncRuleToServer = async (rule: FailoverRule, opts?: { strict?: boolean }): Promise<'synced' | 'local-only'> => {
    const strict = opts?.strict === true
    try {
        const { useSyncStore } = await import('@/store/syncStore')
        const { auth, serverUrl } = useSyncStore.getState()
        if (!auth.isAuthenticated) return 'local-only'

        const account = useAccountStore.getState().accounts.find(a => a.id === rule.accountId)
        if (!account) return 'local-only'

        const sessionKey = await loadSessionKey()
        if (!sessionKey) throw new Error('Encryption key not found')

        let authKey = ''
        const stremioKey = rule.connectionId ? '' : getStremioAuthKey(account)
        if (stremioKey) {
            try { authKey = await getCachedAuthKey(stremioKey, sessionKey) } catch { authKey = '' }
        }
        const target = resolveRuleSyncTarget(rule, account, !!authKey)
        if (!target) throw new Error(NO_SERVER_SIGN_IN)
        const { connectionId, connectionGeneration, credentialType, platform } = target
        const baseUrl = serverUrl || ''
        const apiPath = baseUrl.startsWith('http') ? `${baseUrl.replace(/\/$/, '')}/api` : '/api'

        const addonList = account.addons || []
        const { getSyncPasswordHeader } = await import('@/lib/sync-auth')
        const syncToken = await getSyncPasswordHeader(auth)
        if ((await accountsAwaitingRestore(apiPath, syncToken, auth.id)).has(rule.accountId)) throw new Error(RESTORE_PENDING)

        const resp = await resilientFetch(`${apiPath}/autopilot/sync`, {
            method: 'POST',
            retries: 0,
            headers: {
                'Content-Type': 'application/json',
                'x-sync-password': syncToken,
                'x-sync-user': auth.id
            },
            body: JSON.stringify(ruleSyncPayload(rule, { authKey, connectionId, connectionGeneration, credentialType, platform, addonList }))
        })
        // A 409 chain_overlap body carries the user-facing message; any other status gets
        // the bounded generic one.
        if (!resp.ok) throw new Error(await readAutopilotServerError(resp))
        if (import.meta.env.DEV) console.log(`[Autopilot] Rule ${rule.id} synced to server (Live Mode).`)
        return 'synced'
    } catch (err) {
        if (strict) {
            // resilientFetch embeds the endpoint URL in network errors; never surface it.
            const raw = err instanceof Error ? err.message : ''
            throw new Error(raw.includes('Failed to fetch')
                ? 'Could not reach the server. Check your connection and try again.'
                : (raw || 'The rule could not be saved.'))
        }
        if (import.meta.env.DEV) console.error('[Autopilot] Server sync failed:', err)
        return 'local-only'
    }
}

const NO_SERVER_SIGN_IN = 'This account has no sign-in the server can use. Reconnect it, then try again.'
const RESTORE_PENDING = 'This account is still being restored on the server. Try again shortly.'

// Rules of a restored account are refused until its server-side deletion guard is lifted,
// so queued lifts are retried first and those accounts' rules wait.
async function accountsAwaitingRestore(apiPath: string, syncToken: string, syncUser: string): Promise<Set<string>> {
    const { drainPendingAccountTombstoneLifts } = await import('@/lib/account-server-cleanup')
    return new Set(await drainPendingAccountTombstoneLifts((path, init) => fetch(`${apiPath}${path}`, { ...init, headers: { 'x-sync-password': syncToken, 'x-sync-user': syncUser } })))
}

const syncRulesToServerBatch = async (rules: FailoverRule[]): Promise<RuleBatchOutcome> => {
    const outcome: RuleBatchOutcome = { restored: [], failed: {}, rateLimited: null }
    if (rules.length === 0) return outcome
    const failAll = (message: string) => ({ ...outcome, failed: Object.fromEntries(rules.map(r => [r.id, message])) })
    try {
        const { useSyncStore } = await import('@/store/syncStore')
        const { auth, serverUrl } = useSyncStore.getState()
        if (!auth.isAuthenticated) return failAll('Sign in to your AIOManager cloud account, then try again.')

        const sessionKey = await loadSessionKey()
        if (!sessionKey) throw new Error('Encryption key not found')

        const { getSyncPasswordHeader } = await import('@/lib/sync-auth')
        const syncToken = await getSyncPasswordHeader(auth)

        const baseUrl = serverUrl || ''
        const apiPath = baseUrl.startsWith('http') ? `${baseUrl.replace(/\/$/, '')}/api` : '/api'

        const awaitingRestore = await accountsAwaitingRestore(apiPath, syncToken, auth.id)
        const payload = []
        for (const rule of rules) {
            const account = useAccountStore.getState().accounts.find(a => a.id === rule.accountId)
            if (!account || awaitingRestore.has(rule.accountId)) continue
            let authKey = ''
            const stremioKey = rule.connectionId ? '' : getStremioAuthKey(account)
            if (stremioKey) {
                try { authKey = await getCachedAuthKey(stremioKey, sessionKey) } catch { authKey = '' }
            }
            const target = resolveRuleSyncTarget(rule, account, !!authKey)
            if (!target) continue
            const { connectionId, connectionGeneration, credentialType, platform } = target
            const addonList = account.addons || []
            payload.push(ruleSyncPayload(rule, { authKey, connectionId, connectionGeneration, credentialType, platform, addonList }))
        }

        const sentIds = payload.map(p => p.id)
        const unsent = Object.fromEntries(rules.filter(r => !sentIds.includes(r.id)).map(r => [r.id, awaitingRestore.has(r.accountId) ? RESTORE_PENDING : NO_SERVER_SIGN_IN]))
        if (payload.length === 0) return { ...outcome, failed: unsent }

        const resp = await resilientFetch(`${apiPath}/autopilot/sync-batch`, {
            method: 'POST',
            retries: 0,
            headers: {
                'Content-Type': 'application/json',
                'x-sync-password': syncToken,
                'x-sync-user': auth.id
            },
            body: JSON.stringify(payload)
        })
        const body = await resp.json().catch(() => null)
        const result = readRuleBatchResponse(resp.status, body, sentIds)
        if (import.meta.env.DEV) console.log(`[Autopilot] Batch synced ${result.restored.length} of ${payload.length} rules to server.`)
        return { ...result, failed: { ...unsent, ...result.failed } }
    } catch (err) {
        if (import.meta.env.DEV) console.error('[Autopilot] Batch server sync failed:', err)
        return failAll(err instanceof Error && err.message ? err.message : 'The server could not be reached.')
    }
}

// The global webhook lives server-side (owner-scoped, encrypted); the engine resolves
// it at notification time for rules saved with "Use global webhook" (empty webhookUrl).
const pushGlobalWebhookToServer = async (url: string) => {
    try {
        const { useSyncStore } = await import('@/store/syncStore')
        const { auth, serverUrl } = useSyncStore.getState()
        if (!auth.isAuthenticated) return

        const { getSyncPasswordHeader } = await import('@/lib/sync-auth')
        const syncToken = await getSyncPasswordHeader(auth)
        const baseUrl = serverUrl || ''
        const apiPath = baseUrl.startsWith('http') ? `${baseUrl.replace(/\/$/, '')}/api` : '/api'

        const resp = await resilientFetch(`${apiPath}/autopilot/global-webhook`, {
            method: 'PUT',
            retries: 0,
            headers: {
                'Content-Type': 'application/json',
                'x-sync-password': syncToken,
                'x-sync-user': auth.id
            },
            body: JSON.stringify({ webhookUrl: url })
        })
        // Silent drop = UI shows Active while notifications never fire - say so.
        if (resp && !resp.ok) {
            toast({ title: 'Global webhook not saved', description: `Server rejected the webhook (status ${resp.status}). Notifications for rules using it will not fire.`, variant: 'destructive' })
        }
    } catch (err) {
        if (import.meta.env.DEV) console.error('[Autopilot] Global webhook server sync failed:', err)
        toast({ title: 'Global webhook not saved', description: 'Could not reach the server. Notifications for rules using it will not fire.', variant: 'destructive' })
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

const SCOPE_BACKUP_KEY = 'aioman:failover-scope-backups'
const SCOPE_DECISIONS_KEY = 'aioman:failover-scope-decisions'
const SCOPE_BACKUP_MAX_RULES = 200

export interface FailoverScopeBackup {
    checks: CustomCheckEntry[]
    savedAt: number
}

export const readScopeBackups = async (): Promise<Record<string, FailoverScopeBackup>> => {
    try {
        const raw = await localforage.getItem<Record<string, FailoverScopeBackup>>(SCOPE_BACKUP_KEY)
        return raw && typeof raw === 'object' ? raw : {}
    } catch { return {} }
}

const writeScopeBackup = async (ruleId: string, checks: CustomCheckEntry[]) => {
    try {
        const backups = await readScopeBackups()
        const existing = backups[ruleId]
        if (existing && checks.every(c => existing.checks.some(b => b.url === c.url))) return
        const merged = existing
            ? existing.checks.filter(c => !checks.some(n => n.url === c.url)).concat(checks)
            : checks
        const next: Record<string, FailoverScopeBackup> = { ...backups, [ruleId]: { checks: merged.slice(0, 5), savedAt: Date.now() } }
        const ruleIds = Object.keys(next)
        if (ruleIds.length > SCOPE_BACKUP_MAX_RULES) {
            for (const id of ruleIds.slice(0, ruleIds.length - SCOPE_BACKUP_MAX_RULES)) delete next[id]
        }
        await localforage.setItem(SCOPE_BACKUP_KEY, next)
    } catch (e) { if (import.meta.env.DEV) console.error(e) }
}

export const clearScopeBackup = async (ruleId: string) => {
    try {
        const backups = await readScopeBackups()
        if (backups[ruleId]) {
            delete backups[ruleId]
            await localforage.setItem(SCOPE_BACKUP_KEY, backups)
        }
    } catch (e) { if (import.meta.env.DEV) console.error(e) }
}

export const readScopeDecisions = async (): Promise<string[]> => {
    try {
        return (await localforage.getItem<string[]>(SCOPE_DECISIONS_KEY)) || []
    } catch { return [] }
}

export const recordScopeDecision = async (ruleId: string) => {
    try {
        const decided = await readScopeDecisions()
        if (!decided.includes(ruleId)) await localforage.setItem(SCOPE_DECISIONS_KEY, [...decided, ruleId])
    } catch (e) { if (import.meta.env.DEV) console.error(e) }
}

// Invariant: snapshot-only — the merge below must proceed unaltered (background syncs never block).
const preserveScopedChecksAtRisk = (localRule: FailoverRule, incomingChecks: CustomCheckEntry[] | undefined) => {
    const atRisk = findScopedChecksAtRisk(localRule.customCheckUrls, incomingChecks)
    if (atRisk.length > 0) void writeScopeBackup(localRule.id, atRisk)
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

        const { getSyncPasswordHeader } = await import('@/lib/sync-auth')
        const syncToken = await getSyncPasswordHeader(auth)

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
    safeMode: null,
    statePullFailed: false,
    statePullPartial: false,
    pulseUnreachable: false,
    workerEnabled: true,
    sessionGeneration: 0,
    lastCompletePullAt: 0,
    restoreIssues: {},

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

            // Only prune once the account list has loaded; before then every rule looks orphaned.
            // The prune is local: removing an account already deletes its rules on the server,
            // and a delete from here would stop the server checking rules that are still in use.
            const accountState = useAccountStore.getState()
            if (accountState.hydrated) {
                const currentAccountIds = new Set(accountState.accounts.map(a => a.id))
                const validRules = rules.filter(r => currentAccountIds.has(r.accountId))
                if (validRules.length !== rules.length) {
                    if (import.meta.env.DEV) console.log(`[Failover] Pruning ${rules.length - validRules.length} orphan rules locally.`)
                    set({ rules: validRules })
                    await localforage.setItem(STORAGE_KEY, validRules)
                }
            }

            failoverHydrated = true
            if (get().rules.some(r => !r.connectionId)) await get().pullServerState({ skipRuleSync: true })

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
        let fetched = false
        let pullPartial = false
        const sessionAtStart = get().sessionGeneration
        const urlMemo = new Map<string, string>()

        try {
            const { serverUrl } = (await import('@/store/syncStore')).useSyncStore.getState()
            const accountIds = useAccountStore.getState().accounts.map(a => a.id)
            const baseUrl = serverUrl || ''
            const apiPath = baseUrl.startsWith('http') ? `${baseUrl.replace(/\/$/, '')}/api` : '/api'

            const respData = await fetchAutopilotStates(apiPath, auth, accountIds)
            fetched = true
            pullPartial = Boolean(respData.partial)
            _lastStatePullAt = Date.now()
            set({ statePullFailed: false, statePullPartial: pullPartial })
            {
                const batchedStates = respData.states
                const serverHeartbeat = respData.lastWorkerRun
                const lastCycle = parseAutopilotCycleStats(respData.lastCycle)
                const isPartialState = respData.partial
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

                        const binding = serverRuleBinding(sr, useAccountStore.getState().accounts.find(a => a.id === accountId))
                        const processedRule = { ...rebuildRuleFromServerState(sr, accountId), ...(binding || {}) }

                        let mergedRule: FailoverRule
                        if (existsIndex !== -1) {
                            preserveScopedChecksAtRisk(rules[existsIndex], processedRule.customCheckUrls)
                            const candidate: FailoverRule = { ...rules[existsIndex], ...processedRule, skipReason: readSkipReason(sr), lastError: readRuleError(sr.lastError) }
                            // Reuse the local object when nothing changed: an
                            // observing-nothing pull rewrites no rule identities.
                            mergedRule = reuseUnchanged(rules[existsIndex], candidate)
                            rules[existsIndex] = mergedRule
                        } else {
                            mergedRule = { ...processedRule, skipReason: readSkipReason(sr), lastError: readRuleError(sr.lastError) }
                            rules.push(mergedRule)
                        }
                        processedRules.push(mergedRule)
                    }

                    const reconcileResults = await mapConcurrent(processedRules, 3, (rule) => reconcileAccountAddonsWithActiveRule(rule, { localOnly: true, urlMemo }))
                    if (reconcileResults.some(Boolean)) {
                        needsSync = true
                    }
                }
            }
        } catch (e) {
            if (!fetched) set({ statePullFailed: true })
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

        // Publish and persist only into the session the pull started in, and
        // only when a rule object actually changed, was added, filtered out, or
        // deleted: an observing-nothing pull writes nothing (zero per-cycle
        // Autopilot writes), and a pull finishing after logout or a workspace
        // switch must not resurrect the old session's rules.
        const currentRules = get().rules
        const rulesChanged = rules.length !== currentRules.length
            || rules.some((r, i) => r !== currentRules[i])
        if (rulesChanged && get().sessionGeneration === sessionAtStart) {
            set({ rules })
            await localforage.setItem(STORAGE_KEY, rules)
        }
        if (!pullPartial && get().sessionGeneration === sessionAtStart) {
            _lastCompletePullAt = Date.now()
            set({ lastCompletePullAt: _lastCompletePullAt })
        }
        } finally { _isPulling = false }
    },

    pullServerState: async (opts) => {
        const { rules } = get()
        if (rules.length === 0 || _isPulling) return
        const editsAtStart = new Map(_ruleEditSeq)
        const pendingAtStart = new Set(_pendingRuleUpdates)

        _isPulling = true
        let fetched = false
        let missingFound = false
        const sessionAtStart = get().sessionGeneration
        try {
            if (useAuthStore.getState().isLocked) return

            const { useSyncStore } = await import('@/store/syncStore')
            const { auth, serverUrl } = useSyncStore.getState()
            if (!auth.isAuthenticated) return

            const accountIds = [...new Set(rules.map(r => r.accountId))]
            const baseUrl = serverUrl || ''
            const apiPath = baseUrl.startsWith('http') ? `${baseUrl.replace(/\/$/, '')}/api` : '/api'
            const respData = await fetchAutopilotStates(apiPath, auth, accountIds)
            fetched = true
            _lastStatePullAt = Date.now()
            set({ statePullFailed: false, statePullPartial: Boolean(respData.partial) })
            const batchedStates = respData.states
            const serverHeartbeat = respData.lastWorkerRun
            const lastCycle = parseAutopilotCycleStats(respData.lastCycle)

            if (serverHeartbeat) {
                set({ lastWorkerRun: new Date(serverHeartbeat) })
            }
            if (lastCycle) set({ lastCycle })

            let hasUpdates = false
            const updatedRules = [...rules]
            const seenRuleIds = new Set<string>()
            const urlMemo = new Map<string, string>()
            const norm = memoizedAddonUrlNormalizer(urlMemo)

            for (const accountId of Object.keys(batchedStates)) {
                const serverStates = batchedStates[accountId]
                for (const serverRuleRaw of serverStates) {
                    const serverRule = serverRuleRaw as Record<string, unknown>
                    seenRuleIds.add(serverRule.id as string)
                    const ruleIndex = updatedRules.findIndex(r => r.id === (serverRule.id as string))
                    if (ruleIndex !== -1) {
                        const localRule = updatedRules[ruleIndex]
                        const isPendingUpdate = _pendingRuleUpdates.has(localRule.id)
                        const nextPriorityChain = isPendingUpdate
                            ? localRule.priorityChain
                            : (Array.isArray(serverRule.priorityChain) ? (serverRule.priorityChain as string[]) : localRule.priorityChain)
                        const nextActiveUrl = (serverRule.activeUrl as string) || nextPriorityChain?.[0] || localRule.activeUrl
                        const normNextActive = norm(nextActiveUrl || '')

                        if (didActiveTierChange(localRule.activeUrl, nextActiveUrl)) {
                            if (import.meta.env.DEV) console.log(`[Failover] Server-side swap detected: ${localRule.id} -> ${nextActiveUrl}`)
                        }

                        const normPrimary = norm(nextPriorityChain?.[0] || '')
                        // The per-rule notification mode is only adopted when the server states
                        // it (older servers omit it) and never while a local save is still in
                        // flight: a pull racing the save must not revert the user's edit.
                        const nextWebhookUrl = isPendingUpdate
                            ? localRule.webhookUrl
                            : (typeof serverRule.webhookUrl === 'string' ? serverRule.webhookUrl : localRule.webhookUrl)
                        const nextNotifyEnabled = isPendingUpdate
                            ? localRule.notifyEnabled
                            : (serverRule.notifyEnabled != null ? Boolean(serverRule.notifyEnabled) : localRule.notifyEnabled)
                        const candidate: FailoverRule = {
                            ...localRule,
                            name: (serverRule.name as string) ?? localRule.name,
                            cooldown_ms: (serverRule.cooldownMs as number) ?? localRule.cooldown_ms,
                            priorityChain: nextPriorityChain,
                            activeUrl: nextActiveUrl,
                            webhookUrl: nextWebhookUrl,
                            notifyEnabled: nextNotifyEnabled,
                            isActive: serverRule.isActive !== undefined ? (serverRule.isActive as boolean) : localRule.isActive,
                            isAutomatic: serverRule.isAutomatic != null ? Boolean(serverRule.isAutomatic) : localRule.isAutomatic,
                            stabilization: (serverRule.stabilization as Record<string, number | AutopilotStabilizationEntry>) || localRule.stabilization,
                            lastCheck: serverRule.lastCheck ? new Date(serverRule.lastCheck as string | number) : localRule.lastCheck,
                            skipReason: readSkipReason(serverRule),
                            lastError: readRuleError(serverRule.lastError),
                            platform: !isPendingUpdate && typeof serverRule.platform === 'string' ? serverRule.platform : localRule.platform,
                            ...(!isPendingUpdate ? serverRuleBinding(serverRule, useAccountStore.getState().accounts.find(a => a.id === accountId)) || {} : {}),
                            status: nextActiveUrl
                                ? (normNextActive === normPrimary ? 'monitoring' : 'failed-over')
                                : localRule.status
                        }
                        // Reuse the local object when nothing changed: a pull that
                        // observes identical state republishes and repersists nothing.
                        const nextRule = reuseUnchanged(localRule, candidate)
                        updatedRules[ruleIndex] = nextRule
                        if (nextRule !== localRule) hasUpdates = true

                        // Consumer mode: the server already enforced this state on the
                        // platform, so reconciling must only APPLY it locally — never push
                        // the local list back out (backgroundSync/pushToConnections), which
                        // would resurrect the Swap & Hide clobber one level down the stack.
                        if (await reconcileAccountAddonsWithActiveRule(updatedRules[ruleIndex], { localOnly: true, urlMemo, skipRuleSync: opts?.skipRuleSync })) {
                            hasUpdates = true
                        }
                    }
                }
            }

            // A partial pull cannot prove absence; a complete one can.
            if (!respData.partial) {
                const missing = rulesMissingOnServer(updatedRules, new Set(accountIds), seenRuleIds, Date.now(), _pendingRuleUpdates)
                trackMissingSince(_missingSince, missing, Date.now())
                for (let i = 0; i < updatedRules.length; i++) {
                    if (!missing.has(updatedRules[i].id)) continue
                    missingFound = true
                    if (updatedRules[i].skipReason === 'not_on_server') continue
                    updatedRules[i] = { ...updatedRules[i], skipReason: 'not_on_server' }
                    hasUpdates = true
                }
            }

            if (hasUpdates) {
                // Publish onto the current rules: rules edited or saving since the pull began keep
                // their local state, rules removed meanwhile stay removed, new ones stay.
                const pulledById = new Map(updatedRules.map(r => [r.id, r]))
                const published = get().rules.map(r => {
                    const pulled = pulledById.get(r.id)
                    if (!pulled || _pendingRuleUpdates.has(r.id) || pendingAtStart.has(r.id)) return r
                    if ((_ruleEditSeq.get(r.id) ?? 0) !== (editsAtStart.get(r.id) ?? 0)) return r
                    return pulled
                })
                set({ rules: published })
                await localforage.setItem(STORAGE_KEY, published)
            }
            if (!respData.partial && get().sessionGeneration === sessionAtStart) {
                _lastCompletePullAt = Date.now()
                set({ lastCompletePullAt: _lastCompletePullAt })
            }
        } catch (e) {
            if (!fetched) set({ statePullFailed: true })
            if (import.meta.env.DEV) console.warn('[Failover] pullServerState failed:', e)
        } finally {
            _isPulling = false
        }
        if (missingFound) void get().autoRestoreMissingRules()
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

        pushGlobalWebhookToServer(enabled !== false ? url : '').catch(e => { if (import.meta.env.DEV) console.error(e) })
    },

    addRule: async (accountId, priorityChain, name, cooldown_ms, webhookUrl, notifyEnabled, messageTemplate, customCheckUrls) => {
        const generation = get().sessionGeneration
        const safeChain = Array.isArray(priorityChain) ? priorityChain : []
        const safeCustomChecks = normalizeCustomChecks(customCheckUrls)
        let newRule: FailoverRule = {
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
            createdAt: Date.now(),
        }

        const account = useAccountStore.getState().accounts.find(a => a.id === accountId)
        if (account) {
            const target = resolveRuleSyncTarget(newRule, account, !!getStremioAuthKey(account), true)
            if (target) newRule = { ...newRule, platform: target.platform, connectionId: target.connectionId }
        }

        // Server-first validation: an authenticated save throws (409 overlap, server or
        // network failure) before anything is published, reconciled or pushed, so an
        // invalid overlap never lands locally. Local-only accounts skip the server and
        // still create the rule.
        await syncRuleToServer(newRule, { strict: true })
        if (get().sessionGeneration !== generation) throw new Error('The session changed while saving this rule. Try again.')

        const rules = [...get().rules, newRule]
        set({ rules })
        resetPollCadence()
        await localforage.setItem(STORAGE_KEY, rules)
        await reconcileAccountAddonsWithActiveRule(newRule)
        triggerSync()
    },

    removeRule: async (ruleId, opts) => {
        const generation = get().sessionGeneration
        const strict = opts?.strict === true
        const ruleAccountId = get().rules.find(r => r.id === ruleId)?.accountId
        await trackDeletedRule(ruleId)
        const deletedOnServer = await deleteRuleFromServer(ruleId)
        if (get().sessionGeneration !== generation) throw new Error('The session changed while removing this rule. Try again.')
        if (!deletedOnServer) {
            await clearDeletedRuleId(ruleId)
            if (strict) {
                // Removal flows must verify the server deletion before unlinking a login.
                throw new Error('The rule could not be deleted on the server, so the login was not removed. Try again.')
            }
            toast({
                title: 'Unable to delete Autopilot rule',
                description: 'Server deletion failed. The local rule was kept so it does not reappear on sync.',
                variant: 'destructive',
                href: ruleAccountId ? `/account/${encodeURIComponent(ruleAccountId)}` : undefined,
            })
            return false
        }
        const rules = get().rules.filter(r => r.id !== ruleId)
        set({ rules })
        await localforage.setItem(STORAGE_KEY, rules)
        if (strict && get().rules.some(r => r.id === ruleId)) {
            throw new Error('The rule is still present after deletion, so the login was not removed.')
        }
        triggerSync()
        return true
    },

    updateRule: async (ruleId, updates) => {
        const generation = get().sessionGeneration
        const before = get().rules.find(r => r.id === ruleId)
        if (!before) return
        // Server-first validation before this edit publishes anywhere (see addRule).
        await syncRuleToServer({ ...before, ...updates }, { strict: true })
        if (get().sessionGeneration !== generation) throw new Error('The session changed while saving this rule. Try again.')
        markRuleEdited(ruleId)
        _pendingRuleUpdates.add(ruleId)
        const timeoutId = setTimeout(() => _pendingRuleUpdates.delete(ruleId), 10000)
        try {
            const rules = get().rules.map(r => r.id === ruleId ? { ...r, ...updates } : r)
            set({ rules })
            resetPollCadence()
            await localforage.setItem(STORAGE_KEY, rules)
            const rule = rules.find(r => r.id === ruleId)
            if (rule) {
                await reconcileAccountAddonsWithActiveRule(rule)
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
        markRuleEdited(ruleId)
        const rules = get().rules.map(r =>
            r.id === ruleId ? { ...r, isActive } : r
        )
        set({ rules })
        if (isActive) resetPollCadence()
        await localforage.setItem(STORAGE_KEY, rules)
        const rule = rules.find(r => r.id === ruleId)
        if (rule) {
            const reconciled = await reconcileAccountAddonsWithActiveRule(rule)
            if (!reconciled) await syncRuleToServer(rule)
        }
        triggerSync()
    },

    // A removed connection's rules are dead weight: their server rows were deleted with
    // the connection's server state, so retire the local copies and track the deletions
    // (a states pull or a stale tab must not resurrect them).
    removeConnectionRules: async (accountId, connectionId) => {
        const bound = get().rules.filter(r => r.accountId === accountId && r.connectionId === connectionId)
        if (bound.length === 0) return 0
        for (const rule of bound) await trackDeletedRule(rule.id)
        const remaining = get().rules.filter(r => r.accountId !== accountId || r.connectionId !== connectionId)
        set({ rules: remaining })
        resetPollCadence()
        await localforage.setItem(STORAGE_KEY, remaining)
        triggerSync()
        return bound.length
    },

    // Removal-flow pause: server-first and idempotent, it touches only is_active (no
    // platform, connection or blob writes). A rule absent on the server has nothing to
    // pause, so its 404 counts as paused. Local state flips only after the server
    // confirms, behind a session fence so a reset cannot race the flip.
    pauseRule: async (ruleId) => {
        const rule = get().rules.find(r => r.id === ruleId)
        if (!rule) throw new Error('Rule not found')
        const generation = get().sessionGeneration
        const { useSyncStore } = await import('@/store/syncStore')
        const { auth, serverUrl } = useSyncStore.getState()
        if (auth.isAuthenticated) {
            const baseUrl = serverUrl || ''
            const apiPath = baseUrl.startsWith('http') ? `${baseUrl.replace(/\/$/, '')}/api` : '/api'
            const { getSyncPasswordHeader } = await import('@/lib/sync-auth')
            let resp: Awaited<ReturnType<typeof resilientFetch>>
            try {
                const syncToken = await getSyncPasswordHeader(auth)
                resp = await resilientFetch(`${apiPath}/autopilot/${encodeURIComponent(ruleId)}/pause`, {
                    method: 'POST',
                    retries: 0,
                    headers: { 'x-sync-password': syncToken, 'x-sync-user': auth.id },
                })
            } catch {
                throw new Error('Could not reach the server, so the rule is still active. Try again.')
            }
            if (!resp.ok && resp.status !== 404) throw new Error(await readAutopilotServerError(resp))
        }
        if (get().sessionGeneration !== generation) throw new Error('The session changed during the pause. Try again.')
        markRuleEdited(ruleId)
        const rules = get().rules.map(r => r.id === ruleId ? { ...r, isActive: false } : r)
        set({ rules })
        await localforage.setItem(STORAGE_KEY, rules)
    },

    // Conflict retry: asks the engine to re-audit a contested rule now. It never resumes
    // a disabled rule and pushes nothing; the fresh state pull decides what is enforced.
    retryRuleConflict: async (ruleId) => {
        const rule = get().rules.find(r => r.id === ruleId)
        if (!rule) throw new Error('Rule not found')
        const { useSyncStore } = await import('@/store/syncStore')
        const { auth, serverUrl } = useSyncStore.getState()
        if (!auth.isAuthenticated) return
        const baseUrl = serverUrl || ''
        const apiPath = baseUrl.startsWith('http') ? `${baseUrl.replace(/\/$/, '')}/api` : '/api'
        const { getSyncPasswordHeader } = await import('@/lib/sync-auth')
        let resp: Awaited<ReturnType<typeof resilientFetch>>
        try {
            const syncToken = await getSyncPasswordHeader(auth)
            resp = await resilientFetch(`${apiPath}/autopilot/${encodeURIComponent(ruleId)}/retry-conflict`, {
                method: 'POST',
                retries: 0,
                headers: { 'x-sync-password': syncToken, 'x-sync-user': auth.id },
            })
        } catch {
            throw new Error('Could not reach the server, so the retry did not run. Try again.')
        }
        if (!resp.ok) throw new Error(await readAutopilotServerError(resp))
        await get().pullServerState()
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
        if (_isPulling) return
        // Zero rules skip rule-state work (activeRuleCount 0 never pulls), but the
        // global worker flag is still read once per quiet window so Header and the
        // rule card can announce a turned-off server.
        const flagProbe = rules.length === 0
        if (flagProbe && Date.now() - _lastFlagReadAt < WORKER_FLAG_QUIET_MS) return
        const sessionAtStart = get().sessionGeneration
        const pulseSeq = ++_pulseSeq.next
        const pulseIsCurrent = () => get().sessionGeneration === sessionAtStart && pulseSeq === _pulseSeq.next

        try {
            if (useAuthStore.getState().isLocked) return
            const { useSyncStore } = await import('@/store/syncStore')
            const { auth, serverUrl } = useSyncStore.getState()
            if (!auth.isAuthenticated) return

            const baseUrl = serverUrl || ''
            const apiPath = baseUrl.startsWith('http') ? `${baseUrl.replace(/\/$/, '')}/api` : '/api'
            const { getSyncPasswordHeader } = await import('@/lib/sync-auth')
            const syncToken = await getSyncPasswordHeader(auth)
            if (flagProbe) _lastFlagReadAt = Date.now()

            let resp: Awaited<ReturnType<typeof resilientFetch>>
            try {
                resp = await resilientFetch(`${apiPath}/autopilot/pulse`, {
                    headers: { 'x-sync-password': syncToken, 'x-sync-user': auth.id }
                })
            } catch {
                // Only a transport failure marks the server unreachable; processing errors never do.
                if (pulseIsCurrent()) set({ pulseUnreachable: true })
                return
            }
            // Any HTTP response proves the server is reachable.
            if (pulseIsCurrent()) set({ pulseUnreachable: false })
            if (!resp.ok) return
            const data = await resp.json()
            const serverLastRun = data?.lastWorkerRun
            const lastCycle = parseAutopilotCycleStats(data?.lastCycle)

            if (lastCycle) set({ lastCycle })
            set({ safeMode: readSafeMode(data?.safeMode), workerEnabled: readWorkerEnabledFlag(data?.workerEnabled) })

            const heartbeatAdvanced = Boolean(serverLastRun) && serverLastRun !== _lastWorkerRun
            if (heartbeatAdvanced) {
                _lastWorkerRun = serverLastRun
                set({ lastWorkerRun: new Date(serverLastRun) })
            }
            // Servers that report stateVersion let us skip the pull when nothing changed;
            // older servers keep the heartbeat-based pull.
            const stateVersion = typeof data?.stateVersion === 'string' ? data.stateVersion : null
            const versionChanged = stateVersion !== null && stateVersion !== _lastStateVersion
            const shouldPullStates = stateVersion !== null
                ? versionChanged || isStatePullDue(_lastStatePullAt, Date.now())
                : heartbeatAdvanced || isStatePullDue(_lastStatePullAt, Date.now())
            const willPull = data?.activeRuleCount > 0 && shouldPullStates
            const completeBefore = _lastCompletePullAt
            if (willPull) {
                await get().pullServerState()
            }
            // Acknowledge a version only once a complete pull applied it, so a failed pull retries.
            if (stateVersion !== null && (!willPull || _lastCompletePullAt !== completeBefore)) _lastStateVersion = stateVersion
        } catch (e) {
            if (import.meta.env.DEV) console.warn('[Failover] pulse failed:', e)
        }
    },

    startAutomation: () => {
        if (automationInterval) return
        const state = get()
        _lastWorkerRun = 0
        _cadence.reset()
        _lastStatePullAt = 0
        _lastStateVersion = null
        registerFocusPulse()
        state.pulse()
        set({ isMonitoring: true })
        scheduleNextPoll()
    },

    stopAutomation: () => {
        if (automationInterval) {
            window.clearTimeout(automationInterval)
            automationInterval = null
        }
        unregisterFocusPulse()
        set({ isMonitoring: false })
    },

    importRules: async (data: unknown, strategy: 'merge' | 'mirror' = 'merge', isSilent: boolean = false, ownership?: SyncOwnership) => {
        const own = ownership ?? captureSyncOwnership()
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
                    // Persist under the ownership fence before publishing state.
                    own.assert()
                    await localforage.setItem(STORAGE_KEY + ':webhook', scavengedWebhook)
                    own.assert()
                    set({ webhook: scavengedWebhook })
                } catch {
                    if (import.meta.env.DEV) console.warn('[Failover] Skipping invalid webhook URL from import:', scavengedWebhook.url)
                }
            }
        }
        const rulesToImport = scavengedRules
        const currentRules = [...get().rules]
        _cloudRules = { ids: new Set(rulesToImport.map(r => String(r?.id ?? ''))), at: Date.now() }

        if (strategy === 'mirror') {
            // Anti-Wipe Guard: If remote has 0 rules but we have local rules, preserve local state.
            // This prevents cloud pull from wiping rules when the server has stale/empty data.
            if (rulesToImport.length === 0 && currentRules.length > 0) {
                if (import.meta.env.DEV) console.warn('[Failover] Anti-Wipe Triggered: Remote has 0 rules but local has ' + currentRules.length + '. Preserving local rules.')
                return
            }
            const finalRules: FailoverRule[] = []
            rulesToImport.forEach(newRule => {
                const migratedRule: FailoverRule = stripUndefinedRuleFields({
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
                    customCheckUrls: newRule.customCheckUrls ? normalizeCustomChecks(newRule.customCheckUrls) : undefined,
                    platform: typeof newRule.platform === 'string' ? newRule.platform : undefined,
                    connectionId: typeof newRule.connectionId === 'string' ? newRule.connectionId : undefined,
                })
                const existing = currentRules.find(r => r.id === migratedRule.id)
                if (existing) {
                    preserveScopedChecksAtRisk(existing, migratedRule.customCheckUrls)
                    // A cloud pull landing while a rule save is in flight must not revert it.
                    const keepLocalNotify = _pendingRuleUpdates.has(migratedRule.id)
                    finalRules.push({
                        ...existing,
                        ...migratedRule,
                        ...(keepLocalNotify ? { webhookUrl: existing.webhookUrl, notifyEnabled: existing.notifyEnabled } : {}),
                        lastCheck: newRule.lastCheck ? new Date(newRule.lastCheck) : existing.lastCheck,
                        lastFailover: newRule.lastFailover ? new Date(newRule.lastFailover) : existing.lastFailover
                    })
                } else {
                    finalRules.push({
                        ...migratedRule,
                        lastCheck: newRule.lastCheck ? new Date(newRule.lastCheck) : undefined,
                        lastFailover: newRule.lastFailover ? new Date(newRule.lastFailover) : undefined
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
            const migratedRule: FailoverRule = stripUndefinedRuleFields({
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
                customCheckUrls: newRule.customCheckUrls ? normalizeCustomChecks(newRule.customCheckUrls) : undefined,
                platform: typeof newRule.platform === 'string' ? newRule.platform : undefined,
                connectionId: typeof newRule.connectionId === 'string' ? newRule.connectionId : undefined,
            })
            const index = currentRules.findIndex(r => r.id === migratedRule.id)
            if (index !== -1) {
                preserveScopedChecksAtRisk(currentRules[index], migratedRule.customCheckUrls)
                // A cloud pull landing while a rule save is in flight must not revert it.
                const keepLocalNotify = _pendingRuleUpdates.has(migratedRule.id)
                currentRules[index] = {
                    ...currentRules[index],
                    ...migratedRule,
                    ...(keepLocalNotify ? { webhookUrl: currentRules[index].webhookUrl, notifyEnabled: currentRules[index].notifyEnabled } : {}),
                    lastCheck: newRule.lastCheck ? new Date(newRule.lastCheck) : currentRules[index].lastCheck,
                    lastFailover: newRule.lastFailover ? new Date(newRule.lastFailover) : currentRules[index].lastFailover
                }
                updatedCount++
            } else {
                currentRules.push({
                    ...migratedRule,
                    lastCheck: newRule.lastCheck ? new Date(newRule.lastCheck) : undefined,
                    lastFailover: newRule.lastFailover ? new Date(newRule.lastFailover) : undefined
                })
                addedCount++
            }
        })
        if (updatedCount > 0 || addedCount > 0) {
            // Persist under the ownership fence before publishing state.
            own.assert()
            await localforage.setItem(STORAGE_KEY, currentRules)
            own.assert()
            set({ rules: currentRules })

            if (!isSilent) {
                own.assert()
                await syncRulesToServerBatch(currentRules)
                triggerSync()
            }
        }
    },

    importWebhook: async (incoming, isSilent = false, ownership?: SyncOwnership) => {
        if (!incoming) return
        const own = ownership ?? captureSyncOwnership()
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

            // Persist under the ownership fence before publishing state.
            own.assert()
            await localforage.setItem(STORAGE_KEY + ':webhook', configToStore)
            own.assert()
            set({ webhook: processedWebhook })

            if (import.meta.env.DEV) console.log(`[Failover] Updating webhook (Incoming: ${incomingTs}, Local: ${currentTs})`)

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

    restoreRuleOnServer: async (ruleId, opts) => {
        const rule = get().rules.find(r => r.id === ruleId)
        if (!rule) return false
        const now = Date.now()
        if (now < _restoreRateLimitedUntil) {
            await applyRestoreOutcome({ restored: [], failed: { [ruleId]: RESTORE_RATE_LIMIT_MESSAGE }, rateLimited: null }, _restoreRateLimitedUntil)
            return false
        }
        _restoreSession.attempted.add(ruleId)
        const outcome = await syncRulesToServerBatch([rule])
        if (outcome.rateLimited) _restoreRateLimitedUntil = now + outcome.rateLimited.retryAfterMs
        await applyRestoreOutcome(outcome, outcome.rateLimited ? _restoreRateLimitedUntil : null)
        if (!outcome.restored.includes(ruleId)) return false
        await get().pullServerState()
        if (!opts?.quiet) toast({ ...restoredToastCopy([rule.name]), accountId: rule.accountId })
        return get().rules.find(r => r.id === ruleId)?.skipReason !== 'not_on_server'
    },

    autoRestoreMissingRules: async () => {
        if (_autoRestoreRunning || useAuthStore.getState().isLocked) return
        const accountState = useAccountStore.getState()
        if (!accountState.hydrated) return
        const now = Date.now()
        if (now < _restoreRateLimitedUntil) return
        const accountExists = liveAccountCheck(accountState.accounts.map(a => a.id), accountState.deletedAccounts, accountState.restoredAccounts)
        const deleted = new Set(await getDeletedRuleIds())
        const ids = pickAutoRestore(get().rules, accountExists, deleted, _restoreSession, now)
            .filter(id => passesRestoreGate(id, _missingSince, _cloudRules, now))
        if (ids.length === 0) return
        _autoRestoreRunning = true
        try {
            const byId = new Map(get().rules.map(r => [r.id, r]))
            const outcome = await runAutoRestore(ids, _restoreSession, now, chunk =>
                syncRulesToServerBatch(chunk.map(id => byId.get(id)).filter((r): r is FailoverRule => r !== undefined)))
            if (outcome.rateLimited) _restoreRateLimitedUntil = now + outcome.rateLimited.retryAfterMs
            await applyRestoreOutcome(outcome, outcome.rateLimited ? _restoreRateLimitedUntil : null)
            if (outcome.restored.length > 0) {
                const restored = outcome.restored.map(id => byId.get(id))
                const accountIds = new Set(restored.map(r => r?.accountId))
                toast({ ...restoredToastCopy(restored.map(r => r?.name)), accountId: accountIds.size === 1 ? restored[0]?.accountId : undefined })
            }
        } finally {
            _autoRestoreRunning = false
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
            // Mirroring is Stremio-only: a destination without a Stremio login could never run these rules.
            if (!targetAccount || !getStremioAuthKey(targetAccount)) { skipped += sourceRules.length; continue }

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
        const outcome = await syncRulesToServerBatch(created)
        triggerSync()
        const refused = Object.keys(outcome.failed).length
        return { mirrored: created.length - refused, skipped: skipped + refused }
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
            const { getSyncPasswordHeader } = await import('@/lib/sync-auth')
            const syncToken = await getSyncPasswordHeader(auth)
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
        set({ rules: [], webhook: { url: '', enabled: false, updatedAt: 0 }, isMonitoring: false, lastWorkerRun: undefined, lastCycle: undefined, safeMode: null, statePullFailed: false, statePullPartial: false, pulseUnreachable: false, workerEnabled: true, lastCompletePullAt: 0, sessionGeneration: get().sessionGeneration + 1, restoreIssues: {} })
        _restoreSession = createRestoreSession()
        _restoreRateLimitedUntil = 0
        _missingSince.clear()
        _cloudRules = null
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

async function applyRestoreOutcome(outcome: RuleBatchOutcome, retryAt: number | null) {
    const { rules, restoreIssues } = useFailoverStore.getState()
    const restored = new Set(outcome.restored)
    const issues = { ...restoreIssues }
    for (const id of restored) delete issues[id]
    for (const [id, message] of Object.entries(outcome.failed)) issues[id] = { message, retryAt }
    const next = restored.size > 0
        ? rules.map(r => restored.has(r.id) && r.skipReason === 'not_on_server' ? { ...r, skipReason: null } : r)
        : rules
    useFailoverStore.setState({ rules: next, restoreIssues: issues })
    if (next !== rules) await localforage.setItem(STORAGE_KEY, next)
}
