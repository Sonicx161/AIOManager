import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { v4 as uuidv4 } from 'uuid'

import { useAccountStore } from './accountStore'
import { useAddonStore } from './addonStore'
import { useProfileStore } from './profileStore'
import { useFailoverStore } from './failoverStore'
import { useAuthStore } from './authStore'
import { useVaultStore } from './vaultStore'
import { toast } from '@/hooks/use-toast'
import { deriveSyncToken } from '@/lib/crypto'
import { resilientFetch } from '@/lib/api-resilience'

// Suppress toasts during initial boot to prevent React "state update on unmounted component" warnings
let _appReady = false
setTimeout(() => { _appReady = true }, 3000)

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
        isAuthenticated: boolean
    }
    serverUrl: string
    lastSyncedAt: string | null
    isSyncing: boolean
    isRefreshingFromCloud: boolean  // true only during the post-unlock pull — separate from write syncs
    isInitialSyncCompleted: boolean // Safety flag to prevent stale devices from pushing before they've pulled
    lastActionTimestamp: number
    lastSeenVersion: string | null
    _syncDebounceTimer: any // Internal use only, not persisted
    history: SyncHistoryEntry[]
    // Actions
    setLastSeenVersion: (version: string) => void
    register: (password: string, name?: string) => Promise<void>
    login: (id: string, password: string, isSilent?: boolean, bypassGuard?: boolean) => Promise<void>
    logout: () => void
    syncToRemote: (isAuto?: boolean, isDebounced?: boolean) => Promise<void>
    syncFromRemote: (isSilent?: boolean) => Promise<void>
    refreshFromCloud: () => Promise<void>
    forcePushState: () => Promise<void>
    forceMirrorState: () => Promise<void>
    setServerUrl: (url: string) => void
    setDisplayName: (name: string) => void
    deleteRemoteAccount: () => Promise<void>
    reset: () => void
}

const DEFAULT_SERVER = '/api'

