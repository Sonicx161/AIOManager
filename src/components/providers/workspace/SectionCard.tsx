import type { ReactNode } from 'react'
import { AlertCircle, Loader2, Lock, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export function SectionCard({ title, description, action, footer, children, className, tone = 'default' }: {
    title?: ReactNode
    description?: ReactNode
    action?: ReactNode
    footer?: ReactNode
    children?: ReactNode
    className?: string
    tone?: 'default' | 'destructive'
}) {
    return (
        <section
            data-theme-part="panel"
            data-theme-tone={tone === 'destructive' ? 'status' : undefined}
            className={cn(
                'flex min-w-0 flex-col rounded-2xl border shadow-sm',
                tone === 'destructive' ? 'border-destructive/30 bg-destructive/5' : 'border-border/40 bg-card/50',
                className,
            )}
        >
            {(title || action) && (
                <div className="flex flex-wrap items-start gap-3 px-4 pt-4">
                    <div className="min-w-0 flex-1">
                        {title && <h3 className={cn('text-sm font-semibold', tone === 'destructive' && 'text-destructive')}>{title}</h3>}
                        {description && <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>}
                    </div>
                    {action && <div className="flex shrink-0 flex-wrap items-center gap-2">{action}</div>}
                </div>
            )}
            {children != null && <div className="min-w-0 space-y-3 p-4">{children}</div>}
            {footer && <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-border/30 px-4 py-3">{footer}</div>}
        </section>
    )
}

export function SectionRows({ children }: { children: ReactNode }) {
    return <dl className="divide-y divide-border/30">{children}</dl>
}

export function SectionRow({ label, value, aside, mono, tone }: {
    label: ReactNode
    value: ReactNode
    aside?: ReactNode
    mono?: boolean
    tone?: 'muted' | 'destructive' | 'warning'
}) {
    return (
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 py-2 first:pt-0 last:pb-0">
            <dt className="w-28 shrink-0 text-xs text-muted-foreground">{label}</dt>
            <dd className={cn(
                'min-w-0 flex-1 text-xs font-medium',
                mono ? 'break-all font-mono' : 'break-words',
                tone === 'muted' && 'text-muted-foreground',
                tone === 'destructive' && 'text-destructive',
                tone === 'warning' && 'text-warning',
            )}>{value}</dd>
            {aside && <div className="flex shrink-0 items-center gap-1.5">{aside}</div>}
        </div>
    )
}

export function WorkspaceLoading({ label = 'Loading…', compact }: { label?: string; compact?: boolean }) {
    return (
        <div role="status" className={cn('flex items-center justify-center gap-2 text-xs text-muted-foreground', compact ? 'py-3' : 'py-16')}>
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {label}
        </div>
    )
}

export function WorkspaceError({ message, onRetry, title, action }: { message: string; onRetry?: () => void; title?: string; action?: ReactNode }) {
    return (
        <div data-theme-tone="status" data-theme-part="panel" role="alert" className="flex flex-wrap items-start gap-3 rounded-2xl border border-destructive/20 bg-destructive/10 px-3 py-2.5 shadow-sm">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <div className="min-w-0 flex-1 basis-52 text-xs">
                {title && <p className="font-semibold text-destructive">{title}</p>}
                <p className="break-words text-destructive/90">{message}</p>
            </div>
            {(onRetry || action) && (
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                    {onRetry && (
                        <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs" onClick={onRetry}>
                            <RefreshCw className="h-3.5 w-3.5" />
                            Retry
                        </Button>
                    )}
                    {action}
                </div>
            )}
        </div>
    )
}

export function WorkspaceNotice({ icon, title, children, action, tone = 'warning' }: {
    icon?: ReactNode
    title: ReactNode
    children?: ReactNode
    action?: ReactNode
    tone?: 'warning' | 'destructive' | 'muted'
}) {
    return (
        <div
            data-theme-tone="status"
            data-theme-part="panel"
            role={tone === 'muted' ? 'note' : 'status'}
            className={cn(
                'flex flex-wrap items-center gap-3 rounded-2xl border px-3.5 py-3',
                tone === 'warning' && 'border-warning/30 bg-warning/10',
                tone === 'destructive' && 'border-destructive/30 bg-destructive/10',
                tone === 'muted' && 'border-border/40 bg-muted/20',
            )}
        >
            {icon && <span className={cn('shrink-0', tone === 'warning' ? 'text-warning' : tone === 'destructive' ? 'text-destructive' : 'text-muted-foreground')}>{icon}</span>}
            <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">{title}</p>
                {children && <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{children}</p>}
            </div>
            {action && <div className="flex shrink-0 flex-wrap items-center gap-2">{action}</div>}
        </div>
    )
}

export function VaultLockedNotice({ children }: { children?: ReactNode }) {
    return (
        <WorkspaceNotice icon={<Lock className="h-4 w-4" />} title="Vault locked" tone="muted">
            {children || 'Unlock your vault to test, re-authenticate or change this connection.'}
        </WorkspaceNotice>
    )
}

export function ReadOnlyBadge({ label = 'Read-only' }: { label?: string }) {
    return (
        <span data-theme-part="badge" className="inline-flex shrink-0 items-center rounded-full border border-border/40 bg-muted/30 px-2 py-0.5 text-xs font-medium text-muted-foreground">
            {label}
        </span>
    )
}
