import { Button } from "@/components/ui/button"
import { StatusChip } from "@/components/ui/status-chip"
import { ToolbarShell } from "@/components/ui/toolbar-shell"
import { Switch } from "@/components/ui/switch"
import { TabsContent, TabsTrigger } from "@/components/ui/tabs"
import { WorkspaceTabs } from "@/components/ui/workspace-tabs"
import { useAccountStore } from "@/store/accountStore"
import { useFailoverStore } from "@/store/failoverStore"
import type { FailoverRule } from "@/store/failoverStore"
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Activity, Trash2, Plus, History, Pencil, Webhook, Copy, Download, FlaskConical, XCircle, X, CheckCircle2, ArrowRightLeft, Clock, Loader2, Play, Pause, MoreVertical, Shield, Timer, Send, AlertTriangle } from "lucide-react"
import { useState, useMemo, useCallback, useEffect, useRef } from "react"
import { useSearchParams } from 'react-router-dom'
import {
    DndContext,
    closestCenter,
    MouseSensor,
    TouchSensor,
    KeyboardSensor,
    useSensor,
    useSensors,
    DragEndEvent,
} from '@dnd-kit/core'
import {
    arrayMove,
    SortableContext,
    sortableKeyboardCoordinates,
    verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { restrictToVerticalAxis } from '@dnd-kit/modifiers'
import { identifyAddon } from "@/lib/addon-identifier"
import { toast } from "@/hooks/use-toast"
import { checkAddonHealth } from "@/lib/addon-health"
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog"
import { Tooltip } from "@/components/ui/tooltip"
import { RuleConfidenceLayer, RuleHealthDot } from "@/components/accounts/RuleConfidenceLayer"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cooldownLabel, ruleCountLabel, ruleWebhookKind, showToolbarStatusChip, TOOLBAR_STATUS_DETAIL, webhookDisplayUrl } from "@/components/accounts/autopilot-rule-card"
import { useUIStore } from "@/store/uiStore"
import { FailoverHistory } from "@/components/accounts/FailoverHistory"
import { SortableChainTier, SortableRuleWrapper } from "@/components/accounts/SortableFailoverTiers"
import { WebhooksPanel, testWebhook } from "@/components/accounts/WebhooksPanel"
import { RuleDialog } from "@/components/accounts/RuleDialog"
import type { CustomCheckEntry } from "@/components/accounts/RuleDialog"
import { maskNameLevel, normalizeAddonUrl } from "@/lib/utils"
import { normalizeAddonUrlForMatch } from '@/lib/addon-url'
import { simulationVerdict } from './simulation-verdict'
import { findRuleOverlaps, getRuleMissingConnection, ruleAddonReference, ruleDisplayName } from '@/lib/autopilot-conflicts'
import { AUTOPILOT_PARTIAL_DETAIL, AUTOPILOT_SAFE_MODE_DETAIL, AUTOPILOT_UNREACHABLE_DETAIL, AUTOPILOT_WORKER_OFF_DETAIL, AUTOPILOT_WORKER_OFF_TITLE, autopilotBulkActions, isAutopilotServerLive, recordFirstSeen, resolveAutopilotChip } from "@/lib/autopilot-freshness"
import { useNow } from "@/hooks/use-relative-time"
import { apiFetch } from "@/lib/http-client"

export type FailoverView = 'rules' | 'history' | 'webhooks'

interface FailoverManagerProps {
    accountId: string
    activeView?: FailoverView
    onActiveViewChange?: (view: FailoverView) => void
    showViewTabs?: boolean
}

