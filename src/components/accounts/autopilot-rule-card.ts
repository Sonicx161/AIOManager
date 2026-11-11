import { maskUrlLevel } from '../../lib/utils.ts'
import { AUTOPILOT_WORKER_OFF_DETAIL, type AutopilotChipStatus, type AutopilotRuleFix } from '../../lib/autopilot-freshness.ts'

export type RuleConfidenceLabel =
    | 'Paused' | 'Manual' | 'Standby' | 'Not monitored' | 'Unverified' | 'Pending'
    | 'Needs attention' | 'Queued' | 'Stale' | 'Backup active' | 'No action needed' | 'Turned off'

export interface StaleHeartbeatRuleState {
    label: RuleConfidenceLabel
    detail: string
}

/**
 * State for a rule seen while the worker heartbeat is stale. A rule that has
 * never been checked has nothing stale to warn about, so it stays neutral;
 * the alarm is kept for rules that were checked before. A server with checks
 * turned off shows the operator's honest state instead: nothing is wrong with
 * the heartbeat, the worker simply is not running.
 */
export function staleHeartbeatRuleState(rule: { lastCheck?: Date | string | null }, { workerEnabled = true }: { workerEnabled?: boolean } = {}): StaleHeartbeatRuleState {
    if (!workerEnabled) return { label: 'Turned off', detail: AUTOPILOT_WORKER_OFF_DETAIL }
    if (!rule.lastCheck) return { label: 'Pending', detail: 'Waiting for the first server-side health check.' }
    const checkedAt = rule.lastCheck instanceof Date ? rule.lastCheck : new Date(rule.lastCheck)
    if (Number.isFinite(checkedAt.getTime())) {
        return { label: 'Standby', detail: 'Worker heartbeat is stale; waiting for fresh confirmation.' }
    }
    return { label: 'Pending', detail: 'Waiting for the first server-side health check.' }
}

const QUIET_LABELS: ReadonlySet<RuleConfidenceLabel> = new Set(['No action needed', 'Pending', 'Queued', 'Manual', 'Paused'])

/** Quiet states render one muted line; anything with an error or a real fix keeps the panel. */
export function isQuietRuleState(label: RuleConfidenceLabel, { fix, hasError }: { fix: AutopilotRuleFix | null; hasError: boolean }): boolean {
    if (!QUIET_LABELS.has(label) || hasError) return false
    if (fix === null) return true
    return fix === 'resume' && label === 'Paused'
}

export function quietRuleLine(label: RuleConfidenceLabel, { checkedLabel, latencyMs }: { checkedLabel: string | null; latencyMs: number | null }): string {
    if (label === 'Paused') return 'Paused'
    if (label === 'Manual') return 'Manual mode'
    if (label === 'Pending' || !checkedLabel) return 'Waiting for first check'
    if (label === 'Queued') return `Queued, checked ${checkedLabel}`
    return latencyMs === null ? `Watching on the server, checked ${checkedLabel}` : `Watching on the server, checked ${checkedLabel}, ${Math.round(latencyMs)} ms`
}

export type RuleDotTone = 'warning' | 'destructive' | null

export function ruleDotTone(label: RuleConfidenceLabel): RuleDotTone {
    if (label === 'Needs attention') return 'destructive'
    if (label === 'Stale' || label === 'Not monitored' || label === 'Unverified' || label === 'Standby' || label === 'Backup active' || label === 'Turned off') return 'warning'
    return null
}

export function ruleCountLabel(total: number, paused: number): string {
    const base = `${total} rule${total === 1 ? '' : 's'}`
    return paused > 0 ? `${base}, ${paused} paused` : base
}

export function showToolbarStatusChip({ status, hasWorkerRun, safeMode, workerEnabled = true }: { status: AutopilotChipStatus; hasWorkerRun: boolean; safeMode: boolean; workerEnabled?: boolean }): boolean {
    if (workerEnabled === false) return true
    if (safeMode) return true
    if (!hasWorkerRun) return false
    return status === 'Offline' || status === 'Stale' || status === 'Failing'
}

export const TOOLBAR_STATUS_DETAIL: Partial<Record<AutopilotChipStatus, string>> = {
    Offline: 'Autopilot server is offline.',
    Stale: 'Server is up, but no rule has been checked recently.',
    Failing: "A rule's last check failed. See the rule below for why.",
}

export function cooldownLabel(cooldownMs: number | null | undefined): string | null {
    if (!cooldownMs || cooldownMs <= 0) return null
    return `${Math.max(1, Math.round(cooldownMs / 60000))}m cooldown`
}

export type RuleWebhookKind = 'custom' | 'global' | 'silent'

export function ruleWebhookKind(rule: { webhookUrl?: string | null; notifyEnabled?: boolean }): RuleWebhookKind {
    if (rule.notifyEnabled === false) return 'silent'
    return rule.webhookUrl ? 'custom' : 'global'
}

/** Display-only webhook URL. A webhook URL is a pure bearer secret: host plus marker only. */
export function webhookDisplayUrl(url: string, privacyUrlLevel: number): string {
    if (privacyUrlLevel > 0) return maskUrlLevel(url, privacyUrlLevel).replace(/^https?:\/\//i, '')
    try {
        return `${new URL(url).host}/***`
    } catch {
        return 'Webhook URL'
    }
}
