import { create } from 'zustand'
import { useAccountStore, persistAccounts, acquireSyncMutex } from './accountStore'
import { getConnectionStates } from '@/api/connection'
import type { Connection, ConnectionStatus } from '@/types/connection'
import { isAddonConnection } from '@/types/connection'
import type { Account } from '@/types/account'
import type { PictureRowState } from '@/lib/connection-pictures/types'
import { applyConnectionPictureState } from '@/lib/connection-pictures/sync-merge'
import { toast } from '@/hooks/use-toast'
import { triggerSync } from '@/lib/sync-trigger'
import { canApplyMediaReadFailure, type MediaReadSession } from '@/lib/jellyfin/connection-health'
import { stremioAuthKeyMirrorAfterRemoval, stremioConnectionsOf } from '@/lib/connection-identity'
import { acknowledgeConnectionRestores, addConnectionRemovals } from '@/lib/connection-removals'
import { noteStremioCanonicalRepoint, noteStremioLoginsRemoved } from '@/lib/stremio-repoint'
import { invalidateRealStreamToken } from '@/lib/realstream-token-cache'

/**
 * Canonical Stremio identity transitions: returns the demoted canonical connection id
 * (native stored logins only — a legacy authKey-only account has no identity to move)
 * so the caller can migrate the demoted login's bare-scope history and notify the server.
 * The canonical "changed" only when a DIFFERENT stored login takes it over.
 */
function demotedStremioCanonical(account: Account, nextPrimaryConnectionId: string | undefined, removedConnectionId?: string): string | undefined {
    const nativeLogins = stremioConnectionsOf(account.connections).filter(c => c.id !== removedConnectionId)
    const prevCanonicalId = stremioConnectionsOf(account.connections)
        .find(c => c.id === account.primaryConnectionId)?.id
        ?? stremioConnectionsOf(account.connections)[0]?.id
    if (!prevCanonicalId) return undefined
    if (prevCanonicalId === removedConnectionId) {
        // Removal-promotion: the demoted login is the removed canonical itself.
        return nativeLogins.length > 0 ? prevCanonicalId : undefined
    }
    const nextCanonicalId = nativeLogins.find(c => c.id === nextPrimaryConnectionId)?.id
    return nextCanonicalId && nextCanonicalId !== prevCanonicalId ? prevCanonicalId : undefined
}

function applyStremioCanonicalTransition(accountId: string, demotedConnectionId: string | undefined, promotedConnectionId: string | undefined, loginsRemaining: number, removedCanonicalConnectionId?: string) {
    if (demotedConnectionId) {
        import('./watchEventStore').then(({ useWatchEventStore }) => {
            useWatchEventStore.getState().migrateCanonicalScope(accountId, demotedConnectionId, promotedConnectionId)
        }).catch(() => { })
        noteStremioCanonicalRepoint(accountId, demotedConnectionId)
    } else if (loginsRemaining === 0) {
        noteStremioLoginsRemoved(accountId, removedCanonicalConnectionId)
    }
}

interface ConnectionStateEntry {
    consecutiveFailures: number
    lastError: string | null
    lastErrorAt: number | null
    lastSync: number
    status: ConnectionStatus
    skipCyclesRemaining: number
}

interface ConnectionStore {
    connectionStates: Record<string, Record<string, ConnectionStateEntry>>
    isSyncing: string | null

    addConnection: (accountId: string, connection: Omit<Connection, 'id' | 'lastSync' | 'lastKnownAddonCount' | 'consecutiveFailures'>, options?: { assertCurrent?: () => void }) => Promise<void>
    removeConnection: (accountId: string, connectionId: string, options?: ConnectionRemovalOptions) => Promise<void>
    updateConnection: (accountId: string, connectionId: string, updates: Partial<Connection>, mediaReadSession?: MediaReadSession) => Promise<void>
    setPrimaryConnection: (accountId: string, connectionId: string) => Promise<void>
    toggleConnection: (accountId: string, connectionId: string) => Promise<void>
    syncConnections: (accountId: string) => Promise<void>
    refreshConnectionStates: (accountId: string) => Promise<void>
    /** Persists one connection-picture row's state (followsDefault flips, lastWritten markers, locks). */
    setConnectionPictureState: (accountId: string, rowId: string, state: PictureRowState | null) => Promise<void>
}

