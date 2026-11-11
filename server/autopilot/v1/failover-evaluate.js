import { normalizeAddonUrl } from '../../utils/addon-url.js'
import { isSafeUrl } from '../../utils/ssrf.js'

export { FAILOVER_THRESHOLD, RECOVERY_THRESHOLD, decideTarget } from './failover-decision.js'
import { FAILOVER_THRESHOLD, RECOVERY_THRESHOLD } from './failover-decision.js'

export const RULE_SKIP_REASONS = Object.freeze({
    NO_VALID_CHAIN: 'no_valid_chain',
    NO_CREDENTIALS: 'no_credentials'
})

export function evaluateRuleSkip({ monitorable, chain }) {
    if (!monitorable) return RULE_SKIP_REASONS.NO_CREDENTIALS
    if (!Array.isArray(chain) || chain.length === 0) return RULE_SKIP_REASONS.NO_VALID_CHAIN
    return null
}

// Read-time only: derives the skip state from stored config, so exposing it never writes.
export function resolveRuleSkipReason(rule, runtime, chain) {
    if (runtime?.skipReason) return runtime.skipReason
    return evaluateRuleSkip({
        monitorable: Number(rule?.unmonitored) !== 1,
        chain: Array.isArray(chain) ? chain.filter(url => isSafeUrl(url)) : []
    })
}

// Custom check URLs that apply to one chain member (empty appliesTo means every member).
export function customCheckUrlsFor(customChecks, normUrl) {
    const applicable = customChecks.filter(c =>
        c.appliesTo.length === 0 ||
        c.appliesTo.some(au => normalizeAddonUrl(au).toLowerCase() === normUrl)
    )
    return [...new Set(applicable.map(c => c.url))]
}

// The stored and displayed per-member shape, derived from the target streaks and clamped like before.
export function stabilizationFrom(normalizedChain, members) {
    return Object.fromEntries(normalizedChain.map((url, i) => [url, {
        failures: Math.min(members[i].badStreak, FAILOVER_THRESHOLD),
        successes: Math.min(members[i].goodStreak, RECOVERY_THRESHOLD),
        latencyMs: members[i].goodStreak > 0 ? (members[i].latencyMs ?? null) : null,
    }]))
}
