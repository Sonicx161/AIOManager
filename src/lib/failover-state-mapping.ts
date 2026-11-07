import { normalizeAddonUrl } from './addon-url.ts'
import type { AutopilotStabilizationEntry, CustomCheckEntry, FailoverRule } from '../store/failoverStore.ts'

/**
 * Deletes undefined-valued own keys so spread-merges (`{ ...local, ...processed }`)
 * preserve local-only edits: an absent key never clobbers, an own `undefined` always does.
 */
export function stripUndefinedRuleFields(rule: FailoverRule): FailoverRule {
    const partial = rule as Partial<FailoverRule>
    for (const key of Object.keys(partial) as (keyof FailoverRule)[]) {
        if (partial[key] === undefined) delete partial[key]
    }
    return rule
}

export function rebuildRuleFromServerState(payload: Record<string, unknown>, accountId: string): FailoverRule {
    const priorityChain = (payload.priorityChain as string[]) || []
    const rule: FailoverRule = {
        id: payload.id as string,
        accountId,
        name: typeof payload.name === 'string' ? payload.name : undefined,
        cooldown_ms: typeof payload.cooldownMs === 'number' ? payload.cooldownMs : undefined,
        priorityChain,
        isActive: payload.isActive !== undefined ? Boolean(payload.isActive) : false,
        isAutomatic: payload.isAutomatic != null ? Boolean(payload.isAutomatic) : true,
        activeUrl: (payload.activeUrl as string) || priorityChain[0],
        lastCheck: payload.lastCheck ? new Date(payload.lastCheck as string | number) : undefined,
        stabilization: (payload.stabilization as Record<string, number | AutopilotStabilizationEntry>) || {},
        status: 'idle',
        // Server '' means nothing stored (per-rule off or default); a stored value is the
        // per-rule override. The off/on decision rides on notifyEnabled, not on the empty URL.
        webhookUrl: payload.webhookUrl ? String(payload.webhookUrl) : undefined,
        // Only a boolean is a server statement; omitted (older server, legacy row) stays
        // undefined so the spread-merge preserves the local notification mode.
        notifyEnabled: typeof payload.notifyEnabled === 'boolean' ? payload.notifyEnabled : undefined,
        // Server sends [] for "none configured"; undefined-valued keys are stripped so the
        // spread-merge preserves local-only edits.
        customCheckUrls: Array.isArray(payload.customCheckUrls) && payload.customCheckUrls.length > 0
            ? payload.customCheckUrls as CustomCheckEntry[]
            : undefined,
        messageTemplate: payload.messageTemplate ? String(payload.messageTemplate) : undefined,
        platform: payload.platform ? String(payload.platform) : undefined,
        connectionId: payload.connectionId ? String(payload.connectionId) : undefined,
    }

    if (rule.activeUrl) {
        const normServerActive = normalizeAddonUrl(rule.activeUrl)
        const normPrimary = normalizeAddonUrl(rule.priorityChain?.[0] || '')
        rule.status = normServerActive === normPrimary ? 'monitoring' : 'failed-over'
    }

    return stripUndefinedRuleFields(rule)
}

/**
 * Swap detection for poll-driven convergence (Nuvio "Swap & Hide"): true when the
 * server's enforced active tier differs from the local copy. Normalized compare, so
 * trailing slashes, /manifest.json suffixes, stremio:// scheme and case never produce
 * false swaps. An empty server-side active URL is "no statement", not a swap.
 */
export function didActiveTierChange(previousActiveUrl: string | undefined, nextActiveUrl: string | undefined): boolean {
    if (!nextActiveUrl) return false
    return normalizeAddonUrl(nextActiveUrl) !== normalizeAddonUrl(previousActiveUrl || '')
}
