import { mergeAddons } from '@/lib/utils'
import { mergeAddonDeletionState, filterResurrected } from '@/lib/addon-tombstones'
import { readSyncedSettings } from '@/lib/synced-settings'
import { decrypt, encrypt } from '@/lib/crypto'
import { AddonDescriptor, AddonManifest } from '@/types/addon'
import { getHostnameIdentifier } from '@/lib/addon-identifier'
import { Account } from '@/types/account'
import type { Connection } from '@/types/connection'
import { useProfileStore } from '@/store/profileStore'
import localforage from 'localforage'
import { triggerSync } from '@/lib/sync-trigger'
import { toast } from '@/hooks/use-toast'
import { applySyncedSettings } from '@/lib/synced-settings'
import {
    getEncryptionKey,
    sanitizeAddonManifest,
    safeUUID,
    persistAccounts,
    acquireSyncMutex,
    STORAGE_KEY,
    CHANGELOG_KEY,
    BACKUP_KEY,
    getStremioAuthKey,
    setAccountLoading,
    clearAllAccountLoading,
} from '../accountStore'
import type { AccountStore } from '../accountStore'
import { captureSyncOwnership } from '../sync-store-helpers'

type StoreRef = { getState: () => AccountStore; setState: (partial: Partial<AccountStore> | ((state: AccountStore) => Partial<AccountStore>)) => void }

let _lastPushedAt: number | null = null

export function setLastPushedAt(ts: number | null) {
    _lastPushedAt = ts
}

async function getStore(): Promise<StoreRef> {
    const { useAccountStore } = await import('../accountStore')
    return useAccountStore
}

// Sync incoming connections carry metadata only (credentials live server-side), so local
// credentials must be preserved. Backup imports carry credentials, which take precedence.
function mergeConnections(
    local: Connection[] | undefined,
    incoming: Partial<Connection>[] | undefined,
    mode: 'merge' | 'mirror',
): Connection[] | undefined {
    if (!incoming) return local
    const localById = new Map((local || []).map(c => [c.id, c]))
    const merged: Connection[] = incoming
        .filter(inc => inc.id && inc.platform)
        .map(inc => {
            const existing = localById.get(inc.id as string)
            return {
                status: 'active',
                lastSync: 0,
                lastKnownAddonCount: 0,
                consecutiveFailures: 0,
                ...(existing || {}),
                ...inc,
                credentials: { ...(existing?.credentials || {}), ...(inc.credentials || {}) },
            } as Connection
        })
    if (mode === 'merge') {
        const incomingIds = new Set(merged.map(c => c.id))
        const mergedPlatforms = new Set(merged.map(c => c.platform))
        for (const c of local || []) {
            if (incomingIds.has(c.id)) continue
            if (mergedPlatforms.has(c.platform)) continue
            merged.push(c)
        }
    }
    return merged
}

// Shapes one addon entry for export. Sync exports strip the embedded manifest:
// entries carry manifestId, and the same envelope's manifests map is the
// deduplicated source the import rehydrates from (importAccounts falls back to
// it when the entry has no manifest). Manual backups keep the manifest embedded
// so they stay self-contained.
export function shapeExportAddon(
    addon: AddonDescriptor,
    manifestMap: Record<string, AddonDescriptor['manifest']>,
    forSync: boolean,
): Record<string, unknown> {
    const getManifestKey = (m: AddonDescriptor['manifest']) => `${m.id}:${m.version}`
    let exportAddon = addon
    if (addon.metadata?.customName) {
        const hostName = getHostnameIdentifier(addon.transportUrl)
        if (hostName && addon.metadata.customName === hostName) {
            const { customName: _cn, ...restMeta } = addon.metadata
            exportAddon = { ...addon, metadata: restMeta as AddonDescriptor['metadata'] }
        }
    }
    const sanitized = sanitizeAddonManifest(exportAddon.manifest, exportAddon.transportUrl)
    const key = getManifestKey(sanitized)
    if (!manifestMap[key]) manifestMap[key] = sanitized
    return {
        transportUrl: exportAddon.transportUrl,
        transportName: exportAddon.transportName,
        manifestId: key,
        ...(forSync ? {} : { manifest: sanitized }),
        flags: exportAddon.flags,
        metadata: exportAddon.metadata,
        catalogOverrides: exportAddon.catalogOverrides,
        syncToLibrary: exportAddon.syncToLibrary,
        note: exportAddon.note,
    }
}

