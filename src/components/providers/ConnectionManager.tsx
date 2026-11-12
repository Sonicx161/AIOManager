import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, useAltArrowHistory, useDialogBack } from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { WorkspaceTabs } from '@/components/ui/workspace-tabs'
import { Tooltip } from '@/components/ui/tooltip'
import { StatusChip } from '@/components/ui/status-chip'
import { EmptyState } from '@/components/common/EmptyState'
import { ProviderSetupDialog } from '@/components/providers/ProviderSetupDialog'
import { NuvioSetupDialog, type NuvioBackend } from '@/components/providers/NuvioSetupDialog'
import { RealStreamSetupDialog, type RealStreamTokens } from '@/components/providers/RealStreamSetupDialog'
import { JellyfinSetupDialog } from './JellyfinSetupDialog'
import { StremioSetupDialog, type StremioSignIn } from './StremioSetupDialog'
import { HouseholdSetupDialog } from './HouseholdSetupDialog'
import { WatchMigrationPicker } from './WatchMigrationPicker'
import { isAIOStreamsAddon } from '@/lib/aiostreams-utils'
import { JellyfinConnectionPanel } from './JellyfinConnectionPanel'
import { validateJellyfinReconnect, type JellyfinSession } from '@/lib/jellyfin/session'
import { openJellyfinSecret, sealJellyfinSecret } from '@/lib/jellyfin/connection-data'
import { decrypt, encrypt } from '@/lib/crypto'
import { ApiKeyManager } from '@/components/providers/ApiKeyManager'
import { useConnectionStore } from '@/store/connectionStore'
import { useUIStore } from '@/store/uiStore'
import { useAuthStore } from '@/store/authStore'
import { getAccountEmail, getAccountById, getStremioAuthKey, getStremioConnection, getCachedAuthKey, useAccountStore } from '@/store/accountStore'
import { maskEmailLevel, maskNameLevel, maskProfileLevel } from '@/lib/utils'
import { storedNuvioTargetId } from './nuvio-sync-target'
import { parsePremiumExpire, type PremiumStatus } from '@/lib/stremio-premium'
import { parseNuvioMemberAccess, type NuvioMemberStatus } from '@/lib/nuvio-tier'
import { trace } from '@/lib/trace'
import { cachedRead, isDisplayCacheFresh, peekDisplayCache } from '@/lib/display-read-cache'
import { getUserCached } from '@/lib/stremio-user-cache'
import { toast } from '@/hooks/use-toast'
import { findResignTarget } from '@/lib/connection-identity'
import { useShallow } from 'zustand/react/shallow'
import { isAddonConnection, type Connection } from '@/types/connection'
import type { Account } from '@/types/account'
import type { HydraDriverConfig } from '@/types/provider'
import { RefreshCw, Plus, Zap, Link2, Key, ChevronRight, Users, History } from 'lucide-react'
import { useState, useEffect, useCallback, useRef } from 'react'
import { countActiveConnections } from './connection-state'
import { cn } from '@/lib/utils'
import { PLATFORM_REGISTRY } from '@/lib/platform-registry'
import type { HydraSubscriber } from '@/api/hydra-providers'
import { stremioClient } from '@/api/stremio-client'
import { PlatformLogo } from './ConnectionPrimitives'
import { ConnectionCard } from './ConnectionCard'
import { ConnectionEditPanel } from './ConnectionEditPanel'
import { SubscriberCard } from './SubscriberCard'
import { HydraPullPanel } from './HydraPullPanel'
import { workspaceKind } from './workspace/workspace-model'
import { nuvioMembershipCacheKey } from './NuvioOverview'
import { NuvioTierBadge, StremioSupportersBadge, type StremioMembershipState } from './ConnectionMembershipTab'

interface ConnectionManagerProps {
    accountId: string
    account?: Account
    connections?: Connection[]
    /** 'sheet' renders the compact in-sheet tabs without the workspace panel; default 'panel'. */
    variant?: 'sheet' | 'panel'
    onShowInstalledAddons?: () => void
    /** Open the edit panel for this connection on next change (nonce lets the same id re-open). */
    focusEditConnection?: { id: string; nonce: number } | null
}

