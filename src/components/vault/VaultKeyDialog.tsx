import { useState, useEffect, useMemo, useRef } from 'react'
import { useVaultStore } from '@/store/vaultStore'
import { useProviderStore } from '@/store/providerStore'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogTitle,
    DialogBack,
    DialogAltHistory,
    useDrillHistory,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import {
    Eye, EyeOff, ExternalLink, Info, Search, X, ChevronLeft, ChevronRight,
    Cloud, Layers, Cable, Database, Magnet, Type, Activity, Sparkles, ShieldCheck, Wrench,
} from 'lucide-react'
import { PROVIDERS, deriveGroup, getKeyAbbr, resolveVaultGroup, VAULT_GROUPS } from '@/lib/constants'
import { PROVIDER_REGISTRY, registryForKey, RegistryProvider } from '@/lib/provider-registry'
import { toast } from '@/hooks/use-toast'
import { VaultKey } from '@/types/vault'
import { cn, getTimeAgo } from '@/lib/utils'
import { providerAbbr, expiryDateError } from '@/components/vault/vault-key-fields'
import { ExpiryState, expiryLabel, firstMissingField, maskedKeyDisplay, resolveExpiry, statusLine } from '@/components/vault/vault-key-sheet'

interface VaultKeyDialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    editingKey?: VaultKey | null
    defaultGroup?: string
}

const CATEGORY_ICONS: Record<string, typeof Cloud> = {
    'Debrid Services': Cloud,
    'AIOStreams': Layers,
    'Usenet Providers': Cable,
    'Usenet Indexers': Database,
    'Torrent Indexers': Magnet,
    'Subtitles': Type,
    'Metadata & Trackers': Activity,
    'AI Services': Sparkles,
    'VPN': ShieldCheck,
    'Custom': Wrench,
}

// Mirrors VaultPage's group colors so the picker speaks the same category language as the vault.
const CATEGORY_COLOR: Record<string, { text: string; bg: string }> = {
    'Debrid Services': { text: 'text-primary', bg: 'bg-primary/12' },
    'AIOStreams': { text: 'text-info', bg: 'bg-info/10' },
    'Usenet Providers': { text: 'text-info', bg: 'bg-info/10' },
    'Usenet Indexers': { text: 'text-success', bg: 'bg-success/10' },
    'Torrent Indexers': { text: 'text-success', bg: 'bg-success/10' },
    'Subtitles': { text: 'text-warning', bg: 'bg-warning/10' },
    'Metadata & Trackers': { text: 'text-warning', bg: 'bg-warning/10' },
    'AI Services': { text: 'text-info', bg: 'bg-info/10' },
    'VPN': { text: 'text-primary', bg: 'bg-primary/12' },
    'Custom': { text: 'text-muted-foreground', bg: 'bg-muted/30' },
}

function tint(group: string) {
    return CATEGORY_COLOR[group] || CATEGORY_COLOR.Custom
}

