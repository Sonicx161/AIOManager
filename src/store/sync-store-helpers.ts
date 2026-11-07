import { clearSessionSyncToken } from '@/lib/session-sync-token'
import { getActiveWorkspaceId } from '@/lib/workspace-persistence'

// Shared runtime for sync operations and their async continuations.
export const syncRuntime = {
    appReady: false,
    lastPushedHash: null as string | null,
    corruptRestoreInFlight: false,
    // Monotonic generation for pulls, mirrors, and session invalidation.
    pullSeq: 0,
    // A same-account 304 can adopt pending pull work without rewinding pullSeq.
    adoptedSeq: null as number | null,
    // A 304 may certify only completed hydration; mirror work is never adoptable.
    hydration: null as { seq: number; id: string; status: 'pending' | 'ok' | 'failed'; kind: 'pull' | 'mirror' } | null,
    lastPulledDeletedWatchEvents: null as Record<string, number> | null,
    lastPulledNotesTrash: null as import('./notesStore').Note[] | null,
    // Preserve cloud notes until the local notes store has hydrated.
    lastPulledNotes: null as import('./notesStore').Note[] | null,
    lastPulledVaultTombstones: null as import('./vaultStore').VaultTombstone[] | null,
    // Preserved on push when this device has no avatar; mirrors the pull's upgrade-only identity rule.
    lastPulledCloudAvatar: null as string | null,
    pendingRetry: false,
    syncDebounceTimer: null as ReturnType<typeof setTimeout> | null,
    // When the current deferral window opened (first unsynced change), for the max-wait cap.
    syncDebounceFirstAt: null as number | null,
    // Wire size of the last built push body; sizes the next auto-push debounce window.
    lastPushedEnvelopeBytes: null as number | null,
    // Workspace+markedAt of the pending-push marker this boot already retried (one attempt per marker).
    pendingPushMarkerAttemptKey: null as string | null,
    lastSyncedAccountCount: null as number | null,
    onlineHandler: null as (() => void) | null,
    syncBC: null as BroadcastChannel | null,
}

// Size-aware push debounce: discrete saves each re-upload the whole envelope, so the
// auto-push coalescing window scales with the last measured push body. Small envelopes
// keep the 1.5 s window; multi-MB ones wait up to 10 s. The max-wait cap bounds how long
// a continuously re-armed change can be held. Explicit syncs bypass this entirely.
export const SYNC_DEBOUNCE_BASE_MS = 1500
export const SYNC_DEBOUNCE_MAX_MS = 10_000
export const SYNC_DEBOUNCE_MAX_WAIT_MS = 30_000
export const SYNC_DEBOUNCE_FULL_SCALE_BYTES = 4 * 1024 * 1024

export function pushDebounceDelayMs(lastEnvelopeBytes: number | null, now: number, firstDeferredAt: number | null): number {
    const sized = lastEnvelopeBytes && lastEnvelopeBytes > 0
        ? SYNC_DEBOUNCE_BASE_MS + (SYNC_DEBOUNCE_MAX_MS - SYNC_DEBOUNCE_BASE_MS) * Math.min(1, lastEnvelopeBytes / SYNC_DEBOUNCE_FULL_SCALE_BYTES)
        : SYNC_DEBOUNCE_BASE_MS
    if (firstDeferredAt === null) return Math.round(sized)
    return Math.round(Math.max(0, Math.min(sized, SYNC_DEBOUNCE_MAX_WAIT_MS - (now - firstDeferredAt))))
}

export interface SyncDebounceRuntime {
    syncDebounceTimer: ReturnType<typeof setTimeout> | null
    syncDebounceFirstAt: number | null
    lastPushedEnvelopeBytes: number | null
}

