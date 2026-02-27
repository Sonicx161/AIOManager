import { create } from 'zustand'
import { VaultKey, VaultState } from '@/types/vault'
import { encrypt, decrypt } from '@/lib/crypto'
import { useAuthStore } from '@/store/authStore'
import localforage from 'localforage'

const STORAGE_KEY = 'stremio-manager:key-vault'

interface VaultStore extends VaultState {
    initialize: () => Promise<void>
    addKey: (key: Omit<VaultKey, 'id' | 'updatedAt'>) => Promise<void>
    removeKey: (id: string) => Promise<void>
    updateKey: (id: string, key: Partial<VaultKey>) => Promise<void>
    moveKey: (id: string, direction: 'up' | 'down') => Promise<void>
    clearVault: () => Promise<void>
    importVault: (keys: VaultKey[]) => Promise<void>
}

export const useVaultStore = create<VaultStore>((set, get) => ({
    keys: [],
    isLocked: true,
    loading: false,
    error: null,

    initialize: async () => {
        const { encryptionKey } = useAuthStore.getState()
        if (!encryptionKey) {
            set({ isLocked: true })
            return
        }

        set({ loading: true, error: null })
        try {
            const encryptedData = await localforage.getItem<string>(STORAGE_KEY)
            if (!encryptedData) {
                set({ keys: [], isLocked: false, loading: false })
                return
            }

            const decryptedData = await decrypt(encryptedData, encryptionKey)
            const keys = JSON.parse(decryptedData) as VaultKey[]
            set({ keys, isLocked: false, loading: false })
        } catch (error) {
            console.error('Failed to initialize vault:', error)
            set({ error: 'Failed to decrypt vault. Your keys might be corrupted or the password changed.', loading: false })
        }
    },

    addKey: async (newKey) => {
        const { encryptionKey } = useAuthStore.getState()
        if (!encryptionKey) throw new Error('Vault is locked')

        const key: VaultKey = {
            ...newKey,
            id: crypto.randomUUID(),
            updatedAt: Date.now(),
        }

        const updatedKeys = [...get().keys, key]
        const encryptedData = await encrypt(JSON.stringify(updatedKeys), encryptionKey)
        await localforage.setItem(STORAGE_KEY, encryptedData)

        set({ keys: updatedKeys })
    },

    removeKey: async (id) => {
        const { encryptionKey } = useAuthStore.getState()
        if (!encryptionKey) throw new Error('Vault is locked')

        const updatedKeys = get().keys.filter((k) => k.id !== id)
        const encryptedData = await encrypt(JSON.stringify(updatedKeys), encryptionKey)
        await localforage.setItem(STORAGE_KEY, encryptedData)

        set({ keys: updatedKeys })
    },

    updateKey: async (id, updates) => {
        const { encryptionKey } = useAuthStore.getState()
        if (!encryptionKey) throw new Error('Vault is locked')

        const updatedKeys = get().keys.map((k) =>
            k.id === id ? { ...k, ...updates, updatedAt: Date.now() } : k
        )
        const encryptedData = await encrypt(JSON.stringify(updatedKeys), encryptionKey)
        await localforage.setItem(STORAGE_KEY, encryptedData)

        set({ keys: updatedKeys })
    },

    moveKey: async (id, direction) => {
        const { encryptionKey } = useAuthStore.getState()
        if (!encryptionKey) throw new Error('Vault is locked')

        const keys = [...get().keys]
        const index = keys.findIndex((k) => k.id === id)
        if (index === -1) return

        const newIndex = direction === 'up' ? index - 1 : index + 1
        if (newIndex < 0 || newIndex >= keys.length) return

        // Swap
        const [removed] = keys.splice(index, 1)
        keys.splice(newIndex, 0, removed)

        const encryptedData = await encrypt(JSON.stringify(keys), encryptionKey)
        await localforage.setItem(STORAGE_KEY, encryptedData)

        set({ keys })
    },

    clearVault: async () => {
        await localforage.removeItem(STORAGE_KEY)
        set({ keys: [], isLocked: true })
    },

    importVault: async (keys) => {
        console.log('[VaultStore] Attempting to import vault keys. Count:', keys?.length)
        const { encryptionKey } = useAuthStore.getState()
        if (!encryptionKey) {
            console.warn('[VaultStore] Cannot import vault while locked. Keys will be ignored.')
            return
        }

        if (!keys || !Array.isArray(keys)) {
            console.warn('[VaultStore] Invalid keys format for import:', keys)
            return
        }

        try {
            // Save to storage (encrypted)
            const encryptedData = await encrypt(JSON.stringify(keys), encryptionKey)
            await localforage.setItem(STORAGE_KEY, encryptedData)

            set({ keys, isLocked: false })
            console.log('[VaultStore] Vault import successful.')
        } catch (e) {
            console.error('[VaultStore] Vault import failed:', e)
        }
    }
}))

// Auto-initialize or Lock based on AuthStore
useAuthStore.subscribe((state, prevState) => {
    if (state.encryptionKey && !prevState.encryptionKey) {
        useVaultStore.getState().initialize().then(() => {
            // Refresh provider health after vault is ready
            import('@/store/providerStore').then(({ useProviderStore }) => {
                useProviderStore.getState().refreshAll()
            })
        })
    } else if (!state.encryptionKey && prevState.encryptionKey) {
        useVaultStore.setState({ keys: [], isLocked: true })
    }
})
