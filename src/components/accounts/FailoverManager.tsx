import { Button } from "@/components/ui/button"
import axios from "axios"
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
import { useHistoryStore } from "@/store/historyStore"
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog"
import { ArrowRight, AlertTriangle, Activity, Trash2, Plus, History, Pencil, Webhook, Check, Copy, Download, FlaskConical, XCircle, Loader2 } from "lucide-react"
import { useState, useEffect, useMemo } from "react"
import { identifyAddon } from "@/lib/addon-identifier"
import { toast } from "@/hooks/use-toast"
import { formatDistanceToNow } from "date-fns"
import { checkAddonHealth } from "@/lib/addon-health"
import { Input } from "@/components/ui/input"
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog"

interface FailoverManagerProps {
    accountId: string
}

export function FailoverManager({ accountId }: FailoverManagerProps) {
    const accounts = useAccountStore((state) => state.accounts)
    const account = accounts.find((a) => a.id === accountId)
    const {
        rules,
        addRule,
        updateRule,
        removeRule,
        webhook,
        setWebhook,
        lastWorkerRun,
        toggleAllRulesForAccount
    } = useFailoverStore()

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

    const [isRuleDialogOpen, setIsRuleDialogOpen] = useState(false)
    const [activeFailoverTab, setActiveFailoverTab] = useState("rules")

    const resetForm = () => {
        setChain(["", ""])
        setRuleName("")
        setCooldownMinutes("")
        setRuleWebhookUrl("")
        setRuleNotifyMode('default')
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

    if (!account) return null

    const accountRules = rules.filter(r => r.accountId === accountId)
    const localAddons = account.addons

    // Use allAddonsForLabeling for name resolution in rule display,
    // but localAddons for the selection dropdown to prevent cross-account leaks.
    const addons = allAddonsForLabeling

    const handleSaveRule = async () => {
        const filteredChain = chain.filter(url => !!url)
        if (filteredChain.length < 2) {
            toast({ title: "Invalid Rule", description: "A failover chain needs at least 2 addons.", variant: "destructive" })
            return
        }

        const cooldownMs = cooldownMinutes ? parseInt(cooldownMinutes) * 60 * 1000 : undefined

        const notifyEnabled = ruleNotifyMode !== 'off'
        const webhookUrl = ruleNotifyMode === 'custom' ? ruleWebhookUrl.trim() : ''

        if (editingRuleId) {
            await updateRule(editingRuleId, {
                priorityChain: filteredChain,
                activeUrl: filteredChain[0],
                name: ruleName.trim() || undefined,
                cooldown_ms: cooldownMs,
                notifyEnabled,
                webhookUrl,
            })
            toast({ title: "Rule Updated", description: "Rule settings modified." })
            setEditingRuleId(null)
        } else {
            await addRule(accountId, filteredChain, ruleName.trim() || undefined, cooldownMs, webhookUrl, notifyEnabled)
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



    const handleDuplicateRule = async (rule: typeof rules[0]) => {
        await addRule(accountId, [...rule.priorityChain])
        toast({ title: 'Rule Duplicated', description: 'A copy of the priority chain has been created.' })
    }

    const handleCopyRulesFrom = async (sourceAccountId: string) => {
        const sourceRules = rules.filter(r => r.accountId === sourceAccountId)
        if (sourceRules.length === 0) return

        let imported = 0
        for (const rule of sourceRules) {
            await addRule(accountId, [...rule.priorityChain])
            imported++
        }

        const sourceName = accounts.find(a => a.id === sourceAccountId)?.name || 'Unknown'
        toast({
            title: 'Rules Imported',
            description: `Copied ${imported} rule${imported !== 1 ? 's' : ''} from ${sourceName}.`
        })
    }

    const handleSimulateRule = async (ruleId: string, chain: string[]) => {
        setSimulatingRuleId(ruleId)
        setSimulationResults({})

        for (const url of chain) {
            setSimulationResults(prev => ({
                ...prev,
                [url]: { healthy: false, checking: true }
            }))

            try {
                const health = await checkAddonHealth(url)
                setSimulationResults(prev => ({
                    ...prev,
                    [url]: { healthy: health.isOnline, checking: false, error: health.error }
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
        if (!isActiveInRule) return 'bg-white/[0.03] border-l-[3px] border-l-transparent'
        if (isTier1) return 'bg-white/[0.08] border-l-[3px] border-l-primary'
        return 'bg-amber-500/[0.08] border-l-[3px] border-amber-500'
    }

    return (
        <div className="space-y-6">
            <Tabs value={activeFailoverTab} onValueChange={setActiveFailoverTab} className="space-y-6">
                <TabsList className="flex flex-wrap h-auto bg-transparent p-0 gap-2 justify-start w-full pb-2">
                    <TabsTrigger
                        value="rules"
                        className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground rounded-full px-4 border border-border/50 data-[state=active]:border-transparent bg-muted/30 shrink-0 shadow-sm transition-all"
                    >
                        <Activity className="w-4 h-4 mr-2" />
                        Autopilot Rules
                    </TabsTrigger>
                    <TabsTrigger
                        value="history"
                        className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground rounded-full px-4 border border-border/50 data-[state=active]:border-transparent bg-muted/30 shrink-0 shadow-sm transition-all"
                    >
                        <History className="w-4 h-4 mr-2" />
                        Failover History
                    </TabsTrigger>
                    <TabsTrigger
                        value="webhooks"
                        className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground rounded-full px-4 border border-border/50 data-[state=active]:border-transparent bg-muted/30 shrink-0 shadow-sm transition-all"
                    >
                        <Webhook className="w-4 h-4 mr-2" />
                        Webhooks
                    </TabsTrigger>
                </TabsList>

                <TabsContent value="webhooks" className="space-y-6">
                    <div className="bg-muted/30 border border-border rounded-2xl p-5 space-y-4">
                        <div className="flex items-start justify-between">
                            <div>
                                <h3 className="flex items-center gap-2 text-lg font-bold">
                                    <Webhook className="w-5 h-5 text-primary" />
                                    Global Webhook
                                </h3>
                                <div className="flex items-center gap-2 mt-2">
                                    {webhook.url ? (
                                        <>
                                            <span className="w-2 h-2 rounded-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.5)]"></span>
                                            <span className="text-xs font-mono font-bold text-green-400/80 uppercase tracking-widest">ACTIVE</span>
                                        </>
                                    ) : (
                                        <>
                                            <span className="w-2 h-2 rounded-full bg-muted-foreground/20"></span>
                                            <span className="text-xs font-mono font-bold text-foreground/30 uppercase tracking-widest">NOT CONFIGURED</span>
                                        </>
                                    )}
                                </div>
                                <p className="text-xs text-muted-foreground mt-1">Fallback for all rules unless a rule has its own custom webhook.</p>
                            </div>
                        </div>
                        <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center">
                            <Input
                                placeholder="https://discord.com/api/webhooks/... or Slack URL"
                                value={webhookUrl}
                                onChange={(e) => setWebhookUrl(e.target.value)}
                                className="bg-muted/30 border-border rounded-[10px]"
                            />
                            <div className="flex gap-2">
                                <Button size="sm" onClick={handleSaveWebhook}>Set Webhook</Button>
                                {webhook.url && (
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={async () => {
                                            try {
                                                const { useSyncStore } = await import('@/store/syncStore')
                                                const { serverUrl } = useSyncStore.getState()
                                                const baseUrl = serverUrl || ''
                                                const apiPath = baseUrl.startsWith('http') ? `${baseUrl.replace(/\/$/, '')}/api` : '/api'

                                                await axios.post(`${apiPath}/autopilot/test-webhook`, {
                                                    webhookUrl: webhook.url,
                                                    accountName: account.name
                                                })
                                                toast({ title: 'Test Sent', description: 'Check your notification channel.' })
                                            } catch (err) {
                                                toast({ title: 'Test Failed', description: 'Invalid webhook URL or server error.', variant: 'destructive' })
                                            }
                                        }}
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

                    {/* Per-Rule Webhooks */}
                    <div className="bg-muted/30 border border-border rounded-2xl p-5 space-y-4">
                        <div>
                            <h3 className="flex items-center gap-2 text-lg font-bold">
                                <Webhook className="w-5 h-5 text-blue-400" />
                                Per-Rule Webhooks
                            </h3>
                            <p className="text-xs text-muted-foreground mt-1">Rules with a custom webhook configured. Edit a rule to change its webhook.</p>
                        </div>
                        {accountRules.filter(r => r.webhookUrl && r.notifyEnabled !== false).length === 0 ? (
                            <div className="text-center py-6 text-muted-foreground bg-muted/20 rounded-lg border border-dashed text-sm">
                                No rules have a custom webhook configured. Rules use the global webhook by default.
                            </div>
                        ) : (
                            <div className="space-y-2">
                                {accountRules.filter(r => r.webhookUrl && r.notifyEnabled !== false).map(rule => (
                                    <div key={rule.id} className="flex items-center justify-between bg-muted/20 border border-border/50 rounded-xl px-4 py-3 gap-3">
                                        <div className="flex flex-col gap-0.5 min-w-0">
                                            <span className="text-sm font-medium truncate">
                                                {rule.name || `Rule ${rule.id.slice(0, 8)}`}
                                            </span>
                                            <span className="text-[11px] font-mono text-muted-foreground truncate max-w-xs">
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
                                                    setEditingRuleId(rule.id)
                                                    setActiveFailoverTab("rules")
                                                    setIsRuleDialogOpen(true)
                                                }}
                                            >
                                                <Pencil className="w-3.5 h-3.5 mr-1" /> Edit
                                            </Button>
                                            <Button
                                                variant="outline"
                                                size="sm"
                                                onClick={async () => {
                                                    try {
                                                        const { useSyncStore } = await import('@/store/syncStore')
                                                        const { serverUrl } = useSyncStore.getState()
                                                        const baseUrl = serverUrl || ''
                                                        const apiPath = baseUrl.startsWith('http') ? `${baseUrl.replace(/\/$/, '')}/api` : '/api'
                                                        await axios.post(`${apiPath}/autopilot/test-webhook`, {
                                                            webhookUrl: rule.webhookUrl,
                                                            accountName: account.name
                                                        })
                                                        toast({ title: 'Test Sent', description: 'Check your notification channel.' })
                                                    } catch (err) {
                                                        toast({ title: 'Test Failed', description: 'Invalid URL or server error.', variant: 'destructive' })
                                                    }
                                                }}
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
                                <DialogTitle className="flex items-center gap-2">
                                    {editingRuleId
                                        ? <><Pencil className="w-5 h-5 text-primary" /> Edit Priority Chain</>
                                        : <><Plus className="w-5 h-5 text-primary" /> Create New Autopilot Rule</>
                                    }
                                </DialogTitle>
                                <p className="text-sm text-foreground/50">
                                    Define an ordered list of fallbacks. Autopilot will always try to keep the highest priority addon active.
                                </p>
                            </DialogHeader>

                            <div className="space-y-1.5 pt-4">
                                <label className="text-[10px] font-bold uppercase tracking-widest text-foreground/30 ml-1">Rule Name (Optional)</label>
                                <Input
                                    placeholder="e.g. My Primary Movies"
                                    value={ruleName}
                                    onChange={(e) => setRuleName(e.target.value)}
                                    className="bg-muted/30 border-border rounded-xl"
                                />
                            </div>

                            <div className="bg-muted/20 border border-border/50 rounded-xl p-4 space-y-3">
                                <label className="text-[10px] font-bold uppercase tracking-widest text-foreground/30">Notifications</label>

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
                                        <SelectItem value="off">Off — no notifications for this rule</SelectItem>
                                    </SelectContent>
                                </Select>

                                {ruleNotifyMode !== 'off' && (
                                    <div className="space-y-1.5">
                                        <label className="text-[10px] font-bold uppercase tracking-widest text-foreground/30 ml-1">Cooldown (Minutes)</label>
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
                                        <label className="text-[10px] font-bold uppercase tracking-widest text-foreground/30 ml-1">Custom Webhook URL</label>
                                        <div className="flex gap-2">
                                            <Input
                                                placeholder="https://discord.com/api/webhooks/... or Slack URL"
                                                value={ruleWebhookUrl}
                                                onChange={(e) => setRuleWebhookUrl(e.target.value)}
                                                className="bg-muted/30 border-border rounded-xl"
                                            />
                                            {ruleWebhookUrl && (
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    className="shrink-0"
                                                    onClick={async () => {
                                                        try {
                                                            const { useSyncStore } = await import('@/store/syncStore')
                                                            const { serverUrl } = useSyncStore.getState()
                                                            const baseUrl = serverUrl || ''
                                                            const apiPath = baseUrl.startsWith('http') ? `${baseUrl.replace(/\/$/, '')}/api` : '/api'

                                                            await axios.post(`${apiPath}/autopilot/test-webhook`, {
                                                                webhookUrl: ruleWebhookUrl.trim(),
                                                                accountName: account.name
                                                            })
                                                            toast({ title: 'Test Sent', description: 'Check your notification channel.' })
                                                        } catch (err) {
                                                            toast({ title: 'Test Failed', description: 'Invalid URL or server error.', variant: 'destructive' })
                                                        }
                                                    }}
                                                >
                                                    Test
                                                </Button>
                                            )}
                                        </div>
                                    </div>
                                )}
                            </div>

                            <div className="space-y-3">
                                {chain.map((url, index) => (
                                    <div key={index} className="bg-muted/30 border border-border rounded-xl px-4 py-3 flex flex-col gap-1.5">
                                        <div className="flex items-center justify-between">
                                            <span className="font-mono text-[10px] font-bold tracking-wider text-foreground/25">TIER {index + 1}</span>
                                            <button
                                                className="text-foreground/20 hover:text-red-400 transition-colors disabled:opacity-30 disabled:hover:text-foreground/20"
                                                onClick={() => removeFromChain(index)}
                                                disabled={chain.length <= 2}
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
                                                                {(selectedAddon.metadata?.customLogo || selectedAddon.manifest.logo) && (
                                                                    <img
                                                                        src={selectedAddon.metadata?.customLogo || selectedAddon.manifest.logo}
                                                                        alt=""
                                                                        className="w-5 h-5 rounded object-contain"
                                                                        onError={(e) => {
                                                                            e.currentTarget.style.display = 'none'
                                                                        }}
                                                                    />
                                                                )}
                                                                <span className="truncate">{selectedAddon.metadata?.customName || selectedAddon.manifest.name}</span>
                                                            </div>
                                                        )
                                                    })()}
                                                </SelectValue>
                                            </SelectTrigger>
                                            <SelectContent>
                                                {localAddons.map(addon => (
                                                    <SelectItem key={addon.transportUrl} value={addon.transportUrl}>
                                                        <div className="flex items-center gap-2">
                                                            {(addon.metadata?.customLogo || addon.manifest.logo) && (
                                                                <img
                                                                    src={addon.metadata?.customLogo || addon.manifest.logo}
                                                                    alt=""
                                                                    className="w-5 h-5 rounded object-contain bg-muted/30 p-0.5"
                                                                    onError={(e) => {
                                                                        e.currentTarget.style.display = 'none'
                                                                    }}
                                                                />
                                                            )}
                                                            <span>{addon.metadata?.customName || addon.manifest.name}</span>
                                                        </div>
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                    </div>
                                ))}
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={addToChain}
                                    className="w-full bg-muted/30 border border-dashed border-border/50 hover:bg-muted/50 text-foreground/50 hover:text-foreground h-12 rounded-xl"
                                >
                                    <Plus className="w-4 h-4 mr-2" /> Add Fallback Tier
                                </Button>
                            </div>

                            <div className="flex justify-end gap-2 pt-4 border-t border-border mt-4">
                                <Button variant="ghost" onClick={resetForm}>
                                    Cancel
                                </Button>
                                <Button
                                    size="sm"
                                    className="bg-[#eab308] hover:bg-[#fbbf24] text-black font-[900]"
                                    onClick={handleSaveRule}
                                    disabled={chain.filter(u => !!u).length < 2}
                                >
                                    {editingRuleId ? "Update Chain" : "Enable Autopilot"}
                                </Button>
                            </div>
                        </DialogContent>
                    </Dialog>

                    <div className="space-y-4">
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                            <div className="flex flex-wrap items-center gap-3">
                                <h3 className="text-lg font-semibold flex items-center gap-2">
                                    <Activity className="w-5 h-5" />
                                    Managed Chains
                                </h3>
                                <p className="text-xs text-muted-foreground mt-0.5 hidden sm:block">
                                    Autopilot keeps the highest-priority addon active at all times.
                                </p>
                                <div className="flex-1" />
                                <Button
                                    size="sm"
                                    onClick={() => {
                                        resetForm()
                                        setIsRuleDialogOpen(true)
                                    }}
                                >
                                    <Plus className="w-4 h-4 mr-1.5" />
                                    New Rule
                                </Button>
                                {otherAccountsWithRules.length > 0 && (
                                    <DropdownMenu>
                                        <DropdownMenuTrigger asChild>
                                            <Button variant="outline" size="sm" className="text-xs gap-1.5">
                                                <Download className="w-3 h-3" />
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
                                {accountRules.length > 0 && (
                                    <div className="flex gap-2">
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            className="text-xs border-primary/30 text-primary hover:bg-primary/10"
                                            onClick={() => toggleAllRulesForAccount(accountId, true)}
                                        >
                                            <Check className="w-3 h-3 mr-1" /> Resume All
                                        </Button>
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            className="text-xs border-destructive/30 text-destructive hover:bg-destructive/10"
                                            onClick={() => toggleAllRulesForAccount(accountId, false)}
                                        >
                                            <AlertTriangle className="w-3 h-3 mr-1" /> Pause All
                                        </Button>
                                    </div>
                                )}
                            </div>
                            {lastWorkerRun && (
                                <div
                                    className="flex items-center gap-2 px-3 py-1.5 rounded-full text-[10px] font-bold uppercase tracking-wider"
                                    style={(Date.now() - new Date(lastWorkerRun).getTime()) < 120000
                                        ? { background: 'rgba(34,197,94,0.1)', borderStyle: 'solid', borderWidth: '1px', borderColor: 'rgba(34,197,94,0.2)', color: '#4ade80' }
                                        : { background: 'rgba(245,158,11,0.1)', borderStyle: 'solid', borderWidth: '1px', borderColor: 'rgba(245,158,11,0.2)', color: '#fbbf24' }
                                    }
                                >
                                    {(Date.now() - new Date(lastWorkerRun).getTime()) < 120000 ? (
                                        <span className="relative flex h-2 w-2">
                                            <span className="absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75 animate-ping" />
                                            <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
                                        </span>
                                    ) : (
                                        <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500" />
                                    )}
                                    <span className="whitespace-nowrap font-mono">{
                                        (Date.now() - new Date(lastWorkerRun).getTime()) < 120000
                                            ? 'LIVE'
                                            : 'STANDBY'
                                    }</span>
                                </div>
                            )}
                        </div>

                        {accountRules.length === 0 && (
                            <div className="text-center py-8 text-muted-foreground bg-muted/20 rounded-lg border border-dashed text-sm">
                                No Autopilot rules active for this account.
                            </div>
                        )}

                        <div className="grid gap-4">
                            {accountRules.map(rule => {
                                if (!rule || !rule.priorityChain) return null;
                                const isPrimary = rule.activeUrl === rule.priorityChain[0]

                                const lastCheckDate = rule.lastCheck ? new Date(rule.lastCheck) : null
                                const isValidDate = lastCheckDate && !isNaN(lastCheckDate.getTime())

                                return (
                                    <div key={rule.id} className="bg-muted/30 border border-border rounded-2xl p-5 flex flex-col gap-6">
                                        <div className="flex items-center justify-between">
                                            <div className="flex items-center gap-3">
                                                <div className="font-mono text-[10px] font-bold tracking-wider text-foreground/30 uppercase bg-foreground/5 px-2 py-0.5 rounded">
                                                    {rule.name || `RULE ${rule.id.slice(0, 8)}`}
                                                </div>
                                                {rule.cooldown_ms && (
                                                    <div className="flex items-center gap-1.5 font-mono text-[9px] font-bold text-amber-400 opacity-60">
                                                        <Activity className="w-3 h-3" />
                                                        {Math.round(rule.cooldown_ms / 60000)}m
                                                    </div>
                                                )}
                                                {rule.notifyEnabled === false ? (
                                                    <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-foreground/30 bg-muted/40 border border-border rounded-full px-2 py-0.5">
                                                        <XCircle className="w-3 h-3" />
                                                        Silent
                                                    </span>
                                                ) : rule.webhookUrl ? (
                                                    <span className="inline-flex items-center gap-1.5">
                                                        <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-blue-400/80 bg-blue-500/10 border border-blue-500/20 rounded-full px-2 py-0.5">
                                                            <Webhook className="w-3 h-3" />
                                                            Custom
                                                        </span>
                                                        <Button
                                                            variant="outline"
                                                            size="sm"
                                                            className="h-5 px-2 text-[10px] font-bold uppercase tracking-widest text-blue-400/80 border-blue-500/20 hover:bg-blue-500/10 hover:text-blue-400"
                                                            onClick={async (e) => {
                                                                e.stopPropagation()
                                                                try {
                                                                    const { useSyncStore } = await import('@/store/syncStore')
                                                                    const { serverUrl } = useSyncStore.getState()
                                                                    const baseUrl = serverUrl || ''
                                                                    const apiPath = baseUrl.startsWith('http') ? `${baseUrl.replace(/\/$/, '')}/api` : '/api'
                                                                    await axios.post(`${apiPath}/autopilot/test-webhook`, {
                                                                        webhookUrl: rule.webhookUrl,
                                                                        accountName: account?.name || 'Unknown Account'
                                                                    })
                                                                    toast({ title: 'Test Sent', description: 'Check your notification channel.' })
                                                                } catch (err) {
                                                                    toast({ title: 'Test Failed', description: 'Invalid URL or server error.', variant: 'destructive' })
                                                                }
                                                            }}
                                                        >
                                                            Test Webhook
                                                        </Button>
                                                    </span>
                                                ) : (
                                                    <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-foreground/40 bg-muted/30 border border-border/50 rounded-full px-2 py-0.5">
                                                        <Webhook className="w-3 h-3" />
                                                        Global
                                                    </span>
                                                )}
                                            </div>
                                            <div className="flex items-center gap-2">
                                                <div className="flex items-center gap-2 mr-2">
                                                    <span className={`text-[10px] uppercase font-bold ${rule.isActive ? 'text-primary' : 'text-foreground/30'}`}>
                                                        {rule.isActive ? 'Enabled' : 'Disabled'}
                                                    </span>
                                                    <Switch
                                                        checked={rule.isActive}
                                                        onCheckedChange={(c) => updateRule(rule.id, {
                                                            isActive: c,
                                                            isAutomatic: c
                                                        })}
                                                    />
                                                </div>
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    className={`h-8 w-8 hover:bg-foreground/10 ${simulatingRuleId === rule.id ? 'text-primary anima-pulse' : 'text-foreground/50'}`}
                                                    onClick={() => handleSimulateRule(rule.id, rule.priorityChain)}
                                                    title="Simulate Autopilot Health Check"
                                                >
                                                    <FlaskConical className="w-4 h-4" />
                                                </Button>
                                                <Button variant="ghost" size="icon" className="h-8 w-8 hover:bg-foreground/10 hover:text-foreground text-foreground/50" onClick={() => {
                                                    setChain([...rule.priorityChain])
                                                    setRuleName(rule.name || '')
                                                    setCooldownMinutes(rule.cooldown_ms ? String(Math.round(rule.cooldown_ms / 60000)) : '')
                                                    setRuleNotifyMode(rule.notifyEnabled === false ? 'off' : rule.webhookUrl ? 'custom' : 'default')
                                                    setRuleWebhookUrl(rule.webhookUrl || '')
                                                    setEditingRuleId(rule.id)
                                                    setIsRuleDialogOpen(true)
                                                }} title="Edit this chain">
                                                    <Pencil className="w-4 h-4" />
                                                </Button>
                                                <Button variant="ghost" size="icon" className="h-8 w-8 hover:bg-foreground/10 hover:text-foreground text-foreground/50" onClick={() => handleDuplicateRule(rule)} title="Duplicate this chain">
                                                    <Copy className="w-4 h-4" />
                                                </Button>
                                                <Button variant="ghost" size="icon" className="h-8 w-8 hover:bg-red-500/20 hover:text-red-400 text-foreground/50" onClick={() => removeRule(rule.id)}>
                                                    <Trash2 className="w-4 h-4" />
                                                </Button>
                                            </div>
                                        </div>

                                        {/* Vertical Chain Layout */}
                                        <div className="flex flex-col relative w-full px-2">
                                            {rule.priorityChain.map((url, idx) => {
                                                const addon = addons.find(a => a.transportUrl === url)
                                                const isActiveInRule = url === rule.activeUrl
                                                const isTier1 = idx === 0
                                                const isFailedOver = isActiveInRule && !isTier1

                                                return (
                                                    <div key={idx} className="flex flex-col">
                                                        <div
                                                            className={`flex items-center gap-3 py-3 px-4 rounded-xl relative z-10 transition-colors ${getTierClassName(isActiveInRule, isTier1)}`}
                                                        >
                                                            <div className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0 bg-white/10">
                                                                {idx + 1}
                                                            </div>
                                                            {(addon?.metadata?.customLogo || addon?.manifest.logo) && (
                                                                <img
                                                                    src={addon.metadata?.customLogo || addon.manifest.logo}
                                                                    alt=""
                                                                    className="w-6 h-6 rounded object-contain shrink-0"
                                                                    onError={(e) => { e.currentTarget.style.display = 'none' }}
                                                                />
                                                            )}
                                                            <span className="font-bold truncate text-sm flex-1">{addon?.metadata?.customName || identifyAddon(url, addon?.manifest).name}</span>

                                                            <div className="flex items-center gap-2 shrink-0">
                                                                {isTier1 && <span className="text-[8px] font-mono font-bold text-primary bg-primary/10 px-1.5 py-0.5 rounded">PRIMARY</span>}
                                                                {isFailedOver && <span className="text-[8px] font-mono font-bold text-amber-500 bg-amber-500/10 px-1.5 py-0.5 rounded">ACTIVE</span>}
                                                            </div>
                                                        </div>
                                                        {idx < rule.priorityChain.length - 1 && (
                                                            <div className="w-full flex justify-center py-1">
                                                                <div className="w-px h-4 bg-border relative">
                                                                    <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 border-l-4 border-r-4 border-t-[4px] border-l-transparent border-r-transparent border-t-white/10" />
                                                                </div>
                                                            </div>
                                                        )}
                                                    </div>
                                                )
                                            })}
                                        </div>

                                        {/* Simulation Results Panel */}
                                        {simulatingRuleId === rule.id && (
                                            <div className="mx-2 p-4 rounded-xl bg-primary/5 border border-primary/20 space-y-3 animate-in fade-in slide-in-from-top-1 duration-200">
                                                <div className="flex items-center justify-between">
                                                    <div className="flex items-center gap-2 text-primary">
                                                        <FlaskConical className="w-4 h-4" />
                                                        <span className="text-xs font-bold uppercase tracking-widest">Autopilot Simulation</span>
                                                    </div>
                                                    <Button
                                                        variant="ghost"
                                                        size="sm"
                                                        className="h-6 px-2 text-[10px] font-bold text-foreground/30 hover:text-foreground"
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
                                                                    <span className="font-mono text-[10px] opacity-30">T{idx + 1}</span>
                                                                    <span className="truncate max-w-[150px]">{addon?.metadata?.customName || identifyAddon(url, addon?.manifest).name}</span>
                                                                </div>
                                                                <div className="flex items-center gap-2">
                                                                    {result?.checking ? (
                                                                        <Loader2 className="w-3 h-3 text-primary animate-spin" />
                                                                    ) : result?.healthy ? (
                                                                        <Check className="w-3 h-3 text-emerald-500" />
                                                                    ) : result ? (
                                                                        <div className="flex items-center gap-1.5">
                                                                            <span className="text-[10px] text-red-400/50 italic">{result.error || 'Offline'}</span>
                                                                            <XCircle className="w-3 h-3 text-red-500" />
                                                                        </div>
                                                                    ) : (
                                                                        <div className="w-3 h-3 rounded-full border border-border" />
                                                                    )}
                                                                </div>
                                                            </div>
                                                        )
                                                    })}
                                                </div>

                                                {/* Conclusion */}
                                                {!rule.priorityChain.some(url => simulationResults[url]?.checking) && Object.keys(simulationResults).length > 0 && (
                                                    <div className="pt-2 border-t border-primary/10">
                                                        <p className="text-[11px] text-foreground/90 leading-relaxed">
                                                            <span className="font-bold text-primary mr-1">CONCLUSION:</span>
                                                            {(() => {
                                                                const primaryUrl = rule.priorityChain[0]
                                                                const isPrimaryHealthy = simulationResults[primaryUrl]?.healthy
                                                                if (isPrimaryHealthy) {
                                                                    const addon = addons.find(a => a.transportUrl === primaryUrl)
                                                                    return `${addon?.metadata?.customName || identifyAddon(primaryUrl, addon?.manifest).name} is healthy — no failover needed.`
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

                                        {/* Status Footer */}
                                        <div className="flex items-center justify-between border-t border-border pt-4 px-2">
                                            <div className="flex items-center gap-2">
                                                <span
                                                    className="w-2.5 h-2.5 rounded-full"
                                                    style={isPrimary
                                                        ? { background: '#22c55e', boxShadow: '0 0 10px rgba(34,197,94,0.5)' }
                                                        : { background: '#f59e0b', boxShadow: '0 0 10px rgba(245,158,11,0.5)' }}
                                                />
                                                <span className="font-bold text-sm tracking-tight">{isPrimary ? 'Healthy' : 'Degraded'}</span>
                                            </div>
                                            <div className="flex items-center gap-4">
                                                <span className="font-mono text-[10px] text-foreground/40 uppercase tracking-widest">
                                                    {isValidDate && lastCheckDate ? formatDistanceToNow(lastCheckDate, { addSuffix: true }) : 'Pending'}
                                                </span>
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    className="h-6 p-0 text-foreground/40 hover:text-foreground"
                                                    onClick={() => {
                                                        setChain(rule.priorityChain)
                                                        setRuleName(rule.name || "")
                                                        setCooldownMinutes(rule.cooldown_ms ? (rule.cooldown_ms / 60000).toString() : "")
                                                        setRuleWebhookUrl(rule.webhookUrl || "")
                                                        setRuleNotifyMode(
                                                            rule.notifyEnabled === false ? 'off' :
                                                                (rule.webhookUrl ? 'custom' : 'default')
                                                        )
                                                        setEditingRuleId(rule.id)
                                                        window.scrollTo({ top: 0, behavior: 'smooth' })
                                                    }}
                                                >
                                                    <Pencil className="w-3.5 h-3.5" />
                                                </Button>
                                            </div>
                                        </div>
                                    </div>
                                )
                            })}
                        </div>
                    </div>
                </TabsContent>

                <TabsContent value="history">
                    <FailoverHistory addons={addons} />
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
        </div >
    )
}

function FailoverHistory({ addons }: { addons: any[] }) {
    const { logs, initialize, clearLogs } = useHistoryStore()

    const resolveUrlToName = (url: string) => {
        if (!url || !url.startsWith('http')) return url;
        const cleanUrl = url.replace(/[,.]$/, '');
        const addon = addons.find(a => a.manifestUrl === cleanUrl || a.transportUrl === cleanUrl);
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
    }, [initialize])

    if (logs.length === 0) {
        return (
            <div className="text-center py-12 text-muted-foreground bg-muted/20 rounded-lg border border-dashed">
                <History className="w-10 h-10 mx-auto mb-3 opacity-20" />
                <p>No failover events recorded yet.</p>
            </div>
        )
    }

    return (
        <div className="bg-muted/30 border border-border rounded-2xl p-5 mb-6 space-y-4">
            <div className="flex items-center justify-between mb-4">
                <div>
                    <h3 className="text-lg font-bold">Event Log</h3>
                    <p className="text-sm text-foreground/50">Recent failover and recovery actions.</p>
                </div>
                <Button variant="outline" size="sm" onClick={clearLogs} className="bg-foreground/5 border-foreground/10 hover:bg-foreground/10 text-foreground/50 hover:text-foreground">
                    Clear Log
                </Button>
            </div>
            <div className="relative pl-6 space-y-6 before:absolute before:inset-y-0 before:left-[11px] before:border-l-[2px] before:border-border/50 py-2">
                {logs.map((log) => {
                    const logDate = log.timestamp ? new Date(log.timestamp) : null;
                    const isValidLogDate = logDate && !isNaN(logDate.getTime());

                    let Icon = Activity;
                    let color = 'rgba(255,255,255,0.2)';
                    let bg = '#1f2937';

                    if (log.type === 'failover') {
                        Icon = AlertTriangle;
                        color = '#f87171';
                        bg = 'rgba(248,113,113,0.1)';
                    } else if (log.type === 'recovery') {
                        Icon = Check;
                        color = '#4ade80';
                        bg = 'rgba(74,222,128,0.1)';
                    } else if (log.type === 'self-healing') {
                        Icon = Activity;
                        color = '#60a5fa';
                        bg = 'rgba(96,165,250,0.1)';
                    }

                    return (
                        <div key={log.id} className="relative">
                            <div className="absolute -left-6 top-0 w-6 h-6 rounded-full flex items-center justify-center border-2 border-[#12121c]" style={{ backgroundColor: '#12121c' }}>
                                <div className="w-5 h-5 rounded-full flex items-center justify-center" style={{ backgroundColor: bg }}>
                                    <Icon className="w-3 h-3" style={{ color }} />
                                </div>
                            </div>
                            <div className="flex flex-col gap-1">
                                <div className="flex items-center justify-between">
                                    <span style={{ color }} className="text-xs font-bold uppercase tracking-wider">{log.type}</span>
                                    <span className="font-mono text-[10px] text-foreground/40 uppercase tracking-widest">
                                        {isValidLogDate && logDate ? formatDistanceToNow(logDate, { addSuffix: true }) : 'Unknown time'}
                                    </span>
                                </div>
                                <div className="text-sm font-medium">
                                    {log.metadata?.chain ? (
                                        <div className="flex items-center gap-1.5 opacity-90 text-xs">
                                            <span className="text-foreground/50">Chain:</span>
                                            <div className="flex gap-1 overflow-hidden" style={{ maxWidth: '300px' }}>
                                                {(log.metadata.chain as string[]).map((url, i, arr) => (
                                                    <span key={i} className="flex items-center">
                                                        <span className="truncate max-w-[120px]" title={url}>{resolveUrlToName(url)}</span>
                                                        {i < arr.length - 1 && <ArrowRight className="w-3 h-3 text-foreground/30 mx-1 shrink-0" />}
                                                    </span>
                                                ))}
                                            </div>
                                        </div>
                                    ) : (
                                        <div className="truncate">
                                            {resolveUrlToName(log.primaryName || 'System')}
                                        </div>
                                    )}
                                </div>
                                <div className="text-xs text-foreground/50 leading-relaxed mt-0.5">
                                    {log.message.split(' ').map(word => word.startsWith('http') ? resolveUrlToName(word) : word).join(' ')}
                                </div>
                            </div>
                        </div>
                    )
                })}
            </div>
        </div>
    )
}
