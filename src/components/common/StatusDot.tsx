import { Tooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

export type StatusDotTone = 'success' | 'warning' | 'destructive'

const TONE_BG: Record<StatusDotTone, string> = {
    success: 'bg-success',
    warning: 'bg-warning',
    destructive: 'bg-destructive',
}

interface StatusDotProps {
    tone: StatusDotTone
    label: string
    tooltip?: string
    pulse?: boolean
    // Size of the colored dot; the card-colored cut-out border sits outside it.
    sizeClassName?: string
    className?: string
}

// Corner status dot shared with AccountAvatar: a solid card-colored cut-out, only the inner color pulses.
export function StatusDot({ tone, label, tooltip, pulse = false, sizeClassName = 'h-2.5 w-2.5', className }: StatusDotProps) {
    return (
        <Tooltip content={tooltip ?? label} side="top">
            <span
                role="img"
                aria-label={label}
                className={cn('absolute -bottom-1 -right-1 z-20 box-content rounded-full border-2 border-card bg-card', sizeClassName, className)}
            >
                <span className={cn('block h-full w-full rounded-full', TONE_BG[tone], pulse && 'animate-pulse')} />
            </span>
        </Tooltip>
    )
}
