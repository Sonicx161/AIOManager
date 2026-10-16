import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import { useAccountStore, getStremioAuthKey } from './accountStore'
import type { AddonDescriptor } from '@/types/addon'
import { useAddonStore } from './addonStore'
import { useProfileStore } from './profileStore'
import { useFailoverStore } from './failoverStore'
import { useAuthStore } from './authStore'
import { useVaultStore } from './vaultStore'
import { toast } from '@/hooks/use-toast'
import { deriveSyncToken } from '@/lib/crypto'
import { resilientFetch } from '@/lib/api-resilience'
import { compressSyncPayload, decompressSyncPayload } from '@/lib/sync-payload-codec'
import { decodeSyncBlob, isValidAvatarPayload, isValidWatchPayload } from '@/lib/sync-blob-decode'
import { applySyncedSettings, readSyncedSettings } from '@/lib/synced-settings'
import { resolveRestoreSaltPolicy } from '@/lib/salt-policy'
import { serverHasStremioCredential, canonicalMembershipChanged } from '@/lib/canonical-visibility'
import { needsCredentialHeal } from '@/lib/credential-heal'
import { mergeDeletedEventMaps } from '@/lib/event-tombstones'
import { mergeNotesTrash, filterNotesByTrash } from '@/lib/notes-tombstones'
import { shouldSendPullEtag, readServerSyncTimestamp, shouldMirrorAccountPull } from '@/lib/pull-restore'
import { setActiveWorkspace, getActiveWorkspaceId, ANON_WORKSPACE_ID } from '@/lib/workspace-persistence'
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
    resolveCloudIdentity,
    captureSyncOwnership,
} from './sync-store-helpers'
export { markAccountsHydrated, readIdentityProfile, getSyncApiPath } from './sync-store-helpers'
import {
    getSessionSyncCredential,
    saveSessionSyncToken,
} from '@/lib/session-sync-token'

// Suppress toasts during initial boot to prevent React "state update on unmounted component" warnings
setTimeout(() => { syncRuntime.appReady = true }, 3000)

// Post-conflict merge arm: set when a push is rejected with conflict, consumed
// by the next full pull for the same account. That pull merges (preserving the
// rejected local additions/deletions) instead of mirroring the winner's state.
// Scoped by account id so other workspaces are unaffected. Cleared when the
// armed pull applies, when a push succeeds, on explicit mirror, logout/reset.
let postConflictMergeFor: string | null = null

