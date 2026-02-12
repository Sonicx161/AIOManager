import { create } from 'zustand'
import {
  deriveKey,
  hashPassword,
  generateSalt,
  loadSalt,
  saveSalt,
  loadPasswordHash,
  savePasswordHash,
  isPasswordSetup,
  saveSessionKey,
  loadSessionKey,
  clearSessionKey,
} from '@/lib/crypto'
import { wipeAllData } from '@/lib/storage-reset'
import { resetAllStores } from '@/lib/store-coordinator'

interface AuthStore {
  isLocked: boolean
  encryptionKey: CryptoKey | null

  initialize: () => Promise<void>
  setupMasterPassword: (password: string) => Promise<void>
  unlock: (password: string) => Promise<boolean>
  lock: () => void
  resetMasterPassword: (password: string) => Promise<void>
  unlockFromSync: (password: string, saltBase64?: string) => Promise<void>
  isPasswordSet: () => boolean
}

export const useAuthStore = create<AuthStore>((set, get) => ({
  isLocked: true,
  encryptionKey: null,

  /**
   * Initialize auth state on app startup
   * Tries to load session key, otherwise determines if password is set
   */
  initialize: async () => {
    const passwordSet = isPasswordSetup()

    if (!passwordSet) {
      // No password set yet - not locked
      set({ isLocked: false })
      return
    }

    // Try to load existing session key
    const sessionKey = await loadSessionKey()

    if (sessionKey) {
      // Session key found - user is unlocked
      set({
        encryptionKey: sessionKey,
        isLocked: false,
      })
    } else {
      // No session key - user needs to unlock
      set({ isLocked: true })

      // Critical: If we have an existing session key in storage but it failed to load,
      // or if we are just starting up, we must ensure we don't accidentally leave it unlocked.
      // But here we set isLocked: true, so we are safe.
    }
  },

  /**
   * Set up master password for the first time
   * Generates salt, hashes password, stores both, and derives encryption key
   * Wipes any existing data to prevent decryption issues
   */
  setupMasterPassword: async (password: string) => {
    if (password.length < 8) {
      throw new Error('Password must be at least 8 characters')
    }

    // Wipe any existing data (could be from old encryption system)
    await wipeAllData()

    // Generate and save salt
    const salt = generateSalt()
    saveSalt(salt)

    // Hash and save password
    const hash = await hashPassword(String(password), salt)
    savePasswordHash(hash)

    // Derive encryption key
    const key = await deriveKey(String(password), salt)

    // Save to session storage
    await saveSessionKey(key)

    // Update state - user is now unlocked
    set({
      encryptionKey: key,
      isLocked: false,
    })
  },

  /**
   * Unlock the app with master password
   * Verifies password by comparing hashes, then derives encryption key
   */
  unlock: async (password: string) => {
    const salt = loadSalt()
    const storedHash = loadPasswordHash()

    if (!salt || !storedHash) {
      throw new Error('App is not initialized. Please set up a master password or login via Cloud Sync.')
    }


    // Hash provided password
    const hash = await hashPassword(String(password), salt)

    // Compare hashes
    if (hash !== storedHash) {
      return false // Wrong password
    }

    // Derive encryption key
    const key = await deriveKey(password, salt)

    // Save to session storage
    await saveSessionKey(key)

    // Update state
    set({
      encryptionKey: key,
      isLocked: false,
    })

    return true
  },

  /**
   * Lock the app
   * Clears encryption key from memory and session storage
   */
  lock: () => {
    clearSessionKey()
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

    // Wipe all data first
    await wipeAllData()

    // Reset in-memory state from all stores
    resetAllStores()

    // Set up new password using existing function
    await get().setupMasterPassword(password)
  },

  /**
   * Unlock or initialize encryption from a sync login
   * Useful for fresh installs or cross-device restoration
   */
  unlockFromSync: async (password: string, saltBase64?: string) => {
    let salt: Uint8Array | null = null

    if (saltBase64) {
      // Decode and save salt from cloud
      try {
        salt = Uint8Array.from(atob(saltBase64), (c) => c.charCodeAt(0))
        saveSalt(salt)
      } catch (e) {
        console.error('Failed to decode sync salt:', e)
      }
    }

    if (!salt) {
      // Fallback to local salt
      salt = loadSalt()
    }

    if (!salt) {
      // If still no salt, we can't derive the key.
      // This happens if logging into an old account that didn't sync its salt yet.
      throw new Error('Encryption metadata (salt) is missing from this account backup.')
    }

    const key = await deriveKey(password, salt)

    // Save password hash locally to satisfy isPasswordSetup()
    // This removes the "Master password not set up" barrier for synced accounts
    const hash = await hashPassword(password, salt)
    savePasswordHash(hash)

    // Save to session storage
    await saveSessionKey(key)

    // Update state - user is now unlocked
    set({
      encryptionKey: key,
      isLocked: false,
    })
  },

  /**
   * Check if master password is set up
   */
  isPasswordSet: () => {
    return isPasswordSetup()
  },
}))
