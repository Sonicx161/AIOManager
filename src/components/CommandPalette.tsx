import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useAccountStore } from '@/store/accountStore'
import { useNavigate } from 'react-router-dom'
import {
    LayoutDashboard,
    Package,
    Activity,
    BarChart3,
    Settings,
    HelpCircle,
    User,
    Search,
    CornerDownLeft,
    Sparkles,
} from 'lucide-react'
import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { useFailoverStore } from '@/store/failoverStore'
import { useUIStore } from '@/store/uiStore'

interface CommandItem {
    id: string
    label: string
    sublabel?: string
    icon: React.ReactNode
    action: () => void
    category: 'Navigation' | 'Accounts' | 'Quick Actions'
}

/**
 * Global Command Palette (Ctrl+K / Cmd+K).
 * - Navigate to any page
 * - Jump to a specific account
 * - Quick actions (refresh, settings, autopilot)
 */
export function CommandPalette() {
    const [open, setOpen] = useState(false)
    const [query, setQuery] = useState('')
    const [selectedIndex, setSelectedIndex] = useState(0)
    const inputRef = useRef<HTMLInputElement>(null)
    const scrollRef = useRef<HTMLDivElement>(null)
    const navigate = useNavigate()
    const accounts = useAccountStore((s) => s.accounts)
    const syncAllAccounts = useAccountStore((s) => s.syncAllAccounts)
    const checkRules = useFailoverStore((s) => s.checkRules)

    // Global keyboard shortcut
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
                e.preventDefault()
                setOpen((prev) => !prev)
            }
        }
        window.addEventListener('keydown', handler)
        return () => window.removeEventListener('keydown', handler)
    }, [])

    const go = useCallback(
        (path: string) => {
            navigate(path)
            setOpen(false)
        },
        [navigate]
    )

    // Build command items
    const allItems = useMemo<CommandItem[]>(() => {
        const items: CommandItem[] = []

        // Navigation
        items.push(
            {
                id: 'nav-accounts',
                label: 'Accounts',
                sublabel: 'Dashboard home — manage all accounts',
                icon: <LayoutDashboard className="h-4 w-4" />,
                action: () => go('/'),
                category: 'Navigation',
            },
            {
                id: 'nav-library',
                label: 'Saved Addons Library',
                sublabel: 'Browse and manage saved addon profiles',
                icon: <Package className="h-4 w-4" />,
                action: () => go('/saved-addons'),
                category: 'Navigation',
            },
            {
                id: 'nav-activity',
                label: 'Activity',
                sublabel: 'Unified watch history from all accounts',
                icon: <Activity className="h-4 w-4" />,
                action: () => go('/activity'),
                category: 'Navigation',
            },
            {
                id: 'nav-metrics',
                label: 'Metrics',
                sublabel: 'Stats, charts, and insights',
                icon: <BarChart3 className="h-4 w-4" />,
                action: () => go('/metrics'),
                category: 'Navigation',
            },
            {
                id: 'nav-settings',
                label: 'Settings',
                sublabel: 'Themes, sync, privacy, and preferences',
                icon: <Settings className="h-4 w-4" />,
                action: () => go('/settings'),
                category: 'Navigation',
            },
            {
                id: 'nav-faq',
                label: 'FAQ',
                sublabel: 'Help, guides, and troubleshooting',
                icon: <HelpCircle className="h-4 w-4" />,
                action: () => go('/faq'),
                category: 'Navigation',
            }
        )

        // Accounts
        for (const acc of accounts) {
            items.push({
                id: `acc-${acc.id}`,
                label: acc.name || acc.email || 'Unnamed Account',
                sublabel: acc.email && acc.name ? acc.email : undefined,
                icon: <User className="h-4 w-4" />,
                action: () => go(`/account/${acc.id}`),
                category: 'Accounts',
            })
        }

        // Quick Actions
        items.push(
            {
                id: 'action-refresh',
                label: 'Refresh All Accounts',
                sublabel: 'Sync addons for every connected account',
                icon: <Activity className="h-4 w-4" />,
                action: () => {
                    syncAllAccounts()
                    checkRules()
                    setOpen(false)
                },
                category: 'Quick Actions',
            },
            {
                id: 'action-changelog',
                label: 'View Changelog',
                sublabel: "See what's new in this release",
                icon: <Sparkles className="h-4 w-4" />,
                action: () => {
                    useUIStore.getState().setWhatsNewOpen(true)
                    setOpen(false)
                },
                category: 'Quick Actions',
            }
        )

        return items
    }, [accounts, go, syncAllAccounts, checkRules])

    // Filter
    const filtered = useMemo(() => {
        if (!query.trim()) return allItems
        const q = query.toLowerCase()
        return allItems.filter(
            (item) =>
                item.label.toLowerCase().includes(q) ||
                item.sublabel?.toLowerCase().includes(q) ||
                item.category.toLowerCase().includes(q)
        )
    }, [allItems, query])

    // Group by category
    const grouped = useMemo(() => {
        const groups: Record<string, CommandItem[]> = {}
        for (const item of filtered) {
            if (!groups[item.category]) groups[item.category] = []
            groups[item.category].push(item)
        }
        return groups
    }, [filtered])

    // Reset selection on filter change
    useEffect(() => {
        setSelectedIndex(0)
    }, [query])

    // Reset query on open
    useEffect(() => {
        if (open) {
            setQuery('')
            setSelectedIndex(0)
            // Focus input after dialog animation
            setTimeout(() => inputRef.current?.focus(), 50)
        }
    }, [open])

    // Keyboard navigation
    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'ArrowDown') {
            e.preventDefault()
            setSelectedIndex((prev) => Math.min(prev + 1, filtered.length - 1))
        } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setSelectedIndex((prev) => Math.max(prev - 1, 0))
        } else if (e.key === 'Enter' && filtered[selectedIndex]) {
            e.preventDefault()
            filtered[selectedIndex].action()
        } else if (e.key === 'Escape') {
            setOpen(false)
        }
    }

    // Scroll selected item into view
    useEffect(() => {
        const el = scrollRef.current?.querySelector(`[data-index="${selectedIndex}"]`)
        if (el) {
            el.scrollIntoView({ block: 'nearest' })
        }
    }, [selectedIndex])

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent
                className="max-w-md p-0 gap-0 overflow-hidden rounded-xl shadow-2xl border-border/50 [&>button:last-child]:hidden"
                onKeyDown={handleKeyDown}
            >
                {/* Search Input */}
                <div className="flex items-center gap-3 px-4 py-3 border-b">
                    <Search className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                    <Input
                        ref={inputRef}
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Search pages, accounts, actions..."
                        className="border-0 p-0 h-auto bg-transparent focus-visible:ring-0 text-sm placeholder:text-muted-foreground/60"
                    />
                    <button
                        onClick={() => setOpen(false)}
                        className="hidden sm:inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground bg-muted border rounded hover:bg-accent transition-colors"
                    >
                        Esc
                    </button>
                </div>

                {/* Results */}
                <ScrollArea className="max-h-[320px]" ref={scrollRef}>
                    <div className="py-2">
                        {filtered.length === 0 && (
                            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                                No results found for "{query}"
                            </div>
                        )}

                        {Object.entries(grouped).map(([category, items]) => (
                            <div key={category}>
                                <div className="px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
                                    {category}
                                </div>
                                {items.map((item) => {
                                    const flatIndex = filtered.indexOf(item)
                                    const isSelected = flatIndex === selectedIndex

                                    return (
                                        <button
                                            key={item.id}
                                            data-index={flatIndex}
                                            onClick={(e) => {
                                                e.preventDefault()
                                                item.action()
                                            }}
                                            className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${isSelected
                                                ? 'bg-primary/10 text-primary'
                                                : 'text-foreground hover:bg-accent/50'
                                                }`}
                                        >
                                            <span
                                                className={`flex-shrink-0 ${isSelected ? 'text-primary' : 'text-muted-foreground'}`}
                                            >
                                                {item.icon}
                                            </span>
                                            <div className="flex-1 min-w-0">
                                                <div className="text-sm font-medium truncate">{item.label}</div>
                                                {item.sublabel && (
                                                    <div className="text-xs text-muted-foreground truncate">
                                                        {item.sublabel}
                                                    </div>
                                                )}
                                            </div>
                                            {isSelected && (
                                                <CornerDownLeft className="h-3.5 w-3.5 text-primary/60 flex-shrink-0" />
                                            )}
                                        </button>
                                    )
                                })}
                            </div>
                        ))}
                    </div>
                </ScrollArea>

                {/* Footer hint */}
                <div className="px-4 py-2 border-t bg-muted/30 flex items-center gap-4 text-[10px] text-muted-foreground">
                    <span className="flex items-center gap-1">
                        <kbd className="px-1 py-0.5 bg-muted border rounded text-[9px]">↑↓</kbd>
                        Navigate
                    </span>
                    <span className="flex items-center gap-1">
                        <kbd className="px-1 py-0.5 bg-muted border rounded text-[9px]">↵</kbd>
                        Select
                    </span>
                    <span className="flex items-center gap-1">
                        <kbd className="px-1 py-0.5 bg-muted border rounded text-[9px]">Esc</kbd>
                        Close
                    </span>
                </div>
            </DialogContent>
        </Dialog>
    )
}
