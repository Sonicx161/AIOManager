import type { ReactNode } from 'react'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import type { WorkspaceTabDef } from './workspace-model'

export interface WorkspaceTabItem extends WorkspaceTabDef {
    icon?: ReactNode
    disabled?: boolean
}

// One card: header, a single row of tabs that scrolls sideways on narrow
// screens instead of wrapping, and the active tab's body.
export function WorkspaceTabs({ label, tabs, value, onValueChange, header, actions, children, className }: {
    label: string
    tabs: WorkspaceTabItem[]
    value: string
    onValueChange: (value: string) => void
    header?: ReactNode
    actions?: ReactNode
    children: ReactNode
    className?: string
}) {
    return (
        <Tabs value={value} onValueChange={onValueChange} data-theme-part="panel" data-workspace="tabs" className={cn('min-w-0 rounded-2xl border border-border/40 bg-card/30 shadow-sm', className)}>
            {header && <div className="rounded-t-2xl border-b border-border/40 bg-card/70">{header}</div>}
            <div data-theme-part="tab-workspace-header" className={cn('flex min-w-0 items-center gap-2 border-b border-border/40 bg-card/70 px-2 py-2 sm:px-3', !header && 'rounded-t-2xl')}>
                <TabsList
                    aria-label={label}
                    className="w-auto min-w-0 flex-1 flex-nowrap justify-start gap-1 overflow-x-auto rounded-xl border-0 bg-transparent p-0 shadow-none [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                >
                    {tabs.map(tab => (
                        <TabsTrigger
                            key={tab.id}
                            value={tab.id}
                            disabled={tab.disabled}
                            className="min-h-11 shrink-0 px-3 text-xs sm:min-h-8"
                        >
                            {tab.icon}
                            {tab.label}
                            {tab.count != null && (
                                <span className="rounded-md bg-muted px-1.5 text-xs font-semibold tabular-nums text-muted-foreground">{tab.count}</span>
                            )}
                            {tab.readOnly && (
                                <span className="rounded-full border border-border/40 px-1.5 text-xs font-medium text-muted-foreground">Read-only</span>
                            )}
                        </TabsTrigger>
                    ))}
                </TabsList>
                {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
            </div>
            <div data-theme-part="tab-workspace-body" className="min-w-0 p-4 sm:p-5 [&>[data-theme-part=tab-panel]]:mt-0">
                {children}
            </div>
        </Tabs>
    )
}
