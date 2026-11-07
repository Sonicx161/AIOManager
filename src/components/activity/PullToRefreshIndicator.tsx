import { ArrowDown, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { PullPhase } from '@/lib/touch-gestures'

interface PullToRefreshIndicatorProps {
  distance: number
  phase: PullPhase
  refreshing: boolean
}

export function PullToRefreshIndicator({ distance, phase, refreshing }: PullToRefreshIndicatorProps) {
  if (distance <= 0 && !refreshing) return null
  const label = refreshing ? 'Refreshing' : phase === 'ready' ? 'Release to refresh' : 'Pull to refresh'
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center justify-center gap-2.5 overflow-hidden md:hidden"
      style={{ height: distance }}
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-primary/40 bg-card shadow-sm">
        {refreshing ? (
          <Loader2 className="h-4 w-4 text-primary motion-safe:animate-spin" />
        ) : (
          <ArrowDown
            className={cn('h-4 w-4 text-primary motion-safe:transition-transform', phase === 'ready' && 'rotate-180')}
          />
        )}
      </span>
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
    </div>
  )
}