// tombstones into this map (max-wins) instead of replacing the cloud blob wholesale, so a



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
                    // The pull owns its own completion flip: 304 sets it directly, the 200
                    // path flips after the deferred slices land. Forcing it true here opened
                    // the push gate even when login returned early (e.g. a silent unlock
                    // failure imported nothing).
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

                    const res = await resilientFetch(`${apiPath}/sync/${newId}`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'x-sync-password': syncToken
                        },
                        body: JSON.stringify(emptyState)
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

            login: async (id: string, password: string, isSilent: boolean = false, bypassGuard: boolean = false, deviceUnlock?: { syncKey: CryptoKey }) => {
                if (get().isSyncing && !bypassGuard) return
                // Route every write in this pull into the target workspace's
                // namespace before any import runs. Same id is a no-op, so
                // silent re-syncs skip the swap. A failed login moves back: a
                // half-claimed namespace must never receive this session's writes.
                const priorWorkspace = getActiveWorkspaceId()
                setActiveWorkspace(id)
                // Async continuations of THIS pull (deferred hydration, the completion
                // flip) capture this token and stand down once a newer pull, logout or
                // workspace switch supersedes it. The bump also clears an outstanding
                // 304 adoption: a real supersession ends the re-arm.
                const pullToken = ++syncRuntime.pullSeq
                syncRuntime.adoptedSeq = null
                // Ownership for this pull's work: workspace + pull sequence captured
                // before the first await. Every import re-verifies before its writes
                // and publications, and a same-id logout/relogin (same workspace
                // string, new sequence) invalidates the old work like a real switch.
                const ownership = captureSyncOwnership(pullToken)
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
                            const saltB64 = get().syncSaltB64
                            const keySalt = saltB64 ? Uint8Array.from(atob(saltB64), c => c.charCodeAt(0)) : undefined
                            const syncKeyRaw = await exportSyncKeyRaw(password, keySalt)
                            saveSessionSyncToken(id, syncToken, btoa(String.fromCharCode(...syncKeyRaw)))
                        } catch { /* best-effort: this session still has the password in memory */ }
                    }
                    const storedEtag = get().lastSyncedCloudEtag
                    const sessionUnlocked = !!useAuthStore.getState().encryptionKey
                    // Empty-local force-apply: the workspace pulled notes before, but the
                    // local index now resolves none (sign-out wipe, storage eviction). The
                    // unchanged verdict would freeze an empty view, so the pull re-fetches
                    // the full state and lets the import restore it.
                    let localNotesEmpty = false
                    if (storedEtag && sessionUnlocked && (get().lastSyncedNotesCount ?? 0) > 0) {
                        try {
                            const { isLocalNotesStoreEmpty } = await import('@/store/notesStore')
                            localNotesEmpty = await isLocalNotesStoreEmpty()
                        } catch { localNotesEmpty = false }
                    }
                    const sendPullEtag = postConflictMergeFor !== id && shouldSendPullEtag({
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

                    const res = await resilientFetch(`${apiPath}/sync/${id}`, {
                        headers: pullHeaders
                    })

                    if (res.status === 304) {
                        // This response answers a request whose pull was already
                        // superseded (newer login, logout or reset since the fetch went
                        // out). Reject it before ANY side effect: no adoption, no gate
                        // flip, no log entry in the session that replaced this one, no
                        // credential re-persist. The finally below skips its flag write
                        // for the same reason.
                        if (!ownership.current()) return
                        const hydration = syncRuntime.hydration
                        // A 304 claims nothing. When it lands while an earlier pull of
                        // this account is still applying AND this conditional pull is the
                        // newest actor (it was the bump that invalidated the pending
                        // work), adopt that pending pull explicitly: its ownership
                        // re-validates against the adoption slot until the next real
                        // supersession. The global sequence never rewinds, so no other
                        // stale actor can revive; a pending MIRROR record is never
                        // adopted, and neither is work a newer full pull superseded.
                        const pendingAdopted = !!hydration
                            && hydration.status === 'pending'
                            && hydration.kind !== 'mirror'
                            && hydration.id === id
                            && pullToken > hydration.seq
                            && syncRuntime.pullSeq === pullToken
                        if (pendingAdopted) syncRuntime.adoptedSeq = hydration.seq
                        // "Unchanged" certifies only state this session fully applied: an
                        // in-flight or failed hydration, or a record from another account,
                        // must not ride the shortcut past an unapplied pull. A boot-time 304
                        // with a persisted etag is the one trusted fallback: that etag was
                        // minted after a full application (a pull that is about to apply
                        // clears it first, so a reload can never shortcut from unapplied
                        // state), and the stores below rehydrate exactly that persisted state.
                        const unchangedTrusted = hydration
                            ? hydration.status === 'ok' && hydration.id === id
                            : !!storedEtag && sessionUnlocked
                        set({ lastSyncCheckedAt: new Date().toISOString(), ...(unchangedTrusted ? { isInitialSyncCompleted: true } : {}) })
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

                    // Validation gate: everything below (decrypt, unlock, imports) can
                    // leave the workspace partially applied. Close the push gate and drop
                    // the previously certified etag BEFORE that work starts: the stored
                    // etag describes the pre-pull state, and after a partial application
                    // a reload must never 304-shortcut from it. completePull re-publishes
                    // the response etag only after every slice lands. Network-only
                    // failures (non-OK status, empty body) throw above this line and keep
                    // both: an outage without a partial application is an offline pause,
                    // not a corruption state.
                    set({ isInitialSyncCompleted: false, lastSyncedCloudEtag: null })
                    // This pull is about to apply cloud state: until its hydration
                    // settles, an unchanged (304) verdict cannot certify this session.
                    syncRuntime.hydration = { seq: pullToken, id, status: 'pending', kind: 'pull' }

                    let data: unknown
                    // Server-authoritative pull timestamp: the outer envelope's
                    // syncedAt is stamped by the server clock at push time. It
                    // becomes the next push baseline so a slow device clock can
                    // never self-conflict against its own server write. Captured
                    // before decrypt so a corrupt inner payload still leaves the
                    // outer value available for the decision below.
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
                            accounts: d.accounts ?? undefined,
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

                    // If no in-memory key (fresh page load / re-login after corruption),
                    // try to derive one from the local salt + password so we can still
                    // decrypt existing local account authKeys during reconciliation.
                    // Remembered sessions already carry the key; nothing to derive.
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
                        // Remembered session: the vault key was unwrapped locally and injected
                        // before this pull; unlockFromSync would need the password.
                        unlockOk = !!useAuthStore.getState().encryptionKey
                        if (!unlockOk && !isSilent) {
                            throw new Error('Remembered sign-in could not unlock the vault. Sign in again.')
                        }
                    } else if (!password && useAuthStore.getState().encryptionKey) {
                        // Session-credential restore: the vault is already unlocked with the
                        // stable key from boot. Deriving again would key from the empty
                        // password and clobber both the in-memory key and the stored wrap.
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
                        // A silent unlock failure is still a failed login: hand the
                        // namespace back so no later write lands in the half-claimed target.
                        if (getActiveWorkspaceId() === id) setActiveWorkspace(priorWorkspace)
                        if (import.meta.env.DEV) console.warn('[Sync] Skipping data import - encryption key not available.')
                        return
                    }
                    // Salts aligned: the key unlockFromSync just derived decrypts local authKeys
                    // too, so the expensive local-salt derivation is skipped entirely.
                    if (!preUnlockEncryptionKey && saltsAligned) {
                        preUnlockEncryptionKey = useAuthStore.getState().encryptionKey
                    }
                    const syncData = data as Record<string, unknown>
                    // Prime before any import runs: a mid-import failure must not leave the post-login push free to erase the cloud avatar.
                    syncRuntime.lastPulledCloudAvatar = (typeof syncData.avatar === 'string' && syncData.avatar) ? syncData.avatar : null
                    const localLastSync = get().lastSyncedAt
                    // Prefer the outer server timestamp (server clock domain) over the
                    // inner blob copy (legacy pushes stamped it with a client clock).
                    // Both are server time on modern pushes; the outer is authoritative.
                    const remoteLastSync = responseSyncedAt ?? (syncData.syncedAt as string | undefined)

                    const remoteTime = remoteLastSync ? new Date(remoteLastSync).getTime() : 0
                    const localTime = localLastSync ? new Date(localLastSync).getTime() : 0

                    const isLocalNewer = localTime > remoteTime
                    const isRemoteNewer = remoteTime > localTime
                    const isEqual = remoteTime === localTime

                    let decision = 'passive merge'
                    // Capture once even when accounts are absent. Keep the arm until
                    // every slice lands, so a failed hydration can retry as a merge.
                    const postConflictPull = postConflictMergeFor === id

                    if (syncData.accounts) {
                        const localAccounts = useAccountStore.getState().accounts
                        const remoteAccountsRaw = Array.isArray(syncData.accounts) ? syncData.accounts : (syncData.accounts as Record<string, unknown> | undefined)?.accounts || []
                        const remoteAccounts = remoteAccountsRaw as Record<string, unknown>[]
                        syncRuntime.lastSyncedAccountCount = remoteAccounts.length

                        const hasRemoteData = remoteAccounts.length > 0
                        const hasLocalData = localAccounts.length > 0

                        if (!hasRemoteData && hasLocalData) {
                            decision = 'Seed Cloud (local data exists, cloud is empty)'
                            await useAccountStore.getState().importAccounts(syncData, true, 'merge', preUnlockEncryptionKey, ownership)
                            setTimeout(() => get().syncToRemote(true), 1500)
                        } else if (hasRemoteData) {
                            // Post-conflict pulls merge even when the cloud is newer:
                            // the rejected push's local additions/deletions never
                            // reached the server, and mirroring would drop them.
                            if (shouldMirrorAccountPull({ isRemoteNewer, hasRemoteData, postConflict: postConflictPull })) {
                                decision = 'Adopt Remote (cloud is newer, replace local)'
                                await useAccountStore.getState().importAccounts(syncData, true, 'mirror', preUnlockEncryptionKey, ownership)
                            } else {
                                decision = postConflictPull
                                    ? 'Merge (post-conflict: preserve unsynced local changes)'
                                    : 'Merge (equal or local-newer timestamps)'
                                await useAccountStore.getState().importAccounts(syncData, true, 'merge', preUnlockEncryptionKey, ownership)
                            }
                        }
                    }

                    // Hydration split: only the accounts slice gates first paint. Every other
                    // slice applies in the background; the push gate (isInitialSyncCompleted)
                    // stays closed until they all land, so no write can outrun its revalidation.

                    // Ownership for this pull's background work. fence() re-verifies the
                    // captured workspace + sequence around every awaited import group, and
                    // the importers themselves carry the same ownership for their internal
                    // awaits, so a logout or a newer login mid-hydration stops the old pull
                    // from writing into (or publishing into) the namespace that replaced it.
                    // The continuation guard adds the auth install, which does not exist
                    // until the tail of this function runs.
                    const pullCurrent = ownership.current
                    const fence = ownership.assert
                    // The exact key context that decrypted this response: blobs are sealed
                    // with the same key on push, so they decode with the proven winner
                    // instead of re-resolving from mutable store state (a stale stored salt
                    // used to win there and silently drop both blobs).
                    const responseKey = deviceUnlock
                        ? { deviceSyncKey: deviceUnlock.syncKey }
                        : sessionPullCred
                            ? { sessionSyncKeyB64: sessionPullCred.syncKey }
                            : { password, salt: remoteSyncSalt }
                    // Completion handshake between the deferred slices and the auth install
                    // below: either may finish first, and the gate opens only when both
                    // have, in either order. hydrationOk starts false, so a rejecting
                    // hydration keeps the final install fail-closed.
                    let authInstalled = false
                    let hydrationOk = false
                    // Set when the expected avatar blob cannot be decoded (wrong key,
                    // corruption, or unexpected content): local display state is fine, but
                    // the pull stays incomplete for writes so its push can never replace
                    // the cloud avatar with a payload missing that slice.
                    let avatarIncomplete: string | null = null
                    const setHydration = (status: 'ok' | 'failed') => {
                        // A newer pull owns the record slot by then; never overwrite it.
                        if (syncRuntime.hydration?.seq === pullToken) syncRuntime.hydration = { seq: pullToken, id, status, kind: 'pull' }
                    }
                    const completePull = () => {
                        // The etag is minted from the response this pull fully applied:
                        // publishing it on anything less would let a later 304 certify
                        // state that never landed.
                        set({
                            isInitialSyncCompleted: true,
                            lastSyncedCloudEtag: responseEtag ?? null,
                            lastAppliedAccountCount: useAccountStore.getState().accounts.length,
                            lastAppliedAddonCount: Object.keys(useAddonStore.getState().library).length,
                        })
                        if (postConflictPull) {
                            postConflictMergeFor = null
                            // Hydration has finished; publish the winner plus local work.
                            setTimeout(() => { if (ownership.current()) get().syncToRemote(true).catch(() => {}) }, 1500)
                        }
                    }

                    const applySecondarySlices = async () => {
                    fence()
                    // Watch history out-of-band restore: decrypt the deferred blob when present
                    // (new pushes), else read the inner state (legacy pushes). The merged view
                    // feeds every slice below unchanged.
                    let secondary = syncData
                    // True when a watch blob was present but undecodable: the inner state is
                    // fleet-empty then, so the cloud tombstone map must not overwrite the
                    // previously-pulled one, and the merged view degrades to local-only.
                    let watchBlobBroken = false
                    // Set when an expected blob cannot be decoded: the pull still restores
                    // local display state, but it stays incomplete for writes.
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
                                // A decodable blob of the wrong SHAPE is an expected
                                // cloud slice this pull cannot apply: merging it would
                                // certify a history the device never actually restored.
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
                            setTimeout(() => get().syncToRemote(true), 1500)
                        } else if (isLocalNewer) {
                            if (import.meta.env.DEV) console.log("[Sync] Local addons are fresher. Merging & Pushing.")
                            await useAddonStore.getState().importLibrary(syncData, true, false, true, ownership)
                            setTimeout(() => get().syncToRemote(true), 2000)
                        } else if (isEqual) {
                            if (import.meta.env.DEV) console.log("[Sync] Addons synchronized. Passive import.")
                            await useAddonStore.getState().importLibrary(syncData, true, true, true, ownership)
                        } else {
                            // Post-conflict pulls merge the saved-addon library to
                            // preserve unsynced local entries instead of replacing
                            // them with the winner's list. Explicit mirror
                            // (forceMirrorState) stays wholesale by design.
                            await useAddonStore.getState().importLibrary(syncData, postConflictPull ? true : false, true, true, ownership)
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
                        // initialize swallows a lost session and returns quietly: the
                        // caller must re-verify before publishing into the shared
                        // runtime, or the dead pull's tombstones would steer the next
                        // push of the session that replaced it.
                        fence()
                        syncRuntime.lastPulledVaultTombstones = (secondary.vaultTombstones || []) as import('./vaultStore').VaultTombstone[]
                        await useVaultStore.getState().importVault((secondary.vault || []) as import('@/types/vault').VaultKey[], (secondary.vaultTombstones || []) as import('./vaultStore').VaultTombstone[], ownership)
                    }
                    fence()

                    if (secondary.settings) {
                        applySyncedSettings(secondary.settings as Record<string, unknown>, !isLocalNewer)
                    }

                    fence()
                    {
                        const { useWatchEventStore } = await import('@/store/watchEventStore')
                        fence()
                        const local = useWatchEventStore.getState()
                        const remoteEvents: Record<string, unknown>[] = Array.isArray(secondary.watchEvents) ? secondary.watchEvents as Record<string, unknown>[] : []
                        const remoteDeleted = (secondary.deletedWatchEvents && typeof secondary.deletedWatchEvents === 'object') ? secondary.deletedWatchEvents as Record<string, number> : {}
                        // A broken blob means this map is the inner state's fleet-empty one:
                        // keeping the previously-pulled map preserves the other devices'
                        // deletion tombstones across this degraded pull.
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
                        applySyncedSettings({ customThemes: secondary.customThemes }, true)
                    }

                    if (Array.isArray(secondary.discoverFavorites)) {
                        try { localStorage.setItem('aio-discover-favorites', JSON.stringify(secondary.discoverFavorites)) } catch {}
                    }

                    if (secondary.discoverPrefs && typeof secondary.discoverPrefs === 'object') {
                        try { localStorage.setItem('aio-discover-prefs', JSON.stringify(secondary.discoverPrefs)) } catch {}
                    }

                    // An expected blob that could not be decoded leaves this pull
                    // incomplete: local display state above is preserved, but the
                    // rejection below keeps the push gate closed and the sync log
                    // shows the retry outcome instead of a clean success.
                    if (pullIncomplete) throw new Error(pullIncomplete)
                    } // end applySecondarySlices
                    // Deferred slices apply off the critical path; their outcome decides the
                    // push gate below. A failed hydration stays fail-closed: isInitialSyncCompleted
                    // remains false until a pull lands every slice, so a partially restored
                    // device can never push its partial view over the cloud copy.
                    applySecondarySlices()
                        .then(() => {
                            // The avatar decode failed while slices were still applying:
                            // the record was already downgraded; stay fail-closed.
                            if (avatarIncomplete) return
                            setHydration('ok')
                            hydrationOk = true
                            // The auth install may still be ahead of us (the avatar decode
                            // runs between the two): then the install itself opens the gate.
                            if (!authInstalled) return
                            if (!pullCurrent() || get().auth.id !== id || !get().auth.isAuthenticated) return
                            completePull()
                        })
                        .catch(err => {
                            setHydration('failed')
                            trace('sync', 'pull.hydration-failed', { accountId: id, isSilent, error: (err as Error).message })
                            // Superseded work logs nothing into the session that replaced it.
                            if (!pullCurrent()) return
                            console.warn('[Sync] deferred hydration failed:', err)
                            get().addLogEntry({ type: 'pull', status: 'error', message: `Deferred hydration failed: ${(err as Error).message}`, isAuto: isSilent })
                        })

                    // Identity is upgrade-only on pull: an empty name/avatar in the cloud
                    // (a stale push from another device) can never erase what this device has.
                    const identity = resolveCloudIdentity(syncData, id, get().auth)
                    const restoredName = identity.name
                    // Avatar out-of-band restore: the blob is the cloud's authoritative avatar.
                    // Absent blob (legacy push) keeps the upgrade-only local behavior.
                    let restoredAvatar = identity.avatar
                    {
                        const avatarBlob = avatarBlobWire
                        if (typeof avatarBlob === 'string' && avatarBlob) {
                            const decoded = await decodeSyncBlob(avatarBlob, responseKey)
                            if (decoded !== null) {
                                try {
                                    const parsed = JSON.parse(decoded) as unknown
                                    // Anything but a JSON string (object, null, number)
                                    // is an avatar slice this pull cannot restore: it
                                    // must block writes instead of being dropped.
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
                        // An expected cloud slice this device cannot read blocks writes:
                        // pushing would replace it with a payload missing that slice. The
                        // hydration may already have recorded ok (slices land while this
                        // decode runs), so downgrade the record; no 304 can then certify
                        // this pull, and the install below keeps the gate closed.
                        if (syncRuntime.hydration?.seq === pullToken) syncRuntime.hydration = { seq: pullToken, id, status: 'failed', kind: 'pull' }
                        if (pullCurrent()) {
                            console.warn('[Sync]', avatarIncomplete)
                            get().addLogEntry({ type: 'pull', status: 'error', message: `Deferred hydration failed: ${avatarIncomplete}`, isAuto: isSilent })
                        }
                    }
                    // A logout or a newer session during the avatar decode owns the store
                    // now: installing this session's identity would resurrect a signed-out
                    // state, so the whole tail stands down with the continuation.
                    if (!pullCurrent()) return
                    writeIdentityProfile(id, restoredName, restoredAvatar)
                    // Server-authoritative baseline: adopt the outer pull timestamp.
                    // When the server contract omits it (malformed/legacy), keep the
                    // previous baseline instead of fabricating a local clock that
                    // would reintroduce skew. The etag gate (completePull) still
                    // certifies the applied state, and the revision check on the
                    // next push (baseContentHash) guards real concurrent writes.
                    const pullSyncedAt = responseSyncedAt ?? get().lastSyncedAt
                    set({
                        auth: {
                            id,
                            password,
                            name: restoredName,
                            avatar: restoredAvatar,
                            isAuthenticated: true
                        },
                        ...(pullSyncedAt ? { lastSyncedAt: pullSyncedAt } : {}),
                        lastSyncCheckedAt: new Date().toISOString(),
                        lastSeenVersion: (syncData.lastSeenVersion as string | null) || get().lastSeenVersion,
                        // Opens immediately only when hydration already finished (it may
                        // settle on either side of this install) AND the avatar blob
                        // decoded; otherwise the deferred continuation opens it. The etag
                        // publishes with the gate, only after the pull fully applied.
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
                        setTimeout(() => get().syncToRemote(true), 1500)
                    }

                    get().addLogEntry({
                        type: 'pull',
                        status: 'success',
                        message: `Fetched cloud state. Decision: ${decision}`,
                        isAuto: isSilent
                    })
                    trace('sync', 'pull.success', { accountId: id, isSilent, decision, timing: Date.now() - pullStart })

                    if (!isSilent) {
                        toast({ title: "Login Successful", description: "Data loaded." })
                    }

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
                    // A superseded pull's failure belongs to the session that replaced
                    // it: no corrupt-restore retry, no namespace yank, no log entry or
                    // toast in the replacing session. The rethrown error still reaches
                    // this pull's own caller.
                    if (!ownership.current()) throw e
                    if ((e as Error & { corruptPayload?: boolean })?.corruptPayload && !syncRuntime.corruptRestoreInFlight) {
                        try {
                            const restoreRes = await resilientFetch(`${apiPath}/sync/${id}/restore`, {
                                method: 'POST',
                                headers: { 'x-sync-password': await deriveSyncToken(password) },
                                timeout: 15000,
                            })
                            if (restoreRes.ok) {
                                trace('sync', 'pull.corrupt-restored', { accountId: id })
                                // Retry from the true prior namespace so the inner login's
                                // own failure path restores the right workspace.
                                if (getActiveWorkspaceId() === id) setActiveWorkspace(priorWorkspace)
                                syncRuntime.corruptRestoreInFlight = true
                                try {
                                    return await get().login(id, password, isSilent, bypassGuard, deviceUnlock)
                                } finally {
                                    syncRuntime.corruptRestoreInFlight = false
                                }
                            }
                        } catch (restoreErr) {
                            if (import.meta.env.DEV) console.warn('[Sync] Cloud restore attempt failed:', restoreErr)
                        }
                    }
                    // Undo the namespace swap unless the flow already routed elsewhere
                    // (the deleted-workspace wipe lands on anon on purpose).
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
                    // Only the owning pull may clear the flag: a superseded pull's
                    // finally must not release the in-progress marker of the session
                    // that replaced it.
                    if (ownership.current()) set({ isSyncing: false })
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
                resetAccountsHydration()
                // Supersede every in-flight continuation and drop the hydration record:
                // nothing from the signed-out session may flip the gate, publish an etag,
                // or certify a later 304. The pull/mirror that loses ownership here no
                // longer clears isSyncing itself, so sign-out owns the flag reset.
                syncRuntime.pullSeq++
                syncRuntime.adoptedSeq = null
                syncRuntime.hydration = null
                postConflictMergeFor = null
                if (syncRuntime.syncDebounceTimer) { clearTimeout(syncRuntime.syncDebounceTimer); syncRuntime.syncDebounceTimer = null }
                if (syncRuntime.onlineHandler) { window.removeEventListener('online', syncRuntime.onlineHandler); syncRuntime.onlineHandler = null }
                if (syncRuntime.syncBC) { syncRuntime.syncBC.close(); syncRuntime.syncBC = null }
                clearSyncCredentialCaches()
                import('@/lib/device-session').then(({ deactivateDeviceAuth }) => deactivateDeviceAuth()).catch(() => {})
                import('@/lib/canonical-base').then(({ clearCanonicalBases }) => clearCanonicalBases()).catch(() => {})
                import('@/lib/pmdb-list-publisher').then(({ _invalidateAuthCache }) => _invalidateAuthCache()).catch(() => {})
                import('@/api/hydra-providers').then(({ _clearCanonicalCache }) => _clearCanonicalCache()).catch(() => {})
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
                // The wipe removed the notes index and blobs: the in-memory metas must
                // not survive claiming entries that no longer resolve, or the next
                // sign-in's import skips them on equal timestamps and the store stays
                // stranded empty.
                await import('@/store/notesStore').then(({ useNotesStore }) => useNotesStore.getState().resetLocal())
                // Drop the in-memory namespace after the wipe so late writes
                // cannot touch the signed-out workspace's backend.
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
                // Instead of dropping, we defer the sync so the *last* change always pushes
                if (isAuto) {
                    if (syncRuntime.syncDebounceTimer) clearTimeout(syncRuntime.syncDebounceTimer)
                    syncRuntime.syncDebounceTimer = setTimeout(() => {
                        syncRuntime.syncDebounceTimer = null
                        get().syncToRemote(false, true)
                    }, 1500)
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

                    const exportedAccounts = await useAccountStore.getState().exportAccountsForSync()
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
                        lastSyncedAccountCount: syncRuntime.lastSyncedAccountCount,
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
                    const mergedNotesTrash = mergeNotesTrash(notesState.trash, syncRuntime.lastPulledNotesTrash ?? [])
                    const identityFallback = readIdentityProfile()
                    const identityAvatarFallback = identityFallback.id === auth.id ? identityFallback.avatar : null

                    const watchExport = useWatchEventStore.getState().export()
                    // Watch history out-of-band: 986KB on real accounts rode the inner state,
                    // paying decrypt+parse+merge on every login. It ships as its own encrypted
                    // blob and rehydrates in the deferred phase; the inner state keeps the keys
                    // fleet-empty so legacy readers see an explicitly empty history.
                    const watchPayload = {
                        watchEvents: watchExport.events,
                        watchSnapshot: watchExport.snapshot,
                        watchEventRollups: watchExport.rollups,
                        deletedWatchEvents: mergeDeletedEventMaps(watchExport.deletedEvents, syncRuntime.lastPulledDeletedWatchEvents ?? {}),
                    }
                    const watchPayloadJson = JSON.stringify(watchPayload)
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
                        notes: filterNotesByTrash(localNotes.length === 0 && (syncRuntime.lastPulledNotes?.length ?? 0) > 0 ? syncRuntime.lastPulledNotes! : localNotes, mergedNotesTrash),
                        notesTrash: mergedNotesTrash,
                        watchEvents: [],
                        watchSnapshot: {},
                        watchEventRollups: undefined,
                        deletedWatchEvents: {},
                        salt: saltBase64,
                        name: auth.name,
                        // Avatar moved out-of-band (avatarBlob): a 100-300KB base64 image
                        // rode every push+pull. Captured below, encrypted with the same key.
                        avatar: null,
                        lastSeenVersion: get().lastSeenVersion,
                        customThemes: (() => { try { return JSON.parse(localStorage.getItem('aio-custom-themes') || '[]') } catch { return [] } })(),
                        discoverFavorites: (() => { try { return JSON.parse(localStorage.getItem('aio-discover-favorites') || '[]') } catch { return [] } })(),
                        discoverPrefs: (() => { try { return JSON.parse(localStorage.getItem('aio-discover-prefs') || '{}') } catch { return {} } })(),
                        profiles: useProfileStore.getState().profiles,
                        settings: readSyncedSettings(),
                    }

                    const avatarValue = auth.avatar ?? identityAvatarFallback ?? syncRuntime.lastPulledCloudAvatar ?? null

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
                    // Avatar + watch history participate in the change hash: edits to either
                    // still push even though neither rides the inner state anymore.
                    const stateHash = await computeHash(stringifiedState + '|' + (avatarValue ?? '') + '|' + watchPayloadJson)
                    ownership.assert()
                    if (!forceCanonicalRepublish && !forceFull && syncRuntime.lastPushedHash !== null && stateHash === syncRuntime.lastPushedHash) {
                        trace('sync', 'push.skip-unchanged', { accountId: auth.id, isAuto })
                        if (!isAuto && !isDebounced) {
                            get().addLogEntry({ type: 'push', status: 'success', message: 'No local changes to push - checking cloud.', isAuto: false })
                            setTimeout(() => { if (pushCurrent()) get().syncFromRemote(true).catch(() => {}) }, 0)
                        }
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
                    let encryptWithSameKey: ((plaintext: string) => Promise<string>) | null = null
                    if (auth.password) {
                        encryptedState = await encryptSyncPayload(compressedPayload, auth.password, syncSalt)
                        encryptWithSameKey = (plaintext) => encryptSyncPayload(plaintext, auth.password, syncSalt)
                    } else if (sessionCred) {
                        // Refreshed password-session: encrypt with the session-stored sync key
                        // (exported at login under the same syncSalt) — identical key material
                        // to the password path, and NOT a PBKDF2 of the empty password.
                        const { importSyncKey, encryptSyncPayloadWithKey } = await import('@/lib/crypto')
                        const sessionSyncKey = await importSyncKey(Uint8Array.from(atob(sessionCred.syncKey), c => c.charCodeAt(0)))
                        encryptedState = await encryptSyncPayloadWithKey(compressedPayload, sessionSyncKey)
                        encryptWithSameKey = (plaintext) => encryptSyncPayloadWithKey(plaintext, sessionSyncKey)
                    } else {
                        const deviceSyncKey = await getActiveDeviceSyncKey()
                        if (!deviceSyncKey) throw new Error('Remembered session lost its sync key. Sign in again.')
                        encryptedState = await import('@/lib/crypto').then(m => m.encryptSyncPayloadWithKey(compressedPayload, deviceSyncKey))
                        encryptWithSameKey = (plaintext) => import('@/lib/crypto').then(m => m.encryptSyncPayloadWithKey(plaintext, deviceSyncKey))
                    }

                    // Avatar out-of-band: its own encrypted blob on the body, so the 100-300KB
                    // base64 image stops riding the inner state on every push and pull.
                    // Blobs are deflated before encryption: uncompressed, the watch history
                    // blob made the stored envelope BIGGER than the legacy format.
                    let avatarBlob: string | undefined
                    if (avatarValue) {
                        try {
                            const deflated = await compressSyncPayload(JSON.stringify(avatarValue))
                            avatarBlob = await encryptWithSameKey!(deflated)
                        } catch { /* push without it rather than fail the sync */ }
                    }

                    // Watch history out-of-band: same pattern, bigger slice (~1MB plaintext).
                    let watchBlob: string | undefined
                    try {
                        const deflatedWatch = await compressSyncPayload(watchPayloadJson)
                        watchBlob = await encryptWithSameKey!(deflatedWatch)
                    } catch { /* push without it rather than fail the sync */ }

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
                    const res = await resilientFetch(`${apiPath}/sync/${auth.id}`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'x-sync-password': syncToken
                        },
                        body: JSON.stringify({
                            data: encryptedState,
                            isEncrypted: true,
                            compressed: isCompressed,
                            ...(avatarBlob ? { avatarBlob } : {}),
                            ...(watchBlob ? { watchBlob } : {}),
                            syncSalt: syncSaltB64,
                            syncedAt: get().lastSyncedAt,
                            // Revision base the server compares against its current
                            // content_hash. Unlike the wall-clock baseline above, it
                            // is immune to device clock skew and gives ms-level
                            // precision for rapid concurrent writes. Absent on first
                            // push / legacy snapshots: the server falls back to the
                            // timestamp guard for those.
                            baseContentHash: get().lastSyncedCloudEtag ?? undefined,
                            force: forcePush,
                            // Hash of the logical state (pre-syncedAt); lets the server skip the
                            // archive/rewrite/apiKeys churn when the content is byte-identical
                            // to what it already holds, since the envelope hash is IV-random.
                            contentHint: (forceCanonicalRepublish || forceFull) ? undefined : stateHash,
                            apiKeys: useAccountStore.getState().accounts.reduce<Record<string, string>>((map, a) => {
                                if (a.apiKey) map[a.id] = a.apiKey
                                return map
                            }, {}),
                            canonicalAddons: canonicalPayload,
                            emptiedHubs,
                        })
                    })
                    if (!pushCurrent()) return false

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

                    const resData = await res.text().then(t => { try { return JSON.parse(t) } catch { return {} } })
                    if (!pushCurrent()) return false

                    if (resData.conflict) {
                        if (import.meta.env.DEV) console.log('[Sync] Server reported conflict. Triggering pull.')
                        // Arm the post-conflict merge BEFORE the deferred pull: the
                        // next full pull for this account merges (preserving the
                        // rejected local work) instead of mirroring the winner.
                        postConflictMergeFor = auth.id
                        import('@/hooks/use-toast').then(({ toast }) => {
                            if (!pushCurrent()) return
                            toast({
                                variant: 'warning',
                                title: 'Cloud changed',
                                description: 'The cloud copy changed before this save completed. Pulling the latest state now.',
                            })
                        }).catch(() => {})
                        // Run after this push's finally releases its flag and lock;
                        // otherwise refreshFromCloud skips the pull as already syncing.
                        setTimeout(() => {
                            if (!pushCurrent()) return
                            get().refreshFromCloud().catch(e => { if (import.meta.env.DEV) console.error(e) })
                        }, 0)
                        return false
                    }

                    // Resolve completion helpers before publishing anything. Each import
                    // can yield to logout or a newer pull, just like the network response.
                    const [pushMetadata, canonicalBase] = await Promise.all([
                        import('@/store/account/accountImportExport').catch(() => null),
                        import('@/lib/canonical-base').catch(() => null),
                    ])
                    if (!pushCurrent()) return false
                    syncRuntime.lastPushedHash = stateHash
                    syncRuntime.lastSyncedAccountCount = accountCount
                    pushMetadata?.setLastPushedAt(Date.now())
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
                    canonicalBase?.setCanonicalBases(canonicalPayload)

                    // Server-authoritative push baseline: adopt the push response's
                    // server timestamp, never the local wall clock. A slow device
                    // clock stamping its own time here is the single-device
                    // self-conflict mechanism. When the contract omits the stamp,
                    // keep the previous baseline (etag still advances) instead of
                    // fabricating skew.
                    const pushSyncedAt = readServerSyncTimestamp(resData.syncedAt) ?? get().lastSyncedAt
                    // A confirmed push publishes the local work: any post-conflict
                    // arm for this account is resolved.
                    if (postConflictMergeFor === auth.id) postConflictMergeFor = null
                    set({ ...(pushSyncedAt ? { lastSyncedAt: pushSyncedAt } : {}), needsReauth: false, lastAppliedAccountCount: accountCount, lastAppliedAddonCount: addonCount })

                    get().addLogEntry({
                        type: 'push',
                        status: 'success',
                        message: 'Sync successful',
                        isAuto
                    })
                    trace('sync', 'push.success', { accountId: auth.id, isAuto, bytes: payloadBytes, compressed: isCompressed, timing: Date.now() - pushStart })
                    syncRuntime.pendingRetry = false
                    resetRepublishAttempts()

                    try {
                        const bc = new BroadcastChannel('aio-sync')
                        bc.postMessage({ type: 'sync-complete', timestamp: Date.now() })
                        bc.close()
                    } catch (e) { if (import.meta.env.DEV) console.error(e) }
                    return true
                } catch (e) {
                    if (!pushCurrent()) return false
                    const message = (e as Error).message
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
                // Credential availability is validated BEFORE the operation token is
                // allocated: a credential-less no-op must not consume a generation and
                // supersede an in-flight pull or login whose in-progress flag it would
                // never clean up. The device check awaits, so the identity context is
                // captured before it and re-verified after - a session that ended
                // mid-check stands down without touching any state.
                const sessionCred = getSessionSyncCredential(auth.id)
                if (!auth.password && !sessionCred) {
                    const readAuth = auth
                    const readWorkspace = getActiveWorkspaceId()
                    const readSeq = syncRuntime.pullSeq
                    if (!(await isDeviceSessionActive())) return
                    if (get().auth !== readAuth || getActiveWorkspaceId() !== readWorkspace || syncRuntime.pullSeq !== readSeq) return
                }
                // Ownership (workspace + a fresh monotonic operation token) is captured
                // BEFORE the first meaningful await, exactly like a pull: a mirror that
                // starts in one session must never resume into the one that replaced
                // it, and its token lives in the same generation space as pulls so a
                // login started mid-mirror supersedes it cleanly. An adoption slot
                // cannot outlive a mirror: mirroring replaces every slice wholesale.
                syncRuntime.adoptedSeq = null
                const mirrorToken = ++syncRuntime.pullSeq
                const ownership = captureSyncOwnership(mirrorToken)
                const fence = ownership.assert
                // Explicit mirror is an intentional wholesale replacement: it
                // clears any post-conflict merge arm for this account.
                if (postConflictMergeFor === auth.id) postConflictMergeFor = null
                set({ isSyncing: true })

                const apiPath = getSyncApiPath(serverUrl)

                // Set once the mirror is about to replace local slices: from that point a
                // failure leaves a mixed state whose prior etag must not be certified.
                let applicationStarted = false

                try {
                    const res = await resilientFetch(`${apiPath}/sync/${auth.id}`, {
                        headers: { 'x-sync-password': sessionCred?.token ?? await deriveSyncToken(auth.password) }
                    })

                    // A mirror whose session ended while its fetch was in flight owns
                    // nothing anymore: stand down before touching any state.
                    fence()

                    if (!res.ok) throw new Error(`Cloud Sync Server error (${res.status})`)

                    const text = await res.text()
                    const responseEtag = res.headers.get('etag')
                    let data: Record<string, unknown>
                    const raw = JSON.parse(text) as Record<string, unknown>
                    // Server-authoritative mirror timestamp, same domain as the pull
                    // path. Missing/invalid stamps keep the previous baseline.
                    const responseSyncedAt = readServerSyncTimestamp(raw.syncedAt)
                    fence()
                    const avatarBlobWire = typeof raw.avatarBlob === 'string' ? raw.avatarBlob : undefined
                    const watchBlobWire = typeof raw.watchBlob === 'string' ? raw.watchBlob : undefined
                    const remoteSyncSalt = raw.syncSalt && typeof raw.syncSalt === 'string'
                        ? Uint8Array.from(atob(raw.syncSalt), c => c.charCodeAt(0))
                        : undefined

                    // The winning inner-state key context: the blobs are sealed with the
                    // same key, so they decode with the exact branch that decrypted the
                    // envelope. Resolving them independently let a stale device or session
                    // credential win the blob decode over the credential that actually
                    // worked, silently skipping both blobs. Only a legacy plaintext pull
                    // (which ships no blobs) leaves the empty fallback in place.
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

                    // A mirror replaces local slices wholesale. Close write trust BEFORE
                    // any slice applies: from here on, a failure or partial decode leaves
                    // a mixed state that pushes must not extend and the old etag must not
                    // certify. Only a complete restore re-opens both.
                    applicationStarted = true
                    fence()
                    set({ isInitialSyncCompleted: false, lastSyncedCloudEtag: null })
                    syncRuntime.hydration = { seq: mirrorToken, id: auth.id, status: 'pending', kind: 'mirror' }

                    // Mirror is verbatim cloud: the out-of-band blobs carry the avatar and
                    // watch history on new-format pushes (the inner state ships them
                    // fleet-empty), so skipping them silently drops those slices. Legacy
                    // plaintext pulls carry no blobs, so the password fallback never fires
                    // for one that does.
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
                                // A decodable blob of the wrong SHAPE is an expected cloud
                                // slice this device cannot restore: the mirror is incomplete
                                // rather than silently applying garbage over the slice.
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
                                    // Decryptable but unreadable is still an expected cloud
                                    // slice this device cannot restore: the mirror is incomplete.
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

                    if (data.accounts) {
                        fence()
                        await useAccountStore.getState().importAccounts(data, true, 'mirror', undefined, ownership)
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
                        applySyncedSettings(data.settings as Record<string, unknown>, true)
                    }
                    if (data.notes && Array.isArray(data.notes)) {
                        fence()
                        const { useNotesStore } = await import('@/store/notesStore')
                        await useNotesStore.getState().importNotes(data.notes, ownership)
                        fence()
                        set({ lastSyncedNotesCount: data.notes.length })
                    }
                    if (Array.isArray(data.vault) || Array.isArray(data.vaultTombstones)) {
                        fence()
                        await useVaultStore.getState().initialize(ownership)
                        // Same initializer fence as the pull: initialize returns
                        // quietly on a lost session, so the tombstone publication
                        // into the shared runtime re-verifies first.
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
                        // A broken blob leaves this map fleet-empty: keep the previously-pulled
                        // tombstones instead of clobbering them.
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
                        applySyncedSettings({ customThemes: data.customThemes }, true)
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

                    // Adopt the server timestamp; never stamp the local clock here.
                    // A superseded mirror owns nothing (fence above), so this write
                    // only lands for the owning session. Missing stamps keep the
                    // previous baseline instead of fabricating skew.
                    {
                        const mirrorSyncedAt = responseSyncedAt ?? get().lastSyncedAt
                        if (mirrorSyncedAt) set({ lastSyncedAt: mirrorSyncedAt })
                    }

                    // An expected blob that could not be decoded makes the mirror
                    // incomplete: writes stay disabled and the etag stays cleared, so the
                    // next refresh re-fetches in full instead of a 304 certifying the mix.
                    // Only a complete restore re-opens write trust. Both outcomes write
                    // only their own record slot and only while this mirror still owns
                    // the session.
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
                    // A superseded mirror owns nothing anymore: no trust writes, no log
                    // entry or toast in the session that replaced it.
                    if (!ownership.current()) return
                    const msg = (e as Error).message
                    // A failure after the application boundary may have replaced some
                    // slices already: keep the mixed state uncertified (the gate and etag
                    // were closed at the boundary). Earlier failures (network, decrypt)
                    // changed nothing and keep their prior trust.
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
                    // Only the owning mirror may clear the flag: a superseded mirror's
                    // finally must not release the in-progress marker of the session
                    // that replaced it.
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
                        headers: { 'x-sync-password': getSessionSyncCredential(auth.id)?.token ?? await deriveSyncToken(auth.password) }
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
                postConflictMergeFor = null
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
                serverUrl: state.serverUrl,
                lastActionTimestamp: state.lastActionTimestamp,
                lastSeenVersion: state.lastSeenVersion,
                syncSaltB64: state.syncSaltB64,
                lastSyncedCloudEtag: state.lastSyncedCloudEtag,
                lastSyncedNotesCount: state.lastSyncedNotesCount,
                lastAppliedAccountCount: state.lastAppliedAccountCount,
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
