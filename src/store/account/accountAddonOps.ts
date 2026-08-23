import { triggerSync } from '@/lib/sync-trigger'
import { ACCOUNT_CONTEXT_BULK_OP } from '@/lib/account-contexts'
import {
    fetchAddonManifest as apiFetchAddonManifest,
    updateAddons,
    getAddons,
} from '@/api/addons'
import { getAddonVersionKey, normalizeAddonUrl, mergeAddons } from '@/lib/utils'
import { addTombstones, reconcileTombstones } from '@/lib/addon-tombstones'
import { AddonDescriptor } from '@/types/addon'
import { dedupeAddonsByTransportUrl } from '@/lib/addon-dedupe'
import { mapConcurrent } from '@/lib/concurrency'
import { syncManager } from '@/lib/sync/syncManager'
import { autopilotManager } from '@/lib/autopilot/autopilotManager'
import { getEffectiveManifest } from '@/lib/addon-utils'
import { getCachedManifest, setCachedManifest } from '@/lib/manifest-cache'
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
    setAccountLoading,
    clearAccountLoading,
    hasPlatformConnection,
} from '../accountStore'
import type { AccountStore, ReplaceTransportUrlResult } from '../accountStore'
import type { Account, AccountProfile } from '@/types/account'
import { type Connection, isSyncEligibleConnection } from '@/types/connection'

type StoreRef = { getState: () => AccountStore; setState: (partial: Partial<AccountStore> | ((state: AccountStore) => Partial<AccountStore>)) => void }

