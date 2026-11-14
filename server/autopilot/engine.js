import { createStremioDriver } from '../providers/stremio-driver.js'
import { createHealthChecker } from './health-checks.js'
import { normalizeAddonUrl } from '../utils/addon-url.js'
import { createRuleCache } from './v1/rule-cache.js'
import { createRuntimeState } from './v1/runtime-state.js'
import { createManifests } from './v1/manifests.js'
import { createMerge } from './v1/merge.js'
import { createSiblings } from './v1/siblings.js'
import { createNotify, guardedWebhookFetch } from './v1/notify.js'
import { createHistory } from './v1/history.js'
import { createWriters } from './v1/writers.js'
import { createDeepAudit } from './v1/deep-audit.js'
import { createCommit } from './v1/commit.js'
import { createProcessRule } from './v1/process-rule.js'
import { createScheduler } from './v1/scheduler.js'
import { createConnectionRetry } from './v1/connection-retry.js'
import { autopilotTripwire, guardFetch, guardProvider } from './write-tripwire.js'

export { stableStringify, addonListChanged, runFullRuleUpdate } from './v1/commit.js'
export { RULE_SKIP_REASONS, evaluateRuleSkip, resolveRuleSkipReason } from './v1/failover-evaluate.js'

const envMs = (name, fallback, min) => Math.max(min, parseInt(process.env[name] || String(fallback), 10) || fallback)

// Read-only provider methods; every other method is refused while the write tripwire holds safe mode.
const STREMIO_READS = ['readAddons']
const RECONCILER_READS = ['resolveConnections', 'auditConnections', 'getConnectionStates', 'getState']

