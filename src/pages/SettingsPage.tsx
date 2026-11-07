import { useState, useRef, useEffect, useMemo, useCallback, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { cn } from '@/lib/utils'
import { isSyncioExport, parseSyncioExport } from '@/lib/syncio-import'
import { readAccountImport } from '@/lib/account-membership'
import { useTheme } from '@/contexts/ThemeContext'
import { useAccountStore } from '@/store/accountStore'
import { useAddonStore } from '@/store/addonStore'
import { useLibraryCache } from '@/store/libraryCache'
import { useUIStore } from '@/store/uiStore'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/hooks/use-toast'
import { useDocumentTitle } from '@/hooks/use-document-title'
import { SquircleOverlay } from '@/components/ui/squircle-overlay'
import {
    AlertDialog,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
    Trash2,
    Database,
    EyeOff,
    Download,
    Upload,
    ChevronLeft,
    AlertTriangle,
    CheckCircle2,
    ChevronRight,
    FileJson,
    Activity,
    Info,
    KeyRound,
    Palette,
    User,
    Wrench,
    Zap,
} from 'lucide-react'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog'
import { PrivacyControls } from '@/components/settings/PrivacyControls'
import { canInstall, subscribeInstall } from '@/lib/pwa'

import { SyncDiagnostics } from '@/components/settings/SyncDiagnostics'

import { AccountSection } from '@/components/settings/AccountSection'
import { SyncSummarySection } from '@/components/settings/SyncSummarySection'
import { AutoUpdateSection } from '@/components/settings/AutoUpdateSection'
import { NotificationsSection } from '@/components/settings/NotificationsSection'
import { ThemeSection } from '@/components/settings/ThemeSection'
import { DangerZone } from '@/components/settings/DangerZone'
import { InstallAppCard } from '@/components/settings/InstallAppCard'
import { RepairTools } from '@/components/settings/RepairTools'
import { IntegrationsSection } from '@/components/settings/IntegrationsSection'
import { ApiKeysSection } from '@/components/settings/ApiKeysSection'
import { RememberedDevicesSection } from '@/components/settings/RememberedDevicesSection'
import { SettingsSearch, resolveSectionElement, searchSettings, SETTING_PAGE_LABELS, type SettingSearchEntry } from '@/components/settings/SettingsNavigation'
import { SettingsRootList } from '@/components/settings/SettingsRootList'
import { SettingsGroup, SettingsGroupFooter, SettingsRow } from '@/components/settings/SettingsRows'
import { nextLegacyJump, resolveSelectedPage, resolveSettingsPage, stripFadeState, stripWheelTarget, SETTINGS_TAB_SHORT_LABELS, type SettingsPageId, type SettingsPageSelection } from '@/components/settings/settings-model'
import { ToolbarShell } from '@/components/ui/toolbar-shell'
import { DashboardEntry } from '@/components/common/DashboardEntry'

type ImportPreview = {
    hasAccounts: boolean
    fileName: string
    sizeLabel: string
    version?: string
    exportedAt?: string
    counts: {
        accounts: number
        matchingAccounts: number
        savedAddons: number
        profiles: number
        failoverRules: number
        accountStates: number
        vaultKeys: number | string
        changelog: number
        settings: number
        watchEvents: number
    }
    warnings: string[]
    errors: string[]
}

type PendingImport = {
    text: string
    preview: ImportPreview
}

const asArray = (value: unknown): unknown[] => {
    if (Array.isArray(value)) return value
    if (value && typeof value === 'object') return Object.values(value)
    return []
}

const getPreviewAccounts = (data: Record<string, unknown>) => {
    return readAccountImport(data) || []
}

const getPreviewSavedAddons = (data: Record<string, unknown>) => asArray(
    data?.savedAddons ||
    data?.['stremio-manager:addon-library'] ||
    data?.templates ||
    (data?.addons as Record<string, unknown> | undefined)?.savedAddons ||
    (Array.isArray(data) ? data : null)
)

const getPreviewProfiles = (data: Record<string, unknown>) => asArray(data?.profiles || data?.['stremio-manager:profiles'])

const getPreviewFailoverRules = (data: Record<string, unknown>) => {
    if (Array.isArray(data?.failover)) return data.failover as unknown[]
    return asArray((data?.failover as Record<string, unknown> | undefined)?.rules || data?.['stremio-manager:failover-rules'])
}

const formatFileSize = (size: number) => {
    if (size < 1024) return `${size} B`
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
    return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

const BACKUP_SECTIONS = [
    { key: 'accounts', label: 'Accounts & Connections', description: 'Stremio/Nuvio accounts, auth keys, addon configs' },
    { key: 'library', label: 'Saved Addons', description: 'Library snapshots, profiles, tags' },
    { key: 'vault', label: 'Vault Keys', description: 'Debrid service credentials' },
    { key: 'failover', label: 'Autopilot Rules', description: 'Failover rules and webhook config' },
    { key: 'settings', label: 'Settings & Themes', description: 'App settings, privacy, custom themes' },
    { key: 'notes', label: 'Notes', description: 'Sticky notes and trash' },
]

function applySectionFilter(data: Record<string, unknown>, sections: Set<string>): void {
    if (!sections.has('accounts')) { delete data.accounts; delete data.deletedAccounts; delete data.restoredAccounts; delete data.manifests; delete data.apiKeys; delete data.watchEvents; delete data.watchSnapshot }
    if (!sections.has('library')) { delete data.addons; delete data.accountStates; delete data.profiles }
    if (!sections.has('vault')) { delete data.vault; delete data.vaultTombstones }
    if (!sections.has('failover')) { delete data.failover }
    if (!sections.has('settings')) { delete data.settings; delete data.customThemes; delete data.changelog; delete data.identity }
    if (!sections.has('notes')) { delete data.notes; delete data.notesTrash }
}

// Desktop renders the tab layout at lg and up; below lg the phone home list applies.
const DESKTOP_QUERY = '(min-width: 1024px)'
const subscribeDesktop = (notify: () => void) => {
    const query = window.matchMedia(DESKTOP_QUERY)
    query.addEventListener('change', notify)
    return () => query.removeEventListener('change', notify)
}
const isDesktopNow = () => window.matchMedia(DESKTOP_QUERY).matches

/** Desktop tabs: the five regroup A pages plus a set-apart Danger zone. */
const SETTINGS_TABS: readonly { id: SettingsPageId; icon: typeof User }[] = [
    { id: 'account-sync', icon: User },
    { id: 'appearance-privacy', icon: Palette },
    { id: 'keys', icon: KeyRound },
    { id: 'updates-activity', icon: Zap },
    { id: 'devices-maintenance', icon: Wrench },
    { id: 'danger-zone', icon: AlertTriangle },
]

export function SettingsPage() {
    useDocumentTitle('Settings')
    const { theme, setTheme } = useTheme()
    const accounts = useAccountStore(s => s.accounts)
    const exportAccounts = useAccountStore(s => s.exportAccounts)
    const importAccounts = useAccountStore(s => s.importAccounts)
    const initializeAddonStore = useAddonStore(s => s.initialize)
    const isPrivacyModeEnabled = useUIStore(s => s.isPrivacyModeEnabled)
    const togglePrivacyMode = useUIStore(s => s.togglePrivacyMode)
    const liveActivity = useUIStore(s => s.liveActivity)
    const setLiveActivity = useUIStore(s => s.setLiveActivity)
    const privacyLevelNames = useUIStore(s => s.privacyLevelNames)
    const privacyLevelUrls = useUIStore(s => s.privacyLevelUrls)
    const privacyLevelProfiles = useUIStore(s => s.privacyLevelProfiles)
    const privacyLevelEmail = useUIStore(s => s.privacyLevelEmail)
    const setPrivacyOption = useUIStore(s => s.setPrivacyOption)
    const { clear: clearLibraryCache, invalidate } = useLibraryCache()

    // Same availability rule as InstallAppCard: the section only renders when the browser can install.
    const [installable, setInstallable] = useState(canInstall())
    useEffect(() => subscribeInstall(setInstallable), [])
    // Same emptiness rule as SyncSummarySection; the anchor wrapper stays in the
    // DOM (empty:hidden) so search jumps always find it.
    const library = useAddonStore(s => s.library)
    const hasSyncedAddons = useMemo(() => Object.values(library).some(addon => addon.syncWithInstalled), [library])

    const location = useLocation()
    const navigate = useNavigate()
    // The selected page lives in the hash like the old tabs did; legacy tab ids
    // (general/appearance/data/advanced) resolve through settings-model so
    // existing /settings#... deep links still land on the right section.
    const hash = location.hash.slice(1)
    const page = resolveSettingsPage(hash)

    const navigateToPage = (next: SettingsPageSelection, replace = false) => {
        if (next === resolveSettingsPage(location.hash.slice(1))) return
        navigate({ pathname: location.pathname, search: location.search, hash: next === 'root' ? '' : `#${next}` }, { preventScrollReset: true, replace })
    }

    // Desktop tabs share the hash routing: /settings with no hash opens the
    // first tab, legacy tab ids resolve through settings-model. Tab switches
    // replace history so arrowing across tabs never stacks back steps.
    const isDesktop = useSyncExternalStore(subscribeDesktop, isDesktopNow, isDesktopNow)
    const activeTab = resolveSelectedPage(hash, true) ?? 'account-sync'
    const handleTabChange = (next: string) => {
        if (next === activeTab) return
        navigateToPage(next as SettingsPageId, true)
    }
    // The app header is sticky and its nav row can wrap, so the bar pins below
    // the measured header height and section jumps clear the whole chrome.
    const [headerHeight, setHeaderHeight] = useState(105)
    useEffect(() => {
        const header = document.querySelector('header')
        if (!header) return
        const update = () => setHeaderHeight(header.getBoundingClientRect().height)
        update()
        const observer = new ResizeObserver(update)
        observer.observe(header)
        return () => observer.disconnect()
    }, [])
    // Tab strip overflow: edge fades signal hidden tabs and the wheel scrolls
    // the strip horizontally instead of the page.
    const tabStripRef = useRef<HTMLDivElement>(null)
    const [stripScroll, setStripScroll] = useState({ left: false, right: false })
    const updateStripScroll = useCallback(() => {
        const el = tabStripRef.current
        if (!el) return
        setStripScroll(stripFadeState(el.scrollLeft, el.clientWidth, el.scrollWidth))
    }, [])
    useEffect(() => {
        const el = tabStripRef.current
        if (!el) return
        updateStripScroll()
        const onWheel = (event: WheelEvent) => {
            const target = stripWheelTarget(el.scrollLeft, event.deltaY, el.scrollWidth - el.clientWidth)
            if (target === null) return
            event.preventDefault()
            el.scrollLeft = target
        }
        el.addEventListener('wheel', onWheel, { passive: false })
        window.addEventListener('resize', updateStripScroll)
        return () => {
            el.removeEventListener('wheel', onWheel)
            window.removeEventListener('resize', updateStripScroll)
        }
    }, [updateStripScroll, isDesktop, activeTab])

    // "Find a setting" search destination. The search itself lives in
    // SettingsNavigation; this only routes to the EXISTING page + section so
    // the URL-driven page history keeps working exactly as before.
    const [pendingDestination, setPendingDestination] = useState<{
        anchor: string
        heading?: string
        page: SettingsPageId
    } | null>(null)
    const [highlightedAnchor, setHighlightedAnchor] = useState<string | null>(null)

    // Live query from the search field; non-empty queries filter the home list.
    const [rowQuery, setRowQuery] = useState('')
    const filterPages = useMemo(() => {
        if (!rowQuery.trim()) return null
        return searchSettings(rowQuery, 100).reduce((set, match) => set.add(match.entry.page), new Set<SettingsPageId>())
    }, [rowQuery])

    // A legacy deep link (#about, #repair, #notifications, ...) also names the
    // section it used to open, so queue the scroll-and-highlight flow for it.
    // Only consecutive identical hashes dedupe: moving away re-arms the guard.
    const handledLegacyHash = useRef<string | null>(null)
    useEffect(() => {
        const current = location.hash.slice(1)
        const jump = nextLegacyJump(handledLegacyHash.current, current)
        handledLegacyHash.current = current
        if (jump?.anchor) setPendingDestination({ anchor: jump.anchor, heading: undefined, page: jump.page })
    }, [location.hash])

    const handleSearchNavigate = (entry: SettingSearchEntry) => {
        setPendingDestination({ anchor: entry.anchor ?? entry.id, heading: entry.heading, page: entry.page })
        setRowQuery('')
        if (entry.page !== page) navigateToPage(entry.page)
    }

    useEffect(() => {
        if (!pendingDestination || pendingDestination.page !== page) return
        let cancelled = false
        const startedAt = performance.now()
        const tryFocusDestination = () => {
            if (cancelled) return
            const target = resolveSectionElement(pendingDestination.anchor, pendingDestination.heading)
            if (target) {
                target.scrollIntoView({ behavior: 'smooth', block: 'start' })
                target.setAttribute('tabindex', '-1')
                target.focus({ preventScroll: true })
                setHighlightedAnchor(pendingDestination.anchor)
                setPendingDestination(null)
            } else if (performance.now() - startedAt < 1500) {
                requestAnimationFrame(tryFocusDestination)
            } else {
                setPendingDestination(null)
            }
        }
        requestAnimationFrame(tryFocusDestination)
        return () => { cancelled = true }
    }, [page, pendingDestination])

    useEffect(() => {
        if (!highlightedAnchor) return
        const timeout = setTimeout(() => setHighlightedAnchor(null), 2200)
        return () => clearTimeout(timeout)
    }, [highlightedAnchor])

    const sectionAnchorClass = (anchor: string) =>
        cn(
            'scroll-mt-24 lg:scroll-mt-[var(--settings-scroll-clear)] rounded-3xl transition-shadow duration-700',
            highlightedAnchor === anchor && 'ring-2 ring-primary/40 ring-offset-4 ring-offset-background'
        )

    // Sentence-case heading above each section on the regrouped pages.
    const sectionHeading = (label: string) => (
        <h3 className="mb-2 text-xs font-semibold text-muted-foreground">{label}</h3>
    )

    const [showClearCacheConfirm, setShowClearCacheConfirm] = useState(false)
    const [isClearingCache, setIsClearingCache] = useState(false)

    const [exporting, setExporting] = useState(false)
    const [importing, setImporting] = useState(false)
    const [pendingImport, setPendingImport] = useState<PendingImport | null>(null)
    const [importAccountMode, setImportAccountMode] = useState<'merge' | 'restore'>('merge')
    const fileInputRef = useRef<HTMLInputElement>(null)
    const [showExportDialog, setShowExportDialog] = useState(false)
    const [exportSections, setExportSections] = useState<Set<string>>(new Set(['accounts', 'library', 'vault', 'failover', 'settings', 'notes']))
    const [importSections, setImportSections] = useState<Set<string>>(new Set(['accounts', 'library', 'vault', 'failover', 'settings', 'notes']))

    const toggleExportSection = (key: string) => {
        setExportSections(prev => {
            const next = new Set(prev)
            if (next.has(key)) next.delete(key)
            else next.add(key)
            return next
        })
    }

    const toggleImportSection = (key: string) => {
        setImportSections(prev => {
            const next = new Set(prev)
            if (next.has(key)) next.delete(key)
            else next.add(key)
            return next
        })
    }

    const filterExportJson = (json: string, sections: Set<string>): string => {
        const data = JSON.parse(json) as Record<string, unknown>
        applySectionFilter(data, sections)
        return JSON.stringify(data, null, 2)
    }

    const filterImportJson = (json: string, sections: Set<string>): string => {
        const data = JSON.parse(json) as Record<string, unknown>
        applySectionFilter(data, sections)
        return JSON.stringify(data, null, 2)
    }

    const resetFileInput = () => {
        if (fileInputRef.current) {
            fileInputRef.current.value = ''
        }
    }

    const buildImportPreview = (data: Record<string, unknown>, file: File): ImportPreview => {
        const errors: string[] = []
        const warnings: string[] = []
        const incomingAccounts = getPreviewAccounts(data)
        const savedAddons = getPreviewSavedAddons(data)
        const profiles = getPreviewProfiles(data)
        const failoverRules = getPreviewFailoverRules(data)
        const accountStates = data?.accountStates && typeof data.accountStates === 'object'
            ? Object.keys(data.accountStates).length
            : 0
        const vaultKeys = data?.vault !== undefined ? asArray(data.vault).length : 'N/A'
        const changelog = asArray(data?.changelog).length
        const settings = data?.settings && typeof data.settings === 'object'
            ? Object.keys(data.settings).length
            : 0
        const watchEvents = asArray(data?.watchEvents).length
        const matchingAccounts = incomingAccounts.filter((incoming) =>
            accounts.some(a => {
                const inc = incoming as Record<string, unknown>
                return a.id === inc.id || (!!a.email && typeof inc.email === 'string' && !!inc.email && a.email.toLowerCase() === inc.email.toLowerCase())
            })
        ).length
        const missingCredentials = (incomingAccounts as Record<string, unknown>[]).filter((incoming) => !incoming.authKey).length
        const invalidSavedAddonUrls = (savedAddons as Record<string, unknown>[]).filter((addon) => {
            if (!addon?.installUrl) return true
            try {
                const parsed = new URL(addon.installUrl as string)
                return !['http:', 'https:'].includes(parsed.protocol)
            } catch {
                return true
            }
        }).length

        const recognizedTotal =
            incomingAccounts.length +
            savedAddons.length +
            profiles.length +
            failoverRules.length +
            accountStates +
            (typeof vaultKeys === 'number' ? vaultKeys : 0) +
            changelog +
            settings +
            watchEvents

        if (recognizedTotal === 0 && data.accounts === undefined) {
            errors.push('No recognizable AIOManager data was found in this JSON file.')
        }
        if (data.accounts === undefined) {
            warnings.push('This backup does not include accounts; it may only restore library data, settings, or diagnostics.')
        }
        if (missingCredentials > 0) {
            warnings.push(`${missingCredentials} account${missingCredentials !== 1 ? 's are' : ' is'} missing auth keys and may need to be re-authenticated after import.`)
        }
        if (invalidSavedAddonUrls > 0) {
            warnings.push(`${invalidSavedAddonUrls} saved addon${invalidSavedAddonUrls !== 1 ? 's have' : ' has'} invalid install URLs and will be skipped.`)
        }
        if (settings > 0) {
            warnings.push('Imported settings can update theme, privacy mode, library view, and custom themes.')
        }
        if (!data?.version) {
            warnings.push('This backup has no version marker; the importer will use compatibility recovery where possible.')
        }

        return {
            hasAccounts: data.accounts !== undefined,
            fileName: file.name,
            sizeLabel: formatFileSize(file.size),
            version: typeof data?.version === 'string' ? data.version : undefined,
            exportedAt: typeof data?.exportedAt === 'string' ? data.exportedAt : undefined,
            counts: {
                accounts: incomingAccounts.length,
                matchingAccounts,
                savedAddons: savedAddons.length,
                profiles: profiles.length,
                failoverRules: failoverRules.length,
                accountStates,
                vaultKeys,
                changelog,
                settings,
                watchEvents,
            },
            warnings,
            errors,
        }
    }

    const handleExport = () => {
        setExportSections(new Set(['accounts', 'library', 'vault', 'failover', 'settings', 'notes']))
        setShowExportDialog(true)
    }

    const handleConfirmExport = async () => {
        setExporting(true)
        try {
            const json = await exportAccounts(true)
            const filtered = filterExportJson(json, exportSections)

            const blob = new Blob([filtered], { type: 'application/json' })
            const url = URL.createObjectURL(blob)
            const now = new Date()
            const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`

            const a = document.createElement('a')
            a.href = url
            a.download = `AIOManager-Backup-${timestamp}.json`
            document.body.appendChild(a)
            a.click()
            document.body.removeChild(a)
            URL.revokeObjectURL(url)

            toast({ title: 'Export Complete', description: 'Data downloaded.' })
            setShowExportDialog(false)
        } catch (error) {
            if (import.meta.env.DEV) console.error('Export failed:', error)
            toast({ variant: 'destructive', title: 'Export Failed', description: 'Could not export data.' })
        } finally {
            setExporting(false)
        }
    }

    const handleImportClick = () => {
        fileInputRef.current?.click()
    }

    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0]
        if (!file) return

        if (file.size > 100 * 1024 * 1024) {
            toast({ variant: 'destructive', title: 'File Too Large', description: 'Import file must be under 100MB.' })
            resetFileInput()
            return
        }

        if (file.type !== 'application/json' && !file.name.endsWith('.json')) {
            toast({ variant: 'destructive', title: 'Invalid File', description: 'Select a valid JSON file.' })
            resetFileInput()
            return
        }

        try {
            let text = await file.text()
            let data: Record<string, unknown>
            try {
                data = JSON.parse(text) as Record<string, unknown>
            } catch {
                throw new Error('Invalid JSON format for import')
            }

            if (isSyncioExport(data)) {
                const { accounts: syncioAccounts, skipped } = parseSyncioExport(data)
                if (syncioAccounts.length === 0) {
                    throw new Error('No accounts with auth keys found in Syncio export')
                }
                data = {
                    accounts: syncioAccounts.map(a => ({
                        type: 'stremio',
                        authKey: a.authKey,
                        email: a.email,
                        name: a.name,
                    }))
                }
                text = JSON.stringify(data)
                if (skipped > 0) {
                    toast({ title: 'Syncio export detected', description: `Importing ${syncioAccounts.length} accounts, ${skipped} skipped (no auth key).` })
                }
            }

            const preview = buildImportPreview(data, file)
            if (preview.errors.length > 0) {
                toast({ variant: 'destructive', title: 'Import Blocked', description: preview.errors[0] })
                return
            }
            setPendingImport({ text, preview })
            setImportAccountMode('merge')
            setImportSections(new Set(['accounts', 'library', 'vault', 'failover', 'settings', 'notes']))
        } catch (error) {
            if (import.meta.env.DEV) console.error('Import preview failed:', error)
            toast({ variant: 'destructive', title: 'Import Failed', description: error instanceof Error ? error.message : 'Failed to read import file' })
        } finally {
            resetFileInput()
        }
    }

    const handleConfirmImport = async () => {
        if (!pendingImport) return

        setImporting(true)
        try {
            const filtered = filterImportJson(pendingImport.text, importSections)
            await importAccounts(filtered, false, 'merge', undefined, undefined, importAccountMode)
            await initializeAddonStore()
            const accountCount = useAccountStore.getState().accounts.length
            const restoredAccounts = importSections.has('accounts') && pendingImport.preview.hasAccounts && importAccountMode === 'restore'
            toast({ title: 'Import Successful', description: restoredAccounts ? `Account list restored: ${accountCount} accounts. Other selected data was merged.` : `Selected data merged. You now have ${accountCount} accounts; existing accounts were kept.` })
            setPendingImport(null)
        } catch (error) {
            if (import.meta.env.DEV) console.error('Import failed:', error)
            toast({ variant: 'destructive', title: 'Import Failed', description: error instanceof Error ? error.message : 'Failed to import accounts' })
        } finally {
            setImporting(false)
        }
    }

    const handleClearActivity = () => {
        setShowClearCacheConfirm(true)
    }

    const handleConfirmClearCache = async () => {
        setIsClearingCache(true)
        try {
            await clearLibraryCache()
            const { useWatchEventStore } = await import('@/store/watchEventStore')
            useWatchEventStore.getState().reset()
            invalidate()
            setShowClearCacheConfirm(false)
            toast({ title: 'Activity Cleared', description: 'Watch history cache and event log have been cleared. Sync to rebuild.' })
        } catch (error) {
            if (import.meta.env.DEV) console.error('Clear history cache failed:', error)
            toast({ variant: 'destructive', title: 'Clear Failed', description: 'Could not clear the history cache. Nothing was removed.' })
        } finally {
            setIsClearingCache(false)
        }
    }

    // Per-page section stacks, shared by the phone drill-in pages and the desktop tabs.
    const renderAccountSyncSections = () => (
        <>
            <div data-settings-anchor="sync-identity" className={sectionAnchorClass('sync-identity')}>
                {sectionHeading('Sync identity')}
                <AccountSection />
            </div>
            <div data-settings-anchor="sync-connections" className={cn(sectionAnchorClass('sync-connections'), 'empty:hidden')}>
                {hasSyncedAddons && (
                    <>
                        {sectionHeading('Sync connections')}
                        <SyncSummarySection />
                    </>
                )}
            </div>
            <div data-settings-anchor="backup-restore" className={sectionAnchorClass('backup-restore')}>
                <div data-theme-part="panel" className="flex flex-col justify-between gap-4 sm:gap-5 rounded-[1.75rem] border border-border/45 bg-card/80 p-4 sm:p-5 lg:p-6 shadow-sm md:flex-row md:items-center">
                    <div className="flex flex-1 items-start gap-4">
                        <div className="relative mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-border/35 bg-muted/25">
                            <SquircleOverlay />
                            <Database className="relative z-10 h-4 w-4 text-muted-foreground" />
                        </div>
                        <div className="space-y-1">
                            <h3 className="text-base font-semibold">Backup & Restore</h3>
                            <p className="text-sm text-muted-foreground max-w-md">
                                Export your configuration to a JSON file, or restore a saved backup.
                            </p>
                        </div>
                    </div>
                    <div className="grid shrink-0 grid-cols-2 gap-2 sm:flex">
                        <Button variant="outline" onClick={handleExport} disabled={exporting} className="w-full gap-2 sm:w-auto">
                            <Download className="h-4 w-4" />
                            {exporting ? 'Exporting...' : 'Export'}
                        </Button>
                        <Button variant="outline" onClick={handleImportClick} disabled={importing} className="w-full gap-2 sm:w-auto">
                            <Upload className="h-4 w-4" />
                            {importing ? 'Importing...' : 'Import'}
                        </Button>
                    </div>
                </div>
                <input
                    ref={fileInputRef}
                    type="file"
                    accept=".json,application/json"
                    onChange={handleFileChange}
                    className="hidden"
                />
            </div>

            <div data-settings-anchor="about" className={sectionAnchorClass('about')}>
                <div data-theme-part="panel" className="flex flex-col gap-4 rounded-[1.75rem] border border-border/45 bg-card/80 p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between sm:p-5 lg:p-6">
                    <div className="flex items-center gap-3">
                        <div className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl border border-border/35 bg-muted/25 sm:h-10 sm:w-10">
                            <SquircleOverlay />
                            <Info className="relative z-10 h-4 w-4 text-muted-foreground" />
                        </div>
                        <div>
                            <h3 className="text-base font-semibold">About</h3>
                            <p className="text-xs lg:text-sm text-muted-foreground">Version & build information</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-6 text-sm">
                        <div>
                            <p className="text-xs text-muted-foreground">Version</p>
                            <p className="mt-1 font-medium">{__BUILD_VERSION__}</p>
                        </div>
                        <Tooltip content="Click to copy the build identifier" side="top">
                            <button
                                type="button"
                                onClick={async () => {
                                    try {
                                        await navigator.clipboard.writeText(__BUILD_COMMIT__)
                                        toast({ title: 'Copied', description: 'Build identifier copied to clipboard.' })
                                    } catch {
                                        toast({ variant: 'destructive', title: 'Could not copy build identifier' })
                                    }
                                }}
                                className="rounded-md text-left transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-card"
                                data-theme-part="inline-action"
                                aria-label="Copy build identifier"
                            >
                                <span className="block text-xs text-muted-foreground">Build</span>
                                <span className="mt-1 block font-mono font-medium">{__BUILD_COMMIT__.slice(0, 7)}</span>
                            </button>
                        </Tooltip>
                    </div>
                </div>
            </div>
        </>
    )

    const renderAppearancePrivacySections = () => (
        <>
            <div data-settings-anchor="themes" className={sectionAnchorClass('themes')}>
                {sectionHeading('Theme')}
                <ThemeSection theme={theme} setTheme={setTheme} />
            </div>

            <div data-settings-anchor="privacy-mode" className={sectionAnchorClass('privacy-mode')}>
                {sectionHeading('Privacy mode')}
                <SettingsGroup>
                    <SettingsRow
                        icon={EyeOff}
                        label="Privacy mode"
                        htmlFor="privacy-mode"
                        trailing={
                            <Switch
                                id="privacy-mode"
                                checked={isPrivacyModeEnabled}
                                onCheckedChange={togglePrivacyMode}
                            />
                        }
                    />
                    <AnimatePresence initial={false}>
                        {isPrivacyModeEnabled && (
                            <motion.div
                                initial={{ height: 0, opacity: 0 }}
                                animate={{ height: 'auto', opacity: 1 }}
                                exit={{ height: 0, opacity: 0 }}
                                transition={{ duration: 0.36, ease: [0.38, 0.8, 0.32, 1.07] }}
                                className="overflow-hidden"
                            >
                                <PrivacyControls
                                    namesLevel={privacyLevelNames}
                                    urlsLevel={privacyLevelUrls}
                                    profilesLevel={privacyLevelProfiles}
                                    emailLevel={privacyLevelEmail}
                                    onChange={setPrivacyOption}
                                />
                            </motion.div>
                        )}
                    </AnimatePresence>
                    <SettingsGroupFooter>
                        Control how sensitive data appears across AIOManager
                    </SettingsGroupFooter>
                </SettingsGroup>
            </div>

            {installable && (
                <div data-settings-anchor="install-app" className={sectionAnchorClass('install-app')}>
                    {sectionHeading('Install the app')}
                    <InstallAppCard />
                </div>
            )}
        </>
    )

    const renderKeysSections = () => (
        <>
            <div data-settings-anchor="metadata-integrations" className={sectionAnchorClass('metadata-integrations')}>
                <IntegrationsSection />
            </div>

            <div data-settings-anchor="api-keys" className={sectionAnchorClass('api-keys')}>
                <ApiKeysSection />
            </div>
        </>
    )

    const renderUpdatesActivitySections = () => (
        <>
            <div data-settings-anchor="auto-update" className={sectionAnchorClass('auto-update')}>
                {sectionHeading('Auto-update')}
                <AutoUpdateSection />
            </div>

            <div data-settings-anchor="live-activity" className={sectionAnchorClass('live-activity')}>
                {sectionHeading('Live activity refresh')}
                <SettingsGroup>
                    <SettingsRow
                        icon={Activity}
                        label="Live activity refresh"
                        htmlFor="live-activity"
                        trailing={
                            <Switch
                                id="live-activity"
                                checked={liveActivity}
                                onCheckedChange={setLiveActivity}
                            />
                        }
                    />
                    <SettingsGroupFooter>
                        {liveActivity
                            ? (accounts.length > 10
                                ? <span className="text-warning/80">You have {accounts.length} accounts. Live refresh will send ~{accounts.length} requests to Stremio every 60 seconds ({accounts.length * 60} requests/hour). This may trigger rate limits.</span>
                                : <>Refresh progress every minute while Activity is open. Each refresh sends 1 request per account to Stremio. With {accounts.length} account{accounts.length !== 1 ? 's' : ''}, that's ~{accounts.length} requests every 60 seconds.</>
                            )
                            : 'Refresh progress every minute while Activity is open'}
                    </SettingsGroupFooter>
                </SettingsGroup>
            </div>

            <div data-settings-anchor="monitoring-alerts" className={sectionAnchorClass('monitoring-alerts')}>
                <NotificationsSection />
            </div>

            <div data-settings-anchor="history-cache" className={sectionAnchorClass('history-cache')}>
                {sectionHeading('History cache')}
                <SettingsGroup>
                    <SettingsRow
                        icon={Trash2}
                        label="Clear history cache"
                        trailing={
                            <Button variant="outline" onClick={handleClearActivity} className="h-8 shrink-0 gap-2 px-3 text-xs">
                                <Trash2 className="h-4 w-4" />
                                Clear Cache
                            </Button>
                        }
                    />
                    <SettingsGroupFooter>
                        Clear local activity and watch events. Sync again to rebuild the cache from your accounts.
                    </SettingsGroupFooter>
                </SettingsGroup>
            </div>
        </>
    )

    const renderDevicesMaintenanceSections = () => (
        <>
            <div data-settings-anchor="remembered-devices" className={sectionAnchorClass('remembered-devices')}>
                <RememberedDevicesSection />
            </div>

            <div data-settings-anchor="sync-diagnostics" className={sectionAnchorClass('sync-diagnostics')}>
                {sectionHeading('Diagnostics')}
                <SyncDiagnostics />
            </div>

            <div data-settings-anchor="repair-recovery" className={sectionAnchorClass('repair-recovery')}>
                {sectionHeading('Repair')}
                <RepairTools />
            </div>
        </>
    )

    const renderDangerZoneSections = () => (
        <div data-settings-anchor="danger-zone" className={sectionAnchorClass('danger-zone')}>
            <DangerZone />
        </div>
    )

    // The page sections render as ONE tree for the selected page regardless of
    // breakpoint; only the navigation chrome above swaps (tab bar vs home list
    // or back header), so crossing lg never remounts the page or loses input.
    const selectedPage = resolveSelectedPage(hash, isDesktop)

    return (
        <div className="min-w-0" style={{ '--settings-scroll-clear': `${headerHeight + 132}px` } as CSSProperties}>
            <DashboardEntry className="mb-3 ml-auto flex w-fit" />
            {isDesktop && <h1 className="sr-only">Settings</h1>}
            {isDesktop ? (
                <Tabs value={activeTab} onValueChange={handleTabChange} className="w-full">
                    <div className="sticky z-30 -mx-4 bg-background/95 px-4 py-3 backdrop-blur-sm" style={{ top: headerHeight }}>
                        <div className="flex items-stretch gap-3">
                            <div className="relative min-w-0 max-w-fit flex-1">
                                <TabsList ref={tabStripRef} onScroll={updateStripScroll} className="w-full min-w-0 flex-nowrap overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                                    {SETTINGS_TABS.map(tab => {
                                        const Icon = tab.icon
                                        return (
                                            <TabsTrigger
                                                key={tab.id}
                                                value={tab.id}
                                                className={cn(
                                                    'h-8 px-4 text-xs',
                                                    tab.id === 'danger-zone' ? '[&_svg]:text-destructive' : undefined,
                                                )}
                                            >
                                                <Icon className="h-3.5 w-3.5" />
                                                {SETTINGS_TAB_SHORT_LABELS[tab.id]}
                                            </TabsTrigger>
                                        )
                                    }).reduce((nodes, trigger, index) => {
                                        if (index === SETTINGS_TABS.length - 1) nodes.push(<span key="danger-divider" aria-hidden className="mx-1 h-6 w-px shrink-0 bg-border/60" />)
                                        nodes.push(trigger)
                                        return nodes
                                    }, [] as ReactNode[])}
                                </TabsList>
                                <span aria-hidden className={cn('pointer-events-none absolute inset-y-px left-px w-12 rounded-l-2xl bg-gradient-to-r from-card from-40% to-transparent transition-opacity', stripScroll.left ? 'opacity-100' : 'opacity-0')} />
                                <span aria-hidden className={cn('pointer-events-none absolute inset-y-px right-px w-12 rounded-r-2xl bg-gradient-to-l from-card from-40% to-transparent transition-opacity', stripScroll.right ? 'opacity-100' : 'opacity-0')} />
                                {stripScroll.left && (
                                    <button
                                        type="button"
                                        aria-label="Scroll settings tabs left"
                                        onClick={() => tabStripRef.current?.scrollBy({ left: -180, behavior: 'smooth' })}
                                        className="absolute left-0.5 top-1/2 z-10 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full border border-border/50 bg-card shadow-sm hover:bg-muted/50"
                                    >
                                        <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
                                    </button>
                                )}
                                {stripScroll.right && (
                                    <button
                                        type="button"
                                        aria-label="Scroll settings tabs right"
                                        onClick={() => tabStripRef.current?.scrollBy({ left: 180, behavior: 'smooth' })}
                                        className="absolute right-0.5 top-1/2 z-10 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full border border-border/50 bg-card shadow-sm hover:bg-muted/50"
                                    >
                                        <ChevronRight className="h-3.5 w-3.5" aria-hidden />
                                    </button>
                                )}
                            </div>
                            <div className="ml-auto flex shrink-0 items-center rounded-2xl border border-border/40 bg-card p-1.5 shadow-sm">
                                <SettingsSearch compact className="w-56" popoverClassName="left-auto right-0 w-[22rem]" onNavigate={handleSearchNavigate} />
                            </div>
                        </div>
                    </div>
                </Tabs>
            ) : selectedPage === null ? (
                <div className="min-w-0">
                    <div className="mb-4 flex items-baseline gap-2">
                        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
                        <span className="text-xs font-medium text-muted-foreground">v{__BUILD_VERSION__}</span>
                    </div>
                    <ToolbarShell className="w-full p-3 min-h-16" contentClassName="w-full">
                        <SettingsSearch className="w-full" onNavigate={handleSearchNavigate} onQueryChange={setRowQuery} />
                    </ToolbarShell>
                    <SettingsRootList
                        activePage={page}
                        onSelect={navigateToPage}
                        filterPages={filterPages}
                        className="mt-4"
                    />
                </div>
            ) : (
                <div className="flex items-center gap-1.5">
                    <button
                        type="button"
                        onClick={() => navigateToPage('root')}
                        aria-label="Back to settings"
                        className="flex h-11 min-w-[64px] items-center gap-0.5 rounded-full pl-1 pr-1.5 text-sm font-semibold text-primary transition-colors hover:bg-primary/10"
                    >
                        <ChevronLeft className="h-4 w-4" aria-hidden />
                        Settings
                    </button>
                    <h1 className="min-w-0 flex-1 truncate text-center text-base font-bold">{SETTING_PAGE_LABELS[selectedPage]}</h1>
                    <span className="min-w-[64px]" aria-hidden />
                </div>
            )}

            {selectedPage !== null && (
                <div className="mt-4 min-w-0 space-y-4 sm:space-y-6">
                    {selectedPage === 'account-sync' && renderAccountSyncSections()}
                    {selectedPage === 'appearance-privacy' && renderAppearancePrivacySections()}
                    {selectedPage === 'keys' && renderKeysSections()}
                    {selectedPage === 'updates-activity' && renderUpdatesActivitySections()}
                    {selectedPage === 'devices-maintenance' && renderDevicesMaintenanceSections()}
                    {selectedPage === 'danger-zone' && renderDangerZoneSections()}
                </div>
            )}

            <AlertDialog
                open={!!pendingImport}
                onOpenChange={(open: boolean) => {
                    if (!open && !importing) setPendingImport(null)
                }}
            >
                <AlertDialogContent className="max-w-lg">
                    <AlertDialogHeader>
                        <AlertDialogTitle className="flex items-center gap-2">
                            <FileJson className="h-5 w-5 text-primary" />
                            Preview Import
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                            Review the backup contents before applying changes to this device.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    {pendingImport && (
                        <div className="space-y-4 px-6 pb-5">
                            <div data-theme-part="panel" className="rounded-2xl border border-border/40 bg-muted/20 p-3 text-sm">
                                <div className="flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                        <p className="truncate font-medium text-foreground">{pendingImport.preview.fileName}</p>
                                        <p className="text-xs text-muted-foreground">
                                            {pendingImport.preview.sizeLabel}
                                            {pendingImport.preview.version ? ` / v${pendingImport.preview.version}` : ''}
                                            {pendingImport.preview.exportedAt ? ` / ${new Date(pendingImport.preview.exportedAt).toLocaleString()}` : ''}
                                        </p>
                                    </div>
                                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                                </div>
                            </div>

                            <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
                                {[
                                    ['Accounts', pendingImport.preview.counts.accounts],
                                    ['Saved Addons', pendingImport.preview.counts.savedAddons],
                                    ['Profiles', pendingImport.preview.counts.profiles],
                                    ['Autopilot Rules', pendingImport.preview.counts.failoverRules],
                                    ['Vault Keys', pendingImport.preview.counts.vaultKeys],
                                    ['Settings', pendingImport.preview.counts.settings],
                                ].map(([label, count]) => (
                                    <div key={label} data-theme-part="panel" className="rounded-xl border border-border/35 bg-background/60 p-3">
                                        <p className="text-base font-semibold text-foreground">{count}</p>
                                        <p className="text-muted-foreground">{label}</p>
                                    </div>
                                ))}
                            </div>

                            <div data-theme-part="panel" className="rounded-2xl border border-border/35 bg-background/50 p-3 text-xs text-muted-foreground">
                                <p>
                                    {pendingImport.preview.counts.matchingAccounts} account{pendingImport.preview.counts.matchingAccounts !== 1 ? 's' : ''} appear to match existing local accounts by ID or email.
                                </p>
                                {(pendingImport.preview.counts.accountStates > 0 || pendingImport.preview.counts.changelog > 0 || pendingImport.preview.counts.watchEvents > 0) && (
                                    <p className="mt-1">
                                        Also includes {pendingImport.preview.counts.accountStates} account state record{pendingImport.preview.counts.accountStates !== 1 ? 's' : ''}, {pendingImport.preview.counts.changelog} changelog entr{pendingImport.preview.counts.changelog !== 1 ? 'ies' : 'y'}, and {pendingImport.preview.counts.watchEvents} watch event{pendingImport.preview.counts.watchEvents !== 1 ? 's' : ''}.
                                    </p>
                                )}
                            </div>

                            <div className="space-y-1.5">
                                <div className="flex items-center justify-between">
                                    <p className="text-xs font-semibold text-muted-foreground">Select what to import</p>
                                    <div className="flex gap-2">
                                        <button type="button" data-theme-part="button" onClick={() => setImportSections(new Set(BACKUP_SECTIONS.map(s => s.key)))} className="text-xs text-primary hover:underline">Select All</button>
                                        <button type="button" data-theme-part="button" onClick={() => setImportSections(new Set())} className="text-xs text-muted-foreground hover:underline">Clear</button>
                                    </div>
                                </div>
                                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                                    {BACKUP_SECTIONS.map(section => {
                                        const isSelected = importSections.has(section.key)
                                        return (
                                            <button
                                                key={section.key}
                                                type="button"
                                                data-theme-part="button"
                                                aria-pressed={isSelected}
                                                onClick={() => toggleImportSection(section.key)}
                                                className={`flex items-start gap-2 rounded-xl border p-2.5 text-left transition-colors ${isSelected ? 'border-primary/30 bg-primary/8' : 'border-border/30 bg-muted/20 opacity-60'}`}
                                            >
                                                <div className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border ${isSelected ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/40'}`}>
                                                    {isSelected && <CheckCircle2 className="h-3 w-3" />}
                                                </div>
                                                <div className="min-w-0">
                                                    <p className="text-xs font-medium text-foreground">{section.label}</p>
                                                    <p className="text-xs text-muted-foreground line-clamp-1">{section.description}</p>
                                                </div>
                                            </button>
                                        )
                                    })}
                                </div>
                            </div>

                            {pendingImport.preview.hasAccounts && importSections.has('accounts') && (
                                <fieldset className="space-y-2 rounded-xl border border-border/35 p-3 text-sm">
                                    <legend className="px-1 font-medium">Account list</legend>
                                    <label className="flex items-start gap-2">
                                        <input type="radio" name="backup-account-mode" value="merge" checked={importAccountMode === 'merge'} onChange={() => setImportAccountMode('merge')} disabled={importing} className="mt-1" />
                                        <span>Merge accounts <span className="block text-xs text-muted-foreground">Keep existing accounts and add or update accounts from this file. The file count is not the final total.</span></span>
                                    </label>
                                    <label className="flex items-start gap-2">
                                        <input type="radio" name="backup-account-mode" value="restore" checked={importAccountMode === 'restore'} onChange={() => setImportAccountMode('restore')} disabled={importing} className="mt-1" />
                                        <span>Restore account list <span className="block text-xs text-muted-foreground">Replace your current {accounts.length} accounts with the {pendingImport.preview.counts.accounts} accounts in this file. Accounts absent from the file will be removed from AIOManager and this change will sync to your other devices. Other selected data is merged.</span></span>
                                    </label>
                                </fieldset>
                            )}

                            {pendingImport.preview.warnings.length > 0 && (
                                <div data-theme-tone="status" data-theme-part="panel" className="space-y-2 rounded-2xl border border-warning/25 bg-warning/10 p-3">
                                    <p className="flex items-center gap-2 text-xs font-semibold text-warning">
                                        <AlertTriangle className="h-3.5 w-3.5" />
                                        Import notes
                                    </p>
                                    <ul className="space-y-1 text-xs text-muted-foreground">
                                        {pendingImport.preview.warnings.map((warning) => (
                                            <li key={warning}>- {warning}</li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                        </div>
                    )}
                    <AlertDialogFooter>
                        <AlertDialogCancel disabled={importing}>Cancel</AlertDialogCancel>
                        <Button
                            type="button"
                            onClick={handleConfirmImport}
                            disabled={importing || importSections.size === 0}
                            className="h-11 rounded-full"
                        >
                            {importing ? 'Importing...' : importAccountMode === 'restore' && importSections.has('accounts') && pendingImport?.preview.hasAccounts ? `Restore ${pendingImport.preview.counts.accounts} Accounts` : 'Import Backup'}
                        </Button>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>

            <AlertDialog open={showExportDialog} onOpenChange={(open: boolean) => { if (!exporting) setShowExportDialog(open) }}>
                <AlertDialogContent className="max-w-lg">
                    <AlertDialogHeader>
                        <AlertDialogTitle className="flex items-center gap-2">
                            <Download className="h-5 w-5 text-primary" />
                            Export Backup
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                            Choose what to include in your backup file.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <div className="space-y-3 px-6 pb-5">
                        <div className="flex items-center justify-between">
                            <p className="text-xs font-semibold text-muted-foreground">Sections</p>
                            <div className="flex gap-2">
                                <button type="button" data-theme-part="button" onClick={() => setExportSections(new Set(BACKUP_SECTIONS.map(s => s.key)))} className="text-xs text-primary hover:underline">Select All</button>
                                <button type="button" data-theme-part="button" onClick={() => setExportSections(new Set())} className="text-xs text-muted-foreground hover:underline">Clear</button>
                            </div>
                        </div>
                        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                            {BACKUP_SECTIONS.map(section => {
                                const isSelected = exportSections.has(section.key)
                                return (
                                    <button
                                        key={section.key}
                                        type="button"
                                        data-theme-part="button"
                                        aria-pressed={isSelected}
                                        onClick={() => toggleExportSection(section.key)}
                                        className={`flex items-start gap-2 rounded-xl border p-2.5 text-left transition-colors ${isSelected ? 'border-primary/30 bg-primary/8' : 'border-border/30 bg-muted/20 opacity-60'}`}
                                    >
                                        <div className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border ${isSelected ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/40'}`}>
                                            {isSelected && <CheckCircle2 className="h-3 w-3" />}
                                        </div>
                                        <div className="min-w-0">
                                            <p className="text-xs font-medium text-foreground">{section.label}</p>
                                            <p className="text-xs text-muted-foreground line-clamp-1">{section.description}</p>
                                        </div>
                                    </button>
                                )
                            })}
                        </div>
                    </div>
                    <AlertDialogFooter>
                        <AlertDialogCancel disabled={exporting}>Cancel</AlertDialogCancel>
                        <Button
                            type="button"
                            onClick={handleConfirmExport}
                            disabled={exporting || exportSections.size === 0}
                            className="h-11 rounded-full"
                        >
                            {exporting ? 'Exporting...' : 'Download Backup'}
                        </Button>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>

            {/* Confirmation Dialog needed for SettingsPage specifically (Clear History Cache) */}
            <ConfirmationDialog
                open={showClearCacheConfirm}
                onOpenChange={(open) => {
                    if (!open && !isClearingCache) setShowClearCacheConfirm(open)
                }}
                title="Clear history cache?"
                description="Removes cached activity and watch events on this device. Your next sync rebuilds them from your connected accounts. Nothing is deleted on Stremio or Nuvio."
                confirmText="Clear cache"
                severity="warning"
                isLoading={isClearingCache}
                onConfirm={() => { void handleConfirmClearCache() }}
            />
        </div>
    )
}
