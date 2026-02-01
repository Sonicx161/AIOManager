import { Button } from "@/components/ui/button"
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
import { ArrowRight, AlertTriangle, Activity, Trash2, Plus, History, FlaskConical, Pencil, Webhook } from "lucide-react"
import { useState, useEffect } from "react"
import { toast } from "@/hooks/use-toast"
import { formatDistanceToNow } from "date-fns"
import { Input } from "@/components/ui/input"

interface FailoverManagerProps {
    accountId: string
}

export function FailoverManager({ accountId }: FailoverManagerProps) {
    const account = useAccountStore((state) => state.accounts.find((a) => a.id === accountId))
    const { rules, addRule, updateRule, removeRule, toggleRuleActive, webhook, setWebhook } = useFailoverStore()

    const [primaryId, setPrimaryId] = useState<string>("")
    const [backupId, setBackupId] = useState<string>("")
    const [editingRuleId, setEditingRuleId] = useState<string | null>(null)
    const [webhookUrl, setWebhookUrl] = useState("")

    useEffect(() => {
        setWebhookUrl(webhook.url)
    }, [webhook.url])

    const handleSaveWebhook = () => {
        setWebhook(webhookUrl, !!webhookUrl)
        if (webhookUrl) {
            toast({ title: 'Notifications Enabled', description: 'Discord webhook saved.' })
        } else {
            toast({ title: 'Notifications Disabled', description: 'Webhook removed.' })
        }
    }

    if (!account) return null

    const accountRules = rules.filter(r => r.accountId === accountId)
    const addons = account.addons

    const handleSaveRule = async () => {
        if (!primaryId || !backupId) return
        if (primaryId === backupId) {
            toast({ title: "Invalid Rule", description: "Primary and Backup cannot be the same.", variant: "destructive" })
            return
        }

        if (editingRuleId) {
            await updateRule(editingRuleId, { primaryUrl: primaryId, backupUrl: backupId })
            toast({ title: "Rule Updated", description: "Failover rule updated successfully." })
            setEditingRuleId(null)
        } else {
            await addRule(accountId, primaryId, backupId)
            toast({ title: "Rule Created", description: "Failover rule active." })
        }

        setPrimaryId("")
        setBackupId("")
    }

    const handleCancelEdit = () => {
        setPrimaryId("")
        setBackupId("")
        setEditingRuleId(null)
    }

    const handleTestRule = async (ruleId: string) => {
        toast({ title: "Running Diagnostics...", description: "Performing deep health check on both addons." })
        try {
            const result = await useFailoverStore.getState().testRule(ruleId)

            const pStatus = result.primary.isHealthy ? "✅ Healthy" : "❌ Broken"
            const bStatus = result.backup.isHealthy ? "✅ Healthy" : "❌ Broken"

            toast({
                title: "Diagnostics Complete",
                description: (
                    <div className="flex flex-col gap-1 mt-2">
                        <div className="flex items-center gap-3">
                            <span className="w-16 text-muted-foreground">Primary:</span>
                            <span className="font-medium">{pStatus} <span className="text-muted-foreground font-normal opacity-75">({result.primary.latency || '?'}ms)</span></span>
                        </div>
                        <div className="flex items-center gap-3">
                            <span className="w-16 text-muted-foreground">Backup:</span>
                            <span className="font-medium">{bStatus} <span className="text-muted-foreground font-normal opacity-75">({result.backup.latency || '?'}ms)</span></span>
                        </div>
                    </div>
                ),
                variant: result.primary.isHealthy ? "default" : "destructive"
            })
        } catch (err) {
            toast({ title: "Error", description: "Failed to run diagnostics.", variant: "destructive" })
        }
    }

    return (
        <Tabs defaultValue="rules" className="space-y-6">
            <TabsList>
                <TabsTrigger value="rules" className="flex items-center gap-2">
                    <Activity className="w-4 h-4" /> Rules
                </TabsTrigger>
                <TabsTrigger value="history" className="flex items-center gap-2">
                    <History className="w-4 h-4" /> History
                </TabsTrigger>
            </TabsList>

            <TabsContent value="rules" className="space-y-6">
                <Card>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                            <Webhook className="w-5 h-5 text-indigo-500" />
                            Notifications
                        </CardTitle>
                        <CardDescription>
                            Receive Discord alerts when a failover or recovery event occurs.
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <div className="flex gap-4">
                            <Input
                                placeholder="https://discord.com/api/webhooks/..."
                                value={webhookUrl}
                                onChange={(e) => setWebhookUrl(e.target.value)}
                            />
                            <Button onClick={handleSaveWebhook}>Save</Button>
                        </div>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader>
                        <CardTitle className="text-lg flex items-center gap-2">
                            {editingRuleId ? <Pencil className="w-5 h-5" /> : <Plus className="w-5 h-5 text-primary" />}
                            {editingRuleId ? "Edit Rule" : "Create New Rule"}
                        </CardTitle>
                        <CardDescription>
                            Automatically switch to a backup addon if the primary one goes offline.
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_1fr] gap-4 items-end">
                            <div className="space-y-2">
                                <span className="text-sm font-medium">Primary Addon (Monitored)</span>
                                <Select value={primaryId} onValueChange={setPrimaryId}>
                                    <SelectTrigger>
                                        <SelectValue placeholder="Select primary..." />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {addons.map(addon => (
                                            <SelectItem key={addon.transportUrl} value={addon.transportUrl}>
                                                {addon.manifest.name}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>

                            <div className="flex justify-center pb-2">
                                <ArrowRight className="text-muted-foreground" />
                            </div>

                            <div className="space-y-2">
                                <span className="text-sm font-medium">Backup Addon (Failover)</span>
                                <Select value={backupId} onValueChange={setBackupId}>
                                    <SelectTrigger>
                                        <SelectValue placeholder="Select backup..." />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {addons.map(addon => (
                                            <SelectItem key={addon.transportUrl} value={addon.transportUrl}>
                                                {addon.manifest.name}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>
                        </div>

                        <div className="flex gap-2">
                            <Button
                                className="flex-1 md:w-auto"
                                onClick={handleSaveRule}
                                disabled={!primaryId || !backupId}
                            >
                                {editingRuleId ? "Update Rule" : "Create Rule"}
                            </Button>
                            {editingRuleId && (
                                <Button variant="outline" onClick={handleCancelEdit}>
                                    Cancel
                                </Button>
                            )}
                        </div>
                    </CardContent>
                </Card>

                <div className="space-y-4">
                    <h3 className="text-lg font-semibold flex items-center gap-2">
                        <Activity className="w-5 h-5" />
                        Active Rules
                    </h3>

                    {accountRules.length === 0 && (
                        <div className="text-center py-8 text-muted-foreground bg-muted/20 rounded-lg border border-dashed">
                            No failover rules configured.
                        </div>
                    )}

                    <div className="grid gap-4">
                        {accountRules.map(rule => {
                            let primary = addons.find(a => a.transportUrl === rule.primaryUrl)
                            if (!primary && rule.primaryAddonId) {
                                primary = addons.find(a => a.manifest.id === rule.primaryAddonId)
                            }
                            let backup = addons.find(a => a.transportUrl === rule.backupUrl)
                            if (!backup && rule.backupAddonId) {
                                backup = addons.find(a => a.manifest.id === rule.backupAddonId)
                            }

                            if (!primary || !backup) {
                                return (
                                    <Card key={rule.id} className="border-destructive/20 bg-destructive/5 opacity-80">
                                        <CardContent className="p-4 flex items-center justify-between gap-4">
                                            <div className="flex items-center gap-4">
                                                <div className="p-2 rounded-full bg-destructive/10 text-destructive">
                                                    <AlertTriangle className="w-5 h-5" />
                                                </div>
                                                <div className="space-y-1">
                                                    <div className="font-medium text-destructive">Broken Rule (Addon Missing)</div>
                                                    <div className="text-xs text-muted-foreground">This rule references addons that are no longer installed.</div>
                                                </div>
                                            </div>
                                            <Button variant="ghost" size="icon" className="text-destructive hover:bg-destructive/10" onClick={() => removeRule(rule.id)}>
                                                <Trash2 className="w-4 h-4" />
                                            </Button>
                                        </CardContent>
                                    </Card>
                                )
                            }

                            return (
                                <Card key={rule.id} className={`transition-colors ${rule.status === 'failed-over' ? 'border-destructive/50 bg-destructive/5' : ''}`}>
                                    <CardContent className="p-4 flex flex-col md:flex-row items-center justify-between gap-4">
                                        <div className="flex items-center gap-4 flex-1">
                                            <div className={`p-2 rounded-full ${rule.status === 'failed-over' ? 'bg-destructive/10 text-destructive' : 'bg-primary/10 text-primary'}`}>
                                                {rule.status === 'failed-over' ? <AlertTriangle className="w-5 h-5" /> : <Activity className="w-5 h-5" />}
                                            </div>
                                            <div className="space-y-1">
                                                <div className="flex items-center gap-2 font-medium">
                                                    <span>{primary.manifest.name}</span>
                                                    <ArrowRight className="w-3 h-3 text-muted-foreground" />
                                                    <span>{backup.manifest.name}</span>
                                                </div>
                                                <div className="text-xs text-muted-foreground flex gap-3">
                                                    <span>Status: <span className="uppercase font-semibold">{rule.status}</span></span>
                                                    {rule.lastCheck && <span>Last Check: {new Date(rule.lastCheck).toLocaleTimeString()}</span>}
                                                    {rule.lastFailover && <span className="text-destructive font-semibold">Failover: {new Date(rule.lastFailover).toLocaleTimeString()}</span>}
                                                </div>
                                            </div>
                                        </div>

                                        <div className="flex items-center gap-3">
                                            <span className="text-xs text-muted-foreground">{rule.isActive ? 'Active' : 'Paused'}</span>
                                            <Switch
                                                checked={rule.isActive}
                                                onCheckedChange={(c) => toggleRuleActive(rule.id, c)}
                                            />
                                            <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-primary" onClick={() => handleTestRule(rule.id)} title="Run Diagnostics">
                                                <FlaskConical className="h-4 w-4" />
                                            </Button>
                                            <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-primary" onClick={() => {
                                                setPrimaryId(rule.primaryUrl)
                                                setBackupId(rule.backupUrl)
                                                setEditingRuleId(rule.id)
                                                window.scrollTo({ top: 0, behavior: 'smooth' })
                                            }}>
                                                <Pencil className="h-4 w-4" />
                                            </Button>
                                            <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-destructive" onClick={() => removeRule(rule.id)}>
                                                <Trash2 className="w-4 h-4" />
                                            </Button>
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
                            <TableHead>Primary / Backup</TableHead>
                            <TableHead>Message</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {logs.map((log) => (
                            <TableRow key={log.id}>
                                <TableCell className="whitespace-nowrap font-medium text-xs text-muted-foreground">
                                    {formatDistanceToNow(new Date(log.timestamp), { addSuffix: true })}
                                </TableCell>
                                <TableCell>
                                    <BadgeForType type={log.type} />
                                </TableCell>
                                <TableCell className="text-sm">
                                    {log.primaryName} <span className="text-muted-foreground text-xs">vs</span> {log.backupName}
                                </TableCell>
                                <TableCell className="text-sm text-muted-foreground">
                                    {log.message}
                                </TableCell>
                            </TableRow>
                        ))}
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
            return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-500/10 text-blue-600 dark:text-green-400">Self-Healing</span>
        default:
            return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-800">Info</span>
    }
}