export function FailoverManager({
    accountId,
    activeView,
    onActiveViewChange,
    showViewTabs = true,
}: FailoverManagerProps) {
    const accounts = useAccountStore((state) => state.accounts)
    const account = accounts.find((a) => a.id === accountId)
    const rules = useFailoverStore(s => s.rules)
    const addRule = useFailoverStore(s => s.addRule)
    const updateRule = useFailoverStore(s => s.updateRule)
    const removeRule = useFailoverStore(s => s.removeRule)
    const reorderRules = useFailoverStore(s => s.reorderRules)
    const lastWorkerRun = useFailoverStore(s => s.lastWorkerRun)
    const lastCycle = useFailoverStore(s => s.lastCycle)
    const toggleAllRulesForAccount = useFailoverStore(s => s.toggleAllRulesForAccount)
    const safeMode = useFailoverStore(s => s.safeMode)
    const statePullFailed = useFailoverStore(s => s.statePullFailed)
    const statePullPartial = useFailoverStore(s => s.statePullPartial)
    const pulseUnreachable = useFailoverStore(s => s.pulseUnreachable)
    const workerEnabled = useFailoverStore(s => s.workerEnabled)
    const lastCompletePullAt = useFailoverStore(s => s.lastCompletePullAt)
    const privacyUrlLevel = useUIStore(s => (s.isPrivacyModeEnabled ? s.privacyLevelUrls : 0))
    const privacyNameLevel = useUIStore(s => s.isPrivacyModeEnabled ? s.privacyLevelNames : 0)
    const [searchParams, setSearchParams] = useSearchParams()
    const now = useNow()
    const firstSeenRef = useRef(new Map<string, number>())
    const isAutopilotLive = isAutopilotServerLive(lastWorkerRun, now)

    const [simulatingRuleId, setSimulatingRuleId] = useState<string | null>(null)
    const [simulationResults, setSimulationResults] = useState<Record<string, { healthy: boolean; checking: boolean; error?: string; latencyMs?: number }>>({})
    const [simulatedCustomChecks, setSimulatedCustomChecks] = useState<CustomCheckEntry[]>([])
    const [customCheckResults, setCustomCheckResults] = useState<Record<string, { healthy: boolean; checking: boolean; error?: string; code?: number }>>({})
    // Escape closes an open simulation card first and consumes the key, so the sheet behind it stays.
    useEffect(() => {
        if (!simulatingRuleId) return
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape' || event.defaultPrevented) return
            event.preventDefault()
            setSimulatingRuleId(null)
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => document.removeEventListener('keydown', onKeyDown, true)
    }, [simulatingRuleId])
    const [isRuleDialogOpen, setIsRuleDialogOpen] = useState(false)
    const [editingRule, setEditingRule] = useState<FailoverRule | null>(null)
    const [ruleToDelete, setRuleToDelete] = useState<string | null>(null)
    const [keptResidue, setKeptResidue] = useState<Record<string, string>>({})
    const [removingResidue, setRemovingResidue] = useState<string | null>(null)
    const [residueError, setResidueError] = useState<string | null>(null)
    const [memberReferences, setMemberReferences] = useState<Record<string, string>>({})
    const [localActiveFailoverTab, setLocalActiveFailoverTab] = useState<FailoverView>("rules")
    const activeFailoverTab = activeView ?? localActiveFailoverTab
    const handleFailoverTabChange = useCallback((value: string) => {
        const next = value as FailoverView
        if (activeView === undefined) {
            setLocalActiveFailoverTab(next)
        }
        onActiveViewChange?.(next)
    }, [activeView, onActiveViewChange])

    const openRuleEditor = (rule: FailoverRule) => {
        setEditingRule(rule)
        handleFailoverTabChange("rules")
        setIsRuleDialogOpen(true)
    }

    const requestedRuleId = searchParams.get('editRule')
    useEffect(() => {
        // A zero-rule visit still needs the global worker flag once; pulse() throttles itself.
        if (useFailoverStore.getState().rules.length > 0) return
        void useFailoverStore.getState().pulse()
    }, [])
    useEffect(() => {
        if (!requestedRuleId) return
        const requestedRule = rules.find(rule => rule.id === requestedRuleId && rule.accountId === accountId)
        if (!requestedRule) return
        setEditingRule(requestedRule)
        setIsRuleDialogOpen(true)
        handleFailoverTabChange('rules')
        const next = new URLSearchParams(searchParams)
        next.delete('editRule')
        setSearchParams(next, { replace: true })
    }, [requestedRuleId, rules, accountId, searchParams, setSearchParams, handleFailoverTabChange])

    const referenceUrls = useMemo(() => [...new Set(rules.filter(rule => rule.accountId === accountId && rule.lastError?.affectedRefs?.length).flatMap(rule => rule.priorityChain))], [rules, accountId])
    const referenceKey = JSON.stringify(referenceUrls)
    useEffect(() => {
        let cancelled = false
        const urls: string[] = JSON.parse(referenceKey)
        void Promise.all(urls.map(async url => [normalizeAddonUrlForMatch(url), await ruleAddonReference(url)] as const))
            .then(entries => { if (!cancelled) setMemberReferences(Object.fromEntries(entries)) })
            .catch(() => {})
        return () => { cancelled = true }
    }, [referenceKey])

    const otherAccountsWithRules = useMemo(() => {
        return accounts
            .filter(a => a.id !== accountId)
            .map(a => ({
                ...a,
                ruleCount: rules.filter(r => r.accountId === a.id).length
            }))
            .filter(a => a.ruleCount > 0)
    }, [accounts, accountId, rules])

    // Build a cross-account addon lookup ONLY for name resolution of imported/copied rules.
    // This should NOT be used for the selection dropdown.
    const allAddonsForLabeling = useMemo(() => {
        const localAddons = accounts.find(a => a.id === accountId)?.addons || []
        const merged = [...localAddons]
        for (const acc of accounts) {
            if (acc.id === accountId) continue
            for (const addon of acc.addons) {
                if (!merged.some(a => a.transportUrl === addon.transportUrl)) {
                    merged.push(addon)
                }
            }
        }
        return merged
    }, [accounts, accountId])

    const handleDuplicateRule = async (rule: typeof rules[0]) => {
        try {
            await addRule(accountId, [...rule.priorityChain], rule.name, rule.cooldown_ms, rule.webhookUrl, rule.notifyEnabled, rule.messageTemplate, rule.customCheckUrls?.map(c => ({ ...c })) || [])
            toast({ title: 'Rule Duplicated', description: 'A copy of the priority chain has been created.' })
        } catch {
            toast({ title: 'Rule not duplicated', description: 'An addon can only belong to one Autopilot rule. Edit the existing chain instead.', variant: 'destructive' })
        }
    }

    const handleCopyRulesFrom = async (sourceAccountId: string) => {
        const sourceRules = rules.filter(r => r.accountId === sourceAccountId)
        if (sourceRules.length === 0) return

        let imported = 0
        let failed = 0
        for (const rule of sourceRules) {
            try {
                await addRule(
                accountId,
                [...rule.priorityChain],
                rule.name,
                rule.cooldown_ms,
                rule.webhookUrl,
                rule.notifyEnabled,
                rule.messageTemplate,
                rule.customCheckUrls?.map(c => ({ ...c })) || []
            )
                imported++
            } catch { failed++ }
        }

        const sourceName = accounts.find(a => a.id === sourceAccountId)?.name || 'Unknown'
        toast({
            title: failed > 0 ? 'Some rules were not imported' : 'Rules Imported',
            description: `Copied ${imported} rule${imported !== 1 ? 's' : ''} from ${sourceName}.${failed > 0 ? ` ${failed} could not be saved. Check for addons already used by another rule.` : ''}`,
            ...(failed > 0 ? { variant: 'destructive' as const } : {}),
        })
    }

    const getApplicableCustomChecks = (chain: string[], customCheckUrls?: CustomCheckEntry[]) => {
        const normalizedChainUrls = chain.map(u => normalizeAddonUrl(u).toLowerCase())
        return (customCheckUrls || []).filter(c =>
            c.appliesTo.length === 0 ||
            c.appliesTo.some(au => normalizedChainUrls.includes(normalizeAddonUrl(au).toLowerCase()))
        )
    }

    const renderCustomCheckRow = (entry: CustomCheckEntry) => {
        const result = customCheckResults[entry.url]
        let host = entry.url
        try { host = new URL(entry.url).host || entry.url } catch { host = entry.url }
        return (
            <div className="flex h-10 items-center gap-2 rounded-xl px-1.5 text-sm sm:gap-2.5 sm:px-2.5">
                <span className="w-5 shrink-0" />
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-muted/50">
                    <Shield className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    <Tooltip content={entry.url}>
                        <span>{host}</span>
                    </Tooltip>
                </span>
                {typeof result?.code === 'number' && <span className="hidden shrink-0 font-mono text-[10px] text-muted-foreground sm:inline">{result.code}</span>}
                <div className="flex shrink-0 items-center gap-2">
                    {result?.checking ? (
                        <StatusChip variant="muted" icon={<Loader2 className="animate-spin" />}>Checking</StatusChip>
                    ) : !result ? (
                        <StatusChip variant="muted" icon={<Clock />}>Queued</StatusChip>
                    ) : result.healthy ? (
                        <StatusChip variant="success" icon={<CheckCircle2 />}>Pass</StatusChip>
                    ) : (
                        <>
                            {result.error && (
                                <Tooltip content={result.error}>
                                    <span className="hidden max-w-[120px] truncate text-xs text-muted-foreground sm:inline">{result.error}</span>
                                </Tooltip>
                            )}
                            <StatusChip variant="warning" icon={<AlertTriangle />}>Deferred</StatusChip>
                        </>
                    )}
                </div>
                <span className="hidden w-24 text-right text-xs text-muted-foreground sm:block">Custom check</span>
            </div>
        )
    }

    const handleSimulateRule = async (ruleId: string, chain: string[], customCheckUrls?: CustomCheckEntry[]) => {
        setSimulatingRuleId(ruleId)
        setSimulationResults({})
        setCustomCheckResults({})
        const applicableChecks = getApplicableCustomChecks(chain, customCheckUrls)
        setSimulatedCustomChecks(applicableChecks)

        for (const url of chain) {
            setSimulationResults(prev => ({
                ...prev,
                [url]: { healthy: false, checking: true }
            }))

            try {
                const health = await checkAddonHealth(url)
                setSimulationResults(prev => ({
                    ...prev,
                    [url]: { healthy: health.isOnline, checking: false, error: health.error, latencyMs: health.latencyMs }
                }))
            } catch (err) {
                setSimulationResults(prev => ({
                    ...prev,
                    [url]: { healthy: false, checking: false, error: 'Check failed' }
                }))
            }
        }

        for (const url of [...new Set(applicableChecks.map(c => c.url))]) {
            setCustomCheckResults(prev => ({
                ...prev,
                [url]: { healthy: false, checking: true }
            }))

            try {
                const { useSyncStore } = await import('@/store/syncStore')
                const { serverUrl } = useSyncStore.getState()
                const result = await apiFetch<{ ok?: boolean; status?: number; error?: string }>('/autopilot/test-url', {
                    method: 'POST',
                    baseUrl: (serverUrl || '').startsWith('http') ? serverUrl : undefined,
                    body: { url },
                })
                if (!result.ok) {
                    setCustomCheckResults(prev => ({
                        ...prev,
                        [url]: { healthy: false, checking: false, error: result.error || `Server error (${result.status})` }
                    }))
                    continue
                }
                const data = result.data
                setCustomCheckResults(prev => ({
                    ...prev,
                    [url]: { healthy: !!data?.ok, checking: false, error: data?.error, code: data?.status }
                }))
            } catch (err) {
                setCustomCheckResults(prev => ({
                    ...prev,
                    [url]: { healthy: false, checking: false, error: 'Request failed' }
                }))
            }
        }
    }

    const getTierClassName = (isActiveInRule: boolean, isTier1: boolean) => {
        if (!isActiveInRule) return 'bg-muted/30 border border-border/40'
        if (isTier1) return 'bg-primary/[0.07] border border-primary/25'
        return 'bg-warning/[0.07] border border-warning/25'
    }

    const dragSensors = useSensors(
        useSensor(MouseSensor, { activationConstraint: { distance: 3 } }),
        useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
        useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
    )

    const dragDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    const handleChainDragEnd = useCallback((ruleId: string, currentChain: string[]) => (event: DragEndEvent) => {
        const { active, over } = event
        if (!over || active.id === over.id) return
        if (useFailoverStore.getState().isChecking) return
        const oldIndex = currentChain.indexOf(active.id as string)
        const newIndex = currentChain.indexOf(over.id as string)
        if (oldIndex === -1 || newIndex === -1) return
        const newChain = arrayMove(currentChain, oldIndex, newIndex)

        useFailoverStore.setState({
            rules: useFailoverStore.getState().rules.map(r =>
                r.id === ruleId ? { ...r, priorityChain: newChain, activeUrl: newChain[0] } : r
            )
        })

        if (dragDebounceRef.current) clearTimeout(dragDebounceRef.current)
        dragDebounceRef.current = setTimeout(() => {
            updateRule(ruleId, { priorityChain: newChain, activeUrl: newChain[0] })
        }, 800)
    }, [updateRule])


    const handleRuleReorder = useCallback((event: DragEndEvent) => {
        const { active, over } = event
        if (!over || active.id === over.id) return
        const currentRules = useFailoverStore.getState().rules.filter(r => r.accountId === accountId)
        const oldIndex = currentRules.findIndex(r => r.id === active.id)
        const newIndex = currentRules.findIndex(r => r.id === over.id)
        if (oldIndex === -1 || newIndex === -1) return
        const reorderedIds = arrayMove(currentRules, oldIndex, newIndex).map(r => r.id)
        reorderRules(accountId, reorderedIds)
    }, [accountId, reorderRules])

    if (!account) return null

    const accountRules = rules.filter(r => r.accountId === accountId)
    const leftoverRules = accountRules.flatMap(rule => {
        const missing = getRuleMissingConnection(rule, account)
        return missing && keptResidue[rule.id] !== missing.signature ? [{ rule, ...missing }] : []
    })
    const deleteLeftoverRule = async (ruleId: string) => {
        if (removingResidue) return
        setRemovingResidue(ruleId)
        setResidueError(null)
        try { await removeRule(ruleId); setRuleToDelete(null) }
        catch { setResidueError('Unable to delete this rule. Try again.') }
        finally { setRemovingResidue(null) }
    }
    const pausedRuleCount = accountRules.filter(rule => !rule.isActive).length
    recordFirstSeen(firstSeenRef.current, accountRules, now)
    const pageChip = resolveAutopilotChip({
        isServerLive: isAutopilotLive, hasRules: accountRules.length > 0, rules: accountRules, budgetHit: lastCycle?.budgetHit, now, safeMode, firstSeen: firstSeenRef.current,
        statePullFailed, pulseUnreachable, statesPulled: lastCompletePullAt > 0,
    })
    const pageStatus = pageChip.status
    const workerOff = workerEnabled === false
    const showPageStatus = showToolbarStatusChip({ status: pageStatus, hasWorkerRun: !!lastWorkerRun, safeMode: !!safeMode, workerEnabled })
    const pageStatusTitle = safeMode ? 'Paused' : workerOff ? 'Off' : pageStatus
    const canReorderRules = accountRules.length > 1
    const bulkActions = autopilotBulkActions(accountRules)
    const localAddons = account.addons

    // Use allAddonsForLabeling for name resolution in rule display,
    // but localAddons for the selection dropdown to prevent cross-account leaks.
    const addons = allAddonsForLabeling
    const addonByNormalizedUrl = new Map(
        addons.map(addon => [normalizeAddonUrl(addon.transportUrl), addon] as const)
    )
    const getAddonForUrl = (url?: string) => {
        if (!url) return undefined
        return addonByNormalizedUrl.get(normalizeAddonUrl(url))
    }
    const getAddonNameForUrl = (url?: string) => {
        if (!url) return 'Unknown addon'
        const addon = getAddonForUrl(url)
        return addon?.metadata?.customName || identifyAddon(url, addon?.manifest).name
    }
    const activeFailoverMeta = {
        rules: {
            icon: Activity,
            title: 'Active Rules',
            description: 'Autopilot keeps the highest-priority addon active at all times.',
        },
        history: {
            icon: History,
            title: 'Autopilot History',
            description: 'Review health checks, recovery decisions, and failover switches.',
        },
        webhooks: {
            icon: Webhook,
            title: 'Webhook Routing',
            description: 'Configure global and per-rule notifications for Autopilot events.',
        },
    }[activeFailoverTab]
    const ActiveFailoverIcon = activeFailoverMeta.icon

    return (
        <div className="space-y-6">
            <WorkspaceTabs value={activeFailoverTab} onValueChange={handleFailoverTabChange} label="Autopilot views" contentClassName="space-y-5" tabs={showViewTabs ? <>
                            <TabsTrigger
                                value="rules"
                                className="gap-2"
                            >
                                <Activity className="w-4 h-4" />
                                Rules
                            </TabsTrigger>
                            <TabsTrigger
                                value="history"
                                className="gap-2"
                            >
                                <History className="w-4 h-4" />
                                History
                            </TabsTrigger>
                            <TabsTrigger
                                value="webhooks"
                                className="gap-2"
                            >
                                <Webhook className="w-4 h-4" />
                                Webhooks
                            </TabsTrigger>
            </> : null}>
                {showViewTabs && <div><h3 className="flex items-center gap-2 text-lg font-semibold"><ActiveFailoverIcon className="h-5 w-5" />{activeFailoverMeta.title}</h3><p className="mt-1 text-xs leading-relaxed text-muted-foreground">{activeFailoverMeta.description}</p></div>}

                <TabsContent value="webhooks" className="space-y-6">
                    <WebhooksPanel
                        accountId={accountId}
                        accountName={account.name}
                        accountRules={accountRules}
                        onEditRule={openRuleEditor}
                    />
                </TabsContent>

                <TabsContent value="rules" className="space-y-6">

                    <RuleDialog
                        open={isRuleDialogOpen}
                        onOpenChange={(nextOpen) => { setIsRuleDialogOpen(nextOpen); if (!nextOpen) setEditingRule(null) }}
                        editingRule={editingRule}
                        accountId={accountId}
                        accountName={account.name}
                        localAddons={localAddons}
                        addons={addons}
                        getAddonForUrl={getAddonForUrl}
                        getAddonNameForUrl={getAddonNameForUrl}
                        dragSensors={dragSensors}
                    />

                    <div className="space-y-4">
                        {!showViewTabs && (
                            <div className="flex flex-wrap items-center gap-3">
                                <h3 className="text-lg font-semibold flex items-center gap-2">
                                    <Activity className="w-5 h-5" />
                                    Active Rules
                                </h3>
                                <p className="text-xs text-muted-foreground mt-0.5 hidden sm:block">
                                    Autopilot keeps the highest-priority addon active at all times.
                                </p>
                            </div>
                        )}

                        {leftoverRules.length > 0 && <div data-theme-part="panel" className="rounded-xl border border-border/40 bg-muted/20 p-3 space-y-3" data-testid="leftover-rule-report">
                            <p className="flex items-start gap-2 text-sm text-warning"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /><span>{leftoverRules.length} Autopilot rule{leftoverRules.length === 1 ? ' has' : 's have'} no login to run on.</span></p>
                            <div className="divide-y divide-border/40">
                                {leftoverRules.map(({ rule, label, signature }) => <div key={rule.id} className="flex flex-wrap items-center justify-between gap-2 py-2 first:pt-0 last:pb-0">
                                    <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{maskNameLevel(ruleDisplayName(rule), privacyNameLevel)}</p><p className="text-xs text-muted-foreground">{label}</p></div>
                                    <div className="flex shrink-0 items-center gap-1"><Button size="sm" variant="ghost" className="min-h-9 rounded-full text-xs text-destructive" disabled={!!removingResidue} onClick={() => setRuleToDelete(rule.id)}>Delete</Button><Button size="sm" variant="outline" className="min-h-9 rounded-full text-xs" disabled={!!removingResidue} onClick={() => setKeptResidue(previous => ({ ...previous, [rule.id]: signature }))}>Keep</Button></div>
                                </div>)}
                            </div>
                            {residueError && <p role="alert" className="text-xs text-destructive">{residueError}</p>}
                        </div>}

                        {accountRules.length === 0 ? (
                            <div data-theme-part="panel" className="rounded-2xl border border-border/40 bg-card p-5 shadow-sm">
                                <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-stretch">
                                    <div className="flex flex-col justify-between gap-6">
                                        <div className="space-y-4">
                                            <div className="max-w-xl space-y-2">
                                                <h4 className="text-xl font-semibold tracking-tight">Create an Autopilot chain</h4>
                                                <p className="text-sm leading-6 text-muted-foreground">
                                                    Pick a primary addon, add fallbacks in priority order, and Autopilot keeps one active when your preferred source goes offline.
                                                </p>
                                            </div>
                                        </div>
                                        <div className="flex flex-wrap gap-2">
                                            <Button
                                                size="sm"
                                                onClick={() => {
                                                    setEditingRule(null)
                                                    setIsRuleDialogOpen(true)
                                                }}
                                                className="gap-1.5 h-8 text-xs font-medium"
                                            >
                                                <Plus className="h-3.5 w-3.5" />
                                                New Rule
                                            </Button>
                                            {otherAccountsWithRules.length > 0 && (
                                                <DropdownMenu>
                                                    <DropdownMenuTrigger asChild>
                                                        <Button size="sm" variant="outline" className="gap-1.5 h-8 text-xs font-medium">
                                                            <Download className="h-3.5 w-3.5" />
                                                            Copy Rules From…
                                                        </Button>
                                                    </DropdownMenuTrigger>
                                                    <DropdownMenuContent align="start">
                                                        {otherAccountsWithRules.map(a => (
                                                            <DropdownMenuItem key={a.id} onClick={() => handleCopyRulesFrom(a.id)}>
                                                                <div className="flex items-center gap-2">
                                                                    {a.emoji && <span className="shrink-0">{a.emoji}</span>}
                                                                    <span>{a.name} ({a.ruleCount} rule{a.ruleCount !== 1 ? 's' : ''})</span>
                                                                </div>
                                                            </DropdownMenuItem>
                                                        ))}
                                                    </DropdownMenuContent>
                                                </DropdownMenu>
                                            )}
                                        </div>
                                    </div>
                                    <div data-theme-part="panel" className="rounded-2xl border border-dashed border-border/50 bg-muted/10 p-4">
                                        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Flow</p>
                                        <div className="mt-4 space-y-3">
                                            {['Primary addon stays active', 'Fallbacks wait in priority order', 'Recovery switches back automatically'].map((step, index) => (
                                                <div key={step} className="flex items-center gap-3 text-sm text-muted-foreground">
                                                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border border-border/40 bg-card text-xs font-semibold text-foreground">
                                                        {index + 1}
                                                    </span>
                                                    <span>{step}</span>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        ) : (
                            <>
                            <ToolbarShell>
                                <div className="flex flex-wrap items-center gap-2 flex-1 min-w-[220px]">
                                    <span className="text-xs text-muted-foreground tabular-nums">{ruleCountLabel(accountRules.length, pausedRuleCount)}</span>
                                    {showPageStatus && (
                                        <Popover>
                                            <PopoverTrigger asChild>
                                                <button type="button" className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`Autopilot ${pageStatusTitle} details`}>
                                                    <StatusChip variant="warning" icon={<AlertTriangle />}>
                                                        {pageStatusTitle}
                                                    </StatusChip>
                                                </button>
                                            </PopoverTrigger>
                                            <PopoverContent align="start" className="w-[min(18rem,92vw)] space-y-2 p-3 text-xs">
                                                <p className="text-sm font-semibold text-foreground">{safeMode ? 'Autopilot paused' : workerOff ? AUTOPILOT_WORKER_OFF_TITLE : `Autopilot ${pageStatusTitle.toLowerCase()}`}</p>
                                                <p className="break-words text-muted-foreground">{workerOff ? AUTOPILOT_WORKER_OFF_DETAIL : safeMode ? AUTOPILOT_SAFE_MODE_DETAIL : pageStatus === 'Offline' && (statePullFailed || pulseUnreachable) ? AUTOPILOT_UNREACHABLE_DETAIL : statePullPartial ? AUTOPILOT_PARTIAL_DETAIL : TOOLBAR_STATUS_DETAIL[pageStatus]}</p>
                                                <dl className="space-y-1">
                                                    {pageChip.staleCount > 0 && <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Not checked recently</dt><dd className="text-warning">{pageChip.staleCount} of {pageChip.activeCount}</dd></div>}
                                                    {pageChip.errorCount > 0 && <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Last check failed</dt><dd className="text-warning">{pageChip.errorCount} of {pageChip.activeCount}</dd></div>}
                                                    {lastCycle?.budgetHit && <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Budgeted scan</dt><dd className="text-foreground/80">{lastCycle.scanned} scanned</dd></div>}
                                                </dl>
                                            </PopoverContent>
                                        </Popover>
                                    )}
                                </div>

                                <div className="flex flex-wrap gap-1.5 sm:ml-auto items-center">
                                    {otherAccountsWithRules.length > 0 && (
                                        <DropdownMenu>
                                            <DropdownMenuTrigger asChild>
                                                <Button size="sm" variant="outline" className="gap-1.5 h-8 text-xs font-medium">
                                                    <Download className="h-3.5 w-3.5" />
                                                    <span className="hidden sm:inline">Copy Rules From…</span>
                                                    <span className="sm:hidden">Copy</span>
                                                </Button>
                                            </DropdownMenuTrigger>
                                            <DropdownMenuContent align="start">
                                                {otherAccountsWithRules.map(a => (
                                                    <DropdownMenuItem key={a.id} onClick={() => handleCopyRulesFrom(a.id)}>
                                                        <div className="flex items-center gap-2">
                                                            {a.emoji && <span className="shrink-0">{a.emoji}</span>}
                                                            <span>{a.name} ({a.ruleCount} rule{a.ruleCount !== 1 ? 's' : ''})</span>
                                                        </div>
                                                    </DropdownMenuItem>
                                                ))}
                                            </DropdownMenuContent>
                                        </DropdownMenu>
                                    )}
                                    {accountRules.length > 0 && (
                                        <>
                                            {bulkActions.resume && <Tooltip content="Resume all autopilot rules for this account">
                                                <Button
                                                    size="sm"
                                                    variant="outline"
                                                    className="gap-1.5 h-8 text-xs font-medium"
                                                    onClick={() => toggleAllRulesForAccount(accountId, true)}
                                                >
                                                    <Play className="h-3.5 w-3.5" /> Resume
                                                </Button>
                                            </Tooltip>}
                                            {bulkActions.pause && <Tooltip content="Pause all autopilot rules for this account">
                                                <Button
                                                    size="sm"
                                                    variant="outline"
                                                    className="gap-1.5 h-8 text-xs font-medium"
                                                    onClick={() => toggleAllRulesForAccount(accountId, false)}
                                                >
                                                    <Pause className="h-3.5 w-3.5" /> Pause
                                                </Button>
                                            </Tooltip>}
                                        </>
                                    )}
                                    <Button
                                        size="sm"
                                        onClick={() => {
                                            setEditingRule(null)
                                            setIsRuleDialogOpen(true)
                                        }}
                                        className="gap-1.5 h-8 text-xs font-medium"
                                    >
                                        <Plus className="h-3.5 w-3.5" />
                                        New Rule
                                    </Button>
                                </div>
                            </ToolbarShell>

                        <DndContext
                            sensors={dragSensors}
                            collisionDetection={closestCenter}
                            onDragEnd={handleRuleReorder}
                            modifiers={[restrictToVerticalAxis]}
                        >
                            <SortableContext
                                items={accountRules.map(r => r.id)}
                                strategy={verticalListSortingStrategy}
                            >
                                <div className="grid gap-4">
                                    {accountRules.map(rule => {
                                        if (!rule || !rule.priorityChain) return null;
                                        const activeUrl = rule.activeUrl || rule.priorityChain[0]

                                        const activeAddonName = getAddonNameForUrl(activeUrl)
                                        const primaryAddonName = getAddonNameForUrl(rule.priorityChain[0])
                                        const ruleName = rule.name || `Rule ${rule.id.slice(0, 8)}`
                                        const cooldown = cooldownLabel(rule.cooldown_ms)
                                        const webhookKind = ruleWebhookKind(rule)
                                        const webhookTitle = webhookKind === 'custom' ? 'Custom webhook' : webhookKind === 'global' ? 'Global webhook' : 'Notifications off'
                                        return (
                                            <SortableRuleWrapper key={rule.id} id={rule.id} draggable={canReorderRules}>
                                                <div data-theme-part="panel" className={`bg-card border border-border/40 rounded-2xl p-5 ${canReorderRules ? 'pl-8 ' : ''}flex flex-col gap-5 shadow-sm min-w-0`}>
                                        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                                            <RuleHealthDot rule={rule} isAutopilotLive={isAutopilotLive} lastCycle={lastCycle} />
                                            <Tooltip content={ruleName}>
                                                <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground sm:text-base">
                                                    {ruleName}
                                                </span>
                                            </Tooltip>
                                            <div className="order-last flex basis-full flex-wrap items-center gap-2 sm:order-none sm:basis-auto">
                                                {cooldown && (
                                                    <span className="inline-flex items-center gap-1 text-xs tabular-nums text-muted-foreground">
                                                        <Timer className="h-3 w-3" aria-hidden="true" />
                                                        {cooldown}
                                                    </span>
                                                )}
                                                <Popover>
                                                    <PopoverTrigger asChild>
                                                        <button type="button" className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`${webhookTitle} details`}>
                                                            <StatusChip icon={webhookKind === 'silent' ? <XCircle /> : <Webhook />} variant={webhookKind === 'custom' ? 'primary' : 'muted'}>
                                                                {webhookKind === 'silent' ? 'Silent' : webhookTitle}
                                                            </StatusChip>
                                                        </button>
                                                    </PopoverTrigger>
                                                    <PopoverContent align="end" className="w-[min(16rem,92vw)] space-y-2 p-3 text-xs">
                                                        <p className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                                                            {webhookKind === 'silent' ? <XCircle className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" /> : <Webhook className="h-3.5 w-3.5 text-primary" aria-hidden="true" />}
                                                            {webhookTitle}
                                                        </p>
                                                        {webhookKind === 'custom' && rule.webhookUrl ? (
                                                            <>
                                                                <p className="truncate rounded-lg border border-border/40 bg-muted/30 px-2 py-1.5 font-mono text-foreground/80">
                                                                    {webhookDisplayUrl(rule.webhookUrl, privacyUrlLevel)}
                                                                </p>
                                                                <div className="flex justify-end">
                                                                    <Button size="sm" variant="outline" className="h-7 gap-1.5 text-xs" onClick={() => testWebhook(rule.webhookUrl, accountId, toast, account.name)}>
                                                                        <Send className="h-3 w-3" />
                                                                        Send test
                                                                    </Button>
                                                                </div>
                                                            </>
                                                        ) : (
                                                            <p className="break-words text-muted-foreground">
                                                                {webhookKind === 'silent' ? 'Notifications are off for this rule.' : 'This rule uses the global webhook from the Webhooks tab.'}
                                                            </p>
                                                        )}
                                                    </PopoverContent>
                                                </Popover>
                                            </div>
                                            <Switch
                                                checked={rule.isActive}
                                                aria-label={`${ruleName} enabled`}
                                                onCheckedChange={(c) => updateRule(rule.id, {
                                                    isActive: c,
                                                    isAutomatic: c
                                                })}
                                            />
                                                <DropdownMenu>
                                                    <DropdownMenuTrigger asChild>
                                                        <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0 hover:bg-foreground/10 text-foreground/60" aria-label="More options">
                                                            <MoreVertical className="w-4 h-4" />
                                                        </Button>
                                                    </DropdownMenuTrigger>
                                                    <DropdownMenuContent align="end" className="w-48">
                                                        <DropdownMenuItem className="gap-2" onClick={() => handleSimulateRule(rule.id, rule.priorityChain, rule.customCheckUrls)}>
                                                            <FlaskConical className="w-4 h-4" />
                                                            Simulate Check
                                                        </DropdownMenuItem>
                                                        {webhookKind === 'custom' && (
                                                            <DropdownMenuItem className="gap-2" onClick={() => testWebhook(rule.webhookUrl, accountId, toast, account.name)}>
                                                                <Send className="w-4 h-4" />
                                                                Test webhook
                                                            </DropdownMenuItem>
                                                        )}
                                                        <DropdownMenuItem className="gap-2" onClick={() => openRuleEditor(rule)}>
                                                            <Pencil className="w-4 h-4" />
                                                            Edit Chain
                                                        </DropdownMenuItem>
                                                        <DropdownMenuItem className="gap-2" onClick={() => handleDuplicateRule(rule)}>
                                                            <Copy className="w-4 h-4" />
                                                            Duplicate
                                                        </DropdownMenuItem>
                                                        <DropdownMenuSeparator />
                                                        <DropdownMenuItem className="gap-2 text-destructive focus:text-destructive" onClick={() => setRuleToDelete(rule.id)}>
                                                            <Trash2 className="w-4 h-4" />
                                                            Delete Rule
                                                        </DropdownMenuItem>
                                                    </DropdownMenuContent>
                                                </DropdownMenu>
                                        </div>

                                        <DndContext
                                            sensors={dragSensors}
                                            collisionDetection={closestCenter}
                                            onDragEnd={handleChainDragEnd(rule.id, rule.priorityChain)}
                                            modifiers={[restrictToVerticalAxis]}
                                        >
                                            <SortableContext
                                                items={rule.priorityChain}
                                                strategy={verticalListSortingStrategy}
                                            >
                                                <div className="flex flex-col gap-2 relative w-full px-2">
                                                    {rule.priorityChain.map((url, idx) => {
                                                        const addon = getAddonForUrl(url)
                                                        const isActiveInRule = normalizeAddonUrl(url) === normalizeAddonUrl(activeUrl || '')
                                                        const isTier1 = idx === 0
                                                        const isFailedOver = isActiveInRule && !isTier1
                                                        const name = addon?.metadata?.customName || identifyAddon(url, addon?.manifest).name
                                                        const logo = addon?.metadata?.customLogo || addon?.manifest.logo
                                                        const overlap = findRuleOverlaps(rule, accountRules, localAddons).find(entry => normalizeAddonUrlForMatch(entry.url) === normalizeAddonUrlForMatch(url))
                                                        const changedElsewhere = rule.lastError?.code === 'contested_by_other_writer' && rule.lastError.affectedRefs?.includes(memberReferences[normalizeAddonUrlForMatch(url)])
                                                        const warning = overlap && rule.lastError?.code === 'chain_overlap' ? `In ${overlap.count + 1} rules` : changedElsewhere ? 'Changed elsewhere' : undefined
                                                        return (
                                                            <SortableChainTier
                                                                key={url}
                                                                id={url}
                                                                url={url}
                                                                idx={idx}
                                                                isActiveInRule={isActiveInRule}
                                                                isTier1={isTier1}
                                                                isFailedOver={isFailedOver}
                                                                addonName={name}
                                                                warning={warning}
                                                                warningDetail={overlap ? `Also in rule ${maskNameLevel(overlap.ruleName, privacyNameLevel)}. Autopilot skips it until it is in only one rule.` : 'Changed by another app or workspace after Autopilot set it. Autopilot is not enforcing it for now.'}
                                                                addonLogo={logo}
                                                                getTierClassName={getTierClassName}
                                                            />
                                                        )
                                                    })}
                                                </div>
                                            </SortableContext>
                                        </DndContext>

                                        <RuleConfidenceLayer
                                            rule={rule}
                                            isAutopilotLive={isAutopilotLive}
                                            lastCycle={lastCycle}
                                            activeAddonName={activeAddonName}
                                            primaryAddonName={primaryAddonName}
                                            resolveAddon={url => ({ name: getAddonNameForUrl(url), logo: getAddonForUrl(url)?.metadata?.customLogo || getAddonForUrl(url)?.manifest.logo })}
                                        />

                                        {simulatingRuleId === rule.id && (
                                            <div
                                                data-theme-part="panel"
                                                data-sim-card
                                                className="space-y-3 rounded-2xl border border-border/40 bg-card p-3 shadow-sm sm:mx-2 sm:p-4 animate-in fade-in slide-in-from-top-1 duration-200"
                                            >
                                                <div className="flex items-center justify-between">
                                                    <p className="text-xs font-medium text-muted-foreground uppercase">Simulation</p>
                                                    <Button
                                                        variant="ghost"
                                                        size="icon"
                                                        data-sim-close
                                                        aria-label="Close simulation"
                                                        className="h-8 w-8 rounded-full bg-muted/30 text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                                                        onClick={() => setSimulatingRuleId(null)}
                                                    >
                                                        <X className="h-4 w-4" />
                                                    </Button>
                                                </div>

                                                <div className="space-y-1">
                                                    {rule.priorityChain.map((url, idx) => {
                                                        const result = simulationResults[url]
                                                        const addon = addons.find(a => a.transportUrl === url)
                                                        const name = addon?.metadata?.customName || identifyAddon(url, addon?.manifest).name
                                                        const logo = addon?.metadata?.customLogo || addon?.manifest?.logo
                                                        const underChecks = simulatedCustomChecks.filter(c => c.appliesTo.length > 0 && c.appliesTo.some(au => normalizeAddonUrl(au).toLowerCase() === normalizeAddonUrl(url).toLowerCase()))
                                                        return (
                                                            <div key={url} className="space-y-1">
                                                                <div className="flex h-10 items-center gap-2 rounded-xl px-1.5 text-sm sm:gap-2.5 sm:px-2.5">
                                                                    <span className="w-5 shrink-0 font-mono text-[10px] text-muted-foreground/70">T{idx + 1}</span>
                                                                    <span className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted/50">
                                                                        {logo
                                                                            ? <img src={logo} alt="" className="h-full w-full object-contain" />
                                                                            : <span className="text-[10px] font-semibold text-muted-foreground">{(name || '?').charAt(0).toUpperCase()}</span>}
                                                                    </span>
                                                                    <span className="min-w-0 flex-1 truncate">{name}</span>
                                                                    <div className="flex shrink-0 items-center gap-2">
                                                                        {result?.checking ? (
                                                                            <StatusChip variant="muted" icon={<Loader2 className="animate-spin" />}>Checking</StatusChip>
                                                                        ) : !result ? (
                                                                            <StatusChip variant="muted" icon={<Clock />}>Queued</StatusChip>
                                                                        ) : result.healthy ? (
                                                                            <>
                                                                                {typeof result.latencyMs === 'number' && <span className="hidden text-xs tabular-nums text-muted-foreground sm:inline">{Math.round(result.latencyMs)} ms</span>}
                                                                                <StatusChip variant="success" icon={<CheckCircle2 />}>Healthy</StatusChip>
                                                                            </>
                                                                        ) : (
                                                                            <>
                                                                                {result.error && (
                                                                                    <Tooltip content={result.error}>
                                                                                        <span className="hidden max-w-[120px] truncate text-xs text-muted-foreground sm:inline">{result.error}</span>
                                                                                    </Tooltip>
                                                                                )}
                                                                                <StatusChip variant="destructive" icon={<XCircle />}>Down</StatusChip>
                                                                            </>
                                                                        )}
                                                                    </div>
                                                                    <span className="hidden w-24 text-right text-xs text-muted-foreground sm:block">Manifest ping</span>
                                                                </div>
                                                                {underChecks.map(c => renderCustomCheckRow(c))}
                                                            </div>
                                                        )
                                                    })}
                                                    {simulatedCustomChecks.filter(c => c.appliesTo.length === 0).map(c => renderCustomCheckRow(c))}
                                                </div>

                                                {(() => {
                                                    const settled = !rule.priorityChain.some(url => simulationResults[url]?.checking) && !simulatedCustomChecks.some(c => customCheckResults[c.url]?.checking) && Object.keys(simulationResults).length > 0
                                                    if (!settled) return null
                                                    const addonName = (url: string) => {
                                                        const addon = addons.find(a => a.transportUrl === url)
                                                        return addon?.metadata?.customName || identifyAddon(url, addon?.manifest).name
                                                    }
                                                    const verdict = simulationVerdict({
                                                        chainUrls: rule.priorityChain,
                                                        chainResults: simulationResults,
                                                        customChecks: simulatedCustomChecks,
                                                        customCheckResults,
                                                        addonName,
                                                        normalizeUrl: normalizeAddonUrl,
                                                    })
                                                    const VerdictIcon = verdict.icon === 'check' ? CheckCircle2 : verdict.icon === 'switch' ? ArrowRightLeft : AlertTriangle
                                                    return (
                                                        <div
                                                            data-sim-verdict
                                                            className={verdict.tone === 'neutral'
                                                                ? 'flex items-start gap-2.5 rounded-xl border border-border/40 bg-muted/20 px-3.5 py-2.5 text-sm text-muted-foreground'
                                                                : 'flex items-start gap-2.5 rounded-xl border border-warning/25 bg-warning/10 px-3.5 py-2.5 text-sm text-warning'}
                                                        >
                                                            <VerdictIcon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                                                            <span>{verdict.text}</span>
                                                        </div>
                                                    )
                                                })()}

                                                <div className="flex justify-end">
                                                    <Button
                                                        variant="outline"
                                                        size="sm"
                                                        data-sim-rerun
                                                        className="h-8 gap-1.5 text-xs font-medium"
                                                        onClick={() => handleSimulateRule(rule.id, rule.priorityChain, rule.customCheckUrls)}
                                                    >
                                                        <FlaskConical className="h-3.5 w-3.5" />
                                                        Run again
                                                    </Button>
                                                </div>
                                            </div>
                                        )}

                                                </div>
                                            </SortableRuleWrapper>
                                        )
                                    })}
                                </div>
                            </SortableContext>
                        </DndContext>
                            </>
                        )}
                    </div>
                </TabsContent>

                <TabsContent value="history">
                    <FailoverHistory addons={addons} accountId={accountId} />
                </TabsContent>
            </WorkspaceTabs>

            <ConfirmationDialog
                open={!!ruleToDelete}
                onOpenChange={(open) => { if (!open && !removingResidue) { setRuleToDelete(null); setResidueError(null) } }}
                title="Delete Rule?"
                description={<><span>Are you sure you want to delete this autopilot rule? This cannot be undone.</span>{residueError && <span role="alert" className="block text-destructive">{residueError}</span>}</>}
                confirmText="Delete"
                isDestructive={true}
                isLoading={!!removingResidue}
                onConfirm={() => { if (ruleToDelete) void deleteLeftoverRule(ruleToDelete) }}
            />
        </div >
    )
}
