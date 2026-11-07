import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/common/EmptyState'
import { CopyButton } from '@/components/ui/copy-button'
import { TabsContent } from '@/components/ui/tabs'
import { Tooltip } from '@/components/ui/tooltip'
import { ToolbarShell } from '@/components/ui/toolbar-shell'
import { AddonIcon } from '@/components/ui/addon-icon'
import {
    Card,
    CardHeader,
    CardTitle,
    CardDescription,
    CardContent,
    CardFooter,
} from '@/components/ui/card'
import { useAccountStore, getAccountEmail } from '@/store/accountStore'
import { useAddonStore } from '@/store/addonStore'
import { normalizeUrl } from '@/lib/addon-storage'
import { useVaultStore } from '@/store/vaultStore'
import { useToast } from '@/hooks/use-toast'
import {
    isAIOStreamsAddon,
    parseAIOStreamsUrl,
    fetchAIOStreamsUser,
    updateAIOStreamsUser,
    sanitizeAIOStreamsConfigForUpdate,
    getAIOStreamsConfigureUrl,
    getStoredAIOStreamsPassword,
    saveAIOStreamsPassword,
    migrateAIOStreamsVaultNames,
    fetchAIOStreamsStatus,
    getConfigSections,
    getSectionSummary,
    getConfigStats,
    verifyAIOStreamsWriteReadback,
    buildAIOStreamsVariantInstallUrl,
    findAIOStreamsQuerySelectorCollisions,
} from '@/lib/aiostreams-utils'
import { extractAddonParams, buildVariantUrl, extractVariantsFromConfig, getVariantSelectorLocation, NO_SELECTION } from '@/lib/addon-params'
import { AIOStreamsSyncTab, TargetOption, MissingTargetAccount } from '@/components/addons/aiostreams/AIOStreamsSyncTab'
import { AIOStreamsActionsTab } from '@/components/addons/aiostreams/AIOStreamsActionsTab'
import { AIOStreamsDiffTab } from '@/components/addons/aiostreams/AIOStreamsDiffTab'
import { PresetsEditor } from '@/components/addons/aiostreams/PresetsEditor'
import { BulkAccountPicker } from '@/components/accounts/BulkAccountPicker'
import { cn, maskNameLevel, maskUrlLevel } from '@/lib/utils'
import { useUIStore } from '@/store/uiStore'
import { PopoverFacts, VaultLockedNotice, WorkspaceAction, WorkspaceError, WorkspaceHeader, WorkspaceStatusPill, WorkspaceTabs, type WorkspaceTabItem } from '@/components/providers/workspace'
import { aiostreamsInstallUrl } from '@/components/providers/workspace/workspace-model'
import { maskSecretUrl } from '@/lib/mask-secret-url'
import {
    ArrowLeft, Loader2, AlertTriangle, ExternalLink,
    Eye, ArrowRightLeft, EyeOff, Lock, Shield,
    RefreshCw, Pencil,
    Tv, Users,
    Link2, Server, Layers,
    GitCompare,
} from 'lucide-react'

type Section = 'overview' | 'addons-services' | 'users' | 'sync' | 'diff'

const SECTION_TABS: (WorkspaceTabItem & { id: Section })[] = [
    { id: 'overview', label: 'Overview', icon: <Eye className="h-3.5 w-3.5" /> },
    { id: 'addons-services', label: 'Addons & Services', icon: <Tv className="h-3.5 w-3.5" /> },
    { id: 'users', label: 'Users', icon: <Users className="h-3.5 w-3.5" /> },
    { id: 'sync', label: 'Sync', icon: <ArrowRightLeft className="h-3.5 w-3.5" /> },
    { id: 'diff', label: 'Config diff', icon: <GitCompare className="h-3.5 w-3.5" />, readOnly: true },
]

