// Pure rule decision shared with the client's Rehearse sheet. No imports: the browser bundles this file.

// Mirrors the target state machine (host-health-table.js): DOWN after 2 bad cycles, UP again after 4 good.
export const FAILOVER_THRESHOLD = 2
export const RECOVERY_THRESHOLD = 4

// The worker runs one cycle per tick, so a streak of N checks takes about N of these.
export const CHECK_INTERVAL_MS = 60 * 1000

export const TRANSITION_MESSAGES = Object.freeze({
    failover: 'Primary offline. Switched to backup.',
    recovery: 'Primary recovered. Restored original priority.',
})

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

export function resolveMessageTemplate(template, payload) {
    if (!template) return payload.message
    const values = {
        account: payload.accountName || payload.accountId || 'Unknown',
        rule: payload.ruleName || 'Unnamed Rule',
        primary: payload.fromName || payload.fromUrl || 'Unknown',
        backup: payload.activeName || payload.activeUrl || 'Unknown',
        addon: payload.activeName || 'Unknown',
        from: payload.fromName || payload.fromUrl || 'Unknown',
        to: payload.activeName || payload.activeUrl || 'Unknown',
        status: payload.type === 'failover' ? 'Failed Over' : payload.type === 'recovery' ? 'Recovered' : payload.type,
        provider: payload.provider || 'Unknown',
    }
    return template.replace(/\{{1,2}\s*(account|rule|primary|backup|addon|from|to|status|provider)\s*\}{1,2}/gi, (match, key) => {
        const value = values[key.toLowerCase()]
        return value !== undefined ? value : match
    })
}
