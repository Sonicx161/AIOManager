import { Button } from "@/components/ui/button"
import { StatusChip } from "@/components/ui/status-chip"
import { ToolbarShell } from "@/components/ui/toolbar-shell"
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useAccountStore } from "@/store/accountStore"
import { useFailoverStore } from "@/store/failoverStore"
import type { AddonDescriptor } from "@/types/addon"
import { SquircleOverlay } from "@/components/ui/squircle-overlay"
import { AddonIcon } from "@/components/ui/addon-icon"
import { useHistoryStore } from "@/store/historyStore"
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog"
import { ArrowRight, ChevronDown, CircleDot, AlertTriangle, Activity, Trash2, Plus, History, Pencil, Webhook, Check, Copy, Download, FlaskConical, XCircle, Loader2, Play, Pause, GripVertical, MoreVertical, Shield, Star } from "lucide-react"
import { useState, useEffect, useMemo, useCallback, useRef, memo } from "react"
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
    useSortable,
} from '@dnd-kit/sortable'
import { restrictToVerticalAxis } from '@dnd-kit/modifiers'
import { CSS } from '@dnd-kit/utilities'
import { identifyAddon } from "@/lib/addon-identifier"
import { toast } from "@/hooks/use-toast"
import { apiFetch } from "@/lib/http-client"
import { formatDistanceToNow } from "date-fns"
import { checkAddonHealth } from "@/lib/addon-health"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog"
import { Tooltip } from "@/components/ui/tooltip"
import { EmptyState } from "@/components/common/EmptyState"
import { FailoverEmptyState } from "@/components/common/PageEmptyStates"
import { RuleConfidenceLayer } from "@/components/accounts/RuleConfidenceLayer"
import { normalizeAddonUrl } from "@/lib/utils"

async function testWebhook(
    url: string | undefined,
    accountId: string,
    toastFn: (opts: { title: string; description: string; variant?: 'default' | 'destructive' }) => void,
    accountName?: string
) {
    if (!url) return
    try {
        const { useSyncStore } = await import('@/store/syncStore')
        const { serverUrl } = useSyncStore.getState()
        const baseUrl = serverUrl || ''

        const result = await apiFetch('/autopilot/test-webhook', {
            method: 'POST',
            baseUrl: baseUrl.startsWith('http') ? baseUrl : undefined,
            body: { webhookUrl: url, accountName, accountId },
        })
        if (!result.ok) throw new Error(result.error || `Server returned ${result.status}`)
        toastFn({ title: 'Test Sent', description: 'Check your notification channel.' })
    } catch (err) {
        toastFn({ title: 'Test Failed', description: 'Invalid URL or server error.', variant: 'destructive' })
    }
}

type CustomCheckEntry = { url: string; appliesTo: string[] }

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

interface SortableChainTierProps {
    id: string
    url: string
    idx: number
    chainLength: number
    isActiveInRule: boolean
    isTier1: boolean
    isFailedOver: boolean
    addonName: string
    addonLogo?: string
    getTierClassName: (active: boolean, tier1: boolean) => string
}

const SortableChainTier = memo(function SortableChainTier({
    id, idx, chainLength, isActiveInRule, isTier1, isFailedOver,
    addonName, addonLogo, getTierClassName
}: SortableChainTierProps) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
    const style = {
        transform: CSS.Translate.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
        zIndex: isDragging ? 10 : 'auto' as const,
    }

    return (
        <div ref={setNodeRef} style={style} className="flex flex-col">
            <div className={`flex items-center gap-3 py-3 px-4 rounded-xl relative z-10 transition-colors ${getTierClassName(isActiveInRule, isTier1)}`}>
                <div
                    {...attributes}
                    {...listeners}
                    className="shrink-0 cursor-grab active:cursor-grabbing text-foreground/60 hover:text-foreground/60 transition-colors"
                    style={{ touchAction: 'none' }}
                >
                    <GripVertical className="w-4 h-4" />
                </div>
                <div className="relative w-5 h-5 shrink-0 flex items-center justify-center">
                    <SquircleOverlay />
                    <span className="relative z-10 text-xs font-bold text-muted-foreground">{idx + 1}</span>
                </div>
                <AddonIcon
                    name={addonName}
                    logo={addonLogo}
                    className="h-7 w-7"
                    textClassName="text-xs"
                    imageClassName="p-0.5"
                />
                <span className="font-bold truncate text-sm flex-1">{addonName}</span>
                <div className="flex items-center gap-2 shrink-0">
                    {isTier1 && (
                        <Tooltip content="Primary failover addon">
                            <span aria-label="Primary failover addon" className="inline-flex items-center justify-center rounded-full border p-1 border-primary/25 bg-primary/12 text-primary/80">
                                <Star className="h-3 w-3 fill-current" />
                            </span>
                        </Tooltip>
                    )}
                    {isFailedOver && (
                        <Tooltip content="Currently active">
                            <span aria-label="Currently active" className="inline-flex items-center justify-center rounded-full border p-1 border-success/20 bg-success/10 text-success">
                                <CircleDot className="h-3 w-3" />
                            </span>
                        </Tooltip>
                    )}
                </div>
            </div>
            {idx < chainLength - 1 && (
                <div className="w-full flex items-center justify-center py-1 opacity-30">
                    <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
                </div>
            )}
        </div>
    )
})

interface SortableDialogTierProps {
    id: number
    index: number
    url: string
    chainLength: number
    localAddons: AddonDescriptor[]
    chain: string[]
    addons: AddonDescriptor[]
    updateChainUrl: (index: number, url: string) => void
    removeFromChain: (index: number) => void
}

