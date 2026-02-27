import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog'
import { Command } from 'lucide-react'

interface KeybindingsHelpProps {
    isOpen: boolean
    onClose: () => void
}

export function KeybindingsHelp({ isOpen, onClose }: KeybindingsHelpProps) {
    const shortcuts = [
        { key: '?', description: 'Show this help menu', group: 'General' },
        { key: 'g a', description: 'Go to Accounts', group: 'Navigation' },
        { key: 'g s', description: 'Go to Saved Addons', group: 'Navigation' },
        { key: 'g h', description: 'Go to Activity (History)', group: 'Navigation' },
        { key: 'g m', description: 'Go to Metrics', group: 'Navigation' },
        { key: 'g p', description: 'Go to Settings (Preferences)', group: 'Navigation' },
        { key: 'g f', description: 'Go to FAQ', group: 'Navigation' },
    ]

    return (
        <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="sm:max-w-[425px] bg-background/95 backdrop-blur-md border-primary/20">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Command className="h-5 w-5 text-primary" />
                        Keyboard Shortcuts
                    </DialogTitle>
                </DialogHeader>
                <div className="space-y-6 py-4">
                    <div className="space-y-4">
                        <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-wider">General</h4>
                        <div className="space-y-2">
                            <div className="flex items-center justify-between text-sm">
                                <span className="text-muted-foreground">{shortcuts[0].description}</span>
                                <div className="flex gap-1">
                                    <kbd className="px-2 py-1 bg-muted rounded border border-border text-xs font-mono">Shift</kbd>
                                    <kbd className="px-2 py-1 bg-muted rounded border border-border text-xs font-mono">?</kbd>
                                </div>
                            </div>
                        </div>
                    </div>
                    <div className="space-y-4">
                        <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Navigation</h4>
                        <div className="space-y-3">
                            {shortcuts.slice(1).map((s) => (
                                <div key={s.key} className="flex items-center justify-between text-sm">
                                    <span className="text-muted-foreground">{s.description}</span>
                                    <div className="flex gap-1">
                                        {s.key.split(' ').map((k) => (
                                            <kbd key={k} className="px-2 py-1 bg-muted rounded border border-border text-xs font-mono">{k}</kbd>
                                        ))}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    )
}
