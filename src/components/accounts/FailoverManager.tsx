import { Button } from "@/components/ui/button"
import axios from "axios"
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card"
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table"
import { useAccountStore } from "@/store/accountStore"
import { useFailoverStore } from "@/store/failoverStore"
import { useHistoryStore } from "@/store/historyStore"
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ArrowRight, AlertTriangle, Activity, Trash2, Plus, History, Pencil, Webhook, Check, Copy, Download } from "lucide-react"
import { useState, useEffect, useMemo } from "react"
import { identifyAddon } from "@/lib/addon-identifier"
import { toast } from "@/hooks/use-toast"
import { formatDistanceToNow } from "date-fns"
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
            toast({ title: 'Notifications Enabled', description: 'Discord webhook saved.' })
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

    if (!account) return null

    const accountRules = rules.filter(r => r.accountId === accountId)
    const addons = account.addons

    const handleSaveRule = async () => {
        const filteredChain = chain.filter(url => !!url)
        if (filteredChain.length < 2) {
            toast({ title: "Invalid Rule", description: "A failover chain needs at least 2 addons.", variant: "destructive" })
            return
        }

        if (editingRuleId) {
            await updateRule(editingRuleId, { priorityChain: filteredChain, activeUrl: filteredChain[0] })
            toast({ title: "Rule Updated", description: "Priority chain modified." })
            setEditingRuleId(null)
        } else {
            await addRule(accountId, filteredChain)
            toast({ title: "Rule Created", description: "Autopilot is now monitoring this chain." })
        }

        setChain(["", ""])
    }

    const addToChain = () => setChain([...chain, ""])
    const removeFromChain = (index: number) => setChain(chain.filter((_, i) => i !== index))
    const updateChainUrl = (index: number, url: string) => {
        const newChain = [...chain]
        newChain[index] = url
        setChain(newChain)
    }

    const handleCancelEdit = () => {
        setChain(["", ""])
        setEditingRuleId(null)
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

    return (
        <div className="space-y-6">
            <Tabs defaultValue="rules" className="space-y-6">
                <TabsList>
                    <TabsTrigger value="rules" className="flex items-center gap-2">
                        <Activity className="w-4 h-4" /> Autopilot Rules
                    </TabsTrigger>
                    <TabsTrigger value="history" className="flex items-center gap-2">
                        <History className="w-4 h-4" /> Failover History
                    </TabsTrigger>
                </TabsList>

                <TabsContent value="rules" className="space-y-6">
                    <Card className="border-indigo-500/20 bg-indigo-500/5">
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2">
                                <Webhook className="w-5 h-5 text-indigo-500" />
                                Health Webhooks
                            </CardTitle>
                            <CardDescription>
                                Receive identifiable Discord/Ntfy alerts for account <code className="bg-indigo-500/10 px-1 rounded text-xs">{accountId.slice(0, 8)}...</code>
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <div className="flex gap-4">
                                <Input
                                    placeholder="https://discord.com/api/webhooks/..."
                                    value={webhookUrl}
                                    onChange={(e) => setWebhookUrl(e.target.value)}
                                    className="bg-background"
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
                                                    toast({ title: 'Test Sent', description: 'Check your Discord channel.' })
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
                        </CardContent>
                    </Card>

                    <Card>
                        <CardHeader>
                            <CardTitle className="text-lg flex items-center gap-2">
                                {editingRuleId ? <Pencil className="w-5 h-5" /> : <Plus className="w-5 h-5 text-primary" />}
                                {editingRuleId ? "Edit Priority Chain" : "Create New Autopilot Rule"}
                            </CardTitle>
                            <CardDescription>
                                Define an ordered list of fallbacks. Autopilot will always try to keep the highest priority addon active.
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <div className="space-y-3">
                                {chain.map((url, index) => (
                                    <div key={index} className="flex items-center gap-3">
                                        <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center text-xs font-bold border">
                                            {index + 1}
                                        </div>
                                        <Select value={url} onValueChange={(val) => updateChainUrl(index, val)}>
                                            <SelectTrigger className="flex-1">
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
                                                                        className="w-4 h-4 rounded object-contain"
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
                                                {addons.map(addon => (
                                                    <SelectItem key={addon.transportUrl} value={addon.transportUrl}>
                                                        <div className="flex items-center gap-2">
                                                            {(addon.metadata?.customLogo || addon.manifest.logo) && (
                                                                <img
                                                                    src={addon.metadata?.customLogo || addon.manifest.logo}
                                                                    alt=""
                                                                    className="w-5 h-5 rounded object-contain bg-muted/50 p-0.5"
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
                                        <Button variant="ghost" size="icon" onClick={() => removeFromChain(index)} disabled={chain.length <= 2}>
                                            <Trash2 className="w-4 h-4" />
                                        </Button>
                                    </div>
                                ))}
                                <Button variant="outline" size="sm" onClick={addToChain} className="w-full border-dashed">
                                    <Plus className="w-3 h-3 mr-2" /> Add Fallback Tier
                                </Button>
                            </div>

                            <div className="flex gap-2 pt-4 border-t">
                                <Button
                                    size="sm"
                                    className="flex-1 md:w-auto"
                                    onClick={handleSaveRule}
                                    disabled={chain.filter(u => !!u).length < 2}
                                >
                                    {editingRuleId ? "Update Chain" : "Enable Autopilot"}
                                </Button>
                                {editingRuleId && (
                                    <Button variant="outline" size="sm" onClick={handleCancelEdit}>
                                        Cancel
                                    </Button>
                                )}
                            </div>
                        </CardContent>
                    </Card>

                    <div className="space-y-4">
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                            <div className="flex flex-wrap items-center gap-3">
                                <h3 className="text-lg font-semibold flex items-center gap-2">
                                    <Activity className="w-5 h-5" />
                                    Managed Chains
                                </h3>
                                {otherAccountsWithRules.length > 0 && (
                                    <DropdownMenu>
                                        <DropdownMenuTrigger asChild>
                                            <Button variant="outline" size="sm" className="h-7 text-xs gap-1.5">
                                                <Download className="w-3 h-3" />
                                                Copy Rules From…
                                            </Button>
                                        </DropdownMenuTrigger>
                                        <DropdownMenuContent align="start">
                                            {otherAccountsWithRules.map(a => (
                                                <DropdownMenuItem key={a.id} onClick={() => handleCopyRulesFrom(a.id)}>
                                                    {a.name} ({a.ruleCount} rule{a.ruleCount !== 1 ? 's' : ''})
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
                                            className="h-7 text-xs bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 border-emerald-500/20"
                                            onClick={() => toggleAllRulesForAccount(accountId, true)}
                                        >
                                            <Check className="w-3 h-3 mr-1" /> Resume All
                                        </Button>
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            className="h-7 text-xs bg-amber-500/10 hover:bg-amber-500/20 text-amber-600 dark:text-amber-400 border-amber-500/20"
                                            onClick={() => toggleAllRulesForAccount(accountId, false)}
                                        >
                                            <AlertTriangle className="w-3 h-3 mr-1" /> Pause All
                                        </Button>
                                    </div>
                                )}
                            </div>
                            {lastWorkerRun && (
                                <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider">
                                    <span className={`w-2 h-2 rounded-full ${(Date.now() - new Date(lastWorkerRun).getTime()) < 120000
                                        ? 'bg-green-500 animate-pulse'
                                        : 'bg-muted'
                                        }`} />
                                    <span className="text-muted-foreground whitespace-nowrap">Autopilot: {
                                        (Date.now() - new Date(lastWorkerRun).getTime()) < 120000
                                            ? (accountRules.length === 0
                                                ? 'Live & Standby'
                                                : accountRules.some(r => r.isActive)
                                                    ? 'Live & Monitoring'
                                                    : 'Live & Paused')
                                            : 'Last Heartbeat ' + formatDistanceToNow(new Date(lastWorkerRun), { addSuffix: true })
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
                                const activeAddon = addons.find(a => a.transportUrl === rule.activeUrl)
                                const isPrimary = rule.activeUrl === rule.priorityChain[0]

                                const lastCheckDate = rule.lastCheck ? new Date(rule.lastCheck) : null
                                const isValidDate = lastCheckDate && !isNaN(lastCheckDate.getTime())

                                return (
                                    <Card key={rule.id} className={`transition-all ${!isPrimary ? 'border-amber-500/50 bg-amber-500/5' : ''}`}>
                                        <CardContent className="p-4 flex flex-col gap-4">
                                            <div className="flex items-center justify-between">
                                                <div className="flex items-center gap-3">
                                                    <div className={`p-2 rounded-full ${!isPrimary ? 'bg-amber-500/10 text-amber-500' : 'bg-primary/10 text-primary'}`}>
                                                        {!isPrimary ? <AlertTriangle className="w-5 h-5" /> : <Activity className="w-5 h-5" />}
                                                    </div>
                                                    <div>
                                                        <div className="flex items-center gap-2">
                                                            {(activeAddon?.metadata?.customLogo || activeAddon?.manifest.logo) && (
                                                                <img
                                                                    src={activeAddon.metadata?.customLogo || activeAddon.manifest.logo}
                                                                    alt=""
                                                                    className="w-5 h-5 rounded object-contain bg-muted/50 p-0.5"
                                                                    onError={(e) => {
                                                                        e.currentTarget.style.display = 'none'
                                                                    }}
                                                                />
                                                            )}
                                                            <div className="font-bold flex items-center gap-2">
                                                                {activeAddon?.metadata?.customName || identifyAddon(rule.activeUrl || '', activeAddon?.manifest).name}
                                                                {!isPrimary && <span className="text-[10px] bg-amber-500 text-white px-1.5 py-0.5 rounded uppercase font-bold">Failed Over</span>}
                                                            </div>
                                                        </div>
                                                        <div className="text-[10px] text-muted-foreground font-mono">
                                                            ID: {rule.id.slice(0, 8)}
                                                        </div>
                                                    </div>
                                                </div>
                                                <div className="flex items-center gap-2">
                                                    <div className="flex items-center gap-2 mr-2">
                                                        <span className={`text-[10px] uppercase font-bold ${rule.isActive ? 'text-primary' : 'text-muted-foreground'}`}>
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
                                                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => handleDuplicateRule(rule)} title="Duplicate this chain">
                                                        <Copy className="w-4 h-4 text-muted-foreground" />
                                                    </Button>
                                                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => removeRule(rule.id)}>
                                                        <Trash2 className="w-4 h-4 text-destructive" />
                                                    </Button>
                                                </div>
                                            </div>

                                            <div className="flex flex-wrap gap-2 items-center text-xs">
                                                {rule.priorityChain.map((url, idx) => {
                                                    const addon = addons.find(a => a.transportUrl === url)
                                                    const isActiveInRule = url === rule.activeUrl
                                                    const reliability = rule.stabilization?.[url] || 0

                                                    return (
                                                        <div key={idx} className="flex items-center gap-1 group">
                                                            <div className={`px-2 py-1 rounded flex items-center gap-2 border ${isActiveInRule ? 'bg-primary text-primary-foreground border-primary' : 'bg-muted border-transparent'}`}>
                                                                <span className="opacity-70 font-bold">{idx + 1}</span>
                                                                {(addon?.metadata?.customLogo || addon?.manifest.logo) && (
                                                                    <img
                                                                        src={addon.metadata?.customLogo || addon.manifest.logo}
                                                                        alt=""
                                                                        className="w-4 h-4 rounded object-contain"
                                                                        onError={(e) => {
                                                                            e.currentTarget.style.display = 'none'
                                                                        }}
                                                                    />
                                                                )}
                                                                <span className="font-medium truncate max-w-[100px]">{addon?.metadata?.customName || identifyAddon(url, addon?.manifest).name}</span>
                                                                {reliability > 0 && (
                                                                    <span className={`text-[8px] px-1 rounded ${isActiveInRule ? 'bg-white/20' : 'bg-primary/10 text-primary'}`} title="Consecutive successful health checks">
                                                                        {reliability} pts
                                                                    </span>
                                                                )}
                                                            </div>
                                                            {idx < rule.priorityChain.length - 1 && <ArrowRight className="w-3 h-3 text-muted-foreground opacity-30" />}
                                                        </div>
                                                    )
                                                })}
                                            </div>

                                            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pt-2 border-t text-muted-foreground">
                                                <div className="flex gap-6 sm:gap-8">
                                                    <div className="flex flex-col gap-0.5" title="High-Scale optimization: Database persistence occurs only during system events to maximize disk longevity.">
                                                        <span className="text-[9px] uppercase font-bold opacity-60">Reliability</span>
                                                        <span className="text-primary font-bold flex items-center gap-1.5 text-xs">
                                                            {Object.values(rule.stabilization || {}).reduce((a: number, b: unknown) => a + (Number(b) || 0), 0) === 0
                                                                ? <>Optimized & Healthy <Check className="w-3.5 h-3.5 text-green-500" /></>
                                                                : `${Object.values(rule.stabilization || {}).reduce((a: number, b: unknown) => a + (Number(b) || 0), 0)} Points`}
                                                        </span>
                                                    </div>
                                                    <div className="flex flex-col gap-0.5">
                                                        <span className="text-[9px] uppercase font-bold opacity-60">Last Check</span>
                                                        <span className="text-foreground font-medium text-xs">
                                                            {formatDistanceToNow(lastWorkerRun || (isValidDate && lastCheckDate) || new Date(), { addSuffix: true })}
                                                        </span>
                                                    </div>
                                                </div>
                                                <Button variant="link" size="sm" className="h-auto p-0 text-xs opacity-70 hover:opacity-100" onClick={() => {
                                                    setChain(rule.priorityChain)
                                                    setEditingRuleId(rule.id)
                                                    window.scrollTo({ top: 0, behavior: 'smooth' })
                                                }}>Edit Chain</Button>
                                            </div>
                                        </CardContent>
                                    </Card>
                                )
                            })}
                        </div>
                    </div>
                </TabsContent>

                <TabsContent value="history">
                    <FailoverHistory />
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
        </div>
    )
}

function FailoverHistory() {
    const { logs, initialize, clearLogs } = useHistoryStore()

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
        <Card>
            <CardHeader className="flex flex-row items-center justify-between">
                <div>
                    <CardTitle>Event Log</CardTitle>
                    <CardDescription>Recent failover and recovery actions.</CardDescription>
                </div>
                <Button variant="outline" size="sm" onClick={clearLogs}>
                    Clear Log
                </Button>
            </CardHeader>
            <CardContent>
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead>Time</TableHead>
                            <TableHead>Event</TableHead>
                            <TableHead>Chain Context</TableHead>
                            <TableHead>Message</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {logs.map((log) => {
                            const logDate = log.timestamp ? new Date(log.timestamp) : null;
                            const isValidLogDate = logDate && !isNaN(logDate.getTime());

                            return (
                                <TableRow key={log.id}>
                                    <TableCell className="whitespace-nowrap font-medium text-xs text-muted-foreground">
                                        {isValidLogDate && logDate ? formatDistanceToNow(logDate, { addSuffix: true }) : 'Unknown time'}
                                    </TableCell>
                                    <TableCell>
                                        <BadgeForType type={log.type} />
                                    </TableCell>
                                    <TableCell className="text-sm">
                                        {log.metadata?.chain ? (
                                            <div className="flex items-center gap-1 text-[10px] opacity-70">
                                                {(log.metadata.chain as any[]).length} tiers
                                                <ArrowRight className="w-2 h-2" />
                                                {(log.metadata.activeUrl as string)?.slice(-8)}
                                            </div>
                                        ) : (
                                            <div className="text-xs truncate max-w-[100px]">
                                                {log.primaryName || 'System'}
                                            </div>
                                        )}
                                    </TableCell>
                                    <TableCell className="text-sm text-muted-foreground">
                                        {log.message}
                                    </TableCell>
                                </TableRow>
                            )
                        })}
                    </TableBody>
                </Table>
            </CardContent>
        </Card>
    )
}

function BadgeForType({ type }: { type: string }) {
    switch (type) {
        case 'failover':
            return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-destructive/10 text-destructive">Failover</span>
        case 'recovery':
            return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-500/10 text-green-600 dark:text-green-400">Recovery</span>
        case 'self-healing':
            return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-500/10 text-blue-600 dark:text-blue-400">Self-Healing</span>
        default:
            return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-muted text-muted-foreground">Info</span>
    }
}
