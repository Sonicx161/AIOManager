import { Play, Pause } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Tooltip } from '@/components/ui/tooltip'
import type { MediaPlayback } from '@/lib/jellyfin/activity'

export function AccountMediaPlayback({ playback, compact = false }: { playback: MediaPlayback; compact?: boolean }) {
    const position = Math.floor((playback.item.mediaObservation?.positionMs || 0) / 1000)
    const clock = `${Math.floor(position / 60)}:${String(position % 60).padStart(2, '0')}`
    const label = playback.state === 'resume' ? 'Continue' : playback.state === 'paused' ? 'Paused' : 'Playing'
    const Icon = playback.state === 'paused' ? Pause : Play
    return <div data-media-playback={playback.state} className={cn('flex min-w-0 items-center gap-1.5 text-xs', !compact && 'min-h-5')}>
        <Icon className={cn('h-3.5 w-3.5 shrink-0', playback.state === 'playing' ? 'text-success' : 'text-muted-foreground/65')} aria-hidden="true" />
        <span className="shrink-0 text-[10px] font-medium text-muted-foreground">{label}</span>
        <Tooltip content={`${playback.item.name} · ${playback.productName}`} side="top">
            <span className="truncate font-medium text-foreground/80">{playback.item.name}</span>
        </Tooltip>
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{clock}</span>
    </div>
}

export function AccountWatchingNow({ name, compact = false }: { name: string; compact?: boolean }) {
    return <div data-watching-now className={cn('flex min-w-0 items-center gap-1.5 text-xs', !compact && 'min-h-5')}>
        <Play className="h-3.5 w-3.5 shrink-0 text-success" aria-hidden="true" />
        <span className={cn('text-[10px] font-medium text-muted-foreground', compact ? 'min-w-0 truncate' : 'shrink-0')}>Watching now</span>
        <Tooltip content={name} side="top">
            <span className={cn('truncate font-medium text-foreground/80', compact && 'hidden sm:inline')}>{name}</span>
        </Tooltip>
    </div>
}
