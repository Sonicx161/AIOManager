import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import { useAccountStore, getStremioAuthKey, getStremioConnections } from './accountStore'
import type { AddonDescriptor } from '@/types/addon'
import { useAddonStore } from './addonStore'
import { useProfileStore } from './profileStore'
import { useFailoverStore } from './failoverStore'
import { useAuthStore } from './authStore'
import { useVaultStore } from './vaultStore'
import { toast } from '@/hooks/use-toast'
import { deriveSyncToken } from '@/lib/crypto'
import { getSyncPasswordHeader } from '@/lib/sync-auth'
import { resilientFetch, syncUploadTimeoutMs, SYNC_PULL_TIMEOUT_MS } from '@/lib/api-resilience'
import { compressSyncPayload, decompressSyncPayload } from '@/lib/sync-payload-codec'
import { dedupeCanonicalAddons } from '@/lib/canonical-addons-dedup'
import * as capability from '@/lib/canonical-v2-capability'
import { decodeSyncBlob, isValidAvatarPayload, isValidWatchPayload } from '@/lib/sync-blob-decode'
import { applySyncedSettings, markSyncedSettingsPushed, readSyncedSettings, snapshotSyncedSettingsValues } from '@/lib/synced-settings'
import { resolveRestoreSaltPolicy } from '@/lib/salt-policy'
import { serverHasStremioCredential, canonicalMembershipChanged } from '@/lib/canonical-visibility'
import { needsCredentialHeal } from '@/lib/credential-heal'
import { mergeDeletedEventMaps } from '@/lib/event-tombstones'
import { mergeNotesTrash, filterNotesByTrash } from '@/lib/notes-tombstones'
import { shouldSendPullEtag, readServerSyncTimestamp, shouldMirrorAccountPull } from '@/lib/pull-restore'
import { setActiveWorkspace, getActiveWorkspaceId, ANON_WORKSPACE_ID } from '@/lib/workspace-persistence'
import {
    readPendingPushMarker,
    writePendingPushMarker,
    pendingPushDue,
    noteConfirmedPush,
    readLastConfirmedPushAt,
} from '@/lib/pending-push-marker'
import {
    bindRepublishHost,
    learnServerCredentialedAccounts,
    adoptPushResponseCredentials,
    consumeForceFlag,
    resetRepublishAttempts,
    clearRepublishState,
} from '@/lib/canonical-republish'

export { learnServerCredentialedAccounts }
import { createSafeStorage } from './safe-storage'
import { wipeAllData } from '@/lib/storage-reset'
import { resetAllStores } from '@/lib/store-coordinator'
import { trace } from '@/lib/trace'
import {
    computeHash,
    normalizeStateForSkipHash,
    acquireSyncLock,
    readIdentityProfile,
    writeIdentityProfile,
    getSyncApiPath,
    clearSyncCredentialCaches,
    isDeviceSessionActive,
    getActiveDeviceSyncKey,
    deviceUnlockFromSession,
    resetAccountsHydration,
    isAccountsHydrationComplete,
    LEGACY_SYNC_PASSWORD_KEY,
    syncRuntime,
    armSyncPushDebounce,
    flushSyncPushDebounce,
    resolveCloudIdentity,
    captureSyncOwnership,
    type SyncOwnership,
} from './sync-store-helpers'
export { markAccountsHydrated, readIdentityProfile, getSyncApiPath } from './sync-store-helpers'
import {
    getSessionSyncCredential,
    saveSessionSyncToken,
} from '@/lib/session-sync-token'
import { exportAvatarValue } from '@/lib/avatar-export'

// Suppress toasts during initial boot to prevent React "state update on unmounted component" warnings
setTimeout(() => { syncRuntime.appReady = true }, 3000)

// A health probe decides whether pushes may use the deduplicated canonicalAddons
// form. Servers that do not advertise the acknowledging protocol keep receiving the
// legacy inline field.
async function probeServerCanonicalAddonsV2(apiPath: string): Promise<capability.CanonicalV2Probe> {
    try {
        const res = await resilientFetch(`${apiPath}/health`, { timeout: 5000 })
        if (!res.ok) return 'unknown'
        return capability.readCanonicalV2Probe(await res.json().catch(() => null))
    } catch {
        return 'unknown'
    }
}

// A wrong-key AES-GCM decrypt throws an OperationError with an empty message; the push log and toast must never show a blank reason.
export function pushErrorMessage(error: unknown): string {
    const err = error as Error
    if (err.message) return err.message
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        return 'The sync request was aborted before the server answered; the connection may be too slow or interrupted. Try again on a stronger network.'
    }
    return `${err.name || 'Unknown error'}: could not unlock saved data (an account may need signing in)`
}

// Identity profile lives outside the churnable auth object: session resets, 401 wipes and
// expiry paths must never erase the user's chosen name or avatar. The id stamp scopes the
// local fallback to the owning account so identities never bleed across accounts.
export interface SyncHistoryEntry {
    id: string
    timestamp: string
    type: 'push' | 'pull' | 'force-push' | 'force-mirror'
    status: 'success' | 'error'
    message: string
    isAuto: boolean
}

interface SyncState {
    auth: {
        id: string
        password: string
        name: string
        avatar: string | null
        isAuthenticated: boolean
    }
    serverUrl: string
    lastSyncedAt: string | null
    pendingConflictAccountId: string | null
    lastSyncCheckedAt: string | null
    isSyncing: boolean
    isRefreshingFromCloud: boolean  // true only during the post-unlock pull - separate from write syncs
    isInitialSyncCompleted: boolean // Safety flag to prevent stale devices from pushing before they've pulled
    lastActionTimestamp: number
    lastSeenVersion: string | null
    syncSaltB64: string | null
    lastSyncedCloudEtag: string | null
    // Note count the last applied pull carried. Persisted so the 304 shortcut can
    // tell "cloud genuinely empty" apart from "local index was wiped underneath us".
    lastSyncedNotesCount: number | null
    lastAppliedAccountCount: number | null
    lastSyncedAccountIds: string[] | null
    /** The cloud ETag lastSyncedAccountIds was recorded with; cleanup trusts the ids only for this ETag. */
    lastSyncedAccountIdsEtag: string | null
    lastAppliedAddonCount: number | null
    serverStremioCredentialedAccounts: string[] | null
    // True only when an authenticated+unlocked session has NO usable server credential
    // (no in-memory password, no active device session): pushes are impossible and the
    // dashboard must banner it instead of skipping silently. Session-only; never persisted.
    needsReauth: boolean
    history: SyncHistoryEntry[]
    setLastSeenVersion: (version: string) => void
    addLogEntry: (data: Omit<SyncHistoryEntry, 'id' | 'timestamp'>) => void
    register: (password: string, name?: string) => Promise<void>
    login: (id: string, password: string, isSilent?: boolean, bypassGuard?: boolean, deviceUnlock?: { syncKey: CryptoKey }) => Promise<void>
    logout: () => void
    syncToRemote: (isAuto?: boolean, isDebounced?: boolean, forceFull?: boolean, forcePush?: boolean) => Promise<boolean>
    syncFromRemote: (isSilent?: boolean) => Promise<void>
    refreshFromCloud: () => Promise<void>
    forcePushState: () => Promise<void>
    forceMirrorState: () => Promise<void>
    setServerUrl: (url: string) => void
    setDisplayName: (name: string) => void
    setAvatar: (avatar: string | null) => void
    deleteRemoteAccount: () => Promise<void>
    reset: () => void
}

