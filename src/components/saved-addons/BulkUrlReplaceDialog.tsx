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
import { useUIStore } from '@/store/uiStore'
import { AlertTriangle, Check, Loader2, Wand2, X, ArrowRight } from 'lucide-react'
import { useEffect, useState, useMemo } from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Checkbox } from '@/components/ui/checkbox'
import { cn, normalizeAddonUrl } from '@/lib/utils'
import { SavedAddonIcon } from './SavedAddonIcon'
import {
    formatReplaceRunSummary,
    maskReplaceUrl,
    resolveReplaceDisplayItems,
    summarizeReplaceRun,
} from './url-replace-display'
import type { AddonDescriptor } from '@/types/addon'

function escapeRegExp(s: string) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function replaceAllCaseInsensitive(str: string, find: string, replace: string) {
    return str.replace(new RegExp(escapeRegExp(find), 'gi'), replace)
}

interface BulkUrlReplaceDialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    // When provided, the tool operates on a single account's installed addons and scopes
    // the replacement to that account only (the shared Library is left untouched).
    accountId?: string
    accountAddons?: AddonDescriptor[]
    accountName?: string
}

interface ReplaceSourceEntry {
    key: string
    savedAddonId: string | null
    name: string
    logo?: string
    manifestId: string
    url: string
}

interface ReplaceResult {
    id: string
    savedAddonId: string | null
    name: string
    logo?: string
    manifestId: string
    oldUrl: string
    newUrl: string
    status: 'idle' | 'skipped' | 'running' | 'success' | 'error'
    blockReason?: 'no-change' | 'target-exists' | 'duplicate-target'
    error?: string
}

function getBlockReasonLabel(reason?: ReplaceResult['blockReason']) {
    if (reason === 'no-change') return 'No URL change'
    if (reason === 'target-exists') return 'Already exists'
    if (reason === 'duplicate-target') return 'Same new link'
    return null
}

