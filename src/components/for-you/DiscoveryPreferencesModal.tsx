import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { X, LayoutGrid, SlidersHorizontal, RotateCcw } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
    useRailSize,
    setRailSize,
    setAccountRailSize,
} from '@/lib/discovery-prefs-store'
import { useAccountStore } from '@/store/accountStore'
import { useMaskedAccountLabel } from '@/hooks/useMaskedAccountLabel'
import { useDiscoveryStore, useDiscoveryPrefs, useHouseholdSettings, HOUSEHOLD_CONTEXT } from '@/store/discoveryStore'

const SHELF_SIZE_OPTIONS = [10, 20, 30, 40, 50, 75, 100]
const DEFAULT_RAIL_SIZE = 20

const COMMON_GENRES = ['Action', 'Adventure', 'Animation', 'Comedy', 'Crime', 'Documentary', 'Drama', 'Family', 'Fantasy', 'History', 'Horror', 'Music', 'Mystery', 'Romance', 'Science Fiction', 'Thriller', 'War', 'Western']

const OBSCURITY_OPTIONS: { value: 'popular' | 'balanced' | 'hidden' | 'gems' | 'all'; label: string; desc: string }[] = [
    { value: 'popular', label: 'Popular', desc: 'Blockbusters and crowd-pleasers' },
    { value: 'balanced', label: 'Balanced', desc: 'Mix of mainstream and niche' },
    { value: 'hidden', label: 'Hidden Gems', desc: 'Under-the-radar discoveries' },
    { value: 'gems', label: 'Deep Cuts', desc: 'Truly obscure finds' },
    { value: 'all', label: 'Everything', desc: 'No obscurity filter' },
]

const TYPE_OPTIONS: { value: 'both' | 'movies' | 'series'; label: string }[] = [
    { value: 'both', label: 'Both' },
    { value: 'movies', label: 'Movies' },
    { value: 'series', label: 'Series' },
]

const MERGE_OPTIONS: { value: 'union' | 'intersection'; label: string; desc: string }[] = [
    { value: 'union', label: 'Union', desc: 'Combine all tastes broadly' },
    { value: 'intersection', label: 'Intersection', desc: 'Only shared tastes' },
]

const DECADES = [
    { label: '1990s', from: 1990, to: 1999 },
    { label: '2000s', from: 2000, to: 2009 },
    { label: '2010s', from: 2010, to: 2019 },
    { label: '2020s', from: 2020, to: 2029 },
]

interface DiscoveryPreferencesModalProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    accountId?: string
}

