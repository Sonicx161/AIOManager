import { Button } from '@/components/ui/button'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAddonStore } from '@/store/addonStore'
import { Check, Loader2, Wand2, X, ArrowRight } from 'lucide-react'
import { useEffect, useState, useMemo } from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'

interface BulkUrlReplaceDialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
}

interface ReplaceResult {
    id: string
    name: string
    oldUrl: string
    newUrl: string
    status: 'idle' | 'running' | 'success' | 'error'
    error?: string
}

export function BulkUrlReplaceDialog({ open, onOpenChange }: BulkUrlReplaceDialogProps) {
    const library = useAddonStore(s => s.library)
    const [findText, setFindText] = useState('')
    const [replaceText, setReplaceText] = useState('')
    const [results, setResults] = useState<ReplaceResult[]>([])
    const [isExecuting, setIsExecuting] = useState(false)

    // Calculate matches from full library
    const matches = useMemo(() => {
        if (!findText.trim()) return []
        const addons = Object.values(library)
        return addons.filter(addon =>
            addon.installUrl.toLowerCase().includes(findText.toLowerCase())
        )
    }, [library, findText])

    // Reset when opening
    useEffect(() => {
        if (open) {
            setFindText('')
            setReplaceText('')
            setResults([])
            setIsExecuting(false)
        }
    }, [open])

    const handleRun = async () => {
        if (matches.length === 0 || isExecuting) return

        setIsExecuting(true)

        // Initialize results tracking
        const itemsToProcess: ReplaceResult[] = matches.map(addon => ({
            id: addon.id,
            name: addon.name,
            oldUrl: addon.installUrl,
            newUrl: addon.installUrl.replace(new RegExp(findText, 'gi'), replaceText),
            status: 'idle'
        }))
        setResults(itemsToProcess)

        const addonStore = useAddonStore.getState()

        for (let i = 0; i < itemsToProcess.length; i++) {
            const item = itemsToProcess[i]

            // Mark as running
            setResults(prev => prev.map((r, idx) => idx === i ? { ...r, status: 'running' } : r))

            try {
                // Use the universal replacement logic which handles library, accounts, and rules
                await addonStore.replaceTransportUrlUniversally(item.id, item.oldUrl, item.newUrl)

                // Mark success
                setResults(prev => prev.map((r, idx) => idx === i ? { ...r, status: 'success' } : r))
            } catch (err) {
                console.error(`[BulkReplace] Failed for ${item.name}:`, err)
                // Mark error but continue
                setResults(prev => prev.map((r, idx) => idx === i ? { ...r, status: 'error', error: err instanceof Error ? err.message : 'Replacement failed' } : r))
            }
        }

        setIsExecuting(false)
    }

    const renderUrlWithHighlight = (url: string, fragment: string) => {
        if (!fragment) return url
        const parts = url.split(new RegExp(`(${fragment})`, 'gi'))
        return (
            <span className="break-all font-mono text-[10px] leading-tight">
                {parts.map((part, i) => (
                    part.toLowerCase() === fragment.toLowerCase() ? (
                        <span key={i} className="bg-primary/20 text-primary font-bold rounded px-0.5 border border-primary/20">
                            {part}
                        </span>
                    ) : (
                        <span key={i} className="text-muted-foreground">{part}</span>
                    )
                ))}
            </span>
        )
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-2xl max-h-[90vh] flex flex-col p-0 overflow-hidden">
                <DialogHeader className="p-6 pb-4 border-b">
                    <DialogTitle className="flex items-center gap-2">
                        <Wand2 className="h-5 w-5 text-primary" />
                        Bulk URL Fragment Replace
                    </DialogTitle>
                    <DialogDescription>
                        Search and replace strings across your entire library. Useful for domain migrations or proxy updates.
                    </DialogDescription>
                </DialogHeader>

                <div className="flex-1 overflow-hidden flex flex-col">
                    <div className="p-6 space-y-4">
                        <div className="grid grid-cols-2 gap-4">
                            <div className="space-y-2">
                                <Label htmlFor="find" className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Find Fragment</Label>
                                <Input
                                    id="find"
                                    placeholder="e.g. old-domain.com"
                                    value={findText}
                                    onChange={(e) => setFindText(e.target.value)}
                                    disabled={isExecuting}
                                    className="h-10 font-mono text-sm"
                                />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="replace" className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Replace With</Label>
                                <Input
                                    id="replace"
                                    placeholder="e.g. new-domain.com"
                                    value={replaceText}
                                    onChange={(e) => setReplaceText(e.target.value)}
                                    disabled={isExecuting}
                                    className="h-10 font-mono text-sm"
                                />
                            </div>
                        </div>

                        {/* Results / Preview Section */}
                        <div className="space-y-3 pt-2">
                            <div className="flex items-center justify-between px-1">
                                <h4 className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground flex items-center gap-2">
                                    {isExecuting ? 'Processing Changes' : 'Preview Changes'}
                                    {matches.length > 0 && (
                                        <span className="bg-primary/10 text-primary px-1.5 py-0.5 rounded-full text-[9px]">
                                            {matches.length} matches
                                        </span>
                                    )}
                                </h4>
                            </div>

                            <ScrollArea className="h-[300px] w-full rounded-xl border bg-muted/20">
                                <div className="p-4 space-y-4">
                                    {matches.length === 0 ? (
                                        <div className="h-[260px] flex flex-col items-center justify-center text-center space-y-2 opacity-60">
                                            <div className="p-4 rounded-full bg-muted">
                                                <X className="h-8 w-8 text-muted-foreground" />
                                            </div>
                                            <p className="text-sm font-medium">No addons match this pattern</p>
                                            <p className="text-xs text-muted-foreground">Type something in the 'Find' field above to start filtering.</p>
                                        </div>
                                    ) : (
                                        matches.map((item) => {
                                            const executionState = results.find(r => r.id === item.id)
                                            const newUrl = item.installUrl.replace(new RegExp(findText, 'gi'), replaceText)

                                            return (
                                                <div key={item.id} className={cn(
                                                    "group p-3 rounded-lg border bg-card transition-all relative overflow-hidden",
                                                    executionState?.status === 'success' && "border-green-500/30 bg-green-500/5",
                                                    executionState?.status === 'error' && "border-red-500/30 bg-red-500/5"
                                                )}>
                                                    {/* Status Overlay */}
                                                    <div className="absolute right-3 top-3">
                                                        {executionState?.status === 'running' && <Loader2 className="h-4 w-4 animate-spin text-primary" />}
                                                        {executionState?.status === 'success' && <Check className="h-4 w-4 text-green-600" />}
                                                        {executionState?.status === 'error' && (
                                                            <div className="flex items-center gap-2 text-red-600">
                                                                <span className="text-[10px] font-medium">{executionState.error}</span>
                                                                <X className="h-4 w-4" />
                                                            </div>
                                                        )}
                                                    </div>

                                                    <div className="space-y-3">
                                                        <div className="flex flex-col">
                                                            <span className="text-xs font-bold leading-none mb-1">{item.name}</span>
                                                            <span className="text-[9px] text-muted-foreground uppercase font-bold tracking-tighter">
                                                                {item.manifest?.id}
                                                            </span>
                                                        </div>

                                                        <div className="space-y-2 pt-1 border-t border-dashed">
                                                            <div className="flex flex-col gap-1">
                                                                <span className="text-[9px] font-bold text-muted-foreground uppercase opacity-50">Old URL</span>
                                                                {renderUrlWithHighlight(item.installUrl, findText)}
                                                            </div>

                                                            <div className="flex justify-center -my-1">
                                                                <ArrowRight className="h-3 w-3 text-muted-foreground/40" />
                                                            </div>

                                                            <div className="flex flex-col gap-1">
                                                                <span className="text-[9px] font-bold text-primary/70 uppercase">New URL</span>
                                                                <span className="break-all font-mono text-[10px] leading-tight text-primary/80 italic">
                                                                    {newUrl}
                                                                </span>
                                                            </div>
                                                        </div>
                                                    </div>
                                                </div>
                                            )
                                        })
                                    )}
                                </div>
                            </ScrollArea>
                        </div>
                    </div>
                </div>

                <DialogFooter className="p-4 border-t bg-muted/10 gap-2 sm:gap-0">
                    <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isExecuting}>
                        {results.some(r => r.status === 'success') ? 'Close' : 'Cancel'}
                    </Button>
                    <Button
                        onClick={handleRun}
                        disabled={matches.length === 0 || isExecuting || !findText.trim()}
                        className="bg-primary shadow-lg shadow-primary/20 hover:bg-primary/90"
                    >
                        {isExecuting ? (
                            <>
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                Running...
                            </>
                        ) : (
                            <>
                                <Wand2 className="mr-2 h-4 w-4" />
                                Run Replacement
                            </>
                        )}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
