import { scrubUrls } from './url-ref.js'
import { createConflictState } from './conflict-state.js'

const MAX_RULE_CHECK_ERRORS = 10000
const MAX_ERROR_MESSAGE_LENGTH = 120
const ERROR_CODE_RE = /^[a-z0-9_-]{1,40}$/i

export function createRuntimeState({ nowMs, RULE_RUNTIME_TTL_MS, MAX_RULE_RUNTIME_ENTRIES }) {
    const ruleRuntimeState = new Map()
    const conflicts = createConflictState({ nowMs, maxEntries: MAX_RULE_RUNTIME_ENTRIES })
    // Last check error per rule, memory only: { code, message, at }. Messages are URL-scrubbed and short.
    const ruleCheckErrors = new Map()
    // Memory-only revision per rule, bumped when anything /states shows from memory changes
    // (active url, stabilization, skip reason, check error). lastCheck alone never bumps it.
    // Each bump takes the next value of one process-wide sequence, so an owner's max only rises
    // on a real change and evicting old entries can never hide one.
    const ruleRevisions = new Map()
    let revisionSeq = 0
    const bumpRevision = (ruleId) => {
        ruleRevisions.delete(ruleId)
        ruleRevisions.set(ruleId, ++revisionSeq)
        if (ruleRevisions.size > MAX_RULE_CHECK_ERRORS) {
            const oldest = ruleRevisions.keys().next().value
            if (oldest !== undefined) ruleRevisions.delete(oldest)
        }
    }
    const visibleRuntime = (state) => state ? JSON.stringify([state.activeUrl ?? null, state.stabilization ?? null, state.skipReason ?? null]) : null

    const pruneRuleRuntimeState = () => {
        if (ruleRuntimeState.size <= MAX_RULE_RUNTIME_ENTRIES) return
        const cutoff = nowMs() - RULE_RUNTIME_TTL_MS
        for (const [ruleId, state] of ruleRuntimeState.entries()) {
            if (ruleRuntimeState.size <= MAX_RULE_RUNTIME_ENTRIES) break
            if ((state.lastCheck || 0) < cutoff) ruleRuntimeState.delete(ruleId)
        }
        while (ruleRuntimeState.size > MAX_RULE_RUNTIME_ENTRIES) {
            const oldestRuleId = ruleRuntimeState.keys().next().value
            if (oldestRuleId === undefined) break
            ruleRuntimeState.delete(oldestRuleId)
        }
    }

    const setRuleRuntimeState = (ruleId, state) => {
        if (!ruleId) return
        if (visibleRuntime(ruleRuntimeState.get(ruleId)) !== visibleRuntime(state)) bumpRevision(ruleId)
        if (ruleRuntimeState.has(ruleId)) ruleRuntimeState.delete(ruleId)
        ruleRuntimeState.set(ruleId, state)
        pruneRuleRuntimeState()
    }

    const getRuleRuntimeState = (ruleId) => {
        return ruleRuntimeState.get(ruleId) || null
    }

    const clearRuleRuntimeState = (ruleId) => {
        if (ruleRuntimeState.has(ruleId) || ruleCheckErrors.has(ruleId)) bumpRevision(ruleId)
        ruleRuntimeState.delete(ruleId)
        ruleCheckErrors.delete(ruleId)
        conflicts.clear(ruleId)
    }

    const clearAccountRuleRuntimeState = (accountId) => {
        conflicts.clearAccount(accountId)
        for (const [ruleId, state] of ruleRuntimeState.entries()) {
            if (state.accountId === accountId) { ruleRuntimeState.delete(ruleId); bumpRevision(ruleId) }
        }
        for (const [ruleId, entry] of ruleCheckErrors.entries()) {
            if (entry.accountId === accountId) { ruleCheckErrors.delete(ruleId); bumpRevision(ruleId) }
        }
    }

    const setRuleCheckError = (ruleId, accountId, code, message, details = {}) => {
        if (!ruleId) return
        const safeCode = typeof code === 'string' && ERROR_CODE_RE.test(code) ? code : 'check_failed'
        const safeMessage = scrubUrls(message).replace(/\s+/g, ' ').trim().slice(0, MAX_ERROR_MESSAGE_LENGTH)
        const extra = {
            ...(Array.isArray(details.affectedRefs) ? { affectedRefs: [...new Set(details.affectedRefs.filter(ref => /^ad_[a-f0-9]{16}$/.test(ref)))].slice(0, 100) } : {}),
            ...(Number.isFinite(details.retryAt) ? { retryAt: details.retryAt } : {}),
            ...(Number.isFinite(details.retryHours) ? { retryHours: details.retryHours } : {}),
        }
        const previous = ruleCheckErrors.get(ruleId)
        if (!previous || previous.code !== safeCode || previous.message !== safeMessage || JSON.stringify(previous.extra) !== JSON.stringify(extra)) bumpRevision(ruleId)
        ruleCheckErrors.delete(ruleId)
        ruleCheckErrors.set(ruleId, { code: safeCode, message: safeMessage, at: nowMs(), accountId, extra })
        while (ruleCheckErrors.size > MAX_RULE_CHECK_ERRORS) {
            const oldest = ruleCheckErrors.keys().next().value
            if (oldest === undefined) break
            ruleCheckErrors.delete(oldest)
        }
    }

    const getRuleCheckError = (ruleId) => {
        const entry = ruleCheckErrors.get(ruleId)
        return entry ? { code: entry.code, message: entry.message, at: entry.at, ...entry.extra } : null
    }

    const clearRuleCheckError = (ruleId) => {
        if (ruleCheckErrors.delete(ruleId)) bumpRevision(ruleId)
    }

    const getRuleRevision = (ruleId) => ruleRevisions.get(ruleId) || 0

    const shouldSkipRuleCheck = (ruleId, staleCutoff) => {
        const runtime = ruleRuntimeState.get(ruleId)
        return !!runtime?.lastCheck && runtime.lastCheck >= staleCutoff
    }

    const cycleTargets = new Map()

    return {
        setRuleRuntimeState,
        getRuleRuntimeState,
        clearRuleRuntimeState,
        clearAccountRuleRuntimeState,
        setRuleCheckError,
        getRuleCheckError,
        clearRuleCheckError,
        getRuleRevision,
        shouldSkipRuleCheck,
        cycleTargets,
        conflicts,
    }
}