const SortableDialogTier = memo(function SortableDialogTier({
    id, index, url, chainLength, localAddons, chain, addons,
    updateChainUrl, removeFromChain
}: SortableDialogTierProps) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
    const style = {
        transform: CSS.Translate.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
        zIndex: isDragging ? 10 : 'auto' as const,
    }
    return (
        <div ref={setNodeRef} style={style} className="bg-muted/30 border border-border/40 rounded-2xl px-4 py-3 flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <div
                        {...attributes}
                        {...listeners}
                        className="shrink-0 cursor-grab active:cursor-grabbing text-foreground/40 hover:text-foreground/60 transition-colors"
                        style={{ touchAction: 'none' }}
                    >
                        <GripVertical className="w-4 h-4" />
                    </div>
                    <span className="font-mono text-xs font-medium text-muted-foreground uppercase">TIER {index + 1}</span>
                </div>
                <button
                    className="text-foreground/60 hover:text-destructive transition-colors disabled:opacity-30 disabled:hover:text-foreground/60"
                    onClick={() => removeFromChain(index)}
                    disabled={chainLength <= 2}
                    aria-label="Remove tier"
                >
                    <Trash2 className="w-3.5 h-3.5" />
                </button>
            </div>
            <Select value={url} onValueChange={(val) => updateChainUrl(index, val)}>
                <SelectTrigger className="w-full bg-transparent border-0 p-0 h-8 hover:bg-transparent focus:ring-0 shadow-none text-base font-medium focus-visible:ring-0">
                    <SelectValue placeholder={`Select Tier ${index + 1} addon...`}>
                        {(() => {
                            const selectedAddon = addons.find(a => a.transportUrl === url)
                            if (!selectedAddon) return null
                            return (
                                <div className="flex items-center gap-2">
                                    <AddonIcon
                                        name={selectedAddon.metadata?.customName || selectedAddon.manifest.name}
                                        logo={selectedAddon.metadata?.customLogo || selectedAddon.manifest.logo}
                                        className="h-5 w-5"
                                        textClassName="text-xs"
                                        imageClassName="p-0.5"
                                    />
                                    <span className="truncate">{selectedAddon.metadata?.customName || selectedAddon.manifest.name}</span>
                                </div>
                            )
                        })()}
                    </SelectValue>
                </SelectTrigger>
                <SelectContent>
                    {localAddons
                        .filter(addon => !chain.some((u, i) => i !== index && u === addon.transportUrl))
                        .map(addon => (
                        <SelectItem key={addon.transportUrl} value={addon.transportUrl}>
                            <div className="flex items-center gap-2">
                                <AddonIcon
                                    name={addon.metadata?.customName || addon.manifest.name}
                                    logo={addon.metadata?.customLogo || addon.manifest.logo}
                                    className="h-5 w-5"
                                    textClassName="text-xs"
                                    imageClassName="p-0.5"
                                />
                                <span>{addon.metadata?.customName || addon.manifest.name}</span>
                            </div>
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
        </div>
    )
})

const SortableRuleWrapper = memo(function SortableRuleWrapper({
    id, children,
}: {
    id: string
    children: React.ReactNode
}) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
    const style = {
        transform: CSS.Translate.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
        zIndex: isDragging ? 10 : 'auto' as const,
    }
    return (
        <div ref={setNodeRef} style={style} className="relative">
            <div
                {...attributes}
                {...listeners}
                className="absolute left-0 top-6 cursor-grab active:cursor-grabbing text-foreground/30 hover:text-foreground/60 transition-colors z-20 px-0.5"
                style={{ touchAction: 'none' }}
            >
                <GripVertical className="w-4 h-4" />
            </div>
            {children}
        </div>
    )
})

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
    const webhook = useFailoverStore(s => s.webhook)
    const setWebhook = useFailoverStore(s => s.setWebhook)
    const lastWorkerRun = useFailoverStore(s => s.lastWorkerRun)
    const lastCycle = useFailoverStore(s => s.lastCycle)
    const toggleAllRulesForAccount = useFailoverStore(s => s.toggleAllRulesForAccount)
    const isAutopilotLive = !!lastWorkerRun && (Date.now() - new Date(lastWorkerRun).getTime()) < 120_000

    const [chain, setChain] = useState<string[]>(["", ""])
    const [editingRuleId, setEditingRuleId] = useState<string | null>(null)
    const [webhookUrl, setWebhookUrl] = useState("")
    const [showWebhookConfirm, setShowWebhookConfirm] = useState(false)
    const [simulatingRuleId, setSimulatingRuleId] = useState<string | null>(null)
    const [simulationResults, setSimulationResults] = useState<Record<string, { healthy: boolean; checking: boolean; error?: string }>>({})

    const [ruleName, setRuleName] = useState("")
    const [cooldownMinutes, setCooldownMinutes] = useState<string>("")
    const [ruleWebhookUrl, setRuleWebhookUrl] = useState("")
    const [ruleNotifyMode, setRuleNotifyMode] = useState<'default' | 'custom' | 'off'>('default')
    const [ruleMessageTemplate, setRuleMessageTemplate] = useState("")
    const [isRuleDialogOpen, setIsRuleDialogOpen] = useState(false)
    const [ruleToDelete, setRuleToDelete] = useState<string | null>(null)
    const [customChecks, setCustomChecks] = useState<Array<{ url: string; appliesTo: string[] }>>([])
    const [urlTestResults, setUrlTestResults] = useState<Record<number, { status: 'ok' | 'fail' | 'checking'; code?: number; error?: string }>>({})
    const [expandedChecks, setExpandedChecks] = useState<Set<number>>(new Set())
    const [localActiveFailoverTab, setLocalActiveFailoverTab] = useState<FailoverView>("rules")
    const activeFailoverTab = activeView ?? localActiveFailoverTab
    const handleFailoverTabChange = useCallback((value: string) => {
        const next = value as FailoverView
        if (activeView === undefined) {
            setLocalActiveFailoverTab(next)
        }
        onActiveViewChange?.(next)
    }, [activeView, onActiveViewChange])

    const resetForm = () => {
        setChain(["", ""])
        setRuleName("")
        setCooldownMinutes("")
        setRuleWebhookUrl("")
        setRuleNotifyMode('default')
        setRuleMessageTemplate("")
        setCustomChecks([])
        setUrlTestResults({})
        setExpandedChecks(new Set())
        setEditingRuleId(null)
        setIsRuleDialogOpen(false)
    }

    useEffect(() => {
        setWebhookUrl(webhook.url)
    }, [webhook.url])

    const handleSaveWebhook = () => {
        if (webhook.url && webhookUrl && webhook.url !== webhookUrl) {
            setShowWebhookConfirm(true)
            return
        }
        doSaveWebhook()
    }

    const doSaveWebhook = () => {
        setWebhook(webhookUrl, !!webhookUrl)
        setShowWebhookConfirm(false)
        if (webhookUrl) {
            toast({ title: 'Notifications Enabled', description: 'Discord or Slack webhook saved.' })
        } else {
            toast({ title: 'Notifications Disabled', description: 'Webhook removed.' })
        }
    }

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
        const filteredChain = chain.filter(url => !!url)
        if (filteredChain.length < 2) {
            toast({ title: "Invalid Rule", description: "An autopilot chain needs at least 2 addons.", variant: "destructive" })
            return
        }
        if (hasDuplicateChainUrls(filteredChain)) {
            toast({ title: "Duplicate Addon", description: "Each Autopilot tier needs a different addon URL.", variant: "destructive" })
            return
        }

        const cooldownMs = cooldownMinutes ? parseInt(cooldownMinutes) * 60 * 1000 : undefined

        const notifyEnabled = ruleNotifyMode !== 'off'
        const webhookUrl = ruleNotifyMode === 'custom' ? ruleWebhookUrl.trim() : ''

        const messageTemplate = ruleMessageTemplate.trim() || undefined
        const filteredCustomChecks = customChecks
            .map(c => ({ url: c.url.trim(), appliesTo: c.appliesTo }))
            .filter(c => c.url.length > 0)
            .slice(0, 5)

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

        resetForm()
    }

    const addToChain = () => setChain([...chain, ""])
    const removeFromChain = (index: number) => setChain(chain.filter((_, i) => i !== index))
    const updateChainUrl = (index: number, url: string) => {
        const newChain = [...chain]
        newChain[index] = url
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



    const handleDuplicateRule = async (rule: typeof rules[0]) => {
        await addRule(accountId, [...rule.priorityChain], rule.name, rule.cooldown_ms, rule.webhookUrl, rule.notifyEnabled, rule.messageTemplate, rule.customCheckUrls?.map(c => ({ ...c })) || [])
        toast({ title: 'Rule Duplicated', description: 'A copy of the priority chain has been created.' })
    }

    const handleCopyRulesFrom = async (sourceAccountId: string) => {
        const sourceRules = rules.filter(r => r.accountId === sourceAccountId)
        if (sourceRules.length === 0) return

        let imported = 0
        for (const rule of sourceRules) {
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
        }

        const sourceName = accounts.find(a => a.id === sourceAccountId)?.name || 'Unknown'
        toast({
            title: 'Rules Imported',
            description: `Copied ${imported} rule${imported !== 1 ? 's' : ''} from ${sourceName}.`
        })
    }

    const runCustomCheck = async (url: string): Promise<{ ok: boolean; error?: string }> => {
        try {
            const { useSyncStore } = await import('@/store/syncStore')
            const { serverUrl } = useSyncStore.getState()
            const baseUrl = serverUrl || ''
            const result = await apiFetch<{ ok?: boolean; status?: number; error?: string }>('/autopilot/test-url', {
                method: 'POST',
                baseUrl: baseUrl.startsWith('http') ? baseUrl : undefined,
                body: { url },
            })
            if (!result.ok) return { ok: false, error: result.error || `Server error (${result.status})` }
            return { ok: Boolean(result.data?.ok), error: result.data?.error }
        } catch {
            return { ok: false, error: 'Request failed' }
        }
    }

    const handleSimulateRule = async (ruleId: string, chain: string[], customCheckUrls?: CustomCheckEntry[]) => {
        setSimulatingRuleId(ruleId)
        setSimulationResults({})

        const checks = normalizeCustomChecks(customCheckUrls).filter(c => c.url.trim())

        for (const url of chain) {
            setSimulationResults(prev => ({
                ...prev,
                [url]: { healthy: false, checking: true }
            }))

            try {
                const health = await checkAddonHealth(url)
                let healthy = health.isOnline
                let error = health.error

                // Mirrors engine.js: an unscoped check applies to every addon in the chain.
                if (healthy && checks.length > 0) {
                    const normUrl = normalizeAddonUrl(url).toLowerCase()
                    const applicable = checks.filter(c =>
                        c.appliesTo.length === 0 ||
                        c.appliesTo.some(au => normalizeAddonUrl(au).toLowerCase() === normUrl)
                    )
                    for (const checkUrl of [...new Set(applicable.map(c => c.url))]) {
                        const res = await runCustomCheck(checkUrl)
                        if (!res.ok) {
                            healthy = false
                            error = res.error ? `Health check failed: ${res.error}` : 'Health check failed'
                            break
                        }
                    }
                }

                setSimulationResults(prev => ({
                    ...prev,
                    [url]: { healthy, checking: false, error }
                }))
            } catch (err) {
                setSimulationResults(prev => ({
                    ...prev,
                    [url]: { healthy: false, checking: false, error: 'Check failed' }
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

    const handleDialogChainDragEnd = useCallback((event: DragEndEvent) => {
        const { active, over } = event
        if (!over || active.id === over.id) return
        const oldIndex = Number(active.id)
        const newIndex = Number(over.id)
        if (isNaN(oldIndex) || isNaN(newIndex)) return
        setChain(prev => arrayMove(prev, oldIndex, newIndex))
    }, [])

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
    const enabledRuleCount = accountRules.filter(rule => rule.isActive).length
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
            <Tabs value={activeFailoverTab} onValueChange={handleFailoverTabChange} className="space-y-6">
                {showViewTabs && (
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                        <div>
                            <h3 className="text-lg font-semibold flex items-center gap-2">
                                <ActiveFailoverIcon className="w-5 h-5" />
                                {activeFailoverMeta.title}
                            </h3>
                            <p className="text-xs text-muted-foreground mt-0.5">
                                {activeFailoverMeta.description}
                            </p>
                        </div>
                        <TabsList className="shrink-0">
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
                        </TabsList>
                    </div>
                )}

                <TabsContent value="webhooks" className="space-y-6">
                    <div className="bg-card border border-border/40 rounded-2xl p-5 space-y-4 shadow-sm">
                        <div className="flex items-start justify-between">
                            <div>
                                <h3 className="flex items-center gap-2 text-lg font-bold">
                                    <Webhook className="w-5 h-5 text-primary" />
                                    Global Webhook
                                </h3>
                                <div className="flex items-center gap-2 mt-2">
                                    <StatusChip variant={webhook.url ? 'success' : 'muted'}>
                                        <span className={`h-1.5 w-1.5 rounded-full ${webhook.url ? 'bg-success' : 'bg-muted-foreground/40'}`} />
                                        {webhook.url ? 'Active' : 'Not configured'}
                                    </StatusChip>
                                </div>
                                <p className="text-xs text-muted-foreground mt-1">Fallback for all rules unless a rule has its own custom webhook.</p>
                            </div>
                        </div>
                        <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center">
                            <Input
                                placeholder="https://discord.com/api/webhooks/... or Slack URL"
                                value={webhookUrl}
                                onChange={(e) => setWebhookUrl(e.target.value)}
                                className="bg-muted/30 border-border rounded-lg"
                            />
                            <div className="flex gap-2">
                                <Button size="sm" onClick={handleSaveWebhook}>Set Webhook</Button>
                                {webhook.url && (
                                    <Button
                                        size="sm"
                                        className="bg-muted/40 text-foreground/70 border border-border/40 hover:bg-muted/70 shadow-none"
                                        onClick={() => testWebhook(webhook.url, accountId, toast, account.name)}
                                    >
                                        Test
                                    </Button>
                                )}
                            </div>
                        </div>
                        <p className="text-xs text-muted-foreground/60 pt-1">
                            Supports Discord, Slack, and generic JSON webhooks. Platform is detected automatically from the URL.
                        </p>
                    </div>

                    <div className="bg-card border border-border/40 rounded-2xl p-5 space-y-4 shadow-sm">
                        <div>
                            <h3 className="flex items-center gap-2 text-lg font-bold">
                                <Webhook className="w-5 h-5 text-primary" />
                                Per-Rule Webhooks
                            </h3>
                            <p className="text-xs text-muted-foreground mt-1">Rules with a custom webhook configured. Edit a rule to change its webhook.</p>
                        </div>
                        {accountRules.filter(r => r.webhookUrl && r.notifyEnabled !== false).length === 0 ? (
                            <EmptyState
                                icon={<Webhook className="h-6 w-6" />}
                                title="No rules have a custom webhook configured"
                                description="Rules use the global webhook by default. Edit a rule to override it with a per-rule webhook URL."
                            />
                        ) : (
                            <div className="space-y-2">
                                {accountRules.filter(r => r.webhookUrl && r.notifyEnabled !== false).map(rule => (
                                    <div key={rule.id} className="flex items-center justify-between bg-muted/20 border border-border/40 rounded-xl px-4 py-3 gap-3">
                                        <div className="flex flex-col gap-0.5 min-w-0">
                                            <span className="text-sm font-medium truncate">
                                                {rule.name || `Rule ${rule.id.slice(0, 8)}`}
                                            </span>
                                            <span className="text-xs font-mono text-muted-foreground truncate max-w-xs">
                                                {rule.webhookUrl}
                                            </span>
                                        </div>
                                        <div className="flex gap-2 shrink-0">
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                onClick={() => {
                                                    setChain([...rule.priorityChain])
                                                    setRuleName(rule.name || '')
                                                    setCooldownMinutes(rule.cooldown_ms ? String(Math.round(rule.cooldown_ms / 60000)) : '')
                                                    setRuleNotifyMode(rule.notifyEnabled === false ? 'off' : rule.webhookUrl ? 'custom' : 'default')
                                                    setRuleWebhookUrl(rule.webhookUrl || '')
                                                    setRuleMessageTemplate(rule.messageTemplate || '')
                                                    const normalizedChecks = normalizeCustomChecks(rule.customCheckUrls)
                                                    setCustomChecks(normalizedChecks)
                                                    const initialExpanded = new Set<number>()
                                                    normalizedChecks.forEach((c, i) => { if (c.appliesTo.length > 0) initialExpanded.add(i) })
                                                    setExpandedChecks(initialExpanded)
                                                    setUrlTestResults({})
                                                    setEditingRuleId(rule.id)
                                                    handleFailoverTabChange("rules")
                                                    setIsRuleDialogOpen(true)
                                                }}
                                                className="gap-1.5"
                                            >
                                                <Pencil className="w-3.5 h-3.5" /> Edit
                                            </Button>
                                            <Button
                                                size="sm"
                                                className="bg-muted/40 text-foreground/70 border border-border/40 hover:bg-muted/70 shadow-none"
                                                onClick={() => testWebhook(rule.webhookUrl, accountId, toast, account.name)}
                                            >
                                                Test
                                            </Button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </TabsContent>

                <TabsContent value="rules" className="space-y-6">

                    <Dialog open={isRuleDialogOpen} onOpenChange={(open) => { if (!open) resetForm() }}>
                        <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
                            <DialogHeader>
                                <DialogTitle className="flex items-center gap-2 min-w-0">
                                    {editingRuleId
                                        ? <><Pencil className="w-5 h-5 text-primary" /> Edit Priority Chain</>
                                        : <><Plus className="w-5 h-5 text-primary" /> Create New Autopilot Rule</>
                                    }
                                </DialogTitle>
                                <p className="text-sm text-foreground/60">
                                    Define an ordered list of fallbacks. Autopilot will always try to keep the highest priority addon active.
                                </p>
                            </DialogHeader>

                            <div className="space-y-1.5 pt-4">
                                <label className="text-xs font-medium text-muted-foreground uppercase ml-1">Rule Name (Optional)</label>
                                <Input
                                    placeholder="e.g. My Primary Movies"
                                    value={ruleName}
                                    onChange={(e) => setRuleName(e.target.value)}
                                    className="bg-muted/30 border-border rounded-xl"
                                />
                            </div>

                            <div className="bg-muted/20 border border-border/40 rounded-2xl p-4 space-y-3">
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
                                        <SelectItem value="off">Off - no notifications for this rule</SelectItem>
                                    </SelectContent>
                                </Select>

                                {ruleNotifyMode !== 'off' && (
                                    <div className="space-y-1.5">
                                        <label className="text-xs font-medium text-muted-foreground uppercase ml-1">Notification Cooldown (minutes)</label>
                                        <p className="text-xs text-muted-foreground/60 ml-1 -mt-0.5 mb-1">Minimum time between notifications for this rule. Prevents alert spam during repeated failovers.</p>
                                        <Input
                                            type="number"
                                            placeholder="10"
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
                                            <Input
                                                placeholder="https://discord.com/api/webhooks/... or Slack URL"
                                                value={ruleWebhookUrl}
                                                onChange={(e) => setRuleWebhookUrl(e.target.value)}
                                                className="bg-muted/30 border-border rounded-xl"
                                            />
                                            {ruleWebhookUrl && (
                                                <Button
                                                    size="sm"
                                                    className="shrink-0 bg-muted/40 text-foreground/70 border border-border/40 hover:bg-muted/70 shadow-none"
                                                    onClick={() => testWebhook(ruleWebhookUrl.trim(), accountId, toast, account.name)}
                                                >
                                                    Test
                                                </Button>
                                            )}
                                        </div>
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

                            <div className="bg-muted/20 border border-border/40 rounded-2xl p-4 space-y-3">
                                <div className="space-y-0.5">
                                    <label className="text-xs font-medium text-muted-foreground uppercase">Custom Health Checks (Optional)</label>
                                    <p className="text-xs text-muted-foreground/60">Monitor a provider or service your addons depend on. If the URL goes down, all associated addons are skipped and the chain moves on. Associate a provider API URL with the addons that depend on it. Do NOT put your addon instance URLs here.</p>
                                </div>

                                {customChecks.map((check, index) => {
                                    const result = urlTestResults[index]
                                    const isExpanded = expandedChecks.has(index)
                                    const unassigned = getUnassignedAddons(index)
                                    return (
                                        <div key={index} className="rounded-xl border border-border/40 bg-muted/10 p-3 space-y-2">
                                            <div className="flex gap-2 items-center">
                                                <Input
                                                    placeholder="https://api.torbox.app/v1/api/user/me"
                                                    value={check.url}
                                                    onChange={(e) => updateCustomCheckUrl(index, e.target.value)}
                                                    className="bg-muted/30 border-border rounded-xl"
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
                                                                return (
                                                                    <div key={addonUrl} className="bg-muted/30 rounded-xl px-3 py-2 flex items-center gap-2">
                                                                        <AddonIcon
                                                                            name={addonName}
                                                                            logo={addonLogo}
                                                                            className="h-5 w-5"
                                                                            textClassName="text-xs"
                                                                            imageClassName="p-0.5"
                                                                        />
                                                                        <span className="text-sm truncate flex-1">{addonName}</span>
                                                                        <button
                                                                            type="button"
                                                                            className="text-foreground/60 hover:text-destructive transition-colors shrink-0 px-1"
                                                                            onClick={() => toggleAddonForCheck(index, addonUrl)}
                                                                            aria-label="Remove addon"
                                                                        >
                                                                            <Trash2 className="w-3.5 h-3.5" />
                                                                        </button>
                                                                    </div>
                                                                )
                                                            })
                                                        )}
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
                                            />
                                        ))}
                                    </div>
                                </SortableContext>
                            </DndContext>
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={addToChain}
                                className="w-full bg-muted/30 border border-dashed border-border/40 hover:bg-muted/50 text-foreground/60 hover:text-foreground h-12 rounded-2xl gap-2 mt-3"
                            >
                                <Plus className="w-4 h-4" /> Add Fallback Tier
                            </Button>

                            <div className="flex justify-end gap-3 pt-2 mt-4 [&_button]:h-11 [&_button]:rounded-full [&_button]:px-5">
                                <Button variant="ghost" onClick={resetForm}>
                                    Cancel
                                </Button>
                                <Button
                                    size="sm"
                                    className="bg-primary hover:bg-primary/90 text-primary-foreground font-bold"
                                    onClick={handleSaveRule}
                                    disabled={chain.filter(u => !!u).length < 2}
                                >
                                    {editingRuleId ? "Update Chain" : "Enable Autopilot"}
                                </Button>
                            </div>
                        </DialogContent>
                    </Dialog>

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

                        {accountRules.length === 0 ? (
                            <div className="rounded-2xl border border-border/40 bg-card p-5 shadow-sm">
                                <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-stretch">
                                    <div className="flex flex-col justify-between gap-6">
                                        <div className="space-y-4">
                                            <div className="flex flex-wrap items-center gap-2">
                                                <StatusChip icon={<Shield />} size="md" className="rounded-lg bg-muted/30">
                                                    No rules
                                                </StatusChip>
                                                {lastWorkerRun && (
                                                    <StatusChip size="md" className="rounded-lg bg-muted/30">
                                                        <span className={`h-1.5 w-1.5 rounded-full ${isAutopilotLive ? 'bg-success' : 'bg-warning'}`} />
                                                        {isAutopilotLive ? 'Live' : 'Standby'}
                                                    </StatusChip>
                                                )}
                                            </div>
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
                                                    resetForm()
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
                                    <div className="rounded-2xl border border-dashed border-border/50 bg-muted/10 p-4">
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
                                    <StatusChip icon={<Shield />} size="md" className="rounded-lg bg-muted/30">
                                        {accountRules.length === 0 ? 'No rules' : `${enabledRuleCount}/${accountRules.length} enabled`}
                                    </StatusChip>
                                    {lastWorkerRun && (
                                        <StatusChip size="md" className="rounded-lg bg-muted/30">
                                            <span className={`h-1.5 w-1.5 rounded-full ${isAutopilotLive ? 'bg-success' : 'bg-warning'}`} />
                                            {isAutopilotLive ? 'Live' : 'Standby'}
                                        </StatusChip>
                                    )}
                                    {lastCycle?.budgetHit && (
                                        <StatusChip
                                            size="md"
                                            variant="primary"
                                            className="rounded-lg"
                                        >
                                            Budgeted scan
                                        </StatusChip>
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
                                            <Tooltip content="Resume all autopilot rules for this account">
                                                <Button
                                                    size="sm"
                                                    variant="outline"
                                                    className="gap-1.5 h-8 text-xs font-medium"
                                                    onClick={() => toggleAllRulesForAccount(accountId, true)}
                                                >
                                                    <Play className="h-3.5 w-3.5" /> Resume
                                                </Button>
                                            </Tooltip>
                                            <Tooltip content="Pause all autopilot rules for this account">
                                                <Button
                                                    size="sm"
                                                    variant="outline"
                                                    className="gap-1.5 h-8 text-xs font-medium"
                                                    onClick={() => toggleAllRulesForAccount(accountId, false)}
                                                >
                                                    <Pause className="h-3.5 w-3.5" /> Pause
                                                </Button>
                                            </Tooltip>
                                        </>
                                    )}
                                    <Button
                                        size="sm"
                                        onClick={() => {
                                            resetForm()
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
                                        return (
                                            <SortableRuleWrapper key={rule.id} id={rule.id}>
                                                <div className="bg-card border border-border/40 rounded-2xl p-5 pl-8 flex flex-col gap-5 shadow-sm min-w-0">
                                        <div className="flex items-center justify-between gap-3">
                                            <div className="flex items-center gap-3 min-w-0 flex-1">
                                                <Tooltip content={rule.name || `RULE ${rule.id.slice(0, 8)}`}>
                                                    <div className="font-mono text-xs font-semibold text-foreground/60 uppercase bg-muted/50 border border-border/40 px-2.5 py-1 rounded-lg truncate min-w-0">
                                                        {rule.name || `RULE ${rule.id.slice(0, 8)}`}
                                                    </div>
                                                </Tooltip>
                                                {rule.cooldown_ms && (
                                                    <div className="flex items-center gap-1.5 font-mono text-xs font-semibold text-warning opacity-60">
                                                        <Activity className="w-3 h-3" />
                                                        {Math.round(rule.cooldown_ms / 60000)}m
                                                    </div>
                                                )}
                                                {rule.notifyEnabled === false ? (
                                                    <StatusChip icon={<XCircle />} variant="muted">
                                                        Silent
                                                    </StatusChip>
                                                ) : rule.webhookUrl ? (
                                                    <span className="inline-flex items-center gap-1.5">
                                                        <StatusChip icon={<Webhook />} variant="primary">
                                                            Custom
                                                        </StatusChip>
                                                        <Button
                                                            size="sm"
                                                             variant="outline"
                                                             className="h-6 px-2 text-xs font-medium shadow-none"
                                                            onClick={(e) => { e.stopPropagation(); testWebhook(rule.webhookUrl, accountId, toast, account.name) }}
                                                        >
                                                            Test Webhook
                                                        </Button>
                                                    </span>
                                                ) : (
                                                    <StatusChip icon={<Webhook />} variant="muted">
                                                        Global
                                                    </StatusChip>
                                                )}
                                            </div>
                                            <div className="flex items-center gap-3 shrink-0">
                                                <div className="flex items-center gap-2 mr-1">
                                                    <span className={`text-xs uppercase font-semibold ${rule.isActive ? 'text-primary' : 'text-foreground/60'}`}>
                                                        {rule.isActive ? 'On' : 'Off'}
                                                    </span>
                                                    <Switch
                                                        checked={rule.isActive}
                                                        onCheckedChange={(c) => updateRule(rule.id, {
                                                            isActive: c,
                                                            isAutomatic: c
                                                        })}
                                                    />
                                                </div>
                                                <DropdownMenu>
                                                    <DropdownMenuTrigger asChild>
                                                        <Button variant="ghost" size="icon" className="h-8 w-8 hover:bg-foreground/10 text-foreground/60" aria-label="More options">
                                                            <MoreVertical className="w-4 h-4" />
                                                        </Button>
                                                    </DropdownMenuTrigger>
                                                    <DropdownMenuContent align="end" className="w-48">
                                                        <DropdownMenuItem className="gap-2" onClick={() => handleSimulateRule(rule.id, rule.priorityChain, rule.customCheckUrls)}>
                                                            <FlaskConical className="w-4 h-4" />
                                                            Simulate Check
                                                        </DropdownMenuItem>
                                                        <DropdownMenuItem className="gap-2" onClick={() => {
                                                            setChain([...rule.priorityChain])
                                                            setRuleName(rule.name || '')
                                                            setCooldownMinutes(rule.cooldown_ms ? String(Math.round(rule.cooldown_ms / 60000)) : '')
                                                            setRuleNotifyMode(rule.notifyEnabled === false ? 'off' : rule.webhookUrl ? 'custom' : 'default')
                                                            setRuleWebhookUrl(rule.webhookUrl || '')
                                                            setRuleMessageTemplate(rule.messageTemplate || '')
                                                            const normalizedChecks = normalizeCustomChecks(rule.customCheckUrls)
                                                            setCustomChecks(normalizedChecks)
                                                            const initialExpanded = new Set<number>()
                                                            normalizedChecks.forEach((c, i) => { if (c.appliesTo.length > 0) initialExpanded.add(i) })
                                                            setExpandedChecks(initialExpanded)
                                                            setUrlTestResults({})
                                                            setEditingRuleId(rule.id)
                                                            setIsRuleDialogOpen(true)
                                                        }}>
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
                                                <div className="flex flex-col relative w-full px-2">
                                                    {rule.priorityChain.map((url, idx) => {
                                                        const addon = getAddonForUrl(url)
                                                        const isActiveInRule = normalizeAddonUrl(url) === normalizeAddonUrl(activeUrl || '')
                                                        const isTier1 = idx === 0
                                                        const isFailedOver = isActiveInRule && !isTier1
                                                        const name = addon?.metadata?.customName || identifyAddon(url, addon?.manifest).name
                                                        const logo = addon?.metadata?.customLogo || addon?.manifest.logo
                                                        return (
                                                            <SortableChainTier
                                                                key={url}
                                                                id={url}
                                                                url={url}
                                                                idx={idx}
                                                                chainLength={rule.priorityChain.length}
                                                                isActiveInRule={isActiveInRule}
                                                                isTier1={isTier1}
                                                                isFailedOver={isFailedOver}
                                                                addonName={name}
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
                                        />

                                        {simulatingRuleId === rule.id && (
                                            <div className="mx-2 p-4 rounded-xl bg-primary/5 border-primary/25 space-y-3 animate-in fade-in slide-in-from-top-1 duration-200">
                                                <div className="flex items-center justify-between">
                                                    <div className="flex items-center gap-2 text-primary">
                                                        <FlaskConical className="w-4 h-4" />
                                                        <span className="text-xs font-medium uppercase">Autopilot Simulation</span>
                                                    </div>
                                                    <Button
                                                        variant="ghost"
                                                        size="sm"
                                                        className="h-6 px-2 text-xs font-semibold text-foreground/60 hover:text-foreground"
                                                        onClick={() => setSimulatingRuleId(null)}
                                                    >
                                                        CLOSE
                                                    </Button>
                                                </div>

                                                <div className="space-y-2">
                                                    {rule.priorityChain.map((url, idx) => {
                                                        const result = simulationResults[url]
                                                        const addon = addons.find(a => a.transportUrl === url)
                                                        return (
                                                            <div key={idx} className="flex items-center justify-between text-xs">
                                                                <div className="flex items-center gap-2 text-foreground/70">
                                                                    <span className="font-mono text-xs opacity-30">T{idx + 1}</span>
                                                                    <span className="truncate max-w-[150px]">{addon?.metadata?.customName || identifyAddon(url, addon?.manifest).name}</span>
                                                                </div>
                                                                <div className="flex items-center gap-2">
                                                                    {result?.checking ? (
                                                                        <Loader2 className="w-3 h-3 text-primary animate-spin" />
                                                                    ) : result?.healthy ? (
                                                                        <Check className="w-3 h-3 text-success" />
                                                                    ) : result ? (
                                                                        <div className="flex items-center gap-1.5">
                                                                            {!result.healthy && result.error && (
                                                                                <Tooltip content={result.error}>
                                                                                    <span className="text-xs text-foreground/60 truncate max-w-[120px]">
                                                                                        {result.error}
                                                                                    </span>
                                                                                </Tooltip>
                                                                            )}
                                                                            <XCircle className="w-3 h-3 text-destructive" />
                                                                        </div>
                                                                    ) : (
                                                                        <div className="w-3 h-3 rounded-full border border-border/40" />
                                                                    )}
                                                                </div>
                                                            </div>
                                                        )
                                                    })}
                                                </div>

                                                {!rule.priorityChain.some(url => simulationResults[url]?.checking) && Object.keys(simulationResults).length > 0 && (
                                                    <div className="pt-2 border-t border-primary/10">
                                                        <p className="text-xs text-foreground/90 leading-relaxed">
                                                            <span className="font-bold text-primary mr-1">CONCLUSION:</span>
                                                            {(() => {
                                                                const primaryUrl = rule.priorityChain[0]
                                                                const isPrimaryHealthy = simulationResults[primaryUrl]?.healthy
                                                                if (isPrimaryHealthy) {
                                                                    const addon = addons.find(a => a.transportUrl === primaryUrl)
                                                                    return `${addon?.metadata?.customName || identifyAddon(primaryUrl, addon?.manifest).name} is healthy - no failover needed.`
                                                                }

                                                                const healthyFallback = rule.priorityChain.find((url, idx) => idx > 0 && simulationResults[url]?.healthy)
                                                                if (healthyFallback) {
                                                                    const fallbackAddon = addons.find(a => a.transportUrl === healthyFallback)
                                                                    const primaryAddon = addons.find(a => a.transportUrl === primaryUrl)
                                                                    return `Would failover from ${primaryAddon?.metadata?.customName || identifyAddon(primaryUrl, primaryAddon?.manifest).name} to ${fallbackAddon?.metadata?.customName || identifyAddon(healthyFallback, fallbackAddon?.manifest).name} (first healthy fallback).`
                                                                }

                                                                return "All addons in the chain are currently unreachable. Rule would stay in its current state."
                                                            })()}
                                                        </p>
                                                    </div>
                                                )}
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
            </Tabs>

            <ConfirmationDialog
                open={showWebhookConfirm}
                onOpenChange={setShowWebhookConfirm}
                title="Replace Webhook URL?"
                description="You already have a webhook configured. Are you sure you want to replace it with this new URL?"
                confirmText="Replace Webhook"
                onConfirm={doSaveWebhook}
            />

            <ConfirmationDialog
                open={!!ruleToDelete}
                onOpenChange={(open) => !open && setRuleToDelete(null)}
                title="Delete Rule?"
                description="Are you sure you want to delete this autopilot rule? This cannot be undone."
                confirmText="Delete"
                isDestructive={true}
                onConfirm={() => { if (ruleToDelete) { removeRule(ruleToDelete); setRuleToDelete(null) } }}
            />
        </div >
    )
}

type FailoverAddon = AddonDescriptor & { manifestUrl?: string }

const ChainPill = memo(({ url, status, addons }: { url: string; status: 'active' | 'failed' | 'idle'; addons: FailoverAddon[] }) => {
    const normUrl = normalizeAddonUrl(url).toLowerCase()
    const addon = addons.find(a => {
        const aNorm = normalizeAddonUrl(a.transportUrl || '').toLowerCase()
        return aNorm === normUrl || (a.manifestUrl && normalizeAddonUrl(a.manifestUrl).toLowerCase() === normUrl)
    })
    const displayName = addon?.metadata?.customName || addon?.manifest?.name || identifyAddon(url).name
    const logo = addon?.metadata?.customLogo || addon?.manifest?.logo || identifyAddon(url).logo

    const styles: Record<string, { wrapper: string; dot: string }> = {
        active: { wrapper: 'border-success/30 bg-success/10 text-success', dot: 'bg-success shadow-sm shadow-success/30' },
        failed: { wrapper: 'border-destructive/30 bg-destructive/10 text-destructive', dot: 'bg-destructive shadow-sm shadow-destructive/30' },
        idle: { wrapper: 'border-border/30 bg-muted/20 text-muted-foreground', dot: 'bg-muted-foreground/25' },
    }
    const s = styles[status]

    return (
        <span className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-semibold ${s.wrapper}`}>
            <span className={`h-2 w-2 shrink-0 rounded-full ${s.dot}`} />
            {logo ? (
                <img src={logo} alt="" className="h-4 w-4 rounded-sm object-contain" loading="lazy" />
            ) : null}
            <Tooltip content={url}>
            <span className="truncate max-w-[120px]">{displayName}</span>
        </Tooltip>
        </span>
    )
})
ChainPill.displayName = 'ChainPill'

function FailoverHistory({ addons, accountId }: { addons: FailoverAddon[]; accountId: string }) {
    const allLogs = useHistoryStore(s => s.logs)
    const initialize = useHistoryStore(s => s.initialize)
    const clearLogs = useHistoryStore(s => s.clearLogs)
    const rulesCount = useFailoverStore(s => s.rules.filter(rule => rule.accountId === accountId).length)
    const logs = useMemo(() => allLogs.filter(l => l.accountId === accountId), [allLogs, accountId])
    const [showClearConfirm, setShowClearConfirm] = useState(false)
    const [isClearing, setIsClearing] = useState(false)

    const handleClearLogs = async () => {
        setIsClearing(true)
        try {
            await clearLogs()
            setShowClearConfirm(false)
        } finally {
            setIsClearing(false)
        }
    }

    const resolveUrlToName = (url: string) => {
        if (!url || !url.startsWith('http')) return url;
        const cleanUrl = url.replace(/[,.]$/, '');
        const normClean = normalizeAddonUrl(cleanUrl).toLowerCase();
        const addon = addons.find(a => {
            const aNorm = normalizeAddonUrl(a.transportUrl || '').toLowerCase()
            return aNorm === normClean || (a.manifestUrl && normalizeAddonUrl(a.manifestUrl).toLowerCase() === normClean)
        });
        let name = cleanUrl;
        if (addon) {
            name = addon.metadata?.customName || identifyAddon(cleanUrl, addon.manifest).name;
        } else {
            try {
                name = new URL(cleanUrl).hostname;
            } catch {
                name = cleanUrl;
            }
        }
        return url.replace(cleanUrl, name);
    }

    useEffect(() => {
        initialize()
    }, [initialize, accountId])

    if (logs.length === 0) {
        return (
            <FailoverEmptyState rulesCount={rulesCount} addonsCount={addons.length} />
        )
    }

    return (
        <>
        <div className="bg-card border border-border/40 rounded-2xl p-5 mb-6 shadow-sm">
            <div className="flex items-center justify-between mb-5">
                <div>
                    <h3 className="text-lg font-bold">Event Log</h3>
                    <p className="text-sm text-foreground/60">Recent autopilot and recovery actions.</p>
                </div>
                <Button size="sm" variant="outline" onClick={() => setShowClearConfirm(true)} disabled={isClearing}>
                    {isClearing ? 'Clearing...' : 'Clear Log'}
                </Button>
            </div>
            <div className="space-y-3">
                {logs.map((log) => {
                    const logDate = log.timestamp ? new Date(log.timestamp) : null;
                    const isValidLogDate = logDate && !isNaN(logDate.getTime());

                    let Icon = Activity;
                    let typeColor = 'text-muted-foreground';
                    let typeVariant: 'muted' | 'primary' | 'success' | 'destructive' = 'muted';
                    let cardBg = 'bg-muted/20';
                    let iconBg = 'bg-muted/40';

                    if (log.type === 'failover') {
                        Icon = AlertTriangle;
                        typeColor = 'text-destructive';
                        typeVariant = 'destructive';
                        cardBg = 'bg-destructive/5';
                        iconBg = 'bg-destructive/15';
                    } else if (log.type === 'recovery') {
                        Icon = Check;
                        typeColor = 'text-success';
                        typeVariant = 'success';
                        cardBg = 'bg-success/5';
                        iconBg = 'bg-success/15';
                    } else if (log.type === 'self-healing') {
                        Icon = Activity;
                        typeColor = 'text-primary';
                        typeVariant = 'primary';
                        cardBg = 'bg-primary/5';
                        iconBg = 'bg-primary/15';
                    }

                    const chain = (log.metadata?.chain as string[] | undefined)
                    const activeUrl = log.metadata?.activeUrl as string | undefined
                    const latencyMs = log.metadata?.latencyMs as number | undefined

                    return (
                        <div key={log.id} className={`rounded-xl border border-border/30 ${cardBg} p-4`}>
                            <div className="flex items-start gap-3">
                                <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${iconBg}`}>
                                    <Icon className={`w-4 h-4 ${typeColor}`} />
                                </div>
                                <div className="flex-1 min-w-0 space-y-2.5">
                                    <div className="flex items-center justify-between gap-2">
                                        <div className="flex items-center gap-2">
                                            <StatusChip variant={typeVariant} size="sm">
                                                {log.type}
                                            </StatusChip>
                                            {latencyMs != null && (
                                                <span className="text-xs font-mono text-muted-foreground/50 bg-muted/30 rounded px-1.5 py-0.5">
                                                    {latencyMs < 1000 ? `${Math.round(latencyMs)}ms` : `${(latencyMs / 1000).toFixed(1)}s`}
                                                </span>
                                            )}
                                        </div>
                                        <span className="font-mono text-[11px] text-muted-foreground/50 shrink-0">
                                            {isValidLogDate && logDate ? formatDistanceToNow(logDate, { addSuffix: true }) : 'Unknown time'}
                                        </span>
                                    </div>
                                    {chain && chain.length > 0 ? (
                                        <div className="flex flex-wrap items-center gap-1.5">
                                            {chain.map((url, i) => {
                                                const isActive = activeUrl && normalizeAddonUrl(url).toLowerCase() === normalizeAddonUrl(activeUrl).toLowerCase()
                                                const isPrimary = i === 0
                                                const isFailed = log.type === 'failover' && isPrimary
                                                const status = isActive ? 'active' : isFailed ? 'failed' : 'idle'
                                                return (
                                                    <span key={i} className="flex items-center gap-1.5">
                                                        <ChainPill url={url} status={status} addons={addons} />
                                                        {i < chain.length - 1 && (
                                                            <ArrowRight className="w-3.5 h-3.5 text-muted-foreground/25 shrink-0" />
                                                        )}
                                                    </span>
                                                )
                                            })}
                                        </div>
                                    ) : (
                                        <div className="text-sm font-medium truncate">
                                            {resolveUrlToName(log.primaryName || 'System')}
                                        </div>
                                    )}
                                    <div className="text-[11px] text-foreground/40 leading-relaxed">
                                        {log.message.split(' ').map(word => word.startsWith('http') ? resolveUrlToName(word) : word).join(' ')}
                                    </div>
                                </div>
                            </div>
                        </div>
                    )
                })}
            </div>
        </div>
        <ConfirmationDialog
            open={showClearConfirm}
            onOpenChange={(open) => {
                if (!open && isClearing) return
                setShowClearConfirm(open)
            }}
            title="Clear Event Log?"
            description="This will permanently remove saved autopilot history. This cannot be undone."
            confirmText="Clear Log"
            isDestructive
            isLoading={isClearing}
            onConfirm={() => { void handleClearLogs() }}
        />
        </>
    )
}
