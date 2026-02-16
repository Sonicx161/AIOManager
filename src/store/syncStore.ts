import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { useAccountStore } from './accountStore'
import { useAddonStore } from './addonStore'
import { useProfileStore } from './profileStore'
import { useFailoverStore } from './failoverStore'
import { useAuthStore } from './authStore'
import { v4 as uuidv4 } from 'uuid'
import { toast } from '@/hooks/use-toast'
import { deriveSyncToken } from '@/lib/crypto'
import { resilientFetch } from '@/lib/api-resilience'

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
    lastActionTimestamp: number
    // Actions
    register: (password: string, name?: string) => Promise<void>
    login: (id: string, password: string, isSilent?: boolean) => Promise<void>
    logout: () => void
    syncToRemote: (isAuto?: boolean) => Promise<void>
    syncFromRemote: (isSilent?: boolean) => Promise<void>
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
            lastActionTimestamp: 0,

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

                    toast({ title: "Account Created", description: "Welcome to AIOManager." })
                } catch (e) {
                    toast({ variant: "destructive", title: "Registration Failed", description: (e as Error).message })
                    throw e
                }
            },

            login: async (id: string, password: string, isSilent: boolean = false) => {
                if (get().isSyncing) return
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
                            salt: data?.salt,
                            name: data?.name,
                            syncedAt: data?.syncedAt
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

                    if (data.accounts) {
                        const localAccounts = useAccountStore.getState().accounts
                        // Handle potential array vs object wrapper (legacy compatibility)
                        const remoteAccountsRaw = Array.isArray(data.accounts) ? data.accounts : (data.accounts as any)?.accounts || []
                        const remoteAccounts = remoteAccountsRaw as any[]

                        const hasRemoteData = remoteAccounts.length > 0
                        const hasLocalData = localAccounts.length > 0

                        // ANTI-WIPE GUARD:
                        // If remote is Empty, we NEVER Mirror. We treat it as "Server Needs Healing".
                        // This overrides timestamp logic.
                        if (!hasRemoteData && hasLocalData) {
                            console.warn("[Sync] Anti-Wipe Triggered: Remote is empty. Pushing Local state.")
                            await useAccountStore.getState().importAccounts(JSON.stringify(data), true, 'merge')
                            setTimeout(() => get().syncToRemote(true), 1500)
                        } else if (isLocalNewer) {
                            // Local changes are strictly newer.
                            console.log("[Sync] Local state is fresher. Merging remote changes safely & Pushing.")
                            await useAccountStore.getState().importAccounts(JSON.stringify(data), true, 'merge')
                            // Force push to update the stale server
                            setTimeout(() => get().syncToRemote(true), 2000)
                        } else if (isEqual) {
                            // Perfect Sync. Passive Merge (Just in case).
                            console.log("[Sync] State is synchronized. Passive merge.")
                            await useAccountStore.getState().importAccounts(JSON.stringify(data), true, 'merge')
                        } else {
                            // Remote is newer.
                            if (hasRemoteData) {
                                console.log("[Sync] Remote is newer. Mirroring cloud state.")
                                await useAccountStore.getState().importAccounts(JSON.stringify(data), true, 'mirror')
                            } else {
                                console.warn("[Sync] Remote is newer but EMPTY? Passive merging instead of mirroring to avoid wipe.")
                                await useAccountStore.getState().importAccounts(JSON.stringify(data), true, 'merge')
                            }
                        }
                    }

                    if (data.addons) {
                        const localAddons = Object.keys(useAddonStore.getState().library).length
                        const remoteAddons = Array.isArray(data.addons) ? data.addons : (data.addons as any)?.savedAddons || []

                        if ((!remoteAddons || remoteAddons.length === 0) && localAddons > 0) {
                            console.warn(`[Sync] Remote has 0 addons (Safety net triggered). Switching to MERGE + PUSH.`)
                            await useAddonStore.getState().importLibrary(data, true)
                            setTimeout(() => get().syncToRemote(true), 1500)
                        } else if (isLocalNewer) {
                            console.log("[Sync] Local addons are fresher. Merging & Pushing.")
                            await useAddonStore.getState().importLibrary(data, true)
                            // Force push to update the stale server
                            setTimeout(() => get().syncToRemote(true), 2000)
                        } else if (isEqual) {
                            console.log("[Sync] Addons synchronized. Passive import.")
                            await useAddonStore.getState().importLibrary(data, true, true)
                        } else {
                            // Mirror
                            await useAddonStore.getState().importLibrary(data, false, true)
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

                    set({
                        auth: {
                            id,
                            password,
                            name: data.name || '',
                            isAuthenticated: true
                        },
                        lastSyncedAt: data.syncedAt || new Date().toISOString()
                    })

                    if (!isSilent) {
                        toast({ title: "Login Successful", description: "Your data has been loaded." })
                    }
                } catch (e) {
                    if (!isSilent) {
                        toast({ variant: "destructive", title: "Login Failed", description: (e as Error).message })
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

            syncToRemote: async (isAuto: boolean = false) => {
                const { auth, serverUrl, isSyncing } = get()
                const { isLocked } = useAuthStore.getState()
                if (!auth.isAuthenticated || isSyncing || isLocked) return

                set({ isSyncing: true })

                // Server Protection: Debounce check
                const now = Date.now()
                const lastSync = get().lastActionTimestamp
                const COOLDOWN = 1000 // 1 second minimum between syncs

                if (isAuto && now - lastSync < COOLDOWN) {
                    set({ isSyncing: false })
                    return
                }

                set({ lastActionTimestamp: now })
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
                        salt: saltBase64,
                        name: auth.name,
                        syncedAt: new Date().toISOString()
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

                    if (!isAuto) {
                        toast({ title: "Saved", description: "Changes saved to cloud." })
                    }
                } catch (e) {
                    const message = (e as Error).message
                    const isNetworkError = message === 'Failed to fetch' || (typeof message === 'string' && message.includes('Failed to reach server'))

                    if (!isAuto) {
                        toast({
                            variant: "destructive",
                            title: "Save Failed",
                            description: isNetworkError
                                ? `Check your connection. App could not reach ${apiPath}`
                                : message
                        })
                    }
                    console.error("Sync error:", apiPath, e)
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
            }),
        }
    )
)
import { createSafeStorage } from './safe-storage'
