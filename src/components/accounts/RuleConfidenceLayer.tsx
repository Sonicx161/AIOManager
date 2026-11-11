import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Activity, AlertTriangle, ArrowRight, Check, ChevronDown, CloudOff, Pause, RefreshCw, Shield, XCircle, type LucideIcon } from 'lucide-react'
import { StatusChip } from '@/components/ui/status-chip'
import { PlainStatusPanel, WatchingLine } from '@/components/accounts/FailoverStatusParts'
import { RehearseSheet, type RehearsalAddon } from '@/components/accounts/RehearseSheet'
import { agoLabel, failoverTiming } from '@/lib/failover-rehearsal'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { isQuietRuleState, quietRuleLine, ruleDotTone, staleHeartbeatRuleState, type RuleConfidenceLabel } from '@/components/accounts/autopilot-rule-card'
import { formatRelative, useNow, useRelativeTime } from '@/hooks/use-relative-time'
import { useStremioSyncRepair } from '@/hooks/useStremioSyncRepair'
import { maskNameLevel, normalizeAddonUrl } from '@/lib/utils'
import { useUIStore } from '@/store/uiStore'
import { findRuleOverlaps, getRuleMissingConnection } from '@/lib/autopilot-conflicts'
import {
    AUTOPILOT_FIX_LABEL, AUTOPILOT_SAFE_MODE_DETAIL, AUTOPILOT_SKIP_DETAIL, AUTOPILOT_WORKER_OFF_TITLE, describeRuleError, resolveAutopilotFreshness, resolveRuleFix, ruleConflictDetail, type AutopilotRuleFix,
} from '@/lib/autopilot-freshness'
import { getStremioConnection, useAccountStore } from '@/store/accountStore'
import { useFailoverStore, type AutopilotCycleStats, type AutopilotStabilizationEntry, type FailoverRule } from '@/store/failoverStore'

type ConfidenceVariant = 'muted' | 'primary' | 'success' | 'warning' | 'destructive'

interface RuleConfidenceLayerProps {
    rule: FailoverRule
    isAutopilotLive: boolean
    lastCycle?: AutopilotCycleStats
    activeAddonName: string
    primaryAddonName: string
    resolveAddon?: (url: string) => RehearsalAddon
}

interface ConfidenceState {
    label: RuleConfidenceLabel
    variant: ConfidenceVariant
    icon: LucideIcon
    detail: string
    proof?: string
    title?: string
}

function readCheckedAt(rule: FailoverRule) {
    if (!rule.lastCheck) return null
    const checkedAt = rule.lastCheck instanceof Date ? rule.lastCheck : new Date(rule.lastCheck)
    return Number.isFinite(checkedAt.getTime()) ? checkedAt : null
}

function readStabilizationEntry(rule: FailoverRule, url?: string): AutopilotStabilizationEntry {
    if (!url || !rule.stabilization) return {}
    const normalizedUrl = normalizeAddonUrl(url)
    const candidates = [url, url.toLowerCase(), normalizeAddonUrl(url), normalizedUrl]
    for (const key of candidates) {
        const entry = rule.stabilization[key]
        if (entry !== undefined) return normalizeStabilizationEntry(entry)
    }
    for (const [key, entry] of Object.entries(rule.stabilization)) {
        if (normalizeAddonUrl(key) === normalizedUrl) {
            return normalizeStabilizationEntry(entry)
        }
    }
    return {}
}

function normalizeStabilizationEntry(entry: number | AutopilotStabilizationEntry): AutopilotStabilizationEntry {
    if (typeof entry === 'number') {
        return {
            failures: entry < 0 ? Math.abs(entry) : 0,
            successes: entry > 0 ? entry : 0,
            latencyMs: null,
        }
    }
    const failures = Number(entry.failures)
    const successes = Number(entry.successes)
    const latencyMs = Number(entry.latencyMs)
    return {
        failures: Number.isFinite(failures) ? failures : 0,
        successes: Number.isFinite(successes) ? successes : 0,
        latencyMs: typeof entry.latencyMs === 'number' && Number.isFinite(latencyMs) ? latencyMs : null,
    }
}

