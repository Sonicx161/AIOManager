import { triggerSync } from '@/lib/sync-trigger'
import {
    fetchAddonManifest as apiFetchAddonManifest,
    getAddons,
} from '@/api/addons'
import { getAddonVersionKey, normalizeAddonUrl, mergeAddons } from '@/lib/utils'
import { addTombstones, restoreAddonDeletions, filterResurrected } from '@/lib/addon-tombstones'
import { queueAddonActionDeletes, addonDeleteAcks, InstallAbortedError, makeInstallGuard, liftBlockedByInstance, acquireInstallMutex } from './addonActions'
import { effectiveAddonsFor, normalizeDestinations, stripDestinationsForWire } from '@/lib/addon-destinations'
import { AddonDescriptor } from '@/types/addon'
import { dedupeAddonsByUrl, findInstallSlot } from '@/lib/addon-dedupe'
import { resolveRemovalIndex, type RemoveAddonByIndexResult } from '@/lib/addon-removal'
import { mapConcurrent } from '@/lib/concurrency'
import { normalizeFailedConnectionState } from '@/lib/sync/push-outcome'
import { syncManager } from '@/lib/sync/syncManager'
import { autopilotManager } from '@/lib/autopilot/autopilotManager'
import { getEffectiveManifest } from '@/lib/addon-utils'
import { getCachedManifest, setCachedManifest } from '@/lib/manifest-cache'
import { isPlaceholderManifest } from '@/lib/manifest-placeholder'
import { captureOriginalDetails, planDetailReset, applyDetailReset } from '@/lib/addon-original-details'
import { trace, briefAddons } from '@/lib/trace'
import { toast } from '@/hooks/use-toast'
import {
    getCachedAuthKey,
    getEncryptionKey,
    sanitizeAddonManifest,
    getAccountById,
    persistAccounts,
    acquireSyncMutex,
    isAuthError,
    getStremioAuthKey,
    getStremioConnection,
    setAccountLoading,
    clearAccountLoading,
    hasPlatformConnection,
} from '../accountStore'
import type { AccountStore, ReplaceTransportUrlResult } from '../accountStore'
import type { Account, AccountProfile } from '@/types/account'
import { type Connection, isSyncEligibleConnection } from '@/types/connection'
import { captureSyncOwnership, SyncOwnershipLostError, type SyncOwnership } from '../sync-store-helpers'
import { getActiveWorkspaceId } from '@/lib/workspace-persistence'

type StoreRef = { getState: () => AccountStore; setState: (partial: Partial<AccountStore> | ((state: AccountStore) => Partial<AccountStore>)) => void }

async function getStore(): Promise<StoreRef> {
    const { useAccountStore } = await import('../accountStore')
    return useAccountStore
}

export { InstallAbortedError }

export interface InstallAddonOptions {
    guard?: () => void
    skipIfBusy?: boolean
}

// A queued edit belongs to the workspace and vault in which it was requested.
function captureAddonOwner(): () => boolean {
    const workspaceId = getActiveWorkspaceId()
    const encryptionKey = getEncryptionKey()
    return () => getActiveWorkspaceId() === workspaceId && getEncryptionKey() === encryptionKey
}

async function reconcileInstallBase(account: Account): Promise<AddonDescriptor[]> {
    const accountAuthKey = getStremioAuthKey(account)
    if (!accountAuthKey) return account.addons
    try {
        const { mergeRemoteIntoHub } = await import('./accountSync')
        const decryptedKey = await getCachedAuthKey(accountAuthKey, getEncryptionKey())
        const remoteAddons = await getAddons(decryptedKey, account.id)
        return mergeRemoteIntoHub(account, remoteAddons)
    } catch (err) {
        if (isAuthError(err)) throw err
        if (import.meta.env.DEV) console.warn('[Install] Live reconcile failed; falling back to hub state:', err)
        return account.addons
    }
}

const pluginUrlKey = (url?: string): string => (url ? url.trim().replace(/\/+$/, '').toLowerCase() : '')

// Stop points of a connection push: lost sync ownership, or a cancelled deploy batch.
function assertLive(ownership?: SyncOwnership, signal?: AbortSignal) {
    ownership?.assert()
    if (signal?.aborted) throw Object.assign(new Error('Deploy batch cancelled'), { name: 'AbortError' })
}

async function pushNuvio(conn: Connection, addons: AddonDescriptor[], accountId: string, activeProfileId?: string, ownership?: SyncOwnership, signal?: AbortSignal) {
    const creds = (conn.credentials || {}) as Record<string, string>
    const { nuvioDriverFor } = await import('@/lib/drivers/factory')
    assertLive(ownership, signal)
    const driver = nuvioDriverFor(conn)
    const { fetchConnectionToken, hashRejectedToken } = await import('@/api/connection')
    assertLive(ownership, signal)
    let token = await fetchConnectionToken(accountId, conn.id, 'nuvio')
    assertLive(ownership, signal)
    const { setCachedNuvioToken } = await import('@/lib/nuvio-token-cache')
    assertLive(ownership, signal)
    setCachedNuvioToken(conn.id, token)
    const { resolveNuvioPushProfile } = await import('@/lib/nuvio-profile-resolve')
    assertLive(ownership, signal)
    let profileId = resolveNuvioPushProfile(conn, activeProfileId, token.profileId ?? creds.profileIndex ?? creds.profileId)
    // R9: the provider wire carries projected provider data only — internal
    // destination policy is stripped before the driver. The plugin mirror below is
    // a separate per-connection list and never carries addon policy.
    // A rejected session heals only through a server-side forced revalidation: one retry, never more.
    try {
        await driver.writeAddons(token.accessToken, stripDestinationsForWire(addons), profileId)
    } catch (err) {
        if (!isAuthError(err)) throw err
        assertLive(ownership, signal)
        token = await fetchConnectionToken(accountId, conn.id, 'nuvio', undefined, { rejectedTokenHash: await hashRejectedToken(token.accessToken) })
        assertLive(ownership, signal)
        setCachedNuvioToken(conn.id, token)
        profileId = resolveNuvioPushProfile(conn, activeProfileId, token.profileId ?? creds.profileIndex ?? creds.profileId)
        await driver.writeAddons(token.accessToken, stripDestinationsForWire(addons), profileId)
    }
    ownership?.assert()

    // The addon write has landed; a cancelled batch only skips the separate plugin write.
    const canonicalPlugins = conn.pluginList || []
    if (canonicalPlugins.length > 0 && !signal?.aborted) {
        try {
            const platformPlugins = await driver.readPlugins(token.accessToken, profileId)
            ownership?.assert()
            const canonicalUrls = new Set(canonicalPlugins.map(p => pluginUrlKey(p.url)))
            const platformUrls = new Set((platformPlugins || []).map((p: { url?: string }) => pluginUrlKey(p.url)))
            const needsPush = platformUrls.size !== canonicalUrls.size
                || [...canonicalUrls].some(u => !platformUrls.has(u))
                || [...platformUrls].some(u => !canonicalUrls.has(u))
            if (needsPush && !signal?.aborted) await driver.writePlugins(token.accessToken, canonicalPlugins, profileId)
        } catch (err) {
            if (isAuthError(err)) throw err
        }
    }
}

async function pushRealStream(conn: Connection, addons: AddonDescriptor[], accountId: string, ownership?: SyncOwnership, signal?: AbortSignal) {
    const { fetchConnectionToken, hashRejectedToken } = await import('@/api/connection')
    const [{ getOrFetchRealStreamToken, refreshRealStreamToken }, { realStreamTokenOwner }] = await Promise.all([
        import('@/lib/realstream-token-cache'),
        import('@/lib/realstream-token-owner'),
    ])
    assertLive(ownership, signal)
    const tokenOwner = realStreamTokenOwner(accountId, conn)
    let token = await getOrFetchRealStreamToken(tokenOwner, () => fetchConnectionToken(accountId, conn.id, 'realstream'))
    assertLive(ownership, signal)

    const { realStreamDriverFor } = await import('@/lib/drivers/factory')
    assertLive(ownership, signal)
    // userId is a stable PocketBase identity set at auth time; it never changes between refreshes.
    const userId = conn.credentials?.userId || ''
    if (!userId) throw Object.assign(new Error('RealStream user ID missing; re-authenticate this connection'), { isAuthError: true })

    // R9: strip internal destination policy before the provider wire.
    // A rejected session heals only through a server-side forced revalidation: one retry, never more.
    const write = () => realStreamDriverFor(conn).writeAddons(token.accessToken, stripDestinationsForWire(addons), userId)
    try {
        return await write()
    } catch (err) {
        if (!isAuthError(err)) throw err
        assertLive(ownership, signal)
        const rejectedTokenHash = await hashRejectedToken(token.accessToken)
        token = await refreshRealStreamToken(tokenOwner, token.accessToken, () => fetchConnectionToken(accountId, conn.id, 'realstream', undefined, { rejectedTokenHash }))
        assertLive(ownership, signal)
        return await write()
    }
}

