import { Button } from '@/components/ui/button'
import { StatusChip } from '@/components/ui/status-chip'
import { Tooltip } from '@/components/ui/tooltip'
import { Trash2, Download, Upload, ChevronRight } from 'lucide-react'
import { useState, memo } from 'react'
import { cn } from '@/lib/utils'
import { timeAgo } from '@/lib/connection-format'
import type { HydraSubscriber } from '@/api/hydra-providers'
import { pullFreshness, subscriberIsSender } from './workspace/workspace-model'
import { PullAppLogo } from './HydraPullPanel'

// First-class connection card for a Hydra app. Shares ConnectionCard's shell so these apps
// sit as equals in the connections grid. The lone sender (successful pushes, no pulls, sole
// app on its account) gets the approved Sends card with last active from push evidence;
// every other app renders beta's pull card exactly, from register-driven last_seen_at.
export const SubscriberCard = memo(function SubscriberCard({ subscriber, onRemove, onOpen }: {
    subscriber: HydraSubscriber
    onRemove: (name: string) => void
    onOpen?: () => void
}) {
    const [confirmRemove, setConfirmRemove] = useState(false)
    const sender = subscriberIsSender(subscriber.last_pull_at, subscriber.last_push_at)
    const stale = !sender && pullFreshness(subscriber.last_seen_at, Date.now()) !== 'synced'
    const stop = (e: React.SyntheticEvent) => e.stopPropagation()
    const stopActivate = (e: React.KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation() }

    return (
        <div
            role={onOpen ? 'button' : undefined}
            tabIndex={onOpen ? 0 : undefined}
            aria-label={onOpen ? `Open ${subscriber.name}` : undefined}
            onClick={onOpen}
            onKeyDown={onOpen ? (e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onOpen() } } : undefined}
            data-theme-part="card"
            className={cn(
                'group rounded-2xl border border-border/40 bg-card text-card-foreground shadow-sm',
                onOpen && 'cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                'transition-[background-color,border-color,box-shadow,transform] duration-200',
                'hover:-translate-y-0.5 hover:border-border/70 hover:bg-card/95 hover:shadow-md',
                stale && 'border-warning/30'
            )}
        >
            <div className="flex items-start gap-3 p-4">
                <PullAppLogo subscriber={subscriber} className="mt-0.5 h-11 w-11 shrink-0" />
                <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-sm font-semibold leading-tight truncate">{subscriber.name}</span>
                        <StatusChip size="sm" variant="muted" className="h-5 gap-1 px-2 text-[11px]">
                            {sender ? <Upload className="h-3 w-3" /> : <Download className="h-3 w-3" />}
                            {sender ? 'Sends' : 'Pull'}
                        </StatusChip>
                    </div>
                    {!sender && (
                        <div className="flex items-center gap-1.5">
                            <StatusChip size="sm" variant={stale ? 'warning' : 'success'} className="h-5 gap-1.5 px-2 text-[11px]">
                                <span className={cn('h-1.5 w-1.5 rounded-full', stale ? 'bg-warning' : 'bg-success')} />
                                {stale ? 'Stale' : 'Synced'}
                            </StatusChip>
                        </div>
                    )}
                    <p className={cn('text-xs text-muted-foreground', sender ? '' : 'line-clamp-1')}>
                        {sender
                            ? `Sends its addon to this account · last active ${timeAgo(subscriber.last_push_at)}`
                            : `Pulls your addons · ${subscriber.last_seen_at ? `synced ${timeAgo(subscriber.last_seen_at)}` : 'not pulled yet'}`}
                    </p>
                    <p className="text-xs text-muted-foreground/60">{sender ? 'Backendless app' : 'Backendless app · read-only pull'}</p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1" onClick={stop} onKeyDown={stopActivate}>
                    {confirmRemove ? (
                        <div className="flex flex-col items-end gap-1.5">
                            <Button size="sm" variant="destructive" className="h-7 text-xs" onClick={() => { onRemove(subscriber.name); setConfirmRemove(false) }}>Remove</Button>
                            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setConfirmRemove(false)}>Cancel</Button>
                        </div>
                    ) : (
                        <Tooltip content="Remove app">
                            <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive" onClick={() => setConfirmRemove(true)}>
                                <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                        </Tooltip>
                    )}
                    {onOpen && <ChevronRight className="mt-1 h-4 w-4 text-muted-foreground/40" />}
                </div>
            </div>
        </div>
    )
})