// Supersede any armed timer and schedule the deferred push; the callback resets the
// deferral window so the next change gets a fresh max-wait budget.
export function armSyncPushDebounce(runtime: SyncDebounceRuntime, fire: () => void, now: number = Date.now()): void {
    if (runtime.syncDebounceTimer) clearTimeout(runtime.syncDebounceTimer)
    if (runtime.syncDebounceFirstAt === null) runtime.syncDebounceFirstAt = now
    const delayMs = pushDebounceDelayMs(runtime.lastPushedEnvelopeBytes, now, runtime.syncDebounceFirstAt)
    runtime.syncDebounceTimer = setTimeout(() => {
        runtime.syncDebounceTimer = null
        runtime.syncDebounceFirstAt = null
        fire()
    }, delayMs)
}

// Fire an armed deferred push now (page hide/unload) instead of losing the window.
export function flushSyncPushDebounce(runtime: SyncDebounceRuntime, fire: () => void): boolean {
    if (!runtime.syncDebounceTimer) return false
    clearTimeout(runtime.syncDebounceTimer)
    runtime.syncDebounceTimer = null
    runtime.syncDebounceFirstAt = null
    fire()
    return true
}

export class SyncOwnershipLostError extends Error {
    constructor(
        public readonly expectedWorkspace: string,
        public readonly expectedSeq: number,
        public readonly activeWorkspace: string,
        public readonly activeSeq: number,
    ) {
        super(`Sync ownership lost: expected workspace ${expectedWorkspace} @ ${expectedSeq}, active is ${activeWorkspace} @ ${activeSeq}`)
        this.name = 'SyncOwnershipLostError'
    }
}

export interface SyncOwnership {
    readonly workspace: string
    readonly seq: number
    current: () => boolean
    assert: () => void
}

// Capture workspace and generation before awaiting. Recheck before storage dispatches
// or state publication; only an explicitly adopted sequence remains valid after a newer pull.
export function captureSyncOwnership(seq: number = syncRuntime.pullSeq): SyncOwnership {
    const workspace = getActiveWorkspaceId()
    const current = () =>
        getActiveWorkspaceId() === workspace &&
        (syncRuntime.pullSeq === seq || syncRuntime.adoptedSeq === seq)
    const assert = () => {
        if (!current()) {
            throw new SyncOwnershipLostError(workspace, seq, getActiveWorkspaceId(), syncRuntime.pullSeq)
        }
    }
    return { workspace, seq, current, assert }
}

export async function computeHash(data: string): Promise<string> {
    const encoded = new TextEncoder().encode(data)
    const hashBuffer = await crypto.subtle.digest('SHA-256', encoded)
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('')
}

// Pure "when did we last look" stamps: accountStates.*.lastSync (addonDeployment.syncAccountState
// restamps it on every passive sync) and failover rule lastCheck (advanced by autopilot state pulls).
// They must not defeat the push-skip hash; the pushed payload keeps them. Everything else
// (edits, deletions, tombstones, ordering, settings, credentials) still changes the hash.
export function normalizeStateForSkipHash(state: Record<string, unknown>): Record<string, unknown> {
    const normalized = { ...state }
    if (normalized.accountStates && typeof normalized.accountStates === 'object') {
        const accountStates: Record<string, unknown> = {}
        for (const [id, s] of Object.entries(normalized.accountStates as Record<string, unknown>)) {
            if (s && typeof s === 'object') {
                const { lastSync: _lastSync, ...rest } = s as Record<string, unknown>
                accountStates[id] = rest
            } else {
                accountStates[id] = s
            }
        }
        normalized.accountStates = accountStates
    }
    const failover = normalized.failover
    if (failover && typeof failover === 'object' && Array.isArray((failover as Record<string, unknown>).rules)) {
        const fo = failover as Record<string, unknown>
        normalized.failover = {
            ...fo,
            rules: (fo.rules as unknown[]).map(r => {
                if (!r || typeof r !== 'object') return r
                const { lastCheck: _lastCheck, ...rest } = r as Record<string, unknown>
                return rest
            }),
        }
    }
    return normalized
}

let _syncLock: Promise<void> | null = null

