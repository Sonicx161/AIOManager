import { mergeAddons } from '@/lib/utils'
import { mergeAddonDeletionState, filterResurrected } from '@/lib/addon-tombstones'
import { normalizeDestinations } from '@/lib/addon-destinations'
import { exportAvatarValue } from '@/lib/avatar-export'
import { trace } from '@/lib/trace'
import { deleteAccountIds, mergeAccountMembership, readAccountImport, restoreAccountIds, type AccountListImport } from '@/lib/account-membership'
import { readSyncedSettings } from '@/lib/synced-settings'
import { decrypt, encrypt } from '@/lib/crypto'
import { AddonDescriptor, AddonManifest } from '@/types/addon'
import { getHostnameIdentifier } from '@/lib/addon-identifier'
import { Account } from '@/types/account'
import type { Connection } from '@/types/connection'
import { exportJellyfinCredentials, importJellyfinCredentials, openJellyfinSecret, sealJellyfinSecret, recoverJellyfinConnection } from '@/lib/jellyfin/connection-data'
import { mergeConnections, resolvePrimaryConnectionId } from '@/lib/connection-merge'
import { importConnectionRemovalState, restoredConnectionIds, pruneConnectionRemovalState, readConnectionRemovals, readConnectionRestores } from '@/lib/connection-removals'
import { legacyConnectionGeneration } from '@/lib/connection-generation'
import { markerRemovedStremioLoginIds, resolvePrimaryStremio, stremioAuthKeyAfterMarkerRemovals, stremioConnectionsOf } from '@/lib/connection-identity'
import { SAVED_LOGIN_LOCKED, isSavedCredentialFailure } from './accountSync'
import { isAIOStreamsAddon, parseAIOStreamsUrl } from '@/lib/aiostreams-utils'
import { isAIOMetadataAddon, parseAIOMetadataUrl } from '@/lib/aiometadata-utils'
import type { PictureRowState } from '@/lib/connection-pictures/types'
import { mergeConnectionPictures, migrateConnectionPictures, staleConnectionPictureRowIds, CONNECTION_PICTURES_SCHEMA_VERSION } from '@/lib/connection-pictures/sync-merge'
import { useProfileStore } from '@/store/profileStore'
import localforage from 'localforage'
import { triggerSync } from '@/lib/sync-trigger'
import { toast } from '@/hooks/use-toast'
import { applySyncedSettings } from '@/lib/synced-settings'
import {
    getEncryptionKey,
    sanitizeAddonManifest,
    safeUUID,
    persistAccountMembership,
    acquireSyncMutex,
    ACCOUNT_MEMBERSHIP_MUTEX,
    STORAGE_KEY,
    CHANGELOG_KEY,
    BACKUP_KEY,
    getStremioAuthKey,
    persistAccounts,
    setAccountLoading,
    clearAllAccountLoading,
} from '../accountStore'
import type { AccountStore } from '../accountStore'
import { captureSyncOwnership } from '../sync-store-helpers'
import { restoreKnownManifests } from '@/lib/manifest-placeholder'
import { reuseUnchanged } from '@/lib/reuse-unchanged'

type StoreRef = { getState: () => AccountStore; setState: (partial: Partial<AccountStore> | ((state: AccountStore) => Partial<AccountStore>)) => void }

async function getStore(): Promise<StoreRef> {
    const { useAccountStore } = await import('../accountStore')
    return useAccountStore
}

// Decide whether the stored authKey ciphertext can be kept byte for byte during
// a no-change import instead of re-encrypting. authKey is a legacy mirror:
// connection-based accounts keep the canonical secret on the connection, and
// their mirror (often empty or stale) must still re-encrypt exactly as before.
export function canReuseAuthKeyCiphertext(
    matchedAccount: { authKey?: string },
    canonicalAuthKey: string,
    storedSecretKey: string | null | undefined,
    raRawKey: string | null | undefined,
    sameKeyContext: boolean,
): boolean {
    return !!sameKeyContext
        && !!matchedAccount.authKey
        && canonicalAuthKey === matchedAccount.authKey
        && !!storedSecretKey
        && (!raRawKey || raRawKey === storedSecretKey)
}

// A matched account's stored Stremio logins, offered to adoption as sealed proofs.
export interface LocalStremioLogin {
    id: string
    email?: string
    sealed: string
}

// Explicit canonical-connection context plus the matched account's verified logins;
// adoption never resolves the account match on its own. portableCredentials carries
// this connection's values from the top-level payload sidecar, never the record.
export interface IncomingConnectionAdoptionContext {
    readKey: CryptoKey
    writeKey: CryptoKey
    matched: boolean
    incomingCanonicalId?: string
    portableFlatKey: string
    portableCredentials?: Record<string, string>
    localStremio?: LocalStremioLogin[]
}

