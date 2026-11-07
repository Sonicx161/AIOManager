import { resilientFetch } from '@/lib/api-resilience'
import { useSyncStore, getSyncApiPath } from '@/store/syncStore'
import { useAuthStore } from '@/store/authStore'
import { getActiveWorkspaceId } from '@/lib/workspace-persistence'
import { getDeviceAwareAuthHeaders } from '@/lib/device-session'
import { beginCredentialHealAttempt, connectionCredentialBundle } from '@/lib/connection-credential-heal'
import type { Connection } from '@/types/connection'
import { isAddonConnection } from '@/types/connection'
import type { AddonDescriptor } from '@/types/addon'
import type { ReconcileConnectionOutcome } from '@/lib/sync/push-outcome'

async function getAuthHeaders(): Promise<Record<string, string>> {
    return getDeviceAwareAuthHeaders()
}

export interface ReconcileResult {
    synced: boolean
    changes: Array<{
        type: 'addition' | 'removal_primary' | 'restore'
        url: string
        platform: string
        primary: boolean
    }>
    connectionStates: Record<string, ConnectionState>
    /** Newer servers report each connection's push result; older ones omit it. */
    connectionOutcomes?: Record<string, ReconcileConnectionOutcome>
}

export interface ConnectionState {
    consecutiveFailures: number
    lastError: string | null
    lastErrorAt: number | null
    lastSync: number
    status: 'active' | 'expired' | 'error' | 'degraded'
    skipCyclesRemaining: number
}

export async function triggerReconciliation(
    accountId: string,
    primaryConnectionId?: string,
    connections?: Connection[],
    addons?: AddonDescriptor[],
    options?: { allowCollectionShrink?: boolean },
): Promise<ReconcileResult> {
    const base = getSyncApiPath(useSyncStore.getState().serverUrl)
    const sanitizedConnections = connections?.filter(isAddonConnection).map(({ credentials: _creds, ...rest }) => rest)
    const addonPrimary = connections && !sanitizedConnections?.some(c => c.id === primaryConnectionId)
        ? sanitizedConnections?.find(c => c.enabled)?.id
        : primaryConnectionId
    const res = await resilientFetch(`${base}/providers/sync/${accountId}`, {
        method: 'POST',
        headers: await getAuthHeaders(),
        body: JSON.stringify({ primaryConnectionId: addonPrimary, connections: sanitizedConnections, addons, allowCollectionShrink: options?.allowCollectionShrink === true }),
        timeout: 30000,
    })
    if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'Unknown error' }))
        throw new Error(body.error || `Sync failed (${res.status})`)
    }
    return res.json()
}

// Only a rejected token's hash ever leaves the client; the token itself never does.
export async function hashRejectedToken(token: string): Promise<string> {
    const bytes = new TextEncoder().encode(String(token))
    if (globalThis.crypto?.subtle) {
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
        return [...digest].map(b => b.toString(16).padStart(2, '0')).join('')
    }
    // Insecure context without SubtleCrypto: a deterministic stand-in the server will not match.
    let a = 0x811c9dc5
    let b = 0x9e3779b9
    for (const byte of bytes) {
        a = Math.imul(a ^ byte, 0x01000193) >>> 0
        b = Math.imul(b ^ (byte + 0x9e3779b9), 0x85ebca6b) >>> 0
    }
    return (a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')).repeat(4)
}

// A Nuvio 401 is JWT-shaped when PostgREST says so (PGRST301/PGRST302); REST reads carry no body and count too.
export function isNuvioJwtAuthError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false
    const { status, data } = error as { status?: unknown; data?: { code?: unknown } }
    if (status !== 401) return false
    if (!data || typeof data !== 'object' || typeof data.code !== 'string') return true
    return data.code === 'PGRST301' || data.code === 'PGRST302'
}

const vaultKeyEpochs = new WeakMap<object, number>()
let nextVaultKeyEpoch = 1

// Session identity the heal latch is scoped to: active workspace, sync login,
// and vault key incarnation. Every login, logout, or workspace switch changes
// it, so each session gets its own bounded heal attempt.
function credentialHealSessionScope(): string {
    const { auth } = useSyncStore.getState()
    const vaultKey = useAuthStore.getState().encryptionKey
    let epoch = 0
    if (vaultKey) {
        epoch = vaultKeyEpochs.get(vaultKey) ?? nextVaultKeyEpoch++
        vaultKeyEpochs.set(vaultKey, epoch)
    }
    return [getActiveWorkspaceId(), auth?.id || '', auth?.isAuthenticated ? 1 : 0, epoch].join('\u0000')
}

