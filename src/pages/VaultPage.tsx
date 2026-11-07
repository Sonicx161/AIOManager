import { useState, useMemo, useEffect, useCallback, useRef, useSyncExternalStore } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useVaultStore } from '@/store/vaultStore'
import { useAuthStore } from '@/store/authStore'
import { useProviderStore } from '@/store/providerStore'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'
import { Skeleton } from '@/components/ui/skeleton'
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog'
import { VaultKeyDialog } from '@/components/vault/VaultKeyDialog'
import { SquircleOverlay } from '@/components/ui/squircle-overlay'
import { VaultEmptyState } from '@/components/common/PageEmptyStates'

import { CircularProgress } from '@/components/ui/circular-progress'
import { NumberTicker } from '@/components/ui/number-ticker'
import {
    Lock, Plus, Search, Eye, EyeOff, Edit2, Trash2, ExternalLink,
    RefreshCw, ShieldCheck, Shield, Clock, AlertTriangle, List,
    Cloud, Layers, Cable, Database, Magnet, Type, Activity,
    Sparkles, Wrench, ChevronLeft, X, ArrowDownAZ, ArrowUpDown, Hash,
} from 'lucide-react'
import { VAULT_GROUPS, getKeyAbbr, PROVIDERS, resolveVaultGroup } from '@/lib/constants'
import { cn, getTimeAgo } from '@/lib/utils'
import { toast } from '@/hooks/use-toast'
import { useDocumentTitle } from '@/hooks/use-document-title'
import { getActiveWorkspaceId, subscribeWorkspaceChanges } from '@/lib/workspace-persistence'
import { VaultKey } from '@/types/vault'

import { ProviderHealth } from '@/types/provider'