// An incoming Stremio connection credential may only replace a local one when the
// importing vault can use it or the login identity is proven. The exporter's portable
// secret wins over any local value; a foreign ciphertext never binds another login's
// key, and an unprovable login is rejected as needs-login instead.
export async function adoptIncomingAddonConnection(
    inc: Partial<Connection>,
    context: IncomingConnectionAdoptionContext,
): Promise<Partial<Connection>> {
    const record = inc
    if (record.platform !== 'stremio') return record
    const incoming = record.credentials?.authKey
    if (typeof incoming !== 'string' || !incoming) return record
    const { readKey, writeKey } = context
    const credentials = { ...(record.credentials || {}) }
    const localLogins = (context.matched ? context.localStremio : undefined) || []
    const canonical = !!record.id && record.id === context.incomingCanonicalId

    const openUnderWrite = async (sealed: string): Promise<string | null> => {
        try {
            const plain = await decrypt(sealed, writeKey)
            return plain || null
        } catch { return null }
    }
    const openAnywhere = async (sealed: string): Promise<string | null> => {
        const underWrite = await openUnderWrite(sealed)
        if (underWrite !== null) return underWrite
        try {
            const plain = await decrypt(sealed, readKey)
            return plain || null
        } catch { return null }
    }

    const portableSecret = context.portableCredentials?.authKey
    const portable = typeof portableSecret === 'string' && portableSecret ? portableSecret : undefined
    if (portable) {
        // The exporter decrypted this login's own key; it wins over any local secret.
        // A local ciphertext holding the same secret is kept byte for byte.
        for (const login of localLogins) {
            if (await openUnderWrite(login.sealed) === portable) {
                credentials.authKey = login.sealed
                return { ...record, credentials }
            }
        }
        credentials.authKey = await encrypt(portable, writeKey)
        return { ...record, credentials }
    }

    try {
        const plain = await decrypt(incoming, readKey)
        // Same-vault ciphertext valid under the write key stays byte identical; a
        // readable value under a replaced key is re-sealed.
        credentials.authKey = await openUnderWrite(incoming) !== null ? incoming : await encrypt(plain, writeKey)
        return { ...record, credentials }
    } catch { /* not readable under the import keys */ }
    if (incoming.length <= 60) {
        // Legacy interim format carried plaintext in the sealed field.
        credentials.authKey = await encrypt(incoming, writeKey)
        return { ...record, credentials }
    }

    // Foreign ciphertext: a local secret survives only with a proven login match,
    // never by sort order or mere presence on the same account.
    const sameLogin = record.id && localLogins.find(l => l.id === record.id
        && (!credentials.email || !l.email || l.email === credentials.email))
    if (sameLogin) {
        const localPlain = await openAnywhere(sameLogin.sealed)
        if (localPlain !== null && (!canonical || !context.portableFlatKey || localPlain === context.portableFlatKey)) {
            credentials.authKey = await openUnderWrite(sameLogin.sealed) !== null
                ? sameLogin.sealed
                : await encrypt(localPlain, writeKey)
            return { ...record, credentials }
        }
    }

    // The account-level portable key belongs to the canonical login only.
    if (canonical && context.portableFlatKey) {
        credentials.authKey = await encrypt(context.portableFlatKey, writeKey)
        return { ...record, credentials }
    }

    // Unknown login: reject explicitly (empty value) so the merge cannot restore an
    // unreadable local credential the adoption just refused.
    credentials.authKey = ''
    return { ...record, credentials, status: 'pending', lastError: SAVED_LOGIN_LOCKED }
}

// The versioned portable sidecar travels top-level in the backup/sync payload, keyed by
// account and connection id, so a shipped-beta normalizer never copies it into a stored
// Account or Connection; new readers adopt its values before merge and never persist it.
export function readPortableConnectionCredentials(data: Record<string, unknown>): Record<string, Record<string, Record<string, string>>> {
    const sidecar = data.portableConnectionCredentials
    if (!sidecar || typeof sidecar !== 'object') return {}
    const { version, entries: rawEntries } = sidecar as { version?: unknown; entries?: unknown }
    if (version !== 1 || !rawEntries || typeof rawEntries !== 'object') return {}
    const entries: Record<string, Record<string, Record<string, string>>> = {}
    for (const [accountId, byConnection] of Object.entries(rawEntries as Record<string, unknown>)) {
        if (!byConnection || typeof byConnection !== 'object') continue
        const connections: Record<string, Record<string, string>> = {}
        for (const [connectionId, values] of Object.entries(byConnection as Record<string, unknown>)) {
            if (!values || typeof values !== 'object') continue
            const clean = Object.fromEntries(Object.entries(values as Record<string, unknown>)
                .filter(([, value]) => typeof value === 'string' && value)) as Record<string, string>
            if (Object.keys(clean).length > 0) connections[connectionId] = clean
        }
        if (Object.keys(connections).length > 0) entries[accountId] = connections
    }
    return entries
}

// Emitted only when at least one portable value exists; a credentials-free export carries none.
export function portableSidecarField(entries: Record<string, Record<string, Record<string, string>>>): Record<string, unknown> {
    return Object.keys(entries).length > 0
        ? { portableConnectionCredentials: { version: 1, entries } }
        : {}
}

// Sync exports deduplicate manifests in the envelope; manual backups embed them.
export function shapeExportAddon(    addon: AddonDescriptor,
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
    const sanitized = sanitizeAddonManifest(restoreKnownManifests([exportAddon])[0].manifest, exportAddon.transportUrl)
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
        // Destination policy must survive export/import and the cloud-sync blob —
        // without this the policy silently dies on every sync push (design §4.5.13).
        destinations: exportAddon.destinations,
    }
}

