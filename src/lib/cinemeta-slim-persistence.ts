import { encrypt, decrypt } from '@/lib/crypto'
import { useAuthStore } from '@/store/authStore'
import { getActivePersistence, getActiveWorkspaceId, subscribeWorkspaceChanges } from '@/lib/workspace-persistence'
import { createSlimStore } from '@/lib/cinemeta-slim-store'

export const cinemetaSlimStore = createSlimStore({
    context: () => {
        const key = useAuthStore.getState().encryptionKey
        if (!key) return null
        return {
            scope: getActiveWorkspaceId(),
            keyRef: key,
            cipher: { encrypt: plain => encrypt(plain, key), decrypt: sealed => decrypt(sealed, key) },
            backend: getActivePersistence(),
        }
    },
})

subscribeWorkspaceChanges(() => cinemetaSlimStore.reset())
useAuthStore.subscribe((state, previous) => {
    if (state.encryptionKey !== previous.encryptionKey) cinemetaSlimStore.reset()
})