const GROUP_ICONS: Record<string, typeof Cloud> = {
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

type SmartFilter = 'all' | 'recent' | 'expiring'
type ActiveFilter = { type: 'smart'; id: SmartFilter } | { type: 'group'; name: string }
type CategorySort = 'default' | 'alpha' | 'count'
type EntrySort = 'default' | 'name-asc' | 'name-desc' | 'updated'

const CATEGORY_SORT_KEY = 'vault-category-sort'
const ENTRY_SORT_KEY = 'vault-entry-sort'

function loadCategorySort(): CategorySort {
    const v = localStorage.getItem(CATEGORY_SORT_KEY)
    return v === 'alpha' || v === 'count' ? v : 'default'
}

function loadEntrySort(): EntrySort {
    const v = localStorage.getItem(ENTRY_SORT_KEY)
    return v === 'name-asc' || v === 'name-desc' || v === 'updated' ? v : 'default'
}



function StatusDot({ status, daysRemaining }: { status?: string; daysRemaining?: number | null }) {
    const isExpired = status === 'expired'
    const isError = status === 'error'
    const isActive = status === 'active'
    const isExpiring = isActive && daysRemaining != null && daysRemaining <= 30

    const color = isExpired || isError
        ? 'bg-destructive'
        : isExpiring
            ? 'bg-warning'
            : isActive
                ? 'bg-success'
                : 'bg-muted-foreground/30'

    return <span className={`w-2 h-2 rounded-full shrink-0 ${color}${isActive ? ' animate-pulse' : ''}`} />
}

function ProviderTile({ k, size = 32 }: { k: VaultKey; size?: number }) {
    const abbr = getKeyAbbr(k)
    return (
        <div className="relative shrink-0 flex items-center justify-center" style={{ width: size, height: size }}>
            <SquircleOverlay />
            <span className="relative z-10 leading-none font-bold text-muted-foreground" style={{ fontSize: size * 0.35 }}>
                {abbr}
            </span>
        </div>
    )
}

function getProviderLabel(keyData: VaultKey) {
    return keyData.provider === 'other' && keyData.customProviderName
        ? keyData.customProviderName
        : PROVIDERS.find(p => p.value === keyData.provider)?.label ?? keyData.provider
}

function getCompactProviderLabel(keyData: VaultKey) {
    const providerLabel = getProviderLabel(keyData)
    return keyData.name.toLowerCase().includes(providerLabel.toLowerCase()) ? null : providerLabel
}

function formatEntryCount(count: number) {
    return `${count} ${count === 1 ? 'entry' : 'entries'}`
}

function KeyDetailPanel({
    keyData,
    health,
    onEdit,
    onDelete,
    isRefreshing,
    onRefresh,
}: {
    keyData: VaultKey
    health?: ProviderHealth
    onEdit: () => void
    onDelete: () => void
    isRefreshing: boolean
    onRefresh: () => void
}) {
    const [reveal, setReveal] = useState(false)
    const [copied, setCopied] = useState(false)

    const providerLabel = getProviderLabel(keyData)
    const dashboardUrl = keyData.customDashboardUrl || PROVIDERS.find(p => p.value === keyData.provider)?.url
    const group = resolveVaultGroup(keyData.provider, keyData.group)

    const isActive = health?.status === 'active'
    const isExpired = health?.status === 'expired'
    const isError = health?.status === 'error'
    const daysRemaining = health?.daysRemaining
    const isExpiring = isActive && daysRemaining != null && daysRemaining <= 30

    const years = daysRemaining != null ? Math.floor(daysRemaining / 365) : 0
    const months = daysRemaining != null ? Math.floor((daysRemaining % 365) / 30) : 0
    const days = daysRemaining != null ? daysRemaining % 30 : 0

    return (
        <div className="p-4 sm:p-6 lg:p-10 xl:p-12 max-w-5xl mx-auto w-full">
            <div className="flex items-start gap-3 sm:gap-4 lg:gap-6 mb-7 lg:mb-9">
                <ProviderTile k={keyData} size={56} />
                <div className="flex min-w-0 flex-1 items-start justify-between gap-3 pt-1">
                    <div className="min-w-0">
                        <div className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-0.5">
                            {group}
                        </div>
                        <h1 className="truncate text-2xl lg:text-3xl font-bold tracking-tight leading-tight">{keyData.name}</h1>
                        <div className="text-xs text-muted-foreground mt-1.5 flex items-center gap-2 flex-wrap">
                            <span>{providerLabel}</span>
                            <span>·</span>
                            <StatusDot status={health?.status} daysRemaining={daysRemaining} />
                            <span>{isActive ? 'Active' : isExpired ? 'Expired' : isError ? 'Error' : 'Unknown'}</span>
                            <span>·</span>
                            <span>Updated {getTimeAgo(new Date(keyData.updatedAt))}</span>
                            {isExpiring && (
                                <>
                                    <span>·</span>
                                    <span className="text-warning font-semibold flex items-center gap-1">
                                        <AlertTriangle className="w-3 h-3" /> Rotate soon
                                    </span>
                                </>
                            )}
                        </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={onEdit}
                            className="h-8 gap-1.5 rounded-lg bg-background/80 px-2.5 text-xs font-medium shadow-sm"
                        >
                            <Edit2 className="w-3.5 h-3.5" />
                            <span className="hidden min-[380px]:inline">Edit</span>
                        </Button>
                        <Tooltip content="Delete key" side="bottom">
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={onDelete}
                                className="h-8 gap-1.5 rounded-lg bg-background/80 px-2.5 text-xs font-medium text-muted-foreground shadow-sm hover:text-destructive"
                            >
                                <Trash2 className="w-3.5 h-3.5" />
                                <span className="hidden min-[380px]:inline">Delete</span>
                            </Button>
                        </Tooltip>
                    </div>
                </div>
            </div>

            <div data-theme-part="field" className="rounded-2xl border border-border overflow-hidden mb-5">
                <div className="px-5 py-3 border-b border-border bg-muted/40 flex items-center justify-between">
                    <span className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">API Key</span>
                    <div className="flex items-center gap-1">
                        <button
                            data-theme-part="button"
                            onClick={() => setReveal(r => !r)}
                            className="h-7 px-2 rounded-md hover:bg-muted/60 text-xs font-medium text-muted-foreground flex items-center gap-1"
                        >
                            {reveal ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                            {reveal ? 'Hide' : 'Reveal'}
                        </button>
                        <button
                            data-theme-part="button"
                            onClick={() => {
                                navigator.clipboard.writeText(keyData.value)
                                setCopied(true)
                                setTimeout(() => setCopied(false), 1200)
                            }}
                            className="h-7 px-2 rounded-md hover:bg-muted/60 text-xs font-medium text-primary flex items-center gap-1"
                        >
                            {copied ? '✓ Copied' : 'Copy'}
                        </button>
                    </div>
                </div>
                <div className="px-5 py-6">
                    <div className="font-mono text-sm break-all tracking-wide select-all">
                        {reveal ? keyData.value : '•'.repeat(Math.min(keyData.value.length, 40))}
                    </div>
                </div>
            </div>

            {keyData.serverUrl && (
                <div data-theme-part="field" className="rounded-2xl border border-border overflow-hidden mb-5">
                    <div className="px-5 py-3 border-b border-border bg-muted/40 flex items-center justify-between">
                        <span className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">Server</span>
                        <a
                            data-theme-part="button"
                            href={keyData.serverUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="h-7 px-2 rounded-md hover:bg-muted/60 text-xs font-medium text-primary flex items-center gap-1"
                        >
                            <ExternalLink className="w-3 h-3" />
                            Open
                        </a>
                    </div>
                    <div className="px-5 py-4">
                        <span className="font-mono text-sm break-all tracking-wide select-all">{keyData.serverUrl}</span>
                    </div>
                </div>
            )}

            {health && (
                <div data-theme-part="panel" className="rounded-2xl border border-border overflow-hidden mb-5">
                    <div className="px-5 py-3 border-b border-border bg-muted/40 flex items-center justify-between">
                        <span className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">Subscription</span>
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={onRefresh}
                            disabled={isRefreshing}
                            className="h-7 text-xs gap-1 text-muted-foreground"
                        >
                            <RefreshCw className={`w-3 h-3 ${isRefreshing ? 'animate-spin' : ''}`} />
                            Sync
                        </Button>
                    </div>
                    <div className="px-5 py-5 flex items-center gap-5">
                        <CircularProgress
                            value={daysRemaining != null ? Math.min((daysRemaining / 365) * 100, 100) : 0}
                            size={56}
                            strokeWidth={4}
                            color={
                                isActive && daysRemaining != null && daysRemaining > 30
                                    ? 'hsl(var(--success))'
                                    : isActive
                                        ? 'hsl(var(--warning))'
                                        : 'hsl(var(--destructive))'
                            }
                        >
                            <span className="text-xs font-bold uppercase tracking-tight leading-none">
                                {isActive ? '✓' : isExpired ? 'EXP' : 'ERR'}
                            </span>
                        </CircularProgress>
                        <div>
                            {daysRemaining !== null && daysRemaining !== undefined ? (
                                <div className="text-2xl font-bold leading-tight">
                                    {years > 0 && <><NumberTicker value={years} />y</>}
                                    {months > 0 && <>{years > 0 ? ' ' : ''}<NumberTicker value={months} />mo</>}
                                    {(days > 0 || (years === 0 && months === 0)) && (
                                        <>{(years > 0 || months > 0) ? ' ' : ''}{days === 0 ? '0' : <NumberTicker value={days} />}d</>
                                    )}
                                </div>
                            ) : (
                                <div className="text-2xl font-bold text-muted-foreground leading-tight">-</div>
                            )}
                            {health.expiresAt ? (
                                <div className="text-xs text-muted-foreground mt-0.5">
                                    Expires {new Date(health.expiresAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
                                </div>
                            ) : null}
                            {health.error && (
                                <div className="text-xs text-destructive mt-0.5 italic">{health.error}</div>
                            )}
                        </div>
                    </div>
                </div>
            )}

            <div className="grid grid-cols-1 gap-4 mb-5 sm:grid-cols-2 xl:grid-cols-4">
                <div data-theme-part="panel" className="rounded-2xl border border-border p-4">
                    <div className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-1">Provider</div>
                    <div className="text-sm font-semibold flex items-center gap-2">
                        <ProviderTile k={keyData} size={20} />
                        {providerLabel}
                    </div>
                </div>
                <div data-theme-part="panel" className="rounded-2xl border border-border p-4">
                    <div className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-1">Group</div>
                    <div className="text-sm font-semibold">{group}</div>
                </div>
                <div data-theme-part="panel" className="rounded-2xl border border-border p-4">
                    <div className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-1">Last Checked</div>
                    <div className="text-sm font-semibold">
                        {health?.lastChecked ? getTimeAgo(new Date(health.lastChecked)) : 'Never'}
                    </div>
                </div>
                <div data-theme-part="panel" className="rounded-2xl border border-border p-4">
                    <div className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-1">Key ID</div>
                    <div className="text-sm font-mono text-muted-foreground truncate">{keyData.id.slice(0, 8)}…</div>
                </div>
            </div>

            {dashboardUrl && (
                <div data-theme-part="panel" className="rounded-2xl border border-border divide-y divide-border mb-5">
                    <a
                        data-theme-part="button"
                        href={dashboardUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-3 px-5 py-4 hover:bg-muted/40 transition-colors"
                    >
                        <span className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 bg-primary/12 text-primary">
                            <ExternalLink className="w-3.5 h-3.5" />
                        </span>
                        <div className="flex-1 min-w-0">
                            <div className="text-sm font-semibold">Open provider dashboard</div>
                            <div className="text-xs text-muted-foreground truncate">{dashboardUrl}</div>
                        </div>
                    </a>
                </div>
            )}

            <div className="text-xs text-muted-foreground mt-4 flex items-start gap-2">
                <ShieldCheck className="w-3.5 h-3.5 mt-0.5 text-success shrink-0" />
                <span>Keys are encrypted with AES-256-GCM using a key derived from your master password via PBKDF2-SHA256 (600K iterations). Your master password never leaves your device.</span>
            </div>
        </div>
    )
}

export function VaultPage() {
    useDocumentTitle('Vault')
    const keys = useVaultStore(s => s.keys)
    const encryptionKey = useAuthStore(s => s.encryptionKey)
    const vaultLoading = useVaultStore(s => s.loading)
    const health = useProviderStore(s => s.health)
    const forceRefreshAll = useProviderStore(s => s.forceRefreshAll)
    const isRefreshing = useProviderStore(s => s.isRefreshing)
    const removeKey = useVaultStore(s => s.removeKey)
    const clearVault = useVaultStore(s => s.clearVault)
    const saveFailed = useVaultStore(s => s.saveFailed)

    const [activeFilter, setActiveFilter] = useState<ActiveFilter>({ type: 'smart', id: 'all' })
    const [selectedId, setSelectedId] = useState<string | null>(null)
    const [search, setSearch] = useState('')
    const [isDialogOpen, setIsDialogOpen] = useState(false)
    const [editingKey, setEditingKey] = useState<VaultKey | null>(null)
    const [deleteConfirmation, setDeleteConfirmation] = useState<{ open: boolean; id: string; name: string }>({ open: false, id: '', name: '' })
    const [isDeleting, setIsDeleting] = useState(false)
    const [eraseAllOpen, setEraseAllOpen] = useState(false)
    const [isErasing, setIsErasing] = useState(false)
    const [desktopFilterOpen, setDesktopFilterOpen] = useState(true)
    const [mobileDetailId, setMobileDetailId] = useState<string | null>(null)
    const [mobileFilterOpen, setMobileFilterOpen] = useState(true)
    const [categorySort, setCategorySort] = useState<CategorySort>(loadCategorySort)
    const [entrySort, setEntrySort] = useState<EntrySort>(loadEntrySort)
    const [searchParams, setSearchParams] = useSearchParams()
    const linkedKeyId = searchParams.get('key')

    // Re-initialize when the workspace changes mid-init.
    const workspaceId = useSyncExternalStore(subscribeWorkspaceChanges, getActiveWorkspaceId, () => '')
    const initializedWorkspaceRef = useRef(workspaceId)
    useEffect(() => {
        if (initializedWorkspaceRef.current === workspaceId) return
        initializedWorkspaceRef.current = workspaceId
        if (encryptionKey) useVaultStore.getState().initialize().catch(() => {})
    }, [workspaceId, encryptionKey])

    useEffect(() => {
        if (!linkedKeyId || !keys.some(k => k.id === linkedKeyId)) return
        setActiveFilter({ type: 'smart', id: 'all' })
        setSearch('')
        setSelectedId(linkedKeyId)
        if (window.matchMedia('(max-width: 767px)').matches) setMobileDetailId(linkedKeyId)
        setSearchParams(prev => { const next = new URLSearchParams(prev); next.delete('key'); return next }, { replace: true })
    }, [linkedKeyId, keys, setSearchParams])

    useEffect(() => {
        localStorage.setItem(CATEGORY_SORT_KEY, categorySort)
    }, [categorySort])

    useEffect(() => {
        localStorage.setItem(ENTRY_SORT_KEY, entrySort)
    }, [entrySort])

    useEffect(() => {
        if (encryptionKey) {
            useProviderStore.getState().hydrateAndRefresh()
        }
    }, [encryptionKey])

    const groupedCounts = useMemo(() => {
        const counts: Record<string, number> = {}
        for (const key of keys) {
            const g = resolveVaultGroup(key.provider, key.group)
            counts[g] = (counts[g] || 0) + 1
        }
        return counts
    }, [keys])

    const sortedGroups = useMemo(() => {
        if (categorySort === 'alpha') return [...VAULT_GROUPS].sort((a, b) => a.localeCompare(b))
        if (categorySort === 'count') return [...VAULT_GROUPS].sort((a, b) => (groupedCounts[b] || 0) - (groupedCounts[a] || 0))
        return VAULT_GROUPS
    }, [categorySort, groupedCounts])

    const expiringKeys = useMemo(() => {
        return keys.filter(k => {
            const h = health[k.id]
            return h?.status === 'active' && h.daysRemaining != null && h.daysRemaining <= 30
        })
    }, [keys, health])

    // Once-per-session nudge when keys are within 30 days of expiry.
    useEffect(() => {
        if (expiringKeys.length === 0) return
        try {
            if (sessionStorage.getItem('aio-vault-expiry-toast-shown') === '1') return
            sessionStorage.setItem('aio-vault-expiry-toast-shown', '1')
        } catch {}
        const n = expiringKeys.length
        toast({
            variant: 'warning',
            title: `${n} key${n !== 1 ? 's' : ''} expiring soon`,
            description: `Renew before they expire to avoid stream interruptions. Filter by "Expiring Soon" to see them.`,
            href: '/vault',
        })
    }, [expiringKeys.length])

    const visibleKeys = useMemo(() => {
        let list = keys
        if (activeFilter.type === 'group') {
            list = list.filter(k => resolveVaultGroup(k.provider, k.group) === activeFilter.name)
        } else if (activeFilter.id === 'expiring') {
            list = expiringKeys
        } else if (activeFilter.id === 'recent') {
            list = [...list].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 10)
        }
        if (search) {
            const q = search.toLowerCase()
            list = list.filter(k =>
                k.name.toLowerCase().includes(q) ||
                k.provider.toLowerCase().includes(q) ||
                (k.customProviderName || '').toLowerCase().includes(q) ||
                (k.serverUrl || '').toLowerCase().includes(q) ||
                (k.addonUuid || '').toLowerCase().includes(q)
            )
        }
        if (entrySort !== 'default' && !(activeFilter.type === 'smart' && activeFilter.id === 'recent')) {
            list = [...list]
            if (entrySort === 'name-asc') list.sort((a, b) => a.name.localeCompare(b.name))
            else if (entrySort === 'name-desc') list.sort((a, b) => b.name.localeCompare(a.name))
            else if (entrySort === 'updated') list.sort((a, b) => b.updatedAt - a.updatedAt)
        }
        return list
    }, [keys, activeFilter, search, expiringKeys, entrySort])

    const selected = useMemo(() => {
        if (selectedId) return keys.find(k => k.id === selectedId) ?? null
        return null
    }, [selectedId, keys])

    const filterLabel = useMemo(() => {
        if (activeFilter.type === 'group') return activeFilter.name
        return activeFilter.id === 'all' ? 'Vault' : activeFilter.id === 'recent' ? 'Recent' : 'Expiring Soon'
    }, [activeFilter])

    const handleOpenAdd = useCallback(() => {
        setEditingKey(null)
        setIsDialogOpen(true)
    }, [])

    const handleOpenEdit = useCallback((key: VaultKey) => {
        setEditingKey(key)
        setIsDialogOpen(true)
    }, [])

    const confirmDelete = useCallback(async () => {
        const { id, name } = deleteConfirmation
        setIsDeleting(true)
        try {
            await removeKey(id)
            toast({ title: 'Key Removed', description: `${name} has been deleted from your vault.` })
            setDeleteConfirmation({ open: false, id: '', name: '' })
            if (selectedId === id) setSelectedId(null)
            setMobileDetailId(prev => prev === id ? null : prev)
        } finally {
            setIsDeleting(false)
        }
    }, [deleteConfirmation, removeKey, selectedId])

    const confirmEraseAll = useCallback(async () => {
        setIsErasing(true)
        try {
            await clearVault()
            toast({ title: 'Vault Cleared', description: 'All vault entries have been erased.' })
            setEraseAllOpen(false)
            setSelectedId(null)
            setMobileDetailId(null)
        } catch (e) {
            toast({ title: 'Failed to clear vault', description: e instanceof Error ? e.message : 'Please try again.', variant: 'destructive' })
        } finally {
            setIsErasing(false)
        }
    }, [clearVault])

    if (!encryptionKey) {
        return (
            <div className="flex flex-col items-center justify-center py-24 gap-3 text-center">
                <div className="p-3 rounded-full bg-primary/10">
                    <Lock className="h-6 w-6 text-primary" />
                </div>
                <p className="text-sm text-muted-foreground">Unlock to access your vault</p>
                <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
                    Unlock
                </Button>
            </div>
        )
    }

    if (vaultLoading) {
        return (
            <div className="space-y-4 p-6">
                <div className="flex items-center justify-between">
                    <Skeleton className="h-5 w-48" />
                    <Skeleton className="h-8 w-24" />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    {Array.from({ length: 6 }).map((_, i) => (
                        <Skeleton key={i} className="h-40 rounded-xl" />
                    ))}
                </div>
            </div>
        )
    }

    const sidebarItem = (
        id: string,
        label: string,
        icon: typeof Cloud,
        count?: number,
        filterType: 'smart' | 'group' = 'smart',
    ) => {
        const isActive = activeFilter.type === filterType && (
            filterType === 'smart' ? (activeFilter as { type: 'smart'; id: SmartFilter }).id === id :
                (activeFilter as { type: 'group'; name: string }).name === id
        )
        const Icon = icon
        return (
            <button
                key={id}
                data-theme-part="nav-item"
                data-state={isActive ? 'active' : 'inactive'}
                onClick={() => {
                    setActiveFilter(filterType === 'smart' ? { type: 'smart', id: id as SmartFilter } : { type: 'group', name: id })
                    setSelectedId(null)
                    setSearch('')
                    setDesktopFilterOpen(false)
                }}
                className={`w-full h-10 px-2.5 rounded-xl flex items-center gap-2.5 text-sm transition-[transform,opacity,box-shadow] border ${
                    isActive
                        ? 'bg-background text-foreground border-border/45 font-semibold shadow-sm'
                        : 'text-foreground/85 border-transparent hover:bg-muted/50'
                }`}
            >
                <span className={cn('flex h-6 w-6 shrink-0 items-center justify-center rounded-lg', isActive ? 'bg-muted/50 text-foreground' : 'bg-muted/35 text-muted-foreground')}>
                    <Icon className="h-3.5 w-3.5" />
                </span>
                <span className="min-w-0 flex-1 truncate text-left font-semibold">{label}</span>
                {count !== undefined && (
                    <span className="text-xs font-bold tabular-nums text-muted-foreground">{count}</span>
                )}
            </button>
        )
    }

    type MobileFilterItem = {
        key: string
        label: string
        icon: typeof Cloud
        count: number
        filter: ActiveFilter
    }

    const mobileSmartFilters: MobileFilterItem[] = [
        { key: 'all', label: 'All', icon: List, count: keys.length, filter: { type: 'smart', id: 'all' } },
        { key: 'recent', label: 'Recent', icon: Clock, count: Math.min(keys.length, 10), filter: { type: 'smart', id: 'recent' } },
        { key: 'expiring', label: 'Expiring Soon', icon: AlertTriangle, count: expiringKeys.length, filter: { type: 'smart', id: 'expiring' } },
    ]

    const mobileGroupFilters: MobileFilterItem[] = sortedGroups.map(g => ({
        key: g,
        label: g,
        icon: GROUP_ICONS[g] || Wrench,
        count: groupedCounts[g] || 0,
        filter: { type: 'group', name: g },
    }))

    const renderMobileMenuItem = (item: MobileFilterItem) => {
        const isActive = item.filter.type === activeFilter.type && (
            item.filter.type === 'smart'
                ? item.filter.id === (activeFilter as { type: 'smart'; id: SmartFilter }).id
                : item.filter.name === (activeFilter as { type: 'group'; name: string }).name
        )
        const Icon = item.icon
        return (
            <button
                key={item.key}
                data-theme-part="nav-item"
                data-state={isActive ? 'active' : 'inactive'}
                onClick={() => {
                    setActiveFilter(item.filter)
                    setSelectedId(null)
                    setMobileDetailId(null)
                    setSearch('')
                    setMobileFilterOpen(false)
                }}
                className={cn(
                    "flex h-10 w-full items-center gap-2 rounded-xl border px-2.5 text-sm transition-colors",
                    isActive
                        ? "border-border/45 bg-background text-foreground shadow-sm"
                        : "border-transparent text-foreground/85 hover:border-border/35 hover:bg-muted/45",
                )}
            >
                <span className={cn(
                    "flex h-6 w-6 shrink-0 items-center justify-center rounded-lg",
                    isActive ? "bg-muted/50 text-foreground" : "bg-muted/35 text-muted-foreground"
                )}>
                    <Icon className="h-3.5 w-3.5" />
                </span>
                <span className="min-w-0 flex-1 truncate text-left font-semibold">{item.label}</span>
                <span className="text-xs font-bold tabular-nums text-muted-foreground">{item.count}</span>
            </button>
        )
    }

    return (
        <div className="flex flex-col gap-4">
            {saveFailed && (
                <div data-theme-part="panel" data-theme-tone="status" className="flex items-center gap-2 rounded-xl border border-warning/40 bg-warning/10 px-4 py-2.5 text-sm text-warning">
                    <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                        <line x1="12" y1="9" x2="12" y2="13" />
                        <line x1="12" y1="17" x2="12.01" y2="17" />
                    </svg>
                    <span>Vault changes may not have been saved. Try the action again.</span>
                </div>
            )}
        <div className="flex flex-col lg:flex-row gap-6 lg:h-[calc(100vh-16rem)] lg:min-h-[500px]">
            {/* Desktop Notes-style layout: navigation on the left, details on the right. */}
            <div className="hidden lg:flex gap-6 h-full w-full">
                <section data-theme-part="card" className="flex w-[300px] shrink-0 flex-col overflow-hidden rounded-2xl border border-border/40 bg-card shadow-sm">
                    {desktopFilterOpen ? (
                        <>
                            <div className="flex items-center gap-2 px-5 pt-5 pb-4 shrink-0">
                                <div className="flex-1 min-w-0">
                                    <h1 className="text-lg font-bold tracking-tight">Vault</h1>
                                    <p className="text-xs text-muted-foreground mt-0.5">{formatEntryCount(keys.length)}</p>
                                </div>
                                <Button size="sm" onClick={handleOpenAdd} className="gap-1.5">
                                    <Plus className="w-3 h-3" strokeWidth={2.5} /> Add
                                </Button>
                            </div>

                            <div className="flex-1 overflow-y-auto px-4 pb-4">
                                <div className="space-y-6">
                                    <div>
                                        <Tooltip content="Quick filters for your vault entries" side="top">
                                            <div className="px-1 pb-1 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground cursor-help">Smart</div>
                                        </Tooltip>
                                        <div className="space-y-0.5">
                                            {sidebarItem('all', 'All', List, keys.length)}
                                            {sidebarItem('recent', 'Recent', Clock, Math.min(keys.length, 10))}
                                            {sidebarItem('expiring', 'Expiring Soon', AlertTriangle, expiringKeys.length)}
                                        </div>
                                    </div>

                                    <div>
                                        <div className="flex items-center justify-between px-1 pb-1">
                                            <Tooltip content="Filter by provider type" side="top">
                                                <span className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground cursor-help">Categories</span>
                                            </Tooltip>
                                            <Tooltip content={categorySort === 'default' ? 'Default order' : categorySort === 'alpha' ? 'Alphabetical' : 'By count'} side="top">
                                                <button
                                                    data-theme-part="button"
                                                    onClick={() => setCategorySort(s => s === 'default' ? 'alpha' : s === 'alpha' ? 'count' : 'default')}
                                                    className="text-muted-foreground hover:text-foreground transition-colors"
                                                    aria-label="Toggle category sort"
                                                >
                                                    {categorySort === 'default' ? <ArrowUpDown className="h-3 w-3" /> : categorySort === 'alpha' ? <ArrowDownAZ className="h-3 w-3" /> : <Hash className="h-3 w-3" />}
                                                </button>
                                            </Tooltip>
                                        </div>
                                        <div className="space-y-0.5">
                                            {sortedGroups.map(g => {
                                                const Icon = GROUP_ICONS[g] || Wrench
                                                return sidebarItem(g, g, Icon, groupedCounts[g] || 0, 'group')
                                            })}
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <div data-theme-part="toolbar" className="mt-auto border-t border-border/40 px-4 py-3 shrink-0">
                                <Tooltip content="Sync subscription status from all providers" side="top">
                                    <Button
                                        variant="ghost"
                                        onClick={() => useProviderStore.getState().forceRefreshAll()}
                                        disabled={isRefreshing}
                                        className="w-full justify-start gap-2 text-xs text-muted-foreground hover:text-foreground"
                                    >
                                        <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
                                        Refresh All
                                    </Button>
                                </Tooltip>
                                <Tooltip content="Erase every vault entry" side="top">
                                    <Button
                                        variant="ghost"
                                        onClick={() => setEraseAllOpen(true)}
                                        disabled={keys.length === 0}
                                        className="w-full justify-start gap-2 text-xs text-muted-foreground hover:text-destructive"
                                    >
                                        <Trash2 className="w-3.5 h-3.5" />
                                        Erase All
                                    </Button>
                                </Tooltip>
                            </div>
                        </>
                    ) : (
                        <>
                            <div className="flex items-center gap-3 border-b border-border/40 px-5 pt-5 pb-4 shrink-0">
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-8 shrink-0 gap-1.5 rounded-lg bg-background/80 px-2.5 text-xs font-medium shadow-sm"
                                    onClick={() => {
                                        setDesktopFilterOpen(true)
                                        setSelectedId(null)
                                        setSearch('')
                                    }}
                                >
                                    <ChevronLeft className="h-4 w-4" />
                                    Back
                                </Button>
                                <div className="min-w-0 flex-1">
                                    <h2 className="truncate text-lg font-bold tracking-tight leading-tight">{filterLabel}</h2>
                                    <p className="text-xs text-muted-foreground">{formatEntryCount(visibleKeys.length)}</p>
                                </div>
                                <Button size="sm" onClick={handleOpenAdd} className="gap-1.5">
                                    <Plus className="w-3 h-3" strokeWidth={2.5} /> Add
                                </Button>
                            </div>

                            <div className="px-5 pt-4 pb-3 border-b border-border/40 shrink-0">
                                <div className="flex items-center gap-2">
                                    <div data-theme-part="input" className="h-8 rounded-lg bg-muted/30 border border-border/40 flex items-center px-2.5 gap-2 hover:border-border transition-colors flex-1">
                                        <Search className="w-3.5 h-3.5 text-muted-foreground" />
                                        <input
                                            value={search}
                                            onChange={e => setSearch(e.target.value)}
                                            placeholder="Search vault..."
                                            className="bg-transparent outline-none flex-1 text-xs text-foreground placeholder-muted-foreground"
                                        />
                                        {search && (
                                            <button data-theme-part="button" onClick={() => setSearch('')} className="text-muted-foreground hover:text-foreground" aria-label="Clear search">
                                                <X className="w-3 h-3" />
                                            </button>
                                        )}
                                    </div>
                                    <Tooltip content={entrySort === 'default' ? 'Default order' : entrySort === 'name-asc' ? 'Name A-Z' : entrySort === 'name-desc' ? 'Name Z-A' : 'Recently updated'} side="top">
                                        <button
                                            data-theme-part="button"
                                            onClick={() => setEntrySort(s => s === 'default' ? 'name-asc' : s === 'name-asc' ? 'name-desc' : s === 'name-desc' ? 'updated' : 'default')}
                                            className="h-8 w-8 shrink-0 rounded-lg border border-border/40 bg-muted/30 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                                            aria-label="Toggle entry sort"
                                        >
                                            {entrySort === 'default' ? <ArrowUpDown className="w-3.5 h-3.5" /> : entrySort === 'name-asc' ? <ArrowDownAZ className="w-3.5 h-3.5" /> : entrySort === 'name-desc' ? <ArrowDownAZ className="w-3.5 h-3.5 rotate-180" /> : <Clock className="w-3.5 h-3.5" />}
                                        </button>
                                    </Tooltip>
                                </div>
                            </div>

                            <div className="flex-1 overflow-y-auto">
                                {visibleKeys.length === 0 && keys.length === 0 ? (
                                    <VaultEmptyState onAdd={handleOpenAdd} />
                                ) : visibleKeys.length === 0 ? (
                                    <div className="px-6 py-12 text-center text-xs text-muted-foreground">
                                        {search ? 'No entries match your search.' : 'No entries in this group.'}
                                    </div>
                                ) : (
                                    visibleKeys.map(k => {
                                        const isSelected = selected?.id === k.id
                                        const h = health[k.id]
                                        const providerLabel = getCompactProviderLabel(k)
                                        const isExpiring = h?.status === 'active' && h.daysRemaining != null && h.daysRemaining <= 30
                                        return (
                                            <button
                                                key={k.id}
                                                data-theme-part="nav-item"
                                                data-state={isSelected ? 'active' : 'inactive'}
                                                onClick={() => setSelectedId(k.id)}
                                                className={cn(
                                                    "w-full text-left px-5 py-3.5 flex items-center gap-4 border-b border-l-2 border-border/40 transition-colors",
                                                    isSelected ? 'border-l-border bg-muted/45' : 'border-l-transparent hover:bg-muted/40'
                                                )}
                                            >
                                                <ProviderTile k={k} size={38} />
                                                <div className="flex-1 min-w-0">
                                                    <div className={`text-sm truncate ${isSelected ? 'font-semibold' : 'font-medium'}`}>
                                                        {k.name}
                                                    </div>
                                                    <div className="text-xs text-muted-foreground truncate flex items-center gap-1.5">
                                                        <StatusDot status={h?.status} daysRemaining={h?.daysRemaining} />
                                                        {providerLabel && (
                                                            <>
                                                                <span>{providerLabel}</span>
                                                                <span>·</span>
                                                            </>
                                                        )}
                                                        <span>{getTimeAgo(new Date(k.updatedAt))}</span>
                                                        {isExpiring && (
                                                            <>
                                                                <span>·</span>
                                                                <span className="text-warning font-semibold">Rotate soon</span>
                                                            </>
                                                        )}
                                                    </div>
                                                </div>
                                            </button>
                                        )
                                    })
                                )}
                            </div>
                        </>
                    )}
                </section>

                <section data-theme-part="card" className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border/40 bg-card shadow-sm">
                    {selected ? (
                        <KeyDetailPanel
                            keyData={selected}
                            health={health[selected.id]}
                            onEdit={() => handleOpenEdit(selected)}
                            onDelete={() => setDeleteConfirmation({ open: true, id: selected.id, name: selected.name })}
                            isRefreshing={isRefreshing}
                            onRefresh={() => forceRefreshAll()}
                        />
                    ) : (
                        <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
                            <Shield className="h-12 w-12 text-muted-foreground/30" />
                            <div className="space-y-1">
                                <p className="text-sm font-semibold text-muted-foreground/70">Select an entry to view details</p>
                                <p className="max-w-sm text-xs text-muted-foreground/60">
                                    Choose a vault entry from the navigation list to reveal, rotate, or edit its key information.
                                </p>
                            </div>
                            <Button size="sm" onClick={handleOpenAdd} className="gap-1.5">
                                <Plus className="h-3.5 w-3.5" /> Add Entry
                            </Button>
                        </div>
                    )}
                </section>
            </div>

            {/* Mobile/Tablet layout */}
            <div data-theme-part="card" className="lg:hidden flex flex-col flex-1 min-h-0 bg-card border border-border/40 rounded-2xl shadow-sm overflow-hidden relative">
                <div className="px-4 pt-4 pb-3 flex items-center gap-2 border-b border-border shrink-0">
                    {!mobileFilterOpen && (
                        <Button
                            variant="outline"
                            size="sm"
                            className="h-8 shrink-0 gap-1.5 rounded-lg bg-background/80 px-2.5 text-xs font-medium shadow-sm"
                            onClick={() => {
                                if (mobileDetailId) {
                                    setMobileDetailId(null)
                                } else {
                                    setMobileFilterOpen(true)
                                    setSearch('')
                                }
                            }}
                            aria-label={mobileDetailId ? "Back to key list" : "Back to vault menu"}
                        >
                            <ChevronLeft className="h-4 w-4" />
                            <span className="hidden min-[360px]:inline">Back</span>
                        </Button>
                    )}
                    <div className="flex-1 min-w-0">
                        <div className="min-w-0">
                            <h2 className="truncate text-lg font-bold tracking-tight leading-tight">
                                {mobileDetailId
                                    ? 'Key Details'
                                    : mobileFilterOpen
                                        ? 'Vault'
                                        : filterLabel}
                            </h2>
                            {!mobileDetailId && (
                                <span className="text-xs text-muted-foreground">
                                    {mobileFilterOpen
                                        ? formatEntryCount(keys.length)
                                        : formatEntryCount(visibleKeys.length)}
                                </span>
                            )}
                        </div>
                    </div>
                    {!mobileDetailId && (
                        <Button size="sm" onClick={handleOpenAdd} className="gap-1.5 px-2.5">
                            <Plus className="w-3 h-3" strokeWidth={2.5} />
                            <span className="hidden min-[360px]:inline">Add</span>
                        </Button>
                    )}
                </div>

                {!mobileFilterOpen && !mobileDetailId && (
                    <div className="px-4 pt-3 pb-2 border-b border-border/40 shrink-0">
                        <div className="flex items-center gap-2">
                            <div data-theme-part="input" className="h-8 rounded-lg bg-muted/30 border border-border/40 flex items-center px-2.5 gap-2 flex-1">
                                <Search className="w-3.5 h-3.5 text-muted-foreground" />
                                <input
                                    value={search}
                                    onChange={e => setSearch(e.target.value)}
                                    placeholder="Search vault..."
                                    className="bg-transparent outline-none flex-1 text-xs text-foreground placeholder-muted-foreground"
                                />
                                {search && (
                                    <button data-theme-part="button" onClick={() => setSearch('')} className="text-muted-foreground hover:text-foreground" aria-label="Clear search">
                                        <X className="w-3 h-3" />
                                    </button>
                                )}
                            </div>
                            <Tooltip content={entrySort === 'default' ? 'Default order' : entrySort === 'name-asc' ? 'Name A-Z' : entrySort === 'name-desc' ? 'Name Z-A' : 'Recently updated'} side="top">
                                <button
                                    data-theme-part="button"
                                    onClick={() => setEntrySort(s => s === 'default' ? 'name-asc' : s === 'name-asc' ? 'name-desc' : s === 'name-desc' ? 'updated' : 'default')}
                                    className="h-8 w-8 shrink-0 rounded-lg border border-border/40 bg-muted/30 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                                    aria-label="Toggle entry sort"
                                >
                                    {entrySort === 'default' ? <ArrowUpDown className="w-3.5 h-3.5" /> : entrySort === 'name-asc' ? <ArrowDownAZ className="w-3.5 h-3.5" /> : entrySort === 'name-desc' ? <ArrowDownAZ className="w-3.5 h-3.5 rotate-180" /> : <Clock className="w-3.5 h-3.5" />}
                                </button>
                            </Tooltip>
                        </div>
                    </div>
                )}

                <div className="flex-1 overflow-y-auto">
                    {mobileFilterOpen ? (
                        <div className="space-y-5 p-4">
                            <div className="space-y-1">
                                <Tooltip content="Quick filters for your vault entries" side="top">
                                    <div className="px-1 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground cursor-help">Smart</div>
                                </Tooltip>
                                {mobileSmartFilters.map(renderMobileMenuItem)}
                            </div>
                            <div className="space-y-1 border-t border-border/35 pt-4">
                                <Tooltip content="Filter by provider type" side="top">
                                    <div className="px-1 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground cursor-help">Categories</div>
                                </Tooltip>
                                {mobileGroupFilters.map(renderMobileMenuItem)}
                            </div>
                            <Tooltip content="Sync subscription status from all providers" side="top">
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => useProviderStore.getState().forceRefreshAll()}
                                    disabled={isRefreshing}
                                    className="h-9 w-full justify-start gap-2 text-xs text-muted-foreground"
                                >
                                    <RefreshCw className={`h-3.5 w-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
                                    Refresh All
                                </Button>
                            </Tooltip>
                            <Tooltip content="Erase every vault entry" side="top">
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => setEraseAllOpen(true)}
                                    disabled={keys.length === 0}
                                    className="h-9 w-full justify-start gap-2 text-xs text-muted-foreground hover:text-destructive"
                                >
                                    <Trash2 className="h-3.5 w-3.5" />
                                    Erase All
                                </Button>
                            </Tooltip>
                        </div>
                    ) : mobileDetailId ? (
                        <div className="relative">
                            {(() => {
                                const k = keys.find(k => k.id === mobileDetailId)
                                if (!k) return null
                                return (
                                    <KeyDetailPanel
                                        keyData={k}
                                        health={health[k.id]}
                                        onEdit={() => { handleOpenEdit(k); setMobileDetailId(null) }}
                                        onDelete={() => { setDeleteConfirmation({ open: true, id: k.id, name: k.name }); setMobileDetailId(null) }}
                                        isRefreshing={isRefreshing}
                                        onRefresh={() => forceRefreshAll()}
                                    />
                                )
                            })()}
                        </div>
                    ) : visibleKeys.length === 0 ? (
                        <div className="px-6 py-12 text-center text-xs text-muted-foreground">
                            {search ? 'No entries match your search.' : 'No entries in this group.'}
                        </div>
                    ) : (
                        visibleKeys.map(k => {
                            const h = health[k.id]
                            const providerLabel = getCompactProviderLabel(k)
                            const isExpiring = h?.status === 'active' && h.daysRemaining != null && h.daysRemaining <= 30
                            return (
                                <button
                                    key={k.id}
                                    data-theme-part="button"
                                    onClick={() => setMobileDetailId(k.id)}
                                    className="w-full text-left px-4 py-3 flex items-center gap-3 border-b border-border/40 hover:bg-muted/40 transition-colors"
                                >
                                    <ProviderTile k={k} size={36} />
                                    <div className="flex-1 min-w-0">
                                        <div className="text-sm font-medium truncate">{k.name}</div>
                                        <div className="text-xs text-muted-foreground flex min-w-0 items-center gap-1.5 mt-0.5">
                                            <StatusDot status={h?.status} daysRemaining={h?.daysRemaining} />
                                            {providerLabel && (
                                                <>
                                                    <span className="truncate">{providerLabel}</span>
                                                    <span>·</span>
                                                </>
                                            )}
                                            <span className={cn("shrink-0", providerLabel ? "hidden min-[380px]:inline" : "inline")}>{getTimeAgo(new Date(k.updatedAt))}</span>
                                            {isExpiring && <span className="shrink-0 text-warning font-semibold">· Rotate</span>}
                                        </div>
                                    </div>
                                </button>
                            )
                        })
                    )}
                </div>
            </div>

            <VaultKeyDialog
                open={isDialogOpen}
                onOpenChange={setIsDialogOpen}
                editingKey={editingKey}
                defaultGroup={activeFilter.type === 'group' ? activeFilter.name : undefined}
            />
            <ConfirmationDialog
                open={deleteConfirmation.open}
                onOpenChange={(open) => setDeleteConfirmation(prev => ({ ...prev, open }))}
                title="Remove Key"
                description={`Are you sure you want to remove "${deleteConfirmation.name}" from your vault? This cannot be undone.`}
                confirmText="Remove"
                isDestructive={true}
                isLoading={isDeleting}
                onConfirm={confirmDelete}
            />
            <ConfirmationDialog
                open={eraseAllOpen}
                onOpenChange={setEraseAllOpen}
                title="Erase All Entries"
                description={`Are you sure you want to erase all ${keys.length} vault entries? This cannot be undone.`}
                confirmText="Erase All"
                isDestructive={true}
                isLoading={isErasing}
                disabled={keys.length === 0}
                onConfirm={confirmEraseAll}
            />
        </div>
        </div>
    )
}
