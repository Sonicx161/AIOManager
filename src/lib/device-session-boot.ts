import { deleteRecord, getAnyRecord, isRecordExpired, type DeviceRecord } from './device-store.ts'
import { unwrapBlob, type DeviceSecretBundle } from './device-credential.ts'

/**
 * Boot-time restoration of the remembered-device session, extracted from device-session.ts
 * so the boot race that decides it can be tested under node:test (this file must stay
 * free of '@/' alias imports and of any store module - callers inject the stores).
 *
 * Live bug #51: on refresh the caller is a module-load `import()` that resolves in ~1
 * microtask, while zustand persist needs several async hops to merge 'aioman-sync' back
 * into the sync store. Reading `auth` before hydration lands snapshots the default
 * state (isAuthenticated:false) and the reactivation bails permanently - killing the
 * remembered session until the next manual login.
 */

export interface StoreHydrationApi {
    hasHydrated(): boolean
    onFinishHydration(cb: () => void): () => void
}

export interface SyncStoreLike {
    getState(): { auth: { id: string; password: string; isAuthenticated: boolean } }
    persist: StoreHydrationApi
}

export interface AuthStoreLike {
    getState(): { isLocked: boolean; encryptionKey: CryptoKey | null; initialize(): Promise<void> }
}

export type BootReactivationOutcome =
    | { activated: true; record: DeviceRecord; secret: Uint8Array; bundle: DeviceSecretBundle }
    | {
          activated: false
          reason:
              | 'not-authenticated'
              | 'password-session'
              | 'session-credential'
              | 'vault-locked'
              | 'store-unavailable'
              | 'no-record'
              | 'prf-record'
              | 'account-mismatch'
              | 'corrupt'
      }

export interface ReactivationOptions {
    /** How long to wait for persist hydration before proceeding with the current snapshot. */
    hydrationTimeoutMs?: number
    hasSessionCredential?: (accountId: string) => boolean
}

/**
 * Resolves once the store's persist middleware has finished rehydrating (or after
 * `timeoutMs`, so a broken storage layer can never wedge boot - the state guards in
 * resolveBootReactivation still apply to whatever snapshot exists by then).
 */
export async function waitForStoreHydration(store: SyncStoreLike, timeoutMs = 2000): Promise<void> {
    if (store.persist.hasHydrated()) return
    await new Promise<void>((resolve) => {
        let settled = false
        let timer: ReturnType<typeof setTimeout> | null = null
        const settle = () => {
            if (settled) return
            settled = true
            if (timer) clearTimeout(timer)
            resolve()
        }
        const unsubscribe = store.persist.onFinishHydration(() => {
            unsubscribe()
            settle()
        })
        // Closed race: hydration may finish between the hasHydrated() check above and the
        // subscription above; re-check so the wait resolves immediately instead of timing out.
        if (store.persist.hasHydrated()) {
            unsubscribe()
            settle()
            return
        }
        timer = setTimeout(settle, timeoutMs)
    })
}

async function loadCurrentRecord(): Promise<DeviceRecord | null> {
    const record = await getAnyRecord()
    if (!record) return null
    if (isRecordExpired(record)) {
        await deleteRecord(record.accountUUID)
        return null
    }
    return record
}

/**
 * Decides whether this boot can silently restore the remembered-device session, and if
 * so unwraps the credential bundle. Pure with respect to app state: it never mutates the
 * device-session module's in-memory auth, never fetches, and only touches IndexedDB via
 * the device store. Callers own activation and the follow-up pull.
 */
export async function resolveBootReactivation(
    syncStore: SyncStoreLike,
    authStore: AuthStoreLike,
    options?: ReactivationOptions,
): Promise<BootReactivationOutcome> {
    if (!syncStore.persist.hasHydrated()) {
        await waitForStoreHydration(syncStore, options?.hydrationTimeoutMs ?? 2000)
    }
    const { auth } = syncStore.getState()
    if (!auth.isAuthenticated) return { activated: false, reason: 'not-authenticated' }
    // Password sessions are never gated by the remembered layer (hard invariant): they
    // carry their own credential and must not adopt a remembered device token.
    if (auth.password) return { activated: false, reason: 'password-session' }
    if (options?.hasSessionCredential?.(auth.id)) return { activated: false, reason: 'session-credential' }
    // The vault must be restorable for the session to be usable at all; initialize() is
    // idempotent and also runs from App.tsx, so awaiting it here only closes the module-
    // load race where reactivation resolves before authStore has restored the vault key.
    await authStore.getState().initialize()
    const authState = authStore.getState()
    if (authState.isLocked || !authState.encryptionKey) return { activated: false, reason: 'vault-locked' }
    let record: DeviceRecord | null
    try {
        record = await loadCurrentRecord()
    } catch {
        return { activated: false, reason: 'store-unavailable' }
    }
    // PRF records need a biometric gesture; only the login gate can supply one.
    if (!record) return { activated: false, reason: 'no-record' }
    if (!record.deviceSecret) return { activated: false, reason: 'prf-record' }
    if (record.accountUUID !== auth.id) return { activated: false, reason: 'account-mismatch' }
    let bundle: DeviceSecretBundle
    try {
        bundle = await unwrapBlob(record.deviceSecret, record.blob, {
            accountUUID: record.accountUUID,
            deviceId: record.deviceId,
        })
        if (!bundle.syncKey) throw new Error('missing sync key')
    } catch {
        try { await deleteRecord(record.accountUUID) } catch { /* already unwritable; the expiry path reaps it */ }
        return { activated: false, reason: 'corrupt' }
    }
    return { activated: true, record, secret: record.deviceSecret, bundle }
}