// Hydra (CORS-fragile against arbitrary servers) + any client-side failure fall back to the server.
async function serverReconcile(accountId: string, account: Account, connections: Connection[], options: { addons?: AddonDescriptor[]; allowCollectionShrink?: boolean; ownership?: SyncOwnership; signal?: AbortSignal } = {}) {
    try {
        const { triggerReconciliation } = await import('@/api/connection')
        assertLive(options.ownership, options.signal)
        const addons = options.addons ?? account.addons
        const result = await triggerReconciliation(accountId, account.primaryConnectionId, connections, addons, { allowCollectionShrink: options.allowCollectionShrink })
        options.ownership?.assert()
        const states = { ...(result.connectionStates || {}) }
        // The sync envelope is HTTP 200 even when individual connections failed, and a
        // first failure below the reconciler's backoff threshold still reports status
        // "active": one shared normalization (also used by user Sync) keeps those
        // connections visibly errored with the platform's message.
        const failures: string[] = []
        for (const conn of connections) {
            const failed = normalizeFailedConnectionState(result.connectionOutcomes?.[conn.id], states[conn.id])
            if (!failed) continue
            failures.push(failed.message)
            states[conn.id] = failed.state
        }
        if (Object.keys(states).length > 0) {
            const { useConnectionStore } = await import('@/store/connectionStore')
            options.ownership?.assert()
            useConnectionStore.setState(s => ({
                connectionStates: {
                    ...s.connectionStates,
                    [accountId]: { ...(s.connectionStates[accountId] || {}), ...states },
                },
            }))
        }
        if (failures.length > 0) {
            const shown = failures.slice(0, 2).join(' | ')
            toast({
                title: 'Connection sync failed',
                description: failures.length > 2 ? `${shown} (+${failures.length - 2} more)` : shown,
                variant: 'destructive',
                href: `/account/${encodeURIComponent(accountId)}`,
            })
        }
    } catch (e) {
        if ((options.ownership && !options.ownership.current()) || options.signal?.aborted) return
        toast({
            title: 'Connection sync failed',
            description: e instanceof Error ? e.message : 'One or more connections could not be updated.',
            variant: 'destructive',
            href: `/account/${encodeURIComponent(accountId)}`,
        })
    }
}

export async function pushToConnections(accountId: string, options: { addons?: AddonDescriptor[]; allowCollectionShrink?: boolean; ownership?: SyncOwnership; skipPlatforms?: string[]; signal?: AbortSignal } = {}) {
    const ownership = options.ownership
    // A cancelled deploy batch stops the fan-out at the same points a lost ownership does.
    const stopped = () => !!options.signal?.aborted
    const store = await getStore()
    if (stopped() || (ownership && !ownership.current())) return
    const account = getAccountById(store.getState().accounts, accountId)
    const skipPlatforms = options.skipPlatforms
    const eligible = (account?.connections || []).filter(c => c.enabled && isSyncEligibleConnection(c) && !skipPlatforms?.includes(c.platform))
    if (!account || eligible.length === 0) return

    const sourceAddons = options.addons ?? account.addons ?? []
    const enabledAddons = sourceAddons.filter(a => a?.flags?.enabled !== false)
    // Per-connection destination projection: each eligible connection receives its
    // own effective list (hub minus that login's exclusions). The hub stays the
    // superset; a row excluded for one target is simply absent from that target's
    // write — including an EMPTY write when every row is excluded there (policy-
    // authorized clear, R2). The global empty-guard below still applies to the
    // whole hub: a fully-empty canonical list is only pushed with explicit
    // allowCollectionShrink, never because of policy. The payload is exactly what
    // the hub shows; nothing is held back.
    const effectiveFor = (conn: Connection) => effectiveAddonsFor(enabledAddons, { platform: conn.platform, connectionId: conn.id })
    trace('push', 'connections-start', { accountId, eligible: eligible.map(c => c.platform), source: sourceAddons.length, enabled: enabledAddons.length, allowCollectionShrink: !!options.allowCollectionShrink })
    if (enabledAddons.length === 0 && !options.allowCollectionShrink) {
        trace('push', 'connections-skip-empty', { accountId })
        return
    }

    const { useConnectionStore } = await import('@/store/connectionStore')
    if (stopped() || (ownership && !ownership.current())) return
    const now = Date.now()
    // Bookkeeping for a write that already happened: a cancelled batch does not skip it.
    const setStatus = (connId: string, status: Connection['status'], lastError: string | null = null) => {
        if (ownership && !ownership.current()) return
        useConnectionStore.setState(s => ({
            connectionStates: {
                ...s.connectionStates,
                [accountId]: {
                    ...(s.connectionStates[accountId] || {}),
                    [connId]: {
                        consecutiveFailures: 0,
                        skipCyclesRemaining: 0,
                        lastError,
                        lastErrorAt: lastError ? now : null,
                        lastSync: status === 'active' ? now : (s.connectionStates[accountId]?.[connId]?.lastSync || 0),
                        status,
                    },
                },
            },
        }))
        if (status === 'active') {
            store.setState(s => ({
                accounts: s.accounts.map(acc =>
                    acc.id === accountId
                        ? { ...acc, connections: acc.connections?.map(c => c.id === connId ? { ...c, lastSync: now, status: 'active' as const } : c) }
                        : acc
                )
            }))
            persistAccounts(store.getState().accounts, ownership)
        }
    }

    const serverConnections: Connection[] = []
    let authFailures = 0

    for (const conn of eligible) {
        if (stopped() || (ownership && !ownership.current())) return
        if (conn.platform !== 'nuvio' && conn.platform !== 'realstream') {
            serverConnections.push(conn)
            continue
        }
        const payload = effectiveFor(conn)
        try {
            if (conn.platform === 'nuvio') await pushNuvio(conn, payload, accountId, account.activeProfileId, ownership, options.signal)
            else {
                // R2-08: an empty projection to RealStream, authorized or not, is never
                // a confirmed write. The driver resolves it as a skip with a plain
                // reason; the connection keeps its prior confirmation and never falls
                // back to the server reconciler as success.
                const result = await pushRealStream(conn, payload, accountId, ownership, options.signal)
                if (result?.skipped) {
                    const reason = (result as { reason?: string }).reason || 'empty projection without clear authorization'
                    trace('push', 'connection-skipped', { accountId, platform: conn.platform, connId: conn.id, reason })
                    setStatus(conn.id, 'error', reason)
                    continue
                }
            }
            setStatus(conn.id, 'active')
        } catch (err) {
            if (stopped() || (ownership && !ownership.current())) return
            const msg = err instanceof Error ? err.message : 'Connection sync failed'
            trace('push', 'connection-error', { accountId, platform: conn.platform, connId: conn.id, auth: isAuthError(err), error: msg })
            if (isAuthError(err)) {
                setStatus(conn.id, 'expired', msg)
                authFailures++
            } else {
                setStatus(conn.id, 'error', msg)
                serverConnections.push(conn)
            }
        }
    }

    if (stopped() || (ownership && !ownership.current())) return
    if (authFailures > 0) {
        toast({
            title: 'Connection re-authentication needed',
            description: `${authFailures} connection(s) need to be re-authenticated. Check the Connections tab.`,
            variant: 'destructive',
            href: `/account/${encodeURIComponent(accountId)}`,
        })
    }

    if (serverConnections.length > 0) {
        // The server reconciler projects each connection's destination policy itself (twin module).
        if (stopped()) return
        await serverReconcile(accountId, account, serverConnections, { addons: sourceAddons, allowCollectionShrink: options.allowCollectionShrink, ownership, signal: options.signal })
    }
}

