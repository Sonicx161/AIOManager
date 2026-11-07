import { forwardRef, useState, type ComponentPropsWithoutRef, type ReactNode } from 'react'
import { ChevronDown, MoreHorizontal } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { ConnectionStatusPill, pillLabel, type PillStatus } from '../ConnectionPrimitives'

export interface WorkspaceStat {
    label: string
    value: ReactNode
    sub?: ReactNode
    tone?: 'destructive' | 'warning' | 'muted'
    title?: string
    onClick?: () => void
    /** Accessible name when the stat acts as a button. */
    actionLabel?: string
}

// The status pill is a door: it opens a popover that explains the state and
// offers the next action, so the pill is never just a coloured word.
export function WorkspaceStatusPill({ status, label, children }: { status: PillStatus; label?: string; children?: ReactNode }) {
    const [open, setOpen] = useState(false)
    const text = label || pillLabel(status)
    const chip = (
        <ConnectionStatusPill status={status} label={text} className="h-6 text-xs">
            {children && <ChevronDown className="!h-3 !w-3 opacity-70" />}
        </ConnectionStatusPill>
    )
    if (!children) return chip
    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <button
                    type="button"
                    aria-label={`${text}. Show status details`}
                    className="-my-2.5 inline-flex min-h-11 items-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:my-0 sm:min-h-0"
                >
                    {chip}
                </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-[min(20rem,calc(100vw-2rem))] space-y-3 rounded-2xl border-border/40 p-4" onClick={e => { if ((e.target as HTMLElement).closest('[data-close-popover]')) setOpen(false) }}>
                {children}
            </PopoverContent>
        </Popover>
    )
}

export const WorkspaceAction = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<typeof Button>>(function WorkspaceAction({ className, ...props }, ref) {
    return <Button ref={ref} variant="outline" size="sm" className={cn('h-11 flex-1 gap-1.5 text-xs sm:h-8 sm:flex-none', className)} {...props} />
})

export function WorkspaceMoreMenu({ children, label = 'More actions' }: { children: ReactNode; label?: string }) {
    return (
        <DropdownMenu>
            <DropdownMenuTrigger
                aria-label={label}
                className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-border/40 bg-muted/30 text-muted-foreground shadow-sm transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-8 sm:w-8"
            >
                <MoreHorizontal className="h-4 w-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">{children}</DropdownMenuContent>
        </DropdownMenu>
    )
}

export function WorkspaceStatStrip({ stats, className, bordered }: { stats: WorkspaceStat[]; className?: string; bordered?: boolean }) {
    if (stats.length === 0) return null
    return (
        <dl
            className={cn(
                'grid grid-cols-2 border-border/30',
                stats.length >= 4 ? 'sm:grid-cols-4' : stats.length === 3 ? 'sm:grid-cols-3' : 'sm:grid-cols-2',
                bordered ? 'overflow-hidden rounded-2xl border bg-card/50 shadow-sm' : 'border-t',
                className,
            )}
        >
            {stats.map((stat, i) => (
                <div
                    key={stat.label}
                    className={cn(
                        'min-w-0 border-border/30 px-4 py-3',
                        stat.onClick && 'relative',
                        i % 2 === 1 && 'border-l',
                        i >= 2 && 'border-t sm:border-t-0',
                        i > 0 && 'sm:border-l',
                    )}
                >
                    <dt className="text-xs font-medium uppercase text-muted-foreground">{stat.label}</dt>
                    <dd
                        title={stat.title}
                        className={cn(
                            'mt-0.5 flex min-w-0 items-center gap-1.5 truncate text-sm font-semibold',
                            stat.tone === 'destructive' && 'text-destructive',
                            stat.tone === 'warning' && 'text-warning',
                            stat.tone === 'muted' && 'text-muted-foreground',
                        )}
                    >
                        <span className="min-w-0 truncate">{stat.value}</span>
                    </dd>
                    {stat.sub && <dd className="mt-0.5 truncate text-xs text-muted-foreground">{stat.sub}</dd>}
                    {/* Overlay keeps the dt/dd markup valid while the whole cell stays clickable. */}
                    {stat.onClick && (
                        <button
                            type="button"
                            onClick={stat.onClick}
                            aria-label={stat.actionLabel || stat.label}
                            className="absolute inset-0 cursor-pointer rounded-lg transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                        />
                    )}
                </div>
            ))}
        </dl>
    )
}

export function WorkspaceHeader({ logo, title, pill, family, identity, actions, stats, notice }: {
    logo: ReactNode
    title: string
    pill?: ReactNode
    family?: ReactNode
    identity?: ReactNode
    actions?: ReactNode
    stats?: WorkspaceStat[]
    notice?: ReactNode
}) {
    return (
        <div data-workspace="header" className="min-w-0">
            <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:gap-4">
                <div className="flex min-w-0 flex-1 items-center gap-3">
                    <div className="shrink-0">{logo}</div>
                    <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                            <h2 title={title} className="min-w-0 max-w-full truncate text-lg font-bold tracking-tight">{title}</h2>
                            {pill}
                            {family}
                        </div>
                        {identity && <div className="min-w-0 truncate text-xs text-muted-foreground">{identity}</div>}
                    </div>
                </div>
                {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
            </div>
            {notice && <div className="px-4 pb-4">{notice}</div>}
            {stats && <WorkspaceStatStrip stats={stats} />}
        </div>
    )
}

export function PopoverFacts({ facts }: { facts: Array<{ label: string; value: ReactNode; tone?: 'destructive' | 'warning' }> }) {
    return (
        <dl className="space-y-1.5">
            {facts.map(fact => (
                <div key={fact.label} className="flex items-start justify-between gap-3 text-xs">
                    <dt className="shrink-0 text-muted-foreground">{fact.label}</dt>
                    <dd className={cn('min-w-0 text-right font-medium [overflow-wrap:anywhere]', fact.tone === 'destructive' && 'text-destructive', fact.tone === 'warning' && 'text-warning')}>{fact.value}</dd>
                </div>
            ))}
        </dl>
    )
}
