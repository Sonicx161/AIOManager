import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, Check, ChevronDown, Copy, History, Import, Info, Loader2, Minus, Power, RefreshCw, Trash2, Wrench, Zap } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { StatusChip } from '@/components/ui/status-chip'
import { Tooltip } from '@/components/ui/tooltip'
import { ToolbarShell } from '@/components/ui/toolbar-shell'
import { TabsContent } from '@/components/ui/tabs'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { useConnectionStore } from '@/store/connectionStore'
import { useAuthStore } from '@/store/authStore'
import { useUIStore } from '@/store/uiStore'
import { decrypt } from '@/lib/crypto'
import { JellyfinClient, jellyfinSignInErrorMessage, validateJellyfinReconnect } from '@/lib/jellyfin/session'
import { JellyfinError } from '@/lib/jellyfin/client'
import { openJellyfinSecret } from '@/lib/jellyfin/connection-data'
import { JELLYFIN_CAPABILITIES, JELLYFIN_CAPABILITY_NOTE_FOOTER, JELLYFIN_CAPABILITY_NOTE_SUBTITLE } from '@/lib/jellyfin/capabilities'
import { displayStatus, friendlyConnectionError, timeAgo, tokenExpiry } from '@/lib/connection-format'
import { cn, maskNameLevel, maskUrlLevel } from '@/lib/utils'
import { maskIds } from '@/lib/mask-ids'
import { toast } from '@/hooks/use-toast'
import type { Connection } from '@/types/connection'
import { PlatformLogo, connectionLogoProduct, ConnectionStatusPill, ConnectionTestButton, ConnectionTestResult, connectionLabel, type ConnectionTestOutcome } from './ConnectionPrimitives'
import { connectionPresentation } from './connection-state'
import {
    PopoverFacts, SectionCard, SectionRow, SectionRows, VaultLockedNotice, WorkspaceAction, WorkspaceHeader, WorkspaceMoreMenu,
    WorkspaceNotice, WorkspaceStatusPill, WorkspaceTabs,
} from './workspace'
import { statusSentence, workspaceTabsFor } from './workspace/workspace-model'

const WORKSPACE_TABS = workspaceTabsFor('jellyfin').map(tab => tab.id)
const TAB_ICONS: Record<string, ReactNode> = {
    overview: <Info className="h-3.5 w-3.5" />,
    history: <History className="h-3.5 w-3.5" />,
    connection: <Wrench className="h-3.5 w-3.5" />,
}

const WatchMigrationDialog = lazy(() => import('./WatchMigrationDialog').then(module => ({ default: module.WatchMigrationDialog })))

function CopyValue({ value, label }: { value: string; label: string }) {
    const copy = async () => { try { await navigator.clipboard.writeText(value); toast({ title: `${label} copied` }) } catch { toast({ title: `Could not copy ${label.toLowerCase()}`, variant: 'destructive' }) } }
    return <Button type="button" variant="ghost" size="sm" className="h-8 gap-1 px-2 text-xs" onClick={() => void copy()} aria-label={`Copy ${label.toLowerCase()}`}><Copy className="h-3.5 w-3.5" />Copy</Button>
}

