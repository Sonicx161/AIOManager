import { create } from 'zustand'
import {
  deriveKeyAndHash,
  deriveVerifiedKey,
  generateSalt,
  loadSalt,
  saveSalt,
  loadPasswordHash,
  savePasswordHash,
  saveSessionKey,
  loadSessionKey,
  clearSessionKey,
  clearSyncKeyCache,
} from '@/lib/crypto'
import { findVaultRestorableDeviceRecord } from '@/lib/boot-session-restore'
import { wipeAllData } from '@/lib/storage-reset'
import { resetAllStores } from '@/lib/store-coordinator'

interface AuthStore {
  isLocked: boolean
  encryptionKey: CryptoKey | null

  initialize: () => Promise<void>
  setupMasterPassword: (password: string, saltOverride?: Uint8Array, options?: { resetSyncStore?: boolean }) => Promise<void>
  unlock: (password: string) => Promise<boolean>
  lock: () => void
  resetMasterPassword: (password: string) => Promise<void>
  unlockFromSync: (password: string, saltBase64?: string, options?: { allowGenerate?: boolean }) => Promise<void>
}

export const useAuthStore = create<AuthStore>((set, get) => ({
  isLocked: true,
  encryptionKey: null,

  initialize: async () => {
    const salt = loadSalt()
    const storedHash = loadPasswordHash()
    const passwordSet = !!(salt && storedHash)

    if (!salt && !storedHash) {
      set({ isLocked: false })
      return
    }

    if (!passwordSet) {
      // Partial metadata means the browser session needs a normal sign-in
      // or cloud restore before encrypted account data can be used safely.
      set({ isLocked: true })
      return
    }

    const sessionKey = await loadSessionKey()

    if (sessionKey && (await findVaultRestorableDeviceRecord())) {
      set({
        encryptionKey: sessionKey,
        isLocked: false,
      })
    } else {
      // A restored vault key alone is a credentialless session: the password is never
      // persisted, so without a silently-activatable remembered device record every
      // request would authenticate as deriveSyncToken('') and 401 across the
      // password-verified routes (stremio-proxy, Nuvio QR, backup, re-auth) while sync
      // failures stay silent. Present the gate and collect a real credential instead.
      set({ isLocked: true })
    }
  },

  setupMasterPassword: async (password: string, saltOverride?: Uint8Array, options?: { resetSyncStore?: boolean }) => {
    if (password.length < 8) {
      throw new Error('Password must be at least 8 characters')
    }

    const salt = saltOverride ?? generateSalt()
    const { hash, key } = await deriveKeyAndHash(String(password), salt)

    if (!saveSalt(salt) || !savePasswordHash(hash)) {
      console.warn('Your session may not persist across page reloads.')
    }
    try {
      await saveSessionKey(key)
    } catch {
      // non-fatal - key is in zustand state for this session
    }

    await wipeAllData()
    await resetAllStores({ includeSync: options?.resetSyncStore ?? true })

    if (!saveSalt(salt) || !savePasswordHash(hash)) {
      console.warn('Your session may not persist across page reloads.')
    }
    try {
      await saveSessionKey(key)
    } catch {
      // non-fatal - key is in zustand state for this session
    }

    set({
      encryptionKey: key,
      isLocked: false,
    })
  },

  unlock: async (password: string) => {
    const salt = loadSalt()
    const storedHash = loadPasswordHash()

    if (!salt || !storedHash) {
      throw new Error('App is not initialized. Set up a master password or login via Cloud Sync.')
    }


    const key = await deriveVerifiedKey(String(password), salt, storedHash)

    if (!key) {
      return false
    }

    await saveSessionKey(key)

    set({
      encryptionKey: key,
      isLocked: false,
    })

    return true
  },

  lock: () => {
    clearSessionKey()
    clearSyncKeyCache()
    import('@/store/accountStore').then(({ clearAuthKeyCache }) => {
      clearAuthKeyCache()
    })
    import('@/lib/display-read-cache').then(({ clearDisplayReadCache }) => clearDisplayReadCache()).catch(() => {})
    import('@/lib/pmdb-list-publisher').then(({ _invalidateAuthCache }) => _invalidateAuthCache()).catch(() => {})
    import('@/store/syncStore').then(({ useSyncStore }) => {
      const { auth } = useSyncStore.getState()
      if (auth.isAuthenticated) {
        useSyncStore.setState({ auth: { ...auth, password: '' } })
      }
    })
    try { sessionStorage.removeItem('aioman-sync-password') } catch {}
    set({
      encryptionKey: null,
      isLocked: true,
    })
  },

  /**
   * Reset master password and wipe all data
   * This is a destructive operation - all accounts and addons will be lost
   */
  resetMasterPassword: async (password: string) => {
    if (password.length < 8) {
      throw new Error('Password must be at least 8 characters')
    }

    await wipeAllData()

    await resetAllStores()

    await get().setupMasterPassword(password)
  },

  unlockFromSync: async (password: string, saltBase64?: string, options?: { allowGenerate?: boolean }) => {
    let salt: Uint8Array | null = null

    if (saltBase64) {
      try {
        salt = Uint8Array.from(atob(saltBase64), (c) => c.charCodeAt(0))
        if (!saveSalt(salt)) {
          console.warn('Your session may not persist across page reloads.')
        }
      } catch (e) {
        if (import.meta.env.DEV) console.error('Failed to decode sync salt:', e)
      }
    }

    if (!salt) {
      salt = loadSalt()
    }

    if (!salt) {
      if (!options?.allowGenerate) {
        // Refuse to invent a salt. Deriving a key from a new salt produces a DIFFERENT key,
        // which silently fails to decrypt any account authKey or vault entry that was encrypted
        // under the original salt. The caller only allows generation when there is no existing
        // encrypted data to corrupt (e.g. a brand-new or empty account).
        throw new Error('Encryption salt missing; this account can only be restored from the device or browser where it was created.')
      }
      salt = generateSalt()
      if (!saveSalt(salt)) {
        console.warn('Your session may not persist across page reloads.')
      }
      if (import.meta.env.DEV) console.warn('[Auth] No salt available; generated fresh local encryption metadata for an empty account.')
    }

    const { key, hash } = await deriveKeyAndHash(password, salt)

    // Save password hash locally to satisfy isPasswordSetup()
    // This removes the "Master password not set up" barrier for synced accounts
    if (!savePasswordHash(hash)) {
      console.warn('Your session may not persist across page reloads.')
    }

    await saveSessionKey(key)

    set({
      encryptionKey: key,
      isLocked: false,
    })
  },

}))