async function buildExportData(includeCredentialsValue: boolean, forSync: boolean): Promise<Record<string, unknown>> {
    const store = await getStore()
    const manifestMap: Record<string, AddonDescriptor['manifest']> = {}

    const processAddons = (addons: AddonDescriptor[]) => {
        return addons.map((addon: AddonDescriptor) => shapeExportAddon(addon, manifestMap, forSync))
    }

    const exportedAccounts = await Promise.all(
        store.getState().accounts.map(async (acc) => ({
            id: acc.id,
            name: acc.name,
            email: acc.email,
            authKey: includeCredentialsValue ? await decrypt(getStremioAuthKey(acc), getEncryptionKey()!) : undefined,
            password:
                includeCredentialsValue && acc.password
                    ? await decrypt(acc.password, getEncryptionKey()!)
                    : undefined,
            accentColor: acc.accentColor,
            emoji: acc.emoji,
            avatar: acc.avatar,
            note: acc.note,
            profiles: acc.profiles,
            activeProfileId: acc.activeProfileId,
            deletedAddons: acc.deletedAddons,
            restoredAddons: acc.restoredAddons,
            addons: processAddons(acc.addons),
            connections: (acc.connections || []).map(c => ({
                id: c.id,
                platform: c.platform,
                connectionType: c.connectionType,
                driverType: c.driverType,
                enabled: c.enabled,
                credentials: includeCredentialsValue ? c.credentials : {},
                profileMapping: c.profileMapping,
                capabilities: c.capabilities,
                pluginList: c.pluginList,
                driverConfig: c.driverConfig,
                displayName: c.displayName,
            })),
            primaryConnectionId: acc.primaryConnectionId,
            apiKey: includeCredentialsValue ? acc.apiKey : undefined,
            createdAt: acc.createdAt,
            hideLastWatched: acc.hideLastWatched,
            hideAddonPreview: acc.hideAddonPreview,
            hidePlatformLogos: acc.hidePlatformLogos,
        }))
    )

    const apiKeys: Record<string, string> = {}
    for (const acc of store.getState().accounts) {
        if (includeCredentialsValue && acc.apiKey) apiKeys[acc.id] = acc.apiKey
    }

    const addonStoreModule = await import('@/store/addonStore')
    const { useAddonStore } = addonStoreModule

    if (forSync) {
        return {
            version: '2.0.0',
            manifests: manifestMap,
            accounts: exportedAccounts,
            apiKeys,
            accountStates: useAddonStore.getState().accountStates,
            changelog: store.getState().changelog.slice(0, 100),
        }
    }

    const { useVaultStore } = await import('@/store/vaultStore')
    if (useVaultStore.getState().isLocked) {
        const { useAuthStore } = await import('@/store/authStore')
        if (useAuthStore.getState().encryptionKey) {
            await useVaultStore.getState().initialize()
        }
    }

    const { useNotesStore } = await import('@/store/notesStore')
    const allNotes = await useNotesStore.getState().getAllNotesWithContent()
    const notesTrash = useNotesStore.getState().trash || []

    const data: Record<string, unknown> = {
        version: '2.0.0',
        exportedAt: new Date().toISOString(),
        manifests: manifestMap,
        accounts: exportedAccounts,
        apiKeys,
        profiles: useProfileStore.getState().profiles.map((p) => ({
            ...p,
            createdAt: new Date(p.createdAt).toISOString(),
            updatedAt: new Date(p.updatedAt).toISOString(),
        })),
        identity: {
            name: (await import('@/store/syncStore')).useSyncStore.getState().auth.name,
        },
        addons: (() => {
            const lib = useAddonStore.getState().exportLibrary()
            return typeof lib === 'string' ? JSON.parse(lib) : lib
        })(),
        accountStates: useAddonStore.getState().accountStates,
        failover: {
            rules: (await import('@/store/failoverStore')).useFailoverStore.getState().rules,
            webhook: (await import('@/store/failoverStore')).useFailoverStore.getState().webhook
        },
        settings: readSyncedSettings(),
        changelog: store.getState().changelog.slice(0, 100),
        vault: useVaultStore.getState().keys,
        vaultTombstones: useVaultStore.getState().tombstones,
        watchEvents: (await import('@/store/watchEventStore')).useWatchEventStore.getState().events,
        watchSnapshot: (await import('@/store/watchEventStore')).useWatchEventStore.getState().snapshot,
        deletedWatchEvents: (await import('@/store/watchEventStore')).useWatchEventStore.getState().deletedEventKeys,
        notes: allNotes,
        notesTrash,
        customThemes: (() => { try { return JSON.parse(localStorage.getItem('aio-custom-themes') || '[]') } catch { return [] } })(),
    }

    return data
}

export async function exportAccounts(includeCredentialsValue: boolean) {
    try {
        const data = await buildExportData(includeCredentialsValue, false)
        return JSON.stringify(data, null, 2)
    } catch (error) {
        if (import.meta.env.DEV) console.error('Failed to export accounts:', error)
        throw error
    }
}

export async function exportAccountsForSync(): Promise<Record<string, unknown>> {
    try {
        return await buildExportData(true, true)
    } catch (error) {
        if (import.meta.env.DEV) console.error('Failed to export accounts for sync:', error)
        throw error
    }
}