// Acknowledgement that the Autopilot rules left login-less by this removal were
// disposed server-first. Verified against the live rule store, never trusted.
export interface ConnectionRemovalOptions {
    autopilotRules?: 'paused' | 'deleted'
}

const safeUUID = () => {
    try { return crypto.randomUUID() } catch {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = crypto.getRandomValues(new Uint8Array(1))[0] % 16
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16)
        })
    }
}

// Incarnation token of a connection (SOL-R1-BETA-04): every add of a connection id
// starts a fresh generation. Its server rules and credentials carry it, so a delayed
// cleanup of a removed incarnation never claims a re-added incarnation's rows.
const newConnectionGeneration = () => safeUUID()

async function updateAccount(accountId: string, updater: (account: Account) => Account, assertCurrent?: () => void) {
    const release = await acquireSyncMutex(accountId)
    try {
        assertCurrent?.()
        const { accounts } = useAccountStore.getState()
        const updated = accounts.map(a => a.id === accountId ? updater(a) : a)
        useAccountStore.setState({ accounts: updated })
        persistAccounts(updated)
    } finally {
        release()
    }
}

// Fields that change the encrypted sync envelope. Background health writes
// (status/lastSync/error counters) must not re-push it; structural changes must.
const ENVELOPE_FIELDS = new Set([
    'platform', 'connectionType', 'driverType', 'enabled', 'credentials', 'profileMapping',
    'capabilities', 'pluginList', 'driverConfig', 'displayName', 'mediaServer',
])

const touchesEnvelope = (updates: Partial<Connection>) => Object.keys(updates).some(key => ENVELOPE_FIELDS.has(key))