export function BulkUrlReplaceDialog({ open, onOpenChange, accountId, accountAddons, accountName }: BulkUrlReplaceDialogProps) {
    const library = useAddonStore(s => s.library)
    const isAccountScope = !!accountId
    const isPrivacyModeEnabled = useUIStore(s => s.isPrivacyModeEnabled)
    const privacyLevelUrls = useUIStore(s => s.privacyLevelUrls)
    const urlPrivacyLevel = isPrivacyModeEnabled ? privacyLevelUrls : 0
    const [findText, setFindText] = useState('')
    const [replaceText, setReplaceText] = useState('')
    const [results, setResults] = useState<ReplaceResult[]>([])
    const [isExecuting, setIsExecuting] = useState(false)
    const [showFullUrls, setShowFullUrls] = useState(false)

    // Normalize the two sources (full library vs. a single account's installed addons)
    // into one shape so the preview and run logic stay identical for both modes.
    const sources = useMemo<ReplaceSourceEntry[]>(() => {
        if (isAccountScope) {
            return (accountAddons ?? []).map((addon, index) => ({
                key: `${addon.transportUrl}::${index}`,
                savedAddonId: null,
                name: addon.metadata?.customName || addon.manifest?.name || 'Unknown Addon',
                logo: addon.metadata?.customLogo || addon.manifest?.logo,
                manifestId: addon.manifest?.id || 'unknown',
                url: addon.transportUrl,
            }))
        }
        return Object.values(library).map(addon => ({
            key: addon.id,
            savedAddonId: addon.id,
            name: addon.name,
            logo: addon.metadata?.customLogo || addon.manifest?.logo,
            manifestId: addon.manifest?.id || 'unknown',
            url: addon.installUrl,
        }))
    }, [isAccountScope, accountAddons, library])

    // Calculate dry-run output. This is local-only and does not fetch manifests
    // or mutate accounts until the user runs the replacement.
    const previewItems = useMemo<ReplaceResult[]>(() => {
        if (!findText.trim()) return []
        const rawMatches = sources.filter(source =>
            source.url.toLowerCase().includes(findText.toLowerCase())
        )

        const existingKeysByUrl = new Map<string, string[]>()
        for (const source of sources) {
            const urlKey = normalizeAddonUrl(source.url)
            const keys = existingKeysByUrl.get(urlKey)
            if (keys) keys.push(source.key)
            else existingKeysByUrl.set(urlKey, [source.key])
        }

        const movingKeys = new Set<string>()
        for (const source of rawMatches) {
            const newUrl = replaceAllCaseInsensitive(source.url, findText, replaceText)
            const oldKey = normalizeAddonUrl(source.url)
            const newKey = normalizeAddonUrl(newUrl)
            if (oldKey === newKey) continue
            movingKeys.add(source.key)
        }

        const claimedTargetKeys = new Set<string>()
        return rawMatches.map(source => {
            const newUrl = replaceAllCaseInsensitive(source.url, findText, replaceText)
            const oldKey = normalizeAddonUrl(source.url)
            const newKey = normalizeAddonUrl(newUrl)
            const existingTargetKeys = existingKeysByUrl.get(newKey)?.filter(key => key !== source.key && !movingKeys.has(key)) ?? []

            let blockReason: ReplaceResult['blockReason'] | undefined
            if (oldKey === newKey) {
                blockReason = 'no-change'
            } else if (existingTargetKeys.length > 0) {
                blockReason = 'target-exists'
            } else if (claimedTargetKeys.has(newKey)) {
                blockReason = 'duplicate-target'
            }

            if (oldKey !== newKey && !blockReason) {
                claimedTargetKeys.add(newKey)
            }

            return {
                id: source.key,
                savedAddonId: source.savedAddonId,
                name: source.name,
                logo: source.logo,
                manifestId: source.manifestId,
                oldUrl: source.url,
                newUrl,
                status: blockReason ? 'skipped' : 'idle',
                blockReason,
            }
        })
    }, [sources, findText, replaceText])

    const runnableItems = useMemo(
        () => previewItems.filter(item => !item.blockReason),
        [previewItems]
    )
    const blockedCount = previewItems.length - runnableItems.length
    // After a run starts, keep showing the rows captured when the run began.
    const displayItems = useMemo(
        () => resolveReplaceDisplayItems(results, previewItems),
        [results, previewItems]
    )
    const runSummary = results.length > 0 && !isExecuting ? summarizeReplaceRun(results) : null
    const resultsById = useMemo(
        () => new Map(results.map(result => [result.id, result])),
        [results]
    )

    useEffect(() => {
        if (open) {
            setFindText('')
            setReplaceText('')
            setResults([])
            setIsExecuting(false)
            setShowFullUrls(false)
        }
    }, [open])

    const handleRun = async () => {
        if (runnableItems.length === 0 || isExecuting) return

        setIsExecuting(true)
        setResults(previewItems)

        const addonStore = useAddonStore.getState()

        for (const item of runnableItems) {
            setResults(prev => prev.map(r => r.id === item.id ? { ...r, status: 'running' } : r))

            try {
                // Use the universal replacement logic which handles library, accounts, and rules.
                // In account scope, savedAddonId is null and accountId is set so the change
                // stays scoped to that account and the shared Library is left untouched.
                const result = await addonStore.replaceTransportUrlUniversally(item.savedAddonId, item.oldUrl, item.newUrl, accountId)
                const warning = result.failedAccounts.length
                    ? `Updated locally, but failed to sync ${result.failedAccounts.length} account(s): ${result.failedAccounts.join(', ')}`
                    : undefined

                setResults(prev => prev.map(r => r.id === item.id ? { ...r, status: warning ? 'error' : 'success', error: warning } : r))
            } catch (err) {
                if (import.meta.env.DEV) console.error(`[BulkReplace] Failed for ${item.name}:`, err)
                setResults(prev => prev.map(r => r.id === item.id ? { ...r, status: 'error', error: err instanceof Error ? err.message : 'Replacement failed' } : r))
            }
        }

        setIsExecuting(false)
    }

    const renderUrlWithHighlight = (url: string, fragment: string) => {
        if (!fragment) return url
        const parts = url.split(new RegExp(`(${escapeRegExp(fragment)})`, 'gi'))
        return (
            <span className="break-all font-mono text-xs leading-tight">
                {parts.map((part, i) => (
                    i % 2 === 1 ? (
                        <span key={i} className="bg-primary/20 text-primary font-bold rounded px-0.5 border border-primary/25">
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
                <DialogHeader className="p-6 pb-4">
                    <DialogTitle className="flex items-center gap-2">
                        <Wand2 className="h-5 w-5 text-primary" />
                        Bulk URL Fragment Replace
                    </DialogTitle>
                    <DialogDescription>
                        {isAccountScope
                            ? `Search and replace strings across the addons installed on ${accountName || 'this account'}. Changes apply to this account only; your Library is not changed. Useful for domain migrations or proxy updates.`
                            : 'Search and replace strings across your entire library. Useful for domain migrations or proxy updates.'}
                    </DialogDescription>
                </DialogHeader>

                <div className="flex-1 overflow-hidden flex flex-col">
                    <div className="p-6 space-y-4">
                        <div className="grid grid-cols-2 gap-4">
                            <div className="space-y-2">
                                <Label htmlFor="find" className="text-xs font-medium uppercase text-muted-foreground">Find Fragment</Label>
                                <Input
                                    id="find"
                                    placeholder="e.g. old-domain.com"
                                    value={findText}
                                    onChange={(e) => {
                                        setFindText(e.target.value)
                                        setResults([])
                                    }}
                                    disabled={isExecuting}
                                    className="h-10 font-mono text-sm"
                                />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="replace" className="text-xs font-medium uppercase text-muted-foreground">Replace With</Label>
                                <Input
                                    id="replace"
                                    placeholder="e.g. new-domain.com"
                                    value={replaceText}
                                    onChange={(e) => {
                                        setReplaceText(e.target.value)
                                        setResults([])
                                    }}
                                    disabled={isExecuting}
                                    className="h-10 font-mono text-sm"
                                />
                            </div>
                        </div>


                        <div className="space-y-3 pt-2">
                            <div className="flex items-center justify-between px-1">
                                <h4 className="text-xs font-medium uppercase text-muted-foreground flex items-center gap-2">
                                    {isExecuting ? 'Running Changes' : 'Before You Run This'}
                                    {displayItems.length > 0 && (
                                        <span data-theme-part="badge" className="bg-primary/12 text-primary px-1.5 py-0.5 rounded-full text-xs">
                                            {displayItems.length} matches
                                        </span>
                                    )}
                                    {blockedCount > 0 && (
                                        <span data-theme-part="badge" className="bg-warning/10 text-warning px-1.5 py-0.5 rounded-full text-xs">
                                            {blockedCount} cannot run
                                        </span>
                                    )}
                                </h4>
                                <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                                    <Checkbox
                                        checked={showFullUrls}
                                        onCheckedChange={(checked) => setShowFullUrls(checked === true)}
                                    />
                                    Show full URLs
                                </label>
                            </div>

                            {runSummary && (
                                <p className="px-1 text-xs text-muted-foreground" role="status">
                                    {formatReplaceRunSummary(runSummary)}
                                </p>
                            )}

                            <ScrollArea className="h-[300px] w-full rounded-xl border bg-muted/20">
                                <div className="p-4 space-y-4">
                                    {displayItems.length === 0 ? (
                                        <div className="h-[260px] flex flex-col items-center justify-center text-center space-y-2 opacity-60">
                                            <div className="p-4 rounded-full bg-muted">
                                                <X className="h-8 w-8 text-muted-foreground" />
                                            </div>
                                            <p className="text-sm font-medium">No add-ons match this pattern</p>
                                            <p className="text-xs text-muted-foreground">Enter text in Find to preview matching add-ons.</p>
                                        </div>
                                    ) : (
                                        displayItems.map((item) => {
                                            const executionState = resultsById.get(item.id) ?? item
                                            const blockReasonLabel = getBlockReasonLabel(item.blockReason)
                                            const displayOldUrl = showFullUrls ? item.oldUrl : maskReplaceUrl(item.oldUrl, findText, urlPrivacyLevel)
                                            const displayNewUrl = showFullUrls ? item.newUrl : maskReplaceUrl(item.newUrl, replaceText, urlPrivacyLevel)

                                            return (
                                                <div key={item.id} data-theme-part="addon-card" className={cn(
                                                    "group p-3 rounded-lg border bg-card transition-[transform,opacity,box-shadow] relative overflow-hidden",
                                                    item.blockReason && "border-warning/30 bg-warning/5",
                                                    executionState?.status === 'success' && "border-success/30 bg-success/5",
                                                    executionState?.status === 'error' && "border-destructive/30 bg-destructive/5"
                                                )}>

                                                    <div className="absolute right-3 top-3">
                                                        {executionState?.status === 'running' && <Loader2 className="h-4 w-4 animate-spin text-primary" />}
                                                        {executionState?.status === 'success' && <Check className="h-4 w-4 text-success" />}
                                                        {blockReasonLabel && executionState?.status !== 'success' && executionState?.status !== 'running' && executionState?.status !== 'error' && (
                                                            <div className="flex items-center gap-1.5 text-warning">
                                                                <span className="text-xs font-medium">{blockReasonLabel}</span>
                                                                <AlertTriangle className="h-4 w-4" />
                                                            </div>
                                                        )}
                                                        {executionState?.status === 'error' && (
                                                            <div className="flex items-center gap-2 text-destructive">
                                                                <span className="text-xs font-medium">{executionState.error}</span>
                                                                <X className="h-4 w-4" />
                                                            </div>
                                                        )}
                                                    </div>

                                                    <div className="space-y-3">
                                                        <div className="flex items-center gap-2 pr-24">
                                                            <SavedAddonIcon
                                                                name={item.name}
                                                                logo={item.logo}
                                                                className="h-8 w-8"
                                                                textClassName="text-[11px]"
                                                            />
                                                            <div className="min-w-0">
                                                                <span className="block truncate text-xs font-bold leading-none mb-1">{item.name}</span>
                                                                <span className="block truncate text-xs text-muted-foreground uppercase font-bold tracking-tighter">
                                                                    {item.manifestId}
                                                                </span>
                                                            </div>
                                                        </div>

                                                        <div className="space-y-2 pt-1 border-t border-dashed">
                                                            <div className="flex flex-col gap-1">
                                                                <span className="text-xs font-bold text-muted-foreground uppercase opacity-50">Old URL</span>
                                                                {renderUrlWithHighlight(displayOldUrl, findText)}
                                                            </div>

                                                            <div className="flex justify-center -my-1">
                                                                <ArrowRight className="h-3 w-3 text-muted-foreground/60" />
                                                            </div>

                                                            <div className="flex flex-col gap-1">
                                                                <span className="text-xs font-bold text-primary/70 uppercase">New URL</span>
                                                                <span className="break-all font-mono text-xs leading-tight text-primary/80 italic">
                                                                    {displayNewUrl}
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

                <DialogFooter className="gap-3 px-4 pb-4 pt-0">
                    <Button variant="subtle" onClick={() => onOpenChange(false)} disabled={isExecuting}>
                        {results.some(r => r.status === 'success') ? 'Close' : 'Cancel'}
                    </Button>
                    <Button
                        onClick={handleRun}
                        disabled={runnableItems.length === 0 || isExecuting || !findText.trim()}
                        className="bg-primary hover:bg-primary/90 gap-2"
                    >
                        {isExecuting ? (
                            <>
                                <Loader2 className="h-4 w-4 animate-spin" />
                                Running...
                            </>
                        ) : (
                            <>
                                Run {runnableItems.length} Replacement{runnableItems.length !== 1 ? 's' : ''}
                            </>
                        )}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