function ProviderButton({ p, onSelect }: { p: RegistryProvider; onSelect: (p: RegistryProvider) => void }) {
    const c = tint(p.group)
    return (
        <button data-theme-part="button"
            type="button"
            onClick={() => onSelect(p)}
            className="flex items-center gap-3 rounded-xl border border-border/40 bg-muted/10 px-3 py-3 text-left transition-colors hover:border-border/70 hover:bg-muted/25"
        >
            <span data-theme-part="badge" className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border/40 text-xs font-bold ${c.bg} ${c.text}`}>
                {providerAbbr(p.name)}
            </span>
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{p.name}</span>
        </button>
    )
}

const GROUP_ORDER = ['AIOStreams', ...VAULT_GROUPS]

type SheetPage = 'root' | 'key' | 'expiry' | 'dashboard' | 'setup' | 'provider' | 'badge'

const PAGE_TITLES: Record<Exclude<SheetPage, 'root'>, string> = {
    key: 'Key',
    expiry: 'Expiry',
    dashboard: 'Dashboard',
    setup: 'Setup guide',
    provider: 'Provider and group',
    badge: 'Header badge',
}

const EXPIRY_TONE: Record<ExpiryState, 'good' | 'warn' | 'bad'> = {
    active: 'good',
    expiring: 'warn',
    expired: 'bad',
    error: 'bad',
}

const HEALTH_LABEL: Record<'active' | 'expired' | 'error', string> = {
    active: 'Active',
    expired: 'Expired',
    error: 'Error',
}

const ROW_TONE: Record<'good' | 'warn' | 'bad', string> = {
    good: 'text-success',
    warn: 'text-warning',
    bad: 'text-destructive',
}

const PILL = 'flex h-8 shrink-0 items-center rounded-full border px-3 text-xs font-semibold transition-colors'
const PILL_IDLE = 'border-border/30 bg-muted/40 text-muted-foreground hover:text-foreground'

function formatExpiryDate(iso: string): string {
    const calendar = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
    if (calendar) {
        const utc = new Date(Date.UTC(Number(calendar[1]), Number(calendar[2]) - 1, Number(calendar[3])))
        return utc.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })
    }
    return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function SheetGroup({ children }: { children: React.ReactNode }) {
    return (
        <div data-theme-part="panel" className="divide-y divide-border/30 overflow-hidden rounded-2xl border border-border/40 bg-muted/10">
            {children}
        </div>
    )
}

function SheetRow({ label, sub, value, tone, onClick }: {
    label: string
    sub?: string
    value?: React.ReactNode
    tone?: 'good' | 'warn' | 'bad'
    onClick?: () => void
}) {
    const content = (
        <>
            <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold">{label}</span>
                {sub && <span className="block truncate text-xs text-muted-foreground">{sub}</span>}
            </span>
            {value != null && value !== '' && (
                <span className={cn('min-w-0 max-w-[45%] truncate text-xs', tone ? ROW_TONE[tone] : 'text-muted-foreground')}>
                    {value}
                </span>
            )}
            {onClick && <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
        </>
    )
    if (!onClick) {
        return <div className="flex min-h-[44px] items-center gap-3 px-4 py-2">{content}</div>
    }
    return (
        <button type="button" onClick={onClick} className="flex min-h-[44px] w-full items-center gap-3 px-4 py-2 text-left transition-colors hover:bg-muted/30">
            {content}
        </button>
    )
}

export function VaultKeyDialog({ open, onOpenChange, editingKey, defaultGroup }: VaultKeyDialogProps) {
    const addKey = useVaultStore(s => s.addKey)
    const updateKey = useVaultStore(s => s.updateKey)
    const loading = useVaultStore(s => s.loading)
    const health = useProviderStore(s => (editingKey ? s.health[editingKey.id] : undefined))

    const [selected, setSelected] = useState<RegistryProvider | null>(null)
    const sheetRef = useRef<HTMLDivElement>(null)
    // Page history with the shared back/forward model: Escape and the visible Back
    // pop one level, forward restores it, and transitions refocus the sheet.
    const { page, canForward, go: goToPage, back, goForward, reset } = useDrillHistory<SheetPage>('root', { containerRef: sheetRef })
    const [providerSearch, setProviderSearch] = useState('')
    const [pickerCategory, setPickerCategory] = useState<string | null>(null)
    const [name, setName] = useState('')
    const [value, setValue] = useState('')
    const [serverUrl, setServerUrl] = useState('')
    const [customExpiry, setCustomExpiry] = useState('')
    const [customAbbr, setCustomAbbr] = useState('')
    const [customDashboardUrl, setCustomDashboardUrl] = useState('')
    const [customProviderName, setCustomProviderName] = useState('')
    const [group, setGroup] = useState('')
    const [showKeyValue, setShowKeyValue] = useState(false)
    const [copied, setCopied] = useState(false)
    const [saving, setSaving] = useState(false)
    const searchRef = useRef<HTMLInputElement>(null)
    const valueInputRef = useRef<HTMLInputElement>(null)

    useEffect(() => {
        if (!open) return
        setShowKeyValue(false)
        setCopied(false)
        reset('root')
        setProviderSearch('')
        if (editingKey) {
            setPickerCategory(null)
            const entry = registryForKey(editingKey)
            setSelected(entry)
            setName(editingKey.name)
            setValue(editingKey.value)
            setServerUrl(editingKey.serverUrl || '')
            setCustomExpiry(editingKey.customExpiry || '')
            setCustomAbbr(editingKey.customAbbr || '')
            setCustomDashboardUrl(editingKey.customDashboardUrl || '')
            setCustomProviderName(editingKey.customProviderName || '')
            setGroup(resolveVaultGroup(editingKey.provider, editingKey.group))
        } else {
            setSelected(null)
            setPickerCategory(defaultGroup ?? null)
            setName('')
            setValue('')
            setServerUrl('')
            setCustomExpiry('')
            setCustomAbbr('')
            setCustomDashboardUrl('')
            setCustomProviderName('')
            setGroup('')
        }
    }, [open, editingKey, defaultGroup, reset])

    const handleSelect = (entry: RegistryProvider) => {
        setSelected(entry)
        setGroup(entry.group)
        setCustomDashboardUrl(entry.credentialUrl || '')
        // Catalog "other" entries carry their own display name; custom entries are user-named.
        setCustomProviderName(entry.vaultProvider === 'other' && entry.id !== 'custom' ? entry.name : '')
        // Add flow lands on the setup guide when the catalog has steps for this provider.
        goToPage(entry.setup ? 'setup' : 'root')
    }

    // Search results, flattened across every category so a known name skips the drill-in.
    const searchResults = useMemo(() => {
        const q = providerSearch.trim().toLowerCase()
        if (!q) return []
        const byGroup = new Map<string, RegistryProvider[]>()
        for (const p of PROVIDER_REGISTRY) {
            if (!(p.name.toLowerCase().includes(q) || p.group.toLowerCase().includes(q))) continue
            if (!byGroup.has(p.group)) byGroup.set(p.group, [])
            byGroup.get(p.group)!.push(p)
        }
        return [...byGroup.entries()].sort((a, b) => GROUP_ORDER.indexOf(a[0]) - GROUP_ORDER.indexOf(b[0]))
    }, [providerSearch])

    const categories = useMemo(() => {
        const counts = new Map<string, number>()
        for (const p of PROVIDER_REGISTRY) counts.set(p.group, (counts.get(p.group) || 0) + 1)
        return GROUP_ORDER
            .filter((g, i) => GROUP_ORDER.indexOf(g) === i && counts.has(g))
            .map((g) => ({ group: g, count: counts.get(g)! }))
    }, [])

    const categoryEntries = useMemo(
        () => (pickerCategory ? PROVIDER_REGISTRY.filter((p) => p.group === pickerCategory) : []),
        [pickerCategory]
    )

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        if (!selected || saving) return
        if (selected.vaultProvider === 'other' && expiryDateError(customExpiry)) {
            goToPage('expiry')
            return
        }
        const missing = firstMissingField(value, name)
        if (missing) {
            goToPage(missing.page)
            requestAnimationFrame(() => (document.getElementById(missing.id) as HTMLInputElement | null)?.reportValidity())
            return
        }
        const provider = selected.vaultProvider
        const isAddonProvider = provider === 'aiostreams' || provider === 'aiometadata'
        setSaving(true)
        try {
            const resolvedGroup = resolveVaultGroup(provider, group)
            const extra = {
                ...(provider === 'other' ? {
                    customExpiry: customExpiry || undefined,
                    customDashboardUrl: customDashboardUrl || undefined,
                    customProviderName: (selected.id === 'custom' ? customProviderName : selected.name) || undefined,
                } : {}),
                customAbbr: customAbbr || undefined,
                group: resolvedGroup === deriveGroup(provider) ? undefined : resolvedGroup,
                catalogId: selected.id === 'custom' ? undefined : selected.id,
                ...(isAddonProvider ? { serverUrl: serverUrl.trim() || undefined } : {}),
            }

            if (editingKey) {
                await updateKey(editingKey.id, { name, provider, value, ...extra })
                toast({ title: 'Key Updated', description: `${name} has been updated in your vault.` })
            } else {
                await addKey({ name, provider, value, ...extra })
                toast({ title: 'Key Added', description: `${name} has been added to your secure vault.` })
            }
            onOpenChange(false)
        } catch {
            toast({
                variant: 'destructive',
                title: 'Vault Error',
                description: 'Failed to save key. Ensure your vault is unlocked.',
                href: '/vault'
            })
        } finally {
            setSaving(false)
        }
    }

    const copyValue = () => {
        if (!value) return
        navigator.clipboard.writeText(value).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1200)
        }).catch(() => {})
    }

    const rotateValue = () => {
        setValue('')
        setShowKeyValue(true)
        requestAnimationFrame(() => valueInputRef.current?.focus())
    }

    if (!selected) {
        return (
            <Dialog open={open} onOpenChange={(nextOpen) => { if (saving && !nextOpen) return; onOpenChange(nextOpen) }}>
                <DialogContent ref={sheetRef} className="sm:max-w-[560px]" hideClose>
                    <div className="flex items-center gap-2 pb-1">
                        <Button
                            type="button"
                            variant="ghost"
                            onClick={() => onOpenChange(false)}
                            className="h-11 shrink-0 rounded-full px-3 text-sm font-semibold text-muted-foreground hover:text-foreground"
                        >
                            Cancel
                        </Button>
                        <DialogTitle className="min-w-0 flex-1 truncate text-center text-base font-bold">Choose a provider</DialogTitle>
                        <span aria-hidden="true" className="h-11 w-[72px] shrink-0" />
                    </div>
                    <DialogDescription className="pb-1 text-center text-xs">
                        Pick a provider to store its credentials in your encrypted vault.
                    </DialogDescription>

                    <div className="space-y-4 py-1">
                        <div data-theme-part="field" className="flex h-9 items-center gap-2 rounded-lg border border-border/40 bg-muted/30 px-2.5 transition-colors focus-within:border-border">
                            <Search className="h-3.5 w-3.5 text-muted-foreground" />
                            <input
                                data-theme-part="inline-input"
                                ref={searchRef}
                                value={providerSearch}
                                onChange={(e) => setProviderSearch(e.target.value)}
                                placeholder="Search all providers..."
                                autoFocus
                                className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                            />
                            {providerSearch && (
                                <button data-theme-part="button" type="button" onClick={() => setProviderSearch('')} className="text-muted-foreground hover:text-foreground" aria-label="Clear search">
                                    <X className="h-3 w-3" />
                                </button>
                            )}
                        </div>

                        {pickerCategory && !providerSearch && (
                            <button data-theme-part="button"
                                type="button"
                                onClick={() => setPickerCategory(null)}
                                className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                            >
                                <ChevronLeft className="h-3.5 w-3.5" /> All categories
                            </button>
                        )}

                        <div className="max-h-[440px] space-y-5 overflow-y-auto pr-1">
                            {providerSearch ? (
                                searchResults.length === 0 ? (
                                    <p className="py-10 text-center text-xs text-muted-foreground">No providers match your search.</p>
                                ) : (
                                    searchResults.map(([groupName, entries]) => (
                                        <div key={groupName} className="space-y-1.5">
                                            <div className="px-1 text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">
                                                {groupName}
                                            </div>
                                            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                                                {entries.map((p) => (
                                                    <ProviderButton key={p.id} p={p} onSelect={handleSelect} />
                                                ))}
                                            </div>
                                        </div>
                                    ))
                                )
                            ) : pickerCategory ? (
                                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                                    {categoryEntries.map((p) => (
                                        <ProviderButton key={p.id} p={p} onSelect={handleSelect} />
                                    ))}
                                </div>
                            ) : (
                                <div className="grid grid-cols-2 gap-2.5">
                                    {categories.map(({ group, count }) => {
                                        const Icon = CATEGORY_ICONS[group] || Wrench
                                        const c = tint(group)
                                        return (
                                            <button data-theme-part="button"
                                                key={group}
                                                type="button"
                                                onClick={() => setPickerCategory(group)}
                                                className="flex items-center gap-3 rounded-xl border border-border/40 bg-muted/10 px-3 py-3.5 text-left transition-colors hover:border-border/70 hover:bg-muted/25"
                                            >
                                                <span data-theme-part="badge" className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border/40 ${c.bg} ${c.text}`}>
                                                    <Icon className="h-[18px] w-[18px]" />
                                                </span>
                                                <span className="min-w-0 flex-1">
                                                    <span className="block truncate text-sm font-medium">{group}</span>
                                                    <span className="block text-xs text-muted-foreground">{count} {count === 1 ? 'provider' : 'providers'}</span>
                                                </span>
                                                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/60" />
                                            </button>
                                        )
                                    })}
                                </div>
                            )}
                        </div>
                    </div>
                </DialogContent>
            </Dialog>
        )
    }

    const isCustom = selected.id === 'custom'
    const isOther = selected.vaultProvider === 'other'
    const expiryError = isOther ? expiryDateError(customExpiry) : null
    const resolvedGroup = resolveVaultGroup(selected.vaultProvider, group)
    const providerLabel = isOther && customProviderName ? customProviderName : selected.name
    const abbr = getKeyAbbr({ customAbbr, provider: selected.vaultProvider, name: selected.name })
    const expiry = resolveExpiry(health, customExpiry)
    const dashboardUrl = (isOther ? customDashboardUrl.trim() : '') || PROVIDERS.find(p => p.value === selected.vaultProvider)?.url
    const entryName = name || selected.name
    const healthState = health && health.status !== 'none' ? health.status : null
    const dotClass = (() => {
        if (!health || health.status === 'none') return null
        if (health.status === 'active') {
            return health.daysRemaining != null && health.daysRemaining <= 30 ? 'bg-warning' : 'bg-success'
        }
        return 'bg-destructive'
    })()
    const status = statusLine([
        healthState ? HEALTH_LABEL[healthState] : null,
        resolvedGroup,
        editingKey ? `Updated ${getTimeAgo(new Date(editingKey.updatedAt))}` : null,
    ])

    const setupGuide = selected.setup ? (
        <div data-theme-part="panel" className="space-y-2 rounded-2xl border border-border/40 bg-muted/15 p-4">
            <div className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">
                How to get your {selected.credentialLabel.toLowerCase()}
            </div>
            {selected.setup.intro && (
                <p className="text-xs leading-relaxed text-muted-foreground">{selected.setup.intro}</p>
            )}
            <ol className="list-decimal space-y-1 pl-4 text-xs leading-relaxed text-muted-foreground/90 marker:text-muted-foreground/50">
                {selected.setup.steps.map((step, i) => (
                    <li key={i}>{step}</li>
                ))}
            </ol>
            {selected.setup.note && (
                <p className="text-[11px] italic text-muted-foreground/70">{selected.setup.note}</p>
            )}
        </div>
    ) : null

    const keyRow = (
        <SheetGroup>
            <div className="flex min-h-[44px] items-center gap-2 py-2 pl-4 pr-2.5">
                <button type="button" onClick={() => goToPage('key')} className="min-w-0 flex-1 text-left">
                    <span className="block text-sm font-semibold">Key</span>
                    <span className="block truncate text-xs text-muted-foreground">{selected.credentialLabel} · rotate any time</span>
                </button>
                <span className="max-w-[72px] shrink-0 truncate font-mono text-xs tracking-[0.16em] text-muted-foreground min-[420px]:max-w-[130px]">
                    {maskedKeyDisplay(value, showKeyValue)}
                </span>
                <button
                    type="button"
                    onClick={() => setShowKeyValue(v => !v)}
                    className={cn(PILL, PILL_IDLE)}
                    aria-label={showKeyValue ? 'Hide key value' : 'Reveal key value'}
                >
                    {showKeyValue ? 'Hide' : 'Reveal'}
                </button>
                <button
                    type="button"
                    onClick={copyValue}
                    className={cn(PILL, copied ? 'border-success/30 bg-success/10 text-success' : PILL_IDLE)}
                >
                    {copied ? '✓ Copied' : 'Copy'}
                </button>
                <button
                    type="button"
                    onClick={() => goToPage('key')}
                    aria-label="Open key page"
                    className="flex h-11 w-7 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
                >
                    <ChevronRight className="h-4 w-4" />
                </button>
            </div>
        </SheetGroup>
    )

    const overview = (
        <>
            <div className="flex flex-col items-center px-2 pb-2 pt-1 text-center">
                <span data-theme-part="badge" className={cn('flex h-20 w-20 items-center justify-center rounded-[22px] border border-border/40 text-2xl font-bold', tint(resolvedGroup).bg, tint(resolvedGroup).text)}>
                    {abbr}
                </span>
                <div className="mt-2.5 max-w-full truncate text-[17px] font-bold leading-tight">{entryName}</div>
                <div className="mt-1 flex max-w-full items-center gap-1.5 text-xs text-muted-foreground">
                    {dotClass && <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', dotClass)} />}
                    <span className="min-w-0 truncate">{status}</span>
                </div>
            </div>

            {keyRow}

            {(expiry || isOther || dashboardUrl || selected.setup) && (
                <SheetGroup>
                    {(expiry || isOther) && (
                        <SheetRow
                            label="Expiry"
                            value={expiry ? expiryLabel(expiry, formatExpiryDate) : 'Not set'}
                            tone={expiry ? EXPIRY_TONE[expiry.state] : undefined}
                            onClick={() => goToPage('expiry')}
                        />
                    )}
                    {(dashboardUrl || isOther) && (
                        <SheetRow label="Dashboard" value={dashboardUrl || 'Not set'} onClick={() => goToPage('dashboard')} />
                    )}
                    {selected.setup && (
                        <SheetRow
                            label="Setup guide"
                            value={`How to get your ${selected.credentialLabel.toLowerCase()}`}
                            onClick={() => goToPage('setup')}
                        />
                    )}
                </SheetGroup>
            )}

            <SheetGroup>
                <SheetRow label="Provider and group" value={`${providerLabel} · ${resolvedGroup}`} onClick={() => goToPage('provider')} />
                <SheetRow
                    label="Header badge"
                    value={
                        <span className={cn('flex h-5 w-5 items-center justify-center rounded-md border border-border/40 text-[9px] font-bold', tint(resolvedGroup).bg, tint(resolvedGroup).text)}>
                            {abbr}
                        </span>
                    }
                    onClick={() => goToPage('badge')}
                />
                {editingKey && <SheetRow label="Key ID" value="••••••••" />}
            </SheetGroup>
        </>
    )

    const renderPage = () => {
        switch (page) {
            case 'key':
                return (
                    <>
                        <div className="space-y-2">
                            <div className="flex items-center justify-between gap-2">
                                <Label htmlFor="v-value">{selected.credentialLabel}</Label>
                                {selected.credentialUrl && (
                                    <a
                                        href={selected.credentialUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="flex shrink-0 items-center gap-1 text-xs font-semibold text-primary hover:underline"
                                    >
                                        Get credential <ExternalLink className="h-2.5 w-2.5" />
                                    </a>
                                )}
                            </div>
                            <div className="relative">
                                <Input
                                    id="v-value"
                                    ref={valueInputRef}
                                    type={showKeyValue ? 'text' : 'password'}
                                    placeholder={selected.placeholder || 'Paste your key here'}
                                    value={value}
                                    onChange={(e) => setValue(e.target.value)}
                                    required
                                    className="pr-9 font-mono text-sm"
                                />
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className="absolute right-1 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center text-muted-foreground hover:text-primary"
                                    onClick={() => setShowKeyValue(v => !v)}
                                    aria-label={showKeyValue ? 'Hide value' : 'Show value'}
                                >
                                    {showKeyValue ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                                </Button>
                            </div>
                            {selected.composite && (
                                <p className="text-xs text-muted-foreground">
                                    Enter combined credentials as a single value{selected.placeholder ? ` (e.g. ${selected.placeholder})` : ''}.
                                </p>
                            )}
                            <div className="flex flex-wrap items-center gap-2 pt-0.5">
                                <button
                                    type="button"
                                    onClick={() => setShowKeyValue(v => !v)}
                                    className={cn(PILL, showKeyValue ? 'bg-foreground text-background' : PILL_IDLE)}
                                >
                                    {showKeyValue ? 'Hide value' : 'Reveal value'}
                                </button>
                                <button
                                    type="button"
                                    onClick={copyValue}
                                    className={cn(PILL, copied ? 'border-success/30 bg-success/10 text-success' : PILL_IDLE)}
                                >
                                    {copied ? '✓ Copied' : 'Copy'}
                                </button>
                                {editingKey && (
                                    <button type="button" onClick={rotateValue} className={cn(PILL, PILL_IDLE)}>
                                        Rotate
                                    </button>
                                )}
                            </div>
                            {editingKey && (
                                <p className="text-xs text-muted-foreground">
                                    Rotating replaces the value in place. Addons already configured with the old key keep it until you reconfigure them.
                                </p>
                            )}
                        </div>

                        {(selected.vaultProvider === 'aiostreams' || selected.vaultProvider === 'aiometadata') && (
                            <div className="space-y-2">
                                <Label htmlFor="v-server-url">Server URL <span className="font-normal text-muted-foreground/60">(optional)</span></Label>
                                <Input
                                    id="v-server-url"
                                    type="url"
                                    placeholder="https://your-instance.example.com"
                                    value={serverUrl}
                                    onChange={(e) => setServerUrl(e.target.value)}
                                />
                            </div>
                        )}

                        {setupGuide}
                    </>
                )
            case 'expiry':
                return (
                    <>
                        {isOther && (
                            <div className="space-y-2">
                                <Label htmlFor="v-custom-expiry">Expires on (optional)</Label>
                                <Input
                                    id="v-custom-expiry"
                                    type="date"
                                    value={customExpiry}
                                    onChange={(e) => setCustomExpiry(e.target.value)}
                                    aria-invalid={!!expiryError}
                                />
                                {expiryError && (
                                    <p role="alert" className="text-xs text-destructive">{expiryError}</p>
                                )}
                            </div>
                        )}
                        {health && healthState && (
                            <SheetGroup>
                                <SheetRow label="Status" value={HEALTH_LABEL[healthState]} tone={EXPIRY_TONE[healthState]} />
                                {health.expiresAt && (
                                    <SheetRow label="Expires" value={formatExpiryDate(health.expiresAt)} />
                                )}
                                {health.daysRemaining != null && (
                                    <SheetRow label="Days remaining" value={String(health.daysRemaining)} />
                                )}
                                <SheetRow
                                    label="Last checked"
                                    value={health.lastChecked ? getTimeAgo(new Date(health.lastChecked)) : 'Never'}
                                />
                                {health.error && <SheetRow label="Error" value={health.error} tone="bad" />}
                            </SheetGroup>
                        )}
                        {!isOther && !healthState && (
                            <p className="text-xs text-muted-foreground">No subscription data yet. Run a sync from the vault page.</p>
                        )}
                    </>
                )
            case 'dashboard':
                return (
                    <>
                        {isOther && (
                            <div className="space-y-2">
                                <Label htmlFor="v-custom-dashboard">Dashboard URL</Label>
                                <Input
                                    id="v-custom-dashboard"
                                    type="url"
                                    placeholder="https://provider.com/account"
                                    value={customDashboardUrl}
                                    onChange={(e) => setCustomDashboardUrl(e.target.value)}
                                />
                            </div>
                        )}
                        {dashboardUrl && (
                            <SheetGroup>
                                <a
                                    data-theme-part="button"
                                    href={dashboardUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="flex min-h-[44px] items-center gap-3 px-4 py-2 transition-colors hover:bg-muted/30"
                                >
                                    <span className="min-w-0 flex-1">
                                        <span className="block text-sm font-semibold text-primary">Open dashboard</span>
                                        <span className="block truncate text-xs text-muted-foreground">{dashboardUrl}</span>
                                    </span>
                                    <ExternalLink className="h-4 w-4 shrink-0 text-muted-foreground" />
                                </a>
                            </SheetGroup>
                        )}
                    </>
                )
            case 'setup':
                return setupGuide
            case 'provider':
                return (
                    <>
                        <div className="space-y-2">
                            <Label htmlFor="v-name">Display name</Label>
                            <Input
                                id="v-name"
                                placeholder={`e.g. My ${selected.name} Account`}
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                required
                            />
                        </div>

                        <SheetGroup>
                            <SheetRow label="Provider" value={providerLabel} />
                            <div className="space-y-2 px-4 py-3">
                                <Label htmlFor="v-group">Group</Label>
                                <Select value={resolvedGroup} onValueChange={setGroup}>
                                    <SelectTrigger id="v-group">
                                        <SelectValue placeholder={deriveGroup(selected.vaultProvider)} />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {VAULT_GROUPS.map(g => (
                                            <SelectItem key={g} value={g}>{g}</SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>
                        </SheetGroup>

                        {isCustom && (
                            <div className="space-y-2">
                                <Label htmlFor="v-custom-provider-name">Provider Name</Label>
                                <Input
                                    id="v-custom-provider-name"
                                    placeholder="e.g. UsenetServer, NZBgeek"
                                    value={customProviderName}
                                    onChange={(e) => setCustomProviderName(e.target.value)}
                                />
                            </div>
                        )}

                        {selected.description && (
                            <div data-theme-part="panel" className="flex gap-3 rounded-2xl border border-border/40 bg-muted/25 p-3 text-xs leading-relaxed text-muted-foreground">
                                <Info className="mt-0.5 h-4 w-4 shrink-0" />
                                <p>{selected.description}</p>
                            </div>
                        )}

                        {!editingKey && (
                            <Button
                                type="button"
                                variant="subtle"
                                onClick={() => { setSelected(null); reset('root') }}
                                className="h-11 rounded-full px-5 text-sm font-semibold"
                            >
                                Change provider
                            </Button>
                        )}
                    </>
                )
            case 'badge':
                return (
                    <div className="space-y-2">
                        <Label htmlFor="v-custom-abbr">Header badge</Label>
                        <div className="flex items-center gap-3">
                            <span data-theme-part="badge" className={cn('flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-border/40 text-sm font-bold', tint(resolvedGroup).bg, tint(resolvedGroup).text)}>
                                {abbr}
                            </span>
                            <Input
                                id="v-custom-abbr"
                                placeholder={providerAbbr(selected.name)}
                                maxLength={2}
                                value={customAbbr}
                                onChange={(e) => setCustomAbbr(e.target.value.toUpperCase())}
                                className="flex-1 font-bold placeholder:normal-case"
                            />
                        </div>
                        <p className="text-xs text-muted-foreground">Up to 2 letters, shown in the header key menu.</p>
                    </div>
                )
            default:
                return overview
        }
    }

    return (
        <Dialog open={open} onOpenChange={(nextOpen) => { if (saving && !nextOpen) return; onOpenChange(nextOpen) }}>
            <DialogContent ref={sheetRef} tabIndex={-1} className="outline-none sm:max-w-[560px]" hideClose>
                <DialogBack active={page !== 'root'} onBack={back} />
                <DialogAltHistory
                    active={open && (page !== 'root' || canForward)}
                    canBack={page !== 'root'}
                    canForward={canForward}
                    onBack={back}
                    onForward={goForward}
                />
                <form onSubmit={handleSubmit} className="space-y-4">
                    <div className="flex items-center gap-2 pb-1">
                        {page === 'root' ? (
                            <>
                                <Button
                                    type="button"
                                    variant="ghost"
                                    onClick={() => onOpenChange(false)}
                                    disabled={saving}
                                    className="h-11 shrink-0 rounded-full px-3 text-sm font-semibold text-muted-foreground hover:text-foreground"
                                >
                                    Cancel
                                </Button>
                                {canForward && (
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        onClick={goForward}
                                        aria-label="Forward"
                                        className="h-11 w-11 shrink-0 rounded-full p-0 text-sm font-semibold disabled:opacity-35"
                                    >
                                        <ChevronRight className="h-4 w-4" />
                                    </Button>
                                )}
                                <DialogTitle className="min-w-0 flex-1 truncate text-center text-base font-bold">{entryName}</DialogTitle>
                                <Button type="submit" disabled={loading || saving} className="h-11 shrink-0 rounded-full px-4 text-sm font-bold">
                                    {saving ? 'Saving...' : 'Done'}
                                </Button>
                            </>
                        ) : (
                            <>
                                <span className="flex shrink-0 items-center gap-1">
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        onClick={back}
                                        className="h-11 rounded-full px-3 text-sm font-semibold"
                                    >
                                        ‹ Back
                                    </Button>
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        onClick={goForward}
                                        disabled={!canForward}
                                        aria-label="Forward"
                                        className="h-11 w-11 rounded-full p-0 text-sm font-semibold disabled:opacity-35"
                                    >
                                        <ChevronRight className="h-4 w-4" />
                                    </Button>
                                </span>
                                <DialogTitle className="min-w-0 flex-1 truncate text-center text-base font-bold">{PAGE_TITLES[page]}</DialogTitle>
                                <span aria-hidden="true" className="h-11 w-[72px] shrink-0" />
                            </>
                        )}
                    </div>

                    {renderPage()}
                </form>
            </DialogContent>
        </Dialog>
    )
}