export function createAutopilotEngine(fastify, rawReconciler = null, deps = {}) {
    const nowMs = deps.now ?? (() => Date.now())
    const rand = deps.random ?? (() => Math.random())
    // Webhooks default to the connect-time guarded transport; an injected deps.fetch (golden harness) replaces it.
    const fetchImpl = guardFetch(deps.fetch ?? guardedWebhookFetch)
    autopilotTripwire.attachLogger(fastify.log)

    const stremioDriver = guardProvider(deps.stremioDriver ?? createStremioDriver(), STREMIO_READS)
    const reconciler = guardProvider(rawReconciler, RECONCILER_READS)

    const RULE_RUNTIME_TTL_MS = 24 * 60 * 60 * 1000
    const MAX_RULE_RUNTIME_ENTRIES = 100000
    const AUTOPILOT_SCAN_CHUNK_SIZE = envMs('AUTOPILOT_SCAN_CHUNK_SIZE', 500, 100)
    const AUTOPILOT_MAX_RULES_PER_CYCLE = Math.max(AUTOPILOT_SCAN_CHUNK_SIZE, parseInt(process.env.AUTOPILOT_MAX_RULES_PER_CYCLE || '10000', 10) || 10000)
    const AUTOPILOT_CYCLE_BUDGET_MS = envMs('AUTOPILOT_CYCLE_BUDGET_MS', 120000, 5000)
    // A cycle still running this long after it started is treated as hung (see the scheduler watchdog).
    const AUTOPILOT_CYCLE_WATCHDOG_MS = envMs('AUTOPILOT_CYCLE_WATCHDOG_MS', Math.max(3 * AUTOPILOT_CYCLE_BUDGET_MS, 300000), 1000)
    // Accounts checked in parallel by the scheduler's worker pool.
    const AUTOPILOT_RULE_CONCURRENCY = envMs('AUTOPILOT_RULE_CONCURRENCY', 32, 1)
    const RULE_RECHECK_MS = envMs('AUTOPILOT_RULE_RECHECK_MS', 30000, 10000)
    // Steady-rule heartbeat cadence; keeps persisted last_check fresh well under the client's 15-min staleness threshold
    const RULE_HEARTBEAT_MS = envMs('AUTOPILOT_HEARTBEAT_MS', 300000, 30_000)
    // How often a steady rule re-checks the live collection for drift
    const RULE_DEEP_AUDIT_MS = envMs('AUTOPILOT_DEEP_AUDIT_MS', 3600000, 300_000)
    // A rule that predates this process and has no runtime state yet gets a random phase, so its
    // first audit lands within this window instead of every rule auditing in one cycle; later
    // audits keep that phase. Rules created or edited after boot (updated_at past bootAt) still
    // audit on their next scan.
    const RULE_FIRST_DEEP_AUDIT_MAX_MS = Math.min(RULE_DEEP_AUDIT_MS, 10 * 60 * 1000)
    const bootAt = nowMs()
    const runtimeState = createRuntimeState({ nowMs, RULE_RUNTIME_TTL_MS, MAX_RULE_RUNTIME_ENTRIES })
    const { getRuleRuntimeState, clearRuleRuntimeState, clearAccountRuleRuntimeState, shouldSkipRuleCheck, setRuleRuntimeState } = runtimeState

    const RULE_CACHE_MAX_BYTES = Math.max(0, parseInt(process.env.AUTOPILOT_RULE_CACHE_MAX_BYTES || String(256 * 1024 * 1024), 10) || 0)
    // Freshness is the (id, updated_at) version key, which every writer bumps; the TTL only bounds idle memory.
    const RULE_CACHE_TTL_MS = envMs('AUTOPILOT_RULE_CACHE_TTL_MS', 86400000, 60000)
    const ruleCache = createRuleCache({ fastify, nowMs, RULE_CACHE_MAX_BYTES, RULE_CACHE_TTL_MS, READER_MAX_AGE_MS: Math.max(900000, 2 * AUTOPILOT_CYCLE_BUDGET_MS) })
    const { decryptRuleField } = ruleCache

    // Probes default to the connect-time guarded transport; an injected deps.fetch (golden harness) replaces it.
    // Pings get two thirds of the recheck interval; an overdue ping defers to the next cycle.
    const healthPingBudgetMs = deps.healthPingBudgetMs ?? Math.min(Math.floor(RULE_RECHECK_MS * 2 / 3), AUTOPILOT_CYCLE_BUDGET_MS)
    const { checkAddonHealthInternal, getHealthLatency, checkCustomUrlsHealth, memberStatus, beginProbeCycle, endProbeCycle } = (deps.createHealthChecker ?? createHealthChecker)(fastify, {
        fetch: deps.fetch, now: nowMs, pingBudgetMs: healthPingBudgetMs,
        ...(deps.healthRetryDelayMs != null ? { retryDelayMs: deps.healthRetryDelayMs } : {}),
    })

    const { isSubstantial, fetchManifestRaw, areCollectionsDifferent, prepareAddonsForStremio, fetchAndRefreshManifest } = createManifests({ fastify, nowMs, fetchImpl: deps.fetch })
    const { recordFailoverHistory } = createHistory({ fastify, nowMs })
    const cycleTargets = runtimeState.cycleTargets
    const { siblingKey, prefetchSiblingRows, siblingChainPlans } = createSiblings({ fastify, decryptRuleField, cycleTargets, conflicts: runtimeState.conflicts })
    const { buildReconciledList } = createMerge({ fastify, stremioDriver, checkAddonHealthInternal, recordFailoverHistory, isSubstantial, fetchManifestRaw, siblingChainPlans, runtimeState })

    const { writeStremioCollection, enforceConnectionOnly, syncStremioLive } = createWriters({
        fastify, nowMs, reconciler, stremioDriver, siblingChainPlans, buildReconciledList,
        fetchAndRefreshManifest, prepareAddonsForStremio, areCollectionsDifferent, runtimeState,
    })

    const { sendNotification, notifyTransition } = createNotify({ fastify, nowMs, fetchImpl, decryptRuleField })

    const deepAudit = createDeepAudit({
        fastify, nowMs, rand, bootAt, reconciler, stremioDriver, checkAddonHealthInternal, checkCustomUrlsHealth,
        RULE_DEEP_AUDIT_MS, RULE_FIRST_DEEP_AUDIT_MAX_MS,
    })
    const { planCommit, flushUpdates } = createCommit({ nowMs, setRuleRuntimeState, RULE_HEARTBEAT_MS })
    const connectionRetry = createConnectionRetry({ nowMs })
    const { processAutopilotRule: processRuleUnguarded } = createProcessRule({
        fastify, nowMs, reconciler, decryptRuleField, runtimeState, cycleTargets, siblingChainPlans,
        memberStatus, getHealthLatency, isSubstantial, fetchManifestRaw,
        buildReconciledList, writeStremioCollection, enforceConnectionOnly, syncStremioLive,
        recordFailoverHistory, notifyTransition, deepAudit, planCommit,
        ruleSnapshots: { get: ruleCache.ruleSnapshotGet, set: ruleCache.ruleSnapshotSet, getList: ruleCache.ruleListGet, holdList: ruleCache.ruleListHold, releaseList: ruleCache.ruleListRelease },
        connectionRetry, stremioDriver,
    })
    // Safe mode stops new rules mid-cycle; the seen set sizes the derived write limits.
    // A check that throws (proxy queue saturated) still records the attempt and its error, in memory only.
    const processAutopilotRule = async (rule, siblingRows = null) => {
        if (autopilotTripwire.isSafeMode()) return
        autopilotTripwire.noteRule(rule?.id)
        try {
            return await processRuleUnguarded(rule, siblingRows)
        } catch (err) {
            const queueFull = /queue saturated|too many pending/i.test(String(err?.message || ''))
            runtimeState.setRuleCheckError(rule?.id, rule?.account_id, queueFull ? 'probe_queue_full' : err?.code, err?.message)
            throw err
        }
    }
    const { runAutopilot, startAutopilotWorker, stopAutopilotWorker } = createScheduler({
        fastify, nowMs, cycleTargets, ruleCache, shouldSkipRuleCheck, prefetchSiblingRows, siblingKey,
        processAutopilotRule, flushUpdates, AUTOPILOT_SCAN_CHUNK_SIZE, AUTOPILOT_MAX_RULES_PER_CYCLE,
        AUTOPILOT_CYCLE_BUDGET_MS, RULE_RECHECK_MS, AUTOPILOT_CYCLE_WATCHDOG_MS, AUTOPILOT_RULE_CONCURRENCY,
        probeCycle: { begin: beginProbeCycle, end: endProbeCycle },
    })

    return {
        normalizeAddonUrl,
        checkAddonHealthInternal,
        getHealthLatency,
        decryptRuleField,
        beginRuleCacheRead: ruleCache.beginRead,
        withRuleCacheRead: ruleCache.withRead,
        endRuleCacheRead: ruleCache.endRead,
        invalidateRuleCaches: ruleCache.dropRuleCaches,
        retireRuleCaches: ruleCache.retireRuleCaches,
        retireRuleSecrets: ruleCache.retireRuleSecrets,
        syncStremioLive: async (...args) => {
            const token = ruleCache.beginRead()
            try { return await ruleCache.withRead(token, () => syncStremioLive(...args)) } finally { ruleCache.endRead(token) }
        },
        enforceConnectionOnly,
        buildReconciledList,
        writeStremioCollection,
        sendNotification,
        recordFailoverHistory,
        processAutopilotRule,
        getRuleRuntimeState,
        getRuleCheckError: runtimeState.getRuleCheckError,
        getRuleRevision: runtimeState.getRuleRevision,
        retryContestedRule: (ruleId) => {
            const retried = runtimeState.conflicts.retry(ruleId)
            if (retried) {
                const state = getRuleRuntimeState(ruleId)
                if (state) setRuleRuntimeState(ruleId, { ...state, lastCheck: 0, lastDeepAudit: 0 })
                runtimeState.clearRuleCheckError(ruleId)
            }
            return retried
        },
        clearRuleRuntimeState: (ruleId) => { clearRuleRuntimeState(ruleId); connectionRetry.clear(ruleId) },
        clearAccountRuleRuntimeState: (accountId) => { clearAccountRuleRuntimeState(accountId); connectionRetry.clearAccount(accountId) },
        runAutopilot,
        startAutopilotWorker,
        stopAutopilotWorker,
        getRuleDecryptCacheStats: ruleCache.getRuleDecryptCacheStats,
        getRuleCacheStats: ruleCache.getRuleCacheStats,
        getConnectionRetry: connectionRetry.get,
    }
}