export function AIOStreamsPage() {
    const { accountId, uuid } = useParams<{ accountId: string; uuid: string }>()
    const navigate = useNavigate()
    const accounts = useAccountStore(s => s.accounts)
    const vaultLocked = useVaultStore(s => s.isLocked)
    const { toast } = useToast()

    const account = useMemo(() => accounts.find(a => a.id === accountId), [accounts, accountId])
    const addon = useMemo(() => {
        if (!account) return null
        return account.addons.find(a => {
            if (!isAIOStreamsAddon(a)) return false
            const p = parseAIOStreamsUrl(a.transportUrl)
            return p?.uuid === uuid
        })
    }, [account, uuid])

    const hasAddon = !!addon
    const parsed = useMemo(() => addon ? parseAIOStreamsUrl(addon.transportUrl) : null, [addon])
    const baseUrl = parsed?.baseUrl ?? ''
    const shouldRedirect = !addon || !account || !uuid

    const [connected, setConnected] = useState(false)
    const [password, setPassword] = useState('')
    const [showPassword, setShowPassword] = useState(false)
    const [rememberPassword, setRememberPassword] = useState(false)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState('')
    const [activeSection, setActiveSection] = useState<Section>('overview')
    const [presetsEditing, setPresetsEditing] = useState(false)
    // Effective (merged) view drives every display surface; the raw view is the
    // editing base so writes never bake inherited parent values into the child.
    const [sourceConfig, setSourceConfig] = useState<Record<string, unknown> | null>(null)
    const [sourceRawConfig, setSourceRawConfig] = useState<Record<string, unknown> | null>(null)
    const [instanceStatus, setInstanceStatus] = useState<Record<string, unknown> | null>(null)
    const [instanceReachable, setInstanceReachable] = useState(true)
    const [encryptedPassword, setEncryptedPassword] = useState<string | null>(null)
    const [refreshError, setRefreshError] = useState('')
    const [refreshedAt, setRefreshedAt] = useState<number | null>(null)
    const privacyOn = useUIStore(s => s.isPrivacyModeEnabled)
    const nameLevel = useUIStore(s => s.privacyLevelNames)
    const urlLevel = useUIStore(s => s.privacyLevelUrls)

    const passwordRef = useRef<HTMLInputElement>(null)

    const targetOptions: TargetOption[] = useMemo(() => {
        const seen = new Map<string, TargetOption>()
        for (const acc of accounts) {
            for (const a of (acc.addons || [])) {
                if (!isAIOStreamsAddon(a)) continue
                const p = parseAIOStreamsUrl(a.transportUrl)
                if (!p || (p.baseUrl === baseUrl && p.uuid === uuid)) continue
                const key = `${p.baseUrl}|${p.uuid}`
                if (!seen.has(key)) {
                    seen.set(key, {
                        accountId: acc.id,
                        accountName: acc.name || getAccountEmail(acc) || acc.id,
                        addonName: a.metadata?.customName || a.manifest.name || 'AIOStreams',
                        transportUrl: a.transportUrl,
                        baseUrl: p.baseUrl,
                        uuid: p.uuid,
                        logo: a.metadata?.customLogo || a.manifest.logo,
                    })
                } else {
                    const existing = seen.get(key)!
                    existing.accountName = `${existing.accountName}, ${acc.name || getAccountEmail(acc) || acc.id}`
                }
            }
        }
        return Array.from(seen.values())
    }, [accounts, uuid, baseUrl])

    const missingAIOStreamsAccounts: MissingTargetAccount[] = useMemo(() => accounts
        .filter(acc => acc.id !== accountId && !(acc.addons || []).some(isAIOStreamsAddon))
        .map(acc => ({
            accountId: acc.id,
            accountName: acc.name || getAccountEmail(acc) || acc.id,
        })), [accounts, accountId])

    const sameUserAccounts = useMemo(() => accounts
        .filter(acc => acc.id !== accountId && acc.addons.some(a => {
            if (!isAIOStreamsAddon(a)) return false
            const p = parseAIOStreamsUrl(a.transportUrl)
            return p?.baseUrl === baseUrl && p.uuid === uuid
        }))
        .map(acc => ({
            id: acc.id,
            name: acc.name,
            email: getAccountEmail(acc),
            emoji: acc.emoji,
        })), [accounts, accountId, baseUrl, uuid])

    const linkedAccounts = useMemo(() => accounts.filter(acc =>
        acc.id !== accountId && acc.addons.some(a => {
            if (!isAIOStreamsAddon(a)) return false
            const p = parseAIOStreamsUrl(a.transportUrl)
            return p?.baseUrl === baseUrl && p.uuid !== uuid
        })
    ), [accounts, accountId, baseUrl, uuid])

    useEffect(() => {
        if (!hasAddon) {
            navigate(`/account/${accountId}`)
            return
        }

        migrateAIOStreamsVaultNames().catch(() => {})
        setConnected(false)
        setError('')
        setSourceConfig(null)
        setSourceRawConfig(null)
        setEncryptedPassword(null)
        setRefreshError('')
        setRefreshedAt(null)
        setActiveSection('overview')
        setInstanceStatus(null)
        setInstanceReachable(true)
        fetchAIOStreamsStatus(baseUrl).then(s => {
            if (s) setInstanceStatus(s)
            else setInstanceReachable(false)
        }).catch(() => setInstanceReachable(false))
        const stored = getStoredAIOStreamsPassword(baseUrl, uuid || '')
        if (stored) {
            setPassword(stored)
            setRememberPassword(true)
        } else {
            setPassword('')
            setRememberPassword(false)
        }
    }, [hasAddon, baseUrl, uuid, accountId, navigate])

    useEffect(() => {
        if (!connected) {
            setTimeout(() => passwordRef.current?.focus(), 100)
        }
    }, [connected])

    const loadConfigs = useCallback(async () => {
        if (!uuid || !password) throw new Error('Missing AIOStreams user credentials')
        // Effective view for display, raw view as the editing/writing base.
        const [effective, raw] = await Promise.all([
            fetchAIOStreamsUser(baseUrl, uuid, password),
            fetchAIOStreamsUser(baseUrl, uuid, password, { raw: true }),
        ])
        setSourceConfig(effective.userData as Record<string, unknown>)
        setSourceRawConfig(raw.userData as Record<string, unknown>)
        // The install URL secret comes back beside userData, not inside it.
        setEncryptedPassword(typeof effective.encryptedPassword === 'string' && effective.encryptedPassword ? effective.encryptedPassword : null)
        setRefreshedAt(Date.now())
        return { effective: effective.userData as Record<string, unknown>, raw: raw.userData as Record<string, unknown> }
    }, [baseUrl, uuid, password])

    const handleConnect = useCallback(async () => {
        if (!password.trim() || !uuid) { setError('Password is required'); return }
        setLoading(true)
        setError('')
        try {
            await loadConfigs()
            if (rememberPassword) {
                try { await saveAIOStreamsPassword(baseUrl, uuid, password) } catch {}
            }
            setConnected(true)
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : 'Failed to connect')
        } finally {
            setLoading(false)
        }
    }, [loadConfigs, password, uuid, rememberPassword, baseUrl])

    const handleRefresh = useCallback(async () => {
        if (!password || !uuid) return
        setLoading(true)
        setRefreshError('')
        try {
            await loadConfigs()
        } catch (e: unknown) {
            setRefreshError(e instanceof Error ? e.message : 'Failed to refresh')
        } finally {
            setLoading(false)
        }
    }, [loadConfigs, uuid, password])

    const handleSavePresets = useCallback(async (presets: unknown[]): Promise<boolean> => {
        const updated = presetWriteConfig(sourceRawConfig, presets)
        if (!updated || !uuid || !password) {
            toast({ title: 'Cannot save presets', description: updated ? 'Missing AIOS password or vault locked.' : 'The editable config has not loaded. Refresh and try again.', variant: 'destructive' })
            return false
        }
        try {
            const sanitized = sanitizeAIOStreamsConfigForUpdate(updated)
            await updateAIOStreamsUser(baseUrl, uuid, password, sanitized)
            const { raw } = await loadConfigs()
            // Semantic readback: the presets we sent must be what the child now stores.
            // The upstream PUT has no version guard, so a mismatch usually means a
            // concurrent writer won; surface it instead of trusting the write.
            const verification = verifyAIOStreamsWriteReadback({
                planned: sanitized,
                readback: raw,
                fields: ['presets'],
            })
            if (!verification.ok) {
                toast({
                    title: 'Presets saved but did not verify',
                    description: 'The instance stored different presets than were sent (it may have been changed elsewhere). Latest config was reloaded - review before retrying.',
                    variant: 'destructive',
                })
                return false
            }
            toast({
                title: 'Presets updated',
                description: `${Array.isArray(presets) ? presets.length : 0} addon${Array.isArray(presets) && presets.length !== 1 ? 's' : ''} saved`,
            })
            return true
        } catch (e: unknown) {
            toast({
                title: 'Failed to update presets',
                description: e instanceof Error ? e.message : 'Unknown error',
                variant: 'destructive',
            })
            return false
        }
    }, [sourceRawConfig, uuid, password, baseUrl, loadConfigs, toast])

    useEffect(() => {
        if (shouldRedirect) {
            navigate(accountId ? `/account/${accountId}` : '/', { replace: true })
        }
    }, [accountId, navigate, shouldRedirect])

    if (shouldRedirect) {
        return null
    }

    const addonName = addon.manifest.name || 'AIOStreams'
    const accountLabel = account.name || getAccountEmail(account) || accountId || 'Unknown account'
    const configureUrl = getAIOStreamsConfigureUrl(addon.transportUrl)
    const installUrl = aiostreamsInstallUrl(baseUrl, uuid, encryptedPassword)
    const headerStats = sourceConfig ? getConfigStats(sourceConfig) : null
    const version = instanceStatus && typeof instanceStatus.tag === 'string' ? `v${instanceStatus.tag}` : null
    const maskedBase = maskUrlLevel(baseUrl, privacyOn ? urlLevel : 0)
    const maskedAccount = maskNameLevel(accountLabel, privacyOn ? nameLevel : 0)
    const pill = !instanceReachable ? 'error' : refreshError ? 'degraded' : 'active'
    const pillText = !instanceReachable ? 'Unreachable' : refreshError ? 'Refresh failed' : 'Reachable'

    const changeSection = (s: Section) => {
        if (presetsEditing && s !== activeSection) {
            toast({ title: 'Save or cancel preset changes first' })
            return
        }
        setActiveSection(s)
    }

    return (
        <div className="w-full mx-auto py-6 px-4 md:px-8 lg:px-12 xl:px-16 space-y-4 max-w-[1800px]">
            <ToolbarShell className="w-fit max-w-full p-2" contentClassName="gap-2">
                <Button
                    variant="ghost"
                    size="sm"
                    className="mt-0.5 h-8 shrink-0 gap-1.5 rounded-xl border border-border/40 bg-card px-2.5 text-xs font-medium text-muted-foreground shadow-sm hover:bg-muted/50 hover:text-foreground"
                    onClick={() => navigate(`/account/${accountId}`)}
                >
                    <ArrowLeft className="h-4 w-4" />
                    Back
                </Button>
            </ToolbarShell>

            {!connected ? (
                <CredentialsGate
                    password={password}
                    setPassword={setPassword}
                    showPassword={showPassword}
                    setShowPassword={setShowPassword}
                    rememberPassword={rememberPassword}
                    setRememberPassword={setRememberPassword}
                    loading={loading}
                    error={error}
                    passwordRef={passwordRef}
                    onConnect={handleConnect}
                    configureUrl={configureUrl}
                />
            ) : (
                <WorkspaceTabs
                    label={`${addonName} workspace`}
                    tabs={SECTION_TABS}
                    value={activeSection}
                    onValueChange={value => changeSection(value as Section)}
                    header={
                        <WorkspaceHeader
                            logo={<AddonIcon name={addonName} logo={addon.metadata?.customLogo || addon.manifest.logo} alt={addonName} className="h-12 w-12" textClassName="text-sm" />}
                            title={addonName}
                            pill={
                                <WorkspaceStatusPill status={pill} label={pillText}>
                                    <div className="space-y-1">
                                        <p className="truncate text-sm font-semibold">{addonName}</p>
                                        <p className="text-xs text-muted-foreground">
                                            {!instanceReachable ? 'The instance did not answer its status check.' : refreshError ? 'The last refresh failed. Showing the config from the previous read.' : 'The instance is reachable and this user is signed in.'}
                                        </p>
                                    </div>
                                    <PopoverFacts facts={[
                                        { label: 'Instance', value: maskedBase },
                                        { label: 'Version', value: version || 'Unknown' },
                                        { label: 'Account', value: maskedAccount },
                                        { label: 'Last read', value: refreshedAt ? new Date(refreshedAt).toLocaleTimeString() : 'Not yet' },
                                        ...(refreshError ? [{ label: 'Last error', value: refreshError, tone: 'destructive' as const }] : []),
                                    ]} />
                                    <Button size="sm" variant="outline" className="h-9 w-full text-xs" data-close-popover onClick={handleRefresh} disabled={loading}>
                                        <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
                                        Refresh
                                    </Button>
                                </WorkspaceStatusPill>
                            }
                            identity={[maskedBase, version, maskedAccount].filter(Boolean).join(' · ')}
                            actions={<>
                                <WorkspaceAction onClick={handleRefresh} disabled={loading}>
                                    <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
                                    Refresh
                                </WorkspaceAction>
                                {configureUrl && (
                                    <WorkspaceAction asChild>
                                        <a href={configureUrl} target="_blank" rel="noopener noreferrer"><ExternalLink className="h-3.5 w-3.5" />Configure</a>
                                    </WorkspaceAction>
                                )}
                            </>}
                            notice={refreshError ? (
                                <WorkspaceError title="Refresh failed" message={`${refreshError} Showing the config from the previous read.`} onRetry={loading ? undefined : handleRefresh} />
                            ) : vaultLocked ? <VaultLockedNotice>Unlock your vault to edit presets or compare with other instances.</VaultLockedNotice> : undefined}
                            stats={headerStats ? [
                                { label: 'Sections', value: String(headerStats.sections) },
                                { label: 'Filters', value: String(headerStats.filters) },
                                { label: 'Toggles', value: String(headerStats.toggles) },
                                { label: 'API keys', value: String(headerStats.keys) },
                            ] : undefined}
                        />
                    }
                >
                    <TabsContent value={activeSection}>
                        {sourceConfig ? (
                            <SectionContent
                                activeSection={activeSection}
                                sourceConfig={sourceConfig}
                                sourceRawConfig={sourceRawConfig}
                                baseUrl={baseUrl}
                                configureUrl={configureUrl}
                                uuid={uuid}
                                targetOptions={targetOptions}
                                accountName={account.name || getAccountEmail(account) || accountId || ''}
                                linkedAccounts={linkedAccounts.map(acc => ({
                                    id: acc.id,
                                    name: acc.name,
                                    email: getAccountEmail(acc),
                                    emoji: acc.emoji,
                                }))}
                                sameUserAccounts={sameUserAccounts}
                                instanceStatus={instanceStatus}
                                installUrl={installUrl}
                                accountId={accountId!}
                                transportUrl={addon?.transportUrl ?? ''}
                                missingAccounts={missingAIOStreamsAccounts}
                                onClose={() => navigate(`/account/${accountId}`)}
                                password={password}
                                vaultLocked={vaultLocked}
                                onSavePresets={handleSavePresets}
                                onOpenSync={() => changeSection('sync')}
                                presetsEditing={presetsEditing}
                                setPresetsEditing={setPresetsEditing}
                            />
                        ) : (
                            <div className="space-y-4">
                                <Skeleton className="h-32 w-full rounded-xl" />
                                <Skeleton className="h-64 w-full rounded-xl" />
                            </div>
                        )}
                    </TabsContent>
                </WorkspaceTabs>
            )}
        </div>
    )
}