export const useConnectionStore = create<ConnectionStore>((set, get) => ({
    connectionStates: {},
    isSyncing: null,

    addConnection: async (accountId, partial, options) => {
        options?.assertCurrent?.()
        // Media credentials are sealed browser-only with no server-side copy, so the save
        // only counts when the account actually exists. Never toast success into a void.
        if (partial.platform === 'jellyfin' && !useAccountStore.getState().accounts.some(a => a.id === accountId)) {
            throw new Error('This account no longer exists. Reload and add the media connection again.')
        }
        const connection: Connection = {
            id: safeUUID(),
            // Incarnation token (SOL-R1-BETA-04): every add of a connection id starts a
            // fresh generation, carried on its server rules and credentials.
            generation: newConnectionGeneration(),
            platform: partial.platform,
            connectionType: partial.connectionType || partial.driverType || 'native',
            enabled: partial.enabled ?? true,
            status: partial.status ?? 'active',
            credentials: partial.credentials,
            profileMapping: partial.profileMapping,
            lastSync: 0,
            lastKnownAddonCount: 0,
            capabilities: partial.capabilities ?? ['addons'],
            consecutiveFailures: 0,
            pluginList: partial.pluginList,
            driverConfig: partial.driverConfig,
            displayName: partial.displayName,
            mediaServer: partial.mediaServer,
        }

        if (connection.platform !== 'jellyfin' && connection.connectionType === 'hydra-outbound' && connection.driverConfig?.baseUrl) {
            const { storeConnectionCredential } = await import('@/api/hydra-providers')
            const bundle = {
                authValue: connection.credentials?.apiKey || '',
                baseUrl: connection.driverConfig.baseUrl,
                authType: connection.driverConfig.authType,
                authHeader: connection.driverConfig.authHeader,
                enabled: connection.enabled,
            }
            storeConnectionCredential(accountId, connection.id, bundle, 'hydra', connection.generation).catch(() => {
                toast({ variant: 'destructive', title: 'Connection credential save failed', description: 'The connection will work until page reload.', href: `/account/${encodeURIComponent(accountId)}` })
            })
        }

        // Server-custody platforms: every later token fetch for these goes through the
        // server, so a sign-in whose credential never reached it 404s on each sync. The
        // save is retried once; a second failure is surfaced honestly and the connection
        // is left in the sign-in-required state ('expired' + lastError) the app renders
        // for expired sessions.
        let serverCredentialSaveFailed = false
        const storeServerCredentialWithRetry = async (bundle: Record<string, unknown>, credentialType: 'nuvio' | 'realstream') => {
            const label = credentialType === 'nuvio' ? 'Nuvio' : 'RealStream'
            const { storeConnectionCredential } = await import('@/api/hydra-providers')
            try {
                await storeConnectionCredential(accountId, connection.id, bundle, credentialType, connection.generation)
            } catch {
                try {
                    await storeConnectionCredential(accountId, connection.id, bundle, credentialType, connection.generation)
                } catch (retryErr) {
                    serverCredentialSaveFailed = true
                    connection.status = 'expired'
                    connection.lastError = `${label} sign-in was not stored on the server. Sign in again to sync this connection.`
                    connection.lastErrorAt = Date.now()
                    toast({
                        variant: 'destructive',
                        title: `${label} sign-in was not saved on the server`,
                        description: `${retryErr instanceof Error ? retryErr.message : 'Unknown error'} Sign in again from this connection so it can sync.`,
                        href: `/account/${encodeURIComponent(accountId)}`,
                    })
                }
            }
        }

        if (connection.platform === 'nuvio' && connection.credentials?.accessToken) {
            const bundle = {
                accessToken: connection.credentials.accessToken,
                refreshToken: connection.credentials.refreshToken,
                expiresAt: connection.credentials.expiresAt,
                profileId: connection.credentials.profileId || null,
                baseUrl: connection.credentials?.baseUrl || null,
                publishableKey: connection.credentials?.publishableKey || null,
            }
            await storeServerCredentialWithRetry(bundle, 'nuvio')
        }

        if (connection.platform === 'realstream' && connection.credentials?.accessToken) {
            const bundle = {
                accessToken: connection.credentials.accessToken,
                userId: connection.credentials.userId || null,
                expiresAt: connection.credentials.expiresAt,
                baseUrl: connection.credentials.baseUrl || null,
                email: connection.credentials.email || null,
                password: connection.credentials.password || null,
            }
            await storeServerCredentialWithRetry(bundle, 'realstream')
        }

        if (connection.platform === 'stremio' && connection.credentials?.authKey) {
            // A login added right after a last-login removal must never let the pending
            // removal revoke it: convert the unsynced note into a re-point (migrate the
            // old history) before this login's first credential sync.
            const { convertPendingLoginsRemovedToRepoint } = await import('@/lib/stremio-repoint')
            convertPendingLoginsRemovedToRepoint(accountId)
            // Likewise a queued last-login credential cleanup is dropped before this login registers.
            try {
                const { cancelPendingStremioCredentialCleanup } = await import('@/lib/account-server-cleanup')
                await cancelPendingStremioCredentialCleanup(accountId)
            } catch { /* the drain also skips accounts that have a Stremio login */ }
        }

        await updateAccount(accountId, account => {
            // Multiplicity: every completed sign-in appends its own connection, so one
            // local account can manage several remote logins on the same platform. The
            // canonical addon connection is never displaced — the first addon
            // connection stays primary and later logins bind as secondaries.
            return {
                ...account,
                connections: [...(account.connections || []), connection],
                // A deliberate re-add acknowledges any removal marker for this id (an
                // acknowledgement, not a local erase: it must survive the next sync).
                ...acknowledgeConnectionRestores(account, [connection.id]),
                primaryConnectionId: account.primaryConnectionId || (isAddonConnection(connection) ? connection.id : undefined),
            }
        }, options?.assertCurrent)
        options?.assertCurrent?.()

        if (connection.platform === 'jellyfin'
            && !useAccountStore.getState().accounts.find(a => a.id === accountId)?.connections?.some(c => c.id === connection.id)) {
            throw new Error('This account no longer exists. Reload and add the media connection again.')
        }

        if (!serverCredentialSaveFailed) toast({ title: `${connection.platform} connection added` })

        // Structural connection changes belong in the encrypted sync envelope. Media
        // connections never enter the addon reconciliation below (isAddonConnection).
        triggerSync()

        if (connection.enabled && isAddonConnection(connection)) {
            import('./accountStore').then(({ useAccountStore }) => {
                useAccountStore.getState().syncAccount(accountId, false, 'user').catch(() => {})
            })
        }
    },

    removeConnection: async (accountId, connectionId, options) => {
        const { accounts } = useAccountStore.getState()
        const account = accounts.find(a => a.id === accountId)
        const conn = account?.connections?.find(c => c.id === connectionId)
        if (conn?.platform === 'realstream') invalidateRealStreamToken(connectionId)
        // Autopilot prerequisite: removing the LAST Stremio login strands the rules that
        // run on it. The removal flow pauses or deletes them server-first and acknowledges
        // via options; any other caller fails loudly here instead of bypassing silently.
        // The acknowledgement is verified against the live rule store, not trusted.
        if (conn?.platform === 'stremio' || connectionId === `${accountId}:stremio`) {
            const { isLastStremioLoginRemoval, findDependentRules } = await import('@/lib/rule-removal')
            if (isLastStremioLoginRemoval(account, connectionId)) {
                const { useFailoverStore } = await import('./failoverStore')
                const dependent = findDependentRules(useFailoverStore.getState().rules, accountId, connectionId, account)
                if (dependent.length > 0) {
                    const disposition = options?.autopilotRules
                    if (!disposition) {
                        throw new Error('Autopilot rules still use this login. Pause or delete them before removing it.')
                    }
                    if (disposition === 'paused' && dependent.some(r => r.isActive !== false)) {
                        throw new Error('Autopilot rules still use this login. Pause them before removing it.')
                    }
                    if (disposition === 'deleted' && dependent.some(r => useFailoverStore.getState().rules.some(x => x.id === r.id))) {
                        throw new Error('Autopilot rules still use this login. Delete them before removing it.')
                    }
                }
            }
        }
        // Connection removal is one server-side operation: the Autopilot rules bound to
        // this connection (stored addon_list and priority chain included), their stats
        // and history, and its credential rows all go together, or the failure queues a
        // retry. The canonical account-level Stremio row has no connection id: the next
        // credentials sync re-points it at a surviving login, and the last login's
        // removal deletes it below.
        const removedGeneration = conn?.generation
        if (conn?.platform !== 'jellyfin' && (conn?.connectionType === 'hydra-outbound' || conn?.platform === 'nuvio' || conn?.platform === 'realstream' || conn?.platform === 'stremio')) {
            import('@/api/hydra-providers')
                .then(({ deleteConnectionServerState }) => {
                    // Extra dispatch guard: a same-id re-add with a fresh incarnation
                    // re-owns the server rows, so the cleanup only leaves while the live
                    // connection is still the removed incarnation or already gone.
                    const live = useAccountStore.getState().accounts.find(a => a.id === accountId)?.connections?.find(c => c.id === connectionId)
                    if (live && live.generation !== removedGeneration) return
                    return deleteConnectionServerState(accountId, connectionId, removedGeneration)
                })
                .catch(() => import('@/lib/account-server-cleanup').then(m => m.queuePendingConnectionServerCleanup(accountId, connectionId, Date.now(), removedGeneration)))
                .catch(() => {})
        }
        const { invalidateConnectionCache } = await import('@/lib/connection-discovery')
        invalidateConnectionCache(connectionId)
        const isStremioRemoval = conn?.platform === 'stremio' || connectionId === `${accountId}:stremio`
        // Canonical transition (removal-promotion): compute BEFORE the state update so
        // the previous canonical is still visible, apply AFTER it succeeded.
        const survivingConnections = (account?.connections || []).filter(c => c.id !== connectionId)
        const demotedId = isStremioRemoval && account
            ? demotedStremioCanonical(account, survivingConnections.find(isAddonConnection)?.id, connectionId)
            : undefined
        const promotedId = demotedId && survivingConnections.some(c => c.platform === 'stremio')
            ? (survivingConnections.find(c => c.id === account?.primaryConnectionId)?.platform === 'stremio'
                ? survivingConnections.find(c => c.id === account?.primaryConnectionId)?.id
                : stremioConnectionsOf(survivingConnections)[0]?.id)
            : undefined
        let loginsRemaining = -1
        await updateAccount(accountId, account => {
            const connections = (account.connections || []).filter(c => c.id !== connectionId)
            const primaryConnectionId = account.primaryConnectionId === connectionId
                ? connections.find(isAddonConnection)?.id
                : account.primaryConnectionId
            if (isStremioRemoval) loginsRemaining = stremioConnectionsOf(connections).length
            return {
                ...account,
                connections,
                primaryConnectionId,
                // Removal marker: the version outranks any earlier acknowledgement and
                // survives sync merges, so a stale copy cannot merge this connection
                // back (issue #89).
                ...addConnectionRemovals(account, [connectionId]),
                // account.authKey is the legacy mirror of the CANONICAL Stremio login:
                // unlinking a secondary login must not clear it, and unlinking the
                // canonical one re-points it at the surviving canonical login instead
                // of orphaning the account's session.
                ...(isStremioRemoval ? {
                    authKey: stremioAuthKeyMirrorAfterRemoval({
                        connections: account.connections,
                        removedConnectionId: connectionId,
                        primaryConnectionId,
                        previousAuthKey: account.authKey,
                    }),
                } : {}),
            }
        })
        if (isStremioRemoval && loginsRemaining >= 0) {
            const removedCanonicalId = account?.primaryConnectionId === connectionId || demotedId === connectionId
                ? connectionId
                : stremioConnectionsOf(account?.connections || []).find(c => c.id === account?.primaryConnectionId)?.id ?? stremioConnectionsOf(account?.connections || [])[0]?.id
            applyStremioCanonicalTransition(accountId, demotedId, promotedId, loginsRemaining, removedCanonicalId)
        }
        if (isStremioRemoval && loginsRemaining === 0) {
            const removedAt = Date.now()
            import('@/api/hydra-providers')
                .then(({ deleteStremioCredentials }) => deleteStremioCredentials(accountId, removedAt))
                .catch(() => import('@/lib/account-server-cleanup').then(m => m.queuePendingStremioCredentialCleanup(accountId, removedAt)))
                .catch(() => {})
        }
        // Rules bound to the removed connection cannot run without it, and their server
        // rows went with the connection-state delete above. Retire the local copies too
        // (a rule sync would otherwise re-create the server row), unless the caller
        // disposed of them itself through the removal dialog's disposition.
        if (!options?.autopilotRules) {
            import('./failoverStore').then(({ useFailoverStore }) =>
                useFailoverStore.getState().removeConnectionRules(accountId, connectionId)
            ).catch(() => {})
        }
        if (conn) triggerSync()
    },

    updateConnection: async (accountId, connectionId, updates, mediaReadSession) => {
        let matched = false
        await updateAccount(accountId, account => ({
            ...account,
            connections: (account.connections || []).map(c => {
                if (c.id !== connectionId) return c
                if (mediaReadSession && !canApplyMediaReadFailure(c, mediaReadSession)) return c
                matched = true
                return { ...c, ...updates }
            }),
        }))
        if (matched && updates.credentials) invalidateRealStreamToken(connectionId)
        if (!matched && (updates.mediaServer || updates.credentials?.jellyfin)) {
            throw new Error('This media connection no longer exists. Add a new connection instead.')
        }
        if (matched && touchesEnvelope(updates)) triggerSync()
    },

    setPrimaryConnection: async (accountId, connectionId) => {
        let changed = false
        const accountBefore = useAccountStore.getState().accounts.find(a => a.id === accountId)
        let demotedId: string | undefined
        await updateAccount(accountId, account => {
            const primaryConnectionId = account.connections?.some(c => c.id === connectionId && isAddonConnection(c))
                ? connectionId : account.primaryConnectionId
            changed = primaryConnectionId !== account.primaryConnectionId
            return { ...account, primaryConnectionId }
        })
        if (changed && accountBefore && accountBefore.primaryConnectionId !== connectionId) {
            // Primary switched: if the stremio canonical moved to a different stored
            // login, migrate the demoted login's bare-scope history and notify the server.
            demotedId = demotedStremioCanonical(accountBefore, connectionId)
            const promotedIsStremio = stremioConnectionsOf(accountBefore.connections).some(c => c.id === connectionId)
            if (demotedId) applyStremioCanonicalTransition(accountId, demotedId, promotedIsStremio ? connectionId : undefined, stremioConnectionsOf(accountBefore.connections).length)
        }
        if (changed) triggerSync()
    },

    toggleConnection: async (accountId, connectionId) => {
        let wasEnabled: boolean | undefined
        await updateAccount(accountId, account => {
            wasEnabled = account.connections?.find(c => c.id === connectionId)?.enabled
            return {
                ...account,
                connections: (account.connections || []).map(c =>
                    c.id === connectionId ? { ...c, enabled: !c.enabled } : c
                ),
            }
        })
        const toggled = useAccountStore.getState().accounts.find(a => a.id === accountId)?.connections?.find(c => c.id === connectionId)
        if (toggled?.platform !== 'jellyfin' && toggled?.connectionType === 'hydra-outbound' && toggled.driverConfig?.baseUrl) {
            const { storeConnectionCredential } = await import('@/api/hydra-providers')
            storeConnectionCredential(accountId, connectionId, {
                authValue: toggled.credentials?.apiKey || '',
                baseUrl: toggled.driverConfig.baseUrl,
                authType: toggled.driverConfig.authType,
                authHeader: toggled.driverConfig.authHeader,
                enabled: toggled.enabled,
            }, 'hydra', toggled.generation).catch(() => {})
        }
        // The enabled flag is part of the encrypted envelope for every platform.
        if (toggled) triggerSync()
        if (wasEnabled === false && toggled && isAddonConnection(toggled)) {
            // Reconnecting is not an explicit reinstall of a deleted addon.
            import('./account/accountSync').then(({ scheduleSyncAccount }) => {
                scheduleSyncAccount(accountId, false, 'user')
            })
            import('./account/accountAddonOps').then(({ pushToConnections }) => {
                pushToConnections(accountId).catch(() => {})
            })
        }
    },

    syncConnections: async (accountId) => {
        if (get().isSyncing === accountId) return
        set({ isSyncing: accountId })

        try {
            const { useAccountStore } = await import('./accountStore')
            await useAccountStore.getState().syncAccount(accountId, true, 'user')
            await get().refreshConnectionStates(accountId)
        } catch (err) {
            toast({ title: 'Sync failed', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive', href: `/account/${encodeURIComponent(accountId)}` })
        } finally {
            set({ isSyncing: null })
        }
    },

    refreshConnectionStates: async (accountId) => {
        try {
            const states = await getConnectionStates(accountId)
            set(state => ({
                connectionStates: {
                    ...state.connectionStates,
                    [accountId]: states,
                },
            }))
        } catch {}
    },

    setConnectionPictureState: async (accountId, rowId, state) => {
        await updateAccount(accountId, account => {
            // CP-R3-002: the live path funnels through the bounded pure setter,
            // which bumps the row revision and collapses a full avatar data URI
            // to a digest so it can never ride the synced account blob.
            return { ...account, connectionPictures: applyConnectionPictureState(account.connectionPictures, rowId, state) }
        })
        // Row state is part of the account blob: ride the normal sync queue so
        // other devices see own-picture flips and last-written markers.
        triggerSync()
    },
}))