function backgroundSync(accountId: string, account: Account, updatedAddons: AddonDescriptor[], options?: { allowCollectionShrink?: boolean }, trigger = 'unknown') {
    if (!hasPlatformConnection(account)) {
        return
    }
    const promises: Promise<void>[] = []

    const authKey = getStremioAuthKey(account)
    const stremioConn = getStremioConnection(account)
    const stremioPushEnabled = !stremioConn || stremioConn.enabled !== false
    trace('backgroundSync', 'enter', { accountId, hasAuthKey: !!authKey, stremioPushEnabled, count: updatedAddons.length, allowCollectionShrink: !!options?.allowCollectionShrink, trigger, addons: briefAddons(updatedAddons) })
    if (authKey && stremioPushEnabled) {
        promises.push(
            (async () => {
                // Fan out to every enabled Stremio login (canonical first); each login
                // writes with its own sealed key so secondaries never ride the
                // canonical session.
                const { pushAddonsToStremioConnections } = await import('@/lib/account-compat')
                const result = await pushAddonsToStremioConnections(account, updatedAddons, { allowCollectionShrink: options?.allowCollectionShrink, previousCollection: account.addons })
                for (const failure of result.failed) {
                    if (isAuthError(failure.error)) {
                        toast({
                            title: 'Session expired',
                            description: failure.isPrimary
                                ? 'Session expired. Re-authenticate your connection.'
                                : 'A secondary Stremio login expired. Re-authenticate it from its connection card.',
                            variant: 'destructive',
                            href: `/account/${encodeURIComponent(accountId)}`,
                        })
                    } else {
                        toast({
                            title: failure.isPrimary ? 'Sync failed' : 'Secondary Stremio sync failed',
                            description: failure.error instanceof Error ? failure.error.message : 'Unknown error',
                            variant: 'destructive',
                            href: `/account/${encodeURIComponent(accountId)}`,
                        })
                    }
                }
            })()
        )
    }

    promises.push(pushToConnections(accountId, { addons: updatedAddons, allowCollectionShrink: options?.allowCollectionShrink }).catch(err => { console.error('Failed to push to connections:', err) }))

    Promise.all(promises).finally(() => {
        triggerSync()
        getStore().then(store => {
            store.getState().syncAutopilotRules(accountId)
        }).catch(() => { })
    })
}

function updateActiveProfile(account: Account, updatedAddons: AddonDescriptor[]): Account {
    if (!account.activeProfileId || !account.profiles) return account
    return {
        ...account,
        profiles: account.profiles.map((p: AccountProfile) =>
            p.id === account.activeProfileId ? { ...p, addons: updatedAddons } : p
        ),
    }
}

export async function installAddonToAccount(accountId: string, addonUrl: string, savedMetadata?: AddonDescriptor['metadata'], options?: InstallAddonOptions) {
    const store = await getStore()
    const ownership = captureSyncOwnership()
    const guarded = makeInstallGuard(options, ownership)
    store.setState({ error: null })
    setAccountLoading(accountId)
    let releaseMutex: (() => void) | null = null
    try {
        releaseMutex = await acquireInstallMutex(accountId, options)
        guarded()
        const account = getAccountById(store.getState().accounts, accountId)
        if (!account) throw new Error('Account not found')

        const fetchedAddon = await apiFetchAddonManifest(addonUrl, account.id)
        guarded()
        if (!fetchedAddon) throw new Error('Failed to fetch addon manifest')

        const normalizedAddon: AddonDescriptor = {
            ...fetchedAddon,
            transportUrl: addonUrl,
            manifest: sanitizeAddonManifest(fetchedAddon.manifest, addonUrl),
            metadata: {
                ...fetchedAddon.metadata,
                ...savedMetadata,
                lastUpdated: Date.now(),
            },
        }

        const baseAddons = await reconcileInstallBase(account)
        guarded()
        // A sweep lift never replaces a newer config the hub already holds.
        if (options?.guard && liftBlockedByInstance(baseAddons, normalizedAddon)) {
            throw new InstallAbortedError(new Error('the hub already holds this instance under another url'))
        }
        const mergedAddons = mergeAddons(baseAddons, [normalizedAddon], { keepMissingLocal: true, instanceMatch: 'adopt-remote-url' })
        const finalAddons = dedupeAddonsByUrl(mergedAddons).map(addon => ({
            ...addon,
            manifest: getEffectiveManifest(addon)
        }))

        const deletionState = restoreAddonDeletions(account.deletedAddons, account.restoredAddons, [{ transportUrl: addonUrl }])
        let updatedAccount: Account = { ...account, addons: finalAddons, ...deletionState, lastSync: new Date() }
        updatedAccount = updateActiveProfile(updatedAccount, finalAddons)
        guarded()
        const accounts = store.getState().accounts.map((acc) => (acc.id === accountId ? updatedAccount : acc))
        store.setState({ accounts })
        persistAccounts(accounts)

        // An install is a plain user push: the hub row lands on every destination (rule 1).
        backgroundSync(accountId, account, finalAddons)

        const { useAddonStore } = await import('@/store/addonStore')
        await useAddonStore.getState().syncAccountState(accountId, getStremioAuthKey(account), finalAddons).catch(e => { if (import.meta.env.DEV) console.error(e) })

        const installedAddon = finalAddons.find(a => normalizeAddonUrl(a.transportUrl) === normalizeAddonUrl(addonUrl))
        if (installedAddon) {
            await store.getState().addChangelogEntry({
                accountId,
                addonId: installedAddon.manifest.id,
                addonUrl: installedAddon.transportUrl,
                addonName: installedAddon.metadata?.customName || installedAddon.manifest.name,
                addonLogo: installedAddon.metadata?.customLogo || installedAddon.manifest.logo,
                action: 'installed'
            })
        }
    } catch (error) {
        if (!(error instanceof InstallAbortedError || error instanceof SyncOwnershipLostError)) {
            const message = error instanceof Error ? error.message : 'Failed to install addon'
            store.setState({ error: message })
        }
        throw error
    } finally {
        releaseMutex?.()
        clearAccountLoading(accountId)
    }
}

