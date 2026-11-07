import { XCircle, AlertCircle, RefreshCw } from 'lucide-react'
import { Progress } from '@/components/ui/progress'
import { cn } from '@/lib/utils'

export type OperationStatus = 'idle' | 'running' | 'cancelling' | 'complete' | 'cancelled' | 'error'

interface OperationProgressProps {
    status: OperationStatus
    current: number
    total: number
    label?: string
    detail?: string
    showPercent?: boolean
    variant?: 'card' | 'bare'
    className?: string
}

export function OperationProgress({
    status,
    current,
    total,
    label,
    detail,
    showPercent = true,
    variant = 'card',
    className,
}: OperationProgressProps) {
    if (status === 'idle') return null

    const percent = total > 0 ? Math.max(0, Math.min(100, Math.round((current / total) * 100))) : 0
    const isRunning = status === 'running' || status === 'cancelling'
    const hasTotal = total > 0
    const defaultLabel = isRunning
        ? hasTotal ? `${current} of ${total}` : current > 0 ? `${current} processed` : 'Working...'
        : status === 'complete'
            ? 'Complete'
            : status === 'error'
                ? 'Failed'
                : 'Cancelled'

    const inner = (
        <div className="flex items-center gap-3">
            <div data-theme-part="badge" className={cn(
                'flex h-8 w-8 shrink-0 items-center justify-center rounded-xl',
                status === 'error' ? 'bg-destructive/10' : 'bg-primary/10',
            )}>
                {isRunning
                    ? <RefreshCw className="h-4 w-4 text-primary animate-spin motion-reduce:animate-none" />
                    : status === 'error'
                        ? <AlertCircle className="h-4 w-4 text-destructive" />
                        : <XCircle className="h-4 w-4 text-muted-foreground" />}
            </div>
            <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold">
                    {label ?? defaultLabel}
                </div>
                {detail && (
                    <div className="truncate text-xs text-muted-foreground">{detail}</div>
                )}
            </div>
            {showPercent && hasTotal && (
                <span className="shrink-0 text-sm font-bold tabular-nums text-primary">
                    {percent}%
                </span>
            )}
        </div>
    )

    const barLabel = label || defaultLabel
    const bar = hasTotal
        ? <Progress value={percent} shimmer={isRunning} aria-label={barLabel} className="h-1.5" />
        : isRunning
            ? <Progress indeterminate aria-label={barLabel} className="h-1.5" />
            : null

    if (variant === 'bare') {
        return (
            <div className={cn('space-y-2', className)}>
                {inner}
                {bar}
            </div>
        )
    }

    return (
        <div data-theme-part="panel" className={cn(
            'rounded-2xl border border-border/40 bg-card shadow-sm p-4 space-y-3',
            status === 'error' && 'border-destructive/30',
            className,
        )}>
            {inner}
            {bar}
        </div>
    )
}
