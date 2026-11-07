import { normalizeAddonUrl } from '../../utils/addon-url.js'
import { isSafeUrl } from '../../utils/ssrf.js'

// Mirrors the target state machine (host-health-table.js): DOWN after 2 bad cycles, UP again after 4 good.
export const FAILOVER_THRESHOLD = 2
export const RECOVERY_THRESHOLD = 4

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

// Pure rule decision from the members' target states ({ state, goodStreak }, see host-health-table.js).
// The active member DOWN: move to the first member that is UP, else the first RECOVERING one, else stay.
// A member ranked above the active one that is UP with a full good streak: swap back to it. Otherwise stay.
// An active URL outside the chain ranks below every member.
export function decideTarget(members, activeIndex) {
    if (activeIndex !== -1 && members[activeIndex]?.state === 'DOWN') {
        const up = members.findIndex((m, i) => i !== activeIndex && m.state === 'UP')
        if (up !== -1) return { targetIndex: up, reason: 'active-dead' }
        // A RECOVERING member is only worth a switch once the active one has failed FAILOVER_THRESHOLD cycles in
        // a row, so two alternating flappers cannot cause a switch every cycle.
        const recovering = members[activeIndex].badStreak >= FAILOVER_THRESHOLD
            ? members.findIndex((m, i) => i !== activeIndex && m.state === 'RECOVERING')
            : -1
        if (recovering !== -1) return { targetIndex: recovering, reason: 'active-dead' }
        return { targetIndex: -1, reason: 'outage' }
    }
    const above = activeIndex === -1 ? members.length : activeIndex
    for (let i = 0; i < above; i++) {
        if (members[i].state === 'UP' && members[i].goodStreak >= RECOVERY_THRESHOLD) return { targetIndex: i, reason: 'recovered' }
    }
    return activeIndex === -1 ? { targetIndex: -1, reason: null } : { targetIndex: activeIndex, reason: 'active' }
}

// The stored and displayed per-member shape, derived from the target streaks and clamped like before.
export function stabilizationFrom(normalizedChain, members) {
    return Object.fromEntries(normalizedChain.map((url, i) => [url, {
        failures: Math.min(members[i].badStreak, FAILOVER_THRESHOLD),
        successes: Math.min(members[i].goodStreak, RECOVERY_THRESHOLD),
        latencyMs: members[i].goodStreak > 0 ? (members[i].latencyMs ?? null) : null,
    }]))
}
