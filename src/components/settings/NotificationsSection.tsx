import { Bell } from 'lucide-react'

export function NotificationsSection() {
    return (
        <section className="space-y-4">
            <div className="p-4 rounded-xl border bg-card/50 space-y-4">
                <div className="flex items-center justify-between">
                    <div>
                        <h2 className="text-xl font-bold flex items-center gap-2">
                            <Bell className="h-5 w-5 text-primary" />
                            Monitoring & Alerts
                        </h2>
                        <p className="text-sm text-muted-foreground">
                            Webhook notifications are configured per Autopilot rule.
                        </p>
                    </div>
                </div>
                <p className="text-sm text-foreground/60">
                    To set up notifications, open an account, go to <span className="font-semibold text-foreground/80">Autopilot</span>, and configure the default webhook or per-rule overrides in the <span className="font-semibold text-foreground/80">Failover Manager</span>.
                </p>
            </div>
        </section>
    )
}
