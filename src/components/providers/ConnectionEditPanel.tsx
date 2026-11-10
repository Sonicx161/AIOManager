import { Button } from '@/components/ui/button'
import { motion } from 'framer-motion'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tooltip } from '@/components/ui/tooltip'
import { ToolbarShell } from '@/components/ui/toolbar-shell'
import { TabsContent } from '@/components/ui/tabs'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { EmptyState } from '@/components/common/EmptyState'
import { Trash2, ArrowLeft, Loader2, Mail, Lock, Key, RefreshCw, Eye, EyeOff, QrCode, BookOpen, ChevronDown, Users, Power, Zap, TriangleAlert, KeyRound } from 'lucide-react'
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useConnectionStore } from '@/store/connectionStore'
import { useAccountStore, getCachedAuthKey, getEncryptionKey, getAccountEmail, getStremioConnection } from '@/store/accountStore'
import { useAuthStore } from '@/store/authStore'
import { useLibraryCache } from '@/store/libraryCache'
import { useAddons } from '@/hooks/useAddons'
import { useWatchHistory } from '@/hooks/useWatchHistory'
import { stremioClient } from '@/api/stremio-client'
import { getUserCached } from '@/lib/stremio-user-cache'
import { loginWithCredentials } from '@/api/auth'
import { buildResetPasswordUrl } from '@/api/stremio-relay'
import { isStremioPasswordResetError, STREMIO_PASSWORD_RESET_COPY } from '@/lib/stremio-password-reset'
import { nuvioAuth, realstreamAuth } from '@/api/hydra-providers'
import { exchangeNuvioQr, pollNuvioQr, startNuvioQr } from '@/api/nuvio-qr'
import { QRLinkDialog } from '@/components/qr/QRLinkDialog'
import type { QRSession } from '@/lib/qr-device-link'
import { createStremioLink, pollStremioLink } from '@/api/stremio-link'
import { fetchConnectionToken } from '@/api/connection'
import { encrypt } from '@/lib/crypto'
import type { PremiumStatus } from '@/lib/stremio-premium'
import type { NuvioMemberStatus } from '@/lib/nuvio-tier'
import { DEFAULT_BASE_URL as NUVIO_DEFAULT_BASE_URL } from '@/lib/drivers/nuvio'
import { DEFAULT_BASE_URL as REALSTREAM_DEFAULT_BASE_URL } from '@/lib/drivers/realstream'
import { toast } from '@/hooks/use-toast'
import { cn, maskEmailLevel, maskNameLevel, maskProfileLevel, maskUrlLevel } from '@/lib/utils'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useFailoverStore } from '@/store/failoverStore'
import { boundRulesRemovalNotice, findDependentRules, isLastStremioLoginRemoval } from '@/lib/rule-removal'
import { ruleDisplayName } from '@/lib/autopilot-conflicts'
import type { Connection, ConnectionStatus } from '@/types/connection'
import type { HydraStatus } from '@/types/provider'
import { PlatformLogo, connectionLogoProduct, ConnectionStatusPill, ConnectionTestButton, ConnectionTestResult, connectionLabel, type ConnectionTestOutcome, type PillStatus } from './ConnectionPrimitives'
import { StremioSocialAuth } from '@/components/accounts/StremioSocialAuth'
import { displayStatus, friendlyConnectionError, tokenExpiry, timeAgo } from '@/lib/connection-format'
import { cumulativeWatchKey, canonicalStremioConnections } from '@/lib/activity-utils'
import { computeLibraryStats } from '@/lib/connection-library-stats'
import { NuvioBackupTab, NuvioPluginsTab, NuvioProfilesTab, NuvioLibraryTab, NuvioCollectionsTab, TabToolbar } from './NuvioWorkspace'
import { NuvioOverview, useNuvioMembership } from './NuvioOverview'
import { StremioMembershipCard, StremioSupportersBadge, type StremioMembershipState } from './ConnectionMembershipTab'
import { ProfileRosterRow } from './ProfileRosterRow'
import { connectionPresentation } from './connection-state'
import { useUIStore } from '@/store/uiStore'
import { addStremioProfileAccount, findAccountByAuthKey } from '@/store/account/profileQuickAdd'
import { getProfileClaims, resolveProfileState, profileClaimKey } from '@/lib/profile-claims'
import type { ProfileRosterState } from '@/lib/profile-claims'
import {
    PopoverFacts, SectionCard, SectionRow, SectionRows, VaultLockedNotice, WorkspaceAction, WorkspaceError, WorkspaceHeader,
    WorkspaceLoading, WorkspaceMoreMenu, WorkspaceNotice, WorkspaceStatStrip, WorkspaceStatusPill, WorkspaceTabs,
    type WorkspaceStat, type WorkspaceTabItem,
} from './workspace'
import {
    DEFAULT_WORKSPACE_TAB, backendLabel, needsReauth, resolveWorkspaceTab, sessionState, statusSentence, syncSummary,
    tokenExpiresIn, workspaceKind, workspaceTabsFor, type SessionState, type WorkspaceKind,
} from './workspace/workspace-model'

const errMsg = (e: unknown, fallback = 'Try again.') => (e instanceof Error ? e.message : fallback)

function withTimeout<T>(promise: Promise<T>, ms = 10000): Promise<T> {
    return Promise.race([
        promise,
        new Promise<T>((_, reject) =>
            setTimeout(() => reject(new Error('Connection test timed out')), ms)
        )
    ])
}

// One test path per platform, shared by the header, Overview and the Connection tab.
export async function runConnectionTest(accountId: string, connection: Connection, override?: { apiKey?: string }): Promise<{ message: string; hydra?: HydraStatus; token?: { accessToken: string; expiresAt: number } }> {
    const kind = workspaceKind(connection)
    if (kind === 'hydra-outbound') {
        const { testHydraEndpoint } = await import('@/api/hydra-providers')
        const baseUrl = connection.driverConfig?.baseUrl
        const authType = connection.driverConfig?.authType || 'header'
        const authHeader = connection.driverConfig?.authHeader || 'x-api-key'
        const authValue = override?.apiKey?.trim() || connection.credentials?.apiKey || ''
        if (!authValue) throw new Error('No API key set. Enter one to test.')
        if (!baseUrl) throw new Error('No endpoint URL configured.')
        const hydra = await withTimeout(testHydraEndpoint(baseUrl, authType, authHeader, authValue), 15000)
        return { message: 'Outbound endpoint reachable.', hydra }
    }
    if (kind === 'stremio') {
        // Verify THIS connection's session. The account-level key would test the
        // canonical login and report a secondary's broken session as healthy.
        const encryptedKey = stremioConnectionAuthKey(connection)
        if (!encryptedKey) throw new Error('No auth key stored for this connection')
        const authKey = await getCachedAuthKey(encryptedKey, getEncryptionKey())
        const user = await withTimeout(stremioClient.getUser(authKey))
        return { message: user.email ? 'Connection healthy and signed in.' : 'Connection healthy.' }
    }
    if (kind === 'nuvio') {
        const token = await withTimeout(fetchConnectionToken(accountId, connection.id, 'nuvio', connection.credentials?.baseUrl))
        return { message: `Session healthy (token expires ${new Date(token.expiresAt).toLocaleString()})`, token }
    }
    if (kind === 'realstream') {
        // Beta's RealStream token path never passes a baseUrl (self-hosted
        // RealStream is gone), so the test must match it exactly.
        const token = await withTimeout(fetchConnectionToken(accountId, connection.id, 'realstream'))
        return { message: `Session healthy (token expires ${new Date(token.expiresAt).toLocaleString()})`, token }
    }
    throw new Error('This connection has no test.')
}

interface ReauthMethod {
    id: string
    label: string
    content: React.ReactNode
}

function ReauthCard({ title, description, methods, layoutId, headerAction, footer }: {
    title: string
    description: string
    methods: ReauthMethod[]
    layoutId?: string
    headerAction?: React.ReactNode
    footer?: React.ReactNode
}) {
    const [activeId, setActiveId] = useState(methods[0].id)
    const active = methods.find(m => m.id === activeId) ?? methods[0]
    return (
        <div data-theme-part="panel" className="rounded-2xl border border-border/40 bg-card/50 p-4 shadow-sm space-y-3">
            <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                    <p className="text-sm font-semibold">{title}</p>
                    <p className="text-xs text-muted-foreground">{description}</p>
                </div>
                {headerAction}
            </div>
            {methods.length > 1 && (
                <div data-theme-part="tabs-list" className={cn(
                    'grid gap-0.5 rounded-xl bg-muted/30 p-0.5 border border-border/40',
                    methods.length === 2 ? 'grid-cols-2' : 'grid-cols-3'
                )}>
                    {methods.map(method => (
                        <button
                            key={method.id}
                            type="button"
                            data-theme-part="tab"
                            data-state={activeId === method.id ? 'active' : 'inactive'}
                            onClick={() => setActiveId(method.id)}
                            className={cn(
                                'relative h-8 rounded-lg text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring z-10',
                                activeId === method.id ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
                            )}
                        >
                            {activeId === method.id && (
                                <motion.div
                                    layoutId={layoutId}
                                    data-theme-part="tab-indicator"
                                    className="absolute inset-0 bg-background rounded-lg shadow-sm -z-10 border border-border/10"
                                    transition={{ type: 'spring', stiffness: 380, damping: 30 }}
                                />
                            )}
                            {method.label}
                        </button>
                    ))}
                </div>
            )}
            {active.content}
            {footer}
        </div>
    )
}

// Resolves the login THIS panel edits — never the account-level canonical key: a
// secondary card's verify/delete/re-auth must act on its own sealed session, or the
// action would land on (or destroy) the canonical login's remote account.
function stremioConnectionAuthKey(connection: Connection): string | undefined {
    return connection.credentials?.authKey || undefined
}