export async function installAddonsToAccount(accountId: string, addonUrls: string[], concurrency = 4) {
    const store = await getStore()
    if (addonUrls.length === 0) return { successCount: 0, failCount: 0 }
    store.setState({ error: null })
    setAccountLoading(accountId)
    const releaseMutex = await acquireSyncMutex(accountId)
    try {
        const account = getAccountById(store.getState().accounts, accountId)
        if (!account) throw new Error('Account not found')

        const manifestResults = await mapConcurrent(addonUrls, concurrency, async (addonUrl) => {
            try {
                return { addonUrl, addon: await apiFetchAddonManifest(addonUrl, account.id) }
            } catch (error) {
                if (import.meta.env.DEV) console.error(`Failed to fetch addon ${addonUrl}:`, error)
                return { addonUrl, addon: null }
            }
        })

        const fetchedAddons: AddonDescriptor[] = []
        manifestResults.forEach(result => {
            if (result.addon) fetchedAddons.push(result.addon)
        })

        if (fetchedAddons.length === 0) {
            return { successCount: 0, failCount: addonUrls.length }
        }

        const now = Date.now()

        const updatedAddons = [...await reconcileInstallBase(account)]
        const preExisting = updatedAddons.length
        const taken = new Set<number>()
        fetchedAddons.forEach((newAddon) => {
            const normalized: AddonDescriptor = {
                ...newAddon,
                manifest: sanitizeAddonManifest(newAddon.manifest, newAddon.transportUrl),
                metadata: { ...newAddon.metadata, lastUpdated: now },
            }
            const existingIndex = findInstallSlot(updatedAddons, newAddon, preExisting, taken)
            if (existingIndex >= 0) {
                taken.add(existingIndex)
                const existing = updatedAddons[existingIndex]
                updatedAddons[existingIndex] = {
                    ...normalized,
                    flags: { ...existing.flags, ...normalized.flags },
                    metadata: { ...existing.metadata, ...normalized.metadata },
                    catalogOverrides: existing.catalogOverrides,
                    // A fresh manifest fetch carries no destination policy; the
                    // hub row's stored policy survives every reinstall (R1).
                    destinations: existing.destinations ?? normalized.destinations,
                }
            } else {
                updatedAddons.push(normalized)
            }
        })

        const finalAddons = dedupeAddonsByUrl(updatedAddons).map(addon => ({
            ...addon,
            manifest: getEffectiveManifest(addon)
        }))

        const deletionState = restoreAddonDeletions(account.deletedAddons, account.restoredAddons, fetchedAddons)
        let updatedAccount: Account = { ...account, addons: finalAddons, ...deletionState, lastSync: new Date() }
        updatedAccount = updateActiveProfile(updatedAccount, finalAddons)
        const accounts = store.getState().accounts.map((acc) => (
            acc.id === accountId ? updatedAccount : acc
        ))
        store.setState({ accounts })
        persistAccounts(accounts)

        // A batch install is a plain user push of the new hub rows (rule 1).
        backgroundSync(accountId, account, finalAddons)

        const { useAddonStore } = await import('@/store/addonStore')
        await useAddonStore.getState().syncAccountState(accountId, getStremioAuthKey(account), finalAddons).catch(e => { if (import.meta.env.DEV) console.error(e) })

        for (const fetchedAddon of fetchedAddons) {
            const installedAddon = finalAddons.find(a => normalizeAddonUrl(a.transportUrl) === normalizeAddonUrl(fetchedAddon.transportUrl))
            if (installedAddon) {
                await store.getState().addChangelogEntry({
                    accountId,
                    addonId: installedAddon.manifest.id,
                    addonUrl: installedAddon.transportUrl,
                    addonName: installedAddon.metadata?.customName || installedAddon.manifest.name,
                    addonLogo: installedAddon.metadata?.customLogo || installedAddon.manifest.logo,
                    action: 'installed'
                })
            }
        }

        return { successCount: fetchedAddons.length, failCount: addonUrls.length - fetchedAddons.length }
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to install addons'
        store.setState({ error: message })
        throw error
    } finally {
        releaseMutex()
        clearAccountLoading(accountId)
    }
}

export async function removeAddonFromAccount(accountId: string, transportUrl: string) {
    const store = await getStore()
    store.setState({ error: null })
    setAccountLoading(accountId)
    const releaseMutex = await acquireSyncMutex(accountId)
    try {
        const account = getAccountById(store.getState().accounts, accountId)
        if (!account) throw new Error('Account not found')

        syncManager.addPendingRemoval(accountId, transportUrl)

        try {
            const { useFailoverStore } = await import('@/store/failoverStore')
            await useFailoverStore.getState().removeUrlFromRules(accountId, transportUrl)
        } catch (e) {
            if (import.meta.env.DEV) console.warn('[RemoveAddon] Failover chain cleanup failed:', e)
        }

        const removedAddon = account.addons.find(a => normalizeAddonUrl(a.transportUrl) === normalizeAddonUrl(transportUrl))
        const updatedAddons = account.addons.filter(
            (a) => normalizeAddonUrl(a.transportUrl) !== normalizeAddonUrl(transportUrl)
        )

        let updatedAccount: Account = { ...account, addons: updatedAddons, deletedAddons: addTombstones(account.deletedAddons, [transportUrl], Date.now(), account.restoredAddons), lastSync: new Date() }
        updatedAccount = updateActiveProfile(updatedAccount, updatedAddons)
        const accounts = store.getState().accounts.map((acc) => (acc.id === accountId ? updatedAccount : acc))
        store.setState({ accounts })
        persistAccounts(accounts)
        queueAddonActionDeletes(accountId, addonDeleteAcks(updatedAccount.deletedAddons, [transportUrl]), captureSyncOwnership())

        backgroundSync(accountId, account, updatedAddons, { allowCollectionShrink: true }, 'remove')

        const removedAddonName = removedAddon?.metadata?.customName || removedAddon?.manifest.name || 'Unknown Addon'
        const removedAddonLogo = removedAddon?.metadata?.customLogo || removedAddon?.manifest.logo

        await store.getState().addChangelogEntry({
            accountId,
            addonId: transportUrl,
            addonUrl: transportUrl,
            addonName: removedAddonName,
            addonLogo: removedAddonLogo,
            action: 'removed'
        })
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to remove addon'
        store.setState({ error: message })
        throw error
    } finally {
        releaseMutex()
        clearAccountLoading(accountId)
        setTimeout(() => syncManager.removePendingRemoval(accountId, transportUrl), 5000)
    }
}

export type { RemoveAddonByIndexResult }

export async function removeAddonByIndexFromAccount(accountId: string, index: number, expectedTransportUrl?: string): Promise<RemoveAddonByIndexResult> {
    const store = await getStore()
    store.setState({ error: null })
    setAccountLoading(accountId)
    let transportUrl = ''
    const releaseMutex = await acquireSyncMutex(accountId)
    try {
        const account = getAccountById(store.getState().accounts, accountId)
        if (!account) throw new Error('Account not found')

        const resolvedIndex = resolveRemovalIndex(account.addons, index, expectedTransportUrl)
        if (resolvedIndex < 0) {
            if (expectedTransportUrl) return 'already-gone'
            throw new Error('Addon not found at index')
        }
        const addonToRemove = account.addons[resolvedIndex]

        transportUrl = addonToRemove.transportUrl
        syncManager.addPendingRemoval(accountId, transportUrl)

        try {
            const { useFailoverStore } = await import('@/store/failoverStore')
            await useFailoverStore.getState().removeUrlFromRules(accountId, transportUrl)
        } catch (e) {
            if (import.meta.env.DEV) console.warn('[RemoveByIndex] Failover chain cleanup failed:', e)
        }

        if (addonToRemove.flags?.protected) {
            throw new Error(
                `Addon "${addonToRemove.manifest.name}" is protected and cannot be removed.`
            )
        }

        const updatedAddons = [...account.addons]
        updatedAddons.splice(resolvedIndex, 1)

        let updatedAccount: Account = { ...account, addons: updatedAddons, deletedAddons: addTombstones(account.deletedAddons, [transportUrl], Date.now(), account.restoredAddons), lastSync: new Date() }
        updatedAccount = updateActiveProfile(updatedAccount, updatedAddons)
        const accounts = store.getState().accounts.map((acc) => (acc.id === accountId ? updatedAccount : acc))
        store.setState({ accounts })
        persistAccounts(accounts)
        queueAddonActionDeletes(accountId, addonDeleteAcks(updatedAccount.deletedAddons, [transportUrl]), captureSyncOwnership())

        await store.getState().addChangelogEntry({
            accountId,
            addonId: transportUrl,
            addonUrl: transportUrl,
            addonName: addonToRemove.metadata?.customName || addonToRemove.manifest.name,
            addonLogo: addonToRemove.metadata?.customLogo || addonToRemove.manifest.logo,
            action: 'removed'
        })

        backgroundSync(accountId, account, updatedAddons, { allowCollectionShrink: true }, 'remove-index')
        return 'removed'
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to remove addon'
        store.setState({ error: message })
        throw error
    } finally {
        releaseMutex()
        clearAccountLoading(accountId)
        setTimeout(() => syncManager.removePendingRemoval(accountId, transportUrl), 5000)
    }
}