export const useSyncStore = create<SyncState>()(
    persist(
        (set, get) => ({
            auth: {
                id: '',
                password: '',
                name: '',
                isAuthenticated: false
            },
            serverUrl: '',
            lastSyncedAt: null,
            isSyncing: false,
            isRefreshingFromCloud: false,
            isInitialSyncCompleted: false, // Reset on every boot or logout
            lastActionTimestamp: 0,
            lastSeenVersion: null,
            _syncDebounceTimer: null,
            history: [],

            setLastSeenVersion: (version: string) => {
                set({ lastSeenVersion: version })
                get().syncToRemote(true).catch(console.error)
            },

            addLogEntry: (data: Omit<SyncHistoryEntry, 'id' | 'timestamp'>) => {
                const entry: SyncHistoryEntry = {
                    ...data,
                    id: uuidv4(),
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
                // Immediate sync
                get().syncToRemote(true).catch(console.error)
            },

            // Helper to manually trigger a pull (useful for re-hydration)
            syncFromRemote: async (isSilent: boolean = true) => {
                const { auth } = get()
                if (!auth.isAuthenticated) return
                // Reuse login logic which performs the fetch & merge
                await get().login(auth.id, auth.password, isSilent)
            },

            /**
             * Post-unlock pull: fetches latest cloud state unconditionally.
             * Unlike syncFromRemote(), this bypasses the isSyncing guard because
             * isSyncing protects write/push operations, not read pulls.
             * Sets isRefreshingFromCloud for UI feedback.
             */
            refreshFromCloud: async () => {
                const { auth, isSyncing } = get()
                if (!auth.isAuthenticated || !auth.id || !auth.password) return

                // Safety: Don't trigger if already syncing or if we haven't even finished basic initialization
                if (isSyncing) return

                set({ isRefreshingFromCloud: true })
                try {
                    // This call might throw if decryption fails (e.g. wrong password or corrupt data)
                    await get().login(auth.id, auth.password, true, true)
                    set({ isInitialSyncCompleted: true })
                } catch (e) {
                    console.error('[Sync] Post-unlock cloud refresh failed:', e)
                    // Only show alert if it's NOT a silent failure (decryption/auth issues are never silent)
                    const message = e instanceof Error ? e.message : 'Unknown sync error'
                    if (message.toLowerCase().includes('decrypt') || message.toLowerCase().includes('password')) {
                        toast({
                            variant: 'destructive',
                            title: 'Sync Error',
                            description: message
                        })
                    } else {
                        // Generic network/server failure - less alarming
                        toast({
                            variant: 'destructive',
                            title: 'Refresh Failed',
                            description: 'Could not reach sync server. Using local data.'
                        })
                    }
                } finally {
                    set({ isRefreshingFromCloud: false })
                }
            },

            register: async (password: string, name: string = '') => {
                // Generate new Identity
                const newId = uuidv4()
                const { serverUrl } = get()
                const baseUrl = serverUrl || DEFAULT_SERVER

                // We perform an initial specific sync to "Claim" the ID
                // In this model, we just save the empty state (or default state) to the server
                // to establish the password.

                // For v1, we assume success if we can generate it locally. 
                // The first 'syncToRemote' will actually write it to DB.
                // But to be safe/correct, let's write an empty init state.

                try {
                    const apiPath = baseUrl.startsWith('http') ? `${baseUrl}/api` : baseUrl
                    const { loadSalt } = await import('@/lib/crypto')
                    const salt = loadSalt()
                    const saltBase64 = salt ? btoa(String.fromCharCode(...salt)) : undefined

                    const emptyState = {
                        accounts: [],
                        addons: { version: '1.0', savedAddons: [] },
                        profiles: [],
                        failover: [],
                        salt: saltBase64,
                        syncedAt: new Date().toISOString()
                    }

                    const res = await resilientFetch(`${apiPath}/sync/${newId}`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'x-sync-password': await deriveSyncToken(password)
                        },
                        body: JSON.stringify(emptyState)
                    })

                    if (!res.ok) throw new Error("Failed to register account on server.")

                    // Parity Fix: Also initialize the local Master Password using the same password
                    // This ensures local storage (IndexedDB) encryption key is ready immediately.
                    try {
                        await useAuthStore.getState().setupMasterPassword(password)
                    } catch (e) {
                        console.error("Local password setup during sync registration failed:", e)
                    }

                    set({
                        auth: { id: newId, password, name, isAuthenticated: true },
                        lastSyncedAt: new Date().toISOString()
                    })

                    // Set flag to show post-login reminder (Since the registration dialog is hidden too fast)
                    localStorage.setItem('aiom_show_sync_id_reminder', 'true')

                    toast({ title: "Account Created", description: "Welcome to AIOManager." })
                } catch (e) {
                    toast({ variant: "destructive", title: "Registration Failed", description: (e as Error).message })
                    throw e
                }
            },

            login: async (id: string, password: string, isSilent: boolean = false, bypassGuard: boolean = false) => {
                if (get().isSyncing && !bypassGuard) return
                set({ isSyncing: true })
                const { serverUrl } = get()
                const baseUrl = serverUrl || DEFAULT_SERVER
                const apiPath = baseUrl.startsWith('http') ? `${baseUrl}/api` : baseUrl

                try {
                    const res = await resilientFetch(`${apiPath}/sync/${id}`, {
                        headers: { 'x-sync-password': await deriveSyncToken(password) }
                    })

                    if (res.status === 401) throw new Error("Incorrect Password. If you've forgotten it, you may need to reset your account.")
                    if (res.status === 404) throw new Error("Cloud Account not found. Please check the ID or Register a new one.")
                    if (!res.ok) throw new Error(`Cloud Sync Server error (${res.status}). Please try again later.`)

                    const text = await res.text()
                    if (!text || text.trim() === "") {
                        throw new Error("Server returned an empty response. Your data might not be initialized yet.")
                    }

                    if (text.includes('[object Object]')) {
                        console.warn("[Sync] Server returned '[object Object]'. Treating as corrupted/empty.")
                        throw new Error("Server returned corrupted data ([object Object]). Please reset your account.")
                    }

                    let data: any
                    try {
                        const raw = JSON.parse(text)
                        // Encryption Support (Privacy Update)
                        if (raw.isEncrypted && raw.data) {
                            const { AES, enc } = await import('crypto-js')
                            const bytes = AES.decrypt(raw.data, password)
                            const decryptedStr = bytes.toString(enc.Utf8)

                            if (!decryptedStr) throw new Error("Decryption failed. Wrong password or corrupted cloud data.")

                            // Ultra-Resilience: Attempt parsing first, don't just nuke everything on a partial match
                            try {
                                data = JSON.parse(decryptedStr)

                                // Post-Parse Check: If it PARSED into a literal string "[object Object]", then it's bad.
                                // But if it's a valid object that happens to CONTAIN that string somewhere, we keep it.
                                if (data === '[object Object]') {
                                    console.warn('[Sync] Decrypted data IS "[object Object]". Discarding.')
                                    data = {}
                                }
                            } catch (parseErr) {
                                console.error('[Sync] Parsing failed for decrypted string. Length:', decryptedStr.length)
                                // Only logic to rescue if it WAS a double-serialized object? 
                                // No, standard parse error handling is safer.
                                throw parseErr // Let the outer catch handle it (which prompts wrong password)
                            }
                        } else {
                            // Legacy: Plain text
                            data = raw
                        }

                        // Final Sanity Check: Ensure all components are what we expect
                        data = {
                            accounts: data?.accounts || [], // Support direct array or object
                            addons: data?.addons || { version: '1.0', savedAddons: [] },
                            profiles: Array.isArray(data?.profiles) ? data.profiles : [],
                            failover: data?.failover || [],
                            vault: data?.vault || [],
                            salt: data?.salt,
                            name: data?.name,
                            syncedAt: data?.syncedAt,
                            lastSeenVersion: data?.lastSeenVersion || null
                        }

                    } catch (e) {
                        console.error("[Sync] Decryption/Parsing Error:", e)
                        // If it's a JSON parse error (likely from getting HTML instead of JSON), show a better message
                        if (e instanceof SyntaxError) {
                            throw new Error("Invalid server response. Please make sure the backend is running correctly.")
                        }
                        throw new Error("Failed to decrypt cloud data. Please verify your password.")
                    }

                    // 1. Extract salt and unlock app first
                    // This creates the encryptionKey needed for AccountStore imports
                    let saltToUse = data.salt
                    if (!saltToUse) {
                        // Fallback to local salt for users who haven't pushed their salt to cloud yet
                        const { loadSalt } = await import('@/lib/crypto')
                        const localSalt = loadSalt()
                        if (localSalt) {
                            saltToUse = btoa(String.fromCharCode(...localSalt))
                        }
                    }

                    if (saltToUse) {
                        try {
                            await useAuthStore.getState().unlockFromSync(password, saltToUse)
                        } catch (e) {
                            console.error("Failed to unlock from sync:", e)
                            if (!isSilent) {
                                throw new Error("Could not unlock app with this password. (Encryption Mismatch)")
                            }
                        }
                    }

                    // 2. Import Data: Timestamp Conflict Resolution
                    const localLastSync = get().lastSyncedAt
                    const remoteLastSync = data.syncedAt

                    const remoteTime = remoteLastSync ? new Date(remoteLastSync).getTime() : 0
                    const localTime = localLastSync ? new Date(localLastSync).getTime() : 0

                    const isRemoteNewer = remoteTime > localTime
                    const isLocalNewer = localTime > remoteTime
                    const isEqual = remoteTime === localTime

                    let decision = 'passive merge'

                    if (data.accounts) {
                        const localAccounts = useAccountStore.getState().accounts
                        // Handle potential array vs object wrapper (legacy compatibility)
                        const remoteAccountsRaw = Array.isArray(data.accounts) ? data.accounts : (data.accounts as any)?.accounts || []
                        const remoteAccounts = remoteAccountsRaw as any[]

                        const hasRemoteData = remoteAccounts.length > 0
                        const hasLocalData = localAccounts.length > 0

                        // SIMPLIFIED SYNC: Source of Truth Model
                        // We compare timestamps. Newest timestamp is the 1:1 state.
                        if (!hasRemoteData && hasLocalData) {
                            decision = 'Seed Cloud (local data exists, cloud is empty)'
                            // Seed the cloud with local data
                            await useAccountStore.getState().importAccounts(JSON.stringify(data), true, 'merge')
                            setTimeout(() => get().syncToRemote(true), 1500)
                        } else if (isLocalNewer) {
                            decision = 'Push Local (local is newer)'
                            // Keep local, push to remote
                            setTimeout(() => get().syncToRemote(true), 1500)
                        } else if (isEqual) {
                            decision = 'Synchronized'
                        } else {
                            // Remote is newer OR both empty -> MIRROR
                            decision = 'Mirror Cloud (cloud is source of truth)'
                            await useAccountStore.getState().importAccounts(JSON.stringify(data), true, 'mirror')
                        }
                    }

                    if (data.addons) {
                        const localAddons = Object.keys(useAddonStore.getState().library).length
                        const remoteAddons = Array.isArray(data.addons) ? data.addons : (data.addons as any)?.savedAddons || []

                        if ((!remoteAddons || remoteAddons.length === 0) && localAddons > 0) {
                            console.warn(`[Sync] Remote has 0 addons (Safety net triggered). Switching to MERGE + PUSH.`)
                            await useAddonStore.getState().importLibrary(data, true, false, true)
                            setTimeout(() => get().syncToRemote(true), 1500)
                        } else if (isLocalNewer) {
                            console.log("[Sync] Local addons are fresher. Merging & Pushing.")
                            await useAddonStore.getState().importLibrary(data, true, false, true)
                            // Force push to update the stale server
                            setTimeout(() => get().syncToRemote(true), 2000)
                        } else if (isEqual) {
                            console.log("[Sync] Addons synchronized. Passive import.")
                            await useAddonStore.getState().importLibrary(data, true, true, true)
                        } else {
                            // Mirror
                            await useAddonStore.getState().importLibrary(data, false, true, true)
                        }
                        await useAddonStore.getState().initialize()
                    }
                    if (data.profiles && Array.isArray(data.profiles)) {
                        await useProfileStore.getState().importProfiles(data.profiles)
                    }
                    if (data.failover) {
                        if (Array.isArray(data.failover)) {
                            // Legacy format: just rules
                            await useFailoverStore.getState().importRules(data.failover, isRemoteNewer ? 'mirror' : 'merge', true)
                        } else if (typeof data.failover === 'object') {
                            // New format: { rules, webhook }
                            const strategy = isRemoteNewer ? 'mirror' : 'merge'
                            if (data.failover.rules) await useFailoverStore.getState().importRules(data.failover.rules, strategy, true)
                            if (data.failover.webhook) {
                                await useFailoverStore.getState().importWebhook(data.failover.webhook, true)
                            }
                        }
                    }

                    if (data.vault) {
                        const { useVaultStore } = await import('./vaultStore')
                        await useVaultStore.getState().importVault(data.vault)
                    }

                    set({
                        auth: { id, password, name: data.name || '', isAuthenticated: true },
                        lastSyncedAt: data.syncedAt || new Date().toISOString(),
                        lastSeenVersion: data.lastSeenVersion || get().lastSeenVersion
                    })

                        ; (get() as any).addLogEntry({
                            type: remoteTime === 0 ? 'pull' : 'pull',
                            status: 'success',
                            message: `Fetched cloud state. Decision: ${decision}`,
                            isAuto: isSilent
                        })

                    if (!isSilent) {
                        toast({ title: "Login Successful", description: "Your data has been loaded." })
                    }
                } catch (e) {
                    const msg = (e as Error).message
                        ; (get() as any).addLogEntry({
                            type: 'pull',
                            status: 'error',
                            message: `Pull Failed: ${msg}`,
                            isAuto: isSilent
                        })
                    if (!isSilent) {
                        toast({ variant: "destructive", title: "Login Failed", description: msg })
                    }
                    throw e
                } finally {
                    set({ isSyncing: false })
                }
            },

            logout: async () => {
                set({
                    auth: { id: '', password: '', name: '', isAuthenticated: false },
                    lastSyncedAt: null
                })

                // Clear ALL local data on logout to prevent state leakage
                await Promise.all([
                    useAccountStore.getState().reset(),
                    useAddonStore.getState().reset(),
                    useProfileStore.getState().reset?.(),
                    useFailoverStore.getState().reset?.()
                ])

                toast({ title: "Logged Out", description: "See you next time." })
            },

            syncToRemote: async (isAuto: boolean = false, isDebounced: boolean = false) => {
                const { auth, serverUrl, isSyncing, isInitialSyncCompleted } = get()
                const { isLocked } = useAuthStore.getState()
                if (!auth.isAuthenticated || isSyncing || isLocked) return

                // SAFETY LOCK: If we haven't successfully synced FROM the cloud yet, 
                // we are NOT allowed to sync TO the cloud. This prevents stale clients 
                // from overwriting the source of truth with their old local state.
                if (isAuto && !isInitialSyncCompleted) {
                    console.log("[Sync] Skipping auto-push: Initial pull not yet completed (Source of Truth Protection)")
                    return
                }

                set({ isSyncing: true })

                // Server Protection: Strict Debounce check for auto-syncs
                // Instead of dropping, we defer the sync so the *last* change always pushes
                if (isAuto) {
                    if (get()._syncDebounceTimer) clearTimeout(get()._syncDebounceTimer)
                    const timer = setTimeout(() => {
                        set({ _syncDebounceTimer: null })
                        get().syncToRemote(false, true) // Fire actual real sync, marked as debounced
                    }, 1500)
                    set({ _syncDebounceTimer: timer, isSyncing: false })
                    return
                }

                (get() as any).addLogEntry({
                    type: isAuto ? 'push' : 'push',
                    status: 'success', // Provisional, updated on error
                    message: isAuto ? 'Auto-sync started' : 'Manual push started',
                    isAuto
                })

                set({ lastActionTimestamp: Date.now() })
                const baseUrl = serverUrl || DEFAULT_SERVER
                const apiPath = baseUrl.startsWith('http') ? `${baseUrl}/api` : baseUrl

                try {
                    const { loadSalt } = await import('@/lib/crypto')
                    const salt = loadSalt()
                    const saltBase64 = salt ? btoa(String.fromCharCode(...salt)) : undefined

                    // Standardize: Ensure all exported components are objects before final stringification
                    const rawAccounts = await useAccountStore.getState().exportAccounts(true)
                    const rawAddons = useAddonStore.getState().exportLibrary()

                    const safeParse = (val: any) => {
                        if (!val) return {}
                        if (typeof val === 'object') return val
                        if (typeof val === 'string') {
                            if (val.includes('[object Object]')) {
                                console.warn(`[Sync] Discarding corrupted data checking for [object Object]`)
                                return {}
                            }
                            try {
                                return JSON.parse(val)
                            } catch (e) {
                                console.error(`[Sync] Failed to parse exported data:`, val.substring(0, 50))
                                return {}
                            }
                        }
                        return {}
                    }

                    const state = {
                        accounts: safeParse(rawAccounts),
                        addons: safeParse(rawAddons),
                        profiles: useProfileStore.getState().profiles,
                        failover: {
                            rules: useFailoverStore.getState().rules,
                            webhook: useFailoverStore.getState().webhook
                        },
                        vault: useVaultStore.getState().keys,
                        salt: saltBase64,
                        name: auth.name,
                        syncedAt: new Date().toISOString(),
                        lastSeenVersion: get().lastSeenVersion
                    }

                    const { AES } = await import('crypto-js')
                    const stringifiedState = JSON.stringify(state)

                    if (stringifiedState === '[object Object]') {
                        throw new Error('Sync corruption detected: State is not an object.')
                    }

                    const encryptedState = AES.encrypt(stringifiedState, auth.password).toString()

                    const res = await resilientFetch(`${apiPath}/sync/${auth.id}`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'x-sync-password': await deriveSyncToken(auth.password)
                        },
                        body: JSON.stringify({ data: encryptedState, isEncrypted: true })
                    })

                    if (!res.ok) {
                        const errorData = await res.json().catch(() => ({}))
                        throw new Error(errorData.message || `Server Error: ${res.status}`)
                    }

                    const resData = await res.json()

                    // TRUST THE SERVER CLOCK (Fixes Clock Drift)
                    // If server returns a timestamp, use it. Fallback to local only if missing.
                    const serverTime = resData.syncedAt
                    if (serverTime) {
                        set({ lastSyncedAt: serverTime })
                        console.log(`[Sync] Synced with server clock: ${serverTime}`)
                    } else {
                        set({ lastSyncedAt: new Date().toISOString() })
                    }

                    (get() as any).addLogEntry({
                        type: 'push',
                        status: 'success',
                        message: 'Sync successful',
                        isAuto
                    })

                    if (!isAuto && !isDebounced && _appReady) {
                        // Removed repetitive "Saved" toast notification as requested by users.
                        // The top-right Cloud Sync header icon already provides this feedback natively.
                    }
                } catch (e) {
                    const message = (e as Error).message
                    console.error("Sync error:", apiPath, e)
                        ; (get() as any).addLogEntry({
                            type: 'push',
                            status: 'error',
                            message: `Push Failed: ${message}`,
                            isAuto
                        })
                    if (!isAuto && !isDebounced && _appReady) {
                        toast({ variant: "destructive", title: "Save Failed", description: message })
                    }
                } finally {
                    set({ isSyncing: false })
                }
            },

            forcePushState: async () => {
                const { auth } = get()
                if (!auth.isAuthenticated) return

                // 1. Artificially inflate the local timestamp to ensure server accepts it
                set({ lastActionTimestamp: Date.now() + 10000 })

                    // 2. Add log entry
                    ; (get() as any).addLogEntry({
                        type: 'force-push',
                        status: 'success',
                        message: 'Force push initiated (timestamp inflated)',
                        isAuto: false
                    })

                // 3. Trigger standard sync
                await get().syncToRemote(false)
            },

            forceMirrorState: async () => {
                const { auth, serverUrl } = get()
                if (!auth.isAuthenticated) return
                set({ isSyncing: true })

                const baseUrl = serverUrl || DEFAULT_SERVER
                const apiPath = baseUrl.startsWith('http') ? `${baseUrl}/api` : baseUrl

                try {
                    const res = await resilientFetch(`${apiPath}/sync/${auth.id}`, {
                        headers: { 'x-sync-password': await deriveSyncToken(auth.password) }
                    })

                    if (!res.ok) throw new Error(`Cloud Sync Server error (${res.status})`)

                    const text = await res.text()
                    let data: any
                    const raw = JSON.parse(text)

                    if (raw.isEncrypted && raw.data) {
                        const { AES, enc } = await import('crypto-js')
                        const bytes = AES.decrypt(raw.data, auth.password)
                        const decryptedStr = bytes.toString(enc.Utf8)
                        if (!decryptedStr) throw new Error("Decryption failed")
                        data = JSON.parse(decryptedStr)
                    } else {
                        data = raw
                    }

                    // Strict Mirror: No timestamp comparisons
                    if (data.accounts) {
                        await useAccountStore.getState().importAccounts(JSON.stringify(data), true, 'mirror')
                    }
                    if (data.addons) {
                        await useAddonStore.getState().importLibrary(data, false, true)
                        await useAddonStore.getState().initialize()
                    }
                    if (data.profiles && Array.isArray(data.profiles)) {
                        await useProfileStore.getState().importProfiles(data.profiles)
                    }
                    if (data.failover) {
                        const strategy = 'mirror'
                        if (Array.isArray(data.failover)) {
                            await useFailoverStore.getState().importRules(data.failover, strategy, true)
                        } else if (typeof data.failover === 'object') {
                            if (data.failover.rules) await useFailoverStore.getState().importRules(data.failover.rules, strategy, true)
                            if (data.failover.webhook) await useFailoverStore.getState().importWebhook(data.failover.webhook, true)
                        }
                    }

                    set({ lastSyncedAt: data.syncedAt || new Date().toISOString() })

                        ; (get() as any).addLogEntry({
                            type: 'force-mirror',
                            status: 'success',
                            message: 'Cloud state mirrored verbatim (bypassed merge)',
                            isAuto: false
                        })

                    toast({ title: "Mirror Complete", description: "Local state replaced by cloud data." })
                } catch (e) {
                    const msg = (e as Error).message
                    toast({ variant: "destructive", title: "Mirror Failed", description: msg })
                        ; (get() as any).addLogEntry({
                            type: 'force-mirror',
                            status: 'error',
                            message: `Mirror Failed: ${msg}`,
                            isAuto: false
                        })
                } finally {
                    set({ isSyncing: false })
                }
            },




            deleteRemoteAccount: async () => {
                const { auth, serverUrl } = get()
                if (!auth.isAuthenticated) return
                const baseUrl = serverUrl || DEFAULT_SERVER
                const apiPath = baseUrl.startsWith('http') ? `${baseUrl}/api` : baseUrl

                const res = await resilientFetch(`${apiPath}/sync/${auth.id}`, {
                    method: 'DELETE',
                    headers: { 'x-sync-password': await deriveSyncToken(auth.password) }
                })

                if (!res.ok) throw new Error("Failed to delete account from server")
                get().logout()
            },

            reset: () => {
                set({
                    auth: { id: '', password: '', name: '', isAuthenticated: false },
                    serverUrl: '',
                    lastSyncedAt: null,
                    isSyncing: false,
                    isRefreshingFromCloud: false,
                    lastActionTimestamp: 0
                })
            }
        }),
        {
            name: 'stremio-manager-sync',
            storage: createSafeStorage(),
            partialize: (state) => ({
                auth: state.auth,
                lastSyncedAt: state.lastSyncedAt,
                serverUrl: state.serverUrl,
                lastActionTimestamp: state.lastActionTimestamp,
                lastSeenVersion: state.lastSeenVersion
            }),
        }
    )
)
import { createSafeStorage } from './safe-storage'