async function getStore(): Promise<StoreRef> {
    const { useAccountStore } = await import('../accountStore')
    return useAccountStore
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

async function pushNuvio(conn: Connection, addons: AddonDescriptor[], accountId: string, activeProfileId?: string) {
    const creds = (conn.credentials || {}) as Record<string, string>
    const { nuvioDriverFor } = await import('@/lib/drivers/factory')
    const driver = nuvioDriverFor(conn)
    const { fetchConnectionToken } = await import('@/api/connection')
    const token = await fetchConnectionToken(accountId, conn.id, 'nuvio')
    const { setCachedNuvioToken } = await import('@/lib/nuvio-token-cache')
    setCachedNuvioToken(conn.id, token)
    const { resolveNuvioPushProfile } = await import('@/lib/nuvio-profile-resolve')
    const profileId = resolveNuvioPushProfile(conn, activeProfileId, token.profileId ?? creds.profileIndex ?? creds.profileId)
    await driver.writeAddons(token.accessToken, addons, profileId)

    const canonicalPlugins = conn.pluginList || []
    if (canonicalPlugins.length > 0) {
        try {
            const platformPlugins = await driver.readPlugins(token.accessToken, profileId)
            const canonicalUrls = new Set(canonicalPlugins.map(p => pluginUrlKey(p.url)))
            const platformUrls = new Set((platformPlugins || []).map((p: { url?: string }) => pluginUrlKey(p.url)))
            const needsPush = platformUrls.size !== canonicalUrls.size
                || [...canonicalUrls].some(u => !platformUrls.has(u))
                || [...platformUrls].some(u => !canonicalUrls.has(u))
            if (needsPush) await driver.writePlugins(token.accessToken, canonicalPlugins, profileId)
        } catch (err) {
            if (isAuthError(err)) throw err
        }
    }
}

async function pushRealStream(conn: Connection, addons: AddonDescriptor[], accountId: string) {
    const { fetchConnectionToken } = await import('@/api/connection')
    const token = await fetchConnectionToken(accountId, conn.id, 'realstream')

    const { realStreamDriverFor } = await import('@/lib/drivers/factory')
    // userId is a stable PocketBase identity set at auth time; it never changes between refreshes.
    const userId = conn.credentials?.userId || ''
    if (!userId) throw Object.assign(new Error('RealStream user ID missing; re-authenticate this connection'), { isAuthError: true })

    await realStreamDriverFor(conn).writeAddons(token.accessToken, addons, userId)
}

// Hydra (CORS-fragile against arbitrary servers) + any client-side failure fall back to the server.
async function serverReconcile(accountId: string, account: Account, connections: Connection[], options: { addons?: AddonDescriptor[]; allowCollectionShrink?: boolean } = {}) {
    try {
        const { triggerReconciliation } = await import('@/api/connection')
        const addons = options.addons ?? account.addons
        const result = await triggerReconciliation(accountId, account.primaryConnectionId, connections, addons, { allowCollectionShrink: options.allowCollectionShrink })
        if (result.connectionStates && Object.keys(result.connectionStates).length > 0) {
            const { useConnectionStore } = await import('@/store/connectionStore')
            useConnectionStore.setState(s => ({
                connectionStates: {
                    ...s.connectionStates,
                    [accountId]: { ...(s.connectionStates[accountId] || {}), ...result.connectionStates },
                },
            }))
        }
    } catch (e) {
        toast({
            title: 'Connection sync failed',
            description: e instanceof Error ? e.message : 'One or more connections could not be updated.',
            variant: 'destructive',
        })
    }
}

export async function pushToConnections(accountId: string, options: { addons?: AddonDescriptor[]; allowCollectionShrink?: boolean } = {}) {
    const store = await getStore()
    const account = getAccountById(store.getState().accounts, accountId)
    const eligible = (account?.connections || []).filter(c => c.enabled && isSyncEligibleConnection(c))
    if (!account || eligible.length === 0) return

    const sourceAddons = options.addons ?? account.addons ?? []
    const enabledAddons = sourceAddons.filter(a => a?.flags?.enabled !== false)
    trace('push', 'connections-start', { accountId, eligible: eligible.map(c => c.platform), source: sourceAddons.length, enabled: enabledAddons.length, allowCollectionShrink: !!options.allowCollectionShrink })
    if (enabledAddons.length === 0 && !options.allowCollectionShrink) {
        trace('push', 'connections-skip-empty', { accountId })
        return
    }

    const { useConnectionStore } = await import('@/store/connectionStore')
    const now = Date.now()
    const setStatus = (connId: string, status: Connection['status'], lastError: string | null = null) => {
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
            persistAccounts(store.getState().accounts)
        }
    }

    const serverConnections: Connection[] = []
    let authFailures = 0

    for (const conn of eligible) {
        if (conn.platform !== 'nuvio' && conn.platform !== 'realstream') {
            serverConnections.push(conn)
            continue
        }
        try {
            if (conn.platform === 'nuvio') await pushNuvio(conn, enabledAddons, accountId, account.activeProfileId)
            else await pushRealStream(conn, enabledAddons, accountId)
            setStatus(conn.id, 'active')
        } catch (err) {
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

    if (authFailures > 0) {
        toast({
            title: 'Connection re-authentication needed',
            description: `${authFailures} connection(s) need to be re-authenticated. Check the Connections tab.`,
            variant: 'destructive',
        })
    }

    if (serverConnections.length > 0) {
        await serverReconcile(accountId, account, serverConnections, { addons: sourceAddons, allowCollectionShrink: options.allowCollectionShrink })
    }
}

function backgroundSync(accountId: string, account: Account, updatedAddons: AddonDescriptor[], options?: { allowCollectionShrink?: boolean }, trigger = 'unknown') {
    if (!hasPlatformConnection(account)) {
        return
    }
    const promises: Promise<void>[] = []

    const authKey = getStremioAuthKey(account)
    const stremioConn = account.connections?.find(c => c.platform === 'stremio')
    const stremioPushEnabled = !stremioConn || stremioConn.enabled !== false
    trace('backgroundSync', 'enter', { accountId, hasAuthKey: !!authKey, stremioPushEnabled, count: updatedAddons.length, allowCollectionShrink: !!options?.allowCollectionShrink, trigger, addons: briefAddons(updatedAddons) })
    if (authKey && stremioPushEnabled) {
        const context = options?.allowCollectionShrink ? ACCOUNT_CONTEXT_BULK_OP : accountId
        promises.push(
            getCachedAuthKey(authKey, getEncryptionKey())
                .then(decryptedKey => updateAddons(decryptedKey, updatedAddons, context, { previousCollection: account.addons, allowCollectionShrink: options?.allowCollectionShrink }))
                .catch(err => {
                    if (isAuthError(err)) {
                        toast({ title: 'Session expired', description: 'Session expired. Re-authenticate your connection.', variant: 'destructive' })
                    } else {
                        toast({ title: 'Sync failed', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' })
                    }
                })
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

export async function installAddonToAccount(accountId: string, addonUrl: string, savedMetadata?: AddonDescriptor['metadata']) {
    const store = await getStore()
    store.setState({ error: null })
    setAccountLoading(accountId)
    const releaseMutex = await acquireSyncMutex(accountId)
    try {
        const account = getAccountById(store.getState().accounts, accountId)
        if (!account) throw new Error('Account not found')

        const fetchedAddon = await apiFetchAddonManifest(addonUrl, account.id)
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
        const mergedAddons = mergeAddons(baseAddons, [normalizedAddon], { keepMissingLocal: true })
        const finalAddons = dedupeAddonsByTransportUrl(mergedAddons).map(addon => ({
            ...addon,
            manifest: getEffectiveManifest(addon)
        }))

        let updatedAccount: Account = { ...account, addons: finalAddons, deletedAddons: reconcileTombstones(account.deletedAddons, finalAddons), lastSync: new Date() }
        updatedAccount = updateActiveProfile(updatedAccount, finalAddons)
        const accounts = store.getState().accounts.map((acc) => (acc.id === accountId ? updatedAccount : acc))
        store.setState({ accounts })
        persistAccounts(accounts)

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
        const message = error instanceof Error ? error.message : 'Failed to install addon'
        store.setState({ error: message })
        throw error
    } finally {
        releaseMutex()
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
        fetchedAddons.forEach((newAddon) => {
            const normalized: AddonDescriptor = {
                ...newAddon,
                manifest: sanitizeAddonManifest(newAddon.manifest, newAddon.transportUrl),
                metadata: { ...newAddon.metadata, lastUpdated: now },
            }
            const existingIndex = updatedAddons.findIndex(
                (addon) => normalizeAddonUrl(addon.transportUrl) === normalizeAddonUrl(newAddon.transportUrl)
            )
            if (existingIndex >= 0) {
                const existing = updatedAddons[existingIndex]
                updatedAddons[existingIndex] = {
                    ...normalized,
                    flags: { ...existing.flags, ...normalized.flags },
                    metadata: { ...existing.metadata, ...normalized.metadata },
                    catalogOverrides: existing.catalogOverrides,
                }
            } else {
                updatedAddons.push(normalized)
            }
        })

        const finalAddons = dedupeAddonsByTransportUrl(updatedAddons).map(addon => ({
            ...addon,
            manifest: getEffectiveManifest(addon)
        }))

        let updatedAccount: Account = { ...account, addons: finalAddons, deletedAddons: reconcileTombstones(account.deletedAddons, finalAddons), lastSync: new Date() }
        updatedAccount = updateActiveProfile(updatedAccount, finalAddons)
        const accounts = store.getState().accounts.map((acc) => (
            acc.id === accountId ? updatedAccount : acc
        ))
        store.setState({ accounts })
        persistAccounts(accounts)

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

        const updatedAddons = account.addons.filter(
            (a) => normalizeAddonUrl(a.transportUrl) !== normalizeAddonUrl(transportUrl)
        )

        let updatedAccount: Account = { ...account, addons: updatedAddons, deletedAddons: addTombstones(account.deletedAddons, [transportUrl]), lastSync: new Date() }
        updatedAccount = updateActiveProfile(updatedAccount, updatedAddons)
        const accounts = store.getState().accounts.map((acc) => (acc.id === accountId ? updatedAccount : acc))
        store.setState({ accounts })
        persistAccounts(accounts)

        backgroundSync(accountId, account, updatedAddons, { allowCollectionShrink: true }, 'remove')

        const removedAddon = account.addons.find(a => normalizeAddonUrl(a.transportUrl) === normalizeAddonUrl(transportUrl))
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

export async function removeAddonByIndexFromAccount(accountId: string, index: number) {
    const store = await getStore()
    store.setState({ error: null })
    setAccountLoading(accountId)
    let transportUrl = ''
    const releaseMutex = await acquireSyncMutex(accountId)
    try {
        const account = getAccountById(store.getState().accounts, accountId)
        if (!account) throw new Error('Account not found')

        const addonToRemove = account.addons[index]
        if (!addonToRemove) throw new Error('Addon not found at index')

        transportUrl = addonToRemove.transportUrl
        syncManager.addPendingRemoval(accountId, transportUrl)

        if (addonToRemove.flags?.protected) {
            throw new Error(
                `Addon "${addonToRemove.manifest.name}" is protected and cannot be removed.`
            )
        }

        const updatedAddons = [...account.addons]
        updatedAddons.splice(index, 1)

        let updatedAccount: Account = { ...account, addons: updatedAddons, deletedAddons: addTombstones(account.deletedAddons, [transportUrl]), lastSync: new Date() }
        updatedAccount = updateActiveProfile(updatedAccount, updatedAddons)
        const accounts = store.getState().accounts.map((acc) => (acc.id === accountId ? updatedAccount : acc))
        store.setState({ accounts })
        persistAccounts(accounts)

        await store.getState().addChangelogEntry({
            accountId,
            addonId: transportUrl,
            addonUrl: transportUrl,
            addonName: addonToRemove.metadata?.customName || addonToRemove.manifest.name,
            addonLogo: addonToRemove.metadata?.customLogo || addonToRemove.manifest.logo,
            action: 'removed'
        })

        backgroundSync(accountId, account, updatedAddons, { allowCollectionShrink: true }, 'remove-index')
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

export async function reorderAddons(accountId: string, newOrder: AddonDescriptor[]) {
    const store = await getStore()
    const timestampedOrder = newOrder.map(addon => ({
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

        let updatedAccount: Account = { ...account, addons: timestampedOrder, lastSync: new Date() }
        updatedAccount = updateActiveProfile(updatedAccount, timestampedOrder)
        const accounts = store.getState().accounts.map((acc) => (acc.id === accountId ? updatedAccount : acc))
        store.setState({ accounts })
        persistAccounts(accounts)

        backgroundSync(accountId, account, timestampedOrder, { allowCollectionShrink: true }, 'reorder')
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
        let updatedAccount: Account = { ...account, addons: timestamped, deletedAddons: addTombstones(account.deletedAddons, removedUrls), lastSync: new Date() }
        updatedAccount = updateActiveProfile(updatedAccount, timestamped)
        const accounts = store.getState().accounts.map((acc) => (acc.id === accountId ? updatedAccount : acc))
        store.setState({ accounts })
        persistAccounts(accounts)

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

// The addon stays on the account and stops being pushed to the platforms named
// here. Passing an empty list clears the exclusion.
export async function setAddonPlatformExclusions(accountId: string, transportUrl: string, platforms: string[], targetIndex?: number) {
    const store = await getStore()
    const releaseMutex = await acquireSyncMutex(accountId)
    const account = getAccountById(store.getState().accounts, accountId)
    if (!account) { releaseMutex(); return }
    const prevAccounts = store.getState().accounts
    try {
        const excludePlatforms = Array.from(new Set((platforms || []).filter(p => typeof p === 'string' && p)))
        const updatedAddons = account.addons.map((addon, index) =>
            (targetIndex !== undefined ? index === targetIndex : normalizeAddonUrl(addon.transportUrl) === normalizeAddonUrl(transportUrl))
                ? { ...addon, flags: { ...addon.flags, excludePlatforms } }
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
    },
    targetIndex?: number
) {
    const store = await getStore()
    const account = getAccountById(store.getState().accounts, accountId)
    if (!account) return
    const releaseMutex = await acquireSyncMutex(accountId)
    try {
        const updatedAddons = await Promise.all(account.addons.map(async (addon, index) => {
            if (targetIndex !== undefined ? index === targetIndex : normalizeAddonUrl(addon.transportUrl) === normalizeAddonUrl(transportUrl)) {
                const newAddon = { ...addon }

                if ('note' in settings) {
                    newAddon.note = settings.note || undefined
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

                    const fieldMap: Record<string, string> = {
                        customName: 'name',
                        customLogo: 'logo',
                        customDescription: 'description'
                    }
                    if (clearedFields.some(f => fieldMap[f])) {
                        let originalManifest = getCachedManifest(addon.transportUrl)
                        if (!originalManifest) {
                            try {
                                const fetched = await apiFetchAddonManifest(addon.transportUrl, accountId, true)
                                originalManifest = fetched.manifest
                                setCachedManifest(addon.transportUrl, originalManifest)
                            } catch (e) {
                                if (import.meta.env.DEV) console.warn('[Reset] Could not fetch original manifest:', e)
                            }
                        }
                        if (originalManifest) {
                            const baseManifest = { ...newAddon.manifest }
                            for (const field of clearedFields) {
                                const manifestKey = fieldMap[field]
                                if (manifestKey && (originalManifest as unknown as Record<string, unknown>)[manifestKey]) {
                                    (baseManifest as unknown as Record<string, unknown>)[manifestKey] = (originalManifest as unknown as Record<string, unknown>)[manifestKey]
                                }
                            }
                            newAddon.manifest = baseManifest
                        }
                    }

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
        const accounts = store.getState().accounts.map((acc) =>
            acc.id === accountId ? updateActiveProfile({ ...acc, addons: updatedAddons }, updatedAddons) : acc
        )
        store.setState({ accounts })
        persistAccounts(accounts)
        backgroundSync(accountId, account, updatedAddons)

        if (settings.metadata) {
            const { useAddonStore } = await import('@/store/addonStore')
            const addonStore = useAddonStore.getState()

            const savedAddon = Object.values(addonStore.library).find(s =>
                normalizeAddonUrl(s.installUrl) === normalizeAddonUrl(transportUrl)
                && s.syncWithInstalled === true
                && (!Array.isArray(s.syncAccountIds) || s.syncAccountIds.includes(accountId))
            )

            if (savedAddon) {
                if (import.meta.env.DEV) console.log(`[AccountStore] Inbound Sync: Updating library metadata for "${savedAddon.name}"`)
                await addonStore.updateSavedAddonMetadata(savedAddon.id, settings.metadata)
            }
        }
    } finally {
        releaseMutex()
    }
}

export async function bulkProtectAddons(accountId: string, isProtected: boolean) {
    const store = await getStore()
    const account = getAccountById(store.getState().accounts, accountId)
    if (!account) return 0
    const changedCount = account.addons.filter((addon) => Boolean(addon.flags?.protected) !== isProtected).length
    if (changedCount === 0) return 0
    const releaseMutex = await acquireSyncMutex(accountId)
    try {
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
    const store = await getStore()
    const account = getAccountById(store.getState().accounts, accountId)
    if (!account) return 0
    const releaseMutex = await acquireSyncMutex(accountId)
    try {
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
            if (shouldRemove) removedUrls.push(addon.transportUrl)
            return !shouldRemove
        })

        const updatedAccount = updateActiveProfile({ ...account, addons: updatedAddons, deletedAddons: addTombstones(account.deletedAddons, removedUrls) }, updatedAddons)
        const accounts = store.getState().accounts.map((acc) =>
            acc.id === accountId ? updatedAccount : acc
        )
        store.setState({ accounts })
        persistAccounts(accounts)
        backgroundSync(accountId, account, updatedAddons, { allowCollectionShrink: true }, 'local-remove')
    } finally {
        releaseMutex()
    }
}

export async function replaceTransportUrl(oldUrl: string, newUrl: string, accountId?: string, freshManifest?: AddonDescriptor['manifest'], metadata?: AddonDescriptor['metadata']) {
    const store = await getStore()
    const normOld = normalizeAddonUrl(oldUrl)
    const normNew = normalizeAddonUrl(newUrl)
    const modifiedAccountIds = new Set<string>()
    const previousAddonsByAccountId = new Map<string, AddonDescriptor[]>()

    const updatedAccounts = store.getState().accounts.map((account) => {
        if (accountId && account.id !== accountId) return account

        const hasOld = account.addons.some(a => normalizeAddonUrl(a.transportUrl) === normOld)
        if (!hasOld) return account

        modifiedAccountIds.add(account.id)
        previousAddonsByAccountId.set(account.id, account.addons)

        const updatedAddons = account.addons.map(addon => {
            if (normalizeAddonUrl(addon.transportUrl) === normOld) {
                return {
                    ...addon,
                    transportUrl: newUrl,
                    manifest: freshManifest || addon.manifest,
                    metadata: { ...(metadata || addon.metadata), lastUpdated: Date.now() }
                }
            }
            return addon
        })

        return updateActiveProfile({ ...account, addons: updatedAddons, lastSync: new Date() }, updatedAddons)
    })

    store.setState({ accounts: updatedAccounts })

    if (modifiedAccountIds.size === 0) return { updatedAccountIds: [], failedAccounts: [] }

    persistAccounts(updatedAccounts)

    for (const account of updatedAccounts) {
        if (!modifiedAccountIds.has(account.id)) continue

        backgroundSync(account.id, account, account.addons)
    }

    if (normOld !== normNew) {
        for (const modifiedAccountId of modifiedAccountIds) {
            const previousAddon = previousAddonsByAccountId.get(modifiedAccountId)?.find(
                (addon) => normalizeAddonUrl(addon.transportUrl) === normOld
            )
            const updatedAccount = getAccountById(store.getState().accounts, modifiedAccountId)
            const replacementAddon = updatedAccount?.addons.find(
                (addon) => normalizeAddonUrl(addon.transportUrl) === normNew
            )
            await store.getState().addChangelogEntry({
                accountId: modifiedAccountId,
                addonId: replacementAddon?.manifest.id || previousAddon?.manifest.id || newUrl,
                addonUrl: newUrl,
                oldAddonUrl: previousAddon?.transportUrl || oldUrl,
                newAddonUrl: newUrl,
                addonName: replacementAddon?.metadata?.customName || replacementAddon?.manifest.name || previousAddon?.metadata?.customName || previousAddon?.manifest.name || 'Unknown Addon',
                addonLogo: replacementAddon?.metadata?.customLogo || replacementAddon?.manifest.logo || previousAddon?.metadata?.customLogo || previousAddon?.manifest.logo,
                action: 'replaced'
            })
        }
    }

    return { updatedAccountIds: Array.from(modifiedAccountIds), failedAccounts: [] } as ReplaceTransportUrlResult
}

export async function bulkSetHideConfigure(accountId: string, hideConfigure: boolean) {
    const store = await getStore()
    const account = getAccountById(store.getState().accounts, accountId)
    if (!account) return 0
    const changedCount = account.addons.filter((a) => Boolean(a.metadata?.hideConfigure) !== hideConfigure).length
    if (changedCount === 0) return 0
    const releaseMutex = await acquireSyncMutex(accountId)
    try {
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
    const store = await getStore()
    const account = getAccountById(store.getState().accounts, accountId)
    if (!account) return 0
    const releaseMutex = await acquireSyncMutex(accountId)
    try {
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
