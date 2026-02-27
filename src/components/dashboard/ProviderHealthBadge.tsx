import { ProviderHealth } from '@/types/provider'
import { Badge } from '@/components/ui/badge'
import { AlertCircle, CheckCircle2, Clock, XCircle } from 'lucide-react'

export function ProviderHealthBadge({ health }: { health: ProviderHealth }) {
    if (health.loading) {
        return (
            <Badge variant="outline" className="animate-pulse bg-muted/50 text-muted-foreground border-muted-foreground/20 gap-1.5 px-2 py-0.5">
                <Clock className="h-3 w-3" />
                Checking...
            </Badge>
        )
    }

    if (health.status === 'error') {
        return (
            <Badge variant="outline" className="bg-destructive/10 text-destructive border-destructive/20 gap-1.5 px-2 py-0.5" title={health.error}>
                <AlertCircle className="h-3 w-3" />
                Error
            </Badge>
        )
    }

    if (health.status === 'expired') {
        return (
            <Badge variant="outline" className="bg-destructive/10 text-destructive border-destructive/50 gap-1.5 px-2 py-0.5 font-bold">
                <XCircle className="h-3 w-3" />
                Expired
            </Badge>
        )
    }

    if (health.status === 'none') {
        return (
            <Badge variant="outline" className="bg-muted text-muted-foreground gap-1.5 px-2 py-0.5">
                Unknown
            </Badge>
        )
    }

    const days = health.daysRemaining ?? 0

    let colorClass = 'bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20'
    let Icon = CheckCircle2

    if (days <= 7) {
        colorClass = 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/50 font-bold animate-pulse'
        Icon = AlertCircle
    } else if (days <= 15) {
        colorClass = 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30 font-semibold'
        Icon = Clock
    } else if (days <= 30) {
        colorClass = 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20'
        Icon = Clock
    }

    return (
        <Badge variant="outline" className={`${colorClass} gap-1.5 px-2 py-0.5 transition-all duration-300`}>
            <Icon className="h-3 w-3" />
            {days} {days === 1 ? 'day' : 'days'}
        </Badge>
    )
}