export function JellyfinConnectionPanel({ accountId, connection, onBack, onReconnect }: {
    accountId: string; connection: Connection; onBack: () => void; onReconnect: () => void
}) {
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    const [testResult, setTestResult] = useState<ConnectionTestOutcome | null>(null)
    const [confirmRemove, setConfirmRemove] = useState(false)
    const [migrationOpen, setMigrationOpen] = useState(false)
    const [savedSecret, setSavedSecret] = useState<{ baseUrl: string; userId: string } | null>(null)
    const [workspaceTab, setWorkspaceTab] = useState('overview')
    const [noteOpen, setNoteOpen] = useState(false)
    const request = useRef<AbortController | null>(null)
    const encryptionKey = useAuthStore(state => state.encryptionKey)
    const privacyOn = useUIStore(s => s.isPrivacyModeEnabled)
    const nameLevel = useUIStore(s => s.privacyLevelNames)
    const urlLevel = useUIStore(s => s.privacyLevelUrls)

    useEffect(() => {
        return () => { request.current?.abort() }
    }, [connection.id, connection.credentials?.jellyfin, connection.enabled, encryptionKey])

    useEffect(() => {
        let cancelled = false
        if (!encryptionKey || !connection.credentials?.jellyfin) { setSavedSecret(null); return }
        void openJellyfinSecret(connection, value => decrypt(value, encryptionKey)).then(secret => {
            if (!cancelled) setSavedSecret({ baseUrl: secret.baseUrl, userId: secret.userId })
        }).catch(() => { if (!cancelled) setSavedSecret(null) })
        return () => { cancelled = true }
    }, [connection, encryptionKey])

    const check = async () => {
        if (request.current) return
        const controller = new AbortController()
        request.current = controller
        setBusy(true)
        setError('')
        setTestResult(null)
        try {
            if (!encryptionKey) throw new Error('Unlock your vault first')
            const secret = await openJellyfinSecret(connection, value => decrypt(value, encryptionKey))
            const result = await new JellyfinClient(secret.baseUrl, secret.deviceId).signIn({ ...secret, method: 'token' }, controller.signal)
            controller.signal.throwIfAborted()
            validateJellyfinReconnect(connection, result, secret)
            await useConnectionStore.getState().updateConnection(accountId, connection.id, {
                mediaServer: { ...result.identity, serverId: result.identity.serverId || connection.mediaServer?.serverId, authMethod: connection.mediaServer?.authMethod || 'token' },
                status: 'active', lastError: undefined, lastErrorAt: undefined, consecutiveFailures: 0,
            })
            setTestResult({ ok: true, message: 'Connection healthy' })
            toast({ title: 'Connection healthy' })
        } catch (err) {
            if (!controller.signal.aborted) {
                const message = jellyfinSignInErrorMessage(err, { method: 'token', userId: connection.mediaServer?.userId })
                setError(message)
                setTestResult({ ok: false, message })
                toast({ title: 'Connection test failed', description: message, variant: 'destructive' })
                await useConnectionStore.getState().updateConnection(accountId, connection.id, {
                    status: err instanceof JellyfinError && err.kind === 'auth' ? 'expired' : 'error',
                    lastError: message, lastErrorAt: Date.now(),
                }).catch(() => {})
            }
        } finally {
            if (request.current === controller) request.current = null
            setBusy(false)
        }
    }

    const mutate = async (action: () => Promise<void>) => {
        setBusy(true)
        setError('')
        setTestResult(null)
        try { await action() }
        catch { setError('Could not save this change. Try again.') }
        finally { setBusy(false) }
    }

    const toggleEnabled = () => void mutate(() => useConnectionStore.getState().toggleConnection(accountId, connection.id))

    const identity = connection.mediaServer
    // Capability rows follow the product recorded at verify time; without a
    // detected product there is nothing honest to show, so no card at all.
    const capabilityTable = identity && connection.platform === 'jellyfin' ? JELLYFIN_CAPABILITIES[identity.product] : undefined
    const name = connectionLabel(connection)
    const display = displayStatus(connection.status, tokenExpiry(connection))
    const { pill, showLive } = connectionPresentation(connection.enabled !== false, display)
    const connectionError = error || connection.lastError
    // The product name already leads the header; only surface the server's own name when it says something new.
    const serverName = identity?.serverName?.trim()
    const distinctServerName = serverName && serverName !== name && serverName !== identity?.productName ? serverName : ''
    const configContext = identity?.product === 'aiostreams' ? 'AIOStreams playback configuration' : identity?.product === 'aiometadata' ? 'AIOMetadata library configuration' : identity?.product === 'jellyfin' ? 'Jellyfin server' : 'Jellyfin-compatible endpoint'
    const configPath = savedSecret?.baseUrl || ''
    const configRoute = (() => { try { return configPath ? maskIds(new URL(configPath).pathname) : '' } catch { return '' } })()
    const maskedUser = identity?.userName ? maskNameLevel(identity.userName, privacyOn ? nameLevel : 0) : ''
    const maskedAddress = configPath ? maskIds(maskUrlLevel(configPath, privacyOn ? urlLevel : 0)) : ''
    // Slicing the authority off the masked string keeps the asterisk fillers literal; a new URL
    // round-trip percent-encodes them into %2A.
    const maskedHost = maskedAddress ? maskedAddress.replace(/^https?:\/\//, '').split('/')[0] : ''
    const testDisabledReason = !connection.enabled ? 'Enable this connection to test it.'
        : !encryptionKey ? 'Unlock your vault to test this connection.'
            : !connection.credentials?.jellyfin ? 'Reconnect to sign in first.' : undefined
    const testing = busy && !!request.current
    const needsSignIn = showLive && (display === 'expired' || !connection.credentials?.jellyfin)
    const verified = identity?.lastCheckedAt ? timeAgo(identity.lastCheckedAt) : 'Never'

    const testButton = (
        <Tooltip content={testDisabledReason} disabled={!testDisabledReason}>
            <WorkspaceAction onClick={() => void check()} disabled={busy || !!testDisabledReason} aria-busy={testing}>
                {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
                {testing ? 'Testing...' : 'Test'}
            </WorkspaceAction>
        </Tooltip>
    )

    const header = (
        <WorkspaceHeader
            logo={<PlatformLogo platform={connection.platform} product={connectionLogoProduct(connection)} className="h-12 w-12" />}
            title={name}
            pill={
                <WorkspaceStatusPill status={pill}>
                    <div className="space-y-1">
                        <p className="truncate text-sm font-semibold">{name}</p>
                        <p className="text-xs text-muted-foreground">{statusSentence(pill, 'jellyfin')}</p>
                    </div>
                    <PopoverFacts facts={[
                        { label: 'Last verified', value: verified },
                        { label: 'Remote user', value: maskedUser || 'Sign-in required' },
                        ...(showLive && connectionError ? [{ label: 'Last error', value: friendlyConnectionError(connectionError), tone: 'destructive' as const }] : []),
                    ]} />
                    <div className="flex flex-wrap gap-2">
                        {!connection.enabled ? (
                            <Button size="sm" className="h-9 flex-1 text-xs" data-close-popover disabled={busy} onClick={toggleEnabled}><Power className="h-3.5 w-3.5" />Enable</Button>
                        ) : needsSignIn ? (
                            <Button size="sm" className="h-9 flex-1 text-xs" data-close-popover disabled={busy} onClick={onReconnect}><RefreshCw className="h-3.5 w-3.5" />Reconnect</Button>
                        ) : (
                            <Button size="sm" variant="outline" className="h-9 flex-1 text-xs" disabled={busy || !!testDisabledReason} onClick={() => void check()}><Zap className="h-3.5 w-3.5" />Test</Button>
                        )}
                        <Button size="sm" variant="ghost" className="h-9 text-xs" data-close-popover onClick={() => setWorkspaceTab('connection')}>Connection settings</Button>
                    </div>
                </WorkspaceStatusPill>
            }
            family={identity?.product !== 'jellyfin' ? <StatusChip size="sm" className="h-6 text-xs">Jellyfin API</StatusChip> : undefined}
            identity={[maskedHost, maskedUser && `User ${maskedUser}`, distinctServerName].filter(Boolean).join(' · ') || 'Media server · Jellyfin API'}
            actions={<>
                {testButton}
                <WorkspaceAction onClick={onReconnect} disabled={busy}><RefreshCw className="h-3.5 w-3.5" />Reconnect</WorkspaceAction>
                <WorkspaceMoreMenu label={`More actions for ${name}`}>
                    <DropdownMenuItem className="gap-2 text-xs" disabled={busy} onClick={toggleEnabled}><Power className="h-3.5 w-3.5" />{connection.enabled ? 'Disable connection' : 'Enable connection'}</DropdownMenuItem>
                    <DropdownMenuItem destructive className="gap-2 text-xs" onClick={() => setWorkspaceTab('connection')}><Trash2 className="h-3.5 w-3.5" />Remove connection…</DropdownMenuItem>
                </WorkspaceMoreMenu>
            </>}
            notice={!connection.enabled ? (
                <WorkspaceNotice icon={<Power className="h-4 w-4" />} title="Connection paused" tone="muted" action={<WorkspaceAction disabled={busy} onClick={toggleEnabled}>Enable</WorkspaceAction>}>
                    AIOManager stops reading media from this server until you enable it.
                </WorkspaceNotice>
            ) : needsSignIn ? (
                <WorkspaceNotice icon={<RefreshCw className="h-4 w-4" />} title="Sign-in needed" tone="destructive" action={<WorkspaceAction variant="default" disabled={busy} onClick={onReconnect}>Reconnect</WorkspaceAction>}>
                    The saved sign-in no longer works. Reconnect with the same server and user.
                </WorkspaceNotice>
            ) : !encryptionKey ? <VaultLockedNotice>Unlock your vault to test this server or view its address.</VaultLockedNotice> : undefined}
            stats={[
                { label: 'Remote user', value: maskedUser || 'Sign-in required', tone: maskedUser ? undefined : 'muted', sub: identity?.authMethod === 'password' ? 'Password sign-in' : identity?.authMethod === 'token' ? 'Token sign-in' : identity?.authMethod === 'quickconnect' ? 'Quick Connect sign-in' : undefined },
                { label: 'Version', value: identity?.version || 'Not reported', tone: identity?.version ? undefined : 'muted', sub: identity?.productName },
                { label: 'Last verified', value: verified, title: identity?.lastCheckedAt ? new Date(identity.lastCheckedAt).toLocaleString() : undefined, sub: identity?.lastCheckedAt ? new Date(identity.lastCheckedAt).toLocaleDateString() : undefined },
                { label: 'Last error', value: !showLive ? 'Not checked' : friendlyConnectionError(connection.lastError) || 'None', tone: showLive && connection.lastError ? 'destructive' : 'muted', title: connection.lastError },
            ]}
        />
    )

    return <div className="space-y-4">
        <ToolbarShell className="w-fit max-w-full p-2" contentClassName="gap-2">
            <Button variant="ghost" size="sm" className="h-11 shrink-0 gap-1.5 rounded-xl border border-border/40 bg-card px-2.5 text-xs font-medium text-muted-foreground shadow-sm hover:bg-muted/50 hover:text-foreground sm:h-8" onClick={onBack}>
                <ArrowLeft className="h-4 w-4" />
                Connections
            </Button>
        </ToolbarShell>

        <WorkspaceTabs
            label={`${name} workspace`}
            header={header}
            tabs={workspaceTabsFor('jellyfin').map(tab => ({ ...tab, icon: TAB_ICONS[tab.id] }))}
            value={WORKSPACE_TABS.includes(workspaceTab) ? workspaceTab : 'overview'}
            onValueChange={setWorkspaceTab}
        >
            <TabsContent value="overview">
                <div className="grid gap-4 lg:grid-cols-2">
                    {capabilityTable && <SectionCard
                        className="lg:col-span-2"
                        title="What this server supports"
                        description={JELLYFIN_CAPABILITY_NOTE_SUBTITLE}
                        action={capabilityTable.rows.length > 0 ? <button type="button" data-theme-part="button" aria-expanded={noteOpen} aria-label="What this server supports" onClick={() => setNoteOpen(value => !value)} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
                            {!noteOpen && <span className="max-w-[220px] truncate">{capabilityTable.summary}</span>}
                            <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', noteOpen && 'rotate-180')} />
                        </button> : undefined}
                    >
                        {capabilityTable.rows.length === 0 ? <p className="text-xs leading-relaxed text-muted-foreground">{capabilityTable.summary}</p>
                        : noteOpen && <>
                            <ul className="divide-y divide-border/30">
                                {capabilityTable.rows.map(row => <li key={row.feature} className="flex items-start justify-between gap-3 py-2 first:pt-0 last:pb-0">
                                    <span className="min-w-0 flex-1 text-xs leading-relaxed"><span className="font-medium">{row.feature}</span>{row.note && <span className="mt-0.5 block text-muted-foreground">{row.note}</span>}</span>
                                    {row.status === 'works'
                                        ? <span className="inline-flex shrink-0 items-center gap-1.5 text-xs font-medium text-success"><Check className="h-3.5 w-3.5" />Works</span>
                                        : <span className="inline-flex min-w-0 max-w-[55%] items-start justify-end gap-1.5 text-right text-xs leading-relaxed text-muted-foreground"><Minus className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span className="min-w-0 break-words">{row.reason}</span></span>}
                                </li>)}
                            </ul>
                            <p className="border-t border-border/30 pt-2.5 text-xs leading-relaxed text-muted-foreground">{JELLYFIN_CAPABILITY_NOTE_FOOTER}</p>
                        </>}
                    </SectionCard>}
                    <SectionCard
                        title="Connection health"
                        description="Verify this server is reachable and your saved sign-in still works."
                        action={<Tooltip content={testDisabledReason} disabled={!testDisabledReason}><span><ConnectionTestButton testing={testing} disabled={busy || !!testDisabledReason} onClick={() => void check()} /></span></Tooltip>}
                    >
                        <SectionRows>
                            <SectionRow label="Status" value={<span className="inline-flex flex-wrap items-center gap-2"><ConnectionStatusPill status={pill} /><span className="font-normal text-muted-foreground">{statusSentence(pill, 'jellyfin')}</span></span>} />
                            <SectionRow label="Last verified" value={identity?.lastCheckedAt ? `${verified} (${new Date(identity.lastCheckedAt).toLocaleString()})` : 'Never'} tone={identity?.lastCheckedAt ? undefined : 'muted'} />
                        </SectionRows>
                        <ConnectionTestResult result={testResult ?? (!busy && showLive && connectionError ? { ok: false, message: connectionError } : null)} />
                    </SectionCard>

                    <SectionCard title="Server details" description="The identity recorded when this connection was last verified.">
                        <SectionRows>
                            <SectionRow label="Product" value={identity?.productName || 'Not recorded yet'} aside={identity?.product !== 'jellyfin' ? <StatusChip size="sm" className="h-6 text-xs">Jellyfin API</StatusChip> : undefined} />
                            {distinctServerName && <SectionRow label="Server name" value={distinctServerName} />}
                            {identity?.packageName && <SectionRow label="Package" value={identity.packageName} mono />}
                            <SectionRow label="Sign-in" value={identity?.authMethod === 'password' ? 'Username & password (token saved)' : identity?.authMethod === 'token' ? 'Saved token or API key' : identity?.authMethod === 'quickconnect' ? 'Quick Connect (token saved)' : 'Not recorded'} />
                            {identity?.version && <SectionRow label="API version" value={identity.version} />}
                            <SectionRow label="Server ID" value={identity?.serverId ? maskIds(identity.serverId) : 'Unavailable'} mono />
                        </SectionRows>
                    </SectionCard>

                    <SectionCard
                        className="lg:col-span-2"
                        title="Jellyfin workspace details"
                        description="Safe setup information for using this connection in external apps. Secrets and passwords stay encrypted in your vault."
                        action={configPath ? <CopyValue value={configPath} label="Server address" /> : undefined}
                    >
                        <SectionRows>
                            <SectionRow label="Connection type" value={configContext} />
                            <SectionRow label="Remote user" value={maskedUser || 'Unavailable'} aside={identity?.userName ? <CopyValue value={identity.userName} label="Remote user" /> : undefined} />
                            <SectionRow label="Server address" value={maskedAddress || 'Unlock the vault to view'} mono tone={maskedAddress ? undefined : 'muted'} />
                            <SectionRow label="Config path" value={configRoute || 'Unavailable'} mono tone={configRoute ? undefined : 'muted'} />
                            <SectionRow label="Remote user ID" value={(savedSecret?.userId || identity?.userId) ? maskIds(savedSecret?.userId || identity?.userId || '') : 'Unavailable'} mono />
                        </SectionRows>
                        {identity?.product === 'aiostreams' && <p className="rounded-lg border border-info/30 bg-info/5 px-3 py-2 text-xs leading-relaxed text-muted-foreground">This endpoint is an AIOStreams playback facade. Use the same configuration UUID/alias and selected user shown in AIOStreams when another app asks for Jellyfin details.</p>}
                        {identity?.product === 'aiometadata' && <p className="rounded-lg border border-info/30 bg-info/5 px-3 py-2 text-xs leading-relaxed text-muted-foreground">This endpoint is an AIOMetadata library facade. Its configuration and user handoff settings remain owned by AIOMetadata; this panel only exposes the verified connection context.</p>}
                    </SectionCard>
                </div>
            </TabsContent>
            <TabsContent value="history">
                <SectionCard
                    title="Import watch state"
                    description="Import watched titles and continue-watching progress from another connection. You’ll always preview the changes and choose what to copy before anything is saved."
                    footer={<Button variant="outline" className="h-11 sm:h-9" disabled={busy || !connection.enabled || !encryptionKey || !connection.credentials?.jellyfin} onClick={() => setMigrationOpen(true)}><Import className="h-4 w-4" />Start import…</Button>}
                />
            </TabsContent>
            <TabsContent value="connection">
                <div className="space-y-4">
                    <SectionCard
                        title="Maintenance"
                        description="Reconnect signs in again from scratch; pausing keeps the connection but stops media reads."
                        footer={<div className="ml-auto flex flex-wrap gap-2">
                            <Button variant="outline" className="h-11 sm:h-9" disabled={busy} onClick={onReconnect}><RefreshCw className="h-4 w-4" />Reconnect</Button>
                            <Button variant="outline" className="h-11 sm:h-9" disabled={busy} onClick={toggleEnabled}><Power className="h-4 w-4" />{connection.enabled ? 'Disable' : 'Enable'}</Button>
                        </div>}
                    >
                        {error && <ConnectionTestResult result={{ ok: false, message: error }} />}
                    </SectionCard>
                    <SectionCard
                        title="Remove connection"
                        description="Removes this saved connection from AIOManager. This does not revoke the token on your media server."
                        footer={
                            <div className="ml-auto flex items-center gap-1.5">
                                {confirmRemove ? (
                                    <div role="group" aria-label="Confirm media connection removal" className="flex items-center gap-1.5">
                                        <Button size="sm" variant="subtle" className="h-11 text-xs sm:h-8" disabled={busy} onClick={() => setConfirmRemove(false)}>Cancel</Button>
                                        <Button size="sm" variant="destructive" className="h-11 gap-1.5 text-xs sm:h-8" disabled={busy} onClick={() => void mutate(async () => { await useConnectionStore.getState().removeConnection(accountId, connection.id); onBack() })}>
                                            <Trash2 className="h-3.5 w-3.5" />
                                            Remove connection
                                        </Button>
                                    </div>
                                ) : (
                                    <Button size="sm" variant="outline" className="h-11 gap-1.5 text-xs text-destructive hover:text-destructive sm:h-8" disabled={busy} onClick={() => setConfirmRemove(true)}>
                                        <Trash2 className="h-3.5 w-3.5" />
                                        Remove connection…
                                    </Button>
                                )}
                            </div>
                        }
                    />
                </div>
            </TabsContent>
        </WorkspaceTabs>
        {migrationOpen && <Suspense fallback={null}><WatchMigrationDialog open={migrationOpen} onOpenChange={setMigrationOpen} accountId={accountId} connection={connection} /></Suspense>}
    </div>
}