// Verified re-auth capture: a fresh session must resolve to the SAME remote user this
// connection is bound to. With a stored verified userId that is the authority; without
// one (legacy rows) the verified email must corroborate the stored email — and with
// neither, the update is refused rather than silently rebinding the connection. A
// sibling connection already binding the verified user (double-bind) is rejected too.
async function verifyStremioReconnect(authKey: string, connection: Connection, account?: { connections?: Connection[] }): Promise<{ email?: string; userId?: string }> {
    const user = await stremioClient.getUser(authKey)
    const boundId = connection.credentials?.userId
    if (!boundId) {
        const verifiedEmail = typeof user.email === 'string' ? user.email.trim().toLowerCase() : ''
        const boundEmail = (connection.credentials?.email || '').trim().toLowerCase()
        if (!verifiedEmail || !boundEmail || verifiedEmail !== boundEmail) {
            throw new Error('That session belongs to a different Stremio account than this connection. Re-authenticate this connection with its own account (password tab uses the account\'s own email).')
        }
    } else if (user._id && user._id !== boundId) {
        throw new Error(`That session belongs to a different Stremio account${typeof user.email === 'string' && user.email ? ` (${user.email})` : ''} than the one this connection uses. Sign in with this connection's own account.`)
    }
    if (user._id) {
        const doubleBound = (account?.connections || []).some(c =>
            c.platform === 'stremio' && (c.connectionType == null || c.connectionType === 'native')
            && c.id !== connection.id && c.credentials?.userId === user._id)
        if (doubleBound) {
            throw new Error('That Stremio account is already connected to this AIOManager account through another login.')
        }
    }
    return {
        email: typeof user.email === 'string' && user.email.trim() ? user.email : undefined,
        userId: user._id || undefined,
    }
}

