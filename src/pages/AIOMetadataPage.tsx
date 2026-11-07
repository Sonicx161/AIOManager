import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { CopyButton } from '@/components/ui/copy-button'
import { TabsContent } from '@/components/ui/tabs'
import { ToolbarShell } from '@/components/ui/toolbar-shell'
import { AddonIcon } from '@/components/ui/addon-icon'
import { EmptyState } from '@/components/common/EmptyState'
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card'
import { cn, maskNameLevel, maskUrlLevel } from '@/lib/utils'
import { useUIStore } from '@/store/uiStore'
import { useVaultStore } from '@/store/vaultStore'
import { PopoverFacts, VaultLockedNotice, WorkspaceAction, WorkspaceError, WorkspaceHeader, WorkspaceStatusPill, WorkspaceTabs, type WorkspaceTabItem } from '@/components/providers/workspace'
import { useAccountStore, getAccountEmail } from '@/store/accountStore'
import { useAddonStore } from '@/store/addonStore'
import { normalizeUrl } from '@/lib/addon-storage'
import { useToast } from '@/hooks/use-toast'
import {
    isAIOMetadataAddon,
    parseAIOMetadataUrl,
    getAIOMetadataConfigureUrl,
    fetchAIOMetadataConfig,
    fetchAIOMetadataStatus,
    checkAIOMetadataTrusted,
    getStoredAIOMetadataPassword,
    saveAIOMetadataPassword,
    getConfigSections,
    getConfigStats,
    getSectionSummary,
    type AIOMetadataAddonInfo,
} from '@/lib/aiometadata-utils'
import { extractAddonParams, buildTaggedUrl, NO_SELECTION } from '@/lib/addon-params'
import { AIOMetadataSyncTab, type TargetOption, type MissingTargetAccount } from '@/components/addons/aiometadata/AIOMetadataSyncTab'
import { AIOMetadataActionsTab } from '@/components/addons/aiometadata/AIOMetadataActionsTab'
import { BulkAccountPicker } from '@/components/accounts/BulkAccountPicker'
import { maskSecretUrl } from '@/lib/mask-secret-url'
import {
    ArrowLeft, Loader2, AlertTriangle, ExternalLink, Eye, EyeOff, Lock, Shield,
    ArrowRightLeft, RefreshCw, Database, Image, KeyRound, LayoutGrid, Users, Tag,
} from 'lucide-react'

type Section = 'overview' | 'config' | 'users' | 'sync'

const SECRET_SETTING_KEY = /pass|secret|token|key|auth|cred/i

