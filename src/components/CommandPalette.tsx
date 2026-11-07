import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { vaultKeyLabel, vaultKeySearchHost } from '@/lib/vault-key-label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useAccountStore } from '@/store/accountStore'
import type { BulkActionDefinition } from '@/components/accounts/bulk-actions/registry'
import { useNavigate } from 'react-router-dom'
import { preloadRouteChunk } from '@/routes'
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
    KeyRound,
    StickyNote,
    Tv,
    Key,
    Bookmark,
    ListChecks,
    Compass,
    Link2,
    Palette,
    Wrench,
    Plug,
    Radar,
    Film,
    RefreshCw,
    Rocket,
    UserRound,
    BellOff,
    Zap,
    AlertTriangle,
} from 'lucide-react'
import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { useFailoverStore } from '@/store/failoverStore'
import { useUIStore } from '@/store/uiStore'
import { useNotesStore } from '@/store/notesStore'
import { useVaultStore } from '@/store/vaultStore'
import { useAddonStore } from '@/store/addonStore'
import { useSyncStore } from '@/store/syncStore'
import { useProviderStore } from '@/store/providerStore'
import { useInboxStore } from '@/store/notificationInbox'
import { toast } from '@/hooks/use-toast'
import { PaletteDeployDialog } from '@/components/PaletteDeployDialog'
import { SETTINGS_PAGE_IDS, type SettingsPageId } from '@/components/settings/settings-model'
import { SETTING_PAGE_LABELS } from '@/components/settings/SettingsNavigation'
import { PALETTE_CATEGORY_ORDER, buildPaletteActions, resolvePaletteShortcut, type PaletteActionId } from '@/lib/palette-actions'
import { getAllPendingPush } from '@/lib/sync/pending-push'
import { syncPendingAndCloud } from '@/lib/sync-now'
import { maskAccountLabel, maskEmailLevel } from '@/lib/utils'
import { isAIOStreamsAddon, parseAIOStreamsUrl } from '@/lib/aiostreams-utils'
import { isAIOMetadataAddon, parseAIOMetadataUrl } from '@/lib/aiometadata-utils'
import { dedupeByInstallUrl, filterCommandsByQuery, groupCommandsByCategory } from '@/lib/command-search'
import type { Account } from '@/types/account'

type CommandCategory = (typeof PALETTE_CATEGORY_ORDER)[number]

// Authoritative visual order of the result groups. The keyboard selection
// index is derived from the flattened grouped order, never from the raw item
// list, so the highlighted row always matches what the user sees.
const CATEGORY_ORDER = PALETTE_CATEGORY_ORDER

let syncNowInFlight = false

const NO_ACCOUNTS: Account[] = []
const NO_RULES: ReturnType<typeof useFailoverStore.getState>['rules'] = []
const NO_NOTES: ReturnType<typeof useNotesStore.getState>['notes'] = []
const NO_VAULT_KEYS: ReturnType<typeof useVaultStore.getState>['keys'] = []
const NO_SAVED_ADDONS: ReturnType<typeof useAddonStore.getState>['library'] = {}

export interface CommandItem {
    id: string
    /** Masked display label. Raw searchable text lives in searchText. */
    label: string
    sublabel?: string
    icon: React.ReactNode
    action: () => void
    category: CommandCategory
    emoji?: string
    avatarUrl?: string
    searchText?: string
    aliases?: string[]
    hint?: string[]
    disabled?: boolean
    subject?: { type: 'account' | 'saved-addon'; id: string }
    /** Destination path for navigating items; drives intent-time route chunk preload. */
    target?: string
}

const VIRTUAL_RESULTS_THRESHOLD = 100
export interface CommandResultGroup { category: string; items: CommandItem[] }

type VirtualResultsComponent = typeof import('./CommandPaletteResults').VirtualCommandResults

// One destination per Settings page. Labels come from SETTING_PAGE_LABELS and the hash is the
// page id that SettingsPage resolves; aliases keep the old tab and page names searchable.
const SETTINGS_PAGE_DETAILS: Record<SettingsPageId, { sublabel: string; icon: React.ReactNode; aliases: string[] }> = {
    'account-sync': { sublabel: 'Display name, avatar, push to cloud, pull from cloud and backups', icon: <UserRound className="h-4 w-4" />, aliases: ['general', 'identity', 'data', 'account', 'cloud', 'push', 'pull', 'profile', 'backup', 'restore', 'export', 'import', 'sync connections'] },
    'appearance-privacy': { sublabel: 'Themes, privacy mode, install the app and about', icon: <Palette className="h-4 w-4" />, aliases: ['appearance', 'theme', 'themes', 'dark mode', 'light mode', 'oled', 'accent', 'privacy', 'privacy mode', 'mask', 'hide', 'install', 'pwa', 'app', 'desktop', 'about', 'version', 'build'] },
    keys: { sublabel: 'Metadata provider keys and account API keys', icon: <KeyRound className="h-4 w-4" />, aliases: ['keys', 'api keys', 'credentials', 'metadata integrations', 'tmdb'] },
    'updates-activity': { sublabel: 'Auto-update, live activity refresh, alerts and history cache', icon: <Zap className="h-4 w-4" />, aliases: ['advanced', 'notifications', 'alerts', 'monitoring', 'webhook', 'webhooks', 'auto-update', 'live activity', 'history cache'] },
    'devices-maintenance': { sublabel: 'Remembered devices, sync diagnostics and repair', icon: <Wrench className="h-4 w-4" />, aliases: ['devices', 'remembered devices', 'sessions', 'diagnostics', 'sync diagnostics', 'debug', 'repair', 'recovery', 'fix'] },
    'danger-zone': { sublabel: 'Clear data and delete accounts', icon: <AlertTriangle className="h-4 w-4" />, aliases: ['danger zone', 'reset', 'wipe', 'delete'] },
}