function getConfidenceState(
    rule: FailoverRule,
    isAutopilotLive: boolean,
    lastCycle: AutopilotCycleStats | undefined,
    activeAddonName: string,
    primaryAddonName: string,
    statePullFailed: boolean,
    workerEnabled: boolean,
): ConfidenceState {
    const primaryUrl = rule.priorityChain[0]
    const activeUrl = rule.activeUrl || primaryUrl
    const primaryNorm = normalizeAddonUrl(primaryUrl || '')
    const activeNorm = normalizeAddonUrl(activeUrl || '')
    const chainNorms = new Set(rule.priorityChain.map(url => normalizeAddonUrl(url)))
    const checkedAt = readCheckedAt(rule)
    const ageMs = checkedAt ? Date.now() - checkedAt.getTime() : null
    const staleMs = lastCycle?.budgetHit ? 60 * 60 * 1000 : 15 * 60 * 1000
    const primaryEntry = readStabilizationEntry(rule, primaryUrl)
    const activeEntry = readStabilizationEntry(rule, activeUrl)
    const primaryFailures = primaryEntry.failures || 0
    const activeFailures = activeEntry.failures || 0
    const isFailedOver = !!activeNorm && !!primaryNorm && activeNorm !== primaryNorm
    const freshness = resolveAutopilotFreshness({ ageMs, staleMs, statePullFailed, skipReason: rule.skipReason })

    if (!rule.isActive) {
        return {
            label: 'Paused',
            variant: 'muted',
            icon: Pause,
            detail: 'Rule is paused; Autopilot will not enforce changes.',
        }
    }

    const conflictDetail = ruleConflictDetail(rule)
    if (conflictDetail) return { label: 'Needs attention', variant: 'warning', icon: AlertTriangle, detail: conflictDetail }

    if (rule.isAutomatic === false) {
        return {
            label: 'Manual',
            variant: 'primary',
            icon: Shield,
            detail: 'Manual mode is active; the current addon is preserved.',
            proof: `Active: ${activeAddonName}`,
        }
    }

    // A turned-off worker outranks the heartbeat: even a heartbeat younger than
    // the live window must not present an automatic rule as live or healthy.
    if ((!isAutopilotLive || workerEnabled === false) && !rule.skipReason) {
        const standby = staleHeartbeatRuleState(rule, { workerEnabled })
        const neverChecked = standby.label === 'Pending'
        return {
            label: standby.label,
            variant: neverChecked ? 'primary' : 'warning',
            icon: Activity,
            detail: standby.detail,
            title: standby.label === 'Turned off' ? AUTOPILOT_WORKER_OFF_TITLE : undefined,
            proof: neverChecked
                ? 'No server check has been recorded yet.'
                : standby.label === 'Turned off'
                    ? undefined
                    : `Last confirmed check was ${formatRelative(checkedAt) || 'just now'}.`,
        }
    }

    if (freshness === 'not-monitored' && rule.skipReason) {
        return {
            label: 'Not monitored',
            variant: 'warning',
            icon: AlertTriangle,
            detail: AUTOPILOT_SKIP_DETAIL[rule.skipReason],
            proof: checkedAt ? `Last check was ${formatRelative(checkedAt) || 'just now'}.` : undefined,
        }
    }

    if (freshness === 'unverified') {
        return {
            label: 'Unverified',
            variant: 'warning',
            icon: CloudOff,
            detail: "Couldn't reach server to confirm this rule's latest check.",
            proof: checkedAt ? `Last confirmed check was ${formatRelative(checkedAt) || 'just now'}.` : 'No server check has been recorded yet.',
        }
    }

    if (!checkedAt) {
        return {
            label: 'Pending',
            variant: 'primary',
            icon: Activity,
            detail: 'Waiting for the first server-side health check.',
            proof: lastCycle ? `${lastCycle.scanned} rules were scanned in the latest cycle.` : 'No worker cycle has reported yet.',
        }
    }

    if (activeNorm && !chainNorms.has(activeNorm)) {
        return {
            label: 'Needs attention',
            variant: 'destructive',
            icon: XCircle,
            detail: 'Active addon is outside this priority chain.',
            proof: `Active: ${activeAddonName}`,
        }
    }

    // A live worker can legitimately have an older per-rule timestamp while a
    // budgeted scan is working through a large public instance. Surface that
    // queue state before the generic stale warning; otherwise the UI says
    // "Stale" precisely when the worker is healthy but this rule is waiting.
    const queuedWindowMs = lastCycle
        ? Math.max(5 * 60 * 1000, Math.min(60 * 60 * 1000, Math.max(120_000, lastCycle.durationMs * 3)))
        : 0
    if (lastCycle?.budgetHit && ageMs !== null && ageMs > 120_000 && ageMs <= queuedWindowMs) {
        return {
            label: 'Queued',
            variant: 'primary',
            icon: Activity,
            detail: 'The worker is live and this rule is waiting in the scan budget.',
            proof: `${lastCycle.scanned} rules were scanned in ${Math.round(lastCycle.durationMs / 1000)}s.`,
        }
    }

    if (freshness === 'stale') {
        return {
            label: 'Stale',
            variant: 'warning',
            icon: AlertTriangle,
            detail: 'Last check is older than expected for this worker cadence.',
            proof: `Last check was ${formatRelative(checkedAt) || 'just now'}.`,
        }
    }

    if (primaryFailures >= 2 && !isFailedOver) {
        return {
            label: 'Needs attention',
            variant: 'destructive',
            icon: AlertTriangle,
            detail: 'Primary has repeated failures but is still marked active.',
            proof: `${primaryAddonName} has ${primaryFailures} consecutive misses.`,
        }
    }

    if (activeFailures >= 2) {
        return {
            label: 'Needs attention',
            variant: 'destructive',
            icon: AlertTriangle,
            detail: 'Active addon has repeated failures and no healthier fallback is active.',
            proof: `${activeAddonName} has ${activeFailures} consecutive misses.`,
        }
    }

    if (isFailedOver) {
        return {
            label: 'Backup active',
            variant: 'warning',
            icon: ArrowRight,
            detail: 'Fallback is active to protect playback.',
            proof: primaryFailures > 0
                ? `${primaryAddonName} missed ${primaryFailures} checks. Active addon: ${activeAddonName}.`
                : `Active: ${activeAddonName}`,
        }
    }

    return {
        label: 'No action needed',
        variant: 'success',
        icon: Check,
        detail: 'Primary addon is active; no change is needed.',
    }
}

