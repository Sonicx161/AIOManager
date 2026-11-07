import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { AlertTriangle, ArrowRightLeft, Check, ChevronDown, Loader2, Pencil, Plus, Trash2, XCircle } from "lucide-react"
import { DndContext, closestCenter } from '@dnd-kit/core'
import type { DragEndEvent, SensorDescriptor, SensorOptions } from '@dnd-kit/core'
import { arrayMove, SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { restrictToVerticalAxis } from '@dnd-kit/modifiers'
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select"
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog"
import { StatusChip } from "@/components/ui/status-chip"
import { Tooltip } from "@/components/ui/tooltip"
import { AddonIcon } from "@/components/ui/addon-icon"
import { SecretUrlInput } from "@/components/ui/secret-url-input"
import { SortableDialogTier } from "@/components/accounts/SortableFailoverTiers"
import { customWebhookError, parseCooldownMinutes } from "@/components/accounts/rule-dialog-fields"
import { testWebhook } from "@/components/accounts/WebhooksPanel"
import { identifyAddon } from "@/lib/addon-identifier"
import { toast } from "@/hooks/use-toast"
import { apiFetch } from "@/lib/http-client"
import { useFailoverStore, readScopeBackups, readScopeDecisions, recordScopeDecision, clearScopeBackup } from "@/store/failoverStore"
import type { FailoverRule, FailoverScopeBackup } from "@/store/failoverStore"
import type { AddonDescriptor } from "@/types/addon"
import { maskNameLevel, normalizeAddonUrl } from "@/lib/utils"
import { useUIStore } from "@/store/uiStore"
import { getTakenRuleAddons, growsRuleOverlap } from "@/lib/autopilot-conflicts"
import { findClosestChainAddon, findStaleScopeEntries, getUrlHostname, isSameCheckUrl, restoreScopedChecks, validateCustomCheckScopes } from "@/lib/failover-scope"
import type { ScopeValidationError } from "@/lib/failover-scope"

export type CustomCheckEntry = { url: string; appliesTo: string[] }

const normalizeCustomChecks = (raw: unknown): CustomCheckEntry[] => {
    if (!Array.isArray(raw)) return []
    return raw
        .map((item): CustomCheckEntry => {
            if (typeof item === 'string') return { url: item, appliesTo: [] }
            if (item && typeof item === 'object') {
                const obj = item as { url?: unknown; appliesTo?: unknown }
                return {
                    url: typeof obj.url === 'string' ? obj.url : '',
                    appliesTo: Array.isArray(obj.appliesTo)
                        ? obj.appliesTo.filter((u): u is string => typeof u === 'string')
                        : []
                }
            }
            return { url: '', appliesTo: [] }
        })
        .slice(0, 5)
}

interface RuleDialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    editingRule: FailoverRule | null
    accountId: string
    accountName?: string
    localAddons: AddonDescriptor[]
    addons: AddonDescriptor[]
    getAddonForUrl: (url?: string) => AddonDescriptor | undefined
    getAddonNameForUrl: (url?: string) => string
    dragSensors: SensorDescriptor<SensorOptions>[]
}