function SettingRow({ sectionKey, label, data }: { sectionKey: string; label: string; data: unknown }) {
    const [revealed, setRevealed] = useState(false)
    const raw = typeof data === 'string' ? data : ''
    const isUrl = /^https?:\/\//i.test(raw)
    const isSecret = raw.length > 0 && !isUrl && SECRET_SETTING_KEY.test(sectionKey)
    const sensitive = isUrl || isSecret
    const display = !sensitive
        ? getSectionSummary(sectionKey, data)
        : revealed ? raw : isUrl ? maskSecretUrl(raw) : '•'.repeat(Math.min(raw.length, 12))
    return (
        <div data-theme-part="panel" className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-border/30 bg-muted/10">
            <span className="text-xs font-medium shrink-0">{label}</span>
            <span className="flex min-w-0 items-center gap-1">
                <span className="text-xs text-muted-foreground truncate">{display}</span>
                {sensitive && (
                    <>
                        <button type="button" onClick={() => setRevealed(v => !v)} aria-label={revealed ? `Hide ${label}` : `Show ${label}`} className="p-0.5 text-muted-foreground hover:text-foreground transition-colors">
                            {revealed ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                        </button>
                        <CopyButton value={raw} variant="inline" aria-label={`Copy ${label}`} />
                    </>
                )}
            </span>
        </div>
    )
}

export function AIOMetadataPage() {
    const { accountId, uuid } = useParams<{ accountId: string; uuid: string }>()
    const navigate = useNavigate()
    const accounts = useAccountStore(s => s.accounts)

    const account = useMemo(() => accounts.find(a => a.id === accountId), [accounts, accountId])
    const addon = useMemo(() => {
        if (!account) return null
        return account.addons.find(a => {
            if (!isAIOMetadataAddon(a)) return false
            const p = parseAIOMetadataUrl(a.transportUrl)
            return p?.uuid === uuid
        })
    }, [account, uuid])

    const parsed = useMemo(() => addon ? parseAIOMetadataUrl(addon.transportUrl) : null, [addon])
    const baseUrl = parsed?.baseUrl ?? ''
    const hasAddon = !!addon
    const shouldRedirect = !addon || !account || !uuid

    const [connected, setConnected] = useState(false)
    const [password, setPassword] = useState('')
    const [addonPassword, setAddonPassword] = useState('')
    const [showPassword, setShowPassword] = useState(false)
    const [rememberPassword, setRememberPassword] = useState(false)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState('')
    const [activeSection, setActiveSection] = useState<Section>('overview')
    const [sourceConfig, setSourceConfig] = useState<Record<string, unknown> | null>(null)
    const [status, setStatus] = useState<AIOMetadataAddonInfo | null>(null)
    const [reachable, setReachable] = useState(true)
    const [trusted, setTrusted] = useState<boolean | null>(null)
    const [refreshError, setRefreshError] = useState('')
    const [refreshedAt, setRefreshedAt] = useState<number | null>(null)
    const vaultLocked = useVaultStore(s => s.isLocked)
    const privacyOn = useUIStore(s => s.isPrivacyModeEnabled)
    const nameLevel = useUIStore(s => s.privacyLevelNames)
    const urlLevel = useUIStore(s => s.privacyLevelUrls)

    const passwordRef = useRef<HTMLInputElement>(null)

    const targetOptions: TargetOption[] = useMemo(() => accounts.flatMap(acc =>
        (acc.addons || [])
            .filter(a => {
                if (!isAIOMetadataAddon(a)) return false
                const p = parseAIOMetadataUrl(a.transportUrl)
                return p && !(p.baseUrl === baseUrl && p.uuid === uuid)
            })
            .map(a => {
                const p = parseAIOMetadataUrl(a.transportUrl)
                if (!p) return null
                return {
                    accountId: acc.id,
                    accountName: acc.name || getAccountEmail(acc) || acc.id,
                    addonName: a.metadata?.customName || a.manifest.name || 'AIOMetadata',
                    transportUrl: a.transportUrl,
                    baseUrl: p.baseUrl,
                    uuid: p.uuid,
                    logo: a.metadata?.customLogo || a.manifest.logo,
                }
            })
    ).filter(Boolean) as TargetOption[], [accounts, uuid, baseUrl])

    const missingAccounts: MissingTargetAccount[] = useMemo(() => accounts
        .filter(acc => acc.id !== accountId && !(acc.addons || []).some(isAIOMetadataAddon))
        .map(acc => ({ accountId: acc.id, accountName: acc.name || getAccountEmail(acc) || acc.id })), [accounts, accountId])

    const sameUserAccounts = useMemo(() => accounts
        .filter(acc => acc.id !== accountId && acc.addons.some(a => {
            if (!isAIOMetadataAddon(a)) return false
            const p = parseAIOMetadataUrl(a.transportUrl)
            return p?.baseUrl === baseUrl && p.uuid === uuid
        }))
        .map(acc => ({
            id: acc.id,
            name: acc.name,
            email: getAccountEmail(acc),
            emoji: acc.emoji,
        })), [accounts, accountId, baseUrl, uuid])

    useEffect(() => {
        if (!hasAddon) return
        setConnected(false)
        setError('')
        setSourceConfig(null)
        setRefreshError('')
        setRefreshedAt(null)
        setActiveSection('overview')
        setStatus(null)
        setReachable(true)
        setTrusted(null)
        fetchAIOMetadataStatus(baseUrl).then(s => {
            if (s) setStatus(s); else setReachable(false)
        }).catch(() => setReachable(false))
        if (uuid) checkAIOMetadataTrusted(baseUrl, uuid).then(setTrusted).catch(() => {})
        const stored = getStoredAIOMetadataPassword(baseUrl, uuid || '')
        if (stored) { setPassword(stored); setRememberPassword(true) }
        else { setPassword(''); setRememberPassword(false) }
    }, [hasAddon, baseUrl, uuid])

    useEffect(() => {
        if (!connected) setTimeout(() => passwordRef.current?.focus(), 100)
    }, [connected])

    const needsAddonPassword = trusted !== true && status?.requiresAddonPassword === true

    const handleConnect = useCallback(async () => {
        if (!password.trim() || !uuid) { setError('Password is required'); return }
        setLoading(true)
        setError('')
        try {
            const config = await fetchAIOMetadataConfig(baseUrl, uuid, password, addonPassword || undefined)
            setSourceConfig(config)
            setRefreshedAt(Date.now())
            if (rememberPassword) {
                try { await saveAIOMetadataPassword(baseUrl, uuid, password) } catch {}
            }
            setConnected(true)
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : 'Failed to connect')
        } finally {
            setLoading(false)
        }
    }, [baseUrl, uuid, password, addonPassword, rememberPassword])

    const handleRefresh = useCallback(async () => {
        if (!password || !uuid) return
        setLoading(true)
        setRefreshError('')
        try {
            setSourceConfig(await fetchAIOMetadataConfig(baseUrl, uuid, password, addonPassword || undefined))
            setRefreshedAt(Date.now())
        } catch (e: unknown) {
            setRefreshError(e instanceof Error ? e.message : 'Failed to refresh')
        } finally {
            setLoading(false)
        }
    }, [baseUrl, uuid, password, addonPassword])

    useEffect(() => {
        if (shouldRedirect) navigate(accountId ? `/account/${accountId}` : '/', { replace: true })
    }, [accountId, navigate, shouldRedirect])

    if (shouldRedirect) return null

    const addonName = addon.manifest.name || 'AIOMetadata'
    const accountLabel = account.name || getAccountEmail(account) || accountId || 'Unknown account'
    const configureUrl = getAIOMetadataConfigureUrl(addon.transportUrl)
    const headerStats = sourceConfig ? getConfigStats(sourceConfig) : null
    const versionValue = status?.version || addon.manifest.version
    const version = versionValue ? `v${versionValue}` : null
    const maskedBase = maskUrlLevel(baseUrl, privacyOn ? urlLevel : 0)
    const maskedAccount = maskNameLevel(accountLabel, privacyOn ? nameLevel : 0)
    const pill = !reachable ? 'error' : refreshError ? 'degraded' : 'active'
    const pillText = !reachable ? 'Unreachable' : refreshError ? 'Refresh failed' : 'Reachable'

    return (
        <div className="w-full mx-auto py-6 px-4 md:px-8 lg:px-12 xl:px-16 space-y-4 max-w-[1800px]">
            <ToolbarShell className="w-fit max-w-full p-2" contentClassName="gap-2">
                <Button variant="ghost" size="sm" className="mt-0.5 h-8 shrink-0 gap-1.5 rounded-xl border border-border/40 bg-card px-2.5 text-xs font-medium text-muted-foreground shadow-sm hover:bg-muted/50 hover:text-foreground"
                    onClick={() => navigate(`/account/${accountId}`)}>
                    <ArrowLeft className="h-4 w-4" /> Back
                </Button>
            </ToolbarShell>

            {!connected ? (
                <>
                {vaultLocked && !password && (
                    <div className="mx-auto max-w-md"><VaultLockedNotice>Unlock your vault to use a saved config password.</VaultLockedNotice></div>
                )}
                <CredentialsGate
                    password={password} setPassword={setPassword}
                    addonPassword={addonPassword} setAddonPassword={setAddonPassword}
                    needsAddonPassword={needsAddonPassword}
                    showPassword={showPassword} setShowPassword={setShowPassword}
                    rememberPassword={rememberPassword} setRememberPassword={setRememberPassword}
                    loading={loading} error={error} passwordRef={passwordRef}
                    onConnect={handleConnect} configureUrl={configureUrl}
                />
                </>
            ) : (
                <WorkspaceTabs
                    label={`${addonName} workspace`}
                    tabs={SECTION_TABS}
                    value={activeSection}
                    onValueChange={value => setActiveSection(value as Section)}
                    header={
                        <WorkspaceHeader
                            logo={<AddonIcon name={addonName} logo={addon.metadata?.customLogo || addon.manifest.logo} alt={addonName} className="h-12 w-12" textClassName="text-sm" />}
                            title={addonName}
                            pill={
                                <WorkspaceStatusPill status={pill} label={pillText}>
                                    <div className="space-y-1">
                                        <p className="truncate text-sm font-semibold">{addonName}</p>
                                        <p className="text-xs text-muted-foreground">
                                            {!reachable ? 'The instance did not answer its status check.' : refreshError ? 'The last refresh failed. Showing the config from the previous read.' : 'The instance is reachable and this user is signed in.'}
                                        </p>
                                    </div>
                                    <PopoverFacts facts={[
                                        { label: 'Instance', value: maskedBase },
                                        ...(version ? [{ label: 'Version', value: version }] : []),
                                        { label: 'Trusted user', value: trusted === true ? 'Yes' : trusted === false ? 'No' : 'Unknown' },
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
                            ) : undefined}
                            stats={headerStats ? [
                                { label: 'Provider maps', value: String(headerStats.providers) },
                                { label: 'Catalogs', value: String(headerStats.catalogs) },
                                { label: 'API keys', value: String(headerStats.apiKeys) },
                                { label: 'Features on', value: String(headerStats.toggles) },
                            ] : undefined}
                        />
                    }
                >
                    <TabsContent value={activeSection}>
                        {sourceConfig ? (
                            <SectionContent
                                activeSection={activeSection}
                                sourceConfig={sourceConfig}
                                baseUrl={baseUrl}
                                uuid={uuid}
                                transportUrl={addon.transportUrl}
                                configureUrl={configureUrl}
                                accountName={accountLabel}
                                accountId={accountId!}
                                status={status}
                                version={version}
                                trusted={trusted}
                                targetOptions={targetOptions}
                                missingAccounts={missingAccounts}
                                sameUserAccounts={sameUserAccounts}
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

const SECTION_TABS: (WorkspaceTabItem & { id: Section })[] = [
    { id: 'overview', label: 'Overview', icon: <Eye className="h-3.5 w-3.5" /> },
    { id: 'config', label: 'Configuration', icon: <Database className="h-3.5 w-3.5" />, readOnly: true },
    { id: 'users', label: 'Users', icon: <Users className="h-3.5 w-3.5" /> },
    { id: 'sync', label: 'Sync', icon: <ArrowRightLeft className="h-3.5 w-3.5" /> },
]

function CredentialsGate({
    password, setPassword, addonPassword, setAddonPassword, needsAddonPassword,
    showPassword, setShowPassword, rememberPassword, setRememberPassword,
    loading, error, passwordRef, onConnect, configureUrl,
}: {
    password: string; setPassword: (v: string) => void
    addonPassword: string; setAddonPassword: (v: string) => void
    needsAddonPassword: boolean
    showPassword: boolean; setShowPassword: (v: boolean) => void
    rememberPassword: boolean; setRememberPassword: (v: boolean) => void
    loading: boolean; error: string
    passwordRef: React.RefObject<HTMLInputElement | null>
    onConnect: () => void; configureUrl: string | null
}) {
    return (
        <div className="max-w-md mx-auto my-12">
            <Card className="border border-border/40 shadow-sm bg-card relative overflow-hidden">
                <CardHeader className="text-center relative z-10">
                    <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-2xl bg-muted/35 text-muted-foreground ring-1 ring-border/40">
                        <Lock className="w-5 h-5" />
                    </div>
                    <CardTitle className="text-xl">Authentication Required</CardTitle>
                    <CardDescription>Enter the AIOMetadata config password to manage this user.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4 relative z-10">
                    <div className="space-y-2">
                        <Label htmlFor="password" className="text-xs font-medium text-muted-foreground uppercase">Config Password</Label>
                        <div className="relative">
                            <Shield className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                            <Input id="password" ref={passwordRef} type={showPassword ? 'text' : 'password'} placeholder="Config password"
                                value={password} onChange={e => setPassword(e.target.value)}
                                onKeyDown={e => e.key === 'Enter' && onConnect()} disabled={loading} className="pl-9 pr-10 h-11" />
                            <Button type="button" variant="ghost" size="sm" tabIndex={-1}
                                className="absolute right-0 top-0 h-full px-3 text-muted-foreground hover:text-foreground"
                                onClick={() => setShowPassword(!showPassword)} aria-label={showPassword ? 'Hide password' : 'Show password'}>
                                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                            </Button>
                        </div>
                    </div>
                    {needsAddonPassword && (
                        <div className="space-y-2">
                            <Label htmlFor="addon-password" className="text-xs font-medium text-muted-foreground uppercase">Addon Password</Label>
                            <Input id="addon-password" type="password" placeholder="Instance addon password"
                                value={addonPassword} onChange={e => setAddonPassword(e.target.value)}
                                onKeyDown={e => e.key === 'Enter' && onConnect()} disabled={loading} className="h-11" />
                            <p className="text-xs text-muted-foreground">This instance requires its addon password for new users. After the first connect this user becomes trusted.</p>
                        </div>
                    )}
                    <div className="flex items-center gap-2">
                        <Checkbox id="remember" checked={rememberPassword} onCheckedChange={c => setRememberPassword(!!c)} />
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
                                <ExternalLink className="w-4 h-4" /> Open in AIOMetadata
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
    activeSection, sourceConfig, baseUrl, uuid, transportUrl, configureUrl, accountName, accountId, status, version, trusted, targetOptions, missingAccounts, sameUserAccounts,
}: {
    activeSection: Section
    sourceConfig: Record<string, unknown>
    baseUrl: string
    uuid: string
    transportUrl: string
    configureUrl: string | null
    accountName: string
    accountId: string
    status: AIOMetadataAddonInfo | null
    version: string | null
    trusted: boolean | null
    targetOptions: TargetOption[]
    missingAccounts: MissingTargetAccount[]
    sameUserAccounts: { id: string; name?: string; email?: string; emoji?: string }[]
}) {
    const { toast } = useToast()
    const [tagSwapping, setTagSwapping] = useState(false)
    const [bulkTagExpanded, setBulkTagExpanded] = useState(false)
    const [bulkTagSelected, setBulkTagSelected] = useState<Set<string>>(new Set())
    const sections = useMemo(() => getConfigSections(sourceConfig), [sourceConfig])
    const objectSections = useMemo(() => sections.filter(s => s.category === 'section'), [sections])
    const toggleSections = useMemo(() => sections.filter(s => s.category === 'toggle'), [sections])
    const keySections = useMemo(() => sections.filter(s => s.category === 'key'), [sections])

    const availableTags = useMemo(() => {
        const raw = sourceConfig.tags
        if (!Array.isArray(raw)) return []
        return raw.map((t: unknown): string | null => {
            if (typeof t === 'string') return t.trim() || null
            if (t && typeof t === 'object') {
                const obj = t as Record<string, unknown>
                if (typeof obj.id === 'string') return obj.id
                if (typeof obj.name === 'string') return obj.name
            }
            return null
        }).filter((t): t is string => t !== null && t.length > 0)
    }, [sourceConfig])

    const currentTag = useMemo(() => extractAddonParams(transportUrl).params.tag || '', [transportUrl])

    const handleTagSwap = async (value: string) => {
        const tag = value === NO_SELECTION ? null : value
        const newUrl = buildTaggedUrl(transportUrl, tag)
        if (newUrl === transportUrl) return

        const otherTargets: { accountId: string; oldUrl: string; newUrl: string }[] = []
        for (const accId of bulkTagSelected) {
            const acc = useAccountStore.getState().accounts.find(a => a.id === accId)
            if (!acc) continue
            const matched = acc.addons.find(a => {
                if (!isAIOMetadataAddon(a)) return false
                const p = parseAIOMetadataUrl(a.transportUrl)
                return p?.baseUrl === baseUrl && p.uuid === uuid
            })
            if (!matched) continue
            const theirNewUrl = buildTaggedUrl(matched.transportUrl, tag)
            if (theirNewUrl === matched.transportUrl) continue
            otherTargets.push({ accountId: acc.id, oldUrl: matched.transportUrl, newUrl: theirNewUrl })
        }

        setTagSwapping(true)
        try {
            await useAccountStore.getState().replaceTransportUrl(transportUrl, newUrl, accountId)
            if (otherTargets.length === 0) {
                toast({ title: 'Tag updated', description: tag ? `Filtering by "${tag}"` : 'Showing all catalogs' })
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
                    toast({ title: 'Tag updated across accounts', description: `${tag ? `Filtering by "${tag}"` : 'Showing all catalogs'}. ${total} account${total !== 1 ? 's' : ''}` })
                } else {
                    toast({ title: 'Tag partially updated', description: `${total} succeeded, ${fail} failed`, variant: 'destructive' })
                }
                setBulkTagSelected(new Set())
            }

            // Sync the linked library entry so normalizeUrl(account URL) === normalizeUrl(library installUrl) and syncAccountState linkage survives.
            const linkedSavedAddonId = resolveLinkedSavedAddonId(accountId, transportUrl)
            if (linkedSavedAddonId) {
                try {
                    await useAddonStore.getState().updateSavedAddon(linkedSavedAddonId, { installUrl: newUrl })
                } catch (err) {
                    if (import.meta.env.DEV) console.warn('[AIOMetadataPage] Saved-addon library URL sync failed after tag swap:', err)
                }
            }
        } catch (err) {
            toast({ title: 'Failed to switch tag', description: err instanceof Error ? err.message : undefined, variant: 'destructive' })
        } finally {
            setTagSwapping(false)
        }
    }

    if (activeSection === 'overview') {
        return (
            <div className="space-y-6">
                <SectionHeader title="Overview" description="Metadata setup summary for this user" />
                <div data-theme-part="panel" className="p-5 rounded-2xl border border-border/40 bg-card/50 shadow-sm space-y-3">
                    <h3 className="text-sm font-semibold">Instance Details</h3>
                    <div className="grid gap-3 text-sm">
                        <Detail label="URL"><span className="font-mono text-xs truncate max-w-[60%]">{baseUrl}</span></Detail>
                        <Detail label="UUID">
                            <div className="flex items-center gap-1.5">
                                <code className="text-xs font-mono">{uuid}</code>
                                <CopyButton value={uuid} variant="ghost" className="h-6 w-6 flex items-center justify-center" iconSize={12} />
                            </div>
                        </Detail>
                        <Detail label="Account"><span className="font-medium">{accountName}</span></Detail>
                        {version ? <Detail label="Version"><span className="font-mono text-xs">{version}</span></Detail> : null}
                        <Detail label="Trusted user"><span className="text-xs">{trusted === true ? 'Yes' : trusted === false ? 'No' : 'Unknown'}</span></Detail>
                    </div>
                </div>

                <div data-theme-part="panel" className="p-4 rounded-2xl border border-border/40 bg-card/50 shadow-sm space-y-2">
                    <h3 className="text-sm font-semibold">Install URL</h3>
                    <div className="flex items-center gap-2">
                        <code data-theme-part="field" className="flex-1 text-xs font-mono bg-muted/30 px-3 py-2 rounded-lg truncate">{maskSecretUrl(transportUrl)}</code>
                        <CopyButton value={transportUrl} variant="outline" className="h-9 w-9 shrink-0" iconSize={14} />
                    </div>
                </div>

                {availableTags.length > 0 && (
                    <div data-theme-part="panel" className="p-4 rounded-2xl border border-border/40 bg-card/50 shadow-sm space-y-2">
                        <h3 className="text-sm font-semibold flex items-center gap-1.5">
                            <Tag className="w-3.5 h-3.5" /> Active Tag
                        </h3>
                        <p className="text-xs text-muted-foreground">
                            Filter which catalogs appear in the manifest. Updates the addon URL in place.
                        </p>
                        <Select value={currentTag || NO_SELECTION} onValueChange={handleTagSwap} disabled={tagSwapping}>
                            <SelectTrigger className="w-full">
                                <SelectValue placeholder="All catalogs (no tag)" />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value={NO_SELECTION}>All catalogs (no tag)</SelectItem>
                                {availableTags.map(t => (
                                    <SelectItem key={t} value={t}>{t}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        {sameUserAccounts.length > 0 && (
                            <BulkAccountPicker
                                label={`Also apply to ${sameUserAccounts.length} other account${sameUserAccounts.length !== 1 ? 's' : ''}`}
                                accounts={sameUserAccounts}
                                expanded={bulkTagExpanded}
                                onExpandedChange={setBulkTagExpanded}
                                selected={bulkTagSelected}
                                onSelectedChange={setBulkTagSelected}
                                disabled={tagSwapping}
                            />
                        )}
                    </div>
                )}

                {configureUrl && (
                    <div data-theme-part="panel" className="rounded-2xl border border-border/40 bg-muted/25 p-4 space-y-2">
                        <p className="text-sm text-muted-foreground">For full catalog and provider editing, use the AIOMetadata visual editor.</p>
                        <Button variant="outline" size="sm" className="gap-2" asChild>
                            <a href={configureUrl} target="_blank" rel="noopener noreferrer">
                                <ExternalLink className="w-3.5 h-3.5" /> Configure in AIOMetadata
                            </a>
                        </Button>
                    </div>
                )}
            </div>
        )
    }

    if (activeSection === 'config') {
        return (
            <div className="space-y-6">
                <SectionHeader title="Configuration" description="Read-only summary; edit details in AIOMetadata, then sync across accounts" />

                {objectSections.length > 0 && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {objectSections.map(section => (
                            <div key={section.key} data-theme-part="panel" className="p-4 rounded-2xl border border-border/40 bg-card shadow-sm flex items-center gap-3">
                                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-muted/30 text-muted-foreground">
                                    <SectionIcon icon={section.icon} />
                                </div>
                                <div className="min-w-0 flex-1">
                                    <p className="text-sm font-semibold truncate">{section.label}</p>
                                    <p className="text-xs text-muted-foreground truncate">{getSectionSummary(section.key, section.data)}</p>
                                </div>
                            </div>
                        ))}
                    </div>
                )}

                {toggleSections.length > 0 && (
                    <div className="space-y-2">
                        <h3 className="text-sm font-semibold">Features</h3>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            {toggleSections.map(section => (
                                <div key={section.key} data-theme-part="panel" className="flex items-center justify-between px-3 py-2 rounded-lg border border-border/30 bg-muted/10">
                                    <span className="text-xs font-medium">{section.label}</span>
                                    <span className={cn('text-xs font-semibold', section.data ? 'text-success' : 'text-muted-foreground')}>
                                        {section.data ? 'On' : 'Off'}
                                    </span>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {keySections.length > 0 && (
                    <div className="space-y-2">
                        <h3 className="text-sm font-semibold">Settings</h3>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            {keySections.map(section => (
                                <SettingRow key={section.key} sectionKey={section.key} label={section.label} data={section.data} />
                            ))}
                        </div>
                    </div>
                )}

                {sections.length === 0 && (
                    <EmptyState icon={<Database className="h-6 w-6" />} title="No configuration found" description="This user has no settings yet. Configure it in AIOMetadata first." />
                )}
            </div>
        )
    }

    if (activeSection === 'users') {
        return (
            <div className="space-y-4">
                <SectionHeader title="Users" description="Create new AIOMetadata users from this setup and install them on your accounts." />
                <AIOMetadataActionsTab
                    sourceConfig={sourceConfig}
                    baseUrl={baseUrl}
                    targetOptions={targetOptions}
                    requiresAddonPassword={status?.requiresAddonPassword === true}
                />
            </div>
        )
    }

    return (
        <div className="space-y-4">
            <SectionHeader title="Sync" description="Copy this metadata setup to other accounts, or deploy it to accounts without AIOMetadata." />
            <AIOMetadataSyncTab
                sourceConfig={sourceConfig}
                targetOptions={targetOptions}
                sourceName={typeof sourceConfig.addonName === 'string' && sourceConfig.addonName ? sourceConfig.addonName : 'AIOMetadata setup'}
                sourceAccountName={accountName}
                sourceBaseUrl={baseUrl}
                sourceUuid={uuid}
                requiresAddonPassword={status?.requiresAddonPassword === true}
                missingAccounts={missingAccounts}
            />
        </div>
    )
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">{label}</span>
            {children}
        </div>
    )
}

function SectionIcon({ icon }: { icon: string }) {
    switch (icon) {
        case 'Database': return <Database className="w-4 h-4" />
        case 'Image': return <Image className="w-4 h-4" />
        case 'KeyRound': return <KeyRound className="w-4 h-4" />
        case 'LayoutGrid': return <LayoutGrid className="w-4 h-4" />
        default: return <Database className="w-4 h-4" />
    }
}
