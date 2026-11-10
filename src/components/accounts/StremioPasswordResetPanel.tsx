import { Button } from '@/components/ui/button'
import { ExternalLink, KeyRound, RotateCcw } from 'lucide-react'
import { buildResetPasswordUrl } from '@/api/stremio-relay'
import { STREMIO_PASSWORD_RESET_COPY } from '@/lib/stremio-password-reset'
import { cn } from '@/lib/utils'

interface StremioPasswordResetPanelProps {
    email: string
    onTryAgain: () => void
    compact?: boolean
}

export function StremioPasswordResetPanel({ email, onTryAgain, compact }: StremioPasswordResetPanelProps) {
    return (
        <div data-theme-part="panel" className={cn('rounded-xl border border-border/45 bg-card', compact ? 'px-3 py-2.5' : 'px-4 py-3')}>
            <div className="flex items-start gap-3">
                <div className={cn(
                    'flex shrink-0 items-center justify-center rounded-xl border border-warning/20 bg-warning/10 text-warning',
                    compact ? 'h-8 w-8' : 'h-9 w-9'
                )}>
                    <KeyRound className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                    <p className={cn('font-semibold text-warning', compact ? 'text-[13px]' : 'text-sm')}>
                        {STREMIO_PASSWORD_RESET_COPY.title}
                    </p>
                    <p className={cn('mt-0.5 leading-snug text-muted-foreground', compact ? 'text-xs' : 'text-sm')}>
                        {STREMIO_PASSWORD_RESET_COPY.body}
                    </p>
                    <div className="mt-2.5 flex flex-col gap-2">
                        <Button
                            type="button"
                            size={compact ? 'sm' : 'default'}
                            variant="outline"
                            onClick={() => window.open(buildResetPasswordUrl(email), '_blank', 'noopener,noreferrer')}
                            className="w-full gap-1.5 rounded-xl font-semibold"
                        >
                            <ExternalLink className="h-3.5 w-3.5" />
                            {STREMIO_PASSWORD_RESET_COPY.actionLabel}
                        </Button>
                        <Button
                            type="button"
                            size={compact ? 'sm' : 'default'}
                            variant="ghost"
                            onClick={onTryAgain}
                            className="w-full gap-1.5 rounded-xl font-semibold"
                        >
                            <RotateCcw className="h-3.5 w-3.5" />
                            {STREMIO_PASSWORD_RESET_COPY.retryLabel}
                        </Button>
                    </div>
                </div>
            </div>
        </div>
    )
}