export function RuleDialog({
    open,
    onOpenChange,
    editingRule,
    accountId,
    accountName,
    localAddons,
    addons,
    getAddonForUrl,
    getAddonNameForUrl,
    dragSensors,
}: RuleDialogProps) {
    const rules = useFailoverStore(s => s.rules)
    const addRule = useFailoverStore(s => s.addRule)
    const updateRule = useFailoverStore(s => s.updateRule)
    const globalWebhook = useFailoverStore(s => s.webhook)
    const globalWebhookConfigured = !!(globalWebhook.url && globalWebhook.enabled)
    const privacyNameLevel = useUIStore(s => s.isPrivacyModeEnabled ? s.privacyLevelNames : 0)
    const takenAddons = useMemo(() => {
        const taken = getTakenRuleAddons(accountId, rules, localAddons, editingRule?.id)
        return new Map([...taken].map(([url, entry]) => [url, { ...entry, ruleName: maskNameLevel(entry.ruleName, privacyNameLevel) }]))
    }, [accountId, rules, localAddons, editingRule?.id, privacyNameLevel])

    const [chain, setChain] = useState<string[]>(["", ""])
    const [editingRuleId, setEditingRuleId] = useState<string | null>(null)
    const [ruleName, setRuleName] = useState("")
    const [cooldownMinutes, setCooldownMinutes] = useState<string>("")
    const [ruleWebhookUrl, setRuleWebhookUrl] = useState("")
    const [ruleNotifyMode, setRuleNotifyMode] = useState<'default' | 'custom' | 'off'>('default')
    const [ruleMessageTemplate, setRuleMessageTemplate] = useState("")
    const [customChecks, setCustomChecks] = useState<Array<{ url: string; appliesTo: string[] }>>([])
    const [urlTestResults, setUrlTestResults] = useState<Record<number, { status: 'ok' | 'fail' | 'checking'; code?: number; error?: string }>>({})
    const [expandedChecks, setExpandedChecks] = useState<Set<number>>(new Set())
    const [scopeError, setScopeError] = useState<ScopeValidationError | null>(null)
    const [replacementPicker, setReplacementPicker] = useState<{ checkIndex: number; unmatchedUrl: string; closestUrl?: string } | null>(null)
    const [scopeBackups, setScopeBackups] = useState<Record<string, FailoverScopeBackup>>({})
    const [scopeDecidedRuleIds, setScopeDecidedRuleIds] = useState<string[]>([])
    const [dismissedBackupRuleIds, setDismissedBackupRuleIds] = useState<string[]>([])
    const [isSaving, setIsSaving] = useState(false)
    const [webhookError, setWebhookError] = useState<string | null>(null)
    const [saveError, setSaveError] = useState<string | null>(null)
    const chainErrorRef = useRef<HTMLParagraphElement>(null)
    const checkRowRefs = useRef<Map<number, HTMLDivElement>>(new Map())
    const webhookInputRef = useRef<HTMLInputElement>(null)

    useEffect(() => {
        if (!open) return
        const rule = editingRule
        setChain(rule ? [...rule.priorityChain] : ["", ""])
        setRuleName(rule?.name || "")
        setCooldownMinutes(rule?.cooldown_ms ? String(Math.round(rule.cooldown_ms / 60000)) : "")
        setRuleNotifyMode(rule ? (rule.notifyEnabled === false ? 'off' : rule.webhookUrl ? 'custom' : 'default') : (globalWebhookConfigured ? 'default' : 'off'))
        setRuleWebhookUrl(rule?.webhookUrl || "")
        setRuleMessageTemplate(rule?.messageTemplate || "")
        const normalized = normalizeCustomChecks(rule?.customCheckUrls)
        setCustomChecks(normalized)
        const initialExpanded = new Set<number>()
        normalized.forEach((c, i) => { if (c.appliesTo.length > 0) initialExpanded.add(i) })
        setExpandedChecks(initialExpanded)
        setUrlTestResults({})
        setScopeError(null)
        setReplacementPicker(null)
        setWebhookError(null)
        setSaveError(null)
        setEditingRuleId(rule?.id ?? null)
    }, [open, editingRule, globalWebhookConfigured])

    useEffect(() => {
        if (!open || !editingRuleId) return
        let cancelled = false
        void (async () => {
            const [backups, decided] = await Promise.all([readScopeBackups(), readScopeDecisions()])
            if (cancelled) return
            setScopeBackups(backups)
            setScopeDecidedRuleIds(decided)
        })()
        return () => { cancelled = true }
    }, [open, editingRuleId])

    const hasDuplicateChainUrls = (urls: string[]) => {
        const seen = new Set<string>()
        for (const url of urls) {
            const normalizedUrl = normalizeAddonUrl(url)
            if (seen.has(normalizedUrl)) return true
            seen.add(normalizedUrl)
        }
        return false
    }

    const handleSaveRule = async () => {
        if (isSaving) return
        const filteredChain = chain.filter(url => !!url)
        if (filteredChain.length < 2) {
            toast({ title: "Invalid Rule", description: "An autopilot chain needs at least 2 addons.", variant: "destructive" })
            return
        }
        if (hasDuplicateChainUrls(filteredChain)) {
            toast({ title: "Duplicate Addon", description: "Each Autopilot tier needs a different addon URL.", variant: "destructive" })
            return
        }
        setSaveError(null)
        if (growsRuleOverlap(filteredChain, editingRule?.priorityChain || [], takenAddons)) {
            setSaveError('An addon is already in another Autopilot rule. Remove it from one rule first.')
            requestAnimationFrame(() => chainErrorRef.current?.focus())
            return
        }

        const webhookIssue = customWebhookError(ruleNotifyMode, ruleWebhookUrl)
        if (webhookIssue) {
            setWebhookError(webhookIssue)
            webhookInputRef.current?.focus()
            return
        }
        setWebhookError(null)

        const cooldownMs = parseCooldownMinutes(cooldownMinutes)

        const notifyEnabled = ruleNotifyMode !== 'off'
        const webhookUrl = ruleNotifyMode === 'custom' ? ruleWebhookUrl.trim() : ''

        const messageTemplate = ruleMessageTemplate.trim() || undefined
        const filteredCustomChecks = customChecks
            .map(c => ({ url: c.url.trim(), appliesTo: c.appliesTo }))
            .filter(c => c.url.length > 0)
            .slice(0, 5)

        const scopeIssue = validateCustomCheckScopes(filteredChain, filteredCustomChecks)
        if (scopeIssue) {
            setScopeError(scopeIssue)
            setExpandedChecks(prev => new Set(prev).add(scopeIssue.checkIndex))
            checkRowRefs.current.get(scopeIssue.checkIndex)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
            return
        }
        setScopeError(null)

        setIsSaving(true)
        try {
            if (editingRuleId) {
                const existingRule = rules.find(r => r.id === editingRuleId)
                const chainChanged = !existingRule || JSON.stringify(existingRule.priorityChain) !== JSON.stringify(filteredChain)
                await updateRule(editingRuleId, {
                    priorityChain: filteredChain,
                    activeUrl: chainChanged ? filteredChain[0] : existingRule!.activeUrl,
                    name: ruleName.trim() || undefined,
                    cooldown_ms: cooldownMs,
                    notifyEnabled,
                    webhookUrl,
                    messageTemplate,
                    customCheckUrls: filteredCustomChecks,
                })
                toast({ title: "Rule Updated", description: "Rule settings modified." })
                setEditingRuleId(null)
            } else {
                await addRule(accountId, filteredChain, ruleName.trim() || undefined, cooldownMs, webhookUrl, notifyEnabled, messageTemplate, filteredCustomChecks)
                toast({ title: "Rule Created", description: "Autopilot is now monitoring this chain." })
            }

            onOpenChange(false)
        } catch (error) {
            const message = error instanceof Error ? error.message : ''
            setSaveError(message && !/[a-z][a-z0-9+.-]*:\/\//i.test(message)
                ? message
                : 'The rule was not saved. Check your connection and try again.')
            requestAnimationFrame(() => chainErrorRef.current?.focus())
        } finally {
            setIsSaving(false)
        }
    }

    const addToChain = () => { setSaveError(null); setChain([...chain, ""]) }
    const removeFromChain = (index: number) => { setSaveError(null); setChain(chain.filter((_, i) => i !== index)) }
    const updateChainUrl = (index: number, url: string) => {
        const newChain = [...chain]
        newChain[index] = url
        setSaveError(null)
        setChain(newChain)
    }

    const addCustomCheck = () => {
        if (customChecks.length < 5) {
            setCustomChecks([...customChecks, { url: '', appliesTo: [] }])
        }
    }
    const removeCustomCheck = (index: number) => {
        setCustomChecks(customChecks.filter((_, i) => i !== index))
        setExpandedChecks(prev => {
            const next = new Set<number>()
            prev.forEach(i => {
                if (i < index) next.add(i)
                else if (i > index) next.add(i - 1)
            })
            return next
        })
        setUrlTestResults(prev => {
            const next: Record<number, { status: 'ok' | 'fail' | 'checking'; code?: number; error?: string }> = {}
            Object.entries(prev).forEach(([key, value]) => {
                const i = Number(key)
                if (i < index) next[i] = value
                else if (i > index) next[i - 1] = value
            })
            return next
        })
    }
    const updateCustomCheckUrl = (index: number, url: string) => {
        const next = [...customChecks]
        next[index] = { ...next[index], url }
        setCustomChecks(next)
    }
    const toggleAddonForCheck = (checkIndex: number, addonUrl: string) => {
        const current = customChecks[checkIndex].appliesTo
        if (!current.includes(addonUrl) && current.length >= 10) return
        const next = [...customChecks]
        if (current.includes(addonUrl)) {
            next[checkIndex].appliesTo = current.filter(u => u !== addonUrl)
        } else {
            next[checkIndex].appliesTo = [...current, addonUrl]
        }
        setCustomChecks(next)
    }
    const getUnassignedAddons = (checkIndex: number) => {
        const assigned = new Set(customChecks[checkIndex].appliesTo)
        return chain.filter(url => !!url && !assigned.has(url))
    }
    const toggleExpand = (index: number) => {
        setExpandedChecks(prev => {
            const next = new Set(prev)
            if (next.has(index)) next.delete(index)
            else next.add(index)
            return next
        })
    }

    const chainUrls = chain.filter(url => !!url)
    const staleUrlsByCheck = customChecks.map(c => findStaleScopeEntries(chainUrls, c.appliesTo))
    const hasEmptyScopeCheck = customChecks.some(c => c.url.trim().length > 0 && c.appliesTo.length === 0)
    const activeScopeBackup = editingRuleId ? scopeBackups[editingRuleId] : undefined
    const restorableBackupChecks = activeScopeBackup?.checks.filter(b =>
        b.appliesTo.length > 0 && customChecks.some(c => c.appliesTo.length === 0 && isSameCheckUrl(b.url, c.url))
    ) || []
    const scopeDecisionMade = !!editingRuleId && (scopeDecidedRuleIds.includes(editingRuleId) || dismissedBackupRuleIds.includes(editingRuleId))
    const showRestoreModal = !!editingRuleId && open && restorableBackupChecks.length > 0 && !scopeDecisionMade
    const showLegacyBanner = !!editingRuleId && open && !activeScopeBackup && hasEmptyScopeCheck
    const showDismissedBackupBanner = !!editingRuleId && open && !!activeScopeBackup && restorableBackupChecks.length > 0 && dismissedBackupRuleIds.includes(editingRuleId)

    const applyReplacement = (checkIndex: number, pickedUrl: string) => {
        const staleUrl = replacementPicker?.unmatchedUrl
        if (!staleUrl) return
        setCustomChecks(prev => prev.map((c, i) => {
            if (i !== checkIndex) return c
            const withoutStale = c.appliesTo.filter(u => u !== staleUrl)
            return { ...c, appliesTo: withoutStale.includes(pickedUrl) || withoutStale.length >= 10 ? withoutStale : [...withoutStale, pickedUrl] }
        }))
        setReplacementPicker(null)
        setScopeError(null)
    }

    const focusFirstEmptyScopeCheck = () => {
        const index = customChecks.findIndex(c => c.url.trim().length > 0 && c.appliesTo.length === 0)
        if (index === -1) return
        setExpandedChecks(prev => new Set(prev).add(index))
        checkRowRefs.current.get(index)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }

    const handleScopeDecision = async (choice: 'restore' | 'keep' | 'dismiss') => {
        const ruleId = editingRuleId
        if (!ruleId) return
        // Dismiss is session-only so the backup can still be reviewed later; only Restore and Keep persist.
        if (choice === 'dismiss') {
            setDismissedBackupRuleIds(prev => prev.includes(ruleId) ? prev : [...prev, ruleId])
            return
        }
        if (choice === 'restore') {
            const restored = restoreScopedChecks(customChecks, restorableBackupChecks)
            setCustomChecks(restored)
            const initialExpanded = new Set<number>()
            restored.forEach((c, i) => { if (c.appliesTo.length > 0) initialExpanded.add(i) })
            setExpandedChecks(initialExpanded)
            await updateRule(ruleId, { customCheckUrls: restored })
            await clearScopeBackup(ruleId)
            setScopeBackups(prev => {
                const next = { ...prev }
                delete next[ruleId]
                return next
            })
            toast({ title: 'Scope Restored', description: 'The original addon associations are back on this rule.' })
        }
        await recordScopeDecision(ruleId)
        setScopeDecidedRuleIds(prev => prev.includes(ruleId) ? prev : [...prev, ruleId])
        setDismissedBackupRuleIds(prev => prev.filter(id => id !== ruleId))
    }
    const testCustomCheckUrl = async (index: number) => {
        const url = customChecks[index]?.url.trim()
        if (!url) return
        setUrlTestResults(prev => ({ ...prev, [index]: { status: 'checking' } }))
        try {
            const { useSyncStore } = await import('@/store/syncStore')
            const { serverUrl } = useSyncStore.getState()
            const baseUrl = serverUrl || ''
            const result = await apiFetch<{ ok?: boolean; status?: number; error?: string }>('/autopilot/test-url', {
                method: 'POST',
                baseUrl: baseUrl.startsWith('http') ? baseUrl : undefined,
                body: { url },
            })
            if (!result.ok) {
                setUrlTestResults(prev => ({ ...prev, [index]: { status: 'fail', error: result.error || `Server error (${result.status})` } }))
                return
            }
            const data = result.data
            setUrlTestResults(prev => ({ ...prev, [index]: { status: data?.ok ? 'ok' : 'fail', code: data?.status, error: data?.error } }))
        } catch {
            setUrlTestResults(prev => ({ ...prev, [index]: { status: 'fail', error: 'Request failed' } }))
        }
    }

    const handleDialogChainDragEnd = useCallback((event: DragEndEvent) => {
        const { active, over } = event
        if (!over || active.id === over.id) return
        const oldIndex = Number(active.id)
        const newIndex = Number(over.id)
        if (isNaN(oldIndex) || isNaN(newIndex)) return
        setSaveError(null)
        setChain(prev => arrayMove(prev, oldIndex, newIndex))
    }, [])

    return (
        <>
            <Dialog open={open} onOpenChange={(nextOpen) => { if (isSaving && !nextOpen) return; onOpenChange(nextOpen) }}>
                <DialogContent
                    className='!grid-cols-none !gap-0 !p-0 flex flex-col overflow-hidden !h-[92vh] !max-h-[92vh] rounded-t-3xl sm:!h-auto sm:!max-w-2xl sm:!max-h-[92vh] text-card-foreground'
                >
                    <div className="shrink-0 bg-card px-4 pb-3 pt-1 sm:px-8 sm:pb-5 sm:pt-3">
                        <DialogTitle className="flex items-center gap-2 min-w-0">
                            {editingRuleId
                                ? <><Pencil className="w-5 h-5 text-primary" /> Edit Priority Chain</>
                                : <><Plus className="w-5 h-5 text-primary" /> Create New Autopilot Rule</>
                            }
                        </DialogTitle>
                        <p className="text-sm text-foreground/60 mt-2">
                            Pick addons in priority order. If one goes down, Autopilot switches to the next automatically.
                        </p>
                    </div>

                    <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
                        <div className="space-y-5 px-4 py-4 sm:px-8 sm:py-6">

                            <div className="space-y-1.5 pt-4">
                                <label className="text-xs font-medium text-muted-foreground uppercase ml-1">Rule Name (Optional)</label>
                                <Input
                                    placeholder="e.g. My Primary Movies"
                                    value={ruleName}
                                    onChange={(e) => setRuleName(e.target.value)}
                                    className="bg-muted/30 border-border rounded-xl"
                                />
                            </div>

                            <DndContext
                                sensors={dragSensors}
                                collisionDetection={closestCenter}
                                onDragEnd={handleDialogChainDragEnd}
                                modifiers={[restrictToVerticalAxis]}
                            >
                                <SortableContext
                                    items={chain.map((_, i) => i)}
                                    strategy={verticalListSortingStrategy}
                                >
                                    <div className="space-y-3">
                                        {chain.map((url, index) => (
                                            <SortableDialogTier
                                                key={index}
                                                id={index}
                                                index={index}
                                                url={url}
                                                chainLength={chain.length}
                                                localAddons={localAddons}
                                                chain={chain}
                                                addons={addons}
                                                updateChainUrl={updateChainUrl}
                                                removeFromChain={removeFromChain}
                                                takenAddons={takenAddons}
                                                getAddonNameForUrl={(value) => maskNameLevel(getAddonNameForUrl(value), privacyNameLevel)}
                                            />
                                        ))}
                                    </div>
                                </SortableContext>
                            </DndContext>
                            {saveError && <p ref={chainErrorRef} tabIndex={-1} role="alert" className="text-xs text-destructive focus:outline-none">{saveError}</p>}
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={addToChain}
                                className="w-full bg-muted/30 border border-dashed border-border/40 hover:bg-muted/50 text-foreground/60 hover:text-foreground h-12 rounded-2xl gap-2 mt-3"
                            >
                                <Plus className="w-4 h-4" /> Add Fallback Tier
                            </Button>

                            <div data-theme-part="panel" className="bg-muted/20 border border-border/40 rounded-2xl p-4 space-y-3">
                                <div className="space-y-0.5">
                                    <label className="text-xs font-medium text-muted-foreground uppercase">Custom Health Checks (Optional)</label>
                                    <p className="text-xs text-muted-foreground/60">Watch a provider your addons depend on, like TorBox's API. When it goes down, the addons associated with it are skipped. Use the provider's API URL. Do not use your addon URLs.</p>
                                </div>

                                {showLegacyBanner && (
                                    <div data-theme-tone="status" data-theme-part="panel" className="rounded-xl border border-warning/25 bg-warning/[0.07] px-3 py-2.5 flex items-start gap-2.5">
                                        <AlertTriangle className="w-4 h-4 text-warning shrink-0 mt-0.5" />
                                        <p className="text-xs leading-relaxed text-foreground/80 flex-1 pt-0.5">
                                            Saved before a recent fix, this check's scope may have been widened to all addons. Review the addons it applies to.
                                        </p>
                                        <Button size="sm" variant="outline" className="h-7 px-3 text-xs shrink-0" onClick={focusFirstEmptyScopeCheck}>
                                            Review
                                        </Button>
                                    </div>
                                )}

                                {showDismissedBackupBanner && (
                                    <div data-theme-tone="status" data-theme-part="panel" className="rounded-xl border border-warning/25 bg-warning/[0.07] px-3 py-2.5 flex items-start gap-2.5">
                                        <AlertTriangle className="w-4 h-4 text-warning shrink-0 mt-0.5" />
                                        <p className="text-xs leading-relaxed text-foreground/80 flex-1 pt-0.5">
                                            A backup of this check's original scope is still saved on this device.
                                        </p>
                                        <Button
                                            size="sm"
                                            variant="outline"
                                            className="h-7 px-3 text-xs shrink-0"
                                            onClick={() => setDismissedBackupRuleIds(prev => prev.filter(id => id !== editingRuleId))}
                                        >
                                            Review
                                        </Button>
                                    </div>
                                )}

                                {scopeError && customChecks[scopeError.checkIndex]?.appliesTo.includes(scopeError.unmatchedUrl) && (() => {
                                    const { checkIndex, unmatchedUrl, closestUrl } = scopeError
                                    const checkHostname = getUrlHostname(customChecks[checkIndex].url)
                                    const staleName = getAddonNameForUrl(unmatchedUrl)
                                    const closestName = closestUrl ? getAddonNameForUrl(closestUrl) : undefined
                                    return (
                                        <div data-theme-tone="status" role="alert" data-theme-part="panel" className="rounded-xl border border-destructive/25 bg-destructive/5 p-3 space-y-2.5">
                                            <div className="flex items-start gap-2 text-destructive">
                                                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                                                <p className="text-sm leading-relaxed">
                                                    Custom check for <span className="font-semibold">{checkHostname}</span> is scoped to '{staleName}', which isn't in this failover chain.
                                                    {closestName && <span> Closest match: '{closestName}'.</span>}
                                                </p>
                                            </div>
                                            <div className="flex flex-wrap gap-2 pl-6">
                                                <Button
                                                    size="sm"
                                                    variant="outline"
                                                    className="h-8"
                                                    onClick={() => {
                                                        toggleAddonForCheck(checkIndex, unmatchedUrl)
                                                        setScopeError(null)
                                                    }}
                                                >
                                                    Remove association
                                                </Button>
                                                <Button
                                                    size="sm"
                                                    variant="outline"
                                                    className="h-8"
                                                    onClick={() => {
                                                        setReplacementPicker({ checkIndex, unmatchedUrl, closestUrl })
                                                        setExpandedChecks(prev => new Set(prev).add(checkIndex))
                                                    }}
                                                >
                                                    Pick replacement
                                                </Button>
                                            </div>
                                        </div>
                                    )
                                })()}

                                {customChecks.map((check, index) => {
                                    const result = urlTestResults[index]
                                    const isExpanded = expandedChecks.has(index)
                                    const unassigned = getUnassignedAddons(index)
                                    const staleUrls = staleUrlsByCheck[index] || []
                                    return (
                                        <div
                                            key={index}
                                            ref={(el) => {
                                                if (el) checkRowRefs.current.set(index, el)
                                                else checkRowRefs.current.delete(index)
                                            }}
                                            className="rounded-xl border border-border/40 bg-muted/10 p-3 space-y-2"
                                            data-theme-part="panel"
                                        >
                                            <div className="flex gap-2 items-center">
                                                <SecretUrlInput
                                                    placeholder="https://api.torbox.app/v1/api/user/me"
                                                    value={check.url}
                                                    onChange={(url) => updateCustomCheckUrl(index, url)}
                                                    className="rounded-xl"
                                                    ariaLabel={`Custom check URL ${index + 1}`}
                                                />
                                                <Button
                                                    size="sm"
                                                    className="shrink-0 bg-muted/40 text-foreground/70 border border-border/40 hover:bg-muted/70 shadow-none"
                                                    onClick={() => testCustomCheckUrl(index)}
                                                    disabled={!check.url.trim() || result?.status === 'checking'}
                                                >
                                                    {result?.status === 'checking' ? (
                                                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                                    ) : 'Test'}
                                                </Button>
                                                <button
                                                    data-theme-part="button"
                                                    className="text-foreground/60 hover:text-destructive transition-colors shrink-0 px-1"
                                                    onClick={() => removeCustomCheck(index)}
                                                    aria-label="Remove URL"
                                                >
                                                    <Trash2 className="w-3.5 h-3.5" />
                                                </button>
                                            </div>
                                            {result && result.status !== 'checking' && (
                                                <div className={`flex items-center gap-1.5 text-xs ml-1 ${result.status === 'ok' ? 'text-success' : 'text-destructive'}`}>
                                                    {result.status === 'ok' ? (
                                                        <Check className="w-3.5 h-3.5" />
                                                    ) : (
                                                        <XCircle className="w-3.5 h-3.5" />
                                                    )}
                                                    <span>
                                                        {result.status === 'ok'
                                                            ? `Healthy (HTTP ${result.code})`
                                                            : result.error
                                                                ? `Failed: ${result.error}`
                                                                : `Failed (HTTP ${result.code})`}
                                                    </span>
                                                </div>
                                            )}

                                            <div className="space-y-1.5">
                                                <button
                                                    type="button"
                                                    onClick={() => toggleExpand(index)}
                                                    className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground uppercase hover:text-foreground/80 transition-colors ml-0.5"
                                                >
                                                    <ChevronDown className={`w-3.5 h-3.5 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                                                    Associated with
                                                    <span className="normal-case font-mono text-[10px] text-foreground/50">
                                                        {check.appliesTo.length > 0
                                                            ? `${check.appliesTo.length} addon${check.appliesTo.length !== 1 ? 's' : ''}`
                                                            : 'all'}
                                                    </span>
                                                    {staleUrls.length > 0 && (
                                                        <span className="normal-case font-mono text-[10px] text-warning">
                                                            ({staleUrls.length} not in chain)
                                                        </span>
                                                    )}
                                                </button>
                                                {isExpanded && (
                                                    <div className="space-y-1.5">
                                                        {check.appliesTo.length === 0 ? (
                                                            <p className="text-xs text-muted-foreground/70 px-3 py-2 bg-muted/30 rounded-xl">
                                                                All addons in chain (not recommended unless all share the same provider)
                                                            </p>
                                                        ) : (
                                                            check.appliesTo.map(addonUrl => {
                                                                const addon = getAddonForUrl(addonUrl)
                                                                const addonName = addon?.metadata?.customName || identifyAddon(addonUrl, addon?.manifest).name
                                                                const addonLogo = addon?.metadata?.customLogo || addon?.manifest.logo
                                                                const isStale = staleUrls.includes(addonUrl)
                                                                return (
                                                                    <div data-theme-tone="status" key={addonUrl} data-theme-part="panel" className={`rounded-xl px-3 py-2 flex items-center gap-2 ${isStale ? 'border border-warning/25 bg-warning/[0.08]' : 'bg-muted/30'}`}>
                                                                        <AddonIcon
                                                                            name={addonName}
                                                                            logo={addonLogo}
                                                                            className="h-5 w-5"
                                                                            textClassName="text-xs"
                                                                            imageClassName="p-0.5"
                                                                        />
                                                                        <span className="text-sm truncate flex-1">{addonName}</span>
                                                                        {isStale && (
                                                                            <Tooltip content="Doesn't apply while this addon is out of the chain; reactivates automatically if it returns.">
                                                                                <StatusChip variant="warning" size="sm" className="cursor-help shrink-0">
                                                                                    Not in chain (inactive)
                                                                                </StatusChip>
                                                                            </Tooltip>
                                                                        )}
                                                                        {isStale ? (
                                                                            <>
                                                                                <Tooltip content="Remove this dormant association">
                                                                                    <button
                                                                                        type="button"
                                                                                        data-theme-part="button"
                                                                                        className="text-foreground/60 hover:text-destructive transition-colors shrink-0 px-1"
                                                                                        onClick={() => toggleAddonForCheck(index, addonUrl)}
                                                                                        aria-label="Remove association"
                                                                                    >
                                                                                        <Trash2 className="w-3.5 h-3.5" />
                                                                                    </button>
                                                                                </Tooltip>
                                                                                <Tooltip content="Replace with an addon from this chain">
                                                                                    <button
                                                                                        type="button"
                                                                                        data-theme-part="button"
                                                                                        className="text-foreground/60 hover:text-foreground transition-colors shrink-0 px-1"
                                                                                        onClick={() => setReplacementPicker({
                                                                                            checkIndex: index,
                                                                                            unmatchedUrl: addonUrl,
                                                                                            closestUrl: findClosestChainAddon(addonUrl, chainUrls),
                                                                                        })}
                                                                                        aria-label="Replace association"
                                                                                    >
                                                                                        <ArrowRightLeft className="w-3.5 h-3.5" />
                                                                                    </button>
                                                                                </Tooltip>
                                                                            </>
                                                                        ) : (
                                                                            <button
                                                                                type="button"
                                                                                data-theme-part="button"
                                                                                className="text-foreground/60 hover:text-destructive transition-colors shrink-0 px-1"
                                                                                onClick={() => toggleAddonForCheck(index, addonUrl)}
                                                                                aria-label="Remove addon"
                                                                            >
                                                                                <Trash2 className="w-3.5 h-3.5" />
                                                                            </button>
                                                                        )}
                                                                    </div>
                                                                )
                                                            })
                                                        )}
                                                        {replacementPicker?.checkIndex === index && chainUrls.length > 0 && (() => {
                                                            const staleName = getAddonNameForUrl(replacementPicker.unmatchedUrl)
                                                            return (
                                                                <div className="space-y-1">
                                                                    <Select
                                                                        key={`replace-${index}-${replacementPicker.unmatchedUrl}`}
                                                                        defaultOpen
                                                                        onValueChange={(val) => applyReplacement(index, val)}
                                                                    >
                                                                        <SelectTrigger className="w-full bg-primary/5 border border-primary/30 hover:bg-primary/10 text-foreground h-9 rounded-xl gap-2 font-normal">
                                                                            <ArrowRightLeft className="w-3.5 h-3.5 text-primary" />
                                                                            <SelectValue placeholder={`Replace ${staleName} with…`} />
                                                                        </SelectTrigger>
                                                                        <SelectContent>
                                                                            {chainUrls.map(url => {
                                                                                const addon = getAddonForUrl(url)
                                                                                const addonName = addon?.metadata?.customName || identifyAddon(url, addon?.manifest).name
                                                                                const addonLogo = addon?.metadata?.customLogo || addon?.manifest.logo
                                                                                const isSuggested = !!replacementPicker.closestUrl && url === replacementPicker.closestUrl
                                                                                return (
                                                                                    <SelectItem key={url} value={url}>
                                                                                        <div className="flex items-center gap-2">
                                                                                            <AddonIcon
                                                                                                name={addonName}
                                                                                                logo={addonLogo}
                                                                                                className="h-5 w-5"
                                                                                                textClassName="text-xs"
                                                                                                imageClassName="p-0.5"
                                                                                            />
                                                                                            <span>{addonName}</span>
                                                                                            {isSuggested && (
                                                                                                <StatusChip variant="primary" size="sm">Suggested</StatusChip>
                                                                                            )}
                                                                                        </div>
                                                                                    </SelectItem>
                                                                                )
                                                                            })}
                                                                        </SelectContent>
                                                                    </Select>
                                                                    <button
                                                                        type="button"
                                                                        data-theme-part="button"
                                                                        className="text-xs text-muted-foreground hover:text-foreground transition-colors ml-1"
                                                                        onClick={() => setReplacementPicker(null)}
                                                                    >
                                                                        Cancel replacement
                                                                    </button>
                                                                </div>
                                                            )
                                                        })()}
                                                        {unassigned.length > 0 && check.appliesTo.length < 10 && (
                                                            <Select
                                                                key={`add-${index}-${check.appliesTo.join(',')}`}
                                                                onValueChange={(val) => toggleAddonForCheck(index, val)}
                                                            >
                                                                <SelectTrigger className="w-full bg-muted/30 border border-dashed border-border/40 hover:bg-muted/50 text-foreground/60 hover:text-foreground h-9 rounded-xl gap-2 font-normal">
                                                                    <Plus className="w-3.5 h-3.5" />
                                                                    <SelectValue placeholder="Add addon from chain" />
                                                                </SelectTrigger>
                                                                <SelectContent>
                                                                    {unassigned.map(url => {
                                                                        const addon = getAddonForUrl(url)
                                                                        const addonName = addon?.metadata?.customName || identifyAddon(url, addon?.manifest).name
                                                                        const addonLogo = addon?.metadata?.customLogo || addon?.manifest.logo
                                                                        return (
                                                                            <SelectItem key={url} value={url}>
                                                                                <div className="flex items-center gap-2">
                                                                                    <AddonIcon
                                                                                        name={addonName}
                                                                                        logo={addonLogo}
                                                                                        className="h-5 w-5"
                                                                                        textClassName="text-xs"
                                                                                        imageClassName="p-0.5"
                                                                                    />
                                                                                    <span>{addonName}</span>
                                                                                </div>
                                                                            </SelectItem>
                                                                        )
                                                                    })}
                                                                </SelectContent>
                                                            </Select>
                                                        )}
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    )
                                })}

                                {customChecks.length < 5 && (
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={addCustomCheck}
                                        className="w-full bg-muted/30 border border-dashed border-border/40 hover:bg-muted/50 text-foreground/60 hover:text-foreground h-9 rounded-xl gap-2"
                                    >
                                        <Plus className="w-3.5 h-3.5" /> Add URL
                                    </Button>
                                )}
                            </div>

                            <div data-theme-part="panel" className="bg-muted/20 border border-border/40 rounded-2xl p-4 space-y-3">
                                <label className="text-xs font-medium text-muted-foreground uppercase">Notifications</label>

                                <Select
                                    value={ruleNotifyMode}
                                    onValueChange={(val: 'default' | 'custom' | 'off') => setRuleNotifyMode(val)}
                                >
                                    <SelectTrigger className="bg-muted/30 border-border rounded-xl">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="default">Use global webhook</SelectItem>
                                        <SelectItem value="custom">Custom webhook for this rule</SelectItem>
                                        <SelectItem value="off">Off (no notifications for this rule)</SelectItem>
                                    </SelectContent>
                                </Select>

                                {!editingRuleId && !globalWebhookConfigured && ruleNotifyMode === 'off' && (
                                    <p className="text-xs text-muted-foreground/60 ml-1">
                                        No global webhook is configured yet, so notifications start off. Set one up in the Webhooks tab to enable them.
                                    </p>
                                )}

                                {ruleNotifyMode !== 'off' && (
                                    <div className="space-y-1.5">
                                        <label className="text-xs font-medium text-muted-foreground uppercase ml-1">Notification Cooldown (minutes)</label>
                                        <p className="text-xs text-muted-foreground/60 ml-1 -mt-0.5 mb-1">Minimum time between notifications for this rule. Prevents alert spam during repeated failovers.</p>
                                        <Input
                                            type="number"
                                            placeholder="10"
                                            min={0}
                                            step={1}
                                            value={cooldownMinutes}
                                            onChange={(e) => setCooldownMinutes(e.target.value)}
                                            className="bg-muted/30 border-border rounded-xl"
                                        />
                                    </div>
                                )}

                                {ruleNotifyMode === 'custom' && (
                                    <div className="space-y-1.5">
                                        <label className="text-xs font-medium text-muted-foreground uppercase ml-1">Custom Webhook URL</label>
                                        <div className="flex gap-2">
                                            <SecretUrlInput
                                                placeholder="https://discord.com/api/webhooks/... or Slack URL"
                                                value={ruleWebhookUrl}
                                                inputRef={webhookInputRef}
                                                onChange={(url) => {
                                                    setRuleWebhookUrl(url)
                                                    if (webhookError) setWebhookError(null)
                                                }}
                                                className="rounded-xl"
                                                ariaLabel="Custom webhook URL"
                                            />
                                            {ruleWebhookUrl && (
                                                <Button
                                                    size="sm"
                                                    className="shrink-0 bg-muted/40 text-foreground/70 border border-border/40 hover:bg-muted/70 shadow-none"
                                                    onClick={() => testWebhook(ruleWebhookUrl.trim(), accountId, toast, accountName)}
                                                >
                                                    Test
                                                </Button>
                                            )}
                                        </div>
                                        {webhookError && (
                                            <p role="alert" className="text-xs text-destructive ml-1">{webhookError}</p>
                                        )}
                                    </div>
                                )}

                                {ruleNotifyMode !== 'off' && (
                                    <div className="space-y-1.5">
                                        <label className="text-xs font-medium text-muted-foreground uppercase ml-1">Message Template (Optional)</label>
                                        <p className="text-xs text-muted-foreground/60 ml-1 -mt-0.5 mb-1">Customize the notification message. Use {`{{rule}}`}, {`{{primary}}`}, {`{{backup}}`}, {`{{account}}`} as placeholders.</p>
                                        <Textarea
                                            placeholder="Autopilot triggered for {{rule}} on {{account}}: {{primary}} → {{backup}}"
                                            value={ruleMessageTemplate}
                                            onChange={(e) => setRuleMessageTemplate(e.target.value)}
                                            className="bg-muted/30 border-border rounded-xl min-h-[60px] resize-none"
                                        />
                                    </div>
                                )}
                            </div>

                        </div>
                    </div>

                    <div className="shrink-0 bg-card px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-8">
                        <div className="flex justify-end gap-3 [&_button]:h-11 [&_button]:rounded-full [&_button]:px-5">
                            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isSaving}>
                                Cancel
                            </Button>
                            <Button
                                size="sm"
                                className="bg-primary hover:bg-primary/90 text-primary-foreground font-bold"
                                onClick={handleSaveRule}
                                disabled={chain.filter(u => !!u).length < 2 || isSaving}
                            >
                                {isSaving ? (
                                    <>
                                        <Loader2 className="w-4 h-4 animate-spin" /> Saving
                                    </>
                                ) : editingRuleId ? "Update Chain" : "Enable Autopilot"}
                            </Button>
                        </div>
                    </div>
                </DialogContent>
            </Dialog>

            <Dialog open={showRestoreModal} onOpenChange={(modalOpen) => { if (!modalOpen) void handleScopeDecision('dismiss') }}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                            <AlertTriangle className="w-5 h-5 text-warning" />
                            Restore check scope?
                        </DialogTitle>
                    </DialogHeader>
                    <p className="text-sm text-foreground/70 leading-relaxed">
                        A sync bug widened this check to all addons. A backup of its original scope was found on this device.
                    </p>
                    <div className="flex flex-col sm:flex-row sm:items-center justify-end gap-2 pt-2 [&_button]:rounded-full [&_button]:px-4">
                        <Button variant="ghost" onClick={() => void handleScopeDecision('dismiss')}>Not now</Button>
                        <Button variant="outline" onClick={() => void handleScopeDecision('keep')}>Keep all addons</Button>
                        <Button onClick={() => void handleScopeDecision('restore')}>Restore</Button>
                    </div>
                </DialogContent>
            </Dialog>
        </>
    )
}