export const useSyncStore = create<SyncState>()(
    persist(
        (set, get) => ({
            auth: {
                id: '',
                password: '',
                name: readIdentityProfile().name,
                avatar: readIdentityProfile().avatar,
                isAuthenticated: false
            },
            serverUrl: '',
            lastSyncedAt: null,
            pendingConflictAccountId: null,
            lastSyncCheckedAt: null,
            isSyncing: false,
            isRefreshingFromCloud: false,
            isInitialSyncCompleted: false,
            lastActionTimestamp: 0,
            lastSeenVersion: null,
            syncSaltB64: null,
            lastSyncedCloudEtag: null,
            lastSyncedNotesCount: null,
            lastAppliedAccountCount: null,
            lastSyncedAccountIds: null,
            lastSyncedAccountIdsEtag: null,
            lastAppliedAddonCount: null,
            serverStremioCredentialedAccounts: null,
            needsReauth: false,
            history: [],

            setLastSeenVersion: (version: string) => {
                set({ lastSeenVersion: version })
            },

            addLogEntry: (data: Omit<SyncHistoryEntry, 'id' | 'timestamp'>) => {
                const entry: SyncHistoryEntry = {
                    ...data,
                    id: crypto.randomUUID(),
                    timestamp: new Date().toISOString()
                }
                set(state => ({
                    history: [entry, ...state.history].slice(0, 50)
                }))
            },

            setServerUrl: (url) => set({ serverUrl: url }),

            setDisplayName: (name) => {
                set((state) => ({
                    auth: { ...state.auth, name }
                }))
                writeIdentityProfile(get().auth.id, name, get().auth.avatar ?? null)
                get().syncToRemote(true).catch(e => { if (import.meta.env.DEV) console.error(e) })
            },

            setAvatar: (avatar) => {
                set((state) => ({
                    auth: { ...state.auth, avatar }
                }))
                writeIdentityProfile(get().auth.id, get().auth.name, avatar)
                if (avatar === null) syncRuntime.lastPulledCloudAvatar = null
                get().syncToRemote(true).catch(e => { if (import.meta.env.DEV) console.error(e) })
            },

            syncFromRemote: async (isSilent: boolean = true) => {
                const { auth } = get()
                if (!auth.isAuthenticated) return
                if (!auth.password && !(await isDeviceSessionActive())) return
                await get().login(auth.id, auth.password, isSilent, undefined, await deviceUnlockFromSession())
            },

            /**
             * Post-unlock pull: fetches latest cloud state unconditionally.
             * Unlike syncFromRemote(), this bypasses the isSyncing guard because
             * isSyncing protects write/push operations, not read pulls.
             * Sets isRefreshingFromCloud for UI feedback.
             */
            refreshFromCloud: async () => {
                const { auth, isSyncing } = get()
                if (!auth.isAuthenticated || !auth.id) return
                if (!auth.password && !getSessionSyncCredential(auth.id) && !(await isDeviceSessionActive())) return
                if (isSyncing) return

                const releaseSyncLock = await acquireSyncLock()

                set({ isRefreshingFromCloud: true })
                try {
                    // Only the pull may open the push gate after every required slice has applied.
                    await get().login(auth.id, auth.password, true, true, await deviceUnlockFromSession())
                } catch (e) {
                    // A superseded pull fails silently by design: another session owns
                    // the screen and already surfaced its own state.
                    if ((e as Error)?.name === 'SyncOwnershipLostError') return
                    if (import.meta.env.DEV) console.error('[Sync] Post-unlock cloud refresh failed:', e)
                    const message = e instanceof Error ? e.message : 'Unknown sync error'
                    if (message.toLowerCase().includes('decrypt') || message.toLowerCase().includes('password')) {
                        toast({
                            variant: 'destructive',
                            title: 'Sync Error',
                            description: message
                        })
                    } else {
                        toast({
                            variant: 'destructive',
                            title: 'Refresh Failed',
                            description: 'Could not reach sync server. Using local data.'
                        })
                    }
                } finally {
                    set({ isRefreshingFromCloud: false })
                    releaseSyncLock()
                }
            },

            register: async (password: string, name: string = '') => {
                if (password.length < 8) {
                    throw new Error('Password must be at least 8 characters.')
                }

                const newId = crypto.randomUUID()
                const { serverUrl } = get()

                try {
                    const apiPath = getSyncApiPath(serverUrl)
                    const { generateSalt } = await import('@/lib/crypto')
                    const salt = generateSalt()
                    const saltBase64 = btoa(String.fromCharCode(...salt))
                    const syncSalt = crypto.getRandomValues(new Uint8Array(16))
                    const syncSaltB64 = btoa(String.fromCharCode(...syncSalt))

                    const emptyState = {
                        accounts: [],
                        addons: { version: '1.0', savedAddons: [] },
                        profiles: [],
                        failover: [],
                        vault: [],
                        vaultTombstones: [],
                        notes: [],
                        notesTrash: [],
                        watchEvents: [],
                        watchSnapshot: {},
                        watchEventRollups: { byMonth: {}, daysByAccount: {}, foldedThrough: {} },
                        deletedWatchEvents: {},
                        salt: saltBase64,
                        syncedAt: new Date().toISOString()
                    }
                    const syncToken = await deriveSyncToken(password)

                    const registrationBody = JSON.stringify(emptyState)
                    const res = await resilientFetch(`${apiPath}/sync/${newId}`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'x-sync-password': syncToken
                        },
                        body: registrationBody,
                        timeout: syncUploadTimeoutMs(registrationBody.length),
                    })

                    if (!res.ok) throw new Error("Failed to register account on server.")
                    const registration = await res.json() as { syncedAt?: unknown; contentHash?: unknown }

                    // Parity Fix: Also initialize the local Master Password using the same password.
                    // If this fails, do not continue into an authenticated-but-unusable session.
                    try {
                        await useAuthStore.getState().setupMasterPassword(password, salt, { resetSyncStore: false })
                    } catch (setupError) {
                        try {
                            const cleanupRes = await resilientFetch(`${apiPath}/sync/${newId}`, {
                                method: 'DELETE',
                                headers: { 'x-sync-password': syncToken }
                            })
                            if (!cleanupRes.ok) throw new Error(`cleanup failed (${cleanupRes.status})`)
                        } catch (cleanupError) {
                            if (import.meta.env.DEV) console.error("Failed to clean up incomplete sync registration:", cleanupError)
                            throw new Error(`Local session setup failed after account reservation. Save this UUID before retrying: ${newId}`)
                        }
                        throw setupError
                    }

                    // A fresh workspace starts in a fresh namespace; the wipe
                    // above already cleared the signed-out one.
                    setActiveWorkspace(newId)
                    writeIdentityProfile(newId, name, null)
                    set({
                        auth: { id: newId, password, name, avatar: null, isAuthenticated: true },
                        lastSyncedAt: readServerSyncTimestamp(registration.syncedAt),
                        lastSyncedCloudEtag: typeof registration.contentHash === 'string' ? registration.contentHash : null,
                        pendingConflictAccountId: null,
                        isInitialSyncCompleted: true,
                        syncSaltB64,
                        needsReauth: false,
                    })

                    // Bug #52: persist the derived session credential so a page refresh
                    // keeps platform calls and pushes authenticated without the raw password.
                    try {
                        const { exportSyncKeyRaw } = await import('@/lib/crypto')
                        const syncKeyRaw = await exportSyncKeyRaw(password, syncSalt)
                        saveSessionSyncToken(newId, syncToken, btoa(String.fromCharCode(...syncKeyRaw)))
                    } catch { /* best-effort: this session still has the password in memory */ }

                    // Set flag to show post-login reminder (Since the registration dialog is hidden too fast)
                    localStorage.setItem('aiom_show_sync_id_reminder', 'true')
                    await get().syncToRemote(false)

                    toast({ title: "Account Created", description: "Welcome to AIOManager." })
                } catch (e) {
                    toast({ variant: "destructive", title: "Registration Failed", description: (e as Error).message })
                    throw e
                }
            },

            login: async function login(
                id: string,
                password: string,
                isSilent: boolean = false,
                bypassGuard: boolean = false,
                deviceUnlock?: { syncKey: CryptoKey },
                recovery?: { ownership: SyncOwnership; priorWorkspace: string },
            ) {
                if (recovery) recovery.ownership.assert()
                else if (get().isSyncing && !bypassGuard) return
                // Select the target persistence namespace before importing any state.
                const priorWorkspace = recovery?.priorWorkspace ?? getActiveWorkspaceId()
                setActiveWorkspace(id)
                // A newer pull or session transition invalidates this continuation.
                const pullToken = recovery?.ownership.seq ?? ++syncRuntime.pullSeq
                if (!recovery) syncRuntime.adoptedSeq = null

                const ownership = recovery?.ownership ?? captureSyncOwnership(pullToken)
                set({ isSyncing: true })
                const { serverUrl } = get()
                const apiPath = getSyncApiPath(serverUrl)
                const pullStart = Date.now()
                trace('sync', 'pull.start', { accountId: id, isSilent })

                try {
                    // A refreshed password session has no raw password but keeps its
                    // derived wire credential: the pull authenticates and decrypts with
                    // it instead of deriving garbage from the empty password.
                    const sessionPullCred = password ? null : getSessionSyncCredential(id)
                    const syncToken = password ? await deriveSyncToken(password) : (sessionPullCred?.token ?? await deriveSyncToken(password))
                    const pullHeaders: Record<string, string> = { 'x-sync-password': syncToken }
                    // Bug #52: keep the derived wire credential (+ sync key) in sessionStorage so
                    // the post-refresh session — which never sees the raw password again — stays
                    // authenticated on platform calls and pushes. Skipped when the stored entry
                    // already matches (token equality implies the same password and key).
                    const persistSessionCredential = async () => {
                        if (!password) return
                        if (getSessionSyncCredential(id)?.token === syncToken) return
                        try {
                            const { exportSyncKeyRaw } = await import('@/lib/crypto')
                            ownership.assert()
                            const saltB64 = get().syncSaltB64
                            const keySalt = saltB64 ? Uint8Array.from(atob(saltB64), c => c.charCodeAt(0)) : undefined
                            const syncKeyRaw = await exportSyncKeyRaw(password, keySalt)
                            ownership.assert()
                            saveSessionSyncToken(id, syncToken, btoa(String.fromCharCode(...syncKeyRaw)))
                        } catch { /* best-effort: this session still has the password in memory */ }
                    }
                    // Runs only on a certified pull: a full apply passes the blob's account ids, and a
                    // trusted 304 passes the ids recorded with the unchanged ETag.
                    const scheduleAccountServerCleanup = (blobAccountIds: string[] | null) => {
                        setTimeout(() => {
                            import('@/lib/account-server-cleanup').then(async m => {
                                if (!ownership.current()) return
                                const { auth } = get()
                                if (!auth.isAuthenticated) return
                                const accountsState = useAccountStore.getState()
                                if (!accountsState.hydrated || !Array.isArray(accountsState.accounts) || !accountsState.deletedAccounts) return
                                const syncToken = await getSyncPasswordHeader(auth)
                                const call: Parameters<typeof m.reconcileAccountServerCleanup>[0]['call'] = (path, init) => fetch(`${apiPath}${path}`, { ...init, headers: { 'x-sync-password': syncToken, 'x-sync-user': auth.id } })
                                await m.drainPendingAccountTombstoneLifts(call)
                                await m.reconcileAccountServerCleanup({
                                    call,
                                    presentIds: accountsState.accounts.map(a => a.id),
                                    blobAccountIds,
                                    deletedAccounts: accountsState.deletedAccounts,
                                    restoredAccounts: accountsState.restoredAccounts ?? {},
                                })
                                await m.drainPendingStremioCredentialCleanup({
                                    call,
                                    presentIds: accountsState.accounts.map(a => a.id),
                                    stremioAccountIds: accountsState.accounts.filter(a => getStremioConnections(a).length > 0 || !!getStremioAuthKey(a)).map(a => a.id),
                                })
                                await m.drainPendingConnectionServerCleanup({
                                    call,
                                    presentAccountIds: () => useAccountStore.getState().accounts.map(a => a.id),
                                    presentConnections: () => useAccountStore.getState().accounts.flatMap(a => (a.connections || []).map(c => `${a.id}:${c.id}`)),
                                })
                            }).catch(() => {})
                        }, 4000)
                    }
                    const storedEtag = get().lastSyncedCloudEtag
                    const sessionUnlocked = !!useAuthStore.getState().encryptionKey
                    // An evicted local store needs a full response despite an unchanged cloud ETag.
                    let localNotesEmpty = false
                    if (storedEtag && sessionUnlocked && (get().lastSyncedNotesCount ?? 0) > 0) {
                        try {
                            const { isLocalNotesStoreEmpty } = await import('@/store/notesStore')
                            localNotesEmpty = await isLocalNotesStoreEmpty()
                        } catch { localNotesEmpty = false }
                    }
                    const sendPullEtag = get().pendingConflictAccountId !== id && shouldSendPullEtag({
                        storedEtag,
                        sessionUnlocked,
                        lastSyncedNotesCount: get().lastSyncedNotesCount,
                        localNotesEmpty,
                        lastAppliedAccountCount: get().lastAppliedAccountCount,
                        localAccountCount: useAccountStore.getState().accounts.length,
                        lastAppliedAddonCount: get().lastAppliedAddonCount,
                        localAddonCount: Object.keys(useAddonStore.getState().library).length,
                    })
                    if (storedEtag && sessionUnlocked && !sendPullEtag) {
                        trace('sync', 'pull.force-full-empty-local', { accountId: id, isSilent })
                    }
                    if (sendPullEtag && storedEtag) pullHeaders['If-None-Match'] = storedEtag
                    // Avatar out-of-band blob: captured from the response at parse time,
                    // restored after the inner state applies (function-scope on purpose).
                    let avatarBlobWire: string | undefined
                    let watchBlobWire: string | undefined
                    // Seed and backfill only after this pull certifies its session.
                    let pendingFollowUpPush = false
                    const fireFollowUpPush = () => {
                        setTimeout(() => {
                            if (ownership.current() && get().auth.id === id && get().auth.isAuthenticated && get().isInitialSyncCompleted) {
                                get().syncToRemote(true).catch(() => {})
                            }
                        }, 1500)
                    }
                    const requestFollowUpPush = () => {
                        if (get().isInitialSyncCompleted) fireFollowUpPush()
                        else pendingFollowUpPush = true
                    }

                    const res = await resilientFetch(`${apiPath}/sync/${id}`, {
                        headers: pullHeaders,
                        timeout: SYNC_PULL_TIMEOUT_MS,
                    })

                    if (res.status === 304) {
                        // Discard superseded responses before changing session state.
                        if (!ownership.current()) return
                        const hydration = syncRuntime.hydration
                        // A newer same-account 304 may adopt pending pull hydration, but never mirror work.
                        const pendingAdopted = !!hydration
                            && hydration.status === 'pending'
                            && hydration.kind !== 'mirror'
                            && hydration.id === id
                            && pullToken > hydration.seq
                            && syncRuntime.pullSeq === pullToken
                        if (pendingAdopted) syncRuntime.adoptedSeq = hydration.seq
                        // Trust a 304 only after complete hydration, or when restoring a persisted applied ETag.
                        const unchangedTrusted = hydration
                            ? hydration.status === 'ok' && hydration.id === id
                            : !!storedEtag && sessionUnlocked
                        set({ lastSyncCheckedAt: new Date().toISOString(), ...(unchangedTrusted ? { isInitialSyncCompleted: true } : {}) })
                        // An unchanged cloud copy still carries deleted-account residue; its account ids are the ones recorded with this ETag.
                        // Registration or an account-less pull can move the ETag without new ids; those never match.
                        if (unchangedTrusted && storedEtag && get().lastSyncedAccountIdsEtag === storedEtag) scheduleAccountServerCleanup(get().lastSyncedAccountIds)
                        if (!unchangedTrusted && !pendingAdopted) {
                            get().addLogEntry({
                                type: 'pull',
                                status: 'error',
                                message: 'Cloud is unchanged, but the local copy is not verified complete; pushes stay paused. Pull again to re-apply.',
                                isAuto: isSilent
                            })
                            trace('sync', 'pull.not-modified-unverified', { accountId: id, isSilent })
                        }
                        await persistSessionCredential()
                        if (!useAccountStore.getState().hydrated) {
                            await useAccountStore.getState().initialize()
                        }
                        const { useWatchEventStore } = await import('@/store/watchEventStore')
                        if (!useWatchEventStore.getState().initialized) {
                            await useWatchEventStore.getState().load()
                        }
                        setTimeout(() => {
                            import('@/lib/activity-server').then(m => {
                                m.pushCredentialsToServer().catch(() => {})
                                m.fetchAndMergeServerEvents().catch(() => {})
                            }).catch(() => {})
                        }, 2000)
                        setTimeout(() => {
                            import('@/store/account/accountCanonical')
                                .then(({ reconcileInboundCanonical }) => {
                                    if (ownership.current()) return reconcileInboundCanonical(ownership)
                                })
                                .then(changed => { if (changed && ownership.current()) get().syncToRemote(true).catch(() => {}) })
                                .catch(() => {})
                        }, 2500)
                        get().addLogEntry({
                            type: 'pull',
                            status: 'success',
                            message: 'Cloud already up to date.',
                            isAuto: isSilent
                        })
                        trace('sync', 'pull.not_modified', { accountId: id, isSilent, timing: Date.now() - pullStart })
                        return
                    }

                    if (res.status === 401) {
                        let reason = ''
                        try {
                            const body = await res.json() as { reason?: unknown }
                            if (body && typeof body.reason === 'string') reason = body.reason
                        } catch {}
                        if (deviceUnlock && (reason === 'revoked' || reason === 'expired' || reason === 'generation')) {
                            throw Object.assign(new Error('Your remembered sign-in ended. Sign in again to continue.'), { reason })
                        }
                        if (deviceUnlock && reason === 'unknown') {
                            throw Object.assign(new Error('This device is no longer recognized. Sign in again to continue.'), { reason })
                        }
                        if (!password && sessionPullCred) {
                            throw new Error('Your saved sign-in ended. Sign in again to continue.')
                        }
                        throw new Error("Incorrect Password. If you've forgotten it, you may need to reset your account.")
                    }
                    if (res.status === 404) throw new Error("Cloud Account not found. Check the ID or Register a new one.")
                    if (!res.ok) throw new Error(`Cloud Sync Server error (${res.status}). Try again later.`)

                    const text = await res.text()
                    const responseEtag = res.headers.get('etag')
                    if (!text || text.trim() === "") {
                        throw new Error("Server returned an empty response. Your data might not be initialized yet.")
                    }

                    if (text.includes('[object Object]')) {
                        if (import.meta.env.DEV) console.warn("[Sync] Server returned '[object Object]'. Treating as corrupted/empty.")
                        throw new Error("Server returned corrupted data ([object Object]). Reset your account.")
                    }

                    // Close push trust and clear the old ETag before applying cloud state.
                    // Network failures above this point leave the prior local state certified.
                    set({ isInitialSyncCompleted: false, lastSyncedCloudEtag: null })
                    // This pull is about to apply cloud state: until its hydration
                    // settles, an unchanged (304) verdict cannot certify this session.
                    syncRuntime.hydration = { seq: pullToken, id, status: 'pending', kind: 'pull' }

                    let data: unknown
                    let responseSyncedAt: string | null = null
                    // The salt this response was sealed under, hoisted so the blob
                    // decode and salt adoption below share one value.
                    let remoteSyncSalt: Uint8Array | undefined
                    try {
                        const raw = JSON.parse(text) as Record<string, unknown>
                        responseSyncedAt = readServerSyncTimestamp(raw.syncedAt)
                        avatarBlobWire = typeof raw.avatarBlob === 'string' ? raw.avatarBlob : undefined
                        watchBlobWire = typeof raw.watchBlob === 'string' ? raw.watchBlob : undefined
                        if (raw.isEncrypted && raw.data) {
                            const { decryptSyncPayload } = await import('@/lib/crypto')
                            let decryptedStr: string
                            if (raw.syncSalt && typeof raw.syncSalt === 'string') {
                                remoteSyncSalt = Uint8Array.from(atob(raw.syncSalt), c => c.charCodeAt(0))
                                if (!get().syncSaltB64) set({ syncSaltB64: raw.syncSalt })
                            }
                            try {
                                if (deviceUnlock) {
                                    decryptedStr = await import('@/lib/crypto').then(m => m.decryptSyncPayloadWithKey(raw.data as string, deviceUnlock.syncKey))
                                } else if (sessionPullCred) {
                                    decryptedStr = await import('@/lib/crypto').then(async (m) => {
                                        const sessionSyncKey = await m.importSyncKey(Uint8Array.from(atob(sessionPullCred.syncKey), c => c.charCodeAt(0)))
                                        return m.decryptSyncPayloadWithKey(raw.data as string, sessionSyncKey)
                                    })
                                } else {
                                    decryptedStr = await decryptSyncPayload(raw.data as string, password, remoteSyncSalt)
                                    // The payload decoded under THIS salt: it is the account's
                                    // sync salt. Adopt it over a stale stored one so the session
                                    // key export and future derivations stay on the proven value.
                                    if (typeof raw.syncSalt === 'string' && raw.syncSalt !== get().syncSaltB64) set({ syncSaltB64: raw.syncSalt })
                                }
                            } catch {
                                throw new Error("Decryption failed. Wrong password or corrupted cloud data.")
                            }

                            let payloadStr: string
                            try {
                                payloadStr = raw.compressed ? await decompressSyncPayload(decryptedStr) : decryptedStr
                            } catch (decompressErr) {
                                if (import.meta.env.DEV) console.error('[Sync] Payload decompression failed — cloud copy is corrupt:', decompressErr)
                                const err = new Error('Cloud data is corrupted (stored payload cannot be decompressed). Sign in on a device that still has your data loaded and sync from there to repair the cloud copy.')
                                ;(err as Error & { corruptPayload?: boolean }).corruptPayload = true
                                throw err
                            }

                            try {
                                data = JSON.parse(payloadStr)

                                // Post-Parse Check: If it PARSED into a literal string "[object Object]", then it's bad.
                                // But if it's a valid object that happens to CONTAIN that string somewhere, we keep it.
                                if (data === '[object Object]') {
                                    if (import.meta.env.DEV) console.warn('[Sync] Decrypted data IS "[object Object]". Discarding.')
                                    data = {}
                                }
                            } catch (parseErr) {
                                if (import.meta.env.DEV) console.error('[Sync] Decrypted payload failed to parse — cloud copy is corrupt. Length:', decryptedStr.length)
                                const err = new Error('Cloud data is corrupted (stored payload is undecodable). Sign in on a device that still has your data loaded and sync from there to repair the cloud copy.')
                                ;(err as Error & { corruptPayload?: boolean }).corruptPayload = true
                                throw err
                            }
                        } else {
                            // Legacy: Plain text
                            data = raw
                        }
                        if (raw.syncedAt && data && typeof data === 'object' && !Array.isArray(data)) {
                            (data as Record<string, unknown>).syncedAt = raw.syncedAt
                        }

                        const d = (data || {}) as Record<string, unknown>
                        const dSettings = (d.settings || {}) as Record<string, unknown>
                        data = {
                            accounts: d.accounts,
                            deletedAccounts: d.deletedAccounts,
                            restoredAccounts: d.restoredAccounts,
                            addons: d.addons || { version: '1.0', savedAddons: [] },
                            profiles: Array.isArray(d.profiles) ? d.profiles : [],
                            failover: d.failover || [],
                            vault: Array.isArray(d.vault) ? d.vault : [],
                            vaultTombstones: Array.isArray(d.vaultTombstones) ? d.vaultTombstones : [],
                            notes: Array.isArray(d.notes) ? d.notes : [],
                            notesTrash: Array.isArray(d.notesTrash) ? d.notesTrash : [],
                            salt: d.salt,
                            name: d.name,
                            avatar: d.avatar,
                            syncedAt: d.syncedAt,
                            lastSeenVersion: d.lastSeenVersion || null,
                            settings: d.settings ? {
                                ...dSettings,
                                changelog: dSettings.changelog || []
                            } : { changelog: [] },
                            changelog: Array.isArray(d.changelog) ? d.changelog : [],
                            customThemes: Array.isArray(d.customThemes) ? d.customThemes : [],
                            watchEvents: Array.isArray(d.watchEvents) ? d.watchEvents : [],
                            watchSnapshot: d.watchSnapshot || {},
                            watchEventRollups: (d.watchEventRollups && typeof d.watchEventRollups === 'object') ? d.watchEventRollups : undefined,
                            deletedWatchEvents: (d.deletedWatchEvents && typeof d.deletedWatchEvents === 'object') ? d.deletedWatchEvents : {},
                            apiKeys: d.apiKeys,
                            accountStates: d.accountStates,
                            // The credential sidecar and the deduped manifest map must survive the
                            // login projection exactly as they survive a file import: dropping them
                            // here leaves portable secrets and sync-blob manifests unusable at login.
                            portableConnectionCredentials: (d.portableConnectionCredentials && typeof d.portableConnectionCredentials === 'object')
                                ? d.portableConnectionCredentials
                                : undefined,
                            manifests: (d.manifests && typeof d.manifests === 'object') ? d.manifests : undefined,
                            discoverFavorites: d.discoverFavorites,
                            discoverPrefs: d.discoverPrefs,
                        }

                    } catch (e) {
                        if (import.meta.env.DEV) console.error("[Sync] Decryption/Parsing Error:", e)
                        if ((e as Error & { corruptPayload?: boolean })?.corruptPayload) {
                            throw e
                        }
                        // If it's a JSON parse error (likely from getting HTML instead of JSON), show a better message
                        if (e instanceof SyntaxError) {
                            throw new Error("Invalid server response. Make sure the backend is running correctly.")
                        }
                        throw new Error("Failed to decrypt cloud data. Verify your password.")
                    }

                    // Identity restore must precede the vault unlock: an unlock failure can never skip it.
                    {
                        const pre = resolveCloudIdentity(data as Record<string, unknown>, id, get().auth)
                        if (pre.name !== get().auth.name || pre.avatar !== get().auth.avatar || readIdentityProfile().id !== id) {
                            writeIdentityProfile(id, pre.name, pre.avatar)
                            set({ auth: { ...get().auth, name: pre.name, avatar: pre.avatar } })
                        }
                    }

                    // This ensures we can still decrypt local account authKeys for reconciliation
                    // even if the cloud salt differs from the local salt.
                    let preUnlockEncryptionKey = useAuthStore.getState().encryptionKey

                    const cloudSalt = (data as Record<string, unknown>)?.salt as string | undefined
                    let localSaltBase64: string | undefined
                    {
                        const { loadSalt } = await import('@/lib/crypto')
                        const localSalt = loadSalt()
                        if (localSalt) localSaltBase64 = btoa(String.fromCharCode(...localSalt))
                    }
                    // When the salts match, the key unlockFromSync derives decrypts local authKeys
                    // too - deriving a second one here doubled every full login for nothing.
                    const saltsAligned = !!cloudSalt && !!localSaltBase64 && cloudSalt === localSaltBase64

                    // When salts differ, retain the existing local key for credential reconciliation.
                    if (!preUnlockEncryptionKey && !deviceUnlock && !saltsAligned) {
                        const { loadSalt, deriveKey } = await import('@/lib/crypto')
                        const localSalt = loadSalt()
                        if (localSalt) {
                            try {
                                preUnlockEncryptionKey = await deriveKey(password, localSalt)
                                if (import.meta.env.DEV) console.log('[Sync] Derived pre-unlock key from local salt for reconciliation')
                            } catch (e) {
                                if (import.meta.env.DEV) console.warn('[Sync] Could not derive pre-unlock key from local salt:', e)
                            }
                        }
                    }

                    const norm = data as Record<string, unknown>
                    const hasEncryptedData =
                        (Array.isArray(norm.accounts) && norm.accounts.length > 0) ||
                        (Array.isArray(norm.vault) && norm.vault.length > 0)
                    const saltPolicy = resolveRestoreSaltPolicy({ cloudSalt, localSalt: localSaltBase64, hasEncryptedData })

                    if (saltPolicy.refuse) {
                        if (bypassGuard) {
                            console.warn('[Sync] No encryption salt recoverable. Generating fresh salt for cloud recovery.')
                        } else {
                            throw new Error("Encryption metadata is missing from this account's cloud backup. Sign in once from the device or browser where you created it to finish setup.")
                        }
                    }

                    let unlockOk = false
                    if (deviceUnlock) {
                        // A remembered session must already have unlocked its vault.
                        unlockOk = !!useAuthStore.getState().encryptionKey
                        if (!unlockOk && !isSilent) {
                            throw new Error('Remembered sign-in could not unlock the vault. Sign in again.')
                        }
                    } else if (!password && useAuthStore.getState().encryptionKey) {
                        // Keep the unlocked vault key; deriving from an empty session password would replace it.
                        unlockOk = true
                    } else {
                        try {
                            const allowGen = saltPolicy.allowGenerate || (saltPolicy.refuse && bypassGuard)
                            await useAuthStore.getState().unlockFromSync(password, saltPolicy.saltToUse, { allowGenerate: allowGen })
                            unlockOk = true
                        } catch (e) {
                            if (import.meta.env.DEV) console.error("Failed to restore session from sync:", e)
                            if (!isSilent) {
                                throw new Error("Could not sign in with this password. (Encryption Mismatch)")
                            }
                            // Silent path: don't attempt data import without an encryption key
                        }
                    }

                    // Guard: skip all encrypted store operations if unlock failed
                    if (!unlockOk) {
                        // Restore the prior namespace when unlock fails.
                        if (getActiveWorkspaceId() === id) setActiveWorkspace(priorWorkspace)
                        if (import.meta.env.DEV) console.warn('[Sync] Skipping data import - encryption key not available.')
                        return
                    }

                    if (!preUnlockEncryptionKey && saltsAligned) {
                        preUnlockEncryptionKey = useAuthStore.getState().encryptionKey
                    }
                    const syncData = data as Record<string, unknown>
                    // Prime before any import runs: a mid-import failure must not leave the post-login push free to erase the cloud avatar.
                    syncRuntime.lastPulledCloudAvatar = (typeof syncData.avatar === 'string' && syncData.avatar) ? syncData.avatar : null
                    const localLastSync = get().lastSyncedAt
                    const remoteLastSync = responseSyncedAt ?? readServerSyncTimestamp(syncData.syncedAt)

                    const remoteTime = remoteLastSync ? new Date(remoteLastSync).getTime() : 0
                    const localTime = localLastSync ? new Date(localLastSync).getTime() : 0

                    const isLocalNewer = localTime > remoteTime
                    const isRemoteNewer = remoteTime > localTime
                    const isEqual = remoteTime === localTime

                    let decision = 'passive merge'
                    const postConflictPull = get().pendingConflictAccountId === id
                    let blobAccountIds: string[] | null = null

                    if (syncData.accounts !== undefined) {
                        const remoteAccounts = Array.isArray(syncData.accounts) ? syncData.accounts : (syncData.accounts as Record<string, unknown> | null)?.accounts
                        if (!Array.isArray(remoteAccounts)) throw new Error('Cloud accounts must be an array')
                        const mirror = shouldMirrorAccountPull({ isRemoteNewer, hasRemoteData: remoteAccounts.length > 0, postConflict: postConflictPull })
                        decision = mirror ? 'Adopt Remote (preserve unsynced accounts; apply explicit deletions)' : 'Merge (preserve unsaved changes; apply explicit deletions)'
                        await useAccountStore.getState().importAccounts(syncData, true, mirror ? 'mirror' : 'merge', preUnlockEncryptionKey, ownership, 'sync')
                        ownership.assert()
                        syncRuntime.lastSyncedAccountCount = remoteAccounts.length
                        blobAccountIds = remoteAccounts.map(a => a.id as string)
                        set({ lastSyncedAccountIds: blobAccountIds, lastSyncedAccountIdsEtag: responseEtag ?? null })
                        const localIds = new Set(useAccountStore.getState().accounts.map(a => a.id))
                        if (localIds.size !== remoteAccounts.length || remoteAccounts.some(a => !localIds.has(a.id as string))) requestFollowUpPush()
                    }

                    // Render after accounts load; keep pushes disabled until deferred slices finish.

                    // Fence every deferred import and publication against session replacement.
                    const pullCurrent = ownership.current
                    const fence = ownership.assert
                    // Decode deferred blobs with the same key context as the response.
                    const responseKey = deviceUnlock
                        ? { deviceSyncKey: deviceUnlock.syncKey }
                        : sessionPullCred
                            ? { sessionSyncKeyB64: sessionPullCred.syncKey }
                            : { password, salt: remoteSyncSalt }
                    // Open push trust only after both auth installation and hydration succeed.
                    let authInstalled = false
                    let hydrationOk = false
                    let pullCompleted = false
                    // Avatar decode failure keeps push trust closed.
                    let avatarIncomplete: string | null = null
                    const setHydration = (status: 'ok' | 'failed') => {
                        // A newer pull owns the record slot by then; never overwrite it.
                        if (syncRuntime.hydration?.seq === pullToken) syncRuntime.hydration = { seq: pullToken, id, status, kind: 'pull' }
                    }
                    // Purge server-side residue (rules, credentials, canonical rows) of accounts this
                    // certified pull proves are gone. Runs from completePull, so only after hydration
                    // and the avatar check succeeded.
                    const completePull = () => {
                        if (pullCompleted || !authInstalled || !hydrationOk || avatarIncomplete
                            || !pullCurrent() || get().auth.id !== id || !get().auth.isAuthenticated) return
                        pullCompleted = true
                        scheduleAccountServerCleanup(blobAccountIds)
                        // Publish the ETag only after every response slice has applied.
                        set({
                            isInitialSyncCompleted: true,
                            lastSyncedCloudEtag: responseEtag ?? null,
                            lastAppliedAccountCount: useAccountStore.getState().accounts.length,
                            lastAppliedAddonCount: Object.keys(useAddonStore.getState().library).length,
                        })
                        if (postConflictPull) {
                            // Keep recovery durable until the merged work is confirmed
                            // pushed, including reloads between hydration and republish.
                            pendingFollowUpPush = true
                        }
                        // A deferred follow-up push fires only now that the session is certified.
                        if (pendingFollowUpPush) {
                            pendingFollowUpPush = false
                            fireFollowUpPush()
                        }
                        if (!isSilent) toast({ title: "Login Successful", description: "Data loaded." })
                    }

                    const applySecondarySlices = async () => {
                    fence()
                    // Prefer the deferred watch blob; legacy responses keep history in the inner state.
                    let secondary = syncData
                    // If the watch blob fails, preserve previously pulled deletion markers.
                    let watchBlobBroken = false
                    // An unreadable expected blob leaves this pull incomplete for writes.
                    let pullIncomplete: string | null = null
                    if (watchBlobWire) {
                        const decoded = await decodeSyncBlob(watchBlobWire, responseKey)
                        if (decoded === null) {
                            watchBlobBroken = true
                            pullIncomplete = 'Cloud watch history could not be decoded (wrong key or corrupt blob); this pull is incomplete.'
                            if (import.meta.env.DEV) console.warn('[Sync] Watch blob restore failed; falling back to inner state.')
                        } else {
                            try {
                                const parsed = JSON.parse(decoded) as unknown
                                // Wrong-shaped watch data is an incomplete cloud slice.
                                if (!isValidWatchPayload(parsed)) {
                                    watchBlobBroken = true
                                    pullIncomplete = 'Cloud watch history decoded but was not the expected structure; this pull is incomplete.'
                                    if (import.meta.env.DEV) console.warn('[Sync] Watch blob content was not the expected structure; falling back to inner state.')
                                } else {
                                    secondary = { ...syncData, ...parsed }
                                }
                            } catch (e) {
                                watchBlobBroken = true
                                pullIncomplete = 'Cloud watch history decoded but was not valid JSON; this pull is incomplete.'
                                if (import.meta.env.DEV) console.warn('[Sync] Watch blob content was not valid JSON; falling back to inner state.', e)
                            }
                        }
                    }
                    fence()
                    if (secondary.addons) {
                        const localAddons = Object.keys(useAddonStore.getState().library).length
                        const remoteAddons = Array.isArray(secondary.addons) ? secondary.addons : ((secondary.addons as Record<string, unknown>)?.savedAddons || []) as unknown[]

                        if ((!remoteAddons || remoteAddons.length === 0) && localAddons > 0) {
                            if (import.meta.env.DEV) console.warn(`[Sync] Remote has 0 addons (Safety net triggered). Switching to MERGE + PUSH.`)
                            await useAddonStore.getState().importLibrary(syncData, true, false, true, ownership)
                            requestFollowUpPush()
                        } else if (isLocalNewer) {
                            if (import.meta.env.DEV) console.log("[Sync] Local addons are fresher. Merging & Pushing.")
                            await useAddonStore.getState().importLibrary(syncData, true, false, true, ownership)
                            requestFollowUpPush()
                        } else if (isEqual) {
                            if (import.meta.env.DEV) console.log("[Sync] Addons synchronized. Passive import.")
                            await useAddonStore.getState().importLibrary(syncData, true, true, true, ownership)
                        } else {
                            await useAddonStore.getState().importLibrary(syncData, postConflictPull, true, true, ownership)
                        }
                        await useAddonStore.getState().initialize(ownership)
                    }
                    fence()
                    if (secondary.profiles && Array.isArray(secondary.profiles)) {
                        await useProfileStore.getState().importProfiles(secondary.profiles, ownership)
                    }
                    if (secondary.failover) {
                        const fo = secondary.failover as Record<string, unknown>
                        if (Array.isArray(secondary.failover)) {
                            await useFailoverStore.getState().importRules(secondary.failover, 'merge', true, ownership)
                        } else if (typeof secondary.failover === 'object') {
                            if (fo.rules) await useFailoverStore.getState().importRules(fo.rules, 'merge', true, ownership)
                            if (fo.webhook) {
                                await useFailoverStore.getState().importWebhook(fo.webhook as import('./failoverStore').WebhookConfig, true, ownership)
                            }
                        }
                    }
                    fence()

                    if (secondary.notes && Array.isArray(secondary.notes)) {
                        const { useNotesStore } = await import('@/store/notesStore')
                        await useNotesStore.getState().importNotes(secondary.notes, ownership)
                        syncRuntime.lastPulledNotes = secondary.notes as import('./notesStore').Note[]
                        set({ lastSyncedNotesCount: secondary.notes.length })
                        if (Array.isArray(secondary.notesTrash)) {
                            syncRuntime.lastPulledNotesTrash = secondary.notesTrash
                            await useNotesStore.getState().importTrash(secondary.notesTrash, ownership)
                        }
                    } else if (Array.isArray(secondary.notesTrash)) {
                        syncRuntime.lastPulledNotesTrash = secondary.notesTrash
                        const { useNotesStore } = await import('@/store/notesStore')
                        await useNotesStore.getState().importTrash(secondary.notesTrash, ownership)
                    }
                    fence()
                    if (Array.isArray(secondary.vault) || Array.isArray(secondary.vaultTombstones)) {
                        const { useVaultStore } = await import('./vaultStore')
                        await useVaultStore.getState().initialize(ownership)
                        // Initialization may return after losing ownership; fence before publishing markers.
                        fence()
                        syncRuntime.lastPulledVaultTombstones = (secondary.vaultTombstones || []) as import('./vaultStore').VaultTombstone[]
                        await useVaultStore.getState().importVault((secondary.vault || []) as import('@/types/vault').VaultKey[], (secondary.vaultTombstones || []) as import('./vaultStore').VaultTombstone[], ownership)
                    }
                    fence()

                    if (secondary.settings) {
                        // Protect unsynced local edits: lastSyncedAt cannot see a setting changed
                        // after a failed push, so "remote newer" must not adopt the cloud value over it.
                        applySyncedSettings(secondary.settings as Record<string, unknown>, !isLocalNewer, { protectLocalEdits: true })
                    }

                    fence()
                    {
                        const { useWatchEventStore } = await import('@/store/watchEventStore')
                        fence()
                        const local = useWatchEventStore.getState()
                        const remoteEvents: Record<string, unknown>[] = Array.isArray(secondary.watchEvents) ? secondary.watchEvents as Record<string, unknown>[] : []
                        const remoteDeleted = (secondary.deletedWatchEvents && typeof secondary.deletedWatchEvents === 'object') ? secondary.deletedWatchEvents as Record<string, number> : {}
                        // Preserve cloud deletion markers when the deferred watch blob is unreadable.
                        if (!watchBlobBroken) syncRuntime.lastPulledDeletedWatchEvents = remoteDeleted
                        const mergedDeleted = mergeDeletedEventMaps(local.deletedEventKeys, remoteDeleted)
                        const merged = new Map<string, Record<string, unknown>>()
                        ;[...remoteEvents, ...local.events as unknown as Record<string, unknown>[]].forEach(e => merged.set(e.id as string, e))
                        const mergedEvents = Array.from(merged.values())
                            .sort((a, b) => (b.event_ts as number) - (a.event_ts as number))
                        const mergedSnapshot = { ...(secondary.watchSnapshot || {} as Record<string, unknown>), ...local.snapshot }
                        const remoteRollups = (secondary.watchEventRollups && typeof secondary.watchEventRollups === 'object')
                            ? secondary.watchEventRollups as import('@/lib/watch-event-rollups').EventRollups
                            : undefined
                        useWatchEventStore.getState().initialize(mergedEvents as unknown as import('@/types/activity').WatchEvent[], mergedSnapshot as Record<string, Record<string, import('@/types/activity').SnapshotItem>>, mergedDeleted, remoteRollups)
                    }

                    fence()
                    if (Array.isArray(secondary.customThemes) && secondary.customThemes.length > 0) {
                        applySyncedSettings({ customThemes: secondary.customThemes }, true, { protectLocalEdits: true })
                    }

                    if (Array.isArray(secondary.discoverFavorites)) {
                        try { localStorage.setItem('aio-discover-favorites', JSON.stringify(secondary.discoverFavorites)) } catch {}
                    }

                    if (secondary.discoverPrefs && typeof secondary.discoverPrefs === 'object') {
                        try { localStorage.setItem('aio-discover-prefs', JSON.stringify(secondary.discoverPrefs)) } catch {}
                    }

                    // Unreadable expected blobs keep the pull incomplete and pushes disabled.
                    if (pullIncomplete) throw new Error(pullIncomplete)
                    } // end applySecondarySlices
                    // Deferred hydration controls push trust; a partial restore must never overwrite cloud state.
                    applySecondarySlices()
                        .then(() => {

                            if (avatarIncomplete) return
                            setHydration('ok')
                            hydrationOk = true
                            // Either completion order is valid: auth installation also
                            // calls this gate after the avatar has been decoded.
                            completePull()
                        })
                        .catch(err => {
                            setHydration('failed')
                            trace('sync', 'pull.hydration-failed', { accountId: id, isSilent, error: (err as Error).message })
                            // Superseded work logs nothing into the session that replaced it.
                            if (!pullCurrent()) return
                            console.warn('[Sync] deferred hydration failed:', err)
                            get().addLogEntry({ type: 'pull', status: 'error', message: `Deferred hydration failed: ${(err as Error).message}`, isAuto: isSilent })
                            // The eager path can no longer announce "Data loaded": the user
                            // needs to know the load is partial and syncing is paused. The
                            // push gate below stays closed until a pull fully succeeds.
                            if (!isSilent) {
                                toast({ variant: "destructive", title: "Data Load Incomplete", description: "Some cloud data failed to load and syncing is paused. Your cloud copy is safe — sign in again or press Sync to retry.", href: "/settings" })
                            }
                        })

                    // Identity is upgrade-only on pull: an empty name/avatar in the cloud
                    // (a stale push from another device) can never erase what this device has.
                    const identity = resolveCloudIdentity(syncData, id, get().auth)
                    const restoredName = identity.name
                    // Legacy responses retain upgrade-only avatar handling.
                    let restoredAvatar = identity.avatar
                    {
                        const avatarBlob = avatarBlobWire
                        if (typeof avatarBlob === 'string' && avatarBlob) {
                            const decoded = await decodeSyncBlob(avatarBlob, responseKey)
                            if (decoded !== null) {
                                try {
                                    const parsed = JSON.parse(decoded) as unknown
                                    // An invalid avatar payload leaves the pull incomplete.
                                    if (isValidAvatarPayload(parsed)) restoredAvatar = parsed
                                    else {
                                        avatarIncomplete = 'Cloud avatar blob decoded but was not the expected JSON; this pull is incomplete.'
                                        if (import.meta.env.DEV) console.warn('[Sync] Avatar blob content was not the expected JSON string; keeping local avatar for display.')
                                    }
                                } catch (e) {
                                    avatarIncomplete = 'Cloud avatar blob decoded but was not the expected JSON; this pull is incomplete.'
                                    if (import.meta.env.DEV) console.warn('[Sync] Avatar blob content was not valid JSON; keeping local avatar for display.', e)
                                }
                            } else {
                                avatarIncomplete = 'Cloud avatar could not be decoded (wrong key or corrupt blob); this pull is incomplete.'
                                if (import.meta.env.DEV) console.warn('[Sync] Avatar blob restore failed; keeping local avatar for display.')
                            }
                        }
                    }
                    if (avatarIncomplete) {
                        // Downgrade hydration on avatar failure, even if other slices already finished.
                        if (syncRuntime.hydration?.seq === pullToken) syncRuntime.hydration = { seq: pullToken, id, status: 'failed', kind: 'pull' }
                        if (pullCurrent()) {
                            console.warn('[Sync]', avatarIncomplete)
                            get().addLogEntry({ type: 'pull', status: 'error', message: `Deferred hydration failed: ${avatarIncomplete}`, isAuto: isSilent })
                            // Same contract as a deferred slice failure: warn instead of
                            // letting the earlier login flow imply the load completed.
                            if (!isSilent) {
                                toast({ variant: "destructive", title: "Data Load Incomplete", description: "Your avatar could not be loaded from the cloud and syncing is paused. Your cloud copy is safe — sign in again or press Sync to retry.", href: "/settings" })
                            }
                        }
                    }
                    // Do not reinstall identity after a logout or superseding session.
                    if (!pullCurrent()) return
                    writeIdentityProfile(id, restoredName, restoredAvatar)
                    set({
                        auth: {
                            id,
                            password,
                            name: restoredName,
                            avatar: restoredAvatar,
                            isAuthenticated: true
                        },
                        lastSyncedAt: responseSyncedAt ?? get().lastSyncedAt,
                        lastSyncCheckedAt: new Date().toISOString(),
                        lastSeenVersion: (syncData.lastSeenVersion as string | null) || get().lastSeenVersion,
                        // Push trust requires completed hydration and a readable avatar blob.
                        isInitialSyncCompleted: hydrationOk && !avatarIncomplete,
                        needsReauth: false
                    })
                    authInstalled = true
                    if (hydrationOk && !avatarIncomplete) completePull()
                    // After the set: syncSaltB64 may have just been adopted from the cloud,
                    // and the sync key must be exported under that same salt.
                    await persistSessionCredential()

                    // Heal a salt-less cloud record only with a definitively-correct salt (a freshly
                    // minted one for an empty account). A device-local fallback for a record that has
                    // data is left for a normal sync to push, so a foreign salt can't corrupt the record.
                    if (saltPolicy.backfill) {
                        requestFollowUpPush()
                    }

                    get().addLogEntry({
                        type: 'pull',
                        status: 'success',
                        message: `Fetched cloud state. Decision: ${decision}`,
                        isAuto: isSilent
                    })
                    trace('sync', 'pull.success', { accountId: id, isSilent, decision, timing: Date.now() - pullStart })

                    // The success toast is deferred: it fires from the hydration
                    // completion path above, only after every required slice has
                    // applied, so a partial restore can never read as "Data loaded.".

                    setTimeout(() => {
                        import('@/lib/activity-server').then(async m => {
                            try { await m.pushCredentialsToServer() } catch (e) {
                                const msg = (e as Error).message
                                get().addLogEntry({ type: 'push', status: 'error', message: `Credential push failed: ${msg}`, isAuto: true })
                                console.warn('[Sync] Credential push failed:', e)
                            }
                            m.fetchAndMergeServerEvents().catch(e => {
                                const msg = (e as Error).message
                                get().addLogEntry({ type: 'pull', status: 'error', message: `Server event fetch failed: ${msg}`, isAuto: true })
                                console.warn('[Sync] Server event fetch failed:', e)
                            })
                        }).catch(e => {
                            const msg = (e as Error).message
                            get().addLogEntry({ type: 'push', status: 'error', message: `Activity server import failed: ${msg}`, isAuto: true })
                            console.warn('[Sync] Activity server import failed:', e)
                        })
                    }, 2000)

                    // App-open: fold in any inbound canonical writes (AIOStreams) that landed
                    // while this client was away, then push if a Hub actually changed. Without
                    // a local change to trigger a push, this is what reflects inbound writes.
                    setTimeout(() => {
                        import('@/store/account/accountCanonical')
                            .then(({ reconcileInboundCanonical }) => {
                                if (ownership.current()) return reconcileInboundCanonical(ownership)
                            })
                            .then(changed => { if (changed && ownership.current()) get().syncToRemote(true) })
                            .catch(() => {})
                    }, 2500)

                } catch (e) {
                    // Superseded failures must not retry, roll back, or notify the replacement session.
                    if (!ownership.current()) throw e
                    if ((e as Error & { corruptPayload?: boolean })?.corruptPayload && !syncRuntime.corruptRestoreInFlight) {
                        try {
                            const restoreRes = await resilientFetch(`${apiPath}/sync/${id}/restore`, {
                                method: 'POST',
                                headers: { 'x-sync-password': password ? await deriveSyncToken(password) : await getSyncPasswordHeader({ id, password }) },
                                timeout: 15000,
                            })
                            ownership.assert()
                            if (restoreRes.ok) {
                                trace('sync', 'pull.corrupt-restored', { accountId: id })
                                // Recovery continues this login attempt under the same ownership.
                                syncRuntime.corruptRestoreInFlight = true
                                try {
                                    return await login(id, password, isSilent, bypassGuard, deviceUnlock, { ownership, priorWorkspace })
                                } finally {
                                    syncRuntime.corruptRestoreInFlight = false
                                }
                            }
                        } catch (restoreErr) {
                            if (!ownership.current()) throw restoreErr
                            if (import.meta.env.DEV) console.warn('[Sync] Cloud restore attempt failed:', restoreErr)
                        }
                    }
                    // Restore the prior namespace unless recovery already selected another one.
                    if (getActiveWorkspaceId() === id) setActiveWorkspace(priorWorkspace)
                    const msg = (e as Error).message
                        ; get().addLogEntry({
                            type: 'pull',
                            status: 'error',
                            message: `Pull Failed: ${msg}`,
                            isAuto: isSilent
                        })
                    trace('sync', 'pull.error', { accountId: id, isSilent, error: msg, timing: Date.now() - pullStart })
                    if (!isSilent) {
                        toast({ variant: "destructive", title: "Login Failed", description: msg })
                    }
                    throw e
                } finally {
                    // A failed login may restore its prior workspace before releasing the flag.
                    const rolledBack = syncRuntime.pullSeq === pullToken && getActiveWorkspaceId() === priorWorkspace
                    if (ownership.current() || rolledBack) set({ isSyncing: false })
                }
            },

            logout: async () => {
                if (get().auth.isAuthenticated && get().isInitialSyncCompleted) {
                    // An in-flight push IS pushing the latest state; wiping while it runs
                    // races the serializer against the store reset. Wait it out first.
                    const syncDeadline = Date.now() + 20000
                    while (get().isSyncing && Date.now() < syncDeadline) {
                        await new Promise(r => setTimeout(r, 200))
                    }
                    let pushOk: boolean | undefined
                    try {
                        pushOk = await Promise.race([
                            get().syncToRemote(false, false),
                            new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 20000))
                        ])
                    } catch {}
                    if (pushOk === false || pushOk === undefined) {
                        toast({
                            variant: 'destructive',
                            title: 'Sign-out cancelled',
                            description: 'Your latest data could not be confirmed pushed to the cloud (a sync may still be running), and signing out erases the local copy. Retry in a moment, or export a backup from Settings → Data & Sync first.'
                        })
                        get().addLogEntry({
                            type: 'push',
                            status: 'error',
                            message: 'Sign-out aborted: pre-logout push did not complete (local data preserved).',
                            isAuto: false
                        })
                        return
                    }
                }

                syncRuntime.lastPushedHash = null
                syncRuntime.lastPulledNotes = null
                syncRuntime.pendingRetry = false
                syncRuntime.serverCanonicalAddonsV2 = null
                resetAccountsHydration()
                // Invalidate in-flight work before resetting session state.
                syncRuntime.pullSeq++
                syncRuntime.adoptedSeq = null
                syncRuntime.hydration = null
                set({ pendingConflictAccountId: null })
                if (syncRuntime.syncDebounceTimer) { clearTimeout(syncRuntime.syncDebounceTimer); syncRuntime.syncDebounceTimer = null }
                syncRuntime.syncDebounceFirstAt = null
                if (syncRuntime.onlineHandler) { window.removeEventListener('online', syncRuntime.onlineHandler); syncRuntime.onlineHandler = null }
                if (syncRuntime.syncBC) { syncRuntime.syncBC.close(); syncRuntime.syncBC = null }
                clearSyncCredentialCaches()
                import('@/lib/device-session').then(({ deactivateDeviceAuth }) => deactivateDeviceAuth()).catch(() => {})
                import('@/lib/canonical-base').then(({ clearCanonicalBases }) => clearCanonicalBases()).catch(() => {})
                import('@/lib/pmdb-list-publisher').then(({ _invalidateAuthCache }) => _invalidateAuthCache()).catch(() => {})
                import('@/api/hydra-providers').then(({ _clearCanonicalCache }) => _clearCanonicalCache()).catch(() => {})
                import('@/lib/realstream-token-cache').then(({ clearRealStreamTokens }) => clearRealStreamTokens()).catch(() => {})
                set({
                    // Profile (name + avatar) survives sign-out on purpose: the login screen's
                    // Continue strip and avatar are driven from it, like every keep-me-signed-in app.
                    auth: { id: '', password: '', name: get().auth.name, avatar: get().auth.avatar, isAuthenticated: false },
                    lastSyncedAt: null,
                    lastSyncCheckedAt: null,
                    isSyncing: false,
                    isInitialSyncCompleted: false,
                    lastSyncedCloudEtag: null,
                    lastSyncedNotesCount: null,
                    lastAppliedAccountCount: null,
                    lastSyncedAccountIds: null,
                    lastSyncedAccountIdsEtag: null,
                    lastAppliedAddonCount: null,
                    serverStremioCredentialedAccounts: null,
                    needsReauth: false
                })
                syncRuntime.lastSyncedAccountCount = null
                clearRepublishState()

                const { useWatchEventStore } = await import('@/store/watchEventStore')
                await useWatchEventStore.getState().reset()
                await wipeAllData()
                await resetAllStores({ includeSync: false })
                // Reset note metadata alongside disk state so future imports can restore it.
                await import('@/store/notesStore').then(({ useNotesStore }) => useNotesStore.getState().resetLocal())

                setActiveWorkspace(ANON_WORKSPACE_ID)

                toast({ title: "Logged Out", description: "See you next time." })
            },

            syncToRemote: async (isAuto: boolean = false, isDebounced: boolean = false, forceFull: boolean = false, forcePush: boolean = false): Promise<boolean> => {
                const ownership = captureSyncOwnership()
                if (!useAccountStore.getState().hydrated) {
                    await useAccountStore.getState().initialize()
                }
                if (!ownership.current()) return false
                const { auth, serverUrl, isSyncing, isInitialSyncCompleted } = get()
                const pushCurrent = () => ownership.current() && get().auth.isAuthenticated && get().auth.id === auth.id
                const { isLocked } = useAuthStore.getState()
                // Bug #52: a password-session that refreshed keeps its derived session credential,
                // so pushes resume instead of silently skipping ("no in-session credentials").
                const sessionCred = auth.isAuthenticated ? getSessionSyncCredential(auth.id) : null
                const hasSessionCredentials = !!auth.password || !!sessionCred || (await isDeviceSessionActive())
                if (!ownership.current()) return false
                if (!auth.isAuthenticated || isSyncing || isLocked || !useAccountStore.getState().hydrated || !hasSessionCredentials || !isInitialSyncCompleted) {
                    const reason = !auth.isAuthenticated ? 'not signed in' : isSyncing ? 'a sync is in progress' : isLocked ? 'vault is locked' : !hasSessionCredentials ? 'no in-session credentials' : !isInitialSyncCompleted ? 'initial pull still applying' : 'account state not hydrated'
                    // Credentialless-but-otherwise-operational is the corpse state of the refresh
                    // bug: skipping silently kept it invisible. Raise the re-auth state so the
                    // dashboard banners the stopped sync (live bug #51, part 2).
                    if (!hasSessionCredentials && auth.isAuthenticated && !isLocked && useAccountStore.getState().hydrated && !get().needsReauth) {
                        set({ needsReauth: true })
                        trace('sync', 'push.reauth-required', { accountId: auth.id, isAuto })
                    }
                    if (!isAuto) {
                        get().addLogEntry({ type: 'push', status: 'error', message: `Push skipped: ${reason}.`, isAuto: false })
                        trace('sync', 'push.guard-reject', { accountId: auth.id, reason })
                    }
                    return false
                }

                if (!useAccountStore.getState().hydrated) {
                    if (import.meta.env.DEV) console.log("[Sync] Skipping push: account store not hydrated yet")
                    return false
                }

                const { useWatchEventStore } = await import('@/store/watchEventStore')
                if (!pushCurrent()) return false
                if (!useWatchEventStore.getState().initialized) {
                    await useWatchEventStore.getState().load()
                    if (!pushCurrent()) return false
                    if (!useWatchEventStore.getState().initialized) {
                        if (isAuto) {
                            if (import.meta.env.DEV) console.log("[Sync] Skipping auto-push: Waiting for watch history hydration")
                            return false
                        }
                        await get().refreshFromCloud()
                        if (!pushCurrent()) return false
                        if (!useWatchEventStore.getState().initialized) {
                            if (!isAuto) get().addLogEntry({ type: 'push', status: 'error', message: 'Push skipped: watch history could not be loaded.', isAuto: false })
                            trace('sync', 'push.guard-reject', { accountId: auth.id, reason: 'watch-store-unhydrated' })
                            return false
                        }
                    }
                }

                // SAFETY LOCK: If we haven't successfully synced FROM the cloud yet,
                // we are NOT allowed to sync TO the cloud. This prevents stale clients
                // from overwriting the source of truth with their old local state.
                if (isAuto && (!isAccountsHydrationComplete() || !isInitialSyncCompleted)) {
                    if (import.meta.env.DEV) console.log("[Sync] Skipping auto-push: Waiting for hydration and initial pull")
                    return false
                }

                // Server Protection: Strict Debounce check for auto-syncs
                // Instead of dropping, we defer the sync so the *last* change always pushes.
                // The window scales with the last measured envelope (SYNC-PERF #3) and the
                // max-wait cap inside armSyncPushDebounce bounds the hold; explicit syncs
                // (isAuto=false) push immediately, unchanged.
                if (isAuto) {
                    armSyncPushDebounce(syncRuntime, () => { get().syncToRemote(false, true) })
                    return false
                }

                set({ isSyncing: true })

                set({ lastActionTimestamp: Date.now() })

                // Fold inbound canonical-store writes (e.g. AIOStreams) into non-Stremio
                // Hubs before we build the push body, so the blob + canonical both reflect
                // the three-way merge. The client is the single merger (D2). isSyncing is
                // already true here, so this cannot re-enter syncToRemote; best-effort, so
                // a failure never blocks the push.
                try {
                    const { reconcileInboundCanonical } = await import('@/store/account/accountCanonical')
                    if (!pushCurrent()) return false
                    await reconcileInboundCanonical(ownership)
                } catch (e) { if (import.meta.env.DEV) console.error('[Sync] Inbound canonical reconcile failed:', e) }
                if (!pushCurrent()) return false

                const releaseSyncLock = await acquireSyncLock()
                if (!pushCurrent()) {
                    releaseSyncLock()
                    return false
                }

                const apiPath = getSyncApiPath(serverUrl)
                const pushStart = Date.now()
                let forceCanonicalRepublish = false

                try {
                    trace('sync', 'push.start', { accountId: auth.id, isAuto })
                    const { loadSalt } = await import('@/lib/crypto')
                    ownership.assert()
                    const salt = loadSalt()
                    const saltBase64 = salt ? btoa(String.fromCharCode(...salt)) : undefined

                    const { exportAccountsForSyncWithLocked } = await import('@/store/account/accountImportExport')
                    const { data: exportedAccounts, lockedAccounts } = await exportAccountsForSyncWithLocked()
                    ownership.assert()
                    const rawAddons = useAddonStore.getState().exportLibrary(true)
                    const addonCount = Object.keys(useAddonStore.getState().library).length

                    const safeParse = (val: unknown): Record<string, unknown> => {
                        if (!val) return {}
                        if (typeof val === 'object') return val as Record<string, unknown>
                        if (typeof val === 'string') {
                            if ((val as string).includes('[object Object]')) {
                                if (import.meta.env.DEV) console.warn(`[Sync] Discarding corrupted data checking for [object Object]`)
                                return {}
                            }
                            try {
                                return JSON.parse(val as string) as Record<string, unknown>
                            } catch (e) {
                                if (import.meta.env.DEV) console.error(`[Sync] Failed to parse exported data:`, val.substring(0, 50))
                                return {}
                            }
                        }
                        return {}
                    }

                    const accountCount = Array.isArray(exportedAccounts.accounts) ? exportedAccounts.accounts.length : 0
                    const { shouldBlockEmptyAccountPush } = await import('@/lib/sync-guards')
                    ownership.assert()
                    if (shouldBlockEmptyAccountPush({
                        currentAccountCount: accountCount,
                        lastSyncedAccountCount: syncRuntime.lastSyncedAccountCount ?? get().lastSyncedAccountIds?.length ?? get().lastAppliedAccountCount,
                        lastSyncedAccountIds: get().lastSyncedAccountIds,
                        deletedAccountIds: Object.keys(useAccountStore.getState().deletedAccounts),
                        isManualPush: !isAuto && !isDebounced,
                    })) {
                        trace('sync', 'push.blocked-empty-accounts', { accountId: auth.id, lastSyncedAccountCount: syncRuntime.lastSyncedAccountCount })
                        console.warn('[Sync] Blocked automatic push of 0 accounts (data-loss guard, issue #34). If you intentionally deleted all accounts, use a manual sync to force it.')
                        throw new Error('Blocked push of 0 accounts: local state contradicts the last synced cloud copy. Restore accounts or trigger a manual sync to force-push.')
                    }
                    if (useVaultStore.getState().isLocked && useAuthStore.getState().encryptionKey) {
                        await useVaultStore.getState().initialize()
                    }
                    ownership.assert()
                    // Merge local tombstones with the last-pulled cloud sets so a stale push
                    // can never wipe another device's deletion and resurrect data
                    const vaultState = useVaultStore.getState()
                    const { mergeTombstones } = await import('./vaultStore')
                    ownership.assert()
                    const mergedVaultTombstones = mergeTombstones(vaultState.tombstones, syncRuntime.lastPulledVaultTombstones ?? [])
                    const vaultTombById = new Map(mergedVaultTombstones.map(t => [t.id, t.deletedAt]))
                    const notesState = (await import('@/store/notesStore')).useNotesStore.getState()
                    ownership.assert()
                    const localNotes = await notesState.getAllNotesWithContent()
                    ownership.assert()
                    const notesBaseline = syncRuntime.lastPulledNotes
                    const notesTrashBaseline = syncRuntime.lastPulledNotesTrash
                    const mergedNotesTrash = mergeNotesTrash(notesState.trash, notesTrashBaseline ?? [])
                    const identityFallback = readIdentityProfile()
                    const identityAvatarFallback = identityFallback.id === auth.id ? identityFallback.avatar : null

                    const watchExport = useWatchEventStore.getState().export()
                    const rawAvatarValue = auth.avatar ?? identityAvatarFallback ?? syncRuntime.lastPulledCloudAvatar ?? null
                    // Hard ceiling: an oversized avatar data URI must not ride (or block) the push.
                    const avatarExport = exportAvatarValue(rawAvatarValue)
                    if (avatarExport.dropped) trace('sync', 'push.avatar-ceiling', { accountId: auth.id })
                    const avatarValue = avatarExport.value
                    // Cloud-guard fallback: an empty local store with a known non-empty cloud
                    // set pushes the cloud set, so a wiped device can't erase the cloud notes.
                    const notesToPush = filterNotesByTrash(
                        localNotes.length === 0 && notesBaseline?.length ? notesBaseline : localNotes,
                        mergedNotesTrash,
                    )
                    const state = {
                        ...exportedAccounts,
                        addons: safeParse(rawAddons),
                        failover: {
                            rules: useFailoverStore.getState().rules,
                            webhook: useFailoverStore.getState().webhook
                        },
                        vault: vaultState.keys.filter(k => {
                            const trashedAt = vaultTombById.get(k.id)
                            return !trashedAt || trashedAt < (k.updatedAt || 0)
                        }),
                        vaultTombstones: mergedVaultTombstones,
                        notes: notesToPush,
                        notesTrash: mergedNotesTrash,
                        // Keep writes readable by clients predating deferred blob support.
                        watchEvents: watchExport.events,
                        watchSnapshot: watchExport.snapshot,
                        watchEventRollups: watchExport.rollups,
                        deletedWatchEvents: mergeDeletedEventMaps(watchExport.deletedEvents, syncRuntime.lastPulledDeletedWatchEvents ?? {}),
                        salt: saltBase64,
                        name: auth.name,

                        avatar: avatarValue,
                        lastSeenVersion: get().lastSeenVersion,
                        customThemes: (() => { try { return JSON.parse(localStorage.getItem('aio-custom-themes') || '[]') } catch { return [] } })(),
                        discoverFavorites: (() => { try { return JSON.parse(localStorage.getItem('aio-discover-favorites') || '[]') } catch { return [] } })(),
                        discoverPrefs: (() => { try { return JSON.parse(localStorage.getItem('aio-discover-prefs') || '{}') } catch { return {} } })(),
                        profiles: useProfileStore.getState().profiles,
                        settings: readSyncedSettings(),
                    }
                    // What this push actually sends; an edit after this point must stay unsynced.
                    const sentSettingsValues = snapshotSyncedSettingsValues(state.settings)

                    const { encryptSyncPayload } = await import('@/lib/crypto')
                    ownership.assert()
                    const stringifiedState = JSON.stringify(state)

                    if (stringifiedState === '[object Object]') {
                        throw new Error('Sync corruption detected: State is not an object.')
                    }

                    const payloadBytes = new TextEncoder().encode(stringifiedState).length
                    if (payloadBytes > 100 * 1024 * 1024) {
                        const mb = (payloadBytes / 1024 / 1024).toFixed(1)
                        console.error(`[Sync] Payload is ${mb}MB - exceeds safe threshold (100MB). Aborting push.`)
                        throw new Error(`Sync payload too large (${mb}MB). Remove some accounts or data.`)
                    }

                    forceCanonicalRepublish = consumeForceFlag()
                    // Skip hash over the normalized state: volatile observation stamps
                    // (accountStates lastSync, rule lastCheck) must not defeat it.
                    const stateHash = await computeHash(JSON.stringify(normalizeStateForSkipHash(state)))
                    ownership.assert()
                    if (!forceCanonicalRepublish && !forceFull && get().pendingConflictAccountId !== auth.id && syncRuntime.lastPushedHash !== null && stateHash === syncRuntime.lastPushedHash) {
                        trace('sync', 'push.skip-unchanged', { accountId: auth.id, isAuto })
                        if (!isAuto && !isDebounced) {
                            get().addLogEntry({ type: 'push', status: 'success', message: 'No local changes to push - checking cloud.', isAuto: false })
                            setTimeout(() => { if (pushCurrent()) get().syncFromRemote(true).catch(() => {}) }, 0)
                        }
                        // The server already confirmed this exact state: any pending-push
                        // marker for this workspace is delivered (Sol P1-SYNC-01).
                        noteConfirmedPush(getActiveWorkspaceId())
                        return true
                    }

                    const syncedAtJson = JSON.stringify(new Date().toISOString())
                    const stampedState = stringifiedState === '{}'
                        ? `{"syncedAt":${syncedAtJson}}`
                        : `${stringifiedState.slice(0, -1)},"syncedAt":${syncedAtJson}}`

                    const { syncSaltB64 } = get()
                    const syncSalt = syncSaltB64 ? Uint8Array.from(atob(syncSaltB64), c => c.charCodeAt(0)) : undefined
                    const shouldCompress = stampedState.length > 51200
                    let compressedPayload: string = stampedState
                    let isCompressed = false
                    if (shouldCompress) {
                        try {
                            compressedPayload = await compressSyncPayload(stampedState)
                            isCompressed = true
                        } catch {}
                    }
                    let encryptedState: string
                    if (auth.password) {
                        encryptedState = await encryptSyncPayload(compressedPayload, auth.password, syncSalt)
                    } else if (sessionCred) {
                        // Refreshed password-session: encrypt with the session-stored sync key
                        // (exported at login under the same syncSalt) — identical key material
                        // to the password path, and NOT a PBKDF2 of the empty password.
                        const { importSyncKey, encryptSyncPayloadWithKey } = await import('@/lib/crypto')
                        const sessionSyncKey = await importSyncKey(Uint8Array.from(atob(sessionCred.syncKey), c => c.charCodeAt(0)))
                        encryptedState = await encryptSyncPayloadWithKey(compressedPayload, sessionSyncKey)
                    } else {
                        const deviceSyncKey = await getActiveDeviceSyncKey()
                        if (!deviceSyncKey) throw new Error('Remembered session lost its sync key. Sign in again.')
                        encryptedState = await import('@/lib/crypto').then(m => m.encryptSyncPayloadWithKey(compressedPayload, deviceSyncKey))
                    }

                    // Canonical addon lists for accounts the server can't read itself. A
                    // server-side Stremio credential (serverStremioCredentialedAccounts, learned
                    // from push/canonical responses) means the server reads Stremio directly;
                    // a client-side-only key does NOT — assuming it does strands the account
                    // in a server-side canonical island. Null = never learned: legacy
                    // assumption. Captured to become the merge base on a CONFIRMED push.
                    const knownServerAccounts = get().serverStremioCredentialedAccounts
                    const { isFoldedHub, clearFoldedHub } = await import('@/lib/folded-hubs')
                    ownership.assert()
                    const emptiedHubs: string[] = []
                    const canonicalPayload = useAccountStore.getState().accounts.reduce<Record<string, AddonDescriptor[]>>((map, a) => {
                        if (!serverHasStremioCredential(a.id, knownServerAccounts, !!getStremioAuthKey(a))) {
                            map[a.id] = a.addons || []
                            if (map[a.id].length === 0 && isFoldedHub(a.id)) emptiedHubs.push(a.id)
                        }
                        return map
                    }, {})

                    const syncToken = sessionCred?.token ?? await deriveSyncToken(auth.password)
                    ownership.assert()
                    const hasCanonicalEntries = Object.keys(canonicalPayload).length > 0
                    const canonicalV2Scope = capability.canonicalV2Scope(apiPath, auth.id)
                    if (hasCanonicalEntries && capability.canonicalV2Decision(syncRuntime.serverCanonicalAddonsV2, canonicalV2Scope, Date.now()) === 'probe') {
                        const probe = await probeServerCanonicalAddonsV2(apiPath)
                        ownership.assert()
                        syncRuntime.serverCanonicalAddonsV2 = capability.latchAfterProbe(syncRuntime.serverCanonicalAddonsV2, canonicalV2Scope, probe, Date.now())
                    }
                    const useCanonicalV2 = hasCanonicalEntries && capability.canonicalV2Decision(syncRuntime.serverCanonicalAddonsV2, canonicalV2Scope, Date.now()) === 'v2'
                    const buildPushBody = async (canonicalV2: boolean, revision: { baseContentHash?: string; syncedAt?: string | null; contentHint?: string }) => JSON.stringify({
                        data: encryptedState,
                        isEncrypted: true,
                        compressed: isCompressed,
                        syncSalt: syncSaltB64,
                        syncedAt: revision.syncedAt,
                        baseContentHash: revision.baseContentHash,
                        force: forcePush,
                        // Hash of the logical state (pre-syncedAt); lets the server skip the
                        // archive/rewrite/apiKeys churn when the content is byte-identical
                        // to what it already holds, since the envelope hash is IV-random.
                        contentHint: revision.contentHint,
                        apiKeys: useAccountStore.getState().accounts.reduce<Record<string, string>>((map, a) => {
                            if (a.apiKey) map[a.id] = a.apiKey
                            return map
                        }, {}),
                        // The deduplicated, deflated form travels only when the server
                        // advertised support; the legacy inline field is byte-identical
                        // to what older servers and rolled-back tabs have always sent.
                        ...(canonicalV2
                            ? { canonicalAddonsV2: { version: 2, compressed: true, data: await compressSyncPayload(JSON.stringify(dedupeCanonicalAddons(canonicalPayload))) } }
                            : { canonicalAddons: canonicalPayload }),
                        emptiedHubs,
                    })
                    const sendPush = async (pushBody: string): Promise<Record<string, unknown> | null> => {
                        // Debounce sizing input: the wire size this push actually uploads.
                        syncRuntime.lastPushedEnvelopeBytes = pushBody.length
                        const res = await resilientFetch(`${apiPath}/sync/${auth.id}`, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'x-sync-password': syncToken
                            },
                            body: pushBody,
                            // Multi-MB envelopes need minutes, not the 10 s default, on a slow uplink.
                            timeout: syncUploadTimeoutMs(pushBody.length),
                        })
                        if (!pushCurrent()) return null

                        if (res.status === 401) {
                            const profile = readIdentityProfile()
                            set({ auth: { id: '', password: '', name: profile.name, avatar: profile.avatar, isAuthenticated: false }, isSyncing: false, isInitialSyncCompleted: false, needsReauth: false })
                            clearSyncCredentialCaches()
                            setActiveWorkspace(ANON_WORKSPACE_ID)
                            const expiredOwnership = captureSyncOwnership()
                            import('@/lib/device-session').then(({ deactivateDeviceAuth }) => {
                                if (expiredOwnership.current() && !get().auth.isAuthenticated) deactivateDeviceAuth()
                            }).catch(() => {})
                            throw new Error('Sync session expired')
                        }

                        if (res.status === 413) {
                            throw new Error('Sync data was too large for the server to accept (413). If AIOManager sits behind nginx, raise client_max_body_size in its config. Your data is safe locally and will push once the limit is raised.')
                        }

                        if (!res.ok) {
                            const errorData = await res.text().then(t => { try { return JSON.parse(t) } catch { return {} } }).catch(() => ({}))
                            throw new Error(errorData.message || `Server Error: ${res.status}`)
                        }

                        const parsed = await res.text().then(t => { try { return JSON.parse(t) } catch { return {} } })
                        if (!pushCurrent()) return null
                        return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
                    }

                    let resData = await sendPush(await buildPushBody(useCanonicalV2, {
                        syncedAt: get().lastSyncedAt,
                        baseContentHash: get().lastSyncedCloudEtag ?? undefined,
                        contentHint: (forceCanonicalRepublish || forceFull) ? undefined : stateHash,
                    }))
                    if (!resData) return false
                    if (capability.canonicalV2PushOutcome(useCanonicalV2, resData) === 'retry-legacy') {
                        // The blob landed but the server ignored the V2 canonical field (a
                        // rollback or a server that predates the acknowledgment). Hold
                        // legacy-only for this scope and resend inline on top of the blob
                        // it just stored, without the content hint so the unchanged-content
                        // skip cannot suppress the canonical write.
                        syncRuntime.serverCanonicalAddonsV2 = capability.latchAfterMissingAck(canonicalV2Scope, Date.now())
                        trace('sync', 'push.canonical-v2-unacknowledged', { accountId: auth.id })
                        resData = await sendPush(await buildPushBody(false, {
                            syncedAt: typeof resData.syncedAt === 'string' ? resData.syncedAt : get().lastSyncedAt,
                            baseContentHash: typeof resData.contentHash === 'string' ? resData.contentHash : get().lastSyncedCloudEtag ?? undefined,
                        }))
                        if (!resData) return false
                    }

                    if (resData.conflict) {
                        if (import.meta.env.DEV) console.log('[Sync] Server reported conflict. Triggering pull.')
                        set({ pendingConflictAccountId: auth.id })
                        import('@/hooks/use-toast').then(({ toast }) => {
                            if (!pushCurrent()) return
                            toast({
                                id: 'cloud-changed',
                                variant: 'warning',
                                title: 'Cloud changed',
                                description: 'The cloud copy changed before this save completed. Pulling the latest state and preserving your unsaved changes.',
                            })
                        }).catch(() => {})
                        // Release this push's lock before starting its conflict refresh.
                        setTimeout(() => {
                            if (!pushCurrent()) return
                            get().refreshFromCloud().catch(e => { if (import.meta.env.DEV) console.error(e) })
                        }, 0)
                        return false
                    }

                    // Recheck push ownership after loading completion helpers.
                    const canonicalBase = await import('@/lib/canonical-base').catch(() => null)
                    if (!pushCurrent()) return false
                    syncRuntime.lastPushedHash = stateHash
                    syncRuntime.lastSyncedAccountCount = accountCount
                    // The pushed settings are the cloud copy now: local edits stop counting as unsynced.
                    markSyncedSettingsPushed(sentSettingsValues)
                    // Advance confirmed notes unless a purge changed the fallback during this push.
                    if (syncRuntime.lastPulledNotes === notesBaseline && syncRuntime.lastPulledNotesTrash === notesTrashBaseline) {
                        syncRuntime.lastPulledNotes = notesToPush
                        syncRuntime.lastPulledNotesTrash = mergedNotesTrash
                    }
                    set({
                        lastSyncedAccountIds: (exportedAccounts.accounts as { id: string }[]).map(a => a.id),
                        lastSyncedAccountIdsEtag: typeof resData.contentHash === 'string' ? resData.contentHash : null,
                    })
                    if (typeof resData.contentHash === 'string') {
                        set({ lastSyncedCloudEtag: resData.contentHash })
                    }
                    adoptPushResponseCredentials(forceCanonicalRepublish, resData.serverStremioCredentialedAccounts)
                    for (const hubId of emptiedHubs) clearFoldedHub(hubId)

                    // Credential auto-heal: the response's serverStremioCredentialedAccounts
                    // is the authoritative server-side credential set. Uploading only when an
                    // account with a client-side Stremio key is missing from it keeps healed
                    // steady-state pushes free of the extra round trip.
                    const serverCredentialedIds = Array.isArray(resData.serverStremioCredentialedAccounts)
                        ? resData.serverStremioCredentialedAccounts as string[]
                        : null
                    if (needsCredentialHeal(serverCredentialedIds, useAccountStore.getState().accounts.map(a => ({ id: a.id, hasClientStremioKey: !!getStremioAuthKey(a) })))) {
                        import('@/lib/activity-server').then(m => {
                            if (pushCurrent()) return m.syncCredentialsToServer()
                        }).catch(() => { })
                    }

                    // Advance the merge base ONLY on a confirmed push; base is "what the
                    // server confirmed it received," never "what we hoped to send." If the
                    // push had failed, leaving the base stale would make the next merge
                    // mistake a just-deleted addon for an inbound add and resurrect it.
                    // Receipts make that per hub: a rejected canonical (shrink guard,
                    // other workspace) keeps its old base, and the rejected snapshot is
                    // not retried; it rides later pushes unchanged and the server
                    // re-evaluates its guards with no extra writes. Receipt-less replies
                    // (older servers) keep confirming every entry.
                    const canonicalReceipts = resData.canonical
                    let rejectedHubs: string[] = []
                    if (canonicalBase) {
                        // Server-reported per-hub stored-plaintext hashes ride the base so
                        // the next reconcile can skip hubs the server still holds exactly
                        // as pushed.
                        const canonicalVersions = resData.canonicalVersions && typeof resData.canonicalVersions === 'object'
                            ? resData.canonicalVersions as Record<string, unknown>
                            : null
                        const canonicalEntries: Record<string, import('@/lib/canonical-base').CanonicalBaseEntry> = {}
                        for (const [hubId, addons] of Object.entries(canonicalPayload)) {
                            const hash = canonicalVersions?.[hubId]
                            canonicalEntries[hubId] = typeof hash === 'string' && hash ? { addons, hash } : { addons }
                        }
                        canonicalBase.setCanonicalBases(canonicalBase.confirmedCanonicalEntries(canonicalEntries, canonicalReceipts))
                        rejectedHubs = canonicalBase.rejectedCanonicalEntries(canonicalEntries, canonicalReceipts)
                    }
                    if (rejectedHubs.length > 0) trace('sync', 'push.canonical-rejected', { accountId: auth.id, hubs: rejectedHubs.join(',') })

                    if (get().pendingConflictAccountId === auth.id) set({ pendingConflictAccountId: null })
                    set({ lastSyncedAt: readServerSyncTimestamp(resData.syncedAt) ?? get().lastSyncedAt, needsReauth: false, lastAppliedAccountCount: accountCount, lastAppliedAddonCount: addonCount, lastSyncedNotesCount: notesToPush.length })

                    get().addLogEntry({
                        type: 'push',
                        status: 'success',
                        // Rejected hubs ride the same success entry the locked-account
                        // note uses; no separate surface exists for per-hub outcomes.
                        message: [
                            lockedAccounts.length > 0
                                ? `Sync successful. Sign-in needed on this device: ${lockedAccounts.map(a => a.name).join(', ')}`
                                : 'Sync successful',
                            rejectedHubs.length > 0 ? `Cloud addon list not saved for: ${rejectedHubs.join(', ')}.` : '',
                        ].filter(Boolean).join(' '),
                        isAuto
                    })
                    trace('sync', 'push.success', { accountId: auth.id, isAuto, bytes: payloadBytes, compressed: isCompressed, timing: Date.now() - pushStart })
                    syncRuntime.pendingRetry = false
                    resetRepublishAttempts()
                    // Confirmed delivery retires any pending-push marker for this workspace.
                    noteConfirmedPush(getActiveWorkspaceId())

                    try {
                        const bc = new BroadcastChannel('aio-sync')
                        bc.postMessage({ type: 'sync-complete', timestamp: Date.now() })
                        bc.close()
                    } catch (e) { if (import.meta.env.DEV) console.error(e) }
                    return true
                } catch (e) {
                    if (!pushCurrent()) return false
                    const message = pushErrorMessage(e)
                    if (import.meta.env.DEV) console.error("Sync error:", apiPath, e)
                    if (isAuto) syncRuntime.pendingRetry = true
                    get().addLogEntry({
                            type: 'push',
                            status: 'error',
                            message: `Push Failed: ${message}`,
                            isAuto
                        })
                    trace('sync', 'push.error', { accountId: auth.id, isAuto, error: message, timing: Date.now() - pushStart })
                    if (!isAuto && !isDebounced && syncRuntime.appReady) {
                        toast({ variant: "destructive", title: "Save Failed", description: message })
                    }
                    return false
                } finally {
                    if (pushCurrent()) set({ isSyncing: false })
                    releaseSyncLock()
                }
            },

            forcePushState: async () => {
                const ownership = captureSyncOwnership()
                const { auth } = get()
                if (!auth.isAuthenticated) {
                    get().addLogEntry({ type: 'force-push', status: 'error', message: 'Force push failed: not signed in.', isAuto: false })
                    return
                }

                const deadline = Date.now() + 20000
                while (get().isSyncing && Date.now() < deadline) {
                    await new Promise(r => setTimeout(r, 200))
                    if (!ownership.current()) return
                }
                if (get().isSyncing) {
                    get().addLogEntry({ type: 'force-push', status: 'error', message: 'Force push cancelled: another sync stayed in progress for 20s.', isAuto: false })
                    return
                }

                const ok = await get().syncToRemote(false, false, true, true)
                if (!ownership.current()) return
                get().addLogEntry({
                    type: 'force-push',
                    status: ok ? 'success' : 'error',
                    message: ok ? 'Force push completed.' : 'Force push failed — check the push error entry above for the reason.',
                    isAuto: false
                })
            },

            forceMirrorState: async () => {
                const { auth, serverUrl } = get()
                if (!auth.isAuthenticated) return
                // Validate credentials before allocating a mirror generation, so a no-op cannot
                // supersede pending work. Recheck session identity after the credential await.
                const sessionCred = getSessionSyncCredential(auth.id)
                if (!auth.password && !sessionCred) {
                    const readAuth = auth
                    const readWorkspace = getActiveWorkspaceId()
                    const readSeq = syncRuntime.pullSeq
                    if (!(await isDeviceSessionActive())) return
                    if (get().auth !== readAuth || getActiveWorkspaceId() !== readWorkspace || syncRuntime.pullSeq !== readSeq) return
                }
                // Mirrors share the pull generation counter and invalidate any adopted pull.
                syncRuntime.adoptedSeq = null
                const mirrorToken = ++syncRuntime.pullSeq
                const ownership = captureSyncOwnership(mirrorToken)
                const fence = ownership.assert
                if (get().pendingConflictAccountId === auth.id) set({ pendingConflictAccountId: null })
                set({ isSyncing: true })

                const apiPath = getSyncApiPath(serverUrl)

                // A failure after this boundary leaves local state uncertified.
                let applicationStarted = false

                try {
                    const res = await resilientFetch(`${apiPath}/sync/${auth.id}`, {
                        headers: { 'x-sync-password': sessionCred?.token ?? await deriveSyncToken(auth.password) },
                        timeout: SYNC_PULL_TIMEOUT_MS,
                    })

                    // Discard a mirror response after its session ends.
                    fence()

                    if (!res.ok) throw new Error(`Cloud Sync Server error (${res.status})`)

                    const text = await res.text()
                    const responseEtag = res.headers.get('etag')
                    let data: Record<string, unknown>
                    const raw = JSON.parse(text) as Record<string, unknown>
                    const responseSyncedAt = readServerSyncTimestamp(raw.syncedAt)
                    fence()
                    const avatarBlobWire = typeof raw.avatarBlob === 'string' ? raw.avatarBlob : undefined
                    const watchBlobWire = typeof raw.watchBlob === 'string' ? raw.watchBlob : undefined
                    const remoteSyncSalt = raw.syncSalt && typeof raw.syncSalt === 'string'
                        ? Uint8Array.from(atob(raw.syncSalt), c => c.charCodeAt(0))
                        : undefined

                    // Decode mirror blobs with the key that decrypted the inner payload.
                    let mirrorBlobKeys: import('@/lib/sync-blob-decode').SyncBlobKeys = {}
                    if (raw.isEncrypted && raw.data) {
                        const { decryptSyncPayload: decryptPayload } = await import('@/lib/crypto')
                        let decryptedStr: string
                        let innerKey: import('@/lib/sync-blob-decode').SyncBlobKeys
                        if (auth.password) {
                            decryptedStr = await decryptPayload(raw.data as string, auth.password, remoteSyncSalt)
                            innerKey = { password: auth.password, salt: remoteSyncSalt }
                        } else if (sessionCred) {
                            const { importSyncKey, decryptSyncPayloadWithKey } = await import('@/lib/crypto')
                            const sessionSyncKey = await importSyncKey(Uint8Array.from(atob(sessionCred.syncKey), c => c.charCodeAt(0)))
                            decryptedStr = await decryptSyncPayloadWithKey(raw.data as string, sessionSyncKey)
                            innerKey = { sessionSyncKeyB64: sessionCred.syncKey }
                        } else {
                            const deviceSyncKey = await getActiveDeviceSyncKey()
                            if (!deviceSyncKey) throw new Error('Remembered session lost its sync key. Sign in again.')
                            decryptedStr = await import('@/lib/crypto').then(m => m.decryptSyncPayloadWithKey(raw.data as string, deviceSyncKey))
                            innerKey = { deviceSyncKey }
                        }
                        const payloadStr = raw.compressed ? await decompressSyncPayload(decryptedStr) : decryptedStr
                        fence()
                        data = JSON.parse(payloadStr) as Record<string, unknown>
                        mirrorBlobKeys = innerKey
                    } else {
                        data = raw
                    }

                    // Clear push trust and the old ETag before a mirror applies any slice.
                    applicationStarted = true
                    fence()
                    set({ isInitialSyncCompleted: false, lastSyncedCloudEtag: null })
                    syncRuntime.hydration = { seq: mirrorToken, id: auth.id, status: 'pending', kind: 'mirror' }

                    // Restore deferred avatar and watch blobs as part of the mirror.
                    const mirrorIncomplete: string[] = []
                    let secondary = data
                    let watchBlobBroken = false
                    if (watchBlobWire) {
                        const decoded = await decodeSyncBlob(watchBlobWire, mirrorBlobKeys)
                        fence()
                        if (decoded === null) {
                            watchBlobBroken = true
                            mirrorIncomplete.push('cloud watch history')
                            if (import.meta.env.DEV) console.warn('[Sync] Mirror: watch blob restore failed; falling back to inner state.')
                        } else {
                            try {
                                const parsed = JSON.parse(decoded) as unknown
                                // Wrong-shaped watch data is an incomplete cloud slice.
                                if (!isValidWatchPayload(parsed)) {
                                    watchBlobBroken = true
                                    mirrorIncomplete.push('cloud watch history')
                                    if (import.meta.env.DEV) console.warn('[Sync] Mirror: watch blob content was not the expected structure; falling back to inner state.')
                                } else {
                                    secondary = { ...data, ...parsed }
                                }
                            } catch (e) {
                                watchBlobBroken = true
                                mirrorIncomplete.push('cloud watch history')
                                if (import.meta.env.DEV) console.warn('[Sync] Mirror: watch blob content was not valid JSON; falling back to inner state.', e)
                            }
                        }
                    }
                    let mirroredAvatar = data.avatar
                    if (avatarBlobWire) {
                        const decoded = await decodeSyncBlob(avatarBlobWire, mirrorBlobKeys)
                        fence()
                        if (decoded !== null) {
                            try {
                                const parsed = JSON.parse(decoded) as unknown
                                if (isValidAvatarPayload(parsed)) mirroredAvatar = parsed
                                else {
                                    // Invalid JSON leaves the mirror incomplete.
                                    mirrorIncomplete.push('cloud avatar')
                                    if (import.meta.env.DEV) console.warn('[Sync] Mirror: avatar blob content was not the expected JSON string; keeping local avatar for display.')
                                }
                            } catch (e) {
                                mirrorIncomplete.push('cloud avatar')
                                if (import.meta.env.DEV) console.warn('[Sync] Mirror: avatar blob content was not valid JSON; keeping local avatar for display.', e)
                            }
                        } else {
                            mirrorIncomplete.push('cloud avatar')
                            if (import.meta.env.DEV) console.warn('[Sync] Mirror: avatar blob restore failed; keeping local avatar for display.')
                        }
                    }

                    if (data.accounts !== undefined) {
                        fence()
                        // Import can remap a cloud account onto a matching local id, so the cleanup
                        // baseline is the blob's own ids, never the merged local list.
                        const blobAccounts = Array.isArray(data.accounts) ? data.accounts : (data.accounts as Record<string, unknown> | null)?.accounts
                        if (!Array.isArray(blobAccounts)) throw new Error('Cloud accounts must be an array')
                        const ids = blobAccounts.map(a => (a as { id: string }).id)
                        await useAccountStore.getState().importAccounts(data, true, 'mirror', undefined, ownership, 'restore')
                        fence()
                        syncRuntime.lastSyncedAccountCount = ids.length
                        set({ lastSyncedAccountIds: ids, lastSyncedAccountIdsEtag: responseEtag ?? null })
                    } else {
                        throw new Error('Cloud data is missing accounts; nothing was replaced')
                    }
                    fence()
                    {
                        const identity = resolveCloudIdentity({ ...data, avatar: mirroredAvatar }, auth.id, get().auth)
                        if (identity.name !== get().auth.name || identity.avatar !== get().auth.avatar) {
                            writeIdentityProfile(auth.id, identity.name, identity.avatar)
                            set({ auth: { ...get().auth, name: identity.name, avatar: identity.avatar } })
                        }
                    }
                    if (data.addons) {
                        fence()
                        await useAddonStore.getState().importLibrary(data, false, true, true, ownership)
                        await useAddonStore.getState().initialize(ownership)
                    }
                    if (data.profiles && Array.isArray(data.profiles)) {
                        fence()
                        await useProfileStore.getState().importProfiles(data.profiles, ownership)
                    }
                    if (data.failover) {
                        fence()
                        const strategy = 'mirror'
                        if (Array.isArray(data.failover)) {
                            await useFailoverStore.getState().importRules(data.failover, strategy, true, ownership)
                        } else if (typeof data.failover === 'object') {
                            const fo = data.failover as Record<string, unknown>
                            if (fo.rules) await useFailoverStore.getState().importRules(fo.rules, strategy, true, ownership)
                            if (fo.webhook) await useFailoverStore.getState().importWebhook(fo.webhook as import('./failoverStore').WebhookConfig, true, ownership)
                        }
                    }
                    if (data.settings) {
                        fence()
                        applySyncedSettings(data.settings as Record<string, unknown>, true, { protectLocalEdits: true })
                    }
                    if (data.notes && Array.isArray(data.notes)) {
                        fence()
                        const { useNotesStore } = await import('@/store/notesStore')
                        await useNotesStore.getState().importNotes(data.notes, ownership)
                        fence()
                        syncRuntime.lastPulledNotes = data.notes as import('./notesStore').Note[]
                        set({ lastSyncedNotesCount: data.notes.length })
                    }
                    if (Array.isArray(data.vault) || Array.isArray(data.vaultTombstones)) {
                        fence()
                        await useVaultStore.getState().initialize(ownership)
                        // Fence marker publication after initialization.
                        fence()
                        syncRuntime.lastPulledVaultTombstones = (data.vaultTombstones || []) as import('./vaultStore').VaultTombstone[]
                        await useVaultStore.getState().importVault((data.vault || []) as import('@/types/vault').VaultKey[], (data.vaultTombstones || []) as import('./vaultStore').VaultTombstone[], ownership)
                    }
                    fence()
                    if (Array.isArray(secondary.watchEvents)) {
                        const { useWatchEventStore } = await import('@/store/watchEventStore')
                        fence()
                        const local = useWatchEventStore.getState()
                        const remoteDeleted = (secondary.deletedWatchEvents && typeof secondary.deletedWatchEvents === 'object') ? secondary.deletedWatchEvents as Record<string, number> : {}
                        // Preserve previous deletion markers if the watch blob is unreadable.
                        if (!watchBlobBroken) syncRuntime.lastPulledDeletedWatchEvents = remoteDeleted
                        const mergedDeleted = mergeDeletedEventMaps(local.deletedEventKeys, remoteDeleted)
                        const merged = new Map<string, Record<string, unknown>>()
                        ;[...(secondary.watchEvents as Record<string, unknown>[]), ...local.events as unknown as Record<string, unknown>[]].forEach(e => merged.set(e.id as string, e))
                        const mergedEvents = Array.from(merged.values()).sort((a, b) => (b.event_ts as number) - (a.event_ts as number))
                        const mergedSnapshot = { ...((secondary.watchSnapshot || {}) as Record<string, unknown>), ...local.snapshot }
                        const remoteRollups = (secondary.watchEventRollups && typeof secondary.watchEventRollups === 'object')
                            ? secondary.watchEventRollups as import('@/lib/watch-event-rollups').EventRollups
                            : undefined
                        useWatchEventStore.getState().initialize(mergedEvents as unknown as import('@/types/activity').WatchEvent[], mergedSnapshot as Record<string, Record<string, import('@/types/activity').SnapshotItem>>, mergedDeleted, remoteRollups)
                    }
                    fence()
                    if (Array.isArray(data.customThemes) && data.customThemes.length > 0) {
                        applySyncedSettings({ customThemes: data.customThemes }, true, { protectLocalEdits: true })
                    }
                    if (Array.isArray(data.discoverFavorites)) {
                        try { localStorage.setItem('aio-discover-favorites', JSON.stringify(data.discoverFavorites)) } catch {}
                    }
                    if (data.discoverPrefs && typeof data.discoverPrefs === 'object') {
                        try { localStorage.setItem('aio-discover-prefs', JSON.stringify(data.discoverPrefs)) } catch {}
                    }
                    if (Array.isArray(data.notesTrash)) {
                        fence()
                        syncRuntime.lastPulledNotesTrash = data.notesTrash
                        const { useNotesStore } = await import('@/store/notesStore')
                        await useNotesStore.getState().importTrash(data.notesTrash, ownership)
                    }
                    fence()
                    if (data.lastSeenVersion) {
                        set({ lastSeenVersion: data.lastSeenVersion as string | null })
                    }
                    syncRuntime.lastPulledCloudAvatar = (typeof mirroredAvatar === 'string' && mirroredAvatar) ? mirroredAvatar : null

                    set({ lastSyncedAt: responseSyncedAt ?? get().lastSyncedAt })

                    // Incomplete mirrors keep pushes disabled and require a full refresh.
                    const recordOurs = syncRuntime.hydration?.seq === mirrorToken
                    if (mirrorIncomplete.length > 0) {
                        if (recordOurs) syncRuntime.hydration = { seq: mirrorToken, id: auth.id, status: 'failed', kind: 'mirror' }
                        get().addLogEntry({
                            type: 'force-mirror',
                            status: 'error',
                            message: `Mirror incomplete: ${mirrorIncomplete.join(' and ')} could not be decoded. Check credentials on this device and retry.`,
                            isAuto: false
                        })
                        toast({ variant: 'destructive', title: 'Mirror Incomplete', description: 'Part of the cloud state could not be decoded. Retry once credentials are consistent.' })
                    } else {
                        if (recordOurs) syncRuntime.hydration = { seq: mirrorToken, id: auth.id, status: 'ok', kind: 'mirror' }
                        set({
                            isInitialSyncCompleted: true,
                            lastSyncedCloudEtag: responseEtag ?? null,
                            lastAppliedAccountCount: useAccountStore.getState().accounts.length,
                            lastAppliedAddonCount: Object.keys(useAddonStore.getState().library).length,
                        })
                        get().addLogEntry({
                            type: 'force-mirror',
                            status: 'success',
                            message: 'Cloud state applied with addon deletion protection',
                            isAuto: false
                        })

                        toast({ title: "Mirror Complete", description: "Local state replaced by cloud data." })
                    }
                } catch (e) {

                    if (!ownership.current()) return
                    const msg = (e as Error).message
                    // Keep partially applied mirrors uncertified; earlier network/decrypt failures preserve prior trust.
                    if (applicationStarted && syncRuntime.hydration?.seq === mirrorToken) {
                        syncRuntime.hydration = { seq: mirrorToken, id: auth.id, status: 'failed', kind: 'mirror' }
                    }
                    toast({ variant: "destructive", title: "Mirror Failed", description: msg })
                        ; get().addLogEntry({
                            type: 'force-mirror',
                            status: 'error',
                            message: `Mirror Failed: ${msg}`,
                            isAuto: false
                        })
                } finally {
                    // Only the owning mirror may release its in-progress flag.
                    if (ownership.current()) set({ isSyncing: false })
                }
            },

            deleteRemoteAccount: async () => {
                const { auth, serverUrl } = get()
                if (!auth.isAuthenticated) return
                const apiPath = getSyncApiPath(serverUrl)
                const start = Date.now()
                trace('sync', 'delete.start', { accountId: auth.id })

                try {
                    const res = await resilientFetch(`${apiPath}/sync/${auth.id}`, {
                        method: 'DELETE',
                        headers: { 'x-sync-password': await getSyncPasswordHeader(auth) }
                    })

                    if (!res.ok) throw new Error("Failed to delete account from server")
                    trace('sync', 'delete.success', { accountId: auth.id, timing: Date.now() - start })
                    get().logout()
                } catch (e) {
                    trace('sync', 'delete.error', { accountId: auth.id, error: (e as Error)?.message, timing: Date.now() - start })
                    throw e
                }
            },

            reset: () => {
                resetAccountsHydration()
                syncRuntime.pullSeq++
                syncRuntime.adoptedSeq = null
                syncRuntime.hydration = null
                set({ pendingConflictAccountId: null })
                setActiveWorkspace(ANON_WORKSPACE_ID)
                set({
                    auth: { id: '', password: '', name: '', avatar: null, isAuthenticated: false },
                    serverUrl: '',
                    lastSyncedAt: null,
                    lastSyncCheckedAt: null,
                    isSyncing: false,
                    isRefreshingFromCloud: false,
                    lastActionTimestamp: 0,
                    isInitialSyncCompleted: false,
                    lastSyncedCloudEtag: null,
                    lastSyncedNotesCount: null,
                    lastAppliedAccountCount: null,
                    lastSyncedAccountIds: null,
                    lastSyncedAccountIdsEtag: null,
                    lastAppliedAddonCount: null,
                    serverStremioCredentialedAccounts: null,
                    needsReauth: false
                })
                clearRepublishState()
            }
        }),
        {
            name: 'aioman-sync',
            storage: createSafeStorage(),
            partialize: (state) => ({
                auth: {
                    id: state.auth.id,
                    name: state.auth.name,
                    avatar: state.auth.avatar,
                    isAuthenticated: state.auth.isAuthenticated,
                    password: '',
                },
                lastSyncedAt: state.lastSyncedAt,
                // Survives a reload while conflict recovery is offline or incomplete.
                pendingConflictAccountId: state.pendingConflictAccountId,
                serverUrl: state.serverUrl,
                lastActionTimestamp: state.lastActionTimestamp,
                lastSeenVersion: state.lastSeenVersion,
                syncSaltB64: state.syncSaltB64,
                lastSyncedCloudEtag: state.lastSyncedCloudEtag,
                lastSyncedNotesCount: state.lastSyncedNotesCount,
                lastAppliedAccountCount: state.lastAppliedAccountCount,
                lastSyncedAccountIds: state.lastSyncedAccountIds,
                lastSyncedAccountIdsEtag: state.lastSyncedAccountIdsEtag,
                lastAppliedAddonCount: state.lastAppliedAddonCount,
                serverStremioCredentialedAccounts: state.serverStremioCredentialedAccounts,
            }),
            merge: (persistedState, currentState) => ({
                ...currentState,
                ...(persistedState as Partial<SyncState>),
                isSyncing: false,
                isRefreshingFromCloud: false,
                isInitialSyncCompleted: false,
            }),
        }
    )
)