export async function acquireSyncLock(): Promise<() => void> {
    while (_syncLock) {
        await _syncLock
    }
    let resolve!: () => void
    _syncLock = new Promise<void>(r => { resolve = r })
    let released = false
    return () => {
        if (released) return
        released = true
        _syncLock = null
        resolve()
    }
}

let _accountsHydrated = false

export function markAccountsHydrated() {
    _accountsHydrated = true
}

export function resetAccountsHydration() {
    _accountsHydrated = false
}

export function isAccountsHydrationComplete() {
    return _accountsHydrated
}

// Identity profile lives outside the churnable auth object: session resets, 401 wipes and
// expiry paths must never erase the user's chosen name or avatar. The id stamp scopes the
// local fallback to the owning account so identities never bleed across accounts.
const IDENTITY_KEY = 'aio-identity-v1'

export function readIdentityProfile(): { id: string | null; name: string; avatar: string | null } {
    try {
        const raw = JSON.parse(localStorage.getItem(IDENTITY_KEY) || '{}') as { id?: unknown; name?: unknown; avatar?: unknown }
        return {
            id: typeof raw.id === 'string' && raw.id ? raw.id : null,
            name: typeof raw.name === 'string' ? raw.name : '',
            avatar: typeof raw.avatar === 'string' && raw.avatar ? raw.avatar : null,
        }
    } catch {
        return { id: null, name: '', avatar: null }
    }
}

export function writeIdentityProfile(id: string, name: string, avatar: string | null): void {
    try { localStorage.setItem(IDENTITY_KEY, JSON.stringify({ id, name, avatar })) } catch {}
}

// Upgrade-only identity resolution: a non-empty cloud value wins, otherwise the same-account
// local fallback applies. An empty cloud value can never erase what this device has.
export function resolveCloudIdentity(
    cloud: Record<string, unknown>,
    accountId: string,
    localAuth: { name: string; avatar: string | null },
): { name: string; avatar: string | null } {
    const profile = readIdentityProfile()
    const sameAccount = profile.id === accountId
    const fallbackName = sameAccount ? (localAuth.name || profile.name) : ''
    const fallbackAvatar = sameAccount ? (localAuth.avatar ?? profile.avatar) : null
    const name = (typeof cloud.name === 'string' && cloud.name) ? cloud.name : fallbackName
    const avatar = (typeof cloud.avatar === 'string' && cloud.avatar) ? cloud.avatar : fallbackAvatar
    return { name, avatar }
}

export const LEGACY_SYNC_PASSWORD_KEY = 'aioman-sync-password'

const DEFAULT_SERVER = '/api'

export function getSyncApiPath(serverUrl: string | undefined): string {
    const base = (serverUrl || DEFAULT_SERVER).trim().replace(/\/+$/, '')
    if (!base) return DEFAULT_SERVER
    if (!base.startsWith('http')) return base
    return base.endsWith('/api') ? base : `${base}/api`
}

export const clearSyncCredentialCaches = () => {
    try { sessionStorage.removeItem(LEGACY_SYNC_PASSWORD_KEY) } catch (e) { if (import.meta.env.DEV) console.error(e) }
    clearSessionSyncToken()
    import('@/lib/crypto').then(({ clearSyncKeyCache }) => clearSyncKeyCache()).catch(() => {})
}

export async function isDeviceSessionActive(): Promise<boolean> {
    try {
        const { isDeviceAuthActive } = await import('@/lib/device-session')
        return isDeviceAuthActive()
    } catch {
        return false
    }
}

export async function getActiveDeviceSyncKey(): Promise<CryptoKey | null> {
    try {
        const { getDeviceSyncKey } = await import('@/lib/device-session')
        return getDeviceSyncKey()
    } catch {
        return null
    }
}

export async function deviceUnlockFromSession(): Promise<{ syncKey: CryptoKey } | undefined> {
    const syncKey = await getActiveDeviceSyncKey()
    return syncKey ? { syncKey } : undefined
}