// One damaged media credential must not fail the whole export or sync push: isolate the
// failure per connection, keep the metadata, and mark the record pending so an import
// requests a fresh sign-in for that connection only.
async function exportConnectionForBackup(c: Connection, includeCredentialsValue: boolean, forSync: boolean, portableOut?: Record<string, string>): Promise<Record<string, unknown>> {
    const record: Record<string, unknown> = {
        id: c.id,
        platform: c.platform,
        connectionType: c.connectionType,
        driverType: c.driverType,
        enabled: c.enabled,
        profileMapping: c.profileMapping,
        capabilities: c.capabilities,
        pluginList: c.pluginList,
        driverConfig: c.driverConfig,
        displayName: c.displayName,
        mediaServer: c.mediaServer,
        // Incarnation token (R2-06): rides the backup and the cloud envelope so a
        // removal on the importing device can claim this incarnation's server rows.
        ...(c.generation ? { generation: c.generation } : {}),
    }
    if (c.platform !== 'jellyfin') {
        if (!includeCredentialsValue) return { ...record, credentials: {} }
        const credentials: Record<string, string> = {}
        for (const [field, value] of Object.entries(c.credentials || {})) {
            if (typeof value !== 'string' || !value) continue
            // The legacy sealed field stays byte-compatible for shipped-beta readers; the
            // decrypted secret travels only in the top-level sidecar, never on the record.
            credentials[field] = value
            try {
                const plain = await decrypt(value, getEncryptionKey()!)
                if (portableOut) portableOut[field] = plain
            } catch {
                // Already plaintext: only the legacy field travels, exactly as before.
            }
        }
        return { ...record, credentials }
    }
    if (!includeCredentialsValue && !forSync) {
        return { ...record, credentials: {}, status: 'pending' }
    }
    try {
        const credentials = await exportJellyfinCredentials(c, value => decrypt(value, getEncryptionKey()!))
        return credentials.jellyfinExport
            ? { ...record, credentials }
            : { ...record, credentials: {}, status: 'pending' }
    } catch {
        // Never log the failure detail: it could carry the private server address or token.
        if (import.meta.env.DEV) console.warn('[Export] A media connection requires sign-in on import; its credentials could not be exported')
        return { ...record, credentials: {}, status: 'pending' }
    }
}

/**
 * CP-R2-004 + CP-R3-002: migrate and bound the imported picture state, then
 * drop rows that reference connections or facade instances the incoming
 * account no longer has. Rows for the removed platforms are dropped by the
 * schema-3 migration itself. Pure over the raw incoming record so the merge
 * cannot resurrect stale rows.
 */
function pruneImportedConnectionPictures(acc: Record<string, unknown>): Record<string, PictureRowState> | undefined {
    const migrated = migrateConnectionPictures(acc.connectionPictures)
    if (!migrated) return undefined
    const connections = Array.isArray(acc.connections) ? acc.connections as Array<{ id?: unknown }> : []
    const addons = (Array.isArray(acc.addons) ? acc.addons : []) as AddonDescriptor[]
    const instanceKeys = (isFacade: (a: AddonDescriptor) => boolean, parse: (url: string) => { baseUrl: string; uuid: string } | null) =>
        new Set(addons.flatMap(a => {
            if (!isFacade(a)) return []
            const parsed = parse(a.transportUrl || '')
            return parsed ? [`${parsed.baseUrl}|${parsed.uuid}`] : []
        }))
    const stale = staleConnectionPictureRowIds(migrated, {
        connectionIds: new Set(connections.map(c => (typeof c.id === 'string' ? c.id : '')).filter(Boolean)),
        aiostreamsInstances: instanceKeys(isAIOStreamsAddon, parseAIOStreamsUrl),
        aiometadataInstances: instanceKeys(isAIOMetadataAddon, parseAIOMetadataUrl),
    })
    if (stale.length === 0) return migrated
    const pruned = { ...migrated }
    for (const id of stale) delete pruned[id]
    return Object.keys(pruned).length > 0 ? pruned : undefined
}

// One saved login this device cannot unlock must not fail the whole export or sync
// push: the account travels without its account-level secrets and is reported as
// locked so callers can mark it needs-sign-in. Only sealed-credential failures are
// isolated; any other fault is a runtime error and still throws.
export async function decryptExportedAccountSecrets(
    sealedAuthKey: string,
    sealedPassword: string | undefined,
    decryptValue: (value: string, key: CryptoKey) => Promise<string>,
    key: CryptoKey,
): Promise<{ authKey?: string; password?: string; locked: boolean }> {
    let authKey: string | undefined
    let password: string | undefined
    let locked = false
    try {
        authKey = await decryptValue(sealedAuthKey, key)
    } catch (e) {
        if (!isSavedCredentialFailure(e)) throw e
        locked = true
    }
    if (sealedPassword) {
        try {
            password = await decryptValue(sealedPassword, key)
        } catch (e) {
            if (!isSavedCredentialFailure(e)) throw e
        }
    }
    return { authKey, password, locked }
}

