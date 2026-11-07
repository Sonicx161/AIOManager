import { type ReactNode } from 'react'
import { Check, ChevronRight, type LucideIcon } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

/**
 * iOS-style settings rows (owner pick 2026-11-05): inset groups of rows with
 * trailing switches and value menus, checkmark rows, one grey footer per group
 * and separators inset to the label.
 */

export function SettingsGroup({ children, className }: { children: ReactNode; className?: string }) {
    return (
        <div data-theme-part="panel" className={cn('rounded-2xl border border-border/45 bg-card/80 px-2.5 py-1 shadow-sm', className)}>
            {children}
        </div>
    )
}

/** Inset to the label: group padding (10) + row padding (6) + tile (28) + gap (12). */
export function SettingsRowSeparator() {
    return <div aria-hidden className="ml-14 h-px bg-border/40" />
}

export function SettingsGroupLabel({ children }: { children: ReactNode }) {
    return <p className="px-1.5 pb-1.5 pt-3 text-xs font-semibold text-muted-foreground">{children}</p>
}

export function SettingsGroupFooter({ children, className }: { children: ReactNode; className?: string }) {
    return (
        <div className={cn('border-t border-border/40 px-4 pb-3 pt-2 text-xs leading-relaxed text-muted-foreground', className)}>
            {children}
        </div>
    )
}

interface SettingsRowProps {
    icon?: LucideIcon
    /** Picture in the icon tile's slot (account avatar, platform logo); never clipped by the label. */
    leading?: ReactNode
    label: ReactNode
    /** Trailing control: Switch, Button, value text, checkmark. */
    trailing?: ReactNode
    /** Id of the row's trailing control: renders the label as a real <label htmlFor> so the control gets an accessible name and click-to-toggle. */
    htmlFor?: string
    onClick?: () => void
    disabled?: boolean
    ariaPressed?: boolean
    className?: string
}

export function SettingsRow({ icon: Icon, leading, label, trailing, htmlFor, onClick, disabled, ariaPressed, className }: SettingsRowProps) {
    const content = (
        <>
            {leading && <span className="relative flex h-7 w-7 shrink-0 items-center justify-center">{leading}</span>}
            {!leading && Icon && (
                <span className="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-muted/35 text-muted-foreground">
                    <Icon className="h-[15px] w-[15px]" aria-hidden />
                </span>
            )}
            {htmlFor
                ? <label htmlFor={htmlFor} className="min-w-0 flex-1 cursor-pointer truncate text-sm font-medium">{label}</label>
                : <span className="min-w-0 flex-1 truncate text-sm font-medium">{label}</span>}
            {trailing}
        </>
    )
    if (!onClick) {
        return <div className={cn('flex min-h-[48px] w-full items-center gap-3 px-1.5 py-2', className)}>{content}</div>
    }
    return (
        <button
            type="button"
            data-theme-part="button"
            onClick={onClick}
            disabled={disabled}
            aria-pressed={ariaPressed}
            className={cn(
                'flex min-h-[48px] w-full items-center gap-3 rounded-xl px-1.5 py-2 text-left transition-colors',
                !disabled && 'hover:bg-muted/25',
                disabled && 'pointer-events-none opacity-50',
                className,
            )}
        >
            {content}
        </button>
    )
}

export function SettingsCheckRow({ icon, leading, label, note, checked, onToggle, disabled }: {
    icon?: LucideIcon
    leading?: ReactNode
    label: ReactNode
    note?: string
    checked: boolean
    onToggle: () => void
    disabled?: boolean
}) {
    return (
        <SettingsRow
            icon={icon}
            leading={leading}
            label={label}
            onClick={onToggle}
            disabled={disabled}
            ariaPressed={checked}
            trailing={
                <>
                    {note && <span className="shrink-0 text-xs text-muted-foreground">{note}</span>}
                    <span className={cn('flex h-5 w-5 shrink-0 items-center justify-center rounded-[4px]', checked ? 'bg-primary text-primary-foreground' : 'border border-border/60 text-transparent')}>
                        <Check className="h-3.5 w-3.5" aria-hidden />
                    </span>
                </>
            }
        />
    )
}

interface SettingsValueItem<T extends string | number> {
    value: T
    label: string
}

interface SettingsValueRowProps<T extends string | number> {
    icon?: LucideIcon
    label: string
    value: string
    items: ReadonlyArray<SettingsValueItem<T>>
    selected: T
    onSelect: (value: T) => void
    disabled?: boolean
}

/** Value row: grey current value plus chevron; the menu reuses the app's dropdown with checkmarks. */
export function SettingsValueRow<T extends string | number>({ icon, label, value, items, selected, onSelect, disabled }: SettingsValueRowProps<T>) {
    const Icon = icon
    return (
        <DropdownMenu className="w-full">
            <DropdownMenuTrigger asChild disabled={disabled}>
                <button
                    type="button"
                    className={cn(
                        'flex min-h-[48px] w-full items-center gap-3 rounded-xl px-1.5 py-2 text-left transition-colors',
                        !disabled && 'hover:bg-muted/25',
                        disabled && 'pointer-events-none opacity-50',
                    )}
                >
                    {Icon && (
                        <span className="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-muted/35 text-muted-foreground">
                            <Icon className="h-[15px] w-[15px]" aria-hidden />
                        </span>
                    )}
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{label}</span>
                    <span className="max-w-[45%] truncate text-xs text-muted-foreground">{value}</span>
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/60" aria-hidden />
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="min-w-[210px]">
                {items.map(item => (
                    <DropdownMenuItem key={String(item.value)} onClick={() => onSelect(item.value)} className="min-h-[44px] gap-2.5">
                        <Check className={cn('h-4 w-4 shrink-0 text-primary', selected === item.value ? 'opacity-100' : 'opacity-0')} aria-hidden />
                        {item.label}
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    )
}