/** The one fix for a stale rule, from the server's reason. Shared by the rule row and the header Autopilot popover. */
export function AutopilotRuleFixAction({ rule, fix, className, onRemove }: { rule: FailoverRule; fix: AutopilotRuleFix; className?: string; onRemove?: () => Promise<void> }) {
    const navigate = useNavigate()
    const now = useNow()
    const issue = useFailoverStore(s => s.restoreIssues[rule.id])
    const hasStremio = useAccountStore(s => {
        const account = s.accounts.find(a => a.id === rule.accountId)
        return !!account && !!getStremioConnection(account)?.credentials?.authKey
    })
    const { repair } = useStremioSyncRepair(rule.accountId)
    const [busy, setBusy] = useState(false)
    const [actionError, setActionError] = useState<string | null>(null)
    const inFlight = useRef(false)
    if (fix === 'safe-mode') return null
    const rateLimited = (fix === 'restore' || fix === 'grant-access') && !!issue?.retryAt && issue.retryAt > now
    const run = async () => {
        if (inFlight.current) return
        inFlight.current = true
        setBusy(true)
        setActionError(null)
        const store = useFailoverStore.getState()
        try {
            if (fix === 'restore') await store.restoreRuleOnServer(rule.id)
            else if (fix === 'remove') { if (onRemove) await onRemove(); else await store.removeRule(rule.id) }
            else if (fix === 'grant-access') {
                if (hasStremio) await repair()
                await store.restoreRuleOnServer(rule.id, { quiet: true })
            } else if (fix === 'reconnect') navigate(`/account/${encodeURIComponent(rule.accountId)}?tab=connections`)
            else if (fix === 'resume') await store.toggleRuleActive(rule.id, true)
            else if (fix === 'edit-chain') navigate(`/account/${encodeURIComponent(rule.accountId)}?tab=failover&editRule=${encodeURIComponent(rule.id)}`)
            else if (fix === 'retry-conflict') await store.retryRuleConflict(rule.id)
            else await store.pullServerState()
        } catch {
            if (fix === 'retry-conflict') setActionError('Unable to retry this rule. Try again.')
            else if (fix === 'remove') setActionError('Unable to remove this rule. Try again.')
        } finally {
            inFlight.current = false
            setBusy(false)
        }
    }
    const label = rateLimited ? 'Try again later' : issue && (fix === 'restore' || fix === 'grant-access') ? 'Try again' : AUTOPILOT_FIX_LABEL[fix]
    return (
        <div className={className ?? 'flex flex-col items-end gap-1'} data-testid="autopilot-rule-fix">
            {issue && <p className="break-words text-xs text-warning" role="alert">{issue.message}</p>}
            {actionError && <p className="break-words text-xs text-warning" role="alert">{actionError}</p>}
            <Button size="sm" variant="outline" className="h-7 gap-1.5 text-xs" onClick={run} disabled={busy || rateLimited}>
                {(fix === 'restore' || fix === 'refresh' || fix === 'grant-access' || fix === 'retry-conflict') && <RefreshCw className={`h-3 w-3 ${busy ? 'animate-spin' : ''}`} />}
                {busy ? 'Working...' : label}
            </Button>
        </div>
    )
}