function StremioCredentialsSection({ accountId, connection }: { accountId: string; connection: Connection }) {
    const updateConnection = useConnectionStore(s => s.updateConnection)
    const account = useAccountStore(s => s.accounts.find(a => a.id === accountId))
    const [email, setEmail] = useState(connection.credentials?.email || (account ? getAccountEmail(account) || '' : ''))
    const [password, setPassword] = useState('')
    const [showPassword, setShowPassword] = useState(false)
    const [newAuthKey, setNewAuthKey] = useState('')
    const [saving, setSaving] = useState(false)
    const [savingKey, setSavingKey] = useState(false)
    const [qrOpen, setQrOpen] = useState(false)

    const emailValid = email.includes('@')
    const passwordValid = password.length > 0

    const handleReauth = async () => {
        if (!emailValid || !passwordValid) return
        setSaving(true)
        try {
            const response = await loginWithCredentials(email, password)
            // Identity guard: the fresh session must still be THIS connection's remote user.
            const verified = await verifyStremioReconnect(response.authKey, connection, account)
            const encryptionKey = getEncryptionKey()
            const encrypted = await encrypt(response.authKey, encryptionKey)
            if (getEncryptionKey() !== encryptionKey) throw new Error('Your vault changed while saving. Unlock it and try again.')
            await updateConnection(accountId, connection.id, {
                credentials: {
                    ...connection.credentials,
                    authKey: encrypted,
                    email: verified.email || response.user?.email || email,
                    ...(verified.userId ? { userId: verified.userId } : {}),
                },
                status: 'active',
            })
            toast({ title: 'Stremio session refreshed' })
            setPassword('')
            await useConnectionStore.getState().syncConnections(accountId)
        } catch (err) {
            if (isStremioPasswordResetError(err)) {
                toast({
                    title: STREMIO_PASSWORD_RESET_COPY.title,
                    description: STREMIO_PASSWORD_RESET_COPY.body,
                    action: {
                        label: STREMIO_PASSWORD_RESET_COPY.actionLabel,
                        onClick: () => window.open(buildResetPasswordUrl(email), '_blank', 'noopener,noreferrer'),
                    },
                    actionBelow: true,
                    variant: 'attention',
                    icon: KeyRound,
                    duration: Infinity,
                })
            } else {
                toast({ title: 'Re-authentication failed', description: errMsg(err), variant: 'destructive' })
            }
        } finally {
            setSaving(false)
        }
    }

    const handleUpdate = async () => {
        const trimmed = newAuthKey.trim()
        if (!trimmed) return
        setSavingKey(true)
        try {
            // Verified before save: an invalid key must fail here, and a key belonging to
            // a different remote user than this connection's login is rejected outright.
            const verified = await verifyStremioReconnect(trimmed, connection, account)
            const encryptionKey = getEncryptionKey()
            const encrypted = await encrypt(trimmed, encryptionKey)
            if (getEncryptionKey() !== encryptionKey) throw new Error('Your vault changed while saving. Unlock it and try again.')
            await updateConnection(accountId, connection.id, {
                credentials: {
                    ...connection.credentials,
                    authKey: encrypted,
                    ...(verified.email ? { email: verified.email } : {}),
                    ...(verified.userId ? { userId: verified.userId } : {}),
                },
                status: 'active',
            })
            toast({ title: 'Auth key updated' })
            setNewAuthKey('')
            await useConnectionStore.getState().syncConnections(accountId)
        } catch (err) {
            toast({ title: 'Update failed', description: errMsg(err), variant: 'destructive' })
        } finally {
            setSavingKey(false)
        }
    }

    const handleSocialAuthKey = async (authKey: string, user?: { email?: string; name?: string }) => {
        try {
            const verified = await verifyStremioReconnect(authKey, connection, account)
            const encryptionKey = getEncryptionKey()
            const encrypted = await encrypt(authKey, encryptionKey)
            if (getEncryptionKey() !== encryptionKey) throw new Error('Your vault changed while saving. Unlock it and try again.')
            await updateConnection(accountId, connection.id, {
                credentials: {
                    ...connection.credentials,
                    authKey: encrypted,
                    ...((verified.email || user?.email) ? { email: verified.email || user?.email } : {}),
                    ...(verified.userId ? { userId: verified.userId } : {}),
                },
                status: 'active',
            })
            toast({ title: 'Stremio session refreshed' })
            await useConnectionStore.getState().syncConnections(accountId)
        } catch (err) {
            toast({ title: 'Re-authentication failed', description: errMsg(err), variant: 'destructive' })
        }
    }

    const handleQrClaimed = async (session: QRSession) => {
        try {
            const authKey = (session.platformData as { authKey: string }).authKey
            if (!authKey) throw new Error('QR approval did not return a session. Try again.')
            const verified = await verifyStremioReconnect(authKey, connection, account)
            const encryptionKey = getEncryptionKey()
            const encrypted = await encrypt(authKey, encryptionKey)
            if (getEncryptionKey() !== encryptionKey) throw new Error('Your vault changed while saving. Unlock it and try again.')
            await updateConnection(accountId, connection.id, {
                credentials: {
                    ...connection.credentials,
                    authKey: encrypted,
                    ...(verified.userId ? { userId: verified.userId } : {}),
                },
                status: 'active',
            })
            toast({ title: 'Stremio session refreshed' })
            await useConnectionStore.getState().syncConnections(accountId)
        } catch (err) {
            toast({ title: 'QR re-authentication failed', description: errMsg(err), variant: 'destructive' })
        }
    }

    return (
        <>
            <ReauthCard
                title="Re-authenticate"
                description="Sign in with your Stremio email and password, or paste a fresh auth key."
                layoutId="stremio-reauth-method"
                methods={[
                    {
                        id: 'password',
                        label: 'Password',
                        content: (
                            <div className="space-y-3">
                                <div className="space-y-2">
                                    <Label htmlFor="stremio-edit-email">Email</Label>
                                    <div className="relative">
                                        <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                                        <Input
                                            id="stremio-edit-email"
                                            type="email"
                                            placeholder="you@example.com"
                                            value={email}
                                            onChange={e => setEmail(e.target.value)}
                                            className="pl-10"
                                            autoFocus
                                        />
                                    </div>
                                </div>
                                <div className="space-y-2">
                                    <Label htmlFor="stremio-edit-password">Password</Label>
                                    <div className="relative">
                                        <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                                        <Input
                                            id="stremio-edit-password"
                                            type={showPassword ? 'text' : 'password'}
                                            placeholder="Your Stremio password"
                                            value={password}
                                            onChange={e => setPassword(e.target.value)}
                                            className="pl-10 pr-9"
                                            onKeyDown={e => { if (e.key === 'Enter' && emailValid && passwordValid) handleReauth() }}
                                        />
                                        <button
                                            type="button"
                                            data-theme-part="button"
                                            onClick={() => setShowPassword(s => !s)}
                                            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                                            aria-label={showPassword ? 'Hide password' : 'Show password'}
                                        >
                                            {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                                        </button>
                                    </div>
                                </div>
                                <Button
                                    size="sm"
                                    className="h-8 w-full gap-1.5 text-xs"
                                    onClick={handleReauth}
                                    disabled={saving || !emailValid || !passwordValid}
                                >
                                    {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                                    {saving ? 'Authenticating...' : 'Re-authenticate'}
                                </Button>
                                <StremioSocialAuth onAuthKey={handleSocialAuthKey} />
                            </div>
                        ),
                    },
                    {
                        id: 'qr',
                        label: 'QR Code',
                        content: (
                            <div className="space-y-3">
                                <p className="text-xs leading-relaxed text-muted-foreground">
                                    Scan with your phone's Stremio app and approve to refresh this account's session without a password.
                                </p>
                                <Button
                                    size="sm"
                                    className="h-8 w-full gap-1.5 text-xs"
                                    onClick={() => setQrOpen(true)}
                                >
                                    <QrCode className="h-3.5 w-3.5" />
                                    Re-authenticate with QR
                                </Button>
                            </div>
                        ),
                    },
                    {
                        id: 'authkey',
                        label: 'Auth Key',
                        content: (
                            <div className="space-y-3">
                                <div className="space-y-2">
                                    <Label htmlFor="stremio-new-authkey">New Auth Key</Label>
                                    <div className="relative">
                                        <Key className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                                        <Input
                                            id="stremio-new-authkey"
                                            type="password"
                                            placeholder="Paste a fresh Stremio auth key"
                                            value={newAuthKey}
                                            onChange={e => setNewAuthKey(e.target.value)}
                                            className="pl-10"
                                            onKeyDown={e => { if (e.key === 'Enter' && newAuthKey.trim()) handleUpdate() }}
                                        />
                                    </div>
                                </div>
                                <Button
                                    size="sm"
                                    className="h-8 w-full gap-1.5 text-xs"
                                    onClick={handleUpdate}
                                    disabled={savingKey || !newAuthKey.trim()}
                                >
                                    {savingKey ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                                    {savingKey ? 'Updating...' : 'Update Auth Key'}
                                </Button>
                            </div>
                        ),
                    },
                ]}
            />
            <QRLinkDialog
                open={qrOpen}
                onOpenChange={setQrOpen}
                title="Re-authenticate Stremio"
                description="Scan the QR code with your phone's Stremio app and approve to refresh this account's session."
                start={createStremioLink}
                poll={pollStremioLink}
                onClaimed={handleQrClaimed}
            />
        </>
    )
}

function StremioDangerZoneSection({ accountId, connection }: { accountId: string; connection: Connection }) {
    const [password, setPassword] = useState('')
    const [showPassword, setShowPassword] = useState(false)
    const [deleting, setDeleting] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [confirmDelete, setConfirmDelete] = useState(false)

    const handleDelete = async () => {
        if (!password.trim() || deleting) return
        setDeleting(true)
        setError(null)
        try {
            // THIS connection's sealed key, never the account-level canonical one: deleting
            // a remote Stremio account is irreversible, and the canonical key would destroy
            // the wrong login's account when a secondary card is open.
            const encryptedKey = stremioConnectionAuthKey(connection)
            if (!encryptedKey) throw new Error('No auth key stored for this connection')
            const authKey = await getCachedAuthKey(encryptedKey, getEncryptionKey())
            await stremioClient.deleteUser(authKey, password)
            // The account is gone on the platform, so its rules cannot keep running on this
            // login: pause them server-first (reversible, same disposition as the removal
            // flow) before unlinking. A failed pause keeps the connection so it can retry.
            const { isLastStremioLoginRemoval, findDependentRules } = await import('@/lib/rule-removal')
            const accountNow = useAccountStore.getState().accounts.find(a => a.id === accountId)
            if (accountNow && isLastStremioLoginRemoval(accountNow, connection.id)) {
                const dependent = findDependentRules(useFailoverStore.getState().rules, accountId, connection.id, accountNow)
                for (const rule of dependent) {
                    await useFailoverStore.getState().pauseRule(rule.id)
                }
            }
            await useConnectionStore.getState().removeConnection(accountId, connection.id, { autopilotRules: 'paused' })
            toast({ title: 'Stremio account deleted', description: 'The account was permanently deleted from Stremio.' })
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to delete account')
        } finally {
            setDeleting(false)
        }
    }

    return (
        <div data-theme-tone="status" data-theme-part="panel" className="rounded-2xl border border-destructive/30 bg-destructive/5 p-4 shadow-sm space-y-3">
            <div className="min-w-0">
                <p className="text-sm font-semibold text-destructive">Delete Stremio account</p>
                <p className="text-xs leading-relaxed text-muted-foreground">
                    Permanently deletes this account on Stremio's servers, including its addons and library. This cannot be undone.
                </p>
            </div>
            <div className="space-y-2">
                <Label htmlFor="stremio-delete-password">Account password</Label>
                <div className="relative">
                    <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                        id="stremio-delete-password"
                        type={showPassword ? 'text' : 'password'}
                        placeholder="Your Stremio password"
                        value={password}
                        onChange={e => { setPassword(e.target.value); setError(null); setConfirmDelete(false) }}
                        className="pl-10 pr-9"
                        onKeyDown={e => { if (e.key === 'Enter' && password.trim() && confirmDelete) handleDelete() }}
                        autoComplete="current-password"
                    />
                    <button
                        type="button"
                        data-theme-part="button"
                        onClick={() => setShowPassword(s => !s)}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                        aria-label={showPassword ? 'Hide password' : 'Show password'}
                    >
                        {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                </div>
                {error && (
                    <div data-theme-tone="status" data-theme-part="panel" className="rounded-xl bg-destructive/10 border border-destructive/20 px-3 py-2 text-xs text-destructive">{error}</div>
                )}
            </div>
            <div className="flex items-center justify-end gap-1.5">
                {confirmDelete ? (
                    <>
                        <Button size="sm" variant="subtle" className="h-8 text-xs" onClick={() => setConfirmDelete(false)} disabled={deleting}>
                            Cancel
                        </Button>
                        <Button size="sm" variant="destructive" className="h-8 gap-1.5 text-xs" onClick={handleDelete} disabled={deleting || !password.trim()}>
                            {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                            {deleting ? 'Deleting...' : 'Permanently Delete'}
                        </Button>
                    </>
                ) : (
                    <Button size="sm" variant="destructive" className="h-8 gap-1.5 text-xs" onClick={() => setConfirmDelete(true)} disabled={!password.trim()}>
                        <Trash2 className="h-3.5 w-3.5" />
                        Delete Stremio Account...
                    </Button>
                )}
            </div>
        </div>
    )
}

// Actions for the last-Stremio-login removal: dispose the dependent Autopilot rules on
// the server first (pause or strict delete), then unlink the login. Any failure keeps
// the login and reports inline.
function AutopilotRulesRemovalDialog({ accountId, connection, rules, open, onOpenChange, onBack }: {
    accountId: string
    connection: Connection
    rules: ReadonlyArray<{ id: string; name?: string }>
    open: boolean
    onOpenChange: (open: boolean) => void
    onBack: () => void
}) {
    const privacyOn = useUIStore(s => s.isPrivacyModeEnabled)
    const nameLevel = useUIStore(s => s.privacyLevelNames)
    const [busy, setBusy] = useState<'paused' | 'deleted' | null>(null)
    const [error, setError] = useState<string | null>(null)
    const visibleRules = rules.slice(0, 5)
    const extraCount = rules.length - visibleRules.length

    // Recompute at action time: retries after a partial failure must act on what is
    // actually still here, not on the snapshot the dialog was opened with.
    const dependentsNow = () => {
        const account = useAccountStore.getState().accounts.find(a => a.id === accountId)
        return account ? findDependentRules(useFailoverStore.getState().rules, accountId, connection.id, account) : []
    }

    const runRemoval = async (disposition: 'paused' | 'deleted') => {
        if (busy) return
        setBusy(disposition)
        setError(null)
        try {
            const failover = useFailoverStore.getState()
            for (const rule of dependentsNow()) {
                if (disposition === 'deleted') await failover.removeRule(rule.id, { strict: true })
                else await failover.pauseRule(rule.id)
            }
            await useConnectionStore.getState().removeConnection(accountId, connection.id, { autopilotRules: disposition })
            onOpenChange(false)
            onBack()
        } catch (err) {
            setError(errMsg(err, 'Could not reach the server, so the login was not removed. Try again.'))
        } finally {
            setBusy(null)
        }
    }

    return (
        <Dialog open={open} onOpenChange={next => { if (!busy) onOpenChange(next) }}>
            <DialogContent className="max-w-sm sm:max-w-sm" hideClose>
                <DialogHeader className="items-center pr-0 text-center sm:text-center">
                    <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-warning/30 bg-warning/10 text-warning">
                        <TriangleAlert className="h-6 w-6" />
                    </span>
                    <DialogTitle>Autopilot rules use this login</DialogTitle>
                    <DialogDescription className="leading-relaxed">
                        Removing it leaves these rules without a Stremio login:
                    </DialogDescription>
                </DialogHeader>
                {visibleRules.length > 0 && (
                    <div className="rounded-2xl border border-border/40 bg-muted/20 p-3">
                        <ul className="space-y-2">
                            {visibleRules.map(rule => (
                                <li key={rule.id} className="flex items-center gap-2 text-sm font-medium">
                                    <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
                                    <span className="truncate">{maskNameLevel(ruleDisplayName(rule), privacyOn ? nameLevel : 0)}</span>
                                </li>
                            ))}
                        </ul>
                        {extraCount > 0 && <p className="mt-2 text-xs text-muted-foreground">and {extraCount} more</p>}
                    </div>
                )}
                {error && (
                    <p role="alert" className="flex items-start gap-2 text-xs leading-relaxed text-destructive">
                        <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        {error}
                    </p>
                )}
                <DialogFooter className="gap-2">
                    <div className="grid w-full grid-cols-2 gap-3 sm:w-auto">
                        <Button type="button" variant="subtle" disabled={busy !== null} onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button type="button" data-autofocus="true" disabled={busy !== null} onClick={() => void runRemoval('paused')}>
                            {busy === 'paused' && <Loader2 className="h-4 w-4 animate-spin" />}
                            Keep Paused
                        </Button>
                    </div>
                    <Button type="button" variant="ghost" className="text-destructive hover:text-destructive" disabled={busy !== null} onClick={() => void runRemoval('deleted')}>
                        {busy === 'deleted' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                        Delete Rules
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}

function RemoveConnectionSection({ accountId, connection, onBack }: { accountId: string; connection: Connection; onBack: () => void }) {
    const removeConnection = useConnectionStore(s => s.removeConnection)
    const account = useAccountStore(s => s.accounts.find(a => a.id === accountId))
    const rules = useFailoverStore(s => s.rules)
    const [confirmRemove, setConfirmRemove] = useState(false)
    const [rulesDialogOpen, setRulesDialogOpen] = useState(false)
    const [error, setError] = useState<string | null>(null)

    // Only removing the LAST Stremio login can strand rules; every other removal keeps
    // today's inline confirm.
    const dependentRules = useMemo(
        () => account && isLastStremioLoginRemoval(account, connection.id)
            ? findDependentRules(rules, accountId, connection.id, account)
            : [],
        [rules, account, accountId, connection.id]
    )
    // Any other removal still deletes rules bound to this login (server and local); name them.
    const boundRulesNotice = useMemo(
        () => account && !isLastStremioLoginRemoval(account, connection.id)
            ? boundRulesRemovalNotice(findDependentRules(rules, accountId, connection.id, account))
            : null,
        [rules, account, accountId, connection.id]
    )

    const handleRemove = () => {
        setError(null)
        if (dependentRules.length > 0) {
            setConfirmRemove(false)
            setRulesDialogOpen(true)
            return
        }
        setConfirmRemove(false)
        removeConnection(accountId, connection.id)
            .then(() => onBack())
            .catch(err => setError(errMsg(err, 'Could not remove the connection. Try again.')))
    }

    return (
        <>
            <div data-theme-part="panel" className="rounded-2xl border border-border/40 bg-card/50 p-4 shadow-sm space-y-3">
                <div className="min-w-0">
                    <p className="text-sm font-semibold">Remove connection</p>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                        Unlinks this {connectionLabel(connection)} connection from AIOManager. Nothing is deleted on the platform itself.
                    </p>
                    {boundRulesNotice && (
                        <p className="mt-1 text-xs leading-relaxed text-destructive">{boundRulesNotice}</p>
                    )}
                </div>
                {error && (
                    <p className="flex items-start gap-2 text-xs leading-relaxed text-destructive">
                        <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        {error}
                    </p>
                )}
                <div className="flex items-center justify-end gap-1.5">
                    {confirmRemove ? (
                        <>
                            <Button size="sm" variant="subtle" className="h-8 text-xs" onClick={() => setConfirmRemove(false)}>Cancel</Button>
                            <Button size="sm" variant="destructive" className="h-8 gap-1.5 text-xs" onClick={handleRemove}>
                                <Trash2 className="h-3.5 w-3.5" />
                                Remove Connection
                            </Button>
                        </>
                    ) : (
                        <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs text-destructive hover:text-destructive" onClick={() => { setError(null); if (dependentRules.length > 0) { setRulesDialogOpen(true) } else { setConfirmRemove(true) } }}>
                            <Trash2 className="h-3.5 w-3.5" />
                            Remove Connection...
                        </Button>
                    )}
                </div>
            </div>
            <AutopilotRulesRemovalDialog
                accountId={accountId}
                connection={connection}
                rules={dependentRules}
                open={rulesDialogOpen}
                onOpenChange={setRulesDialogOpen}
                onBack={onBack}
            />
        </>
    )
}

function NuvioCredentialsSection({ accountId, connection }: { accountId: string; connection: Connection }) {
    const updateConnection = useConnectionStore(s => s.updateConnection)
    const [email, setEmail] = useState(connection.credentials?.email || '')
    const [password, setPassword] = useState('')
    const [showPassword, setShowPassword] = useState(false)
    const [saving, setSaving] = useState(false)
    const [testing, setTesting] = useState(false)
    const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
    const [qrOpen, setQrOpen] = useState(false)

    const emailValid = email.includes('@')
    const passwordValid = password.length > 0

    const storedBaseUrl = connection.credentials?.baseUrl || undefined
    const storedPublishableKey = connection.credentials?.publishableKey || undefined

    const handleReauth = async () => {
        if (!emailValid || !passwordValid) return
        setSaving(true)
        try {
            const bu = connection.credentials?.baseUrl || undefined
            const pk = connection.credentials?.publishableKey || undefined
            const result = await nuvioAuth(email, password, pk, bu)
            const t = result.tokens
            if (!t) throw new Error('No tokens returned. Confirm your Nuvio account and try again.')
            await updateConnection(accountId, connection.id, {
                credentials: {
                    ...connection.credentials,
                    email,
                    accessToken: t.accessToken,
                    refreshToken: t.refreshToken,
                    expiresAt: String(t.expiresAt),
                },
                status: 'active',
            })
            const { storeConnectionCredential } = await import('@/api/hydra-providers')
            try {
                await storeConnectionCredential(accountId, connection.id, {
                    accessToken: t.accessToken,
                    refreshToken: t.refreshToken,
                    expiresAt: t.expiresAt,
                    profileId: connection.credentials?.profileId || null,
                    baseUrl: bu || null,
                    publishableKey: pk || null,
                }, 'nuvio', connection.generation)
            } catch (err) {
                toast({ title: 'Saved locally, but the server did not store the new session', description: errMsg(err), variant: 'destructive' })
            }
            toast({ title: 'Nuvio session refreshed' })
            setPassword('')
            await useConnectionStore.getState().syncConnections(accountId)
        } catch (err) {
            toast({ title: 'Re-authentication failed', description: errMsg(err), variant: 'destructive' })
        } finally {
            setSaving(false)
        }
    }

    const handleQrClaimed = async (session: QRSession) => {
        try {
            const result = await exchangeNuvioQr(session, storedPublishableKey, storedBaseUrl)
            const t = result.tokens
            if (!t) throw new Error('No tokens returned. Try QR sign-in again.')
            await updateConnection(accountId, connection.id, {
                credentials: {
                    ...connection.credentials,
                    email: result.email || email,
                    accessToken: t.accessToken,
                    refreshToken: t.refreshToken,
                    expiresAt: String(t.expiresAt),
                },
                status: 'active',
            })
            const { storeConnectionCredential } = await import('@/api/hydra-providers')
            try {
                await storeConnectionCredential(accountId, connection.id, {
                    accessToken: t.accessToken,
                    refreshToken: t.refreshToken,
                    expiresAt: t.expiresAt,
                    profileId: connection.credentials?.profileId || null,
                    baseUrl: storedBaseUrl || null,
                    publishableKey: storedPublishableKey || null,
                }, 'nuvio', connection.generation)
            } catch (err) {
                toast({ title: 'Saved locally, but the server did not store the new session', description: errMsg(err), variant: 'destructive' })
            }
            toast({ title: 'Nuvio session refreshed' })
            await useConnectionStore.getState().syncConnections(accountId)
        } catch (err) {
            toast({ title: 'QR re-authentication failed', description: errMsg(err), variant: 'destructive' })
        } finally {
            setQrOpen(false)
        }
    }

    const handleTest = async () => {
        setTesting(true)
        setTestResult(null)
        try {
            const { message } = await runConnectionTest(accountId, connection)
            setTestResult({ ok: true, message })
            toast({ title: 'Connection healthy' })
        } catch (err) {
            const message = errMsg(err, 'Session could not be verified. Try re-authenticating.')
            setTestResult({ ok: false, message })
            toast({ title: 'Connection test failed', description: message, variant: 'destructive' })
        } finally {
            setTesting(false)
        }
    }

    return (
        <>
            <ReauthCard
                title="Nuvio credentials"
                description="Re-authenticate to refresh your session tokens."
                layoutId="nuvio-reauth-method"
                headerAction={
                    <ConnectionTestButton testing={testing} onClick={handleTest} />
                }
                footer={<ConnectionTestResult result={testResult} />}
                methods={[
                    {
                        id: 'password',
                        label: 'Password',
                        content: (
                            <div className="space-y-3">
                                <div className="space-y-2">
                                    <Label htmlFor="nuvio-edit-email">Email</Label>
                                    <div className="relative">
                                        <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                                        <Input
                                            id="nuvio-edit-email"
                                            type="email"
                                            placeholder="you@example.com"
                                            value={email}
                                            onChange={e => setEmail(e.target.value)}
                                            className="pl-10"
                                        />
                                    </div>
                                </div>
                                <div className="space-y-2">
                                    <Label htmlFor="nuvio-edit-password">Password</Label>
                                    <div className="relative">
                                        <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                                        <Input
                                            id="nuvio-edit-password"
                                            type={showPassword ? 'text' : 'password'}
                                            placeholder="Your Nuvio password"
                                            value={password}
                                            onChange={e => setPassword(e.target.value)}
                                            className="pl-10 pr-9"
                                            onKeyDown={e => { if (e.key === 'Enter' && emailValid && passwordValid) handleReauth() }}
                                        />
                                        <button
                                            type="button"
                                            data-theme-part="button"
                                            onClick={() => setShowPassword(s => !s)}
                                            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                                            aria-label={showPassword ? 'Hide password' : 'Show password'}
                                        >
                                            {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                                        </button>
                                    </div>
                                </div>
                                <Button
                                    size="sm"
                                    className="h-8 w-full gap-1.5 text-xs"
                                    onClick={handleReauth}
                                    disabled={saving || !emailValid || !passwordValid}
                                >
                                    {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                                    {saving ? 'Authenticating...' : 'Re-authenticate'}
                                </Button>
                            </div>
                        ),
                    },
                    {
                        id: 'qr',
                        label: 'QR Code',
                        content: (
                            <div className="space-y-3">
                                <p className="text-xs leading-relaxed text-muted-foreground">
                                    Scan with the Nuvio app on your phone to refresh this connection's session without a password.
                                </p>
                                <Button
                                    size="sm"
                                    className="h-8 w-full gap-1.5 text-xs"
                                    onClick={() => setQrOpen(true)}
                                >
                                    <QrCode className="h-3.5 w-3.5" />
                                    Re-authenticate with QR
                                </Button>
                            </div>
                        ),
                    },
                ]}
            />
            <QRLinkDialog
                open={qrOpen}
                onOpenChange={setQrOpen}
                title="Re-authenticate Nuvio"
                description="Scan the QR code with the Nuvio app on your phone to refresh this connection's session."
                start={() => startNuvioQr(storedPublishableKey, storedBaseUrl)}
                poll={(session) => pollNuvioQr(session, storedPublishableKey, storedBaseUrl)}
                onClaimed={handleQrClaimed}
            />
        </>
    )
}

function RealStreamCredentialsSection({ accountId, connection }: { accountId: string; connection: Connection }) {
    const updateConnection = useConnectionStore(s => s.updateConnection)
    const [email, setEmail] = useState(connection.credentials?.email || '')
    const [password, setPassword] = useState('')
    const [showPassword, setShowPassword] = useState(false)
    const [saving, setSaving] = useState(false)
    const [testing, setTesting] = useState(false)
    const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)

    const emailValid = email.includes('@')
    const passwordValid = password.length > 0

    const handleReauth = async () => {
        if (!emailValid || !passwordValid) return
        setSaving(true)
        try {
            const result = await realstreamAuth(email, password, connection.credentials?.baseUrl || undefined)
            const t = result.tokens
            if (!t) throw new Error('No tokens returned. Confirm your RealStream account and try again.')
            const credentials = {
                ...connection.credentials,
                email,
                password,
                accessToken: t.accessToken,
                userId: t.userId || connection.credentials?.userId || '',
                expiresAt: String(t.expiresAt),
            }
            await updateConnection(accountId, connection.id, { credentials, status: 'active' })
            const { storeConnectionCredential } = await import('@/api/hydra-providers')
            try {
                await storeConnectionCredential(accountId, connection.id, {
                    accessToken: t.accessToken,
                    userId: t.userId || null,
                    expiresAt: t.expiresAt,
                    baseUrl: connection.credentials?.baseUrl || null,
                    email,
                    password,
                }, 'realstream', connection.generation)
            } catch (err) {
                toast({ title: 'Saved locally, but the server did not store the new session', description: errMsg(err), variant: 'destructive' })
            }
            toast({ title: 'RealStream session refreshed' })
            setPassword('')
            await useConnectionStore.getState().syncConnections(accountId)
        } catch (err) {
            toast({ title: 'Re-authentication failed', description: errMsg(err), variant: 'destructive' })
        } finally {
            setSaving(false)
        }
    }

    const handleTest = async () => {
        setTesting(true)
        setTestResult(null)
        try {
            const { message } = await runConnectionTest(accountId, connection)
            setTestResult({ ok: true, message })
            toast({ title: 'Connection healthy' })
        } catch (err) {
            const message = errMsg(err, 'Session could not be verified. Try re-authenticating.')
            setTestResult({ ok: false, message })
            toast({ title: 'Connection test failed', description: message, variant: 'destructive' })
        } finally {
            setTesting(false)
        }
    }

    return (
        <ReauthCard
            title="RealStream credentials"
            description="Re-authenticate to refresh your session tokens."
            headerAction={
                <ConnectionTestButton testing={testing} onClick={handleTest} />
            }
            footer={<ConnectionTestResult result={testResult} />}
            methods={[
                {
                    id: 'password',
                    label: 'Password',
                    content: (
                        <div className="space-y-3">
                            <div className="space-y-2">
                                <Label htmlFor="rs-edit-email">Email</Label>
                                <div className="relative">
                                    <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                                    <Input
                                        id="rs-edit-email"
                                        type="email"
                                        placeholder="you@example.com"
                                        value={email}
                                        onChange={e => setEmail(e.target.value)}
                                        className="pl-10"
                                    />
                                </div>
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="rs-edit-password">Password</Label>
                                <div className="relative">
                                    <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                                    <Input
                                        id="rs-edit-password"
                                        type={showPassword ? 'text' : 'password'}
                                        placeholder="Your RealStream password"
                                        value={password}
                                        onChange={e => setPassword(e.target.value)}
                                        className="pl-10 pr-9"
                                        onKeyDown={e => { if (e.key === 'Enter' && emailValid && passwordValid) handleReauth() }}
                                    />
                                    <button
                                        type="button"
                                        data-theme-part="button"
                                        onClick={() => setShowPassword(s => !s)}
                                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                                        aria-label={showPassword ? 'Hide password' : 'Show password'}
                                    >
                                        {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                                    </button>
                                </div>
                            </div>
                                <Button
                                    size="sm"
                                    className="h-8 w-full gap-1.5 text-xs"
                                    onClick={handleReauth}
                                    disabled={saving || !emailValid || !passwordValid}
                                >
                                    {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                                    {saving ? 'Authenticating...' : 'Re-authenticate'}
                                </Button>
                            </div>
                        ),
                    },
            ]}
        />
    )
}

function HydraCredentialsSection({ accountId, connection }: { accountId: string; connection: Connection }) {
    const updateConnection = useConnectionStore(s => s.updateConnection)
    const [newApiKey, setNewApiKey] = useState('')
    const [showKey, setShowKey] = useState(false)
    const [saving, setSaving] = useState(false)
    const [testing, setTesting] = useState(false)
    const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)

    const handleUpdate = async () => {
        const trimmed = newApiKey.trim()
        if (!trimmed) return
        setSaving(true)
        try {
            await updateConnection(accountId, connection.id, {
                credentials: { ...connection.credentials, apiKey: trimmed },
                status: 'active',
            })
            const { storeConnectionCredential } = await import('@/api/hydra-providers')
            const bundle = {
                authValue: trimmed,
                baseUrl: connection.driverConfig?.baseUrl,
                authType: connection.driverConfig?.authType,
                authHeader: connection.driverConfig?.authHeader,
                enabled: connection.enabled,
            }
            try {
                await storeConnectionCredential(accountId, connection.id, bundle, 'hydra', connection.generation)
            } catch (err) {
                toast({ title: 'Saved locally, but the server did not store the key', description: errMsg(err), variant: 'destructive' })
            }
            toast({ title: 'API key updated' })
            setNewApiKey('')
            setTestResult(null)
            await useConnectionStore.getState().syncConnections(accountId)
        } catch (err) {
            toast({ title: 'Update failed', description: errMsg(err), variant: 'destructive' })
        } finally {
            setSaving(false)
        }
    }

    const handleTest = async () => {
        setTesting(true)
        setTestResult(null)
        try {
            const { message } = await runConnectionTest(accountId, connection, { apiKey: newApiKey })
            setTestResult({ ok: true, message })
            toast({ title: 'Connection healthy' })
        } catch (err) {
            const message = errMsg(err, 'Endpoint test failed. Check the API key and target server.')
            setTestResult({ ok: false, message })
            toast({ title: 'Connection test failed', description: message, variant: 'destructive' })
        } finally {
            setTesting(false)
        }
    }

    return (
        <ReauthCard
            title="Hydra API key"
            description="Update the API key used to push to this outbound server."
            headerAction={
                <ConnectionTestButton testing={testing} onClick={handleTest} />
            }
            footer={<ConnectionTestResult result={testResult} />}
            methods={[
                {
                    id: 'apikey',
                    label: 'API Key',
                    content: (
                        <div className="space-y-3">
                            <div className="space-y-2">
                                <Label htmlFor="hydra-edit-key">New API Key</Label>
                                <div className="relative">
                                    <Key className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                                    <Input
                                        id="hydra-edit-key"
                                        type={showKey ? 'text' : 'password'}
                                        placeholder="Paste a new API key"
                                        value={newApiKey}
                                        onChange={e => { setNewApiKey(e.target.value); setTestResult(null) }}
                                        className="pl-10 pr-9"
                                        onKeyDown={e => { if (e.key === 'Enter' && newApiKey.trim()) handleUpdate() }}
                                    />
                                    <button
                                        type="button"
                                        data-theme-part="button"
                                        onClick={() => setShowKey(s => !s)}
                                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                                        aria-label={showKey ? 'Hide key' : 'Show key'}
                                    >
                                        {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                                    </button>
                                </div>
                            </div>
                            <Button
                                size="sm"
                                className="h-8 w-full gap-1.5 text-xs"
                                onClick={handleUpdate}
                                disabled={saving || !newApiKey.trim()}
                            >
                                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                                {saving ? 'Updating...' : 'Update API Key'}
                            </Button>
                        </div>
                    ),
                },
            ]}
        />
    )
}

function SupportersProfilesRoster({ accountId, connection }: { accountId: string; connection: Connection }) {
    const account = useAccountStore(s => s.accounts.find(a => a.id === accountId))
    const accounts = useAccountStore(s => s.accounts)
    const updateConnection = useConnectionStore(s => s.updateConnection)
    const [profiles, setProfiles] = useState<Array<{ id: string; name: string; avatar?: string }>>([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const selfUserId = useRef('')

    const claims = useMemo(() => getProfileClaims(accounts), [accounts])

    const loadProfiles = useCallback(async () => {
        if (!account) return
        setLoading(true)
        setError(null)
        try {
            // Supporters profiles belong to the login being edited; the canonical key
            // would list a different user's profiles on a secondary card. The shared
            // GetUser cache is keyed per auth key, so a secondary never sees the
            // canonical login's cached user.
            const encryptedKey = stremioConnectionAuthKey(connection)
            if (!encryptedKey) throw new Error('No auth key stored for this connection')
            const authKey = await getCachedAuthKey(encryptedKey, getEncryptionKey())
            const user = await getUserCached(authKey, key => stremioClient.getUser(key))
            selfUserId.current = user._id || ''
            const userProfiles = user.premiumPrefs?.userProfiles
            if (userProfiles) {
                setProfiles(Object.values(userProfiles).map(p => ({ id: p.id, name: p.name, avatar: p.avatar })))
            } else {
                setProfiles([])
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not load Stremio profiles')
        } finally {
            setLoading(false)
        }
    }, [account, connection])

    useEffect(() => { loadProfiles() }, [loadProfiles])

    const rowStateFor = (profileId: string): ProfileRosterState => {
        if (!profileId) return 'unclaimed'
        const resolved = resolveProfileState({ platform: 'stremio', profileId }, claims, accountId, connection.id)
        if (resolved === 'unclaimed' && selfUserId.current && profileId === selfUserId.current) return 'active-here'
        return resolved
    }

    const navigateToClaimant = (claimId: string) => {
        const owner = accounts.find(a => a.id === claimId)
        if (!owner) return
        useUIStore.getState().openAddAccountDialog(owner)
    }

    const [pasteFor, setPasteFor] = useState<{ id: string; name: string } | null>(null)
    const [pasteName, setPasteName] = useState('')
    const [pasteKey, setPasteKey] = useState('')
    const [adding, setAdding] = useState(false)
    const [showKeyHelp, setShowKeyHelp] = useState(false)

    const openPaste = (p: { id: string; name: string }) => {
        setPasteFor(p)
        setPasteName(p.name)
        setPasteKey('')
    }

    const confirmPaste = async () => {
        if (!pasteFor || !pasteKey.trim() || adding) return
        setAdding(true)
        let createdId: string | null = null
        try {
            const result = await addStremioProfileAccount(
                pasteKey.trim(),
                pasteName.trim() || pasteFor.name,
            )
            createdId = result.accountId
            if (result.skipped) {
                toast({ title: 'Already added', description: 'This profile is already an account here.' })
            }
            // Stamp the claim on the skipped path too: a first attempt that created
            // the account but died before stamping would otherwise stay unclaimed
            // forever while every retry reports "Already added".
            const targetId = createdId ?? (await findAccountByAuthKey(pasteKey.trim()))
            const target = targetId ? useAccountStore.getState().accounts.find(a => a.id === targetId) : undefined
            const stremioConn = target?.connections?.find(c => c.platform === 'stremio')
            if (target && stremioConn && !stremioConn.credentials?.stremioProfileId) {
                await updateConnection(target.id, stremioConn.id, {
                    credentials: { ...stremioConn.credentials, stremioProfileId: pasteFor.id },
                })
            }
            if (!result.skipped) {
                toast({ title: 'Account added' })
            }
            setPasteFor(null)
            setPasteKey('')
            await loadProfiles()
        } catch (err) {
            toast({
                title: createdId ? 'Account added, but the profile stamp failed' : 'Could not add this auth key',
                description: createdId ? 'The account exists; retry this profile to link it.' : errMsg(err),
                variant: createdId ? 'warning' : 'destructive',
            })
        } finally {
            setAdding(false)
        }
    }

    const claimFor = (profileId: string) =>
        claims.get(profileClaimKey({ platform: 'stremio', profileId }))

    return (
        <div data-theme-part="panel" className="rounded-2xl border border-border/40 bg-card/50 p-4 shadow-sm space-y-3">
            {/* Same section head vocabulary as the Nuvio profile roster so both
                connection surfaces read as one layout language: live count and
                reload, never an invented number. */}
            <TabToolbar label="Supporters profiles" count={loading ? undefined : profiles.length} loading={loading} onReload={() => { void loadProfiles() }} icon={<Users className="h-3.5 w-3.5" />} />
            <div className="-mt-2.5 min-w-0">
                <p className="text-xs text-muted-foreground">Each Supporters profile can become its own fully managed account.</p>
                <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground/80">
                    Adding a profile as an account makes it a full account, just like the ones you already manage: its own addons, its own watch history. It stays on the same Stremio login and nothing changes on Stremio. You can delete the account anytime.
                </p>
            </div>

            {loading ? (
                <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading profiles...
                </div>
            ) : error ? (
                <>
                    <div data-theme-tone="status" data-theme-part="panel" className="rounded-xl bg-destructive/10 border border-destructive/20 px-3 py-2 text-xs text-destructive">{error}</div>
                    <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs" onClick={loadProfiles}>
                        <RefreshCw className="h-3.5 w-3.5" /> Retry
                    </Button>
                </>
            ) : profiles.length === 0 ? (
                <p className="py-2 text-xs text-muted-foreground">No Supporters profiles found on this login.</p>
            ) : (
                <>
                    <div className="space-y-1.5">
                        {profiles.map((p, i) => {
                            const state = rowStateFor(p.id)
                            const claim = state === 'claimed' ? claimFor(p.id) : undefined
                            return (
                                <div key={p.id}>
                                    <ProfileRosterRow
                                        profile={{ name: p.name, index: i + 1 }}
                                        state={state}
                                        claimedBy={claim}
                                        onAdd={() => openPaste(p)}
                                        onNavigate={() => claim && navigateToClaimant(claim.accountId)}
                                    />
                                </div>
                            )
                        })}
                    </div>

                    {pasteFor && (
                        <div data-theme-part="panel" className="rounded-2xl border border-border/40 bg-card p-3 space-y-2.5 shadow-sm">
                            <p className="text-xs font-medium">Add <strong>{pasteFor.name}</strong> as its own account</p>
                            <div className="space-y-1">
                                <Label htmlFor={`supporters-name-${pasteFor.id}`} className="text-[11px] text-muted-foreground">Account name</Label>
                                <Input
                                    id={`supporters-name-${pasteFor.id}`}
                                    value={pasteName}
                                    onChange={e => setPasteName(e.target.value)}
                                    className="h-8 text-xs"
                                />
                            </div>
                            <div className="space-y-1">
                                <Label htmlFor={`supporters-key-${pasteFor.id}`} className="text-[11px] text-muted-foreground">Auth key from web.stremio.com</Label>
                                <Input
                                    id={`supporters-key-${pasteFor.id}`}
                                    type="password"
                                    value={pasteKey}
                                    onChange={e => setPasteKey(e.target.value)}
                                    placeholder="Paste this profile's auth key"
                                    className="h-8 font-mono text-xs"
                                    autoFocus
                                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void confirmPaste() } }}
                                />
                            </div>
                            <div className="flex gap-2">
                                <Button variant="subtle" size="sm" className="h-7 flex-1 text-xs" onClick={() => setPasteFor(null)} disabled={adding}>Cancel</Button>
                                <Button size="sm" className="h-7 flex-1 text-xs" onClick={() => void confirmPaste()} disabled={adding || !pasteKey.trim()}>
                                    {adding ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                                    Add as account
                                </Button>
                            </div>
                        </div>
                    )}
                </>
            )}

            <div data-theme-part="panel" className="rounded-xl border border-border/30 bg-muted/20">
                <button
                    type="button"
                    data-theme-part="button"
                    onClick={() => setShowKeyHelp(s => !s)}
                    className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left"
                >
                    <span className="text-xs font-semibold">How to get a profile's auth key</span>
                    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                        Don't know how?
                        <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', showKeyHelp && 'rotate-180')} />
                    </span>
                </button>
                {showKeyHelp && (
                    <div className="space-y-2.5 border-t border-border/30 px-3 py-3">
                        <ol className="space-y-1.5 text-xs leading-relaxed text-muted-foreground">
                            <li className="flex gap-2">
                                <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[10px] font-bold text-primary mt-0.5">1</span>
                                <span>
                                    Go to <a href="https://web.stremio.com/" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">web.stremio.com</a> and switch to the profile you want to add.
                                </span>
                            </li>
                            <li className="flex gap-2">
                                <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[10px] font-bold text-primary mt-0.5">2</span>
                                <span className="min-w-0 flex-1">
                                    Open the browser console (<kbd className="px-1 py-0.5 rounded bg-muted border border-border text-[10px]">F12</kbd>) and run:
                                    <pre
                                        data-theme-part="field"
                                        className="mt-1 select-all cursor-pointer overflow-x-auto rounded-lg bg-muted/60 border border-border/40 px-2 py-1 font-mono text-[10px] text-muted-foreground hover:bg-muted transition-colors"
                                        onClick={(e) => {
                                            const target = e.currentTarget
                                            const selection = window.getSelection()
                                            const range = document.createRange()
                                            range.selectNodeContents(target)
                                            selection?.removeAllRanges()
                                            selection?.addRange(range)
                                        }}
                                    >localStorage.getItem("profile")</pre>
                                </span>
                            </li>
                            <li className="flex gap-2">
                                <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[10px] font-bold text-primary mt-0.5">3</span>
                                <span>Copy the <span className="font-mono text-[10px]">authKey</span> value from the result, come back here, and paste it into the profile's Add as account box.</span>
                            </li>
                        </ol>
                        <p className="text-[11px] text-muted-foreground/70 border-t border-border/30 pt-2">
                            Stremio keeps profile control inside its own apps, so each profile needs its own key. Nuvio profiles are added with one tap on the Nuvio side. Full walkthrough in the <a href="/kronorium" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Kronorium</a>.
                        </p>
                    </div>
                )}
            </div>
        </div>
    )
}

/** Undated saved-state rows are excluded from watch time; say so when they exist. */
export function stremioLibraryWatchTimeSub(entries: ReadonlyArray<{ backfill?: boolean; importedSavedState?: boolean }>): string | undefined {
    const undated = entries.filter(entry => entry.backfill || entry.importedSavedState).length
    return undated > 0 ? `Excludes ${undated.toLocaleString()} undated saved ${undated === 1 ? 'row' : 'rows'}` : undefined
}

function StremioLibrarySection({ accountId, error }: { accountId: string; error?: string | null }) {
    // Jellyfin rows are filtered out below, so this view never pays for
    // Jellyfin media reads or archive walks.
    const { history: accountHistory, loading } = useWatchHistory(accountId, true, { media: false })
    const history = useMemo(() => accountHistory.filter(entry => !entry.source || entry.source === 'stremio'), [accountHistory])
    const accounts = useAccountStore(s => s.accounts)
    const canonical = useMemo(() => canonicalStremioConnections(accounts), [accounts])

    const stats = useMemo(() => computeLibraryStats(history, entry => cumulativeWatchKey(entry, canonical)), [history, canonical])
    const unlocked = useAuthStore(s => Boolean(s.encryptionKey))
    useEffect(() => {
        if (!unlocked) return
        void useLibraryCache.getState().ensureLoaded(useAccountStore.getState().accounts)
    }, [unlocked, accountId])
    const retry = () => {
        const cache = useLibraryCache.getState()
        cache.revalidate([accountId])
        void cache.ensureLoaded(useAccountStore.getState().accounts)
    }
    const errorBanner = error ? (
        <WorkspaceError title="Could not refresh this library" message={`${error} Showing what AIOManager last read.`} onRetry={retry} />
    ) : null

    if (loading && history.length === 0) return <WorkspaceLoading />

    if (history.length === 0) {
        return (
            <div className="space-y-3">
                {errorBanner}
                <EmptyState
                    icon={<BookOpen className="h-5 w-5" />}
                    title="No watch history"
                    description="Watch activity tracked for this account will appear here."
                />
            </div>
        )
    }

    const watchHours = stats.watchMs / 3600000
    const watchTime = watchHours >= 1 ? `${Math.round(watchHours * 10) / 10} h` : `${Math.round(stats.watchMs / 60000)} min`

    return (
        <div className="space-y-4">
            {errorBanner}
            <WorkspaceStatStrip bordered stats={[
                { label: 'Watched items', value: String(history.length) },
                { label: 'Movies', value: String(stats.movies) },
                { label: 'Episodes', value: String(stats.episodes) },
                { label: 'Watch time', value: watchTime, sub: stremioLibraryWatchTimeSub(history), title: 'Dated watches only; imported saved state has no watch times.' },
            ]} />
            {stats.topShows.length > 0 && (
                <SectionCard title="Most watched">
                    <div className="space-y-1.5">
                        {stats.topShows.map(({ itemId, name, episodes: count }, i) => (
                            <div key={itemId} className="flex min-w-0 items-center gap-3">
                                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-muted/60 text-xs font-bold text-muted-foreground">{i + 1}</span>
                                <span className="min-w-0 flex-1 truncate text-sm font-medium">{name}</span>
                                <span className="shrink-0 text-xs text-muted-foreground">{count} episode{count === 1 ? '' : 's'}</span>
                            </div>
                        ))}
                    </div>
                </SectionCard>
            )}
        </div>
    )
}

function ConnectionHealthCard({ kind, pill, showLive, sync, failures, lastError, testing, testResult, onTest, testDisabledReason }: {
    kind: WorkspaceKind
    pill: PillStatus
    showLive: boolean
    sync: { value: string; sub: string }
    failures?: number
    lastError?: string | null
    testing: boolean
    testResult: ConnectionTestOutcome | null
    onTest?: () => void
    testDisabledReason?: string
}) {
    return (
        <SectionCard
            title="Connection health"
            description="Latest test and sync result for this connection."
            action={onTest ? (
                <Tooltip content={testDisabledReason} disabled={!testDisabledReason}>
                    <span><ConnectionTestButton testing={testing} disabled={!!testDisabledReason} onClick={onTest} /></span>
                </Tooltip>
            ) : undefined}
        >
            <SectionRows>
                <SectionRow label="Status" value={<span className="inline-flex flex-wrap items-center gap-2"><ConnectionStatusPill status={pill} /><span className="font-normal text-muted-foreground">{statusSentence(pill, kind)}</span></span>} />
                <SectionRow label="Last sync" value={sync.value} tone={showLive ? undefined : 'muted'} />
                {showLive && failures != null && <SectionRow label="Failures in a row" value={String(failures)} tone={failures > 0 ? 'warning' : undefined} />}
                <SectionRow label="Last error" value={!showLive ? 'Not checked while paused' : lastError || 'None'} tone={showLive && lastError ? 'destructive' : 'muted'} />
            </SectionRows>
            <ConnectionTestResult result={testResult} />
        </SectionCard>
    )
}

function HydraEndpointCard({ connection, status, onTest, testing }: { connection: Connection; status: HydraStatus | null; onTest?: () => void; testing: boolean }) {
    const privacyOn = useUIStore(s => s.isPrivacyModeEnabled)
    const urlLevel = useUIStore(s => s.privacyLevelUrls)
    const config = connection.driverConfig
    return (
        <SectionCard title="Endpoint" description="The Hydra server AIOManager pushes this account's addons to.">
            <SectionRows>
                <SectionRow label="Name" value={config?.name || connection.displayName || 'Unnamed'} />
                <SectionRow label="URL" value={config?.baseUrl ? maskUrlLevel(config.baseUrl, privacyOn ? urlLevel : 0) : 'Not set'} mono tone={config?.baseUrl ? undefined : 'muted'} />
                <SectionRow label="Auth" value={hydraAuthLabel(connection)} />
                <SectionRow
                    label="Server reports"
                    value={status ? `${status.name || 'Hydra server'}${status.version ? ` v${status.version}` : ''}` : 'Run a test to read it'}
                    tone={status ? undefined : 'muted'}
                    aside={!status && onTest ? <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={onTest} disabled={testing}>Test</Button> : undefined}
                />
                {status && status.capabilities?.length > 0 && <SectionRow label="Capabilities" value={status.capabilities.join(', ')} />}
            </SectionRows>
        </SectionCard>
    )
}

function hydraAuthLabel(connection: Connection): string {
    const config = connection.driverConfig
    if (config?.authType === 'bearer') return 'Bearer token'
    if (config?.authType === 'basic') return 'Basic auth'
    if (config?.authType === 'none') return 'None'
    return `API key in ${config?.authHeader || 'x-api-key'}`
}

// The server owns Nuvio and RealStream token refresh, so the copy saved here goes stale.
// Mirror the server's current token so the workspace never shows a refreshed session as expired.
async function mirrorServerToken(accountId: string, connection: Connection, token: { accessToken: string; expiresAt: number }): Promise<void> {
    if (!token.accessToken || String(token.expiresAt) === String(connection.credentials?.expiresAt)) return
    await useConnectionStore.getState().updateConnection(accountId, connection.id, {
        credentials: { ...connection.credentials, accessToken: token.accessToken, expiresAt: String(token.expiresAt) },
    })
}

function useServerTokenMirror(accountId: string, connection: Connection, active: boolean) {
    const expired = tokenExpiresIn(connection.credentials?.expiresAt, Date.now())?.expired === true
    const checked = useRef<string | null>(null)
    useEffect(() => {
        if (!active || !expired || checked.current === connection.id) return
        checked.current = connection.id
        const platform = workspaceKind(connection) === 'nuvio' ? 'nuvio' : 'realstream'
        const baseUrl = platform === 'nuvio' ? connection.credentials?.baseUrl : undefined
        fetchConnectionToken(accountId, connection.id, platform, baseUrl)
            .then(token => mirrorServerToken(accountId, connection, token))
            .catch(() => {})
    }, [accountId, connection, active, expired])
}

function RealStreamSessionCard({ connection, session, onReauth }: { connection: Connection; session: SessionState; onReauth: () => void }) {
    const privacyOn = useUIStore(s => s.isPrivacyModeEnabled)
    const emailLevel = useUIStore(s => s.privacyLevelEmail)
    const email = connection.credentials?.email
    const expires = tokenExpiresIn(connection.credentials?.expiresAt, Date.now())
    const backend = backendLabel(connection.credentials?.baseUrl, REALSTREAM_DEFAULT_BASE_URL)
    return (
        <SectionCard
            title="Session"
            description="The server refreshes RealStream sessions when it can."
            footer={<Button variant="outline" size="sm" className="h-11 gap-1.5 text-xs sm:h-8" onClick={onReauth}><Key className="h-3.5 w-3.5" />Re-authenticate</Button>}
        >
            <SectionRows>
                <SectionRow label="Signed in as" value={email ? maskEmailLevel(email, privacyOn ? emailLevel : 0) : 'Not recorded'} tone={email ? undefined : 'muted'} />
                <SectionRow label="Token" value={expires?.label || 'No expiry recorded'} tone={expires?.expired ? 'destructive' : expires ? undefined : 'muted'} />
                <SectionRow label="Backend" value={backend.host} mono />
                <SectionRow label="Re-auth" value={session === 'Silent re-auth ready' ? 'Silent, with the saved password' : session} tone={needsReauth(session) ? 'destructive' : undefined} />
            </SectionRows>
        </SectionCard>
    )
}

function StremioLoginCard({ connection, email }: { connection: Connection; email?: string }) {
    const privacyOn = useUIStore(s => s.isPrivacyModeEnabled)
    const emailLevel = useUIStore(s => s.privacyLevelEmail)
    const profileLevel = useUIStore(s => s.privacyLevelProfiles)
    const profile = connection.credentials?.stremioProfileName
    return (
        <SectionCard title="This Stremio login" description="Each Stremio login on this account has its own session.">
            <SectionRows>
                <SectionRow label="Signed in as" value={email ? maskEmailLevel(email, privacyOn ? emailLevel : 0) : 'Not recorded'} tone={email ? undefined : 'muted'} />
                {profile && <SectionRow label="Profile" value={maskProfileLevel(profile, privacyOn ? profileLevel : 0)} />}
                <SectionRow label="Auth key" value={connection.credentials?.authKey ? 'Stored, encrypted in your vault' : 'Not stored'} tone={connection.credentials?.authKey ? undefined : 'destructive'} />
            </SectionRows>
        </SectionCard>
    )
}

export function ConnectionEditPanel({
    accountId,
    connection,
    status,
    lastError,
    lastSync,
    premium,
    premiumState = 'ready',
    onRefreshPremium,
    nuvioMember,
    onBack,
    onShowInstalledAddons,
}: {
    accountId: string
    connection: Connection
    status: ConnectionStatus
    lastError?: string | null
    lastSync?: number
    premium?: PremiumStatus
    premiumState?: StremioMembershipState
    onRefreshPremium?: () => void
    nuvioMember?: NuvioMemberStatus
    onBack: () => void
    onShowInstalledAddons?: () => void
}) {
    const account = useAccountStore(s => s.accounts.find(a => a.id === accountId))
    const { addons } = useAddons(accountId)
    const vaultLocked = !useAuthStore(s => s.encryptionKey)
    const syncing = useConnectionStore(s => s.isSyncing === accountId)
    const failures = useConnectionStore(s => s.connectionStates[accountId]?.[connection.id]?.consecutiveFailures)
    const privacyOn = useUIStore(s => s.isPrivacyModeEnabled)
    const emailLevel = useUIStore(s => s.privacyLevelEmail)
    const urlLevel = useUIStore(s => s.privacyLevelUrls)
    const profileLevel = useUIStore(s => s.privacyLevelProfiles)

    const kind = workspaceKind(connection)
    const isStremio = kind === 'stremio'
    const isNuvio = kind === 'nuvio'
    const isRealStream = kind === 'realstream'
    const isHydra = kind === 'hydra-outbound'
    const enabled = connection.enabled !== false
    const isPrimaryStremio = isStremio && !!account && getStremioConnection(account)?.id === connection.id

    const [tabState, setTab] = useState(DEFAULT_WORKSPACE_TAB)
    const [testing, setTesting] = useState(false)
    const [testResult, setTestResult] = useState<ConnectionTestOutcome | null>(null)
    const [hydraStatus, setHydraStatus] = useState<HydraStatus | null>(null)

    const name = connectionLabel(connection)
    const expiry = tokenExpiry(connection)
    const display = displayStatus(status, expiry)
    const { pill, showLive } = connectionPresentation(enabled, display)
    const session = sessionState(connection, display)
    const reauth = showLive && needsReauth(session)
    const sync = syncSummary(enabled, lastSync, ts => timeAgo(ts))
    const liveError = showLive ? friendlyConnectionError(lastError) || null : null
    const membership = useNuvioMembership(accountId, connection, nuvioMember, isNuvio && enabled)
    useServerTokenMirror(accountId, connection, (isNuvio || isRealStream) && enabled)

    const testDisabledReason = isStremio && vaultLocked ? 'Unlock your vault to test this login.'
        : isStremio && !connection.credentials?.authKey ? 'Sign in first.'
            : kind === 'other' ? 'This connection has no test.' : undefined

    const tabs: WorkspaceTabItem[] = workspaceTabsFor(kind, { supportersProfiles: isStremio && premium?.active === true })
    const tab = resolveWorkspaceTab(tabs, tabState)

    const handleTest = async () => {
        if (testing || testDisabledReason) return
        setTesting(true)
        setTestResult(null)
        try {
            const result = await runConnectionTest(accountId, connection)
            if (result.hydra) setHydraStatus(result.hydra)
            if (result.token) await mirrorServerToken(accountId, connection, result.token)
            setTestResult({ ok: true, message: result.message })
            toast({ title: 'Connection healthy' })
        } catch (err) {
            const message = errMsg(err, 'Connection test failed')
            setTestResult({ ok: false, message })
            toast({ title: 'Connection test failed', description: message, variant: 'destructive' })
        } finally {
            setTesting(false)
        }
    }

    const handleSync = () => {
        if (!enabled || syncing) return
        useConnectionStore.getState().syncConnections(accountId).catch(err => {
            toast({ title: 'Sync failed', description: errMsg(err), variant: 'destructive' })
        })
    }

    const toggleEnabled = () => {
        useConnectionStore.getState().toggleConnection(accountId, connection.id).catch(err => {
            toast({ title: 'Could not change this connection', description: errMsg(err), variant: 'destructive' })
        })
    }

    const email = connection.credentials?.email || (isPrimaryStremio && account ? getAccountEmail(account) : undefined)
    const maskedEmail = email ? maskEmailLevel(email, privacyOn ? emailLevel : 0) : undefined
    const identityParts: string[] = []
    if (isHydra) {
        if (connection.driverConfig?.baseUrl) identityParts.push(maskUrlLevel(connection.driverConfig.baseUrl, privacyOn ? urlLevel : 0))
        identityParts.push('Outbound Hydra target')
    } else {
        if (maskedEmail) identityParts.push(maskedEmail)
        if (isStremio && connection.credentials?.stremioProfileName) identityParts.push(maskProfileLevel(connection.credentials.stremioProfileName, privacyOn ? profileLevel : 0))
        if (isNuvio) identityParts.push(backendLabel(connection.credentials?.baseUrl, NUVIO_DEFAULT_BASE_URL).host)
        if (isRealStream) identityParts.push(backendLabel(connection.credentials?.baseUrl, REALSTREAM_DEFAULT_BASE_URL).host)
    }

    const addonsStat: WorkspaceStat = {
        label: 'Account addons',
        value: String(addons.length),
        sub: 'Recorded in AIOManager',
        onClick: onShowInstalledAddons,
        actionLabel: 'Show installed addons',
    }
    const syncStat: WorkspaceStat = { label: 'Last sync', value: sync.value, sub: sync.sub, tone: enabled ? undefined : 'muted', title: sync.sub }
    const sessionSub = isRealStream ? tokenExpiresIn(connection.credentials?.expiresAt, Date.now())?.label
        : isNuvio ? 'Refreshed by the server'
            : expiry.label || undefined
    const sessionStat: WorkspaceStat = { label: 'Session', value: session, sub: sessionSub, tone: reauth ? 'destructive' : undefined }
    const errorStat: WorkspaceStat = { label: 'Last error', value: !showLive ? 'Not checked' : liveError || 'None', tone: liveError ? 'destructive' : 'muted', title: liveError || undefined, sub: liveError ? 'Details in the status menu' : undefined }
    // The Overview Membership card owns the tier display; a header copy would say it twice.
    const stats: WorkspaceStat[] = isNuvio
        ? [addonsStat, syncStat, sessionStat]
        : isHydra
            ? [addonsStat, syncStat, { label: 'Auth', value: hydraAuthLabel(connection) }, errorStat]
            : [addonsStat, syncStat, sessionStat, errorStat]

    const statusPopover = (
        <>
            <div className="space-y-1">
                <p className="truncate text-sm font-semibold">{name}</p>
                <p className="text-xs text-muted-foreground">{statusSentence(pill, kind)}</p>
            </div>
            <PopoverFacts facts={[
                { label: 'Last sync', value: sync.value },
                { label: 'Session', value: session, tone: reauth ? 'destructive' : undefined },
                ...(showLive && expiry.label ? [{ label: 'Token', value: expiry.label, tone: expiry.state === 'expired' ? 'destructive' as const : expiry.state === 'expiring' ? 'warning' as const : undefined }] : []),
                ...(liveError ? [{ label: 'Last error', value: liveError, tone: 'destructive' as const }] : []),
                ...(testResult ? [{ label: 'Last test', value: testResult.message, tone: testResult.ok ? undefined : 'destructive' as const }] : []),
            ]} />
            <div className="flex flex-wrap gap-2">
                {!enabled ? (
                    <Button size="sm" className="h-9 flex-1 text-xs" data-close-popover onClick={toggleEnabled}><Power className="h-3.5 w-3.5" />Enable</Button>
                ) : reauth ? (
                    <Button size="sm" className="h-9 flex-1 text-xs" data-close-popover onClick={() => setTab('connection')}><Key className="h-3.5 w-3.5" />Re-authenticate</Button>
                ) : (
                    <Button size="sm" variant="outline" className="h-9 flex-1 text-xs" onClick={() => void handleTest()} disabled={testing || !!testDisabledReason}>
                        {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
                        {testing ? 'Testing...' : 'Test'}
                    </Button>
                )}
                <Button size="sm" variant="ghost" className="h-9 text-xs" data-close-popover onClick={() => setTab('connection')}>Connection settings</Button>
            </div>
        </>
    )

    const notice = !enabled ? (
        <WorkspaceNotice icon={<Power className="h-4 w-4" />} title="Connection paused" tone="muted" action={<WorkspaceAction onClick={toggleEnabled}>Enable</WorkspaceAction>}>
            AIOManager skips it during sync. Nothing changes on {name}.
        </WorkspaceNotice>
    ) : reauth ? (
        <WorkspaceNotice icon={<Key className="h-4 w-4" />} title="Sign-in needed" tone="destructive" action={<WorkspaceAction variant="default" onClick={() => setTab('connection')}>Re-authenticate</WorkspaceAction>}>
            This connection can't push until you sign in again.
        </WorkspaceNotice>
    ) : isStremio && vaultLocked ? <VaultLockedNotice /> : undefined

    const header = (
        <WorkspaceHeader
            logo={<PlatformLogo platform={connection.platform} product={connectionLogoProduct(connection)} className="h-12 w-12" isHydra={isHydra} />}
            title={name}
            pill={<WorkspaceStatusPill status={pill}>{statusPopover}</WorkspaceStatusPill>}
            family={isStremio && premium?.active === true ? <StremioSupportersBadge /> : undefined}
            identity={identityParts.join(' · ') || undefined}
            actions={<>
                {kind !== 'other' && (
                    <Tooltip content={testDisabledReason} disabled={!testDisabledReason}>
                        <WorkspaceAction onClick={() => void handleTest()} disabled={testing || !!testDisabledReason} aria-busy={testing}>
                            {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
                            {testing ? 'Testing...' : 'Test'}
                        </WorkspaceAction>
                    </Tooltip>
                )}
                <Tooltip content="Enable this connection to sync it." disabled={enabled}>
                    <WorkspaceAction onClick={handleSync} disabled={syncing || !enabled}>
                        <RefreshCw className={cn('h-3.5 w-3.5', syncing && 'animate-spin')} />
                        {syncing ? 'Syncing...' : 'Sync'}
                    </WorkspaceAction>
                </Tooltip>
                <WorkspaceMoreMenu label={`More actions for ${name}`}>
                    <DropdownMenuItem className="gap-2 text-xs" onClick={() => setTab('connection')}><Key className="h-3.5 w-3.5" />Connection settings</DropdownMenuItem>
                    <DropdownMenuItem className="gap-2 text-xs" onClick={toggleEnabled}><Power className="h-3.5 w-3.5" />{enabled ? 'Disable connection' : 'Enable connection'}</DropdownMenuItem>
                    <DropdownMenuItem destructive className="gap-2 text-xs" onClick={() => setTab('connection')}><Trash2 className="h-3.5 w-3.5" />Remove connection…</DropdownMenuItem>
                </WorkspaceMoreMenu>
            </>}
            notice={notice}
            stats={stats}
        />
    )

    const health = (
        <ConnectionHealthCard
            kind={kind}
            pill={pill}
            showLive={showLive}
            sync={sync}
            failures={failures}
            lastError={liveError}
            testing={testing}
            testResult={testResult}
            onTest={kind === 'other' ? undefined : () => void handleTest()}
            testDisabledReason={testDisabledReason}
        />
    )

    return (
        <div className="space-y-4">
            <ToolbarShell className="w-fit max-w-full p-2" contentClassName="gap-2">
                <Button variant="ghost" size="sm" className="h-11 shrink-0 gap-1.5 rounded-xl border border-border/40 bg-card px-2.5 text-xs font-medium text-muted-foreground shadow-sm hover:bg-muted/50 hover:text-foreground sm:h-8" onClick={onBack}>
                    <ArrowLeft className="h-4 w-4" />
                    Connections
                </Button>
            </ToolbarShell>

            <WorkspaceTabs label={`${name} workspace`} tabs={tabs} value={tab} onValueChange={setTab} header={header}>
                <TabsContent value="overview">
                    {isNuvio ? (
                        <NuvioOverview accountId={accountId} connection={connection} status={status} session={session} membership={membership} onOpenTab={setTab} health={health} />
                    ) : (
                        <div className="grid gap-4 lg:grid-cols-2">
                            {isStremio && (
                                <StremioMembershipCard
                                    premium={premium}
                                    state={!isPrimaryStremio ? 'not-primary' : vaultLocked && !premium ? 'locked' : premiumState}
                                    onRefresh={onRefreshPremium}
                                />
                            )}
                            {isRealStream && <RealStreamSessionCard connection={connection} session={session} onReauth={() => setTab('connection')} />}
                            {isHydra && <HydraEndpointCard connection={connection} status={hydraStatus} onTest={() => void handleTest()} testing={testing} />}
                            {health}
                            {isStremio && <StremioLoginCard connection={connection} email={email} />}
                        </div>
                    )}
                </TabsContent>

                <TabsContent value="connection">
                    <div className="space-y-4">
                        {isStremio && vaultLocked && <VaultLockedNotice />}
                        {isStremio && (
                            <>
                                <StremioCredentialsSection accountId={accountId} connection={connection} />
                                <StremioDangerZoneSection accountId={accountId} connection={connection} />
                            </>
                        )}
                        {isNuvio && <NuvioCredentialsSection accountId={accountId} connection={connection} />}
                        {isRealStream && <RealStreamCredentialsSection accountId={accountId} connection={connection} />}
                        {isHydra && <HydraCredentialsSection accountId={accountId} connection={connection} />}
                        <RemoveConnectionSection accountId={accountId} connection={connection} onBack={onBack} />
                    </div>
                </TabsContent>

                {isStremio && premium?.active && (
                    <TabsContent value="profiles">
                        {vaultLocked
                            ? <VaultLockedNotice>Unlock your vault to load this login's Supporters profiles.</VaultLockedNotice>
                            : <SupportersProfilesRoster accountId={accountId} connection={connection} />}
                    </TabsContent>
                )}
                {isStremio && (
                    <TabsContent value="library">
                        <StremioLibrarySection accountId={accountId} error={liveError} />
                    </TabsContent>
                )}

                {isNuvio && (
                    <>
                        <TabsContent value="profiles">
                            <NuvioProfilesTab accountId={accountId} connection={connection} status={status} />
                        </TabsContent>
                        <TabsContent value="plugins">
                            <NuvioPluginsTab accountId={accountId} connection={connection} />
                        </TabsContent>
                        <TabsContent value="library">
                            <NuvioLibraryTab accountId={accountId} connection={connection} />
                        </TabsContent>
                        <TabsContent value="collections">
                            <NuvioCollectionsTab accountId={accountId} connection={connection} />
                        </TabsContent>
                        <TabsContent value="backup">
                            <NuvioBackupTab accountId={accountId} connection={connection} />
                        </TabsContent>
                    </>
                )}
            </WorkspaceTabs>
        </div>
    )
}
