import { Profile } from '@/types/profile'
import localforage from 'localforage'
import { create } from 'zustand'

const STORAGE_KEY = 'stremio-manager:profiles'

interface ProfileState {
    profiles: Profile[]
    loading: boolean
    error: string | null

    // Actions
    initialize: () => Promise<void>
    createProfile: (name: string, description?: string, color?: string) => Promise<Profile>
    updateProfile: (id: string, updates: Partial<Omit<Profile, 'id' | 'createdAt'>>) => Promise<void>
    deleteProfile: (id: string) => Promise<void>
    reorderProfiles: (newOrder: Profile[]) => Promise<void>
    getProfile: (id: string) => Profile | undefined
    importProfiles: (profiles: Profile[]) => Promise<void>
    reset: () => void
}

export const useProfileStore = create<ProfileState>((set, get) => ({
    profiles: [],
    loading: false,
    error: null,

    initialize: async () => {
        set({ loading: true })
        try {
            const stored = await localforage.getItem<Profile[]>(STORAGE_KEY)
            if (stored) {
                // Convert date strings back to Date objects
                const parsed = stored.map(p => ({
                    ...p,
                    createdAt: new Date(p.createdAt),
                    updatedAt: new Date(p.updatedAt)
                }))
                set({ profiles: parsed })
            }
        } catch (err) {
            console.error('Failed to load profiles:', err)
            set({ error: 'Failed to load profiles' })
        } finally {
            set({ loading: false })
        }
    },

    createProfile: async (name: string, description?: string, color?: string) => {
        const newProfile: Profile = {
            id: crypto.randomUUID(),
            name,
            description,
            color,
            createdAt: new Date(),
            updatedAt: new Date()
        }

        set(state => {
            const updated = [...state.profiles, newProfile]
            localforage.setItem(STORAGE_KEY, updated)
            // Sync to cloud immediately
            import('./syncStore').then(({ useSyncStore }) => {
                useSyncStore.getState().syncToRemote(true).catch(console.error)
            })
            return { profiles: updated, error: null }
        })

        return newProfile
    },

    updateProfile: async (id: string, updates: Partial<Omit<Profile, 'id' | 'createdAt'>>) => {
        set(state => {
            const updated = state.profiles.map(p =>
                p.id === id
                    ? { ...p, ...updates, updatedAt: new Date() }
                    : p
            )
            localforage.setItem(STORAGE_KEY, updated)
            // Sync to cloud immediately
            import('./syncStore').then(({ useSyncStore }) => {
                useSyncStore.getState().syncToRemote(true).catch(console.error)
            })
            return { profiles: updated, error: null }
        })
    },

    deleteProfile: async (id: string) => {
        set(state => {
            const updated = state.profiles.filter(p => p.id !== id)
            localforage.setItem(STORAGE_KEY, updated)
            // Sync to cloud immediately
            import('./syncStore').then(({ useSyncStore }) => {
                useSyncStore.getState().syncToRemote(true).catch(console.error)
            })
            return { profiles: updated, error: null }
        })
    },

    reorderProfiles: async (newOrder: Profile[]) => {
        set(() => {
            localforage.setItem(STORAGE_KEY, newOrder)
            // Sync to cloud immediately
            import('./syncStore').then(({ useSyncStore }) => {
                useSyncStore.getState().syncToRemote(true).catch(console.error)
            })
            return { profiles: newOrder, error: null }
        })
    },

    getProfile: (id: string) => {
        return get().profiles.find(p => p.id === id)
    },

    importProfiles: async (profilesToImport: Profile[]) => {
        const existingIds = new Set(get().profiles.map(p => p.id))
        const newProfiles = profilesToImport.filter(p => !existingIds.has(p.id))

        if (newProfiles.length === 0) return

        set(state => {
            const updated = [...state.profiles, ...newProfiles]
            localforage.setItem(STORAGE_KEY, updated)
            return { profiles: updated, error: null }
        })
    },

    reset: () => {
        set({ profiles: [], loading: false, error: null })
        localforage.removeItem(STORAGE_KEY)
    }
}))