// A 404 means the server has no credential row for THIS connection id (device
// migration, a merge-dropped duplicate re-sign, a lost write). When the client
// still holds the connection's credentials, re-register them under the same id
// and generation once per session and retry the fetch once; the original error
// surfaces when either step fails or no credentials are held.
async function reRegisterCredentialAndRefetchToken(
    accountId: string,
    connectionId: string,
    baseUrl?: string | null,
    rejectedTokenHash?: string,
): Promise<{ accessToken: string; expiresAt: number; profileId: string | null } | null> {
    if (!beginCredentialHealAttempt(credentialHealSessionScope(), connectionId)) return null
    try {
        const { useAccountStore } = await import('@/store/accountStore')
        const connection = useAccountStore.getState().accounts
            .find(a => a.id === accountId)?.connections?.find(c => c.id === connectionId)
        const bundle = connection ? connectionCredentialBundle(connection) : null
        if (!connection || !bundle) return null
        const { storeConnectionCredential } = await import('@/api/hydra-providers')
        await storeConnectionCredential(accountId, connectionId, bundle, connection.platform, connection.generation)
        const base = getSyncApiPath(useSyncStore.getState().serverUrl)
        const res = await resilientFetch(`${base}/providers/connections/${connectionId}/token`, {
            method: 'POST',
            headers: await getAuthHeaders(),
            body: JSON.stringify({ accountId, platform: connection.platform, ...(baseUrl ? { baseUrl } : {}), ...(rejectedTokenHash ? { rejectedTokenHash } : {}) }),
            timeout: 10000,
        })
        if (!res.ok) return null
        return res.json()
    } catch {
        return null
    }
}

export async function fetchConnectionToken(
    accountId: string,
    connectionId: string,
    platform: string,
    baseUrl?: string | null,
    options?: { rejectedTokenHash?: string },
): Promise<{ accessToken: string; expiresAt: number; profileId: string | null }> {
    const rejectedTokenHash = typeof options?.rejectedTokenHash === 'string' && /^[0-9a-f]{64}$/.test(options.rejectedTokenHash)
        ? options.rejectedTokenHash
        : undefined
    const base = getSyncApiPath(useSyncStore.getState().serverUrl)
    const res = await resilientFetch(`${base}/providers/connections/${connectionId}/token`, {
        method: 'POST',
        headers: await getAuthHeaders(),
        body: JSON.stringify({ accountId, platform, ...(baseUrl ? { baseUrl } : {}), ...(rejectedTokenHash ? { rejectedTokenHash } : {}) }),
        timeout: 10000,
    })
    if (res.status === 404) {
        const healed = await reRegisterCredentialAndRefetchToken(accountId, connectionId, baseUrl, rejectedTokenHash)
        if (healed) return healed
    }
    if (!res.ok) {
        const err = new Error(res.status === 401 ? 'Session expired, re-authenticate this connection' : `Token fetch failed (${res.status})`)
        ;(err as { isAuthError?: boolean }).isAuthError = res.status === 401
        throw err
    }
    return res.json()
}

export async function setConnectionProfile(
    connectionId: string,
    profileId: string,
): Promise<void> {
    const base = getSyncApiPath(useSyncStore.getState().serverUrl)
    const res = await resilientFetch(`${base}/providers/connections/${connectionId}/profile`, {
        method: 'POST',
        headers: await getAuthHeaders(),
        body: JSON.stringify({ profileId }),
        timeout: 15000,
    })
    if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'Unknown error' }))
        throw new Error(body.error || `Profile switch failed (${res.status})`)
    }
}

export async function getConnectionStates(accountId: string): Promise<Record<string, ConnectionState>> {
    const base = getSyncApiPath(useSyncStore.getState().serverUrl)
    const res = await resilientFetch(`${base}/providers/status/${accountId}`, {
        headers: await getAuthHeaders(),
        timeout: 10000,
    })
    if (res.status === 401) {
        const err = new Error('Session expired')
        ;(err as { isAuthError?: boolean }).isAuthError = true
        throw err
    }
    if (!res.ok) return {}
    const body = await res.json()
    return body.connectionStates || {}
}