if (typeof window !== 'undefined') {
    // Migration: stop storing the raw password (pre-remembered-device sessions).
    try { sessionStorage.removeItem(LEGACY_SYNC_PASSWORD_KEY) } catch {}
    localStorage.removeItem('aio-pending-sync')

    import('@/lib/device-session').then(({ reactivateDeviceSessionIfNeeded }) => reactivateDeviceSessionIfNeeded()).catch(() => {})

    syncRuntime.onlineHandler = () => {
        if (syncRuntime.pendingRetry) {
            syncRuntime.pendingRetry = false
            useSyncStore.getState().syncToRemote(true).catch(() => {})
        }
    }
    window.addEventListener('online', syncRuntime.onlineHandler)

    // A hidden/closing page must not drop a deferred change. The async push may still
    // complete, but iOS can suspend the page before it reaches the server, so the hide
    // path also writes a durable pending-push marker (workspace id + timestamp only) and
    // the next valid session retries one normal push (Sol P1-SYNC-01). The local account
    // persist flush rides the same events in accountStore.
    const flushPendingPushForHide = () => {
        const flushed = flushSyncPushDebounce(syncRuntime, () => { useSyncStore.getState().syncToRemote(false, true).catch(() => {}) })
        const inFlight = useSyncStore.getState().isSyncing
        if (flushed || inFlight) writePendingPushMarker(getActiveWorkspaceId())
    }
    window.addEventListener('pagehide', flushPendingPushForHide)
    window.addEventListener('beforeunload', flushPendingPushForHide)
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flushPendingPushForHide()
    })

    // Boot retry: once a session is valid again (signed in, initial sync applied, no
    // re-auth pending, nothing in flight), a due marker for this workspace runs one
    // normal push. Marker and confirmed state are per workspace, so only the active
    // workspace's entry is compared here. The confirmed response clears it; one
    // attempt per marker per boot, and a different workspace's marker is never
    // pushed from here.
    const retryPendingPushIfDue = () => {
        const state = useSyncStore.getState()
        if (!state.auth.isAuthenticated || !state.isInitialSyncCompleted || state.needsReauth || state.isSyncing) return
        const marker = readPendingPushMarker(getActiveWorkspaceId())
        if (!marker || !pendingPushDue(marker, { workspaceId: getActiveWorkspaceId(), lastConfirmedPushAt: readLastConfirmedPushAt(getActiveWorkspaceId()) })) return
        const attemptKey = `${marker.workspaceId}:${marker.markedAt}`
        if (syncRuntime.pendingPushMarkerAttemptKey === attemptKey) return
        syncRuntime.pendingPushMarkerAttemptKey = attemptKey
        trace('sync', 'push.pending-marker-retry', { accountId: state.auth.id, workspaceId: marker.workspaceId, markedAt: marker.markedAt })
        state.syncToRemote(false, true).catch(() => {})
    }
    useSyncStore.subscribe(retryPendingPushIfDue)
    retryPendingPushIfDue()

    try {
        syncRuntime.syncBC = new BroadcastChannel('aio-sync')
        syncRuntime.syncBC.onmessage = (event) => {
            if (event.data?.type === 'sync-complete') {
                const state = useSyncStore.getState()
                if (!state.auth.isAuthenticated) return
                const lastSync = state.lastSyncedAt
                if (lastSync && Date.now() - new Date(lastSync).getTime() < 30_000) return
                state.syncFromRemote(true).catch(e => { if (import.meta.env.DEV) console.error(e) })
            }
        }
    } catch (e) { if (import.meta.env.DEV) console.error(e) }
}

bindRepublishHost({
    isAuthenticated: () => useSyncStore.getState().auth.isAuthenticated,
    runRepublish: () => useSyncStore.getState().syncToRemote(false, true),
    getPrevSet: () => useSyncStore.getState().serverStremioCredentialedAccounts,
    setPrevSet: next => useSyncStore.setState({ serverStremioCredentialedAccounts: next }),
    membershipChanged: (prev, next) => canonicalMembershipChanged(useAccountStore.getState().accounts, a => !!getStremioAuthKey(a), prev, next),
    schedule: (fn, delayMs) => setTimeout(fn, delayMs),
    cancel: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
})