function CredentialsGate({ password, setPassword, showPassword, setShowPassword, rememberPassword, setRememberPassword, loading, error, passwordRef, onConnect, configureUrl }: {
    password: string
    setPassword: (v: string) => void
    showPassword: boolean
    setShowPassword: (v: boolean) => void
    rememberPassword: boolean
    setRememberPassword: (v: boolean) => void
    loading: boolean
    error: string
    passwordRef: React.RefObject<HTMLInputElement | null>
    onConnect: () => void
    configureUrl: string | null
}) {
    return (
        <div className="max-w-md mx-auto my-12">
            <Card className="border border-border/40 shadow-sm bg-card relative overflow-hidden">
                <CardHeader className="text-center relative z-10">
                    <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-2xl bg-muted/35 text-muted-foreground ring-1 ring-border/40">
                        <Lock className="w-5 h-5" />
                    </div>
                    <CardTitle className="text-xl">Authentication Required</CardTitle>
                    <CardDescription>
                        Enter the AIOStreams instance password to manage this user.
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4 relative z-10">
                    <div className="space-y-2">
                        <Label htmlFor="password" className="text-xs font-medium text-muted-foreground uppercase">Password</Label>
                        <div className="relative">
                            <Shield className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                            <Input
                                id="password"
                                ref={passwordRef}
                                type={showPassword ? 'text' : 'password'}
                                placeholder="Instance password"
                                value={password}
                                onChange={e => setPassword(e.target.value)}
                                onKeyDown={e => e.key === 'Enter' && onConnect()}
                                disabled={loading}
                                className="pl-9 pr-10 h-11"
                            />
                            <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="absolute right-0 top-0 h-full px-3 text-muted-foreground hover:text-foreground"
                                onClick={() => setShowPassword(!showPassword)}
                                tabIndex={-1}
                                aria-label={showPassword ? "Hide password" : "Show password"}
                            >
                                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                            </Button>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        <Checkbox id="remember" checked={rememberPassword} onCheckedChange={(c) => setRememberPassword(!!c)} />
                        <Label htmlFor="remember" className="text-sm font-normal cursor-pointer">Remember password locally</Label>
                    </div>
                    {error && (
                        <div data-theme-tone="status" data-theme-part="panel" className="flex items-center gap-2 text-destructive text-sm bg-destructive/10 p-3 rounded-lg border border-destructive/20" role="alert">
                            <AlertTriangle className="w-4 h-4 shrink-0" />
                            <p>{error}</p>
                        </div>
                    )}
                </CardContent>
                <CardFooter className="relative z-10 flex flex-col gap-2">
                    <Button onClick={onConnect} disabled={loading || !password.trim()} className="w-full shine-sweep gap-2" size="xl">
                        {loading && <Loader2 className="w-4 h-4 animate-spin" />}
                        {loading ? 'Connecting...' : 'Connect'}
                    </Button>
                    {configureUrl && (
                        <Button variant="outline" size="lg" className="w-full gap-2" asChild>
                            <a href={configureUrl} target="_blank" rel="noopener noreferrer">
                                <ExternalLink className="w-4 h-4" />
                                Open in AIOStreams
                            </a>
                        </Button>
                    )}
                </CardFooter>
            </Card>
        </div>
    )
}