export async function reorderAddons(accountId: string, newOrder: AddonDescriptor[], options: { explicitInstallUrls?: string[] } = {}) {
    const store = await getStore()
    // Reorder is also a repair boundary: stale platform reads can hand us the
    // same URL more than once. Preserve the first occurrence's position so a
    // save cannot make the duplicate permanent or shuffle the user's order.
    const seenUrls = new Map<string, number>()
    const uniqueOrder: AddonDescriptor[] = []
    newOrder.forEach(addon => {
        const key = normalizeAddonUrl(addon.transportUrl)
        if (!key) {
            uniqueOrder.push(addon)
            return
        }
        const existingIndex = seenUrls.get(key)
        if (existingIndex === undefined) {
            seenUrls.set(key, uniqueOrder.length)
            uniqueOrder.push(addon)
            return
        }
        const existing = uniqueOrder[existingIndex]
        uniqueOrder[existingIndex] = {
            ...existing,
            ...addon,
            transportUrl: addon.transportUrl || existing.transportUrl,
            flags: { ...(addon.flags || {}), ...(existing.flags || {}) },
            metadata: { ...(existing.metadata || {}), ...(addon.metadata || {}) },
            catalogOverrides: addon.catalogOverrides || existing.catalogOverrides,
            note: addon.note ?? existing.note,
        }
    })
    const timestampedOrder = uniqueOrder.map(addon => ({
        ...addon,
        metadata: {
            ...addon.metadata,
            lastUpdated: Date.now()
        }
    }))

    store.setState({ error: null })
    setAccountLoading(accountId)
    const releaseMutex = await acquireSyncMutex(accountId)
    try {
        const account = getAccountById(store.getState().accounts, accountId)
        if (!account) throw new Error('Account not found')

        // Collection clones explicitly install their source URLs. Ordinary reorders
        // pass no install intent, so stale list membership cannot cancel a deletion.
        const explicitUrls = new Set((options.explicitInstallUrls || []).map(normalizeAddonUrl))
        const explicitAddons = timestampedOrder.filter(addon => explicitUrls.has(normalizeAddonUrl(addon.transportUrl)))
        const deletionState = restoreAddonDeletions(account.deletedAddons, account.restoredAddons, explicitAddons)
        const finalOrder = filterResurrected(timestampedOrder, [], deletionState.deletedAddons)
        if (options.explicitInstallUrls !== undefined) {
            const keptUrls = new Set(finalOrder.map(addon => normalizeAddonUrl(addon.transportUrl)))
            const removedUrls = account.addons
                .filter(addon => !keptUrls.has(normalizeAddonUrl(addon.transportUrl)))
                .map(addon => addon.transportUrl)
            deletionState.deletedAddons = addTombstones(deletionState.deletedAddons, removedUrls, Date.now(), deletionState.restoredAddons)
            queueAddonActionDeletes(accountId, addonDeleteAcks(deletionState.deletedAddons, removedUrls), captureSyncOwnership())
        }
        let updatedAccount: Account = { ...account, addons: finalOrder, ...deletionState, lastSync: new Date() }
        updatedAccount = updateActiveProfile(updatedAccount, finalOrder)
        const accounts = store.getState().accounts.map((acc) => (acc.id === accountId ? updatedAccount : acc))
        store.setState({ accounts })
        persistAccounts(accounts)

        // A collection import is a plain user push of its rows (rule 1); the tombstones
        // above already guard the removals it replaced.
        backgroundSync(accountId, account, finalOrder, { allowCollectionShrink: true }, 'reorder')
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to reorder addons'
        store.setState({ error: message })
        throw error
    } finally {
        releaseMutex()
        clearAccountLoading(accountId)
    }
}

export async function bulkDeleteAddons(accountId: string, keptAddons: AddonDescriptor[], removedUrls: string[]) {
    const store = await getStore()
    store.setState({ error: null })
    setAccountLoading(accountId)
    const releaseMutex = await acquireSyncMutex(accountId)
    try {
        const account = getAccountById(store.getState().accounts, accountId)
        if (!account) throw new Error('Account not found')

        const timestamped = keptAddons.map(addon => ({ ...addon, metadata: { ...addon.metadata, lastUpdated: Date.now() } }))
        let updatedAccount: Account = { ...account, addons: timestamped, deletedAddons: addTombstones(account.deletedAddons, removedUrls, Date.now(), account.restoredAddons), lastSync: new Date() }
        updatedAccount = updateActiveProfile(updatedAccount, timestamped)
        const accounts = store.getState().accounts.map((acc) => (acc.id === accountId ? updatedAccount : acc))
        store.setState({ accounts })
        persistAccounts(accounts)
        queueAddonActionDeletes(accountId, addonDeleteAcks(updatedAccount.deletedAddons, removedUrls), captureSyncOwnership())

        try {
            const { useFailoverStore } = await import('@/store/failoverStore')
            for (const url of removedUrls) {
                await useFailoverStore.getState().removeUrlFromRules(accountId, url)
            }
        } catch (e) {
            if (import.meta.env.DEV) console.warn('[BulkDelete] Failover chain cleanup failed:', e)
        }

        backgroundSync(accountId, account, timestamped, { allowCollectionShrink: true }, 'bulk-delete')
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to delete addons'
        store.setState({ error: message })
        throw error
    } finally {
        releaseMutex()
        clearAccountLoading(accountId)
    }
}

export async function toggleAddonProtection(accountId: string, transportUrl: string, isProtected: boolean, targetIndex?: number) {
    const store = await getStore()
    const releaseMutex = await acquireSyncMutex(accountId)
    const account = getAccountById(store.getState().accounts, accountId)
    if (!account) { releaseMutex(); return }
    const prevAccounts = store.getState().accounts
    try {
        const updatedAddons = account.addons.map((addon, index) =>
            (targetIndex !== undefined ? index === targetIndex : normalizeAddonUrl(addon.transportUrl) === normalizeAddonUrl(transportUrl))
                ? { ...addon, flags: { ...addon.flags, protected: isProtected } }
                : addon
        )
        const updatedAccount = updateActiveProfile({ ...account, addons: updatedAddons }, updatedAddons)
        const accounts = store.getState().accounts.map((acc) =>
            acc.id === accountId ? updatedAccount : acc
        )
        store.setState({ accounts })
        persistAccounts(accounts)
        backgroundSync(accountId, account, updatedAddons)
    } catch (e) {
        store.setState({ accounts: prevAccounts })
        persistAccounts(prevAccounts)
        throw e
    } finally {
        releaseMutex()
    }
}

export async function toggleAddonEnabled(accountId: string, transportUrl: string, isEnabled: boolean, silent = false, targetIndex?: number, isAutopilot = false) {
    const store = await getStore()
    const releaseMutex = await acquireSyncMutex(accountId)
    try {
        const account = getAccountById(store.getState().accounts, accountId)
        if (!account) return
        const updatedAddons = account.addons.map((addon, index) =>
            (targetIndex !== undefined ? index === targetIndex : normalizeAddonUrl(addon.transportUrl) === normalizeAddonUrl(transportUrl))
                ? {
                    ...addon,
                    flags: { ...addon.flags, enabled: isEnabled },
                    metadata: { ...addon.metadata, lastUpdated: Date.now() }
                }
                : addon
        )

        const updatedAccount = updateActiveProfile({ ...account, addons: updatedAddons }, updatedAddons)
        store.setState(state => ({
            accounts: state.accounts.map(acc => acc.id === accountId ? updatedAccount : acc)
        }))
        persistAccounts(store.getState().accounts)

        if (!silent) {
            backgroundSync(accountId, account, updatedAddons)
        }

        if (!isAutopilot) {
            autopilotManager.handleManualToggle(accountId, transportUrl)
        }
    } finally {
        releaseMutex()
    }
}

export async function bulkToggleAddonEnabled(accountId: string, addonUrls: string[], isEnabled: boolean) {
    const store = await getStore()
    const releaseMutex = await acquireSyncMutex(accountId)
    try {
        const account = getAccountById(store.getState().accounts, accountId)
        if (!account) return
        const targetUrls = new Set(addonUrls.map(u => normalizeAddonUrl(u)))

        const updatedAddons = account.addons.map((addon) =>
            targetUrls.has(normalizeAddonUrl(addon.transportUrl))
                ? {
                    ...addon,
                    flags: { ...addon.flags, enabled: isEnabled },
                    metadata: { ...addon.metadata, lastUpdated: Date.now() }
                }
                : addon
        )

        const updatedAccount = updateActiveProfile({ ...account, addons: updatedAddons }, updatedAddons)
        const accounts = store.getState().accounts.map((acc) =>
            acc.id === accountId ? updatedAccount : acc
        )
        store.setState({ accounts })
        persistAccounts(accounts)

        backgroundSync(accountId, account, updatedAddons, { allowCollectionShrink: !isEnabled }, 'toggle-bulk')

        addonUrls.forEach(url => {
            autopilotManager.handleManualToggle(accountId, url)
        })
    } finally {
        releaseMutex()
    }
}

