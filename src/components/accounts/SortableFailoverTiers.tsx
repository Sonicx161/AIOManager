import { memo } from "react"
import type { ReactNode } from "react"
import { AlertTriangle, CircleDot, GripVertical, Star, Trash2 } from "lucide-react"
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { AddonIcon } from "@/components/ui/addon-icon"
import { Tooltip } from "@/components/ui/tooltip"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { AddonDescriptor } from "@/types/addon"
import { normalizeAddonUrlForMatch } from '@/lib/addon-url'
import type { TakenRuleAddon } from '@/lib/autopilot-conflicts'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

interface SortableChainTierProps {
    id: string
    url: string
    idx: number
    isActiveInRule: boolean
    isTier1: boolean
    isFailedOver: boolean
    addonName: string
    addonLogo?: string
    getTierClassName: (active: boolean, tier1: boolean) => string
    warning?: string
    warningDetail?: string
}

export const SortableChainTier = memo(function SortableChainTier({
    id, idx, isActiveInRule, isTier1, isFailedOver,
    addonName, addonLogo, getTierClassName, warning, warningDetail
}: SortableChainTierProps) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
    const style = {
        transform: CSS.Translate.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
        zIndex: isDragging ? 10 : 'auto' as const,
    }

    return (
        <div ref={setNodeRef} style={style} className="flex flex-col">
            <div className={`flex items-center gap-3 py-3 px-4 rounded-xl relative z-10 transition-colors ${warning ? 'flex-wrap sm:flex-nowrap' : ''} ${getTierClassName(isActiveInRule, isTier1)}`}>
                <div
                    {...attributes}
                    {...listeners}
                    className="shrink-0 cursor-grab active:cursor-grabbing text-foreground/60 hover:text-foreground/60 transition-colors"
                    style={{ touchAction: 'none' }}
                >
                    <GripVertical className="w-4 h-4" />
                </div>
                <span className="w-4 shrink-0 text-center text-xs font-semibold tabular-nums text-muted-foreground">{idx + 1}</span>
                <AddonIcon
                    name={addonName}
                    logo={addonLogo}
                    className="h-7 w-7"
                    textClassName="text-xs"
                    imageClassName="p-0.5"
                />
                <span className="font-bold truncate text-sm flex-1">{addonName}</span>
                <div className={`flex items-center gap-2 shrink-0 ${warning ? 'max-sm:w-full max-sm:justify-end' : ''}`}>
                    {warning && <Popover>
                        <PopoverTrigger asChild>
                            <button type="button" className="inline-flex min-h-8 items-center gap-1 rounded-full border border-warning/20 bg-warning/10 px-2 text-xs font-medium text-warning focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`${addonName}: ${warning}`}>
                                <AlertTriangle className="h-3 w-3" aria-hidden="true" />{warning}
                            </button>
                        </PopoverTrigger>
                        <PopoverContent align="end" className="w-[min(18rem,85vw)] p-3 text-xs">{warningDetail || warning}</PopoverContent>
                    </Popover>}
                    {isTier1 && (
                        <Tooltip content="Primary failover addon">
                            <span aria-label="Primary failover addon" className="inline-flex items-center justify-center rounded-full border p-1 border-primary/25 bg-primary/12 text-primary/80">
                                <Star className="h-3 w-3 fill-current" />
                            </span>
                        </Tooltip>
                    )}
                    {isFailedOver && (
                        <Tooltip content="Currently active">
                            <span aria-label="Currently active" className="inline-flex items-center justify-center rounded-full border p-1 border-success/20 bg-success/10 text-success">
                                <CircleDot className="h-3 w-3" />
                            </span>
                        </Tooltip>
                    )}
                </div>
            </div>
        </div>
    )
})

interface SortableDialogTierProps {
    id: number
    index: number
    url: string
    chainLength: number
    localAddons: AddonDescriptor[]
    chain: string[]
    addons: AddonDescriptor[]
    updateChainUrl: (index: number, url: string) => void
    removeFromChain: (index: number) => void
    takenAddons?: ReadonlyMap<string, TakenRuleAddon>
    getAddonNameForUrl?: (url: string) => string
}