function SectionHeader({ title, description }: { title: string; description: string }) {
    return (
        <div className="mb-4">
            <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
            <p className="text-sm text-muted-foreground mt-0.5">{description}</p>
        </div>
    )
}

// Writes edit the child's own (raw) config so inherited parent values stay inherited.
// The effective view is never a fallback: it would bake parent values into the child.
function presetWriteConfig(raw: Record<string, unknown> | null | undefined, presets: unknown[]): Record<string, unknown> | null {
    return raw && typeof raw === 'object' ? { ...raw, presets } : null
}

function resolveLinkedSavedAddonId(accountId: string, oldUrl: string): string | null {
    const { accountStates, library } = useAddonStore.getState()
    const viaAccountState = accountStates[accountId]?.installedAddons.find(
        (installed) => installed.savedAddonId && normalizeUrl(installed.installUrl) === normalizeUrl(oldUrl)
    )
    if (viaAccountState?.savedAddonId && library[viaAccountState.savedAddonId]) return viaAccountState.savedAddonId
    const viaLibraryUrl = Object.values(library).find(
        (savedAddon) => normalizeUrl(savedAddon.installUrl) === normalizeUrl(oldUrl)
    )
    return viaLibraryUrl?.id ?? null
}

function SectionContent({
    activeSection,
    sourceConfig,
    sourceRawConfig,
    baseUrl,
    configureUrl,
    uuid,
    targetOptions,
    accountName,
    linkedAccounts,
    sameUserAccounts,
    instanceStatus,
    installUrl,
    accountId,
    transportUrl,
    missingAccounts,
    onClose,
    password,
    vaultLocked,
    onSavePresets,
    onOpenSync,
    presetsEditing,
    setPresetsEditing,
}: {
    activeSection: Section
    sourceConfig: Record<string, unknown>
    sourceRawConfig: Record<string, unknown> | null
    baseUrl: string
    configureUrl: string | null
    uuid: string
    targetOptions: TargetOption[]
    accountName: string
    linkedAccounts: { id: string; name?: string; email?: string; emoji?: string }[]
    sameUserAccounts: { id: string; name?: string; email?: string; emoji?: string }[]
    instanceStatus: Record<string, unknown> | null
    installUrl: string | null
    accountId: string
    transportUrl: string
    missingAccounts: MissingTargetAccount[]
    onClose: () => void
    password: string
    vaultLocked: boolean
    onSavePresets: (presets: unknown[]) => Promise<boolean> | boolean
    onOpenSync: () => void
    presetsEditing: boolean
    setPresetsEditing: (v: boolean) => void
}) {
    const sections = useMemo(() => getConfigSections(sourceConfig), [sourceConfig])
    const [presetsSaving, setPresetsSaving] = useState(false)
    const { toast } = useToast()
    const [variantSwapping, setVariantSwapping] = useState(false)
    const [bulkVariantExpanded, setBulkVariantExpanded] = useState(false)
    const [bulkVariantSelected, setBulkVariantSelected] = useState<Set<string>>(new Set())

    const availableVariants = useMemo(() => extractVariantsFromConfig(sourceConfig), [sourceConfig])
    const currentVariant = useMemo(() => extractAddonParams(transportUrl).params.variant || '', [transportUrl])

    const handleVariantSwap = async (value: string) => {
        const variantId = value === NO_SELECTION ? null : value
        const variantLocation = getVariantSelectorLocation(sourceConfig)
        const buildUrl = (current: string): string => {
            // AIOS-scoped helper: path (`/v/`) selectors stay distinct in
            // AIOManager's query-stripped addon identity; query (`?v=`) ones
            // collapse onto one addon when they differ only by query string.
            return buildAIOStreamsVariantInstallUrl(current, variantId, { selectorLocation: variantLocation })
                ?? buildVariantUrl(current, variantId, variantLocation)
        }
        const newUrl = buildUrl(transportUrl)
        if (newUrl === transportUrl) return

        const otherTargets: { accountId: string; oldUrl: string; newUrl: string }[] = []
        for (const accId of bulkVariantSelected) {
            const acc = useAccountStore.getState().accounts.find(a => a.id === accId)
            if (!acc) continue
            const matched = acc.addons.find(a => {
                if (!isAIOStreamsAddon(a)) return false
                const p = parseAIOStreamsUrl(a.transportUrl)
                return p?.baseUrl === baseUrl && p.uuid === uuid
            })
            if (!matched) continue
            const theirNewUrl = buildUrl(matched.transportUrl)
            if (theirNewUrl === matched.transportUrl) continue
            otherTargets.push({ accountId: acc.id, oldUrl: matched.transportUrl, newUrl: theirNewUrl })
        }

        setVariantSwapping(true)
        try {
            await useAccountStore.getState().replaceTransportUrl(transportUrl, newUrl, accountId)
            if (otherTargets.length === 0) {
                toast({ title: 'Variant updated', description: variantId ? `Switched to ${variantId}` : 'Switched to base config' })
            } else {
                let success = 0
                let fail = 0
                const results = await Promise.allSettled(otherTargets.map(t =>
                    useAccountStore.getState().replaceTransportUrl(t.oldUrl, t.newUrl, t.accountId)
                ))
                for (const r of results) {
                    if (r.status === 'fulfilled') success++
                    else fail++
                }
                const total = 1 + success
                if (fail === 0) {
                    toast({ title: 'Variant updated across accounts', description: `${variantId ? `Switched to ${variantId}` : 'Switched to base config'}. ${total} account${total !== 1 ? 's' : ''}` })
                } else {
                    toast({ title: 'Variant partially updated', description: `${total} succeeded, ${fail} failed`, variant: 'destructive' })
                }
                setBulkVariantSelected(new Set())
            }

            // Sync the linked library entry so normalizeUrl(account URL) === normalizeUrl(library installUrl) and syncAccountState linkage survives.
            const linkedSavedAddonId = resolveLinkedSavedAddonId(accountId, transportUrl)
            if (linkedSavedAddonId) {
                try {
                    await useAddonStore.getState().updateSavedAddon(linkedSavedAddonId, { installUrl: newUrl })
                } catch (err) {
                    if (import.meta.env.DEV) console.warn('[AIOStreamsPage] Saved-addon library URL sync failed after variant swap:', err)
                }
            }

            // Query-selected variants of one AIOStreams user collapse onto a
            // single AIOManager addon (identity strips the query string). If any
            // affected account now holds colliding URLs, tell the user to switch
            // the instance's variant selector to the path form (`/v/`).
            if (variantLocation === 'query') {
                const affectedIds = [accountId, ...otherTargets.map(t => t.accountId)]
                const currentAccounts = useAccountStore.getState().accounts
                for (const accId of affectedIds) {
                    const acc = currentAccounts.find(a => a.id === accId)
                    if (!acc) continue
                    const urls = (acc.addons || [])
                        .filter(isAIOStreamsAddon)
                        .map(a => a.transportUrl)
                    const collisions = findAIOStreamsQuerySelectorCollisions(urls)
                    if (collisions.length > 0) {
                        toast({
                            title: 'Variant URLs collide in AIOManager',
                            description: `${acc.name || acc.id} holds AIOStreams URLs that differ only by query string, so they overwrite each other. Switch the variant selector location to "Path segment (/v/)" on the AIOStreams instance and re-apply.`,
                            variant: 'destructive',
                        })
                        break
                    }
                }
            }
        } catch (err) {
            toast({ title: 'Failed to switch variant', description: err instanceof Error ? err.message : undefined, variant: 'destructive' })
        } finally {
            setVariantSwapping(false)
        }
    }

    const configSize = useMemo(() => {
        const json = JSON.stringify(sourceConfig)
        const bytes = new Blob([json]).size
        if (bytes < 1024) return `${bytes} B`
        return `${(bytes / 1024).toFixed(1)} KB`
    }, [sourceConfig])

    const formatterSummary = useMemo(() => {
        const f = sourceConfig.formatter as { id?: string } | undefined
        if (!f?.id) return null
        return f.id.charAt(0).toUpperCase() + f.id.slice(1)
    }, [sourceConfig])

    const services = useMemo(() => {
        const raw = sourceConfig.services
        if (!Array.isArray(raw)) return []
        return raw as Record<string, unknown>[]
    }, [sourceConfig])

    const addons = useMemo(() => {
        const raw = sourceConfig.presets
        if (!Array.isArray(raw)) return []
        return raw as Record<string, unknown>[]
    }, [sourceConfig])
    // The editor edits the child's OWN presets (raw view). When this config
    // inherits presets from a parent, the effective list shown above is wider
    // than what the editor may change; say so instead of silently flattening.
    const editablePresets = useMemo(() => {
        const base = sourceRawConfig ?? sourceConfig
        const raw = base.presets
        return Array.isArray(raw) ? (raw as Record<string, unknown>[]) : []
    }, [sourceRawConfig, sourceConfig])
    const inheritedPresetsCount = useMemo(() => {
        const effective = Array.isArray(sourceConfig.presets) ? sourceConfig.presets.length : 0
        const own = Array.isArray((sourceRawConfig ?? sourceConfig).presets) ? ((sourceRawConfig ?? sourceConfig).presets as unknown[]).length : 0
        return Math.max(0, effective - own)
    }, [sourceConfig, sourceRawConfig])
    const filterSections = useMemo(() => sections.filter(s => s.category === 'filter'), [sections])
    const toggleSections = useMemo(() => sections.filter(s => s.category === 'toggle'), [sections])
    const sortSection = useMemo(() => sections.find(s => s.key === 'sortCriteria'), [sections])

    switch (activeSection) {
        case 'overview':
            return (
                <div className="space-y-6">
                    <SectionHeader title="Overview" description="Instance summary and quick actions" />

                    <div data-theme-part="panel" className="p-5 rounded-2xl border border-border/40 bg-card/50 shadow-sm space-y-3">
                        <h3 className="text-sm font-semibold">Instance Details</h3>
                        <div className="grid gap-3 text-sm">
                            <div className="flex items-center justify-between">
                                <span className="text-muted-foreground">URL</span>
                                <span className="font-mono text-xs truncate max-w-[60%]">{baseUrl}</span>
                            </div>
                            <div className="flex items-center justify-between gap-2">
                                <span className="text-muted-foreground">UUID</span>
                                <div className="flex items-center gap-1.5">
                                    <code className="text-xs font-mono">{uuid}</code>
                                    <CopyButton value={uuid} variant="ghost" className="h-6 w-6 flex items-center justify-center" iconSize={12} />
                                </div>
                            </div>
                            <div className="flex items-center justify-between">
                                <span className="text-muted-foreground">Account</span>
                                <span className="font-medium">{accountName}</span>
                            </div>
                            <div className="flex items-center justify-between">
                                <span className="text-muted-foreground">Version</span>
                                <span className="font-mono text-xs">{instanceStatus && typeof instanceStatus.tag === 'string' ? `v${instanceStatus.tag}` : 'Unknown'}</span>
                            </div>
                            <div className="flex items-center justify-between">
                                <span className="text-muted-foreground">Config Size</span>
                                <span className="font-mono text-xs">{configSize}</span>
                            </div>
                            {formatterSummary && (
                                <div className="flex items-center justify-between">
                                    <span className="text-muted-foreground">Formatter</span>
                                    <span className="font-medium">{formatterSummary}</span>
                                </div>
                            )}
                        </div>
                    </div>

                    {toggleSections.length > 0 && (
                        <div className="space-y-2">
                            <h3 className="text-sm font-semibold">Quick Settings</h3>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                {toggleSections.map(section => (
                                    <div key={section.key} data-theme-part="panel" className="flex items-center justify-between px-3 py-2 rounded-lg border border-border/30 bg-muted/10">
                                        <span className="text-xs font-medium">{section.label}</span>
                                        <span className={cn(
                                            "text-xs font-semibold",
                                            section.data ? "text-success" : "text-muted-foreground"
                                        )}>
                                            {section.data ? "On" : "Off"}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {(filterSections.length > 0 || sortSection) && (
                        <div data-theme-part="panel" className="p-4 rounded-2xl border border-border/40 bg-card/50 shadow-sm space-y-2">
                            <div className="flex items-center justify-between">
                                <h3 className="text-sm font-semibold">Filters & Sorting</h3>
                                <span className="text-xs text-muted-foreground">{filterSections.length} filter rule{filterSections.length !== 1 ? 's' : ''}</span>
                            </div>
                            <p className="text-xs text-muted-foreground">
                                {sortSection ? `Sorting: ${getSectionSummary(sortSection.key, sortSection.data)}` : 'No sorting configured'}
                            </p>
                            {configureUrl && (
                                <Button variant="outline" size="sm" className="gap-2 mt-1" asChild>
                                    <a href={configureUrl} target="_blank" rel="noopener noreferrer">
                                        <ExternalLink className="w-3.5 w-3.5" /> Configure in AIOStreams
                                    </a>
                                </Button>
                            )}
                        </div>
                    )}

                    {installUrl && (
                        <div data-theme-part="panel" className="p-4 rounded-2xl border border-border/40 bg-card/50 shadow-sm space-y-2">
                            <h3 className="text-sm font-semibold">Install URL</h3>
                            <div className="flex items-center gap-2">
                                <code data-theme-part="field" className="flex-1 text-xs font-mono bg-muted/30 px-3 py-2 rounded-lg truncate">{maskSecretUrl(installUrl)}</code>
                                <CopyButton value={installUrl} variant="outline" className="h-9 w-9 shrink-0" iconSize={14} />
                            </div>
                        </div>
                    )}

                    {availableVariants.length > 0 && (
                        <div data-theme-part="panel" className="p-4 rounded-2xl border border-border/40 bg-card/50 shadow-sm space-y-2">
                            <h3 className="text-sm font-semibold flex items-center gap-1.5">
                                <Layers className="w-3.5 h-3.5" /> Active Variant
                            </h3>
                            <p className="text-xs text-muted-foreground">
                                Switch the variant applied at request time. Updates the addon URL in place.
                            </p>
                            <Select value={currentVariant || NO_SELECTION} onValueChange={handleVariantSwap} disabled={variantSwapping}>
                                <SelectTrigger className="w-full">
                                    <SelectValue placeholder="Base config (no variant)" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value={NO_SELECTION}>Base config (no variant)</SelectItem>
                                    {availableVariants.map(v => (
                                        <SelectItem key={v.id} value={v.id}>{v.name || v.id}</SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                            {sameUserAccounts.length > 0 && (
                                <BulkAccountPicker
                                    label={`Also apply to ${sameUserAccounts.length} other account${sameUserAccounts.length !== 1 ? 's' : ''}`}
                                    accounts={sameUserAccounts}
                                    expanded={bulkVariantExpanded}
                                    onExpandedChange={setBulkVariantExpanded}
                                    selected={bulkVariantSelected}
                                    onSelectedChange={setBulkVariantSelected}
                                    disabled={variantSwapping}
                                />
                            )}
                        </div>
                    )}

                    {sameUserAccounts.length > 0 && (
                        <div data-theme-tone="status" data-theme-part="panel" className="p-4 rounded-2xl border border-info/20 bg-info/5 shadow-sm space-y-2">
                            <h3 className="text-sm font-semibold">Same User Also Installed</h3>
                            <p className="text-xs text-muted-foreground">
                                These accounts already use this exact AIOStreams user, so they are shown here instead of as sync targets.
                            </p>
                            <div className="flex flex-wrap gap-2 mt-2">
                                {sameUserAccounts.map(acc => (
                                    <span key={acc.id} data-theme-part="badge" className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-background/60 border border-info/20">
                                        <Users className="w-3 h-3 text-info" />
                                        {acc.emoji ? `${acc.emoji} ` : ''}{acc.name || acc.email || acc.id}
                                    </span>
                                ))}
                            </div>
                        </div>
                    )}

                    {linkedAccounts.length > 0 && (
                        <div data-theme-part="panel" className="p-4 rounded-2xl border border-border/40 bg-card/50 shadow-sm space-y-2">
                            <h3 className="text-sm font-semibold">Other Users On This Instance</h3>
                            <p className="text-xs text-muted-foreground">Other accounts using different AIOStreams users on this same instance</p>
                            <div className="flex flex-wrap gap-2 mt-2">
                                {linkedAccounts.map(acc => (
                                    <span key={acc.id} data-theme-part="badge" className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-muted/30 border border-border/30">
                                        <Link2 className="w-3 h-3 text-muted-foreground" />
                                        {acc.emoji ? `${acc.emoji} ` : ''}{acc.name || acc.email || acc.id}
                                    </span>
                                ))}
                            </div>
                        </div>
                    )}

                    {configureUrl && (
                        <div data-theme-part="panel" className="rounded-2xl border border-border/40 bg-muted/25 p-4 space-y-2">
                            <p className="text-sm text-muted-foreground">For detailed configuration, use AIOStreams' visual editor.</p>
                            <Button variant="outline" size="sm" className="gap-2" asChild>
                                <a href={configureUrl} target="_blank" rel="noopener noreferrer">
                                    <ExternalLink className="w-3.5 w-3.5" />
                                    Configure in AIOStreams
                                </a>
                            </Button>
                        </div>
                    )}

                </div>
            )

        case 'addons-services': {
            const canEditPresets = !vaultLocked && !!password
            const handlePresetsSave = async (presets: unknown[]) => {
                setPresetsSaving(true)
                const ok = await onSavePresets(presets)
                if (ok) setPresetsEditing(false)
                setPresetsSaving(false)
            }
            return (
                <div className="space-y-6">
                    <SectionHeader title="Addons & Services" description="Manage services and addon presets" />

                    <div className="space-y-4">
                        <div className="flex items-center justify-between">
                            <h3 className="text-sm font-semibold">Services</h3>
                            <span className="text-xs text-muted-foreground">{services.length} configured</span>
                        </div>
                        {services.length === 0 ? (
                            <EmptyState
                                icon={<Server className="h-6 w-6" />}
                                title="No services configured"
                                description="Connect a debrid service (Real-Debrid, AllDebrid, Premiumize, TorBox, etc.) so AIOStreams can pull cached, high-speed streams."
                            />
                        ) : (
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                {services.map((svc, idx) => {
                                    const svcId = String(svc.id || svc.type || `service-${idx}`)
                                    const isEnabled = svc.enabled !== false
                                    const credentials = svc.credentials && typeof svc.credentials === 'object' && !Array.isArray(svc.credentials)
                                        ? svc.credentials as Record<string, unknown>
                                        : {}
                                    const credentialCount = Object.values(credentials).filter(v => v != null && String(v).trim()).length

                                    return (
                                        <div key={idx} data-theme-part="panel" className={cn(
                                            "p-4 rounded-2xl border shadow-sm flex items-center gap-3",
                                            isEnabled ? "border-border/40 bg-card" : "border-border/30 bg-muted/10"
                                        )}>
                                            <div className={cn(
                                                "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl",
                                                isEnabled ? "bg-success/10 text-success" : "bg-muted/30 text-muted-foreground"
                                            )}>
                                                <Tv className="w-4 h-4" />
                                            </div>
                                            <div className="min-w-0 flex-1">
                                                <p className="text-sm font-semibold truncate">{formatName(svcId)}</p>
                                                <p className="text-xs text-muted-foreground">
                                                    {isEnabled ? 'Enabled' : 'Disabled'} · {credentialCount} credential{credentialCount !== 1 ? 's' : ''}
                                                </p>
                                            </div>
                                        </div>
                                    )
                                })}
                            </div>
                        )}
                    </div>

                    <div className="space-y-4 border-t border-border/30 pt-6">
                        {!presetsEditing ? (
                            <>
                                <div className="flex items-center justify-between gap-3 flex-wrap">
                                    <div className="flex items-center gap-2 min-w-0">
                                        <h3 className="text-sm font-semibold">Addons</h3>
                                        <span className="text-xs text-muted-foreground">{addons.length} configured</span>
                                    </div>
                                    <Tooltip content={canEditPresets ? 'Edit addon presets' : 'Unlock Vault to edit.'} side="left">
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            className="gap-1.5 h-8 text-xs shrink-0"
                                            disabled={!canEditPresets}
                                            onClick={() => setPresetsEditing(true)}
                                        >
                                            <Pencil className="w-3 h-3" />
                                            Edit
                                        </Button>
                                    </Tooltip>
                                </div>
                                {addons.length === 0 ? (
                                    <EmptyState
                                        icon={<Layers className="h-6 w-6" />}
                                        title="No addons configured"
                                        description="Add streaming addons (Torrentio, MediaFusion, etc.) to this AIOStreams instance so it has sources to query."
                                    />
                                ) : (
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                        {addons.map((ad, idx) => {
                                            const adOptions = ad.options && typeof ad.options === 'object' && !Array.isArray(ad.options) ? ad.options as Record<string, unknown> : {}
                                            const name = String(adOptions.name || ad.name || ad.type || ad.id || `Addon ${idx + 1}`)
                                            const isEnabled = ad.enabled !== false
                                            const logo = (adOptions.logo ?? ad.logo) as string | undefined
                                            return (
                                                <div key={idx} data-theme-part="addon-card" className={cn(
                                                    "p-4 rounded-2xl border shadow-sm flex items-center gap-3",
                                                    isEnabled ? "border-border/40 bg-card" : "border-border/30 bg-muted/10"
                                                )}>
                                                    <AddonIcon
                                                        name={name}
                                                        logo={logo}
                                                        className="h-8 w-8"
                                                        textClassName="text-xs"
                                                    />
                                                    <div className="flex-1 min-w-0">
                                                        <p className="text-sm font-semibold truncate">{name}</p>
                                                        <p className="text-xs text-muted-foreground font-mono truncate">{String(adOptions.id || ad.id || ad.instanceId || '')}</p>
                                                    </div>
                                                    <span data-theme-part="badge" className={cn(
                                                        "rounded-full px-2 py-0.5 text-xs font-semibold uppercase tracking-wide",
                                                        isEnabled ? "bg-success/10 text-success" : "bg-muted/35 text-muted-foreground"
                                                    )}>
                                                        {isEnabled ? 'On' : 'Off'}
                                                    </span>
                                                </div>
                                            )
                                        })}
                                    </div>
                                )}
                            </>
                        ) : (
                            <div className="space-y-3">
                                <div className="flex items-center justify-between gap-3">
                                    <div className="flex items-center gap-2 min-w-0">
                                        <h3 className="text-sm font-semibold">Edit Addons</h3>
                                        {presetsSaving && (
                                            <span className="text-xs text-muted-foreground flex items-center gap-1">
                                                <Loader2 className="w-3 h-3 animate-spin" /> Saving...
                                            </span>
                                        )}
                                    </div>
                                </div>
                                {inheritedPresetsCount > 0 && (
                                    <p data-theme-tone="status" data-theme-part="panel" className="rounded-xl border border-info/20 bg-info/5 px-3 py-2 text-xs text-info">
                                        This config inherits {inheritedPresetsCount} addon{inheritedPresetsCount !== 1 ? 's' : ''} from a parent config. The editor below manages this child's own addons only - inherited ones stay managed by the parent.
                                    </p>
                                )}
                                <PresetsEditor
                                    value={editablePresets}
                                    onSave={handlePresetsSave}
                                    onCancel={() => setPresetsEditing(false)}
                                    saving={presetsSaving}
                                />
                            </div>
                        )}
                    </div>

                    {configureUrl && !presetsEditing && (
                        <div data-theme-part="panel" className="p-4 rounded-xl border border-primary/25 bg-primary/5 space-y-2 mt-4">
                            <p className="text-sm text-muted-foreground">For advanced configuration, use the official AIOStreams UI.</p>
                            <Button variant="outline" size="sm" className="gap-2" asChild>
                                <a href={configureUrl} target="_blank" rel="noopener noreferrer">
                                    <ExternalLink className="w-3.5 h-3.5" /> Configure in AIOStreams
                                </a>
                            </Button>
                        </div>
                    )}
                </div>
            )
        }

        case 'users':
            return (
                <div className="space-y-4">
                    <SectionHeader title="Users" description="Advanced AIOStreams user creation and deletion tools" />
                    <AIOStreamsActionsTab
                        sourceConfig={sourceConfig}
                        baseUrl={baseUrl}
                        uuid={uuid}
                        targetOptions={targetOptions}
                        accountId={accountId}
                        transportUrl={transportUrl}
                        onClose={onClose}
                    />
                </div>
            )

        case 'sync':
            return (
                <div className="space-y-4">
                    <SectionHeader title="Sync Set" description="Copy this setup to existing or new targets; everything moves unless you choose groups." />
                    <AIOStreamsSyncTab
                        sourceConfig={sourceConfig}
                        targetOptions={targetOptions}
                        sourceName={typeof sourceConfig.addonName === 'string' ? sourceConfig.addonName : 'AIOStreams setup'}
                        sourceAccountName={accountName}
                        sourceBaseUrl={baseUrl}
                        sourceUuid={uuid}
                        missingAccountCount={missingAccounts.length}
                        missingAccounts={missingAccounts}
                        sameUserAccounts={sameUserAccounts.map(acc => ({
                            accountId: acc.id,
                            accountName: `${acc.emoji ? `${acc.emoji} ` : ''}${acc.name || acc.email || acc.id}`,
                        }))}
                    />
                </div>
            )

        case 'diff':
            return (
                <div className="space-y-4">
                    <SectionHeader title="Config Diff" description="Compare this instance's addon presets against another target. Read-only." />
                    <AIOStreamsDiffTab
                        sourceConfig={sourceConfig}
                        targetOptions={targetOptions}
                        vaultLocked={vaultLocked}
                        onOpenSync={onOpenSync}
                    />
                </div>
            )
    }
}

function formatName(s: string): string {
    return s
        .replace(/([A-Z])/g, ' $1')
        .replace(/[_-]/g, ' ')
        .replace(/^./, c => c.toUpperCase())
        .trim()
}