async function buildExportData(
    includeCredentialsValue: boolean,
    forSync: boolean,
    onLockedAccount?: (account: { id: string; name: string }) => void,
): Promise<Record<string, unknown>> {
    const store = await getStore()
    const manifestMap: Record<string, AddonDescriptor['manifest']> = {}
    const portableEntries: Record<string, Record<string, Record<string, string>>> = {}

    const processAddons = (addons: AddonDescriptor[]) => {
        return addons.map((addon: AddonDescriptor) => shapeExportAddon(addon, manifestMap, forSync))
    }

    // Sync blobs only: an avatar data URI over the hard ceiling is not exported (the
    // local copy is kept), so one bad picture can never block sync again.
    const exportAvatar = (acc: { id: string; avatar?: string }) => {
        if (!forSync) return acc.avatar
        const guarded = exportAvatarValue(acc.avatar)
        if (guarded.dropped) trace('sync', 'export.avatar-ceiling', { accountId: acc.id })
        return guarded.value ?? undefined
    }

    const lockedExportAccounts: Array<{ id: string; name: string }> = []
    const exportedAccounts = await Promise.all(
        store.getState().accounts.map(async (acc) => {
            const secrets = includeCredentialsValue
                ? await decryptExportedAccountSecrets(getStremioAuthKey(acc), acc.password, decrypt, getEncryptionKey())
                : { authKey: undefined, password: undefined, locked: false }
            if (secrets.locked) lockedExportAccounts.push({ id: acc.id, name: acc.name })
            return {
                id: acc.id,
                name: acc.name,
                email: acc.email,
                authKey: secrets.authKey,
                password: secrets.password,
                accentColor: acc.accentColor,
            emoji: acc.emoji,
            avatar: exportAvatar(acc),
            note: acc.note,
            profiles: acc.profiles,
            activeProfileId: acc.activeProfileId,
            deletedAddons: acc.deletedAddons,
            restoredAddons: acc.restoredAddons,
            // Both marker maps ride the blob, pruned so the envelope stays bounded;
            // the fields are additive, older readers ignore them.
            ...pruneConnectionRemovalState(acc),
            // CP-R3-002: the export re-applies the bounds, so a marker that
            // somehow bypassed the setter can never ride the blob.
            connectionPictures: migrateConnectionPictures(acc.connectionPictures),
            connectionPicturesSchemaVersion: acc.connectionPictures ? CONNECTION_PICTURES_SCHEMA_VERSION : undefined,
            addons: processAddons(acc.addons),
            connections: await Promise.all((acc.connections || []).map(async c => {
                const portable: Record<string, string> = {}
                const exported = await exportConnectionForBackup(c, includeCredentialsValue, forSync, portable)
                if (Object.keys(portable).length > 0) {
                    portableEntries[acc.id] = portableEntries[acc.id] || {}
                    portableEntries[acc.id][c.id] = portable
                }
                return exported
            })),
            primaryConnectionId: acc.primaryConnectionId,
            apiKey: includeCredentialsValue ? acc.apiKey : undefined,
            createdAt: acc.createdAt,
            hideLastWatched: acc.hideLastWatched,
            hideAddonPreview: acc.hideAddonPreview,
            hidePlatformLogos: acc.hidePlatformLogos,
            }
        })
    )

    if (lockedExportAccounts.length > 0) {
        // Reuse the account-level needs-sign-in state the regular sync already
        // writes for a locked login (accountSync syncAccount catch: expired +
        // SAVED_LOGIN_LOCKED), so the card shows the existing re-enter copy.
        const lockedIds = new Set(lockedExportAccounts.map(a => a.id))
        const markedAccounts = store.getState().accounts.map(acc => lockedIds.has(acc.id)
            ? { ...acc, status: 'expired' as const, lastError: SAVED_LOGIN_LOCKED, lastErrorAt: Date.now() }
            : acc)
        store.setState({ accounts: markedAccounts })
        persistAccounts(markedAccounts)
        for (const locked of lockedExportAccounts) onLockedAccount?.(locked)
    }

    const apiKeys: Record<string, string> = {}
    for (const acc of store.getState().accounts) {
        if (includeCredentialsValue && acc.apiKey) apiKeys[acc.id] = acc.apiKey
    }

    const addonStoreModule = await import('@/store/addonStore')
    const { useAddonStore } = addonStoreModule

    if (forSync) {
        return {
            version: '2.1.0',
            manifests: manifestMap,
            accounts: exportedAccounts,
            ...portableSidecarField(portableEntries),
            deletedAccounts: store.getState().deletedAccounts,
            restoredAccounts: store.getState().restoredAccounts,
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
        version: '2.1.0',
        exportedAt: new Date().toISOString(),
        manifests: manifestMap,
        accounts: exportedAccounts,
        ...portableSidecarField(portableEntries),
        deletedAccounts: store.getState().deletedAccounts,
        restoredAccounts: store.getState().restoredAccounts,
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

export async function exportAccountsForSyncWithLocked(): Promise<{ data: Record<string, unknown>; lockedAccounts: Array<{ id: string; name: string }> }> {
    const lockedAccounts: Array<{ id: string; name: string }> = []
    try {
        const data = await buildExportData(true, true, account => lockedAccounts.push(account))
        return { data, lockedAccounts }
    } catch (error) {
        if (import.meta.env.DEV) console.error('Failed to export accounts for sync:', error)
        throw error
    }
}

export async function exportAccountsForSync(): Promise<Record<string, unknown>> {
    return (await exportAccountsForSyncWithLocked()).data
}

// Accept file JSON or a parsed sync envelope. Ownership fences cover imports, rollback,
// and deferred persistence so superseded work cannot change the replacement session.
async function liftImportedAccountTombstones(ids: string[]) {
    if (ids.length === 0) return
    try {
        const { liftAccountServerTombstones } = await import('@/lib/account-server-cleanup')
        // Lifts that fail here (offline, signed out, rate limited) stay queued and are retried
        // before these accounts' rules upload.
        await liftAccountServerTombstones(async (path, init) => {
            const { useSyncStore } = await import('../syncStore')
            const { auth, serverUrl } = useSyncStore.getState()
            if (!auth.isAuthenticated) throw new Error('Not signed in')
            const { getSyncPasswordHeader } = await import('@/lib/sync-auth')
            const syncToken = await getSyncPasswordHeader(auth)
            const baseUrl = serverUrl || ''
            const apiPath = baseUrl.startsWith('http') ? `${baseUrl.replace(/\/$/, '')}/api` : '/api'
            return fetch(`${apiPath}${path}`, { ...init, headers: { 'x-sync-password': syncToken, 'x-sync-user': auth.id } })
        }, ids)
    } catch {
        // The queue could not be read or written; the next import retries.
    }
}

// An incoming record from a locked exporter carries no account-level secrets, so the
// importing device's working key wins exactly as before; an incoming secret still
// overrides. The exporter drops what it cannot unlock, so a still-sealed string can
// never arrive here posing as plaintext.
export function resolveMergedAccountSecrets(
    incomingKey: string | undefined,
    incomingPassword: string | undefined,
    localKey: string | null | undefined,
    localPassword: string | undefined,
): { authKey: string | null | undefined; password: string | undefined } {
    return {
        authKey: incomingKey || localKey,
        password: incomingPassword !== undefined ? incomingPassword : localPassword,
    }
}

// Connection incarnation tokens after an import (R2-06): a cloud sync merge or a
// plain file merge preserves the incoming/local generation (same incarnation, and a
// legacy side gets one minted); an explicit RESTORE re-mints every connection the
// backup brought back, so a delayed cleanup of the removed incarnation can never
// claim the restored one's rows. Since R3-03 the legacy mint is the same
// deterministic digest the load migration uses, so a generationless import joins
// the incarnation every other device holds for that connection.
export async function settleImportedConnectionGenerations(accountId: string, connections: Connection[] | undefined, incomingIds: Set<string>, accountList: AccountListImport): Promise<Connection[] | undefined> {
    if (!connections) return connections
    return Promise.all(connections.map(async c => {
        if (accountList === 'restore' && incomingIds.has(c.id)) return { ...c, generation: safeUUID() }
        if (!c.generation) return { ...c, generation: await legacyConnectionGeneration(accountId, c.id) }
        return c
    }))
}

export async function importAccounts(json: string | Record<string, unknown>, isSilent = false, mode: 'merge' | 'mirror' = 'merge', localDecryptionKey?: CryptoKey | null, ownership?: import('../sync-store-helpers').SyncOwnership, accountList: AccountListImport = 'merge') {
    const own = ownership ?? captureSyncOwnership()
    const store = await getStore()
    own.assert()
    if (!store.getState().hydrated) {
        await store.getState().initialize()
        own.assert()
        if (!store.getState().hydrated) throw new Error('Accounts could not be loaded; import was not applied')
    }
    store.setState({ error: null })
    setAccountLoading('__import__')
    const mutexReleases: Array<() => void> = []
    let restorePreImport: (() => Promise<void>) | null = null
    try {
        mutexReleases.push(await acquireSyncMutex(ACCOUNT_MEMBERSHIP_MUTEX))
        mutexReleases.push(...await Promise.all(store.getState().accounts.map(a => acquireSyncMutex(a.id))))
        own.assert()
        let data: Record<string, unknown>
        if (!json) throw new Error('No data provided to import')
        try {
            data = typeof json === 'object' ? (json as Record<string, unknown>) : JSON.parse(json) as Record<string, unknown>
        } catch (e) {
            throw new Error('Invalid JSON format for import')
        }
        if (!data || typeof data !== 'object') throw new Error('Invalid backup format')
        const accountsToImport = readAccountImport(data)
        if (accountList === 'sync' && accountsToImport === undefined) throw new Error('Cloud data is missing accounts')
        // A file merge is additive. Sync/restore retain deletion history;
        // explicit imports acknowledge deletions for the selected accounts.
        let membership = mergeAccountMembership(store.getState(), accountList !== 'merge' ? data : {})

        const manifestMap = (data.manifests || {}) as Record<string, unknown>
        const portableConnectionCredentials = readPortableConnectionCredentials(data)

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
            membership: willImportAccounts ? mergeAccountMembership(store.getState()) : null,
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
        // Restore memory first, then re-persist under the same ownership fence.
        restorePreImport = async () => {
            if (preImport.accounts !== null) store.setState({ accounts: reuseUnchanged(store.getState().accounts, preImport.accounts), ...preImport.membership, changelog: preImport.changelog ?? undefined })
            useAddonStore.setState({ library: preImport.addonLibrary, accountStates: preImport.addonAccountStates })
            useFailoverStore.setState({ rules: preImport.failoverRules, webhook: preImport.failoverWebhook })
            useProfileStore.setState({ profiles: preImport.profiles })
            if (preImport.vaultKeys !== null) useVaultStore.setState({ keys: preImport.vaultKeys ?? undefined, tombstones: preImport.vaultTombstones ?? undefined })
            if (preImport.watchEvents !== null) useWatchEventStore.setState({ events: preImport.watchEvents ?? undefined, snapshot: preImport.watchSnapshot ?? undefined, deletedEventKeys: preImport.watchDeleted ?? undefined })
            if (preImport.notesIndex !== null) useNotesStore.setState({ notes: preImport.notesIndex ?? undefined, trash: preImport.notesTrash ?? undefined })
            applySyncedSettings(preImport.settings, true)
            await (async () => {
                try {
                    const { default: localforage } = await import('localforage')
                    const notesModule = await import('@/store/notesStore')
                    own.assert()
                    const results = await Promise.allSettled([
                        preImport.accounts !== null && preImport.membership !== null ? persistAccountMembership(preImport.accounts, preImport.membership, own) : Promise.resolve(),
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
                            // Capture rollback ciphertexts before awaiting writes; fence every subsequent dispatch.
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

        if (accountsToImport === undefined) {
            own.assert()
            if (!isSilent) triggerSync()
            return
        }

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
                deletedConnections: readConnectionRemovals(acc.deletedConnections),
                restoredConnections: readConnectionRestores(acc.restoredConnections),
                // CP-R2-004: normalize, bound and prune the imported picture
                // state (stale rows for connections/instances the incoming
                // account no longer has never enter the merged blob), and
                // stamp the schema version that interpreted it.
                connectionPictures: pruneImportedConnectionPictures(acc),
                connectionPicturesSchemaVersion: CONNECTION_PICTURES_SCHEMA_VERSION,
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
                            // Sanitize inbound policy per entry: valid entries survive
                            // verbatim (never widened), junk entries are dropped
                            // individually; a wholly-invalid field collapses to absent
                            // policy (= default allow, same as any pre-feature row).
                            destinations: normalizeDestinations(ad.destinations as AddonDescriptor['destinations']),
                            manifest: sanitizeAddonManifest(restoreKnownManifests([{ transportUrl, manifest: (ad.manifest || manifestMap[ad.manifestId as string]) as AddonManifest }])[0].manifest, transportUrl || undefined),
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
        // A cloud restore can replace the local vault key. Rewrap browser-only media
        // credentials before metadata-only connection merges preserve the local record.
        const currentAccounts = await Promise.all(store.getState().accounts.map(async account => {
            if (!localDecryptionKey) return account
            return { ...account, connections: await Promise.all((account.connections || []).map(async connection => {
                if (connection.platform !== 'jellyfin' || !connection.credentials?.jellyfin) return connection
                return recoverJellyfinConnection(connection, async c => {
                    const secret = await openJellyfinSecret(c, value => decrypt(value, localDecryptionKey))
                    return { ...c, credentials: await sealJellyfinSecret(secret, value => encrypt(value, getWriteEncryptionKey())) }
                })
            })) }
        }))

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
        const incomingIds = new Set(normalizedAccounts.map(a => a.id))

        for (const ra of normalizedAccounts) {
            if (accountList === 'sync' && Object.hasOwn(membership.deletedAccounts, ra.id)) continue
            const availableAccounts = currentAccounts.filter(a => !processedLocalIds.has(a.id)
                && (a.id === ra.id || !incomingIds.has(a.id))
                && (accountList !== 'sync' || !Object.hasOwn(membership.deletedAccounts, a.id)))
            let matchedAccount = availableAccounts.find((a) => a.id === ra.id)

            if (!matchedAccount && ra.rawKey) {
                const found = localDecrypted.find((ld) => ld.key === ra.rawKey && availableAccounts.some(a => a.id === ld.id))
                if (found) matchedAccount = availableAccounts.find((a) => a.id === found.id)
            }

            const raHasCredentials = !!ra.rawKey || (ra.connections || []).some(c => c.credentials)

            if (!matchedAccount && ra.email) {
                matchedAccount = availableAccounts.find((a) => {
                    if (a.email?.toLowerCase() !== ra.email?.toLowerCase()) return false
                    const aHasCredentials = !!localSecretsById.get(a.id)?.key || (a.connections || []).some(c => c.credentials)
                    return raHasCredentials === aHasCredentials
                })
            }

            if (!matchedAccount && ra.apiKey) {
                matchedAccount = availableAccounts.find((a) => {
                    if (a.apiKey !== ra.apiKey) return false
                    const aHasCredentials = !!localSecretsById.get(a.id)?.key || (a.connections || []).some(c => c.credentials)
                    return raHasCredentials === aHasCredentials
                })
            }

            if (ra.connections) {
                // The opener validates legacy same-key ciphertext; anything that cannot be
                // decrypted, parsed and matched to the record's user becomes pending.
                const localConnections = matchedAccount?.connections || []
                const localStremio: LocalStremioLogin[] = []
                for (const c of stremioConnectionsOf(localConnections)) {
                    const sealed = c.credentials?.authKey
                    if (typeof sealed === 'string' && sealed) localStremio.push({ id: c.id, email: c.credentials?.email, sealed })
                }
                const incomingCanonicalId = resolvePrimaryStremio(ra.connections as Connection[], ra.primaryConnectionId)?.id
                ra.connections = await Promise.all(ra.connections.map(async c => {
                    const adopted = await adoptIncomingAddonConnection(c, {
                        readKey: getReadEncryptionKey(),
                        writeKey: getWriteEncryptionKey(),
                        matched: !!matchedAccount,
                        incomingCanonicalId,
                        portableFlatKey: ra.rawKey,
                        portableCredentials: c.id ? portableConnectionCredentials[ra.id]?.[c.id] : undefined,
                        localStremio,
                    })
                    return recoverJellyfinConnection(adopted,
                        value => importJellyfinCredentials(
                            value,
                            text => encrypt(text, getWriteEncryptionKey()),
                            text => decrypt(text, getReadEncryptionKey()),
                        ))
                }))
            }

            if (matchedAccount) {
                const matchedSecrets = localSecretsById.get(matchedAccount.id)
                // Keeping the stored ciphertext is byte-identical only when the same key
                // that decrypted the local secrets is the one being written with. A
                // cross-salt restore supplies a different read key and must re-encrypt.
                const keepLocalCiphertext = (localDecryptionKey ?? getEncryptionKey()) === getEncryptionKey()
                const { authKey: mergedAuthKey, password: mergedPassword } = resolveMergedAccountSecrets(ra.rawKey, ra.password, matchedSecrets?.key, matchedSecrets?.password)
                // The authKey reuse must prove equality against the exact ciphertext it
                // keeps: the decrypted canonical secret (matchedSecrets.key) may live on
                // the connection, while the reused field is the legacy authKey mirror.
                const secretUnchanged = canReuseAuthKeyCiphertext(
                    matchedAccount,
                    getStremioAuthKey(matchedAccount),
                    matchedSecrets?.key,
                    ra.rawKey,
                    keepLocalCiphertext,
                )
                const passwordUnchanged = !!matchedSecrets && (keepLocalCiphertext && (ra.password === undefined || ra.password === matchedSecrets.password))
                const mergedAuthKeyValue = mergedAuthKey
                    ? (secretUnchanged ? matchedAccount.authKey : await encrypt(mergedAuthKey, getWriteEncryptionKey()))
                    : matchedAccount.authKey
                const updated: Account = {
                    ...matchedAccount,
                    name: ra.name || matchedAccount.name,
                    authKey: mergedAuthKeyValue,
                    password: mergedPassword
                        ? (passwordUnchanged ? matchedAccount.password : await encrypt(mergedPassword, getWriteEncryptionKey()))
                        : matchedAccount.password,
                    accentColor: ra.accentColor || matchedAccount.accentColor,
                    emoji: ra.emoji || matchedAccount.emoji,
                    note: ra.note ?? matchedAccount.note,
                    hideLastWatched: ra.hideLastWatched ?? matchedAccount.hideLastWatched,
                    hideAddonPreview: ra.hideAddonPreview ?? matchedAccount.hideAddonPreview,
                    hidePlatformLogos: ra.hidePlatformLogos ?? matchedAccount.hidePlatformLogos,
                    avatar: matchedAccount.avatar ?? ra.avatar,
                    connectionPictures: mergeConnectionPictures(matchedAccount.connectionPictures, ra.connectionPictures),
                    connectionPicturesSchemaVersion: Math.max(
                        matchedAccount.connectionPicturesSchemaVersion ?? CONNECTION_PICTURES_SCHEMA_VERSION,
                        ra.connectionPicturesSchemaVersion ?? CONNECTION_PICTURES_SCHEMA_VERSION,
                    ),
                    apiKey: ra.apiKey ?? matchedAccount.apiKey ?? safeUUID(),
                    profiles: reuseUnchanged(matchedAccount.profiles, (() => {
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
                    })()),
                    activeProfileId: matchedAccount.activeProfileId ?? ra.activeProfileId,
                    ...(() => {
                        // Resolve explicit reinstalls before either device's list can enter the merge.
                        const deletionState = mergeAddonDeletionState(
                            matchedAccount.deletedAddons, ra.deletedAddons,
                            matchedAccount.restoredAddons, ra.restoredAddons,
                        )
                        const localAddons = filterResurrected(matchedAccount.addons, [], deletionState.deletedAddons)
                        const remoteAddons = filterResurrected(ra.addons, [], deletionState.deletedAddons)
                        const mergedAddons = mode === 'mirror'
                            ? remoteAddons
                            : mergeAddons(localAddons, remoteAddons, { keepMissingLocal: true, instanceMatch: 'adopt-remote-url' })
                        return { addons: reuseUnchanged(matchedAccount.addons, mergedAddons), ...deletionState }
                    })(),
                    ...(await (async () => {
                        // Re-point primaries that referred to media or removed connections.
                        // Removal markers by flow (lib/connection-removals.ts): a sync
                        // pull merges both devices' maps newest-wins so an explicit
                        // removal survives a stale copy; a backup restore acknowledges
                        // the markers of every connection it brings back; a merge-mode
                        // file import adopts no file markers, so an old backup cannot
                        // delete a live connection. A read/merge never queues server
                        // credential cleanup: rows of a live connection are deleted only
                        // by an explicit AIOManager removal (connectionStore) or a
                        // deletion record, never because a merge chose not to keep the
                        // connection locally.
                        const incomingConnectionIds = new Set((ra.connections || []).map(c => c?.id).filter(Boolean) as string[])
                        const restoredIds = restoredConnectionIds(incomingConnectionIds, !!ra.rawKey, [matchedAccount.id, ra.id])
                        const removalState = importConnectionRemovalState(accountList, matchedAccount, ra, restoredIds)
                        const mergedConnections = mergeConnections(matchedAccount.connections, ra.connections, mode, removalState) ?? matchedAccount.connections
                        const primaryConnectionId = resolvePrimaryConnectionId(mergedConnections, ra.primaryConnectionId ?? matchedAccount.primaryConnectionId)
                        // A Stremio login dropped by a marker must not live on through
                        // the legacy flat key: reconcile account.authKey exactly the way
                        // an explicit removal does (clear when none survive, re-point at
                        // the surviving canonical otherwise), so the duplicate guards
                        // never see the removed login either. The candidates include the
                        // legacy synthesized ids (`${id}:stremio`, both records: a
                        // key/email match can pair different account ids) because a
                        // pre-multi-login account has no stored row to enumerate.
                        const markerRemovedStremioIds = markerRemovedStremioLoginIds({
                            localConnections: matchedAccount.connections,
                            incomingConnections: ra.connections,
                            accountIds: [matchedAccount.id, ra.id],
                            removals: removalState,
                        })
                        const authKeyAfterMarkerRemovals = markerRemovedStremioIds.length > 0
                            ? stremioAuthKeyAfterMarkerRemovals({
                                connections: mergedConnections,
                                primaryConnectionId,
                                previousAuthKey: mergedAuthKeyValue,
                                removedConnectionIds: markerRemovedStremioIds,
                            })
                            : undefined
                        return {
                            connections: reuseUnchanged(matchedAccount.connections, await settleImportedConnectionGenerations(matchedAccount.id, mergedConnections, incomingConnectionIds, accountList)),
                            primaryConnectionId,
                            ...removalState,
                            ...(authKeyAfterMarkerRemovals !== undefined ? { authKey: authKeyAfterMarkerRemovals } : {}),
                        }
                    })()),
                    lastSync: ra.lastSync || new Date(),
                    status: 'active' as const,
                }
                reconciledAccounts.push(updated)
                processedLocalIds.add(matchedAccount.id)
            } else {
                const deletionState = mergeAddonDeletionState(undefined, ra.deletedAddons, undefined, ra.restoredAddons)
                const importedAddons = filterResurrected(ra.addons, [], deletionState.deletedAddons)
                const incomingIds = new Set((ra.connections || []).map(c => c?.id).filter(Boolean) as string[])
                // Same marker policy as the matched-account branch (lib/connection-removals.ts).
                const restoredIds = restoredConnectionIds(incomingIds, !!ra.rawKey, [ra.id])
                const removalState = importConnectionRemovalState(accountList, undefined, ra, restoredIds)
                const importedConnections = await settleImportedConnectionGenerations(ra.id, mergeConnections(undefined, ra.connections, mode, removalState), incomingIds, accountList)
                const primaryConnectionId = resolvePrimaryConnectionId(importedConnections, ra.primaryConnectionId)
                // The flat key follows the surviving Stremio logins here too, so a
                // marker-removed login (the legacy synthesized `${ra.id}:stremio` id
                // included) cannot be synthesized back from account.authKey.
                const sealedFlatKey = ra.rawKey ? await encrypt(ra.rawKey, getWriteEncryptionKey()) : ''
                const markerRemovedStremioIds = markerRemovedStremioLoginIds({
                    localConnections: undefined,
                    incomingConnections: ra.connections,
                    accountIds: [ra.id],
                    removals: removalState,
                })
                const importedAccount = {
                    ...ra,
                    addons: importedAddons,
                    ...deletionState,
                    ...removalState,
                    authKey: markerRemovedStremioIds.length > 0
                        ? stremioAuthKeyAfterMarkerRemovals({
                            connections: importedConnections,
                            primaryConnectionId,
                            previousAuthKey: sealedFlatKey,
                            removedConnectionIds: markerRemovedStremioIds,
                        })
                        : sealedFlatKey,
                    password: ra.password ? await encrypt(ra.password, getWriteEncryptionKey()) : undefined,
                    connections: importedConnections,
                    primaryConnectionId,
                    apiKey: ra.apiKey ?? safeUUID(),
                } as Account
                reconciledAccounts.push(importedAccount)
            }
        }

        if (accountList !== 'sync') {
            membership = restoreAccountIds(membership, [...normalizedAccounts.map(a => a.id), ...reconciledAccounts.map(a => a.id)])
        }
        if (accountList === 'restore') {
            membership = deleteAccountIds(membership, currentAccounts.filter(a => !processedLocalIds.has(a.id)).map(a => a.id))
        }
        const localOnlyAccounts =
            accountList === 'restore'
                ? []
                : await Promise.all(
                    currentAccounts
                        .filter((a) => !processedLocalIds.has(a.id) && !Object.hasOwn(membership.deletedAccounts, a.id))
                        .map(migrateLocalAccountSecrets)
                )

        let finalAccounts: typeof currentAccounts
        if (accountList === 'restore' || mode === 'mirror') {
            finalAccounts = [...reconciledAccounts, ...localOnlyAccounts]
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
            }
            for (const acc of reconciledAccounts) {
                if (!seenIds.has(acc.id)) { ordered.push(acc); seenIds.add(acc.id) }
            }
            for (const acc of localOnlyAccounts) {
                if (!seenIds.has(acc.id)) { ordered.push(acc); seenIds.add(acc.id) }
            }
            finalAccounts = ordered
        }

        if (finalAccounts.length > 0) {
            const diskData = await localforage.getItem<Account[]>(STORAGE_KEY)
            if (diskData && Array.isArray(diskData) && diskData.length > 0) {
                own.assert()
                await localforage.setItem(BACKUP_KEY, diskData)
            }
        }

        own.assert()
        if (accountList === 'restore' && (finalAccounts.length !== accountsToImport.length || new Set(finalAccounts.map(a => a.id)).size !== finalAccounts.length)) {
            throw new Error('The backup account list could not be restored exactly; no account changes were saved')
        }
        await persistAccountMembership(finalAccounts, membership, own)
        const accountsPrev = store.getState().accounts
        store.setState({ accounts: reuseUnchanged(accountsPrev, finalAccounts), ...membership, hydrated: true })
        if (accountList !== 'sync') {
            const finalIds = new Set(finalAccounts.map(a => a.id))
            await liftImportedAccountTombstones([...normalizedAccounts, ...reconciledAccounts].map(a => a.id).filter(id => finalIds.has(id)))
            own.assert()
        }

        if (!isSilent) {
            triggerSync()
            toast({ title: 'Import Successful' })
        }
        if (own.current()) {
            store.getState().syncAllAccounts().catch(e => { if (import.meta.env.DEV) console.error(e) })
        }
    } catch (error) {
        // A superseded import must not roll back or publish errors into the replacement session.
        if (!own.current()) throw error
        try { await restorePreImport?.() } catch (rollbackErr) {
            if (import.meta.env.DEV) console.error('[Import] Rollback to pre-import state failed:', rollbackErr)
        }
        if (!own.current()) throw error
        store.setState({ error: (error as Error).message })
        throw error
    } finally {
        mutexReleases.forEach(release => release())
        if (own.current()) clearAllAccountLoading()
    }
}