export async function reinstallAddon(accountId: string, transportUrl: string) {
    const store = await getStore()
    store.setState({ error: null })
    setAccountLoading(accountId)

    const timeoutId = setTimeout(() => {
        if (store.getState().loadingAccounts.has(accountId)) {
            clearAccountLoading(accountId)
            store.setState({ error: 'Addon reinstall timed out. It may still complete in the background.' })
        }
    }, 30000)

    const releaseMutex = await acquireSyncMutex(accountId)
    try {
        const account = getAccountById(store.getState().accounts, accountId)
        if (!account) throw new Error('Account not found')

        const { reinstallAddon: apiReinstallAddon } = await import('@/api/addons')
        const authKey = await getCachedAuthKey(getStremioAuthKey(account), getEncryptionKey())

        const { updatedAddon } = await apiReinstallAddon(authKey, transportUrl, accountId)

        const updatedAddons = account.addons.map((addon) => {
            if (normalizeAddonUrl(addon.transportUrl) === normalizeAddonUrl(transportUrl)) {
                return {
                    ...addon,
                    catalogOverrides: undefined,
                    manifest: getEffectiveManifest({
                        ...addon,
                        catalogOverrides: undefined,
                        manifest: updatedAddon?.manifest || addon.manifest
                    }),
                    metadata: { ...addon.metadata, lastUpdated: Date.now() }
                }
            }
            return addon
        })

        let updatedAccount: Account = { ...account, addons: updatedAddons, lastSync: new Date() }
        updatedAccount = updateActiveProfile(updatedAccount, updatedAddons)
        const accounts = store.getState().accounts.map((acc) =>
            acc.id === accountId ? updatedAccount : acc
        )
        store.setState({ accounts })
        persistAccounts(accounts)

        backgroundSync(accountId, account, updatedAddons)

        const { useAddonStore } = await import('@/store/addonStore')
        await useAddonStore.getState().syncAccountState(accountId, getStremioAuthKey(account), updatedAddons).catch(e => { if (import.meta.env.DEV) console.error(e) })

        if (updatedAddon?.manifest?.id && updatedAddon?.manifest?.version) {
            const { useAddonStore: addonStoreForVersions } = await import('@/store/addonStore')
            addonStoreForVersions.getState().updateLatestVersions({
                [updatedAddon.manifest.id]: updatedAddon.manifest.version,
                [getAddonVersionKey({
                    transportUrl,
                    manifest: updatedAddon.manifest,
                })]: updatedAddon.manifest.version,
            })
        }

        if (updatedAddon) {
            const addonStore = useAddonStore.getState()
            const normUrl = normalizeAddonUrl(transportUrl)

            const savedAddonId = Object.keys(addonStore.library).find(
                id => normalizeAddonUrl(addonStore.library[id].installUrl) === normUrl
            )

            if (savedAddonId) {
                const savedAddon = addonStore.library[savedAddonId]
                const freshManifest = updatedAddon.manifest
                await addonStore.updateSavedAddon(savedAddonId, {
                    manifest: getEffectiveManifest({ ...savedAddon, manifest: freshManifest }),
                })
            }
        }

        if (updatedAddon) {
            await store.getState().addChangelogEntry({
                accountId,
                addonId: updatedAddon.manifest.id,
                addonUrl: updatedAddon.transportUrl,
                addonName: updatedAddon.metadata?.customName || updatedAddon.manifest.name,
                addonLogo: updatedAddon.metadata?.customLogo || updatedAddon.manifest.logo,
                action: 'updated'
            })
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to reinstall addon'
        store.setState({ error: message })
        throw error
    } finally {
        releaseMutex()
        clearTimeout(timeoutId)
        clearAccountLoading(accountId)
    }
}

export async function reinstallAddons(accountId: string, transportUrls: string[], concurrency = 4, onProgress?: (current: number, total: number) => void) {
    const store = await getStore()
    if (transportUrls.length === 0) return { successCount: 0, failCount: 0 }
    store.setState({ error: null })
    setAccountLoading(accountId)
    const releaseMutex = await acquireSyncMutex(accountId)
    try {
        const account = getAccountById(store.getState().accounts, accountId)
        if (!account) throw new Error('Account not found')

        let completedCount = 0
        const manifestResults = await mapConcurrent(transportUrls, concurrency, async (transportUrl) => {
            try {
                return { transportUrl, addon: await apiFetchAddonManifest(transportUrl, accountId, true) }
            } catch (error) {
                if (import.meta.env.DEV) console.warn(`Failed to reinstall addon ${transportUrl}:`, error)
                return { transportUrl, addon: null }
            } finally {
                completedCount++
                if (onProgress) onProgress(completedCount, transportUrls.length)
            }
        })

        const freshByUrl = new Map<string, AddonDescriptor>()
        manifestResults.forEach(result => {
            if (result.addon) {
                freshByUrl.set(normalizeAddonUrl(result.transportUrl), result.addon)
            }
        })

        if (freshByUrl.size === 0) {
            return { successCount: 0, failCount: transportUrls.length }
        }

        const now = Date.now()
        const latestVersions: Record<string, string> = {}
        const updatedAddons = account.addons.map((addon) => {
            const updatedAddon = freshByUrl.get(normalizeAddonUrl(addon.transportUrl))
            if (!updatedAddon) return addon

            if (updatedAddon.manifest?.id && updatedAddon.manifest?.version) {
                latestVersions[updatedAddon.manifest.id] = updatedAddon.manifest.version
                latestVersions[getAddonVersionKey({
                    transportUrl: addon.transportUrl,
                    manifest: updatedAddon.manifest,
                })] = updatedAddon.manifest.version
            }

            return {
                ...addon,
                manifest: getEffectiveManifest({
                    ...addon,
                    manifest: updatedAddon.manifest || addon.manifest
                }),
                metadata: { ...addon.metadata, lastUpdated: now }
            }
        })

        let updatedAccount: Account = { ...account, addons: updatedAddons, lastSync: new Date() }
        updatedAccount = updateActiveProfile(updatedAccount, updatedAddons)
        const accounts = store.getState().accounts.map((acc) =>
            acc.id === accountId ? updatedAccount : acc
        )
        store.setState({ accounts })
        persistAccounts(accounts)

        backgroundSync(accountId, account, updatedAddons)

        const { useAddonStore } = await import('@/store/addonStore')
        const addonStore = useAddonStore.getState()
        await addonStore.syncAccountState(accountId, getStremioAuthKey(account), updatedAddons).catch(e => { if (import.meta.env.DEV) console.error(e) })

        if (Object.keys(latestVersions).length > 0) {
            addonStore.updateLatestVersions(latestVersions)
        }

        for (const [normUrl, updatedAddon] of freshByUrl) {
            const latestAddonStore = useAddonStore.getState()
            const savedAddonId = Object.keys(latestAddonStore.library).find(
                id => normalizeAddonUrl(latestAddonStore.library[id].installUrl) === normUrl
            )

            if (savedAddonId) {
                const savedAddon = latestAddonStore.library[savedAddonId]
                await latestAddonStore.updateSavedAddon(savedAddonId, {
                    manifest: getEffectiveManifest({ ...savedAddon, manifest: updatedAddon.manifest }),
                })
            }

            await store.getState().addChangelogEntry({
                accountId,
                addonId: updatedAddon.manifest.id,
                addonUrl: updatedAddon.transportUrl,
                addonName: updatedAddon.metadata?.customName || updatedAddon.manifest.name,
                addonLogo: updatedAddon.metadata?.customLogo || updatedAddon.manifest.logo,
                action: 'updated'
            })
        }

        return { successCount: freshByUrl.size, failCount: transportUrls.length - freshByUrl.size }
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to reinstall addons'
        store.setState({ error: message })
        throw error
    } finally {
        releaseMutex()
        clearAccountLoading(accountId)
    }
}

export async function updateAddonSettings(
    accountId: string,
    transportUrl: string,
    settings: {
        metadata?: { customName?: string; customLogo?: string; customDescription?: string; syncToLibrary?: boolean; hideConfigure?: boolean },
        catalogOverrides?: AddonDescriptor['catalogOverrides'],
        manifest?: AddonDescriptor['manifest'],
        note?: string,
        destinations?: AddonDescriptor['destinations'] | null,
    },
    targetIndex?: number
) {
    const ownerIsCurrent = captureAddonOwner()
    const store = await getStore()
    // Read AFTER the mutex: a sync that publishes while this op waits on the
    // lock must not be clobbered by a pre-await snapshot of account.addons.
    const releaseMutex = await acquireSyncMutex(accountId)
    try {
        if (!ownerIsCurrent()) return
        const account = getAccountById(store.getState().accounts, accountId)
        if (!account) return
        const updatedAddons = await Promise.all(account.addons.map(async (addon, index) => {
            if (targetIndex !== undefined ? index === targetIndex : normalizeAddonUrl(addon.transportUrl) === normalizeAddonUrl(transportUrl)) {
                const newAddon = { ...addon }

                if ('note' in settings) {
                    newAddon.note = settings.note || undefined
                }

                if ('destinations' in settings) {
                    // Absent/empty/cleared policy collapses to "sync everywhere" —
                    // the field disappears rather than lingering as an empty object.
                    const normalized = normalizeDestinations(settings.destinations)
                    if (normalized) newAddon.destinations = normalized
                    else delete newAddon.destinations
                }

                const clearedFields: string[] = []
                if (settings.metadata) {
                    const cleanMetadata = { ...(addon.metadata || {}) } as Record<string, unknown>
                    const settingsMetadata = settings.metadata as Record<string, unknown>
                    Object.keys(settingsMetadata).forEach((k) => {
                        if (settingsMetadata[k] === undefined) {
                            delete cleanMetadata[k]
                            clearedFields.push(k)
                        }
                        else cleanMetadata[k] = settingsMetadata[k]
                    })
                    newAddon.metadata = cleanMetadata

                    const customFields = addon.metadata as Partial<Record<'customName' | 'customLogo' | 'customDescription', string>> | undefined
                    let storedOriginal = addon.metadata?.originalManifest
                    if (!isPlaceholderManifest(addon.manifest)) {
                        storedOriginal = captureOriginalDetails(addon.manifest, customFields, storedOriginal, settingsMetadata)
                    }

                    const plan = planDetailReset(clearedFields, customFields, storedOriginal)
                    if (plan.resetFields.length > 0) {
                        let remoteOriginal: AddonDescriptor['manifest'] | null = null
                        if (plan.needsRemote) {
                            remoteOriginal = getCachedManifest(addon.transportUrl)
                            if (!remoteOriginal) {
                                try {
                                    const fetched = await apiFetchAddonManifest(addon.transportUrl, accountId, true)
                                    remoteOriginal = fetched.manifest
                                    setCachedManifest(addon.transportUrl, remoteOriginal)
                                } catch (e) {
                                    if (import.meta.env.DEV) console.warn('[Reset] Could not fetch original manifest:', e)
                                }
                            }
                            if (!remoteOriginal) {
                                throw new Error('Could not restore the original details because the addon host is unreachable. Nothing was changed; try again when it is online.')
                            }
                        }
                        const reset = applyDetailReset(newAddon.manifest, plan.resetFields, storedOriginal, remoteOriginal)
                        newAddon.manifest = reset.manifest
                        storedOriginal = reset.stored
                    }
                    const nextMetadata = { ...cleanMetadata } as NonNullable<AddonDescriptor['metadata']>
                    if (storedOriginal && Object.keys(storedOriginal).length > 0) nextMetadata.originalManifest = storedOriginal
                    else delete nextMetadata.originalManifest
                    newAddon.metadata = nextMetadata

                    newAddon.manifest = getEffectiveManifest(newAddon)
                }

                if (settings.catalogOverrides) {
                    newAddon.catalogOverrides = settings.catalogOverrides
                    newAddon.manifest = getEffectiveManifest(newAddon)
                }

                if (settings.manifest) {
                    newAddon.manifest = settings.manifest
                    newAddon.catalogOverrides = undefined
                    if (newAddon.metadata) {
                        const { customName: _cn, customLogo: _cl, customDescription: _cd, ...restMeta } = newAddon.metadata
                        newAddon.metadata = restMeta as typeof newAddon.metadata
                    }
                    if (newAddon.metadata?.cinemetaConfig) {
                        newAddon.manifest = getEffectiveManifest(newAddon)
                    }
                }

                return newAddon
            }
            return addon
        }))
        if (!ownerIsCurrent()) return
        const accounts = store.getState().accounts.map((acc) =>
            acc.id === accountId ? updateActiveProfile({ ...acc, addons: updatedAddons }, updatedAddons) : acc
        )
        store.setState({ accounts })
        persistAccounts(accounts)
        backgroundSync(accountId, account, updatedAddons)
    } finally {
        releaseMutex()
    }
}

export async function bulkProtectAddons(accountId: string, isProtected: boolean) {
    const ownerIsCurrent = captureAddonOwner()
    const store = await getStore()
    const releaseMutex = await acquireSyncMutex(accountId)
    try {
        if (!ownerIsCurrent()) return 0
        const account = getAccountById(store.getState().accounts, accountId)
        if (!account) return 0
        const changedCount = account.addons.filter((addon) => Boolean(addon.flags?.protected) !== isProtected).length
        if (changedCount === 0) return 0
        const updatedAddons = account.addons.map((a) => ({
            ...a,
            flags: { ...a.flags, protected: isProtected },
        }))
        const accounts = store.getState().accounts.map((acc) =>
            acc.id === accountId ? updateActiveProfile({ ...acc, addons: updatedAddons }, updatedAddons) : acc
        )
        store.setState({ accounts })
        persistAccounts(accounts)
        backgroundSync(accountId, account, updatedAddons)
        return changedCount
    } finally {
        releaseMutex()
    }
}

export async function bulkProtectSelectedAddons(accountId: string, transportUrls: string[], isProtected: boolean) {
    const ownerIsCurrent = captureAddonOwner()
    const store = await getStore()
    const releaseMutex = await acquireSyncMutex(accountId)
    try {
        if (!ownerIsCurrent()) return 0
        const account = getAccountById(store.getState().accounts, accountId)
        if (!account) return 0
        const normalizedTargets = new Set(transportUrls.map((u) => normalizeAddonUrl(u)))
        const changedCount = account.addons.filter((a) =>
            normalizedTargets.has(normalizeAddonUrl(a.transportUrl)) &&
            Boolean(a.flags?.protected) !== isProtected
        ).length
        if (changedCount === 0) return 0
        const updatedAddons = account.addons.map((a) =>
            normalizedTargets.has(normalizeAddonUrl(a.transportUrl))
                ? { ...a, flags: { ...a.flags, protected: isProtected } }
                : a
        )
        const accounts = store.getState().accounts.map((acc) =>
            acc.id === accountId ? updateActiveProfile({ ...acc, addons: updatedAddons }, updatedAddons) : acc
        )
        store.setState({ accounts })
        persistAccounts(accounts)
        backgroundSync(accountId, account, updatedAddons)
        return changedCount
    } finally {
        releaseMutex()
    }
}

export async function removeLocalAddons(accountId: string, idsOrUrls: string[]) {
    const store = await getStore()
    const releaseMutex = await acquireSyncMutex(accountId)
    try {
        const account = getAccountById(store.getState().accounts, accountId)
        if (!account) return

        const removedUrls: string[] = []
        const updatedAddons = account.addons.filter((addon) => {
            const normA = normalizeAddonUrl(addon.transportUrl)
            const shouldRemove = idsOrUrls.some((target) => {
                const normTarget = normalizeAddonUrl(target)
                return addon.manifest.id === target || normA === normTarget
            })
            if (shouldRemove) {
                removedUrls.push(addon.transportUrl)
            }
            return !shouldRemove
        })

        const updatedAccount = updateActiveProfile({ ...account, addons: updatedAddons, deletedAddons: addTombstones(account.deletedAddons, [...removedUrls], Date.now(), account.restoredAddons) }, updatedAddons)
        const accounts = store.getState().accounts.map((acc) =>
            acc.id === accountId ? updatedAccount : acc
        )
        store.setState({ accounts })
        persistAccounts(accounts)
        queueAddonActionDeletes(accountId, addonDeleteAcks(updatedAccount.deletedAddons, removedUrls), captureSyncOwnership())

        try {
            const { useFailoverStore } = await import('@/store/failoverStore')
            for (const url of removedUrls) {
                await useFailoverStore.getState().removeUrlFromRules(accountId, url)
            }
        } catch (e) {
            if (import.meta.env.DEV) console.warn('[LocalRemove] Failover chain cleanup failed:', e)
        }

        backgroundSync(accountId, account, updatedAddons, { allowCollectionShrink: true }, 'local-remove')
    } finally {
        releaseMutex()
    }
}

// A function merges into the copy's metadata as read under the account mutex.
export type ReplaceMetadata = AddonDescriptor['metadata'] | ((current: AddonDescriptor['metadata']) => AddonDescriptor['metadata'])

export async function replaceTransportUrl(oldUrl: string, newUrl: string, accountId?: string, freshManifest?: AddonDescriptor['manifest'], metadata?: ReplaceMetadata) {
    const ownerIsCurrent = captureAddonOwner()
    const store = await getStore()
    const normOld = normalizeAddonUrl(oldUrl)
    const normNew = normalizeAddonUrl(newUrl)

    // Candidate ids from the CURRENT state are advisory only: the authoritative
    // read happens under each account's mutex below, so a replacement that
    // waited behind a long in-flight sync rebases onto that sync's result
    // instead of clobbering it with a pre-await snapshot (and vice versa).
    const candidateIds = store.getState().accounts
        .filter(account => (!accountId || account.id === accountId)
            && account.addons.some(a => normalizeAddonUrl(a.transportUrl) === normOld))
        .map(account => account.id)

    // Each account is replaced under its own mutex and ONLY that mutex: no task
    // ever holds one account's lock while awaiting another's, so a global
    // replacement cannot deadlock against syncs or other multi-account ops, and
    // an unlocked account is replaced immediately even while another account's
    // sync is still mid-network. backgroundSync, persistAccounts and
    // addChangelogEntry never take the mutex, so nothing called under the lock
    // re-enters it.
    const outcomes = await Promise.all(candidateIds.map(async (candidateId): Promise<string | null> => {
        const releaseMutex = await acquireSyncMutex(candidateId)
        try {
            if (!ownerIsCurrent()) return null
            const account = getAccountById(store.getState().accounts, candidateId)
            // The account may have been removed (or its whole store swapped for a
            // workspace/vault flip) while this replacement waited on the mutex:
            // re-check against fresh state, never resurrect the stale snapshot.
            if (!account) return null
            // A serialized predecessor (sync, removal, another replacement) may
            // already have removed or replaced the old URL — follow existing
            // semantics and skip rather than force anything.
            if (!account.addons.some(a => normalizeAddonUrl(a.transportUrl) === normOld)) return null

            const previousAddons = account.addons
            const updatedAddons = account.addons.map(addon => {
                if (normalizeAddonUrl(addon.transportUrl) === normOld) {
                    return {
                        ...addon,
                        transportUrl: newUrl,
                        manifest: freshManifest || addon.manifest,
                        metadata: { ...(typeof metadata === 'function' ? metadata(addon.metadata) : (metadata || addon.metadata)), lastUpdated: Date.now() }
                    }
                }
                return addon
            })

            const deletionState = normOld !== normNew
                ? restoreAddonDeletions(account.deletedAddons, account.restoredAddons, [{ transportUrl: newUrl }])
                : {}
            const updatedAccount = updateActiveProfile({ ...account, addons: updatedAddons, ...deletionState, lastSync: new Date() }, updatedAddons)
            const accounts = store.getState().accounts.map((acc) =>
                acc.id === candidateId ? updatedAccount : acc
            )
            store.setState({ accounts })
            persistAccounts(accounts)

            backgroundSync(candidateId, updatedAccount, updatedAccount.addons)

            if (normOld !== normNew) {
                const previousAddon = previousAddons.find(
                    (addon) => normalizeAddonUrl(addon.transportUrl) === normOld
                )
                const replacementAddon = updatedAddons.find(
                    (addon) => normalizeAddonUrl(addon.transportUrl) === normNew
                )
                await store.getState().addChangelogEntry({
                    accountId: candidateId,
                    addonId: replacementAddon?.manifest.id || previousAddon?.manifest.id || newUrl,
                    addonUrl: newUrl,
                    oldAddonUrl: previousAddon?.transportUrl || oldUrl,
                    newAddonUrl: newUrl,
                    addonName: replacementAddon?.metadata?.customName || replacementAddon?.manifest.name || previousAddon?.metadata?.customName || previousAddon?.manifest.name || 'Unknown Addon',
                    addonLogo: replacementAddon?.metadata?.customLogo || replacementAddon?.manifest.logo || previousAddon?.metadata?.customLogo || previousAddon?.manifest.logo,
                    action: 'replaced'
                })
            }
            return candidateId
        } finally {
            releaseMutex()
        }
    }))

    return { updatedAccountIds: outcomes.filter((id): id is string => id !== null), failedAccounts: [] } as ReplaceTransportUrlResult
}

export async function bulkSetHideConfigure(accountId: string, hideConfigure: boolean) {
    const ownerIsCurrent = captureAddonOwner()
    const store = await getStore()
    const releaseMutex = await acquireSyncMutex(accountId)
    try {
        if (!ownerIsCurrent()) return 0
        const account = getAccountById(store.getState().accounts, accountId)
        if (!account) return 0
        const changedCount = account.addons.filter((a) => Boolean(a.metadata?.hideConfigure) !== hideConfigure).length
        if (changedCount === 0) return 0
        const updatedAddons = account.addons.map((a) => {
            const newMetadata = { ...a.metadata }
            if (hideConfigure) newMetadata.hideConfigure = true
            else delete newMetadata.hideConfigure
            return { ...a, metadata: newMetadata }
        })
        const accounts = store.getState().accounts.map((acc) =>
            acc.id === accountId ? updateActiveProfile({ ...acc, addons: updatedAddons }, updatedAddons) : acc
        )
        store.setState({ accounts })
        persistAccounts(accounts)
        backgroundSync(accountId, account, updatedAddons)
        return changedCount
    } finally {
        releaseMutex()
    }
}

export async function bulkSetHideConfigureSelected(accountId: string, transportUrls: string[], hideConfigure: boolean) {
    const ownerIsCurrent = captureAddonOwner()
    const store = await getStore()
    const releaseMutex = await acquireSyncMutex(accountId)
    try {
        if (!ownerIsCurrent()) return 0
        const account = getAccountById(store.getState().accounts, accountId)
        if (!account) return 0
        const normalizedTargets = new Set(transportUrls.map((u) => normalizeAddonUrl(u)))
        const changedCount = account.addons.filter((a) =>
            normalizedTargets.has(normalizeAddonUrl(a.transportUrl)) &&
            Boolean(a.metadata?.hideConfigure) !== hideConfigure
        ).length
        if (changedCount === 0) return 0
        const updatedAddons = account.addons.map((a) => {
            if (!normalizedTargets.has(normalizeAddonUrl(a.transportUrl))) return a
            const newMetadata = { ...a.metadata }
            if (hideConfigure) newMetadata.hideConfigure = true
            else delete newMetadata.hideConfigure
            return { ...a, metadata: newMetadata }
        })
        const accounts = store.getState().accounts.map((acc) =>
            acc.id === accountId ? updateActiveProfile({ ...acc, addons: updatedAddons }, updatedAddons) : acc
        )
        store.setState({ accounts })
        persistAccounts(accounts)
        backgroundSync(accountId, account, updatedAddons)
        return changedCount
    } finally {
        releaseMutex()
    }
}
