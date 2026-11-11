import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ArrowRightLeft, CheckCircle2, Clock, FlaskConical, Loader2, RefreshCw, Shield, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { StatusChip } from '@/components/ui/status-chip'
import { checkAddonHealth } from '@/lib/addon-health'
import {
    failoverTiming, rehearsalNotification, rehearsalPlatforms, rehearseFailover, type RehearsalResult, type RehearsalTier,
} from '@/lib/failover-rehearsal'
import { getPlatformEntry } from '@/lib/platform-registry'
import { apiFetch } from '@/lib/http-client'
import { maskNameLevel, maskUrlLevel, normalizeAddonUrl } from '@/lib/utils'
import { useAccountStore } from '@/store/accountStore'
import { type FailoverRule } from '@/store/failoverStore'
import { useUIStore } from '@/store/uiStore'
import { PlatformLogo } from '@/components/providers/ConnectionPrimitives'

export interface RehearsalAddon {
    name: string
    logo?: string
}

interface RehearseSheetProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    rule: FailoverRule
    resolveAddon: (url: string) => RehearsalAddon
}

interface TierCheck {
    checking: boolean
    healthy: boolean
    latencyMs?: number
    error?: string
}

// The engine treats an unreachable custom check as deferred (says nothing about the addon); an HTTP error or a blocked URL still fails it.
interface CustomCheck {
    checking: boolean
    outcome?: 'pass' | 'deferred' | 'failed'
}

const BLOCKED_ERROR = 'Blocked unsafe redirect or no response'

const hostOf = (url: string) => {
    try { return new URL(url).host || url } catch { return url }
}

const sameUrl = (a: string, b: string) => normalizeAddonUrl(a).toLowerCase() === normalizeAddonUrl(b).toLowerCase()

function CustomCheckRow({ url, state }: { url: string; state?: CustomCheck }) {
    return (
        <div className="flex h-10 items-center gap-2 rounded-xl px-1.5 text-sm sm:gap-2.5 sm:px-2.5">
            <span className="w-5 shrink-0" />
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-muted/50"><Shield className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" /></span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground" title={url}>{hostOf(url)}</span>
            {!state || state.checking ? <StatusChip variant="muted" icon={<Loader2 className="animate-spin" />}>Checking</StatusChip>
                : state.outcome === 'pass' ? <StatusChip variant="success" icon={<CheckCircle2 />}>Pass</StatusChip>
                    : state.outcome === 'deferred' ? <StatusChip variant="muted" icon={<Clock />}>Deferred</StatusChip>
                        : <StatusChip variant="destructive" icon={<XCircle />}>Failed</StatusChip>}
            <span className="hidden w-24 text-right text-xs text-muted-foreground sm:block">Custom check</span>
        </div>
    )
}