export const SortableDialogTier = memo(function SortableDialogTier({
    id, index, url, chainLength, localAddons, chain, addons,
    updateChainUrl, removeFromChain, takenAddons, getAddonNameForUrl
}: SortableDialogTierProps) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
    const style = {
        transform: CSS.Translate.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
        zIndex: isDragging ? 10 : 'auto' as const,
    }
    const overlap = takenAddons?.get(normalizeAddonUrlForMatch(url))
    return (
        <div ref={setNodeRef} style={style} data-theme-part="panel" className={`bg-muted/30 border rounded-2xl px-4 py-3 flex flex-col gap-1.5 ${overlap ? 'border-warning/30' : 'border-border/40'}`}>
            <div className="flex items-center justify-between">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <div
                        {...attributes}
                        {...listeners}
                        className="shrink-0 cursor-grab active:cursor-grabbing text-foreground/40 hover:text-foreground/60 transition-colors"
                        style={{ touchAction: 'none' }}
                    >
                        <GripVertical className="w-4 h-4" />
                    </div>
                    <span className="font-mono text-xs font-medium text-muted-foreground uppercase">TIER {index + 1}</span>
                    {overlap && <span className="max-w-full truncate rounded-full border border-warning/20 bg-warning/10 px-2 py-0.5 text-xs text-warning">Also in rule {overlap.ruleName}</span>}
                </div>
                <button
                    data-theme-part="button"
                    className="text-foreground/60 hover:text-destructive transition-colors disabled:opacity-30 disabled:hover:text-foreground/60"
                    onClick={() => removeFromChain(index)}
                    disabled={chainLength <= 2}
                    aria-label="Remove tier"
                >
                    <Trash2 className="w-3.5 h-3.5" />
                </button>
            </div>
            <Select value={url} onValueChange={(val) => updateChainUrl(index, val)}>
                <SelectTrigger className="w-full bg-transparent border-0 p-0 h-8 hover:bg-transparent focus:ring-0 shadow-none text-base font-medium focus-visible:ring-0">
                    <SelectValue placeholder={`Select Tier ${index + 1} addon...`}>
                        {(() => {
                            const selectedAddon = addons.find(a => a.transportUrl === url)
                            if (!selectedAddon) return null
                            return (
                                <div className="flex items-center gap-2">
                                    <AddonIcon
                                        name={selectedAddon.metadata?.customName || selectedAddon.manifest.name}
                                        logo={selectedAddon.metadata?.customLogo || selectedAddon.manifest.logo}
                                        className="h-5 w-5"
                                        textClassName="text-xs"
                                        imageClassName="p-0.5"
                                    />
                                    <span className="truncate">{getAddonNameForUrl?.(selectedAddon.transportUrl) || selectedAddon.metadata?.customName || selectedAddon.manifest.name}</span>
                                </div>
                            )
                        })()}
                    </SelectValue>
                </SelectTrigger>
                <SelectContent>
                    {localAddons
                        .filter(addon => !chain.some((u, i) => i !== index && u === addon.transportUrl))
                        .map(addon => (
                        <SelectItem key={addon.transportUrl} value={addon.transportUrl} disabled={takenAddons?.has(normalizeAddonUrlForMatch(addon.transportUrl))} className={takenAddons?.has(normalizeAddonUrlForMatch(addon.transportUrl)) ? 'text-muted-foreground/50' : undefined}>
                            <div className="flex items-center gap-2">
                                <AddonIcon
                                    name={addon.metadata?.customName || addon.manifest.name}
                                    logo={addon.metadata?.customLogo || addon.manifest.logo}
                                    className="h-5 w-5"
                                    textClassName="text-xs"
                                    imageClassName="p-0.5"
                                />
                                <span>{getAddonNameForUrl?.(addon.transportUrl) || addon.metadata?.customName || addon.manifest.name}</span>
                                {takenAddons?.get(normalizeAddonUrlForMatch(addon.transportUrl)) && <span className="ml-auto pl-3 text-xs text-muted-foreground">In rule {takenAddons.get(normalizeAddonUrlForMatch(addon.transportUrl))!.ruleName}</span>}
                            </div>
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
            {overlap && <p className="text-xs text-warning">Remove {getAddonNameForUrl?.(url) || 'this addon'} from this rule or from {overlap.ruleName}.</p>}
        </div>
    )
})

export const SortableRuleWrapper = memo(function SortableRuleWrapper({
    id, draggable = true, children,
}: {
    id: string
    draggable?: boolean
    children: ReactNode
}) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, disabled: !draggable })
    const style = {
        transform: CSS.Translate.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
        zIndex: isDragging ? 10 : 'auto' as const,
    }
    return (
        <div ref={setNodeRef} style={style} className="relative min-w-0">
            {draggable && <div
                {...attributes}
                {...listeners}
                className="absolute left-0 top-7 cursor-grab active:cursor-grabbing text-foreground/30 hover:text-foreground/60 transition-colors z-20 px-0.5"
                style={{ touchAction: 'none' }}
            >
                <GripVertical className="w-4 h-4" />
            </div>}
            {children}
        </div>
    )
})
