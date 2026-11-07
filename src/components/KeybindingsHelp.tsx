import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { SquircleOverlay } from '@/components/ui/squircle-overlay'
import { Keyboard, Command, Navigation, MousePointerClick } from 'lucide-react'

interface KeybindingsHelpProps {
    isOpen: boolean
    onClose: () => void
}

const GROUPS = [
    {
        label: 'General',
        icon: Command,
        items: [
            { keys: ['?'], desc: 'Show this help' },
            { keys: ['Ctrl', 'K'], desc: 'Command palette' },
            { keys: ['/'], desc: 'Focus search (Accounts, Addons, Discover, Activity)' },
        ],
    },
    {
        label: 'Navigation',
        icon: Navigation,
        items: [
            { keys: ['G', 'A'], desc: 'Accounts' },
            { keys: ['G', 'S'], desc: 'Saved Addons' },
            { keys: ['G', 'H'], desc: 'Activity' },
            { keys: ['G', 'M'], desc: 'Metrics' },
            { keys: ['G', 'N'], desc: 'Notes' },
            { keys: ['G', 'V'], desc: 'Vault' },
            { keys: ['G', 'P'], desc: 'Settings' },
            { keys: ['G', 'R'], desc: 'Replay' },
            { keys: ['G', 'F'], desc: 'Docs' },
        ],
    },
    {
        label: 'Actions',
        icon: MousePointerClick,
        items: [
            { keys: ['Ctrl', 'A'], desc: 'Select all' },
            { keys: ['S'], desc: 'Save selected to library' },
            { keys: ['Ctrl', 'N'], desc: 'New note' },
            { keys: ['Esc'], desc: 'Close / deselect' },
        ],
    },
    {
        label: 'Note Editor',
        icon: Keyboard,
        items: [
            { keys: ['Ctrl', 'B'], desc: 'Bold' },
            { keys: ['Ctrl', 'I'], desc: 'Italic' },
            { keys: ['Ctrl', 'Z'], desc: 'Undo' },
            { keys: ['Ctrl', 'Y'], desc: 'Redo' },
        ],
    },
]

export function KeybindingsHelp({ isOpen, onClose }: KeybindingsHelpProps) {
    return (
        <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="!gap-0 !p-0 overflow-hidden !max-w-md max-h-[85vh] shadow-[0_24px_64px_hsl(0_0%_0%/0.45)]" hideClose>
                <DialogTitle className="sr-only">Keyboard Shortcuts</DialogTitle>

                <div className="flex items-start gap-3 border-b border-border/40 bg-gradient-to-br from-card to-card/60 px-5 py-4">
                    <div data-theme-part="badge" className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-border/35 bg-muted/25">
                        <SquircleOverlay />
                        <Keyboard className="relative z-10 h-4 w-4 text-muted-foreground" />
                    </div>
                    <div className="flex-1">
                        <h2 className="text-sm font-bold leading-tight">Keyboard Shortcuts</h2>
                        <p className="text-xs text-muted-foreground mt-0.5">Press <kbd data-theme-part="badge" className="rounded border border-border/40 bg-muted/30 px-1 py-0.5 font-mono text-[10px]">?</kbd> anywhere to reopen.</p>
                    </div>
                    <button data-theme-part="button"
                        type="button"
                        onClick={onClose}
                        aria-label="Close"
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border/40 bg-muted/30 text-muted-foreground transition-all hover:bg-muted/60 hover:text-foreground active:scale-95"
                    >
                        <kbd className="text-[10px] font-mono">Esc</kbd>
                    </button>
                </div>

                <div className="overflow-y-auto px-5 py-4 space-y-5">
                    {GROUPS.map(group => {
                        const Icon = group.icon
                        return (
                            <div key={group.label} className="space-y-2">
                                <div className="flex items-center gap-1.5">
                                    <Icon className="h-3 w-3 text-muted-foreground/60" />
                                    <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{group.label}</span>
                                </div>
                                <div className="space-y-1">
                                    {group.items.map(item => (
                                        <div key={item.desc} className="flex items-center justify-between gap-3 rounded-lg px-2 py-1 transition-colors hover:bg-muted/20">
                                            <span className="text-xs text-muted-foreground">{item.desc}</span>
                                            <div className="flex items-center gap-0.5 shrink-0">
                                                {item.keys.map((k, i) => (
                                                    <kbd data-theme-part="badge" key={i} className="rounded-md border border-border/40 bg-muted/30 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-foreground/70 min-w-[20px] text-center">
                                                        {k}
                                                    </kbd>
                                                ))}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )
                    })}
                </div>

                <div className="border-t border-border/30 bg-muted/15 px-5 py-3">
                    <p className="text-[10px] text-center text-muted-foreground/50">Shortcuts are off while typing in a field or a dialog is open.</p>
                </div>
            </DialogContent>
        </Dialog>
    )
}
