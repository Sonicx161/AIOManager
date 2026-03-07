import { useState } from 'react'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Bell } from 'lucide-react'
import { useFailoverStore } from '@/store/failoverStore'
import { toast } from '@/hooks/use-toast'

export function NotificationsSection() {
    const { webhook, setWebhook } = useFailoverStore()
    const [webhookUrl, setWebhookUrl] = useState(webhook.url)

    const handleSave = () => {
        setWebhook(webhookUrl, !!webhookUrl)
        toast({ title: webhookUrl ? 'Notifications Enabled' : 'Notifications Disabled' })
    }

    return (
        <section className="space-y-4">
            <div className="p-4 rounded-xl border bg-card/50 space-y-4">
                <div className="flex items-center justify-between">
                    <div>
                        <h2 className="text-xl font-bold flex items-center gap-2">
                            <Bell className="h-5 w-5 text-primary" />
                            Monitoring & Alerts
                        </h2>
                        <p className="text-sm text-muted-foreground">System-wide health alerts and failover notifications.</p>
                    </div>
                </div>
                <div className="space-y-2">
                    <Label className="text-sm font-semibold">
                        Discord Webhook URL
                    </Label>
                    <div className="flex gap-2">
                        <Input
                            placeholder="https://discord.com/api/webhooks/..."
                            value={webhookUrl}
                            onChange={(e) => setWebhookUrl(e.target.value)}
                            className="h-10 bg-background/50 border-muted focus:bg-background transition-colors"
                        />
                        <Button onClick={handleSave} className="shrink-0">Save</Button>
                    </div>
                </div>
            </div>
        </section>
    )
}