export function DiscoveryPreferencesModal({ open, onOpenChange, accountId }: DiscoveryPreferencesModalProps) {
    const isAccountMode = Boolean(accountId)
    const globalSize = useRailSize()
    const accountSize = useRailSize(accountId)
    const hasOverride = isAccountMode && accountSize !== globalSize
    const activeSize = isAccountMode ? accountSize : globalSize
    const accounts = useAccountStore(s => s.accounts)
    const maskedLabel = useMaskedAccountLabel()
    const accountName = (() => {
        if (!accountId) return ''
        const acc = accounts.find(a => a.id === accountId)
        return acc ? maskedLabel(acc) : 'Account'
    })()

    const ctx = accountId || HOUSEHOLD_CONTEXT
    const _prefs = useDiscoveryPrefs(ctx)
    const _store = useDiscoveryStore()
    const _household = useHouseholdSettings()
    const discoveryPrefs = {
        ..._prefs,
        enabledAccounts: _household.enabledAccounts,
        mergeMode: _household.mergeMode,
        setObscurity: (v: typeof _prefs.obscurity) => _store.setObscurity(ctx, v),
        setMinRating: (v: number) => _store.setMinRating(ctx, v),
        setEraRange: (from: number, to: number) => _store.setEraRange(ctx, from, to),
        setTypeMix: (v: typeof _prefs.typeMix) => _store.setTypeMix(ctx, v),
        setGenreBoost: (genre: string, mult: number) => _store.setGenreBoost(ctx, genre, mult),
        removeGenreBoost: (genre: string) => _store.removeGenreBoost(ctx, genre),
        toggleExcludedGenre: (genre: string) => _store.toggleExcludedGenre(ctx, genre),
        dismissItem: (id: string) => _store.dismissItem(ctx, id),
        undismissItem: (id: string) => _store.undismissItem(ctx, id),
        loveItem: (id: string) => _store.loveItem(ctx, id),
        unloveItem: (id: string) => _store.unloveItem(ctx, id),
        resetToDefaults: () => _store.resetContext(ctx),
        setEnabledAccounts: _store.setEnabledAccounts,
        setMergeMode: _store.setMergeMode,
    }
    const activeDecade = DECADES.find(d => d.from === discoveryPrefs.eraRange.from && d.to === discoveryPrefs.eraRange.to)

    const genreState = (genre: string): 'default' | 'boost' | 'strong' | 'suppress' | 'excluded' => {
        if (discoveryPrefs.excludedGenres.includes(genre)) return 'excluded'
        const mult = discoveryPrefs.genreBoosts[genre]
        if (!mult) return 'default'
        if (mult >= 2) return 'strong'
        if (mult > 1) return 'boost'
        return 'suppress'
    }

    const cycleGenre = (genre: string) => {
        const state = genreState(genre)
        if (state === 'default') {
            discoveryPrefs.setGenreBoost(genre, 1.5)
        } else if (state === 'boost') {
            discoveryPrefs.setGenreBoost(genre, 2.0)
        } else if (state === 'strong') {
            discoveryPrefs.setGenreBoost(genre, 0.3)
        } else if (state === 'suppress') {
            discoveryPrefs.removeGenreBoost(genre)
            discoveryPrefs.toggleExcludedGenre(genre)
        } else {
            discoveryPrefs.toggleExcludedGenre(genre)
        }
    }

    const handleResetAll = () => {
        discoveryPrefs.resetToDefaults()
        if (accountId) setAccountRailSize(accountId, null)
        else setRailSize(DEFAULT_RAIL_SIZE)
    }

    const applySize = (size: number) => {
        if (isAccountMode && accountId) setAccountRailSize(accountId, size)
        else setRailSize(size)
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent
                className={cn(
                    '!gap-0 !p-0 flex flex-col overflow-hidden',
                    '!max-w-3xl !max-h-[88vh]',
                    'shadow-[0_24px_64px_hsl(0_0%_0%/0.45)]',
                )}
                hideClose
            >
                <DialogTitle className="sr-only">Discovery Preferences</DialogTitle>

                <div className="flex items-start justify-between gap-4 border-b border-border/40 bg-gradient-to-br from-card to-card/60 px-5 py-5 sm:px-7">
                    <div className="min-w-0">
                        <div className="flex items-center gap-2.5">
                            <span data-theme-part="badge" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-border/40 bg-muted/40 text-primary">
                                <LayoutGrid className="h-4 w-4" />
                            </span>
                            <div className="min-w-0">
                                <h2 className="text-base font-bold leading-tight tracking-tight text-foreground">
                                    Discovery Preferences
                                </h2>
                                <p className="mt-0.5 text-xs text-muted-foreground">
                                    {isAccountMode
                                        ? <>Managing: <span className="font-semibold text-foreground/90">{accountName}</span></>
                                        : <>Managing: <span className="font-semibold text-foreground/90">Unified Catalog</span></>}
                                </p>
                            </div>
                        </div>
                    </div>
                    <button
                        type="button"
                        data-theme-part="button"
                        onClick={() => onOpenChange(false)}
                        aria-label="Close"
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border/40 bg-muted/30 text-muted-foreground transition-all hover:bg-muted/60 hover:text-foreground active:scale-95"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                <div className="space-y-7 overflow-y-auto px-5 py-6 sm:px-7">
                    <section className="space-y-4">
                        <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0">
                                <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                                    Display
                                </h3>
                            </div>
                            <span data-theme-part="badge" className="shrink-0 rounded-full border border-border/40 bg-muted/30 px-2.5 py-0.5 text-xs font-bold tabular-nums text-foreground">
                                {activeSize}
                            </span>
                        </div>

                        <div data-theme-part="panel" className="rounded-2xl border border-border/40 bg-muted/15 p-3 space-y-2">
                            <div className="flex items-center justify-between gap-2">
                                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                    Shelf Size
                                </span>
                                <span className="text-[11px] text-muted-foreground/70">items per row</span>
                            </div>
                            <div className="grid grid-cols-5 gap-1.5">
                                {SHELF_SIZE_OPTIONS.map(size => (
                                    <button
                                        key={size}
                                        type="button"
                                        data-theme-part="tab"
                                        data-state={activeSize === size ? 'active' : 'inactive'}
                                        onClick={() => applySize(size)}
                                        className={cn(
                                            'rounded-lg border py-2 text-sm font-semibold tabular-nums transition-colors',
                                            activeSize === size
                                                ? 'border-primary/50 bg-primary/10 text-primary'
                                                : 'border-border/40 bg-muted/20 text-muted-foreground hover:bg-muted/40 hover:text-foreground',
                                        )}
                                    >
                                        {size}
                                    </button>
                                ))}
                            </div>
                            {isAccountMode && (
                                <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground/80">
                                    <SlidersHorizontal className="h-3 w-3 shrink-0" />
                                    {hasOverride
                                        ? `Override for ${accountName} (${accountSize}). Global default is ${globalSize}.`
                                        : `Using global default of ${globalSize} for ${accountName}.`}
                                </p>
                            )}
                        </div>
                    </section>

                    <div className="border-t border-border/30" />

                    <section className="space-y-4">
                        <div>
                            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                                Content Mix
                            </h3>
                            <p className="mt-1 text-xs text-muted-foreground/70">
                                Tune what kind of content surfaces in your recommendations
                            </p>
                        </div>

                        <div className="space-y-2">
                            <span className="text-xs font-medium text-muted-foreground">Obscurity</span>
                            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                                {OBSCURITY_OPTIONS.map(opt => (
                                    <button
                                        key={opt.value}
                                        type="button"
                                        data-theme-part="tab"
                                        data-state={discoveryPrefs.obscurity === opt.value ? 'active' : 'inactive'}
                                        onClick={() => discoveryPrefs.setObscurity(opt.value)}
                                        className={cn(
                                            'rounded-lg border px-3 py-2 text-left text-xs transition-colors',
                                            discoveryPrefs.obscurity === opt.value
                                                ? 'border-primary/50 bg-primary/10 text-foreground'
                                                : 'border-border/40 bg-muted/20 text-muted-foreground hover:bg-muted/40 hover:text-foreground',
                                        )}
                                    >
                                        <span className="block font-semibold">{opt.label}</span>
                                        <span className="mt-0.5 block text-[10px] text-muted-foreground/70">{opt.desc}</span>
                                    </button>
                                ))}
                            </div>
                        </div>

                        <div className="space-y-2">
                            <span className="text-xs font-medium text-muted-foreground">Content Type</span>
                            <div className="flex gap-1.5">
                                {TYPE_OPTIONS.map(opt => (
                                    <button
                                        key={opt.value}
                                        type="button"
                                        data-theme-part="tab"
                                        data-state={discoveryPrefs.typeMix === opt.value ? 'active' : 'inactive'}
                                        onClick={() => discoveryPrefs.setTypeMix(opt.value)}
                                        className={cn(
                                            'flex-1 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors',
                                            discoveryPrefs.typeMix === opt.value
                                                ? 'border-primary/50 bg-primary/10 text-primary'
                                                : 'border-border/40 bg-muted/20 text-muted-foreground hover:bg-muted/40 hover:text-foreground',
                                        )}
                                    >
                                        {opt.label}
                                    </button>
                                ))}
                            </div>
                        </div>

                        <div className="space-y-2">
                            <div className="flex items-center justify-between">
                                <span className="text-xs font-medium text-muted-foreground">Minimum Rating</span>
                                <span data-theme-part="badge" className="rounded-full border border-border/40 bg-muted/30 px-2 py-0.5 text-[11px] font-bold tabular-nums text-foreground">
                                    {discoveryPrefs.minRating.toFixed(1)}+
                                </span>
                            </div>
                            <input data-theme-part="slider"
                                type="range"
                                min={0}
                                max={10}
                                step={0.5}
                                value={discoveryPrefs.minRating}
                                onChange={(e) => discoveryPrefs.setMinRating(parseFloat(e.target.value))}
                                className="w-full accent-primary"
                            />
                        </div>

                        <div className="space-y-2">
                            <span className="text-xs font-medium text-muted-foreground">Era</span>
                            <div className="flex flex-wrap gap-1">
                                <button
                                    type="button"
                                    data-theme-part="tab"
                                    data-state={!activeDecade ? 'active' : 'inactive'}
                                    onClick={() => discoveryPrefs.setEraRange(1990, new Date().getFullYear())}
                                    className={cn(
                                        'rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
                                        !activeDecade
                                            ? 'border-primary/50 bg-primary/10 text-primary'
                                            : 'border-border/40 bg-muted/20 text-muted-foreground hover:bg-muted/40 hover:text-foreground',
                                    )}
                                >
                                    All eras
                                </button>
                                {DECADES.map(d => (
                                    <button
                                        key={d.label}
                                        type="button"
                                        data-theme-part="tab"
                                        data-state={activeDecade?.label === d.label ? 'active' : 'inactive'}
                                        onClick={() => discoveryPrefs.setEraRange(d.from, d.to)}
                                        className={cn(
                                            'rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
                                            activeDecade?.label === d.label
                                                ? 'border-primary/50 bg-primary/10 text-primary'
                                                : 'border-border/40 bg-muted/20 text-muted-foreground hover:bg-muted/40 hover:text-foreground',
                                        )}
                                    >
                                        {d.label}
                                    </button>
                                ))}
                            </div>
                        </div>
                    </section>

                    <div className="border-t border-border/30" />

                    <section className="space-y-3">
                        <div>
                            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                                Genre Preferences
                            </h3>
                            <p className="mt-1 text-xs text-muted-foreground/70">
                                Tap to cycle: Boost 1.5x, Strong 2x, Suppress 0.3x, Exclude
                            </p>
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                            {COMMON_GENRES.map(genre => {
                                const state = genreState(genre)
                                const mult = discoveryPrefs.genreBoosts[genre]
                                return (
                                    <button
                                        key={genre}
                                        data-theme-part="badge"
                                        data-state={state}
                                        type="button"
                                        onClick={() => cycleGenre(genre)}
                                        className={cn(
                                            'rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors',
                                            state === 'default' && 'border-border/40 bg-muted/20 text-muted-foreground hover:bg-muted/40 hover:text-foreground',
                                            state === 'boost' && 'border-success/40 bg-success/10 text-success',
                                            state === 'strong' && 'border-success/60 bg-success/20 text-success font-bold',
                                            state === 'suppress' && 'border-warning/40 bg-warning/10 text-warning',
                                            state === 'excluded' && 'border-destructive/40 bg-destructive/10 text-destructive line-through',
                                        )}
                                    >
                                        {state === 'excluded' || !mult ? genre : `${genre} \u00d7${mult.toFixed(1)}`}
                                    </button>
                                )
                            })}
                        </div>
                    </section>

                    {accounts.length > 1 && !accountId && (
                        <>
                            <div className="border-t border-border/30" />
                            <section className="space-y-3">
                                <div>
                                    <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                                        Accounts
                                    </h3>
                                    <p className="mt-1 text-xs text-muted-foreground/70">
                                        Which accounts contribute to recommendations
                                    </p>
                                </div>
                                <div className="space-y-1.5">
                                    <button
                                        type="button"
                                        data-theme-part="tab"
                                        data-state={discoveryPrefs.enabledAccounts === 'all' ? 'active' : 'inactive'}
                                        onClick={() => discoveryPrefs.setEnabledAccounts('all')}
                                        className={cn(
                                            'flex w-full items-center justify-between rounded-xl border px-3 py-2 text-xs transition-colors',
                                            discoveryPrefs.enabledAccounts === 'all'
                                                ? 'border-primary/50 bg-primary/10'
                                                : 'border-border/40 bg-muted/20 hover:bg-muted/40',
                                        )}
                                    >
                                        <span className="font-medium text-foreground">All accounts</span>
                                        <span className="text-muted-foreground">{accounts.length}</span>
                                    </button>
                                    {accounts.map(acc => {
                                        const enabled = discoveryPrefs.enabledAccounts === 'all' || (Array.isArray(discoveryPrefs.enabledAccounts) && discoveryPrefs.enabledAccounts.includes(acc.id))
                                        return (
                                            <button
                                                key={acc.id}
                                                data-theme-part="button"
                                                data-state={enabled ? 'active' : 'inactive'}
                                                aria-pressed={enabled}
                                                type="button"
                                                onClick={() => {
                                                    if (discoveryPrefs.enabledAccounts === 'all') {
                                                        discoveryPrefs.setEnabledAccounts(accounts.filter(a => a.id !== acc.id).map(a => a.id))
                                                    } else if (Array.isArray(discoveryPrefs.enabledAccounts)) {
                                                        discoveryPrefs.setEnabledAccounts(enabled ? discoveryPrefs.enabledAccounts.filter(id => id !== acc.id) : [...discoveryPrefs.enabledAccounts, acc.id])
                                                    }
                                                }}
                                                className={cn(
                                                    'flex w-full items-center justify-between rounded-xl border px-3 py-2 text-xs transition-colors',
                                                    enabled ? 'border-border/40 bg-muted/20' : 'border-border/25 opacity-50',
                                                )}
                                            >
                                                <span className="font-medium text-foreground">{maskedLabel(acc)}</span>
                                                <span className={cn('h-2 w-2 rounded-full', enabled ? 'bg-success' : 'bg-muted-foreground/30')} />
                                            </button>
                                        )
                                    })}
                                </div>
                                <div className="flex gap-1.5">
                                    {MERGE_OPTIONS.map(opt => (
                                        <button
                                            key={opt.value}
                                            type="button"
                                            data-theme-part="tab"
                                            data-state={discoveryPrefs.mergeMode === opt.value ? 'active' : 'inactive'}
                                            onClick={() => discoveryPrefs.setMergeMode(opt.value)}
                                            className={cn(
                                                'flex-1 rounded-lg border px-2 py-1.5 text-left text-xs transition-colors',
                                                discoveryPrefs.mergeMode === opt.value
                                                    ? 'border-primary/50 bg-primary/10'
                                                    : 'border-border/40 bg-muted/20 hover:bg-muted/40',
                                            )}
                                        >
                                            <span className="block font-medium text-foreground">{opt.label}</span>
                                            <span className="mt-0.5 block text-[10px] text-muted-foreground/70">{opt.desc}</span>
                                        </button>
                                    ))}
                                </div>
                            </section>
                        </>
                    )}

                    {isAccountMode && accountId && (
                        <>
                            <div className="border-t border-border/30" />
                            <section className="space-y-3">
                                <div>
                                    <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                                        Account Override
                                    </h3>
                                    <p className="mt-1 text-xs text-muted-foreground/70">
                                        Manage this account's row size preference
                                    </p>
                                </div>
                                <div data-theme-part="panel" className="flex items-center justify-between gap-3 rounded-xl border border-border/40 bg-muted/20 px-3 py-2.5">
                                    <div className="min-w-0">
                                        <p className="text-sm font-medium text-foreground">
                                            {hasOverride
                                                ? `Custom size: ${accountSize} items`
                                                : `Using global default: ${globalSize} items`}
                                        </p>
                                        <p className="mt-0.5 text-[11px] text-muted-foreground/70">
                                            {hasOverride
                                                ? `Global default is ${globalSize} items`
                                                : 'No override applied'}
                                        </p>
                                    </div>
                                    {hasOverride && (
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className="h-8 shrink-0 gap-1.5 text-xs"
                                            onClick={() => setAccountRailSize(accountId, null)}
                                        >
                                            <RotateCcw className="h-3.5 w-3.5" />
                                            Reset
                                        </Button>
                                    )}
                                </div>
                            </section>
                        </>
                    )}
                </div>

                <div data-theme-part="toolbar" className="flex items-center justify-between gap-2 border-t border-border/40 bg-muted/15 px-5 py-4 sm:px-7">
                    <Button
                        variant="ghost"
                        size="sm"
                        className="h-9 gap-1.5 text-xs"
                        onClick={handleResetAll}
                    >
                        <RotateCcw className="h-3.5 w-3.5" />
                        Reset to defaults
                    </Button>
                    <Button
                        size="sm"
                        className="h-9 gap-1.5 px-5 text-xs font-semibold"
                        onClick={() => onOpenChange(false)}
                    >
                        Done
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    )
}
