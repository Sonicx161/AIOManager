import { useEffect, useState } from "react"
import { Pencil, Webhook } from "lucide-react"
import { maskSecretUrl } from '@/lib/mask-secret-url'
import { Button } from "@/components/ui/button"
import { SecretUrlInput } from "@/components/ui/secret-url-input"
import { StatusChip } from "@/components/ui/status-chip"
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog"
import { EmptyState } from "@/components/common/EmptyState"
import { toast } from "@/hooks/use-toast"
import { apiFetch } from "@/lib/http-client"
import { useFailoverStore } from "@/store/failoverStore"
import type { FailoverRule } from "@/store/failoverStore"

export async function testWebhook(
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

interface WebhooksPanelProps {
    accountId: string
    accountName?: string
    accountRules: FailoverRule[]
    onEditRule: (rule: FailoverRule) => void
}

export function WebhooksPanel({ accountId, accountName, accountRules, onEditRule }: WebhooksPanelProps) {
    const webhook = useFailoverStore(s => s.webhook)
    const setWebhook = useFailoverStore(s => s.setWebhook)
    const [webhookUrl, setWebhookUrl] = useState("")
    const [serverGlobalWebhook, setServerGlobalWebhook] = useState<{ configured: boolean; masked?: string | null } | null>(null)
    const [showWebhookConfirm, setShowWebhookConfirm] = useState(false)

    useEffect(() => {
        setWebhookUrl(webhook.url)
    }, [webhook.url])

    useEffect(() => {
        let cancelled = false
        void (async () => {
            const result = await apiFetch<{ configured: boolean; masked?: string | null }>('/autopilot/global-webhook')
            if (!cancelled && result.ok) setServerGlobalWebhook(result.data ?? { configured: false })
        })()
        return () => { cancelled = true }
    }, [])

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

    return (
        <>
        <div data-theme-part="panel" className="bg-card border border-border/40 rounded-2xl p-5 space-y-4 shadow-sm">
            <div className="flex items-start justify-between">
                <div>
                    <h3 className="flex items-center gap-2 text-lg font-bold">
                        <Webhook className="w-5 h-5 text-primary" />
                        Global Webhook
                    </h3>
                    <div className="flex items-center gap-2 mt-2">
                        <StatusChip variant={webhook.url || serverGlobalWebhook?.configured ? 'success' : 'muted'}>
                            <span className={`h-1.5 w-1.5 rounded-full ${webhook.url || serverGlobalWebhook?.configured ? 'bg-success' : 'bg-muted-foreground/40'}`} />
                            {webhook.url ? 'Active' : serverGlobalWebhook?.configured ? `Active on server${serverGlobalWebhook.masked ? ` ${serverGlobalWebhook.masked}` : ''}` : 'Not configured'}
                        </StatusChip>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">Fallback for all rules unless a rule has its own custom webhook.</p>
                    {!webhook.url && serverGlobalWebhook?.configured && (
                        <p className="text-xs text-muted-foreground/70 mt-1">
                            A global webhook is saved on the server{serverGlobalWebhook.masked ? ` (${serverGlobalWebhook.masked})` : ''} for this account. This browser has no local copy. Paste the URL and save to replace or test it.
                        </p>
                    )}
                </div>
            </div>
            <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center">
                <SecretUrlInput
                    placeholder="https://discord.com/api/webhooks/... or Slack URL"
                    value={webhookUrl}
                    onChange={(url) => setWebhookUrl(url)}
                    className="rounded-lg"
                    ariaLabel="Global webhook URL"
                />
                <div className="flex gap-2">
                    <Button size="sm" onClick={handleSaveWebhook}>Set Webhook</Button>
                    {webhook.url && (
                        <Button
                            size="sm"
                            className="bg-muted/40 text-foreground/70 border border-border/40 hover:bg-muted/70 shadow-none"
                            onClick={() => testWebhook(webhook.url, accountId, toast, accountName)}
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

        <div data-theme-part="panel" className="bg-card border border-border/40 rounded-2xl p-5 space-y-4 shadow-sm">
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
                        <div key={rule.id} data-theme-part="panel" className="flex items-center justify-between bg-muted/20 border border-border/40 rounded-xl px-4 py-3 gap-3">
                            <div className="flex flex-col gap-0.5 min-w-0">
                                <span className="text-sm font-medium truncate">
                                    {rule.name || `Rule ${rule.id.slice(0, 8)}`}
                                </span>
                                <span className="text-xs font-mono text-muted-foreground truncate max-w-xs">
                                    {maskSecretUrl(rule.webhookUrl!)}
                                </span>
                            </div>
                            <div className="flex gap-2 shrink-0">
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => onEditRule(rule)}
                                    className="gap-1.5"
                                >
                                    <Pencil className="w-3.5 h-3.5" /> Edit
                                </Button>
                                <Button
                                    size="sm"
                                    className="bg-muted/40 text-foreground/70 border border-border/40 hover:bg-muted/70 shadow-none"
                                    onClick={() => testWebhook(rule.webhookUrl, accountId, toast, accountName)}
                                >
                                    Test
                                </Button>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
        <ConfirmationDialog
            open={showWebhookConfirm}
            onOpenChange={setShowWebhookConfirm}
            title="Replace Webhook URL?"
            description="You already have a webhook configured. Are you sure you want to replace it with this new URL?"
            confirmText="Replace Webhook"
            onConfirm={doSaveWebhook}
        />
        </>
    )
}