export function RehearseSheet({ open, onOpenChange, rule, resolveAddon }: RehearseSheetProps) {
    const account = useAccountStore(s => s.accounts.find(a => a.id === rule.accountId))
    const privacyNameLevel = useUIStore(s => (s.isPrivacyModeEnabled ? s.privacyLevelNames : 0))
    const privacyUrlLevel = useUIStore(s => (s.isPrivacyModeEnabled ? s.privacyLevelUrls : 0))
    const [pretend, setPretend] = useState(0)
    const [tierChecks, setTierChecks] = useState<Record<string, TierCheck>>({})
    const [customChecks, setCustomChecks] = useState<Record<string, CustomCheck>>({})
    const run = useRef(0)

    const chain = rule.priorityChain
    const applicableChecks = useMemo(() => (rule.customCheckUrls || []).filter(check =>
        check.appliesTo.length === 0 || check.appliesTo.some(url => chain.some(member => sameUrl(member, url)))), [rule.customCheckUrls, chain])

    const runChecks = useCallback(async () => {
        const id = ++run.current
        const live = () => run.current === id
        setTierChecks(Object.fromEntries(chain.map(url => [url, { checking: true, healthy: false }])))
        setCustomChecks(Object.fromEntries(applicableChecks.map(check => [check.url, { checking: true }])))
        await Promise.all([
            ...chain.map(async url => {
                let next: TierCheck
                try {
                    const health = await checkAddonHealth(url)
                    next = { checking: false, healthy: health.isOnline, latencyMs: health.latencyMs, error: health.error }
                } catch {
                    next = { checking: false, healthy: false, error: 'Check failed' }
                }
                if (live()) setTierChecks(prev => ({ ...prev, [url]: next }))
            }),
            ...[...new Set(applicableChecks.map(check => check.url))].map(async url => {
                let outcome: CustomCheck['outcome'] = 'failed'
                try {
                    const { useSyncStore } = await import('@/store/syncStore')
                    const { serverUrl } = useSyncStore.getState()
                    const result = await apiFetch<{ ok?: boolean; status?: number; error?: string }>('/autopilot/test-url', {
                        method: 'POST',
                        baseUrl: (serverUrl || '').startsWith('http') ? serverUrl : undefined,
                        body: { url },
                    })
                    const data = result.ok ? result.data : undefined
                    if (data?.ok) outcome = 'pass'
                    else if (data && data.status === 0 && data.error !== BLOCKED_ERROR) outcome = 'deferred'
                } catch {
                    outcome = 'deferred'
                }
                if (live()) setCustomChecks(prev => ({ ...prev, [url]: { checking: false, outcome } }))
            }),
        ])
    }, [chain, applicableChecks])

    useEffect(() => {
        if (!open) {
            run.current++
            return
        }
        setPretend(0)
        void runChecks()
    }, [open, runChecks])

    const settled = chain.every(url => tierChecks[url] && !tierChecks[url].checking)
        && applicableChecks.every(check => customChecks[check.url] && !customChecks[check.url].checking)

    const tiers: RehearsalTier[] = chain.map(url => {
        const sunk = applicableChecks.some(check => (check.appliesTo.length === 0 || check.appliesTo.some(member => sameUrl(member, url))) && customChecks[check.url]?.outcome === 'failed')
        return { url, name: maskNameLevel(resolveAddon(url).name, privacyNameLevel), healthy: !!tierChecks[url]?.healthy && !sunk }
    })
    const activeUrl = rule.activeUrl || chain[0]
    const activeIndex = chain.findIndex(url => sameUrl(url, activeUrl || ''))
    const result: RehearsalResult | null = settled ? rehearseFailover({ tiers, activeIndex, pretendIndex: pretend }) : null

    const nameOf = (index: number) => tiers[index]?.name ?? 'The active addon'
    const accountName = account ? maskNameLevel(account.name, privacyNameLevel) : ''
    const hasTarget = !!result && (result.kind === 'switch' || result.kind === 'recover')
    const platforms = hasTarget && account ? rehearsalPlatforms(account, rule, chain[result.targetIndex]) : []
    const notification = hasTarget
        ? rehearsalNotification({
            type: result.notificationType,
            template: rule.messageTemplate,
            accountName,
            ruleName: rule.name,
            fromUrl: privacyUrlLevel > 0 ? maskUrlLevel(chain[0], privacyUrlLevel) : chain[0],
            targetUrl: privacyUrlLevel > 0 ? maskUrlLevel(chain[result.targetIndex], privacyUrlLevel) : chain[result.targetIndex],
        })
        : null
    const notifyOff = rule.notifyEnabled === false
    const webhookLabel = rule.webhookUrl ? 'Rule webhook' : 'Global webhook'

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="!grid-cols-none !gap-0 !p-0 flex flex-col overflow-hidden !max-h-[92vh] rounded-t-3xl sm:!max-w-lg text-card-foreground" data-testid="rehearse-sheet">
                <div className="shrink-0 bg-card px-4 pb-3 pt-1 sm:px-8 sm:pb-5 sm:pt-3">
                    <DialogTitle className="flex min-w-0 items-center gap-2"><FlaskConical className="h-5 w-5 text-primary" aria-hidden="true" />Rehearse a failover</DialogTitle>
                    <p className="mt-2 text-sm text-foreground/60">Nothing changes. Pick an addon to pretend is down and see what Autopilot would do.</p>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                    <div className="space-y-5 px-4 py-4 sm:px-8 sm:py-6">
                        <div className="space-y-1.5">
                            <Label htmlFor="rehearse-pretend">Pretend this addon is down</Label>
                            <Select value={String(pretend)} onValueChange={value => setPretend(Number(value))}>
                                <SelectTrigger id="rehearse-pretend" aria-label="Pretend this addon is down"><SelectValue /></SelectTrigger>
                                <SelectContent>
                                    {tiers.map((tier, i) => <SelectItem key={tier.url} value={String(i)}>{tier.name}</SelectItem>)}
                                </SelectContent>
                            </Select>
                        </div>

                        <div data-theme-part="panel" className="space-y-1 rounded-2xl border border-border/40 bg-card p-3 shadow-sm sm:p-4">
                            {tiers.map((tier, i) => {
                                const check = tierChecks[tier.url]
                                const logo = resolveAddon(tier.url).logo
                                const underChecks = applicableChecks.filter(c => c.appliesTo.length > 0 && c.appliesTo.some(member => sameUrl(member, tier.url)))
                                return (
                                    <div key={tier.url} className="space-y-1">
                                        <div className="flex h-10 items-center gap-2 rounded-xl px-1.5 text-sm sm:gap-2.5 sm:px-2.5">
                                            <span className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted/50">
                                                {logo
                                                    ? <img src={logo} alt="" className="h-full w-full object-contain" />
                                                    : <span className="text-[10px] font-semibold text-muted-foreground">{(tier.name || '?').charAt(0).toUpperCase()}</span>}
                                            </span>
                                            <span className="min-w-0 flex-1 truncate">{tier.name}</span>
                                            {i === pretend ? (
                                                <StatusChip variant="destructive" icon={<XCircle />}>Pretending down</StatusChip>
                                            ) : !check || check.checking ? (
                                                <StatusChip variant="muted" icon={<Loader2 className="animate-spin" />}>Checking</StatusChip>
                                            ) : tier.healthy ? (
                                                <>
                                                    {typeof check.latencyMs === 'number' && <span className="hidden text-xs tabular-nums text-muted-foreground sm:inline">{Math.round(check.latencyMs)} ms</span>}
                                                    <StatusChip variant="success" icon={<CheckCircle2 />}>Healthy</StatusChip>
                                                </>
                                            ) : (
                                                <StatusChip variant="destructive" icon={<XCircle />}>Down</StatusChip>
                                            )}
                                        </div>
                                        {underChecks.map(c => <CustomCheckRow key={c.url} url={c.url} state={customChecks[c.url]} />)}
                                    </div>
                                )
                            })}
                            {applicableChecks.filter(check => check.appliesTo.length === 0).map(check => <CustomCheckRow key={check.url} url={check.url} state={customChecks[check.url]} />)}
                        </div>

                        {result && (
                            <div
                                data-testid="rehearse-verdict"
                                className="flex items-start gap-2.5 rounded-xl border border-border/40 bg-muted/20 px-3.5 py-2.5 text-sm text-muted-foreground"
                            >
                                {result.kind === 'outage'
                                    ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
                                    : <ArrowRightLeft className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />}
                                <span>
                                    {result.kind === 'switch' && <>After {failoverTiming.missedChecks} missed checks (about {failoverTiming.switchMinutes} min), Autopilot switches to <b className="font-semibold text-foreground">{nameOf(result.targetIndex)}</b>.{result.targetIndex > result.activeIndex ? ` It switches back after ${failoverTiming.goodChecks} good checks.` : ''}</>}
                                    {result.kind === 'recover' && <><b className="font-semibold text-foreground">{nameOf(result.targetIndex)}</b> is passing. Autopilot switches back to it after {failoverTiming.goodChecks} good checks (about {failoverTiming.backMinutes} min).</>}
                                    {result.kind === 'stay' && (result.activeIndex === -1
                                        ? 'Nothing changes. The active addon is not in this chain.'
                                        : `Nothing changes. ${nameOf(result.activeIndex)} stays on.`)}
                                    {result.kind === 'outage' && `Nothing to switch to. Autopilot keeps ${nameOf(result.activeIndex)} and keeps checking. No notification is sent until a switch happens.`}
                                </span>
                            </div>
                        )}

                        {hasTarget && result && (
                            <div className="space-y-2">
                                <h4 className="text-sm font-semibold">{platforms.length === 0 ? 'Platforms' : `Changes on ${platforms.length} platform${platforms.length === 1 ? '' : 's'}`}</h4>
                                {platforms.length === 0 && <p className="text-sm text-muted-foreground">No platform is connected to this account, so nothing would be written.</p>}
                                <ul className="space-y-2">
                                    {platforms.map(platform => {
                                        const entry = getPlatformEntry(platform.platformId)
                                        const from = result.activeIndex === -1 ? '' : nameOf(result.activeIndex)
                                        return (
                                            <li key={platform.platformId} data-theme-part="card" data-testid="rehearse-platform" className="flex items-center gap-3 rounded-2xl border border-border/40 bg-card/50 p-3 shadow-sm">
                                                <PlatformLogo platform={platform.platformId} className="h-6 w-6 shrink-0" />
                                                <div className="min-w-0 flex-1">
                                                    <p className="text-sm font-semibold">{entry?.name ?? platform.platformId}{platform.logins > 1 ? ` (${platform.logins} logins)` : ''}</p>
                                                    <p className="break-words text-sm text-muted-foreground">
                                                        {platform.excluded
                                                            ? `${nameOf(result.targetIndex)} is not sent here`
                                                            : `Turn on ${nameOf(result.targetIndex)}${from ? `, turn off ${from}` : ''}`}
                                                    </p>
                                                </div>
                                                {platform.needsLogin && <StatusChip variant="warning" icon={<AlertTriangle />}>Needs login</StatusChip>}
                                            </li>
                                        )
                                    })}
                                </ul>
                            </div>
                        )}

                        {hasTarget && notification && (
                            <div className="space-y-2">
                                <h4 className="text-sm font-semibold">Notification</h4>
                                {notifyOff
                                    ? <p className="text-sm text-muted-foreground">Notifications are off for this rule.</p>
                                    : (
                                        <div data-theme-part="panel" className="space-y-1 rounded-2xl border border-border/40 bg-muted/20 p-3 text-sm" data-testid="rehearse-notification">
                                            <p className="font-semibold">{notification.title}</p>
                                            <p className="break-all text-muted-foreground">{notification.message}</p>
                                            <p className="text-xs text-muted-foreground/60">{webhookLabel}</p>
                                        </div>
                                    )}
                            </div>
                        )}
                    </div>
                </div>

                <div className="shrink-0 bg-card px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-8">
                    <div className="flex justify-end gap-3 [&_button]:h-11 [&_button]:rounded-full [&_button]:px-5">
                        <Button variant="outline" size="sm" onClick={() => void runChecks()} disabled={!settled}>
                            <RefreshCw className="h-4 w-4" />Run again
                        </Button>
                        <Button size="sm" onClick={() => onOpenChange(false)}>Done</Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    )
}
