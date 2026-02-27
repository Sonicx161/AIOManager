import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { X } from 'lucide-react'
import { ReactNode } from 'react'

export interface FloatingActionItem {
    label: string
    icon?: ReactNode
    onClick: () => void
    variant?: 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link'
    disabled?: boolean
}

interface FloatingActionBarProps {
    open: boolean
    selectedCount: number
    totalCount?: number
    onClearSelection: () => void
    actions: FloatingActionItem[]
    className?: string
}

export function FloatingActionBar({
    open,
    selectedCount,
    totalCount,
    onClearSelection,
    actions,
    className
}: FloatingActionBarProps) {
    if (!open) return null

    return (
        <div className={cn(
            "fixed bottom-6 left-1/2 -translate-x-1/2 z-50 w-full max-w-3xl px-4 pointer-events-none",
            className
        )}>
            <div className="bg-background border shadow-2xl rounded-2xl p-2 flex items-center justify-between gap-4 pointer-events-auto animate-in fade-in slide-in-from-bottom-10 duration-300">

                {/* Selection Count */}
                <div className="flex items-center gap-3 pl-2">
                    <div className="bg-primary/10 text-primary font-bold px-3 py-1 rounded-full text-sm">
                        {selectedCount}
                    </div>
                    <span className="text-sm font-medium text-muted-foreground hidden sm:inline-block">
                        Selected
                        {totalCount ? <span className="opacity-50 mx-1">/ {totalCount}</span> : ''}
                    </span>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2">
                    {actions.map((action, index) => (
                        <Button
                            key={index}
                            size="sm"
                            variant={action.variant || 'default'}
                            onClick={action.onClick}
                            disabled={action.disabled}
                            className="h-9"
                        >
                            {action.icon && <span className="mr-2 h-4 w-4">{action.icon}</span>}
                            {action.label}
                        </Button>
                    ))}

                    <div className="h-6 w-px bg-border mx-1" />

                    <Button
                        size="icon"
                        variant="ghost"
                        onClick={onClearSelection}
                        className="h-9 w-9 rounded-full hover:bg-muted"
                        title="Clear Selection"
                    >
                        <X className="h-4 w-4" />
                    </Button>
                </div>
            </div>
        </div>
    )
}