/** Small header dot, rendered only for states that need a look. */
export function RuleHealthDot({ rule, isAutopilotLive, lastCycle }: { rule: FailoverRule; isAutopilotLive: boolean; lastCycle?: AutopilotCycleStats }) {
    const pullUnverified = useFailoverStore(s => s.statePullFailed || s.statePullPartial)
    const workerEnabled = useFailoverStore(s => s.workerEnabled)
    const { label } = getConfidenceState(rule, isAutopilotLive, lastCycle, '', '', pullUnverified, workerEnabled)
    const tone = rule.isActive && ruleConflictDetail(rule) ? 'warning' : ruleDotTone(label)
    if (!tone) return null
    return (
        <span role="img" aria-label={label} className={`h-2 w-2 shrink-0 rounded-full ${tone === 'destructive' ? 'bg-destructive' : 'bg-warning'}`} />
    )
}

function plainStatusSentence(label: RuleConfidenceLabel, rule: FailoverRule, primaryName: string, activeName: string, checkedAt: Date | null): string {
    if (label === 'Backup active') {
        const entry = readStabilizationEntry(rule, rule.priorityChain[0])
        const good = failoverTiming.goodChecks
        if ((entry.failures || 0) > 0) return `${primaryName} missed ${entry.failures} checks in a row. ${activeName} is on until ${primaryName} passes ${good} checks in a row.`
        if ((entry.successes || 0) > 0) return `${primaryName} is passing again (${entry.successes} of ${good} checks). ${activeName} stays on until it passes ${good} in a row.`
        return `${activeName} is on while ${primaryName} is down. It switches back after ${good} good checks in a row.`
    }
    const since = checkedAt ? checkedAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(checkedAt.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' as const } : {}) }) : null
    return `The server has not checked this rule${since ? ` since ${since}` : ''}, so it cannot switch right now. Checks resume when the server runs again.`
}

export function RuleConfidenceLayer({ rule, isAutopilotLive, lastCycle, activeAddonName, primaryAddonName, resolveAddon }: RuleConfidenceLayerProps) {
    const [rehearseOpen, setRehearseOpen] = useState(false)
    const now = useNow()
    const account = useAccountStore(s => s.accounts.find(a => a.id === rule.accountId))
    const rules = useFailoverStore(s => s.rules)
    const privacyNameLevel = useUIStore(s => s.isPrivacyModeEnabled ? s.privacyLevelNames : 0)
    const formatRelativeLabel = useRelativeTime()
    const checkedAt = readCheckedAt(rule)
    const activeUrl = rule.activeUrl || rule.priorityChain[0]
    const activeEntry = readStabilizationEntry(rule, activeUrl)
    const pullUnverified = useFailoverStore(s => s.statePullFailed || s.statePullPartial)
    const workerEnabled = useFailoverStore(s => s.workerEnabled)
    const safeMode = useFailoverStore(s => s.safeMode)
    // Primitive-only reads: no per-notification id array, and membership from the
    // tombstone records directly (same rule as liveAccountCheck).
    const accountExists = useAccountStore((s) => {
        const deleted = s.deletedAccounts[rule.accountId]
        return s.accounts.some(a => a.id === rule.accountId) && !(deleted !== undefined && deleted >= (s.restoredAccounts[rule.accountId] ?? 0))
    })
    const confidence = getConfidenceState(rule, isAutopilotLive, lastCycle, activeAddonName, primaryAddonName, pullUnverified, workerEnabled)
    const Icon = confidence.icon
    const checkedRelative = checkedAt ? formatRelativeLabel(checkedAt) || 'just now' : null
    const lastCheckLabel = checkedRelative ? `Last checked ${checkedRelative}` : 'Check pending'
    const errorLabel = rule.isActive ? describeRuleError(rule.lastError) : null
    const latencyMs = typeof activeEntry.latencyMs === 'number' ? activeEntry.latencyMs : null
    const latencyLabel = latencyMs !== null ? `Latency ${Math.round(latencyMs)}ms` : null
    const stale = confidence.label === 'Stale' || confidence.label === 'Not monitored'
    const fix = isAutopilotLive || rule.skipReason === 'not_on_server' || !rule.isActive || !!ruleConflictDetail(rule)
        ? resolveRuleFix(rule, { accountExists, safeMode, stale })
        : null

    const missingConnection = getRuleMissingConnection(rule, account)
    const overlap = rule.lastError?.code === 'chain_overlap' ? findRuleOverlaps(rule, rules, account?.addons || [])[0] : undefined
    const overlapAddon = overlap ? account?.addons.find(addon => normalizeAddonUrl(addon.transportUrl) === normalizeAddonUrl(overlap.url)) : undefined
    const overlapName = overlapAddon ? maskNameLevel(overlapAddon.metadata?.customName || overlapAddon.manifest.name || 'An addon', privacyNameLevel) : undefined
    const conflictDetail = rule.isActive ? ruleConflictDetail(rule, overlapName) : null
    const warning = missingConnection
        ? `${missingConnection.label}. ${rule.isActive ? 'This rule has no login to run on.' : 'This rule is paused.'}`
        : conflictDetail
    if (warning && !safeMode) {
        return (
            <div data-theme-part="panel" className="mx-2 rounded-xl border border-border/40 bg-muted/20 px-3 py-2.5" data-testid="rule-conflict-warning">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <p className="flex min-w-0 items-start gap-2 text-sm text-warning">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                        <span className="break-words">{warning}</span>
                    </p>
                    {!missingConnection && fix && <AutopilotRuleFixAction rule={rule} fix={fix} className="flex shrink-0 flex-col items-end gap-1" />}
                </div>
            </div>
        )
    }

    const rehearse = resolveAddon ? () => setRehearseOpen(true) : undefined
    const rehearseSheet = resolveAddon && rehearseOpen ? <RehearseSheet open onOpenChange={setRehearseOpen} rule={rule} resolveAddon={resolveAddon} /> : null

    if (isQuietRuleState(confidence.label, { fix, hasError: !!errorLabel })) {
        if (confidence.label !== 'No action needed') {
            return (
                <p className="mx-2 text-right text-xs tabular-nums text-muted-foreground" data-testid="rule-quiet-status">
                    {quietRuleLine(confidence.label, { checkedLabel: checkedRelative, latencyMs })}
                </p>
            )
        }
        const watchingAgo = checkedAt ? agoLabel(now - checkedAt.getTime()) : null
        return (
            <>
                <WatchingLine line={quietRuleLine(confidence.label, { checkedLabel: watchingAgo, latencyMs })} rule={rule} onRehearse={rehearse} />
                {rehearseSheet}
            </>
        )
    }

    if ((confidence.label === 'Backup active' || confidence.label === 'Standby' || confidence.label === 'Stale') && fix !== 'safe-mode') {
        const kind = confidence.label === 'Backup active' ? 'backup' : 'stale'
        return (
            <>
                <PlainStatusPanel
                    kind={kind}
                    sentence={plainStatusSentence(confidence.label, rule, primaryAddonName, activeAddonName, checkedAt)}
                    action={kind === 'stale' ? <AutopilotRuleFixAction rule={rule} fix={fix ?? 'refresh'} /> : fix ? <AutopilotRuleFixAction rule={rule} fix={fix} /> : undefined}
                    errorLine={errorLabel ? (
                        <p className="mt-1 flex items-center gap-1 text-xs text-warning" data-testid="rule-last-error">
                            <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
                            <span className="min-w-0 break-words">{errorLabel}</span>
                        </p>
                    ) : undefined}
                    onRehearse={rehearse}
                />
                {rehearseSheet}
            </>
        )
    }

    return (
        <div data-theme-part="panel" className="mx-2 rounded-xl border border-border/40 bg-muted/20 px-3 py-2.5">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <Popover>
                        <PopoverTrigger asChild>
                            <button type="button" className="shrink-0 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`${confidence.label} details`}>
                                <StatusChip variant={confidence.variant} size="sm">
                                    <Icon />
                                    {confidence.label}
                                    <ChevronDown className="opacity-70" />
                                </StatusChip>
                            </button>
                        </PopoverTrigger>
                        <PopoverContent align="start" className="w-[min(18rem,92vw)] space-y-1.5 p-3 text-xs">
                            <p className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                                <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                                {confidence.title ?? confidence.label}
                            </p>
                            <p className="break-words text-foreground/80">{confidence.detail}</p>
                            {confidence.proof && <p className="break-words text-muted-foreground">{confidence.proof}</p>}
                        </PopoverContent>
                    </Popover>
                    <span className="min-w-0 break-words text-sm text-foreground/90">
                        {confidence.detail}
                    </span>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                    <StatusChip variant="muted" size="sm">
                        {lastCheckLabel}
                    </StatusChip>
                    {latencyLabel && (
                        <StatusChip variant="muted" size="sm">
                            {latencyLabel}
                        </StatusChip>
                    )}
                    {fix && fix !== 'safe-mode' && <AutopilotRuleFixAction rule={rule} fix={fix} />}
                </div>
            </div>
            {confidence.proof && <p className="mt-1 text-xs text-muted-foreground/60">{confidence.proof}</p>}
            {fix === 'safe-mode' && <p className="mt-1 text-xs text-muted-foreground">{AUTOPILOT_SAFE_MODE_DETAIL}</p>}
            {errorLabel && (
                <p className="mt-1 flex items-center gap-1 text-xs text-warning" data-testid="rule-last-error">
                    <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
                    <span className="min-w-0 break-words">{errorLabel}</span>
                </p>
            )}
        </div>
    )
}