export function ConnectionManager({ accountId, account, connections = [], onShowInstalledAddons, focusEditConnection, variant = 'panel' }: ConnectionManagerProps) {
    const { syncConnections, isSyncing, connectionStates, addConnection, refreshConnectionStates } = useConnectionStore(
        useShallow(s => ({
            syncConnections: s.syncConnections,
            isSyncing: s.isSyncing,
            connectionStates: s.connectionStates,
            addConnection: s.addConnection,
            refreshConnectionStates: s.refreshConnectionStates,
        }))
    )
    const [addDialogOpen, setAddDialogOpen] = useState(false)
    const [hydraDialogOpen, setHydraDialogOpen] = useState(false)
    const [nuvioDialogOpen, setNuvioDialogOpen] = useState(false)
    const [realstreamDialogOpen, setRealstreamDialogOpen] = useState(false)
    const [jellyfinDialogOpen, setJellyfinDialogOpen] = useState(false)
    const [stremioDialogOpen, setStremioDialogOpen] = useState(false)
    const [personSaving, setPersonSaving] = useState(false)
    const [jellyfinReconnectId, setJellyfinReconnectId] = useState<string | null>(null)
    const [subscribers, setSubscribers] = useState<HydraSubscriber[]>([])
    const [editingId, setEditingId] = useState<string | null>(null)
    const [openSubscriber, setOpenSubscriber] = useState<string | null>(null)
    const [premiumPhase, setPremiumPhase] = useState<StremioMembershipState>('loading')
    const [premiumNonce, setPremiumNonce] = useState(0)
    const [subTab, setSubTab] = useState('connections')
    const [premiumByAccount, setPremiumByAccount] = useState<Map<string, PremiumStatus>>(new Map())
    const [nuvioMemberByConnection, setNuvioMemberByConnection] = useState<Map<string, NuvioMemberStatus>>(new Map())
    const premiumFetchedAccounts = useRef(new Set<string>())
    const nuvioMemberFetchedConnections = useRef(new Set<string>())
    const accountStates = connectionStates[accountId] || {}
    const isPrivacyModeEnabled = useUIStore(s => s.isPrivacyModeEnabled)
    const privacyLevelEmail = useUIStore(s => s.privacyLevelEmail)
    const privacyLevelNames = useUIStore(s => s.privacyLevelNames)
    const privacyLevelProfiles = useUIStore(s => s.privacyLevelProfiles)
    const emailPrivacyLevel = isPrivacyModeEnabled ? privacyLevelEmail : 0
    const namePrivacyLevel = isPrivacyModeEnabled ? privacyLevelNames : 0
    const storeAccount = useAccountStore(s => getAccountById(s.accounts, accountId))
    const statusAccount = account ?? storeAccount
    const encryptionKeyFromStore = useAuthStore(s => s.encryptionKey)

    // Pull live connection status (last sync, errors, expiry-driven state) so the cards can show it
    // without waiting for the next manual sync. Best-effort; the store swallows failures.
    useEffect(() => {
        refreshConnectionStates(accountId)
    }, [accountId, refreshConnectionStates])

    useEffect(() => {
        if (focusEditConnection) openConnectionPanel(focusEditConnection.id, null)
    }, [focusEditConnection])

    useEffect(() => {
        let cancelled = false
        import('@/api/hydra-providers')
            .then(({ fetchSubscribers }) => fetchSubscribers(accountId))
            .then(subs => { if (!cancelled) setSubscribers(subs) })
            .catch(() => { })
        return () => { cancelled = true }
    }, [accountId])

    useEffect(() => {
        if (!statusAccount) return
        const stremioKey = getStremioAuthKey(statusAccount)
        if (!stremioKey) {
            trace('connections', 'premium.skip', { accountId, reason: 'no-stremio-key' })
            return
        }
        if (premiumFetchedAccounts.current.has(accountId)) return
        const { encryptionKey } = useAuthStore.getState()
        if (!encryptionKey) {
            trace('connections', 'premium.skip', { accountId, reason: 'locked' })
            setPremiumPhase('locked')
            return
        }
        let cancelled = false
        premiumFetchedAccounts.current.add(accountId)
        setPremiumPhase('loading')
        ;(async () => {
            const authKey = await getCachedAuthKey(stremioKey, encryptionKey)
            // Shared GetUser cache (#33): keyed per auth key, 60 s TTL, single-flight.
            // The explicit Test path in runConnectionTest bypasses it.
            const user = await getUserCached(authKey, key => stremioClient.getUser(key))
            const status = parsePremiumExpire(user.premium_expire)
            trace('connections', 'premium.result', { accountId, active: status.active, lifetime: status.lifetime, expiresAt: status.expiresAt, cancelled })
            // Write unconditionally: a cancelled-effect skip would strand the result behind the dedupe marker.
            setPremiumByAccount(prev => new Map(prev).set(accountId, status))
            setPremiumPhase('ready')
        })().catch(err => {
            // A failed fetch must not latch: release the dedupe marker so the next mount retries.
            premiumFetchedAccounts.current.delete(accountId)
            setPremiumPhase('error')
            trace('connections', 'premium.error', { accountId, error: err instanceof Error ? err.message : String(err) })
        })
        return () => { cancelled = true }
    }, [accountId, statusAccount, encryptionKeyFromStore, premiumNonce])

    const refreshPremium = useCallback(() => {
        premiumFetchedAccounts.current.delete(accountId)
        setPremiumNonce(n => n + 1)
    }, [accountId])

    useEffect(() => {
        if (!statusAccount) return
        const nuvioConns = connections.filter(c => c.enabled && workspaceKind(c) === 'nuvio')
        if (nuvioConns.length === 0) return
        let cancelled = false
        ;(async () => {
            const [{ fetchConnectionToken }, { nuvioDriverFor }, { getCachedNuvioToken, setCachedNuvioToken }] = await Promise.all([
                import('@/api/connection'),
                import('@/lib/drivers/factory'),
                import('@/lib/nuvio-token-cache'),
            ])
            for (const conn of nuvioConns) {
                if (cancelled) return
                if (nuvioMemberFetchedConnections.current.has(conn.id)) continue
                // Grid membership shares the workspace's cached read (#32): inside the
                // TTL a revisit paints the badge with 0 requests; a stale entry paints
                // first and one background read revalidates it. Keyed per connection
                // identity and cleared on vault lock and logout.
                const cacheKey = nuvioMembershipCacheKey(accountId, conn)
                const cached = peekDisplayCache<unknown>(cacheKey)
                if (cached) {
                    setNuvioMemberByConnection(prev => new Map(prev).set(conn.id, parseNuvioMemberAccess(cached.value)))
                    if (isDisplayCacheFresh(cached)) {
                        nuvioMemberFetchedConnections.current.add(conn.id)
                        continue
                    }
                }
                nuvioMemberFetchedConnections.current.add(conn.id)
                try {
                    const rows = await cachedRead(cacheKey, async () => {
                        let token = getCachedNuvioToken(conn.id)
                        if (!token) {
                            token = await fetchConnectionToken(accountId, conn.id, 'nuvio', conn.credentials?.baseUrl)
                            setCachedNuvioToken(conn.id, token)
                        }
                        return nuvioDriverFor(conn).getMemberAccess(token.accessToken)
                    })
                    const status = parseNuvioMemberAccess(rows)
                    trace('connections', 'nuvioMember.result', { connectionId: conn.id, supporter: status.supporter, label: status.label, cancelled })
                    // Written unconditionally (like the premium effect): deps churn cancels the
                    // effect mid-fetch, but the result is still the freshest data for this connection.
                    setNuvioMemberByConnection(prev => new Map(prev).set(conn.id, status))
                } catch (err) {
                    // A failed fetch must not latch: release the dedupe marker so the next mount retries.
                    nuvioMemberFetchedConnections.current.delete(conn.id)
                    trace('connections', 'nuvioMember.error', { connectionId: conn.id, error: err instanceof Error ? err.message : String(err) })
                }
            }
        })().catch(() => { })
        return () => { cancelled = true }
    }, [accountId, statusAccount, connections])

    const handleRemoveSubscriber = useCallback(async (name: string) => {
        let snapshot: HydraSubscriber[] = []
        setSubscribers(prev => { snapshot = prev; return prev.filter(s => s.name !== name) })
        try {
            const { deleteSubscriber } = await import('@/api/hydra-providers')
            await deleteSubscriber(accountId, name)
        } catch (err) {
            setSubscribers(snapshot)
            toast({ title: 'Could not remove app', description: err instanceof Error ? err.message : 'Try again.', variant: 'destructive' })
        }
    }, [accountId])

    const resolvedConnections = connections
    const activeCount = countActiveConnections(resolvedConnections, id => accountStates[id]?.status)

    const handleSync = async () => {
        await syncConnections(accountId)
    }

    const handleAddNative = (platform: string) => {
        addConnection(accountId, {
            platform,
            connectionType: 'native',
            enabled: true,
            status: 'error',
            credentials: {},
            capabilities: platform === 'nuvio' ? ['addons', 'plugins', 'profiles'] : ['addons'],
        })
        setAddDialogOpen(false)
    }

    const handlePlatformClick = (platform: string) => {
        if (platform === 'jellyfin') {
            setAddDialogOpen(false)
            setJellyfinReconnectId(null)
            setJellyfinDialogOpen(true)
        } else if (platform === 'stremio') {
            // Verified sign-in only: a placeholder "needs sign-in" Stremio connection can
            // no longer be created, and several Stremio logins may be bound to one account.
            setAddDialogOpen(false)
            setStremioDialogOpen(true)
        } else if (platform === 'nuvio') {
            setAddDialogOpen(false)
            setNuvioDialogOpen(true)
        } else if (platform === 'realstream') {
            setAddDialogOpen(false)
            setRealstreamDialogOpen(true)
        } else if (platform === 'hydra-outbound') {
            setAddDialogOpen(false)
            setHydraDialogOpen(true)
        } else {
            handleAddNative(platform)
        }
    }

    const handleJellyfinComplete = async (session: JellyfinSession) => {
        const key = useAuthStore.getState().encryptionKey
        if (!key) throw new Error('Unlock your vault before saving a connection')
        const existing = jellyfinReconnectId ? resolvedConnections.find(c => c.id === jellyfinReconnectId) : undefined
        if (jellyfinReconnectId && !existing) throw new Error('This connection was removed. Add a new connection instead.')
        if (existing) {
            const previous = existing.credentials?.jellyfin
                ? await openJellyfinSecret(existing, value => decrypt(value, key)).catch(() => undefined) : undefined
            validateJellyfinReconnect(existing, session, previous)
        }
        const credentials = await sealJellyfinSecret(session.secret, value => encrypt(value, key))
        if (useAuthStore.getState().encryptionKey !== key) throw new Error('Your vault changed while saving. Unlock it and try again.')
        const data = { credentials, mediaServer: { ...session.identity, serverId: session.identity.serverId || existing?.mediaServer?.serverId }, status: 'active' as const,
            displayName: session.identity.productName, lastError: undefined, lastErrorAt: undefined }
        if (existing) await useConnectionStore.getState().updateConnection(accountId, existing.id, data)
        else await addConnection(accountId, { ...data, platform: 'jellyfin', connectionType: 'native', enabled: true, capabilities: [] })
    }

    // Verified Stremio sign-in from StremioSetupDialog. Seals the key per connection;
    // a legacy account that still keeps its login only in account.authKey gets that
    // login materialized as the canonical connection FIRST so the existing session
    // stays primary and the new login binds as a true secondary.
    const handleStremioComplete = async (signIn: StremioSignIn) => {
        const key = useAuthStore.getState().encryptionKey
        if (!key) throw new Error('Unlock your vault before saving a connection')
        const account = useAccountStore.getState().accounts.find(a => a.id === accountId)
        if (!account) throw new Error('This account no longer exists. Reload and add the connection again.')
        const hasStoredStremio = (account.connections || []).some(c => c.platform === 'stremio')
        if (!hasStoredStremio && account.authKey && account.authKey.length > 60) {
            await addConnection(accountId, {
                platform: 'stremio',
                connectionType: 'native',
                enabled: true,
                status: 'active',
                credentials: { authKey: account.authKey, ...(account.email ? { email: account.email } : {}) },
                capabilities: ['addons'],
            })
            // Vault generation through the asynchronous materialization: re-check before
            // sealing the NEW login so a vault rotated mid-add never persists a stale-key blob.
            if (useAuthStore.getState().encryptionKey !== key) throw new Error('Your vault changed while saving. Unlock it and try again.')
        }
        const sealed = await encrypt(signIn.authKey, key)
        // Vault generation through the asynchronous claim: the sealed blob must land
        // under the SAME vault the dialog verified against, so re-check before the add.
        if (useAuthStore.getState().encryptionKey !== key) throw new Error('Your vault changed while saving. Unlock it and try again.')
        await addConnection(accountId, {
            platform: 'stremio',
            connectionType: 'native',
            enabled: true,
            status: 'active',
            credentials: {
                authKey: sealed,
                ...(signIn.email ? { email: signIn.email } : {}),
                // Verified remote identity: duplicate binding detection and per-connection
                // attribution key on the user Stremio actually authenticated, not the key blob.
                ...(signIn.userId ? { userId: signIn.userId } : {}),
            },
            capabilities: ['addons'],
        })
        useConnectionStore.getState().syncConnections(accountId).catch(() => {})
    }

    const handleHydraComplete = async (config: HydraDriverConfig, credential: string) => {
        await addConnection(accountId, {
            platform: config.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
            connectionType: 'hydra-outbound',
            enabled: true,
            status: 'active',
            credentials: { apiKey: credential },
            capabilities: ['addons'],
            driverConfig: config,
        })
    }

    // Adding is always additive: reconnecting an existing login is a per-connection
    // edit (ConnectionEditPanel), never a second sign-in that overwrites the first.
    // A setup-dialog sign-in for a login the account already binds refreshes THAT
    // connection in place (same id, same incarnation), so its server credential
    // updates where the token fetch reads it instead of under a fresh id.
    const errMsg = (e: unknown, fallback = 'Try again.') => (e instanceof Error ? e.message : fallback)
    const refreshResignedConnection = async (
        resign: Connection,
        credentials: Record<string, string>,
        platform: 'nuvio' | 'realstream',
    ) => {
        await useConnectionStore.getState().updateConnection(accountId, resign.id, { credentials, status: 'active' })
        const { storeConnectionCredential } = await import('@/api/hydra-providers')
        try {
            await storeConnectionCredential(accountId, resign.id, credentials, platform, resign.generation)
        } catch (err) {
            toast({ title: 'Saved locally, but the server did not store the new session', description: errMsg(err), variant: 'destructive' })
        }
        toast({ title: platform === 'nuvio' ? 'Nuvio session refreshed' : 'RealStream session refreshed' })
        useConnectionStore.getState().syncConnections(accountId).catch(() => {})
    }

    const handleNuvioComplete = async (tokens: { accessToken: string; refreshToken: string; expiresAt: number }, profileId: string | null, _profiles: unknown[], email: string, backend: NuvioBackend) => {
        const effBackendCreds: Record<string, string> = {
            ...(backend.baseUrl ? { baseUrl: backend.baseUrl } : {}),
            ...(backend.publishableKey ? { publishableKey: backend.publishableKey } : {}),
        }
        const credentials = {
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            expiresAt: String(tokens.expiresAt),
            profileId: profileId || '',
            // The sign-in email labels THIS login on its card: with several Nuvio
            // logins bound, exact edit/reconnect/remove must be human-identifiable.
            ...(email ? { email } : {}),
            ...effBackendCreds,
        }
        const resign = findResignTarget(resolvedConnections, {
            platform: 'nuvio',
            email,
            profileId,
            baseUrl: backend.baseUrl || null,
        })
        if (resign) {
            await refreshResignedConnection(resign, { ...resign.credentials, ...credentials }, 'nuvio')
            return
        }
        await addConnection(accountId, {
            platform: 'nuvio',
            connectionType: 'native',
            enabled: true,
            status: 'active',
            credentials,
            capabilities: ['addons', 'plugins', 'profiles'],
        })
    }

    const handleRealStreamComplete = async (tokens: RealStreamTokens, email: string, password: string) => {
        const credentials = {
            accessToken: tokens.accessToken,
            userId: tokens.userId || '',
            expiresAt: String(tokens.expiresAt),
            // Stored E2E-encrypted so the server can silently re-authenticate if the token expires.
            email,
            password,
        }
        const resign = findResignTarget(resolvedConnections, {
            platform: 'realstream',
            email,
            userId: tokens.userId || null,
        })
        if (resign) {
            await refreshResignedConnection(resign, { ...resign.credentials, ...credentials }, 'realstream')
            return
        }
        await addConnection(accountId, {
            platform: 'realstream',
            connectionType: 'native',
            enabled: true,
            status: 'active',
            credentials,
            capabilities: ['addons'],
        })
    }

    // Setup dialogs reset their own wizard state before invoking this.
    const backToPicker = (closeDialog: (open: boolean) => void) => () => {
        closeDialog(false)
        setAddDialogOpen(true)
    }

    const renderSetupDialogs = () => (
        <>
            {jellyfinDialogOpen && <JellyfinSetupDialog
                accountId={accountId}
                onBackToPicker={jellyfinReconnectId ? undefined : backToPicker(setJellyfinDialogOpen)}
                open={jellyfinDialogOpen}
                reconnectCredentials={jellyfinReconnectId ? resolvedConnections.find(c => c.id === jellyfinReconnectId)?.credentials?.jellyfin : undefined}
                onOpenChange={open => { setJellyfinDialogOpen(open); if (!open) setJellyfinReconnectId(null) }}
                onComplete={handleJellyfinComplete}
            />}
            {stremioDialogOpen && <StremioSetupDialog
                accountId={accountId}
                open={stremioDialogOpen}
                onOpenChange={open => { setStremioDialogOpen(open) }}
                onComplete={handleStremioComplete}
                onBackToPicker={backToPicker(setStremioDialogOpen)}
            />}
            <ProviderSetupDialog
                open={hydraDialogOpen}
                onOpenChange={(open) => { setHydraDialogOpen(open) }}
                onComplete={handleHydraComplete}
                onBackToPicker={backToPicker(setHydraDialogOpen)}
            />
            <NuvioSetupDialog
                open={nuvioDialogOpen}
                onOpenChange={(open) => { setNuvioDialogOpen(open) }}
                onComplete={handleNuvioComplete}
                onBackToPicker={backToPicker(setNuvioDialogOpen)}
                initialBackend={(() => {
                    const existing = resolvedConnections.find(c => c.platform === 'nuvio')
                    return existing ? { baseUrl: existing.credentials?.baseUrl, publishableKey: existing.credentials?.publishableKey } : undefined
                })()}
            />
            <RealStreamSetupDialog
                open={realstreamDialogOpen}
                onOpenChange={(open) => { setRealstreamDialogOpen(open) }}
                onComplete={handleRealStreamComplete}
                onBackToPicker={backToPicker(setRealstreamDialogOpen)}
            />
        </>
    )

    const editing = editingId ? resolvedConnections.find(c => c.id === editingId) : null
    const openedSubscriber = !editing && openSubscriber ? subscribers.find(sub => sub.name === openSubscriber) : undefined
    // In the Edit Account sheet, Escape on an open connection returns to the list before leaving Connections.
    // The popped panel joins a bounded forward stack; a new panel push clears it (the shared sheet model).
    const panelOpen = !!editing || !!openedSubscriber
    const [panelForward, setPanelForward] = useState<Array<{ editingId: string | null; openSubscriber: string | null }>>([])
    const openConnectionPanel = (nextEditingId: string | null, nextSubscriber: string | null) => {
        setPanelForward([])
        setEditingId(nextEditingId)
        setOpenSubscriber(nextSubscriber)
    }
    const panelBack = () => {
        setPanelForward(prev => [{ editingId, openSubscriber }, ...prev].slice(0, 12))
        setEditingId(null)
        setOpenSubscriber(null)
    }
    const panelForwardTo = () => {
        const head = panelForward[0]
        if (!head) return
        setEditingId(head.editingId)
        setOpenSubscriber(head.openSubscriber)
        setPanelForward(prev => prev.slice(1))
    }
    useDialogBack(panelOpen, panelBack)
    // Alt+Left/Right history inside the Edit Account sheet only (the shared
    // keyboard model). Stays registered while a Forward entry exists, so the
    // popped list still answers Alt+Right.
    useAltArrowHistory(variant === 'sheet' && (panelOpen || panelForward.length > 0), panelOpen, panelForward.length > 0, panelBack, panelForwardTo)
    // Opening a panel unmounts the pressed card and closing unmounts the focused
    // control: move focus to whichever container is mounted so Escape keeps working.
    const listRef = useRef<HTMLDivElement>(null)
    const panelRef = useRef<HTMLDivElement>(null)
    const wasPanelOpen = useRef(panelOpen)
    useEffect(() => {
        if (wasPanelOpen.current && !panelOpen) listRef.current?.focus({ preventScroll: true })
        if (!wasPanelOpen.current && panelOpen) panelRef.current?.focus({ preventScroll: true })
        wasPanelOpen.current = panelOpen
    }, [panelOpen])
    // Sheet-only phone polish: the tab strip is its own scrollable row, so keep the
    // active tab scrolled into view and fade only the edges that hide more tabs.
    // Desktop lays the strip and the actions on one line inside the fixed-width
    // dialog and never overflows, so the fades never mount there.
    const sheetTabListRef = useRef<HTMLDivElement>(null)
    const [tabFades, setTabFades] = useState({ left: false, right: false })
    const updateTabFades = useCallback(() => {
        const el = sheetTabListRef.current
        if (!el) return
        const left = el.scrollLeft > 1
        const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1
        setTabFades(prev => (prev.left === left && prev.right === right) ? prev : { left, right })
    }, [])
    useEffect(() => {
        const el = sheetTabListRef.current
        if (!el) return
        const active = el.querySelector<HTMLElement>('[role=tab][data-state=active]')
        if (active) {
            const target = active.offsetLeft - (el.clientWidth - active.offsetWidth) / 2
            el.scrollTo({ left: Math.max(0, Math.min(target, el.scrollWidth - el.clientWidth)) })
        }
        updateTabFades()
    }, [subTab, updateTabFades])
    useEffect(() => {
        window.addEventListener('resize', updateTabFades)
        return () => window.removeEventListener('resize', updateTabFades)
    }, [updateTabFades])
    const hasAny = resolvedConnections.length > 0 || subscribers.length > 0
    const hasApiKeyTab = !!statusAccount?.apiKey
    // Media-server connections never take addon pushes (isAddonConnection excludes jellyfin),
    // so a media-only or fully paused account has nothing to sync. Explain the disabled Sync
    // instead of leaving it silent.
    const syncBlockedReason = resolvedConnections.some(c => c.enabled && isAddonConnection(c))
        ? ''
        : 'Nothing to sync yet — enable an addon connection such as Stremio or Nuvio'

    const connectionActions = <>
                    <Tooltip content={syncBlockedReason} disabled={!!isSyncing || !syncBlockedReason} className="max-w-[min(20rem,calc(100vw-2rem))] whitespace-normal leading-relaxed">
                        <Button
                            variant="outline"
                            size="sm"
                            className={cn('gap-1.5 h-8 text-xs font-medium', syncBlockedReason && 'cursor-not-allowed opacity-50 active:scale-100')}
                            onClick={() => { if (!syncBlockedReason) void handleSync() }}
                            disabled={!!isSyncing}
                            aria-disabled={syncBlockedReason ? true : undefined}
                        >
                            <RefreshCw className={cn('h-3.5 w-3.5', isSyncing && 'animate-spin')} />
                            {isSyncing ? 'Syncing...' : 'Sync'}
                        </Button>
                    </Tooltip>
                    <Button
                        size="sm"
                        className="gap-1.5 h-8 text-xs font-medium"
                        onClick={() => setAddDialogOpen(true)}
                    >
                        <Plus className="h-3.5 w-3.5" />
                        Add Connection
                    </Button>
    </>
    // In the sheet the header row shares space with the scrolling tab strip, so
    // Sync collapses to one labelled 36px icon button.
    const sheetConnectionActions = <>
                    <Tooltip content={syncBlockedReason} disabled={!!isSyncing || !syncBlockedReason} className="max-w-[min(20rem,calc(100vw-2rem))] whitespace-normal leading-relaxed">
                        <Button
                            variant="outline"
                            size="icon"
                            className={cn(syncBlockedReason && 'cursor-not-allowed opacity-50 active:scale-100')}
                            onClick={() => { if (!syncBlockedReason) void handleSync() }}
                            disabled={!!isSyncing}
                            aria-disabled={syncBlockedReason ? true : undefined}
                            aria-label={isSyncing ? 'Syncing connections' : 'Sync connections'}
                        >
                            <RefreshCw className={cn('h-4 w-4', isSyncing && 'animate-spin')} />
                        </Button>
                    </Tooltip>
                    <Button
                        size="sm"
                        className="gap-1.5 h-8 text-xs font-medium"
                        onClick={() => setAddDialogOpen(true)}
                    >
                        <Plus className="h-3.5 w-3.5" />
                        Add Connection
                    </Button>
    </>
    const connectionsList = (
        <div className="space-y-4">
            <p className="min-w-0 text-xs leading-relaxed text-muted-foreground">
                {activeCount} of {resolvedConnections.length} connection{resolvedConnections.length === 1 ? '' : 's'} active{subscribers.length > 0 ? ` · ${subscribers.length} app${subscribers.length === 1 ? '' : 's'}` : ''}. Each connection has its own sign-in. Add several accounts or servers from the same platform.
            </p>

            {!hasAny ? (
                <EmptyState
                    icon={<Zap className="h-6 w-6" />}
                    title="No connections yet"
                    description="Connect an addon platform or a media server."
                    action={
                        <Button size="sm" className="gap-1.5" onClick={() => setAddDialogOpen(true)}>
                            <Plus className="h-3.5 w-3.5" />
                            Add Connection
                        </Button>
                    }
                />
            ) : (
                <div className="space-y-3">
                    <div className="space-y-2">
                        {resolvedConnections.map(conn => {
                            const state = conn.platform === 'jellyfin' ? undefined : accountStates[conn.id]
                            // The live state entry is authoritative while present: its
                            // lastError: null means the error is CLEARED (the stored
                            // connection copy must not resurrect it) and lastSync: 0
                            // means never synced. Only fall back to the stored fields
                            // when there is no live entry at all.
                            const liveStatus = state ? state.status : conn.status
                            const liveLastSync = state ? state.lastSync : conn.lastSync
                            const liveLastError = state ? state.lastError : (conn.lastError ?? null)
                            const kind = workspaceKind(conn)
                            const needsSignIn = (kind === 'stremio' && !conn.credentials?.authKey)
                                || (kind === 'jellyfin' && !conn.credentials?.jellyfin)
                            // Account-level identity (email, premium) belongs to the
                            // CANONICAL Stremio login only; every other login shows its
                            // OWN bound identity so same-platform cards stay human-identifiable
                            // (exact edit/reconnect/remove per login). displayName covers
                            // logins whose platform stores no email (e.g. labeled Nuvio).
                            const isPrimaryStremio = kind === 'stremio' && !!statusAccount && getStremioConnection(statusAccount)?.id === conn.id
                            const connIdentityRaw = conn.mediaServer?.userName
                                || conn.credentials?.email
                                || (conn.connectionType !== 'hydra-outbound' ? conn.displayName : undefined)
                                || (isPrimaryStremio && account ? getAccountEmail(account) : undefined)
                            const connIsEmail = !!connIdentityRaw?.includes('@')
                            const maskedConnIdentity = connIdentityRaw
                                ? (connIsEmail ? maskEmailLevel(connIdentityRaw, emailPrivacyLevel) : maskNameLevel(connIdentityRaw, namePrivacyLevel))
                                : undefined
                            const connEmail = maskedConnIdentity
                            const customLabel = conn.displayName && conn.displayName !== connIdentityRaw
                                && conn.displayName.toLowerCase() !== conn.platform.toLowerCase()
                                ? maskNameLevel(conn.displayName, namePrivacyLevel) : undefined
                            const nuvioTarget = kind === 'nuvio'
                                ? storedNuvioTargetId({ ...conn, activeProfileId: statusAccount?.activeProfileId }) : undefined
                            const profileLabel = kind === 'nuvio'
                                ? nuvioTarget ? `Profile ${maskProfileLevel(nuvioTarget, isPrivacyModeEnabled ? privacyLevelProfiles : 0)}` : 'Primary profile'
                                : conn.credentials?.stremioProfileName
                                    ? maskProfileLevel(conn.credentials.stremioProfileName, isPrivacyModeEnabled ? privacyLevelProfiles : 0) : undefined
                            const contextLabel = [customLabel, profileLabel].filter(Boolean).join(' · ') || undefined
                            const premium = isPrimaryStremio ? premiumByAccount.get(accountId) : undefined
                            const nuvioMember = kind === 'nuvio' ? nuvioMemberByConnection.get(conn.id) : undefined
                            // lastKnownAddonCount is not maintained after connection creation.
                            // Show the current account collection rather than a stale remote count.
                            const accountAddonCount = statusAccount?.addons?.length
                            // Same-platform cards stay distinguishable by each login's own identity.
                            return (
                                <ConnectionCard
                                    key={conn.id}
                                    connection={conn}
                                    status={needsSignIn ? 'pending' : liveStatus}
                                    lastSync={liveLastSync}
                                    lastError={liveLastError}
                                    syncing={isSyncing === accountId}
                                    onEdit={() => openConnectionPanel(conn.id, null)}
                                    onToggle={() => useConnectionStore.getState().toggleConnection(accountId, conn.id)}
                                    email={connEmail}
                                    contextLabel={contextLabel}
                                    addonCount={conn.platform === 'jellyfin' ? undefined : accountAddonCount}
                                    badge={
                                        <>
                                            {needsSignIn ? (
                                                <StatusChip size="sm" variant="warning">Needs sign-in</StatusChip>
                                            ) : nuvioMember || premium !== undefined ? (
                                                <>
                                                    {premium?.active && <StremioSupportersBadge />}
                                                    {premium && !premium.active && <StatusChip size="sm" variant="muted">Free</StatusChip>}
                                                    {nuvioMember && <NuvioTierBadge member={nuvioMember} />}
                                                </>
                                            ) : undefined}
                                        </>
                                    }
                                />
                            )
                        })}
                        {subscribers.map(sub => (
                            <SubscriberCard key={sub.name} subscriber={sub} onRemove={handleRemoveSubscriber} onOpen={() => openConnectionPanel(null, sub.name)} />
                        ))}
                    </div>
                </div>
            )}
        </div>
    )

    const personPanel = statusAccount?.addons.some(isAIOStreamsAddon)
        ? <HouseholdSetupDialog accountId={accountId} open embedded onSavingChange={setPersonSaving} onOpenChange={value => { if (!value) setSubTab('connections') }} />
        : <div data-theme-part="panel" className="space-y-3 rounded-2xl border border-border/40 bg-card/50 p-5"><h3 className="text-base font-semibold">Set up a person with AIOS / AIOM</h3><p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">Set up their Jellyfin playback here without switching between AIOStreams and AIOMetadata. Create or choose their AIOStreams user, optionally connect AIOMetadata, then attach their verified sign-in to a local account you manage. Advanced setup can also add a variant.</p><p className="text-xs leading-relaxed text-muted-foreground">Start by adding an AIOStreams configuration to this account’s addons. To connect an existing Jellyfin, AIOS or AIOM user, use Add Connection in Linked accounts.</p></div>

    const connectionTabTriggers = <>
        <TabsTrigger disabled={personSaving} value="connections"><Link2 className="h-3.5 w-3.5" />Linked accounts</TabsTrigger>
        <TabsTrigger disabled={personSaving} value="history"><History className="h-3.5 w-3.5" />Watch history</TabsTrigger>
        <TabsTrigger value="person"><Users className="h-3.5 w-3.5" />Set up a person</TabsTrigger>
        {hasApiKeyTab && <TabsTrigger disabled={personSaving} value="apikey"><Key className="h-3.5 w-3.5" />API Key</TabsTrigger>}
    </>

    const connectionPanels = <>
        <TabsContent value="connections">{connectionsList}</TabsContent>
        <TabsContent value="history"><WatchMigrationPicker accountId={accountId} embedded /></TabsContent>
        <TabsContent value="person">{personPanel}</TabsContent>
        {hasApiKeyTab && <TabsContent value="apikey">{statusAccount && <ApiKeyManager account={statusAccount} />}</TabsContent>}
    </>

    return (
        <>
            {!panelOpen && panelForward.length > 0 && (
                <div className="flex justify-end pb-1">
                    <Button type="button" variant="ghost" onClick={panelForwardTo} aria-label="Forward to connection panel" className="h-11 w-11 rounded-full p-0 sm:h-9 sm:w-9">
                        <ChevronRight className="h-4 w-4" />
                    </Button>
                </div>
            )}
            {openedSubscriber ? (
                <div ref={panelRef} tabIndex={-1} className="outline-none min-w-0">
                    <HydraPullPanel
                        key={openedSubscriber.name}
                        subscriber={openedSubscriber}
                        addonCount={statusAccount?.addons?.filter(addon => addon.flags?.enabled !== false).length ?? 0}
                        onBack={panelBack}
                        onRemove={name => { void handleRemoveSubscriber(name) }}
                        onOpenApiKey={hasApiKeyTab ? () => { openConnectionPanel(null, null); setSubTab('apikey') } : undefined}
                    />
                </div>
            ) : editing ? (
                <div ref={panelRef} tabIndex={-1} className="outline-none min-w-0">
                    {(() => {
                    if (workspaceKind(editing) === 'jellyfin') return <JellyfinConnectionPanel
                        key={editing.id} accountId={accountId} connection={editing}
                        onBack={panelBack}
                        onReconnect={() => { setJellyfinReconnectId(editing.id); setJellyfinDialogOpen(true) }}
                    />
                    // Same authority rule as the cards: the live state entry wins as a
                    // whole; the stored connection fields only serve when it is absent.
                    const editState = accountStates[editing.id]
                    const editingIsPrimaryStremio = workspaceKind(editing) === 'stremio' && !!statusAccount && getStremioConnection(statusAccount)?.id === editing.id
                    return (
                        <ConnectionEditPanel
                            key={editing.id}
                            accountId={accountId}
                            connection={editing}
                            status={editState ? editState.status : editing.status}
                            lastError={editState ? editState.lastError : (editing.lastError ?? null)}
                            lastSync={editState ? editState.lastSync : editing.lastSync}
                            premium={editingIsPrimaryStremio ? premiumByAccount.get(accountId) : undefined}
                            premiumState={premiumPhase}
                            onRefreshPremium={editingIsPrimaryStremio ? refreshPremium : undefined}
                            nuvioMember={workspaceKind(editing) === 'nuvio' ? nuvioMemberByConnection.get(editing.id) : undefined}
                            onBack={panelBack}
                            onShowInstalledAddons={onShowInstalledAddons ? () => { openConnectionPanel(null, null); onShowInstalledAddons() } : undefined}
                        />
                    )
                })()}
                </div>
            ) : (
                <div ref={listRef} tabIndex={-1} className="outline-none">
                {variant === 'sheet' ? (
                <Tabs value={subTab} onValueChange={value => { if (!personSaving) setSubTab(value) }} className="min-w-0">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                        <div className="relative min-w-0 flex-1">
                            <TabsList ref={sheetTabListRef} onScroll={updateTabFades} aria-label="Connection tools" className="w-full min-w-0 flex-nowrap overflow-x-auto rounded-xl border-0 bg-muted/25 p-1 shadow-none [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&_[role=tab]]:px-3 [&_[role=tab]]:text-xs">
                                {connectionTabTriggers}
                            </TabsList>
                            {tabFades.left && <div aria-hidden="true" data-connection-tabs-fade="left" className="pointer-events-none absolute inset-y-0 left-0 hidden w-7 bg-gradient-to-r from-card to-transparent max-sm:block rounded-l-xl" />}
                            {tabFades.right && <div aria-hidden="true" data-connection-tabs-fade="right" className="pointer-events-none absolute inset-y-0 right-0 hidden w-7 bg-gradient-to-l from-card to-transparent max-sm:block rounded-r-xl" />}
                        </div>
                        <div className="ml-auto flex shrink-0 items-center gap-2 max-sm:self-end">{subTab === 'connections' && sheetConnectionActions}</div>
                    </div>
                    <div className="mt-3 [&>[data-theme-part=tab-panel]]:mt-0">{connectionPanels}</div>
                </Tabs>
                ) : (
                <WorkspaceTabs value={subTab} onValueChange={value => { if (!personSaving) setSubTab(value) }} label="Connection tools" actions={subTab === 'connections' ? connectionActions : undefined} tabs={connectionTabTriggers}>
                    {connectionPanels}
                </WorkspaceTabs>
                )}
                </div>
            )}

            <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
                <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl sm:p-7">
                    <DialogHeader>
                        <DialogTitle>Add Connection</DialogTitle>
                        <DialogDescription>Connect a platform or media server to AIOManager.</DialogDescription>
                    </DialogHeader>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-2">
                        {PLATFORM_REGISTRY
                            .filter(p => p.available)
                            .map(p => {
                                // Multiplicity: a connected platform stays clickable so
                                // another remote login on the same platform can be bound;
                                // the badge only reports what is already connected.
                                const isAlreadyConnected = p.connectionType === 'native' && resolvedConnections.some(c => c.platform === p.id)
                                return { platform: p, isAlreadyConnected }
                            })
                            .map(({ platform: p, isAlreadyConnected }) => (
                                <button
                                    key={p.id}
                                    data-theme-part="card"
                                    className="group/card flex min-w-0 flex-col justify-between gap-4 rounded-2xl border border-border/40 bg-card p-5 text-left shadow-sm transition-[background-color,border-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:border-primary/40 hover:bg-card/95 hover:shadow-md"
                                    onClick={() => handlePlatformClick(p.id)}
                                >
                                    <div className="flex items-start gap-3">
                                        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-muted/60 ring-1 ring-border/40 transition-colors group-hover/card:bg-background">
                                            <PlatformLogo platform={p.id} className="h-9 w-9" isHydra={p.connectionType === 'hydra-outbound'} />
                                        </div>
                                        <div className="min-w-0 flex-1">
                                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                                <p className="text-sm font-semibold">{p.name}{p.connectionType === 'hydra-outbound' && <span className="ml-1 font-normal text-muted-foreground">· outbound</span>}</p>
                                                {isAlreadyConnected && (
                                                    <span data-theme-part="badge" className="rounded-full bg-success/15 px-2 py-0.5 text-[10px] font-semibold uppercase text-success">Connected</span>
                                                )}
                                            </div>
                                            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{p.description}</p>
                                        </div>
                                    </div>
                                    <span className="inline-flex items-center gap-1 text-xs font-medium text-primary">
                                        {isAlreadyConnected ? 'Add another' : 'Connect'}
                                        <ChevronRight className="h-3.5 w-3.5 transition-transform group-hover/card:translate-x-0.5" />
                                    </span>
                                </button>
                            ))}

                        <div data-theme-part="panel" className="rounded-2xl border border-border/30 bg-muted/20 p-4 text-xs text-muted-foreground sm:col-span-2">
                            <p className="font-medium text-foreground">Apps connect to you automatically</p>
                            <p className="mt-1 leading-relaxed">Apps such as Odin pull your addons using your AIOManager URL and account API key through the Hydra API. They appear in your <span className="font-medium text-foreground">connections list</span> after they sync. Find your API key on the API Key tab.</p>
                        </div>
                    </div>
                </DialogContent>
            </Dialog>

            {renderSetupDialogs()}
        </>
    )
}
