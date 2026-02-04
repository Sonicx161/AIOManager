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
    autoSyncEnabled: boolean

    // Actions
    register: (password: string, name?: string) => Promise<void>
    login: (id: string, password: string, isSilent?: boolean) => Promise<void>
    logout: () => void
    syncToRemote: (isAuto?: boolean) => Promise<void>
    syncFromRemote: (isSilent?: boolean) => Promise<void>
    setServerUrl: (url: string) => void
    setDisplayName: (name: string) => void
    setAutoSyncEnabled: (enabled: boolean) => void
    deleteRemoteAccount: () => Promise<void>
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
            autoSyncEnabled: true, // Default to true for convenience

            setServerUrl: (url) => set({ serverUrl: url }),

            setDisplayName: (name) => set((state) => ({
                auth: { ...state.auth, name }
            })),

            setAutoSyncEnabled: (enabled) => set({ autoSyncEnabled: enabled }),

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
                    const emptyState = {
                        accounts: [],
                        addons: {},
                        profiles: [],
                        failover: [],
                        syncedAt: new Date().toISOString()
                    }

                    const res = await fetch(`${apiPath}/sync/${newId}`, {
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
                    const res = await fetch(`${apiPath}/sync/${id}`, {
                        headers: { 'x-sync-password': await deriveSyncToken(password) }
                    })

                    if (res.status === 401) throw new Error("Invalid Password")
                    if (res.status === 404) throw new Error("Account ID not found")
                    if (!res.ok) throw new Error("Server error, please try again later.")

                    const text = await res.text()
                    if (!text || text.trim() === "") {
                        throw new Error("Server returned an empty response. Your data might not be initialized yet.")
                    }

                    let data: any
                    try {
                        const raw = JSON.parse(text)
                        // Encryption Support (Privacy Update)
                        if (raw.isEncrypted && raw.data) {
                            const { AES, enc } = await import('crypto-js')
                            const bytes = AES.decrypt(raw.data, password)
                            const decryptedStr = bytes.toString(enc.Utf8)
                            if (!decryptedStr) throw new Error("Decryption failed. Wrong password?")
                            data = JSON.parse(decryptedStr)
                        } else {
                            // Legacy: Plain text
                            data = raw
                        }
                    } catch (e) {
                        console.error("[Sync] Decryption/Parsing Error:", e)
                        // If it's a JSON parse error (likely from getting HTML instead of JSON), show a better message
                        if (e instanceof SyntaxError) {
                            throw new Error("Invalid server response. Please make sure the backend is running correctly.")
                        }
                        throw new Error("Failed to decrypt data. Wrong password?")
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

                    // 2. Import Data
                    if (data.accounts) {
                        await useAccountStore.getState().importAccounts(data.accounts, true)
                    }
                    if (data.addons) {
                        await useAddonStore.getState().importLibrary(data.addons, true)
                        await useAddonStore.getState().initialize()
                    }
                    if (data.profiles && Array.isArray(data.profiles)) {
                        await useProfileStore.getState().importProfiles(data.profiles)
                    }
                    if (data.failover) {
                        if (Array.isArray(data.failover)) {
                            // Legacy format: just rules
                            await useFailoverStore.getState().importRules(data.failover)
                        } else if (typeof data.failover === 'object') {
                            // New format: { rules, webhook }
                            if (data.failover.rules) await useFailoverStore.getState().importRules(data.failover.rules)
                            if (data.failover.webhook) {
                                useFailoverStore.getState().setWebhook(data.failover.webhook.url, data.failover.webhook.enabled)
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
                const baseUrl = serverUrl || DEFAULT_SERVER
                const apiPath = baseUrl.startsWith('http') ? `${baseUrl}/api` : baseUrl

                try {
                    const { loadSalt } = await import('@/lib/crypto')
                    const salt = loadSalt()
                    const saltBase64 = salt ? btoa(String.fromCharCode(...salt)) : undefined

                    const state = {
                        accounts: await useAccountStore.getState().exportAccounts(true),
                        addons: useAddonStore.getState().exportLibrary(),
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
                    const encryptedState = AES.encrypt(JSON.stringify(state), auth.password).toString()

                    const res = await fetch(`${apiPath}/sync/${auth.id}`, {
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

                    set({ lastSyncedAt: new Date().toISOString() })

                    if (!isAuto) {
                        toast({ title: "Saved", description: "Changes saved to cloud." })
                    }
                } catch (e) {
                    const message = (e as Error).message
                    const isNetworkError = message === 'Failed to fetch' || message.includes('Failed to reach server')

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

            syncFromRemote: async (isSilent: boolean = false) => {
                const { auth } = get()
                if (!auth.isAuthenticated) return
                await get().login(auth.id, auth.password, isSilent)
            },

            deleteRemoteAccount: async () => {
                const { auth, serverUrl } = get()
                if (!auth.isAuthenticated) return
                const baseUrl = serverUrl || DEFAULT_SERVER
                const apiPath = baseUrl.startsWith('http') ? `${baseUrl}/api` : baseUrl

                const res = await fetch(`${apiPath}/sync/${auth.id}`, {
                    method: 'DELETE',
                    headers: { 'x-sync-password': await deriveSyncToken(auth.password) }
                })

                if (!res.ok) throw new Error("Failed to delete account from server")
                get().logout()
            }
        }),
        {
            name: 'sync-storage',
            partialize: (state) => ({
                serverUrl: state.serverUrl,
                lastSyncedAt: state.lastSyncedAt,
                autoSyncEnabled: state.autoSyncEnabled
            })
        }
    )
)