// Accepts a JSON string (file backups, legacy callers) or an already-parsed envelope
// (the sync pull) so the pull does not stringify+parse the whole payload just to
// cross the function boundary. The object is handed to the store importers, which may
// attach or unwrap manifests on nested input items in place (pre-existing importer
// behavior); the sync pull never reads the envelope again after this call.
//
// The whole import is one transaction and owns a workspace from entry: the
// ownership context (the caller's, or one captured here before the first await)
// is carried into every sub-import, every publication, the rollback and the
// detached disk re-persist. When ownership is lost mid-import the transaction
// abandons its rollback and error publication instead of restoring a dead
// session's snapshot over the session that replaced it.
export async function importAccounts(json: string | Record<string, unknown>, isSilent = false, mode: 'merge' | 'mirror' = 'merge', localDecryptionKey?: CryptoKey | null, ownership?: import('../sync-store-helpers').SyncOwnership) {
    const own = ownership ?? captureSyncOwnership()
    const store = await getStore()
    own.assert()
    store.setState({ error: null })
    setAccountLoading('__import__')
    let mutexReleases: Array<() => void> = []
    let restorePreImport: (() => void) | null = null
    try {
        mutexReleases = await Promise.all(store.getState().accounts.map(a => acquireSyncMutex(a.id)))
        let data: Record<string, unknown>
        if (!json) throw new Error('No data provided to import')
        try {
            data = typeof json === 'object' ? (json as Record<string, unknown>) : JSON.parse(json) as Record<string, unknown>
        } catch (e) {
            throw new Error('Invalid JSON format for import')
        }

        const manifestMap = (data.manifests || {}) as Record<string, unknown>

        if (!localDecryptionKey) getEncryptionKey()

        const { useAddonStore } = await import('@/store/addonStore')
        const { useFailoverStore } = await import('@/store/failoverStore')
        const { useProfileStore } = await import('@/store/profileStore')
        const { useVaultStore } = await import('@/store/vaultStore')
        const { useWatchEventStore } = await import('@/store/watchEventStore')
        const { useNotesStore } = await import('@/store/notesStore')
        // Snapshots are gated on the payload keys their sub-imports are gated on (the
        // unconditional importLibrary/importRules calls keep unconditional snapshots);
        // null means the slice can't have been mutated, so restore skips it too.
        const willImportAccounts = data.accounts !== undefined || Array.isArray(data.changelog)
        const willImportWatch = Array.isArray(data.watchEvents) && (data.watchEvents as unknown[]).length > 0
        const willImportVault = Array.isArray(data.vault) || Array.isArray(data.vaultTombstones)
        const willImportNotes = Array.isArray(data.notes) && (data.notes as unknown[]).length > 0
        const preImport = {
            accounts: willImportAccounts ? structuredClone(store.getState().accounts) : null,
            changelog: willImportAccounts ? structuredClone(store.getState().changelog) : null,
            addonLibrary: structuredClone(useAddonStore.getState().library),
            addonAccountStates: structuredClone(useAddonStore.getState().accountStates),
            failoverRules: structuredClone(useFailoverStore.getState().rules),
            failoverWebhook: structuredClone(useFailoverStore.getState().webhook),
            profiles: structuredClone(useProfileStore.getState().profiles),
            vaultKeys: willImportVault ? structuredClone(useVaultStore.getState().keys) : null,
            vaultTombstones: willImportVault ? structuredClone(useVaultStore.getState().tombstones) : null,
            watchEvents: willImportWatch ? structuredClone(useWatchEventStore.getState().events) : null,
            watchSnapshot: willImportWatch ? structuredClone(useWatchEventStore.getState().snapshot) : null,
            watchDeleted: willImportWatch ? structuredClone(useWatchEventStore.getState().deletedEventKeys) : null,
            notesIndex: willImportNotes ? structuredClone(useNotesStore.getState().notes) : null,
            notesTrash: willImportNotes ? structuredClone(useNotesStore.getState().trash) : null,
            settings: readSyncedSettings(),
        }
        // Memory-first (infallible), then best-effort disk re-persist: the sub-imports below
        // persist each slice to localforage as they run, so a late throw + reload would
        // otherwise resurrect the partial import. A failed persist self-heals on that
        // store's next action since memory already holds the restored state. The writer
        // re-verifies ownership between its own awaits: only a rollback that still owns
        // the session may dispatch, so an ordinary failure that races a switch cannot
        // restore its snapshot into the replacing namespace.
        restorePreImport = () => {
            if (preImport.accounts !== null) store.setState({ accounts: preImport.accounts, changelog: preImport.changelog ?? undefined })
            useAddonStore.setState({ library: preImport.addonLibrary, accountStates: preImport.addonAccountStates })
            useFailoverStore.setState({ rules: preImport.failoverRules, webhook: preImport.failoverWebhook })
            useProfileStore.setState({ profiles: preImport.profiles })
            if (preImport.vaultKeys !== null) useVaultStore.setState({ keys: preImport.vaultKeys ?? undefined, tombstones: preImport.vaultTombstones ?? undefined })
            if (preImport.watchEvents !== null) useWatchEventStore.setState({ events: preImport.watchEvents ?? undefined, snapshot: preImport.watchSnapshot ?? undefined, deletedEventKeys: preImport.watchDeleted ?? undefined })
            if (preImport.notesIndex !== null) useNotesStore.setState({ notes: preImport.notesIndex ?? undefined, trash: preImport.notesTrash ?? undefined })
            applySyncedSettings(preImport.settings, true)
            void (async () => {
                try {
                    const { default: localforage } = await import('localforage')
                    const { persistAccounts } = await import('../accountStore')
                    const notesModule = await import('@/store/notesStore')
                    own.assert()
                    const results = await Promise.allSettled([
                        preImport.accounts !== null ? persistAccounts(store.getState().accounts, own) : Promise.resolve(),
                        localforage.setItem('aioman:addon-library', useAddonStore.getState().library),
                        localforage.setItem('aioman:account-addons', useAddonStore.getState().accountStates),
                        localforage.setItem('aioman:failover-rules', useFailoverStore.getState().rules),
                        localforage.setItem('aioman:profiles', useProfileStore.getState().profiles),
                        preImport.watchEvents !== null
                            ? localforage.setItem('aio_watch_events_v2', { events: useWatchEventStore.getState().events, snapshot: useWatchEventStore.getState().snapshot })
                            : Promise.resolve(),
                        preImport.changelog !== null ? localforage.setItem(CHANGELOG_KEY, store.getState().changelog) : Promise.resolve(),
                        preImport.notesIndex !== null ? localforage.setItem(notesModule.NOTES_INDEX_KEY, useNotesStore.getState().notes) : Promise.resolve(),
                        preImport.notesTrash !== null ? localforage.setItem(notesModule.NOTES_TRASH_KEY, useNotesStore.getState().trash) : Promise.resolve(),
                        (async () => {
                            const { useAuthStore } = await import('@/store/authStore')
                            const { encrypt } = await import('@/lib/crypto')
                            const key = useAuthStore.getState().encryptionKey
                            if (!key) return
                            // Both ciphertexts are captured from the restored (owning)
                            // session's state up front: the payloads belong to this
                            // rollback until it stands down. Every awaited dispatch
                            // re-verifies before the next one, so a write held across a
                            // session switch aborts the chain instead of dispatching the
                            // remaining payloads into the replacing namespace.
                            const vaultCiphertext = await encrypt(JSON.stringify(useVaultStore.getState().keys), key)
                            const webhookCiphertext = await encrypt(JSON.stringify(useFailoverStore.getState().webhook), key)
                            own.assert()
                            await localforage.setItem('aioman:key-vault', vaultCiphertext)
                            own.assert()
                            await localforage.setItem('aioman:key-vault:tombstones', useVaultStore.getState().tombstones)
                            own.assert()
                            await localforage.setItem('aioman:failover-rules:webhook', webhookCiphertext)
                        })(),
                    ])
                    const failed = results.filter(r => r.status === 'rejected').length
                    if (failed > 0 && import.meta.env.DEV) console.warn(`[Import] Rollback re-persist: ${failed} slice(s) failed (memory state is correct)`)
                } catch (e) {
                    // A rollback that lost its session mid-writer stops quietly.
                    if ((e as Error)?.name !== 'SyncOwnershipLostError' && import.meta.env.DEV) {
                        console.warn('[Import] Rollback re-persist abandoned:', e)
                    }
                }
            })()
        }

        await useAddonStore.getState().importLibrary(data as Record<string, unknown>, mode === 'merge', false, true, own)

        if (data.accountStates) {
            await useAddonStore.getState().importAccountStates(data.accountStates as Record<string, import('@/types/saved-addon').AccountAddonState>, own)
        }

        await useFailoverStore.getState().importRules(data, mode, true, own)

        let scavengedProfiles = data.profiles || data['stremio-manager:profiles']
        if (scavengedProfiles && !Array.isArray(scavengedProfiles) && typeof scavengedProfiles === 'object') {
            scavengedProfiles = Object.values(scavengedProfiles)
        }
        if (Array.isArray(scavengedProfiles) && scavengedProfiles.length > 0) {
            own.assert()
            await useProfileStore.getState().importProfiles(scavengedProfiles, own)
        }

        if (data.settings) {
            own.assert()
            applySyncedSettings(data.settings, mode === 'mirror')
        }

        if (Array.isArray(data.customThemes) && data.customThemes.length > 0) {
            own.assert()
            applySyncedSettings({ customThemes: data.customThemes }, true)
        }

        if (Array.isArray(data.vault) || Array.isArray(data.vaultTombstones)) {
            own.assert()
            await useVaultStore.getState().initialize(own)
            await useVaultStore.getState().importVault((data.vault || []) as import('@/types/vault').VaultKey[], (data.vaultTombstones || []) as import('@/store/vaultStore').VaultTombstone[], own)
        }

        if (Array.isArray(data.changelog) && data.changelog.length > 0) {
            const existing = store.getState().changelog
            const merged = [...data.changelog]
            for (const entry of existing) {
                if (!merged.find(e => e.id === entry.id)) merged.push(entry)
            }
            const sorted = merged.sort((a, b) =>
                new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
            ).slice(0, 100)
            own.assert()
            store.setState({ changelog: sorted })
            localforage.setItem(CHANGELOG_KEY, sorted).catch(e => { if (import.meta.env.DEV) console.error(e) })
        }

        const incomingEvents = Array.isArray(data.watchEvents) ? data.watchEvents as Record<string, unknown>[] : []
        const incomingDeleted = (data.deletedWatchEvents && typeof data.deletedWatchEvents === 'object')
            ? data.deletedWatchEvents as Record<string, number>
            : null
        const localDeleted = useWatchEventStore.getState().deletedEventKeys
        let tombstonesChanged = false
        const mergedDeletedMap: Record<string, number> = { ...localDeleted }
        if (incomingDeleted) {
            for (const [k, ts] of Object.entries(incomingDeleted)) {
                const numTs = Number(ts) || 0
                if (!(k in mergedDeletedMap) || numTs > mergedDeletedMap[k]) {
                    mergedDeletedMap[k] = numTs
                    tombstonesChanged = true
                }
            }
        }
        if (incomingEvents.length > 0 || tombstonesChanged) {
            const current = useWatchEventStore.getState().events
            const currentIds = new Set(current.map(e => e.id))
            const newEvents = incomingEvents.filter((e) => !currentIds.has(e.id as string))
            if (newEvents.length > 0 || tombstonesChanged) {
                own.assert()
                const merged = [...current, ...newEvents] as Record<string, unknown>[]
                const deduped = Array.from(new Map(merged.map((e) => [e.id as string, e])).values())
                const sorted = deduped.sort((a, b) => ((b as Record<string, unknown>).event_ts as number) - ((a as Record<string, unknown>).event_ts as number))
                const snapshot = data.watchSnapshot || useWatchEventStore.getState().snapshot
                useWatchEventStore.getState().initialize(sorted as unknown as import('@/types/activity').WatchEvent[], snapshot as Record<string, Record<string, import('@/types/activity').SnapshotItem>>, mergedDeletedMap)
            }
        }

        if (Array.isArray(data.notes) && data.notes.length > 0) {
            const { useNotesStore } = await import('@/store/notesStore')
            own.assert()
            await useNotesStore.getState().importNotes(data.notes as import('@/store/notesStore').Note[], own)
            if (Array.isArray(data.notesTrash)) {
                await useNotesStore.getState().importTrash(data.notesTrash as import('@/store/notesStore').Note[], own)
            }
        }

        let accountsToImport = data.accounts || []
        if (!Array.isArray(accountsToImport) && typeof accountsToImport === 'object') {
            accountsToImport = (accountsToImport as Record<string, unknown>).accounts as unknown[] || []
        }

        if (!Array.isArray(accountsToImport)) accountsToImport = []

        const normalizedAccounts = (accountsToImport as Record<string, unknown>[]).map((acc) => {
            return {
                id: (acc.id as string) || safeUUID(),
                name: (acc.name as string) || 'Imported Account',
                email: acc.email as string,
                rawKey: (acc.authKey as string) || '',
                password: acc.password as string | undefined,
                note: acc.note as string | undefined,
                profiles: acc.profiles as import('@/types/account').AccountProfile[] | undefined,
                activeProfileId: acc.activeProfileId as string | undefined,
                deletedAddons: acc.deletedAddons as Record<string, number> | undefined,
                restoredAddons: acc.restoredAddons as Record<string, number> | undefined,
                addons: Array.isArray(acc.addons)
                    ? (acc.addons as Record<string, unknown>[]).map((ad: Record<string, unknown>) => {
                        const transportUrl = String(ad.transportUrl || '')
                        const rawMetadata = ad.metadata as AddonDescriptor['metadata']
                        let cleanedMetadata = rawMetadata
                        if (rawMetadata?.customName) {
                            const hostName = getHostnameIdentifier(transportUrl)
                            if (hostName && rawMetadata.customName === hostName) {
                                const { customName: _cn, ...rest } = rawMetadata
                                cleanedMetadata = rest as AddonDescriptor['metadata']
                            }
                        }
                        return {
                            transportUrl,
                            transportName: ad.transportName as string | undefined,
                            manifestId: String(ad.manifestId || ''),
                            installedAt: ad.installedAt as string | undefined,
                            flags: ad.flags as AddonDescriptor['flags'],
                            note: typeof ad.note === 'string' ? ad.note.slice(0, 10000) : undefined,
                            metadata: cleanedMetadata,
                            catalogOverrides: ad.catalogOverrides as AddonDescriptor['catalogOverrides'],
                            syncToLibrary: ad.syncToLibrary as boolean | undefined,
                            manifest: sanitizeAddonManifest((ad.manifest || manifestMap[ad.manifestId as string]) as AddonManifest, transportUrl || undefined),
                        }
                    })
                    : [],
                accentColor: acc.accentColor as string | undefined,
                emoji: acc.emoji as string | undefined,
                avatar: acc.avatar as string | undefined,
                connections: acc.connections as Partial<Connection>[] | undefined,
                primaryConnectionId: acc.primaryConnectionId as string | undefined,
                hideLastWatched: acc.hideLastWatched as boolean | undefined,
                hideAddonPreview: acc.hideAddonPreview as boolean | undefined,
                hidePlatformLogos: acc.hidePlatformLogos as boolean | undefined,
                apiKey: acc.apiKey as string | undefined,
                createdAt: acc.createdAt as number | undefined,
                lastSync: new Date(),
                status: 'active' as const,
            }
        })

        const getReadEncryptionKey = () => localDecryptionKey ?? getEncryptionKey()
        const getWriteEncryptionKey = () => getEncryptionKey()
        const currentAccounts = [...store.getState().accounts]

        const localDecrypted = await Promise.all(
            currentAccounts.map(async (acc) => {
                let password: string | undefined
                try {
                    if (acc.password) password = await decrypt(acc.password, getReadEncryptionKey())
                } catch {
                    password = undefined
                }
                try {
                    return { id: acc.id, key: await decrypt(getStremioAuthKey(acc), getReadEncryptionKey()), password }
                } catch (e) {
                    // Top-level authKey may be empty for connection-based accounts;
                    // fall back to the authKey stored in Stremio connection credentials.
                    const stremioConn = (acc.connections || []).find((c) => c.platform === 'stremio')
                    if (stremioConn?.credentials?.authKey && getReadEncryptionKey()) {
                        try {
                            return { id: acc.id, key: await decrypt(stremioConn.credentials.authKey, getReadEncryptionKey()), password }
                        } catch {}
                    }
                    const connWithCreds = (acc.connections || []).find(c => c.credentials?.authKey)
                    if (connWithCreds && getReadEncryptionKey()) {
                        try {
                            return { id: acc.id, key: await decrypt(connWithCreds.credentials.authKey, getReadEncryptionKey()), password }
                        } catch {}
                    }
                    return { id: acc.id, key: null, password }
                }
            })
        )
        const localSecretsById = new Map(localDecrypted.map((entry) => [entry.id, entry]))

        const migrateLocalAccountSecrets = async (account: Account): Promise<Account> => {
            if (!localDecryptionKey) return account
            const secrets = localSecretsById.get(account.id)
            if (!secrets?.key) return account
            return {
                ...account,
                authKey: await encrypt(secrets.key, getWriteEncryptionKey()),
                password: secrets.password ? await encrypt(secrets.password, getWriteEncryptionKey()) : account.password,
            }
        }

        const reconciledAccounts: Account[] = []
        const processedLocalIds = new Set<string>()

        for (const ra of normalizedAccounts) {
            let matchedAccount = currentAccounts.find((a) => a.id === ra.id)

            if (!matchedAccount && ra.rawKey) {
                const found = localDecrypted.find((ld) => ld.key === ra.rawKey)
                if (found) matchedAccount = currentAccounts.find((a) => a.id === found.id)
            }

            const raHasCredentials = !!ra.rawKey || (ra.connections || []).some(c => c.credentials)

            if (!matchedAccount && ra.email) {
                matchedAccount = currentAccounts.find((a) => {
                    if (a.email?.toLowerCase() !== ra.email?.toLowerCase()) return false
                    const aHasCredentials = !!localSecretsById.get(a.id)?.key || (a.connections || []).some(c => c.credentials)
                    return raHasCredentials === aHasCredentials
                })
            }

            if (!matchedAccount && ra.apiKey) {
                matchedAccount = currentAccounts.find((a) => {
                    if (a.apiKey !== ra.apiKey) return false
                    const aHasCredentials = !!localSecretsById.get(a.id)?.key || (a.connections || []).some(c => c.credentials)
                    return raHasCredentials === aHasCredentials
                })
            }

            if (matchedAccount) {
                const matchedSecrets = localSecretsById.get(matchedAccount.id)
                const mergedAuthKey = ra.rawKey || matchedSecrets?.key
                const mergedPassword = ra.password !== undefined ? ra.password : matchedSecrets?.password
                const updated: Account = {
                    ...matchedAccount,
                    name: ra.name || matchedAccount.name,
                    authKey: mergedAuthKey
                        ? await encrypt(mergedAuthKey, getWriteEncryptionKey())
                        : matchedAccount.authKey,
                    password: mergedPassword
                        ? await encrypt(mergedPassword, getWriteEncryptionKey())
                        : matchedAccount.password,
                    accentColor: ra.accentColor || matchedAccount.accentColor,
                    emoji: ra.emoji || matchedAccount.emoji,
                    note: ra.note ?? matchedAccount.note,
                    hideLastWatched: ra.hideLastWatched ?? matchedAccount.hideLastWatched,
                    hideAddonPreview: ra.hideAddonPreview ?? matchedAccount.hideAddonPreview,
                    hidePlatformLogos: ra.hidePlatformLogos ?? matchedAccount.hidePlatformLogos,
                    avatar: matchedAccount.avatar ?? ra.avatar,
                    apiKey: ra.apiKey ?? matchedAccount.apiKey ?? safeUUID(),
                    profiles: (() => {
                        const localProfiles = matchedAccount.profiles || []
                        const incomingProfiles = ra.profiles || []
                        let merged
                        if (incomingProfiles.length === 0) merged = [...(matchedAccount.profiles || [])]
                        else if (localProfiles.length === 0) merged = [...(ra.profiles || [])]
                        else {
                            const byId = new Map(localProfiles.map(p => [p.id, p]))
                            for (const p of incomingProfiles) {
                                if (!byId.has(p.id)) byId.set(p.id, p)
                            }
                            merged = Array.from(byId.values())
                        }
                        const resolvedActiveId = matchedAccount.activeProfileId ?? ra.activeProfileId
                        const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
                        const hasDefault = merged.some(p => p?.id === 'default')
                        if (!hasDefault && (resolvedActiveId === undefined || resolvedActiveId === null) && merged.length > 0) {
                            const candidateIdx = merged.findIndex(p => p && !uuidRe.test(String(p.id)))
                            const targetIdx = candidateIdx === -1 ? 0 : candidateIdx
                            merged[targetIdx] = { ...merged[targetIdx], id: 'default' }
                        }
                        let firstDefaultKept = false
                        return merged.map(p => {
                            if (p?.id === 'default') {
                                if (firstDefaultKept) return { ...p, id: safeUUID() }
                                firstDefaultKept = true
                            }
                            return p
                        })
                    })(),
                    activeProfileId: matchedAccount.activeProfileId ?? ra.activeProfileId,
                    ...(() => {
                        // A saved local addon is not proof of a reinstall. Resolve both devices'
                        // explicit restore acknowledgements before either list can enter the merge.
                        const deletionState = mergeAddonDeletionState(
                            matchedAccount.deletedAddons,
                            ra.deletedAddons,
                            matchedAccount.restoredAddons,
                            ra.restoredAddons,
                        )
                        const localAddons = filterResurrected(matchedAccount.addons, [], deletionState.deletedAddons)
                        const remoteAddons = filterResurrected(ra.addons, [], deletionState.deletedAddons)
                        const mergedAddons = mode === 'mirror'
                            ? remoteAddons
                            : mergeAddons(localAddons, remoteAddons, { instanceMatch: 'adopt-remote-url' })
                        return { addons: mergedAddons, ...deletionState }
                    })(),
                    connections: mergeConnections(matchedAccount.connections, ra.connections, mode) ?? matchedAccount.connections,
                    primaryConnectionId: ra.primaryConnectionId ?? matchedAccount.primaryConnectionId,
                    lastSync: ra.lastSync || new Date(),
                    status: 'active' as const,
                }
                reconciledAccounts.push(updated)
                processedLocalIds.add(matchedAccount.id)
            } else {
                const deletionState = mergeAddonDeletionState(undefined, ra.deletedAddons, undefined, ra.restoredAddons)
                const importedAddons = filterResurrected(ra.addons, [], deletionState.deletedAddons)
                const importedAccount = {
                    ...ra,
                    addons: importedAddons,
                    ...deletionState,
                    authKey: ra.rawKey ? await encrypt(ra.rawKey, getWriteEncryptionKey()) : '',
                    password: ra.password ? await encrypt(ra.password, getWriteEncryptionKey()) : undefined,
                    connections: mergeConnections(undefined, ra.connections, mode),
                    apiKey: ra.apiKey ?? safeUUID(),
                } as Account
                reconciledAccounts.push(importedAccount)
            }
        }

        const localOnlyAccounts =
            mode === 'mirror'
                ? []
                : await Promise.all(
                    currentAccounts
                        .filter((a) => !processedLocalIds.has(a.id))
                        .map(migrateLocalAccountSecrets)
                )

        const lastPushMs = _lastPushedAt
        const freshLocalAccounts = mode === 'mirror'
            ? currentAccounts.filter(a =>
                !processedLocalIds.has(a.id) &&
                a.createdAt !== undefined &&
                (lastPushMs === null || a.createdAt > lastPushMs))
            : []

        let finalAccounts: typeof currentAccounts
        if (mode === 'mirror') {
            finalAccounts = freshLocalAccounts.length > 0
                ? [...reconciledAccounts, ...freshLocalAccounts]
                : reconciledAccounts
        } else {
            const reconciledById = new Map(reconciledAccounts.map(a => [a.id, a]))
            const localById = new Map(localOnlyAccounts.map(a => [a.id, a]))
            const seenIds = new Set<string>()
            const ordered: typeof currentAccounts = []
            for (const existing of currentAccounts) {
                const id = existing.id
                seenIds.add(id)
                const reconciled = reconciledById.get(id)
                const local = localById.get(id)
                if (reconciled) ordered.push(reconciled)
                else if (local) ordered.push(local)
                else ordered.push(existing)
            }
            for (const acc of reconciledAccounts) {
                if (!seenIds.has(acc.id)) { ordered.push(acc); seenIds.add(acc.id) }
            }
            for (const acc of localOnlyAccounts) {
                if (!seenIds.has(acc.id)) { ordered.push(acc); seenIds.add(acc.id) }
            }
            finalAccounts = ordered
        }

        if (freshLocalAccounts.length > 0) {
            console.warn(`[Import] Mirror merge spared ${freshLocalAccounts.length} account(s) created after the last confirmed push (never synced, so the cloud cannot have seen them): ${freshLocalAccounts.map(a => `${a.name} (${a.id})`).join(', ')}`)
        }

        if (currentAccounts.length > 0 && finalAccounts.length < currentAccounts.length) {
            if (import.meta.env.DEV) console.warn(`[Import] Would reduce accounts from ${currentAccounts.length} to ${finalAccounts.length}. Aborting write and pushing local state.`)
            own.assert()
            setTimeout(() => triggerSync(), 500)
            clearAllAccountLoading()
            return
        }

        if (finalAccounts.length === 0) {
            const backup = await localforage.getItem<Account[]>(BACKUP_KEY)
            if (backup && backup.length > 0) {
                if (import.meta.env.DEV) console.warn(`[Import] Final accounts would be empty but backup has ${backup.length}. Restoring from backup.`)
                const restoredBackup = localDecryptionKey
                    ? await Promise.all(backup.map(async (account) => {
                        try {
                            const rawAuthKey = await decrypt(getStremioAuthKey(account), getReadEncryptionKey())
                            const rawPassword = account.password ? await decrypt(account.password, getReadEncryptionKey()).catch(() => undefined) : undefined
                            return {
                                ...account,
                                authKey: await encrypt(rawAuthKey, getWriteEncryptionKey()),
                                password: rawPassword ? await encrypt(rawPassword, getWriteEncryptionKey()) : account.password,
                            }
                        } catch {
                            return account
                        }
                    }))
                    : backup
                own.assert()
                store.setState({ accounts: restoredBackup })
                await localforage.setItem(STORAGE_KEY, restoredBackup)
                setTimeout(() => triggerSync(), 500)
                clearAllAccountLoading()
                return
            }
        }

        if (finalAccounts.length > 0) {
            const diskData = await localforage.getItem<Account[]>(STORAGE_KEY)
            if (diskData && Array.isArray(diskData) && diskData.length > 0) {
                own.assert()
                await localforage.setItem(BACKUP_KEY, diskData)
            }
        }

        own.assert()
        store.setState({ accounts: finalAccounts, hydrated: true })
        persistAccounts(finalAccounts, own)

        if (!isSilent) {
            triggerSync()
            toast({ title: 'Import Successful' })
        }
        if (own.current()) {
            store.getState().syncAllAccounts().catch(e => { if (import.meta.env.DEV) console.error(e) })
        }
    } catch (error) {
        // Ownership lost mid-import: the session that replaced this one owns the
        // stores now, so restoring the dead session's snapshot over it (in memory,
        // on disk, or as an error banner) would destroy the replacing session's
        // state. Only an ordinary same-session failure rolls back.
        if (!own.current()) throw error
        try { restorePreImport?.() } catch (rollbackErr) {
            if (import.meta.env.DEV) console.error('[Import] Rollback to pre-import state failed:', rollbackErr)
        }
        store.setState({ error: (error as Error).message })
        throw error
    } finally {
        mutexReleases.forEach(release => release())
        clearAllAccountLoading()
    }
}