function installHost(url: string | undefined): string {
    if (!url) return ''
    try { return new URL(url).host } catch { return '' }
}

export function CommandPalette({ initiallyOpen = false }: { initiallyOpen?: boolean }) {
    const [open, setOpen] = useState(initiallyOpen)
    const [exitPending, setExitPending] = useState(false)
    // Dialog keeps its children for a 200ms exit. Keep the current list through
    // that transition, then release its subscriptions and derived commands.
    const indexActive = open || exitPending
    useEffect(() => {
        if (open) { setExitPending(true); return }
        const timer = setTimeout(() => setExitPending(false), 220)
        return () => clearTimeout(timer)
    }, [open])
    const [query, setQuery] = useState('')
    const [selectedIndex, setSelectedIndex] = useState(0)
    const [bulkActions, setBulkActions] = useState<BulkActionDefinition[]>([])
    const [subList, setSubList] = useState<'accounts' | 'addons' | null>(null)
    const [deployAddonId, setDeployAddonId] = useState<string | null>(null)
    const [VirtualCommandResults, setVirtualCommandResults] = useState<VirtualResultsComponent | null>(null)
    const [resultsLoadFailed, setResultsLoadFailed] = useState(false)
    const [resultsLoadAttempt, setResultsLoadAttempt] = useState(0)
    const inputRef = useRef<HTMLInputElement>(null)
    const scrollRef = useRef<HTMLDivElement>(null)
    const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null)
    const attachScrollRoot = useCallback((node: HTMLDivElement | null) => {
        scrollRef.current = node
        setScrollRoot(node)
    }, [])
    const navigate = useNavigate()
    const accounts = useAccountStore((s) => indexActive ? s.accounts : NO_ACCOUNTS)
    const syncAllAccounts = useAccountStore((s) => s.syncAllAccounts)
    const signedIn = useSyncStore((s) => s.auth.isAuthenticated)
    const notificationCount = useInboxStore((s) => indexActive ? s.entries.length : 0)
    const syncing = useSyncStore((s) => s.isSyncing || s.isRefreshingFromCloud)
    const checkRules = useFailoverStore((s) => s.checkRules)
    const autopilotRules = useFailoverStore((s) => indexActive ? s.rules : NO_RULES)
    const notes = useNotesStore((s) => indexActive ? s.notes : NO_NOTES)
    const vaultKeys = useVaultStore((s) => indexActive ? s.keys : NO_VAULT_KEYS)
    const savedAddonLibrary = useAddonStore((s) => indexActive ? s.library : NO_SAVED_ADDONS)
    const isPrivacyModeEnabled = useUIStore((s) => s.isPrivacyModeEnabled)
    const privacyLevelNames = useUIStore((s) => s.privacyLevelNames)
    const privacyLevelEmail = useUIStore((s) => s.privacyLevelEmail)
    const namePrivacy = isPrivacyModeEnabled ? privacyLevelNames : 0
    const emailPrivacy = isPrivacyModeEnabled ? privacyLevelEmail : 0

    useEffect(() => {
        const keyHandler = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
                e.preventDefault()
                setOpen((prev) => !prev)
            }
        }
        const customHandler = () => setOpen(true)
        window.addEventListener('keydown', keyHandler)
        window.addEventListener('open-command-palette', customHandler)
        return () => {
            window.removeEventListener('keydown', keyHandler)
            window.removeEventListener('open-command-palette', customHandler)
        }
    }, [])

    const go = useCallback(
        (path: string) => {
            navigate(path)
            setOpen(false)
        },
        [navigate]
    )

    const runSyncNow = useCallback(() => {
        const { auth, isSyncing, isRefreshingFromCloud, syncToRemote } = useSyncStore.getState()
        if (!auth.isAuthenticated || isSyncing || isRefreshingFromCloud || syncNowInFlight) return
        syncNowInFlight = true
        syncPendingAndCloud({
            pendingAccountIds: getAllPendingPush().map(([id]) => id),
            knownAccountIds: new Set(useAccountStore.getState().accounts.map(a => a.id)),
            syncAccount: useAccountStore.getState().syncAccount,
            syncToRemote: () => syncToRemote(false),
        })
            .catch(() => {})
            .finally(() => { syncNowInFlight = false })
        setOpen(false)
    }, [])

    const runVaultCheck = useCallback(() => {
        setOpen(false)
        const providers = useProviderStore.getState()
        if (providers.isRefreshing) return
        providers.forceRefreshAll()
            .then(() => {
                const { health } = useProviderStore.getState()
                const keyIds = useVaultStore.getState().keys.map((k) => k.id)
                const checked = keyIds.filter((id) => health[id] && health[id].status !== 'none')
                if (checked.length === 0) return
                const attention = checked.filter((id) => health[id].status === 'error' || health[id].status === 'expired').length
                toast({
                    title: 'Vault check complete',
                    description: attention > 0
                        ? `${attention} of ${checked.length} key${checked.length !== 1 ? 's' : ''} need attention.`
                        : `All ${checked.length} key${checked.length !== 1 ? 's' : ''} look healthy.`,
                    variant: attention > 0 ? 'destructive' : undefined,
                    href: '/vault',
                })
            })
            .catch(() => toast({ title: 'Vault check failed', description: 'Could not check your vault keys.', variant: 'destructive', href: '/vault' }))
    }, [])

    const actionHandlers = useMemo<Record<PaletteActionId, () => void>>(() => ({
        'sync-now': runSyncNow,
        'deploy-addon': () => { setSubList('addons'); setQuery(''); setSelectedIndex(0) },
        'open-account': () => { setSubList('accounts'); setQuery(''); setSelectedIndex(0) },
        'check-vault': runVaultCheck,
        'clear-notifications': () => { useInboxStore.getState().clear(); setOpen(false) },
    }), [runSyncNow, runVaultCheck])

    const actionSpecs = useMemo(() => buildPaletteActions({
        signedIn,
        syncing,
        accountCount: accounts.length,
        savedAddonCount: Object.keys(savedAddonLibrary).length,
        vaultKeyCount: vaultKeys.length,
        notificationCount,
    }), [signedIn, syncing, accounts.length, savedAddonLibrary, vaultKeys.length, notificationCount])

    // Display helpers. Labels render masked under privacy mode while the raw
    // values stay searchable through searchText. Credential fields (connection
    // credentials, vault key values) are never searched or displayed.
    const accountLabel = useCallback(
        (acc: Account) => maskAccountLabel(acc, namePrivacy, emailPrivacy),
        [namePrivacy, emailPrivacy]
    )

    const accountSearchText = useCallback((acc: Account) => {
        const platforms = (acc.connections ?? []).flatMap((c) => [c.platform, c.displayName ?? ''])
        return [acc.name, acc.email ?? '', ...platforms].filter(Boolean).join(' ')
    }, [])

    const allItems = useMemo<CommandItem[]>(() => {
        if (!indexActive) return []
        const items: CommandItem[] = []
        const rulesByAccount = new Map<string, typeof autopilotRules>()
        for (const rule of autopilotRules) {
            const rules = rulesByAccount.get(rule.accountId)
            if (rules) rules.push(rule)
            else rulesByAccount.set(rule.accountId, [rule])
        }
        // Preserve account order and count each account once per installed URL.
        const accountsByAddonUrl = new Map<string, Account[]>()
        for (const account of accounts) {
            for (const url of new Set((account.addons ?? []).map(addon => addon.transportUrl))) {
                const installed = accountsByAddonUrl.get(url)
                if (installed) installed.push(account)
                else accountsByAddonUrl.set(url, [account])
            }
        }

        const actionIcons: Record<PaletteActionId, React.ReactNode> = {
            'sync-now': <RefreshCw className="h-4 w-4" />,
            'deploy-addon': <Rocket className="h-4 w-4" />,
            'open-account': <UserRound className="h-4 w-4" />,
            'check-vault': <KeyRound className="h-4 w-4" />,
            'clear-notifications': <BellOff className="h-4 w-4" />,
        }
        for (const spec of actionSpecs) {
            items.push({
                id: `palette-action-${spec.id}`,
                label: spec.label,
                sublabel: spec.sublabel,
                icon: actionIcons[spec.id],
                action: spec.disabled ? () => {} : actionHandlers[spec.id],
                category: 'Actions',
                aliases: spec.aliases,
                hint: spec.hint,
                disabled: spec.disabled,
            })
        }

        items.push(
            {
                id: 'nav-accounts',
                label: 'Accounts',
                sublabel: 'Dashboard home - manage all accounts',
                icon: <LayoutDashboard className="h-4 w-4" />,
                action: () => go('/'),
                target: '/',
                category: 'Navigation',
                aliases: ['home', 'dashboard', 'accounts'],
            },
            {
                id: 'nav-discover',
                label: 'Discover Addons',
                sublabel: 'Find and save new addons',
                icon: <Compass className="h-4 w-4" />,
                action: () => go('/saved-addons#discover'),
                target: '/saved-addons#discover',
                category: 'Navigation',
                aliases: ['discover', 'discovery', 'find addons', 'browse addons', 'new addons', 'catalog'],
            },
            {
                id: 'nav-library',
                label: 'Saved Addons Library',
                sublabel: 'Browse and manage saved addon profiles',
                icon: <Package className="h-4 w-4" />,
                action: () => go('/saved-addons'),
                target: '/saved-addons',
                category: 'Navigation',
                aliases: ['library', 'saved addons', 'addon library'],
            },
            {
                id: 'nav-addon-sync',
                label: 'Saved Addons Sync',
                sublabel: 'Review saved addons mirrored into account addons',
                icon: <Link2 className="h-4 w-4" />,
                action: () => go('/saved-addons#sync'),
                target: '/saved-addons#sync',
                category: 'Navigation',
                aliases: ['sync', 'mirroring', 'mirror', 'active sync', 'deployment', 'addon sync'],
            },
            {
                id: 'nav-activity',
                label: 'Activity',
                sublabel: 'Unified watch history from all accounts',
                icon: <Activity className="h-4 w-4" />,
                action: () => go('/activity'),
                target: '/activity',
                category: 'Navigation',
                aliases: ['history', 'watch history', 'activity'],
            },
            {
                id: 'nav-metrics',
                label: 'Metrics',
                sublabel: 'Stats, charts, and insights',
                icon: <BarChart3 className="h-4 w-4" />,
                action: () => go('/metrics'),
                target: '/metrics',
                category: 'Navigation',
                aliases: ['metrics', 'stats', 'statistics', 'charts'],
            },
            {
                id: 'nav-replay',
                label: 'Replay',
                sublabel: 'Year in review experience',
                icon: <Tv className="h-4 w-4" />,
                action: () => go('/replay'),
                target: '/replay',
                category: 'Navigation',
                aliases: ['replay', 'year in review', 'wrapped'],
            },
            {
                id: 'nav-notes',
                label: 'Notes',
                sublabel: 'Markdown notes and documentation',
                icon: <StickyNote className="h-4 w-4" />,
                action: () => go('/notes'),
                target: '/notes',
                category: 'Navigation',
                aliases: ['notes', 'markdown', 'documentation'],
            },
            {
                id: 'nav-vault',
                label: 'Key Vault',
                sublabel: 'Encrypted API key management',
                icon: <KeyRound className="h-4 w-4" />,
                action: () => go('/vault'),
                target: '/vault',
                category: 'Navigation',
                aliases: ['vault', 'api keys', 'keys', 'credentials'],
            },
            {
                id: 'nav-theme-editor',
                label: 'Theme Editor',
                sublabel: 'Edit the custom theme color palette',
                icon: <Palette className="h-4 w-4" />,
                action: () => go('/settings/theme/editor'),
                target: '/settings/theme/editor',
                category: 'Navigation',
                aliases: ['theme editor', 'custom theme', 'colors', 'design'],
            },
            {
                id: 'nav-settings',
                label: 'Settings',
                sublabel: 'Themes, sync, privacy, and preferences',
                icon: <Settings className="h-4 w-4" />,
                action: () => go('/settings'),
                target: '/settings',
                category: 'Navigation',
                aliases: ['settings', 'preferences', 'options'],
            },
            {
                id: 'nav-faq',
                label: 'Docs',
                sublabel: 'Help, guides, and troubleshooting',
                icon: <HelpCircle className="h-4 w-4" />,
                action: () => go('/kronorium'),
                target: '/kronorium',
                category: 'Navigation',
                aliases: ['docs', 'documentation', 'help', 'faq', 'guides', 'kronorium'],
            }
        )

        for (const page of SETTINGS_PAGE_IDS) {
            const details = SETTINGS_PAGE_DETAILS[page]
            items.push({
                id: `settings-${page}`,
                label: `Settings - ${SETTING_PAGE_LABELS[page]}`,
                sublabel: details.sublabel,
                icon: details.icon,
                action: () => go(`/settings#${page}`),
                target: `/settings#${page}`,
                category: 'Settings',
                aliases: details.aliases,
            })
        }

        for (const acc of accounts) {
            items.push({
                id: `acc-${acc.id}`,
                label: accountLabel(acc),
                emoji: acc.emoji,
                avatarUrl: acc.avatar,
                sublabel: acc.email && acc.name ? maskEmailLevel(acc.email, emailPrivacy) : undefined,
                icon: <User className="h-4 w-4" />,
                action: () => go(`/account/${acc.id}`),
                target: `/account/${acc.id}`,
                category: 'Accounts',
                searchText: accountSearchText(acc),
                subject: { type: 'account', id: acc.id },
            })

            // Per-account Connections tab destination, searchable by account
            // name and linked platform.
            const connections = acc.connections ?? []
            if (connections.length > 0) {
                // Display platform names only; connection display names can
                // carry personal text, so they stay searchable but unrendered.
                const platformLabels = [
                    ...new Set(connections.map((c) => c.platform)),
                ]
                items.push({
                    id: `connections-${acc.id}`,
                    label: `Connections - ${accountLabel(acc)}`,
                    sublabel: platformLabels.join(', '),
                    icon: <Plug className="h-4 w-4" />,
                    action: () => go(`/account/${acc.id}?tab=connections`),
                    target: `/account/${acc.id}?tab=connections`,
                    category: 'Accounts',
                    searchText: accountSearchText(acc),
                    aliases: ['connections', 'platforms', 'linked platforms', 'integrations'],
                })
            }

            // Per-account Autopilot tab destination, searchable by account
            // name, platform, and rule names.
            const rules = rulesByAccount.get(acc.id) ?? []
            if (rules.length > 0) {
                const ruleNames = rules.map((r) => r.name).filter((n): n is string => Boolean(n))
                const countLabel = `${rules.length} rule${rules.length !== 1 ? 's' : ''}`
                items.push({
                    id: `autopilot-${acc.id}`,
                    label: `Autopilot - ${accountLabel(acc)}`,
                    sublabel:
                        ruleNames.length > 0
                            ? `${countLabel}: ${ruleNames.slice(0, 2).join(', ')}`
                            : countLabel,
                    icon: <Radar className="h-4 w-4" />,
                    action: () => go(`/account/${acc.id}?tab=failover`),
                    target: `/account/${acc.id}?tab=failover`,
                    category: 'Accounts',
                    searchText: [accountSearchText(acc), ...ruleNames].filter(Boolean).join(' '),
                    aliases: ['autopilot', 'failover', 'rules', 'monitoring', 'chains'],
                })
            }
        }

        // Per-account AIOStreams and AIOMetadata instance destinations. The
        // routes and uuid parsing mirror AIOStreamsPage and AIOMetadataPage.
        // Duplicate installs of one instance parse to the same uuid, so keep
        // only the first: rows stay unique and React keys never collide.
        for (const acc of accounts) {
            const seenInstances = new Set<string>()
            for (const addon of acc.addons ?? []) {
                const addonName =
                    addon.metadata?.customName || addon.manifest?.name || addon.transportName || ''
                if (isAIOStreamsAddon(addon)) {
                    const parsed = parseAIOStreamsUrl(addon.transportUrl)
                    const instanceKey = parsed ? `aiostreams:${parsed.uuid}` : null
                    if (parsed && instanceKey && !seenInstances.has(instanceKey)) {
                        seenInstances.add(instanceKey)
                        items.push({
                            id: `aiostreams-${acc.id}-${parsed.uuid}`,
                            label: addonName || 'AIOStreams',
                            sublabel: `AIOStreams - ${accountLabel(acc)}`,
                            icon: <Tv className="h-4 w-4" />,
                            action: () => go(`/account/${acc.id}/aiostreams/${parsed.uuid}`),
                            target: `/account/${acc.id}/aiostreams/${parsed.uuid}`,
                            category: 'Addons',
                            searchText: [
                                accountSearchText(acc),
                                parsed.baseUrl,
                                parsed.uuid,
                                addonName,
                                'aiostreams',
                            ]
                                .filter(Boolean)
                                .join(' '),
                            aliases: ['aiostreams', 'streams', 'debrid', 'config'],
                        })
                    }
                }
                if (isAIOMetadataAddon(addon)) {
                    const parsed = parseAIOMetadataUrl(addon.transportUrl)
                    const instanceKey = parsed ? `aiometadata:${parsed.uuid}` : null
                    if (parsed && instanceKey && !seenInstances.has(instanceKey)) {
                        seenInstances.add(instanceKey)
                        items.push({
                            id: `aiometadata-${acc.id}-${parsed.uuid}`,
                            label: addonName || 'AIOMetadata',
                            sublabel: `AIOMetadata - ${accountLabel(acc)}`,
                            icon: <Film className="h-4 w-4" />,
                            action: () => go(`/account/${acc.id}/aiometadata/${parsed.uuid}`),
                            target: `/account/${acc.id}/aiometadata/${parsed.uuid}`,
                            category: 'Addons',
                            searchText: [
                                accountSearchText(acc),
                                parsed.baseUrl,
                                parsed.uuid,
                                addonName,
                                'aiometadata',
                            ]
                                .filter(Boolean)
                                .join(' '),
                            aliases: ['aiometadata', 'metadata', 'meta', 'catalogs', 'config'],
                        })
                    }
                }
            }
        }

        for (const n of notes) {
            const sublabel = n.tags.length > 0 ? n.tags.slice(0, 3).map(t => `#${t}`).join(' ') : 'Note'
            items.push({
                id: `note-${n.id}`,
                label: n.title,
                sublabel,
                icon: <StickyNote className="h-4 w-4" />,
                action: () => go(`/notes?note=${encodeURIComponent(n.id)}`),
                target: `/notes?note=${encodeURIComponent(n.id)}`,
                category: 'Notes',
                searchText: [n.title, ...n.tags, ...n.wikilinks].filter(Boolean).join(' '),
            })
        }

        for (const k of vaultKeys) {
            items.push({
                id: `vault-${k.id}`,
                label: vaultKeyLabel(k),
                sublabel: k.provider,
                icon: <Key className="h-4 w-4" />,
                action: () => go('/vault'),
                target: '/vault',
                category: 'Vault',
                searchText: [vaultKeySearchHost(k.serverUrl), k.customProviderName].filter(Boolean).join(' '),
                aliases: ['api key', 'vault', 'credential'],
            })
        }

        const savedAddonList = dedupeByInstallUrl(Object.values(savedAddonLibrary))
        const savedAddonNameCounts = new Map<string, number>()
        for (const a of savedAddonList) {
            const name = (a.name ?? '').toLowerCase()
            savedAddonNameCounts.set(name, (savedAddonNameCounts.get(name) ?? 0) + 1)
        }
        for (const a of savedAddonList) {
            const tagStr = (a.tags ?? []).join(' ')
            const manifestName = a.manifest?.name ?? ''
            const installedAccounts = accountsByAddonUrl.get(a.installUrl) ?? []
            const installedLabels = installedAccounts.map(acc => accountLabel(acc))
            const accountStr = installedLabels.length > 0 ? installedLabels.join(', ') : 'Not installed'
            const firstAccountId = installedAccounts[0]?.id
            // Raw account names and emails stay searchable while the
            // displayed deployment list is masked under privacy mode.
            const rawAccountStr = installedAccounts
                .map(acc => [acc.name, acc.email ?? ''].filter(Boolean).join(' '))
                .join(' ')
            items.push({
                id: `addon-${a.id}`,
                label: a.name || 'Unnamed Addon',
                sublabel: (savedAddonNameCounts.get((a.name ?? '').toLowerCase()) ?? 0) > 1
                    ? [accountStr, installHost(a.installUrl)].filter(Boolean).join(' · ')
                    : accountStr,
                icon: <Bookmark className="h-4 w-4" />,
                action: () => go(firstAccountId ? `/account/${firstAccountId}` : '/saved-addons'),
                target: firstAccountId ? `/account/${firstAccountId}` : '/saved-addons',
                category: 'Saved Addons',
                searchText: `${a.name ?? ''} ${manifestName} ${tagStr} ${rawAccountStr}`,
                subject: { type: 'saved-addon', id: a.id },
            })
        }

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
                aliases: ['refresh', 'sync all', 'update all'],
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
                aliases: ['changelog', 'whats new', 'release notes'],
            }
        )

        for (const def of bulkActions) {
            items.push({
                id: `bulk-${def.id}`,
                label: def.title,
                sublabel: def.description,
                icon: <ListChecks className="h-4 w-4" />,
                action: () => {
                    navigate('/?bulk=' + def.id)
                    setOpen(false)
                },
                target: '/',
                category: 'Bulk Operations',
                aliases: ['bulk', 'batch'],
            })
        }

        return items
    }, [indexActive, accounts, notes, vaultKeys, savedAddonLibrary, autopilotRules, go, syncAllAccounts, checkRules, navigate, bulkActions, accountLabel, accountSearchText, emailPrivacy, actionSpecs, actionHandlers])

    const visibleItems = useMemo(() => {
        if (!subList) return allItems
        const type = subList === 'addons' ? 'saved-addon' : 'account'
        return allItems
            .filter((item) => item.subject?.type === type)
            .map((item) => subList === 'addons' && item.subject
                ? { ...item, action: () => { setDeployAddonId(item.subject!.id); setSubList(null); setOpen(false) } }
                : item)
    }, [allItems, subList])

    const filtered = useMemo(() => filterCommandsByQuery(visibleItems, query), [visibleItems, query])

    const groups = useMemo(() => groupCommandsByCategory(filtered, CATEGORY_ORDER), [filtered])

    // Flattened grouped order. This is the order the user sees and the order
    // the keyboard navigates, so selection can never drift from the visual
    // grouping.
    const ordered = useMemo(() => groups.flatMap((g) => g.items), [groups])
    const needsVirtualResults = indexActive && ordered.length > VIRTUAL_RESULTS_THRESHOLD
    useEffect(() => {
        if (!needsVirtualResults || VirtualCommandResults) return
        let cancelled = false
        setResultsLoadFailed(false)
        // Keep the virtualizer out of the startup bundle without suspending the
        // dialog's first reveal while the result module resolves.
        import('./CommandPaletteResults').then(module => {
            if (!cancelled) setVirtualCommandResults(() => module.VirtualCommandResults)
        }).catch(() => {
            if (!cancelled) setResultsLoadFailed(true)
        })
        return () => { cancelled = true }
    }, [needsVirtualResults, VirtualCommandResults, resultsLoadAttempt])

    const indexById = useMemo(() => {
        const map = new Map<string, number>()
        ordered.forEach((item, i) => map.set(item.id, i))
        return map
    }, [ordered])

    useEffect(() => {
        setSelectedIndex(0)
    }, [query])

    // Keyboard navigation moves aria-activedescendant without DOM focus; preload the
    // highlighted row's destination chunk the same way a hover would.
    useEffect(() => {
        const item = ordered[selectedIndex]
        if (item?.target) preloadRouteChunk(item.target)
    }, [ordered, selectedIndex])

    // Keep the selection inside the result list as it shrinks or empties.
    // Never allow a negative index with zero results.
    useEffect(() => {
        setSelectedIndex((prev) => (prev >= ordered.length ? 0 : prev))
    }, [ordered.length])

    useEffect(() => {
        if (!open || bulkActions.length > 0) return
        let cancelled = false
        import('@/components/accounts/bulk-actions/registry')
            .then(m => { if (!cancelled) setBulkActions(m.BULK_ACTIONS) })
            .catch(() => {})
        return () => { cancelled = true }
    }, [open, bulkActions.length])

    useEffect(() => {
        if (open) {
            setQuery('')
            setSubList(null)
            setSelectedIndex(0)
            setTimeout(() => inputRef.current?.focus(), 50)
        }
    }, [open])

    const handleKeyDown = (e: React.KeyboardEvent) => {
        const shortcut = resolvePaletteShortcut(e, actionSpecs)
        if (shortcut) {
            e.preventDefault()
            if (!shortcut.disabled) actionHandlers[shortcut.id]()
            return
        }
        if (e.key === 'Backspace' && subList && query === '') {
            e.preventDefault()
            setSubList(null)
            return
        }
        if (e.key === 'ArrowDown') {
            e.preventDefault()
            if (ordered.length === 0) return
            setSelectedIndex((prev) => Math.min(prev + 1, ordered.length - 1))
        } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            if (ordered.length === 0) return
            setSelectedIndex((prev) => Math.max(prev - 1, 0))
        } else if (e.key === 'Enter') {
            if (needsVirtualResults && !VirtualCommandResults) {
                e.preventDefault()
                return
            }
            const item = ordered[selectedIndex]
            if (item) {
                e.preventDefault()
                item.action()
            }
        } else if (e.key === 'Escape') {
            if (subList) {
                e.preventDefault()
                e.stopPropagation()
                setSubList(null)
            } else {
                setOpen(false)
            }
        }
    }

    useEffect(() => {
        if (ordered.length > VIRTUAL_RESULTS_THRESHOLD) return
        const el = scrollRef.current?.querySelector(`[data-index="${selectedIndex}"]`)
        if (el) {
            el.scrollIntoView({ block: 'nearest' })
        }
    }, [selectedIndex, ordered.length])

    const renderCommandItem = (item: CommandItem) => {
        const flatIndex = indexById.get(item.id) ?? -1
        const isSelected = flatIndex === selectedIndex

        return (
            <button data-theme-part="nav-item" data-state={isSelected ? "active" : "inactive"}
                key={item.id}
                id={`command-palette-option-${item.id}`}
                role="option"
                aria-selected={isSelected}
                data-index={flatIndex}
                onClick={(e) => {
                    e.preventDefault()
                    item.action()
                }}
                onPointerEnter={() => { if (item.target) preloadRouteChunk(item.target) }}
                onFocus={() => { if (item.target) preloadRouteChunk(item.target) }}
                onTouchStart={() => { if (item.target) preloadRouteChunk(item.target) }}
                aria-disabled={item.disabled || undefined}
                className={`relative mx-3 flex w-[calc(100%-1.5rem)] items-center gap-3 rounded-2xl px-3 py-3 text-left transition-[background-color,box-shadow,color,transform] duration-150 ${item.disabled ? 'opacity-60' : ''} ${isSelected
                    ? 'bg-primary/10 text-foreground shadow-sm ring-1 ring-primary/20'
                    : 'text-foreground hover:bg-muted/30'
                    }`}
            >
                {isSelected && (
                    <span className="absolute inset-y-2 left-0 w-1 rounded-r-full bg-primary" />
                )}
                    {item.avatarUrl ? (
                        <span data-theme-part="avatar" className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl overflow-hidden transition-colors">
                            <img src={item.avatarUrl} alt="" className="h-full w-full object-cover" loading="lazy" />
                        </span>
                    ) : (
                        <span data-theme-part="badge"
                            className={`inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl transition-colors ${isSelected ? 'bg-primary text-primary-foreground shadow-sm' : 'bg-muted/45 text-muted-foreground'}`}
                        >
                            {item.icon}
                        </span>
                    )}
                <div className="flex-1 min-w-0">
                    <div className="truncate text-sm font-semibold tracking-tight">
                        {item.emoji && <span className="mr-2">{item.emoji}</span>}
                        {item.label}
                    </div>
                    {item.sublabel && (
                        <div className="truncate text-xs font-medium text-muted-foreground">
                            {item.sublabel}
                        </div>
                    )}
                </div>
                {item.hint && (
                    <span className="hidden flex-shrink-0 items-center gap-1 sm:flex" aria-hidden="true">
                        {item.hint.map((key) => (
                            <kbd key={key} data-theme-part="badge" className="min-w-[1.5rem] rounded-lg border border-border/50 bg-background/40 px-1.5 py-0.5 text-center font-mono text-[11px] text-muted-foreground shadow-sm">{key}</kbd>
                        ))}
                    </span>
                )}
                {isSelected && (
                    <CornerDownLeft className="h-3.5 w-3.5 flex-shrink-0 text-primary" />
                )}
            </button>
        )

    }
    return (
        <>
        {deployAddonId && <PaletteDeployDialog addonId={deployAddonId} onClose={() => setDeployAddonId(null)} />}
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent
                className="sm:max-w-[min(92vw,42rem)] sm:max-w-2xl p-0 gap-0 overflow-hidden sm:rounded-[2rem] border border-border/50 bg-card/90 shadow-2xl ring-1 ring-white/5 backdrop-blur-2xl [&>button:last-child]:hidden"
                onKeyDown={handleKeyDown}
            >
                <DialogTitle className="sr-only">Command palette</DialogTitle>

                <div data-theme-part="field" className="mx-3 mt-3 flex items-center gap-3 rounded-2xl border border-border/40 bg-muted/25 px-4 py-3 shadow-inner">
                    <Search className="h-4 w-4 text-muted-foreground/80 flex-shrink-0" />
                    <input
                        data-theme-part="inline-input"
                        ref={inputRef}
                        role="combobox"
                        aria-expanded
                        aria-autocomplete="list"
                        aria-controls={filtered.length > 0 ? 'command-palette-listbox' : undefined}
                        aria-activedescendant={ordered[selectedIndex]
                            ? `command-palette-option-${ordered[selectedIndex].id}`
                            : undefined}
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder={subList === 'accounts' ? 'Choose an account...' : subList === 'addons' ? 'Choose a saved addon to deploy...' : 'Search pages, accounts, addons, actions...'}
                        className="h-6 w-full min-w-0 flex-1 border-0 bg-transparent p-0 text-base font-medium text-foreground outline-none placeholder:text-muted-foreground/55 focus:ring-0 sm:text-sm"
                    />
                    <button data-theme-part="button"
                        onClick={() => setOpen(false)}
                        className="hidden sm:inline-flex items-center gap-0.5 rounded-lg border border-border/50 bg-background/40 px-2 py-1 text-[11px] font-mono text-muted-foreground shadow-sm transition-colors hover:bg-muted/60 hover:text-foreground"
                    >
                        Esc
                    </button>
                </div>


                <ScrollArea className={ordered.length > VIRTUAL_RESULTS_THRESHOLD ? "h-[min(54vh,440px)]" : "max-h-[min(54vh,440px)]"} ref={attachScrollRoot}>
                    <div className="py-3">
                        {filtered.length === 0 ? (
                            <div data-theme-part="panel" className="mx-3 rounded-2xl border border-dashed border-border/40 bg-muted/15 px-4 py-10 text-center text-sm text-muted-foreground">
                                No results found for "{query}"
                            </div>
                        ) : (
                            <div id="command-palette-listbox" role="listbox" aria-label="Command results">
                        {ordered.length > VIRTUAL_RESULTS_THRESHOLD ? (VirtualCommandResults
                            ? <VirtualCommandResults groups={groups} selectedIndex={selectedIndex} query={query} scrollRoot={scrollRoot} renderItem={renderCommandItem} />
                            : <div className="px-6 py-4 text-sm text-muted-foreground" role="status">
                                {resultsLoadFailed ? <>Could not load search results. <button type="button" className="underline" onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') event.stopPropagation() }} onClick={() => setResultsLoadAttempt(attempt => attempt + 1)}>Retry</button></> : 'Loading search results...'}
                            </div>) : groups.map(({ category, items }) => (
                            <div key={category} className="space-y-1">
                                <div className="px-6 pt-3 pb-1 text-[11px] font-bold uppercase tracking-wider text-muted-foreground/80">
                                    {category}
                                </div>
                                {items.map(item => renderCommandItem(item))}
                            </div>
                        ))}
                            </div>
                        )}
                    </div>
                </ScrollArea>


                <div data-theme-part="toolbar" className="m-3 mt-0 hidden items-center gap-4 rounded-2xl border border-border/35 bg-muted/20 px-4 py-2.5 text-xs text-muted-foreground sm:flex">
                    <span className="flex items-center gap-1">
                        <kbd data-theme-part="badge" className="rounded-lg border border-border/50 bg-background/40 px-1.5 py-0.5 text-xs shadow-sm">↑↓</kbd>
                        Navigate
                    </span>
                    <span className="flex items-center gap-1">
                        <kbd data-theme-part="badge" className="rounded-lg border border-border/50 bg-background/40 px-1.5 py-0.5 text-xs shadow-sm">↵</kbd>
                        Select
                    </span>
                    <span className="flex items-center gap-1">
                        <kbd data-theme-part="badge" className="rounded-lg border border-border/50 bg-background/40 px-1.5 py-0.5 text-xs shadow-sm">Esc</kbd>
                        {subList ? 'Back' : 'Close'}
                    </span>
                </div>
            </DialogContent>
        </Dialog>
        </>
    )
}
