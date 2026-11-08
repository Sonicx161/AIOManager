import { resilientFetch } from '@/lib/api-resilience'
import { useSyncStore, getSyncApiPath } from '@/store/syncStore'
import { getSyncPasswordHeader } from '@/lib/sync-auth'
import type { HydraStatus } from '@/types/provider'
import type { AddonDescriptor } from '@/types/addon'

export interface CanonicalEntry {
    addons: AddonDescriptor[]
    updatedAt: number
}

// jsonBody: false omits Content-Type: a bodyless request with that header makes
// Fastify parse an empty JSON body and answer 400 (FST_ERR_CTP_EMPTY_JSON_BODY).
async function getAuthHeaders(options?: { jsonBody?: boolean }): Promise<Record<string, string>> {
    const { auth } = useSyncStore.getState()
    return {
        ...(options?.jsonBody === false ? {} : { 'Content-Type': 'application/json' }),
        'x-sync-user': auth.id,
        'x-sync-password': await getSyncPasswordHeader(auth),
    }
}

export async function testHydraEndpoint(
    baseUrl: string,
    authType: string,
    authHeader: string,
    authValue: string,
): Promise<HydraStatus> {
    const base = getSyncApiPath(useSyncStore.getState().serverUrl)
    const res = await resilientFetch(`${base}/providers/hydra/test`, {
        method: 'POST',
        headers: await getAuthHeaders(),
        body: JSON.stringify({ baseUrl, authType, authHeader, authValue }),
        timeout: 15000,
    })
    if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'Unknown error' }))
        throw new Error(body.error || `Test failed (${res.status})`)
    }
    return res.json()
}

export async function storeConnectionCredential(
    accountId: string,
    connectionId: string,
    credential: string | Record<string, unknown>,
    credentialType?: string,
    generation?: string,
): Promise<void> {
    const base = getSyncApiPath(useSyncStore.getState().serverUrl)
    const res = await resilientFetch(`${base}/providers/connections/${connectionId}/credentials`, {
        method: 'POST',
        headers: await getAuthHeaders(),
        body: JSON.stringify({ accountId, credential, credentialType, ...(generation ? { connectionGeneration: generation } : {}) }),
        timeout: 10000,
    })
    if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'Unknown error' }))
        throw new Error(body.error || 'Failed to store credentials')
    }
}

export async function nuvioAuth(
    email: string,
    password: string,
    publishableKey?: string,
    baseUrl?: string,
): Promise<{ tokens: { accessToken: string; refreshToken: string; expiresAt: number }; profiles: Array<{ id: string; name: string }> }> {
    const base = getSyncApiPath(useSyncStore.getState().serverUrl)
    const res = await resilientFetch(`${base}/providers/nuvio/auth`, {
        method: 'POST',
        headers: await getAuthHeaders(),
        body: JSON.stringify({ email, password, publishableKey, baseUrl }),
        timeout: 15000,
    })
    if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'Unknown error' }))
        throw Object.assign(new Error(body.error || `Authentication failed (${res.status})`), { status: res.status })
    }
    return res.json()
}

export async function realstreamAuth(
    email: string,
    password: string,
    baseUrl?: string,
): Promise<{ tokens: { accessToken: string; userId: string | null; expiresAt: number } }> {
    const base = getSyncApiPath(useSyncStore.getState().serverUrl)
    const res = await resilientFetch(`${base}/providers/realstream/auth`, {
        method: 'POST',
        headers: await getAuthHeaders(),
        body: JSON.stringify({ email, password, baseUrl }),
        timeout: 15000,
    })
    if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'Unknown error' }))
        throw new Error(body.error || `Authentication failed (${res.status})`)
    }
    return res.json()
}

export async function nuvioSignup(
    email: string,
    password: string,
    publishableKey?: string,
    baseUrl?: string,
): Promise<{ tokens: { accessToken: string; refreshToken: string; expiresAt: number }; profiles: Array<{ id: string; name: string }> }> {
    const base = getSyncApiPath(useSyncStore.getState().serverUrl)
    const res = await resilientFetch(`${base}/providers/nuvio/signup`, {
        method: 'POST',
        headers: await getAuthHeaders(),
        body: JSON.stringify({ email, password, publishableKey, baseUrl }),
        timeout: 20000,
    })
    if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'Unknown error' }))
        throw new Error(body.error || `Sign up failed (${res.status})`)
    }
    return res.json()
}

export async function realstreamSignup(
    email: string,
    password: string,
    name?: string,
    baseUrl?: string,
): Promise<{ tokens: { accessToken: string; userId: string | null; expiresAt: number } }> {
    const base = getSyncApiPath(useSyncStore.getState().serverUrl)
    const res = await resilientFetch(`${base}/providers/realstream/signup`, {
        method: 'POST',
        headers: await getAuthHeaders(),
        body: JSON.stringify({ email, password, name, baseUrl }),
        timeout: 20000,
    })
    if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'Unknown error' }))
        throw new Error(body.error || `Sign up failed (${res.status})`)
    }
    return res.json()
}

let canonicalCache: { canonical: Record<string, CanonicalEntry>; serverStremioCredentialedAccounts: string[] | null; etag: string | null } | null = null

export function _clearCanonicalCache() {
    canonicalCache = null
}

export interface CanonicalFetchResult {
    canonical: Record<string, CanonicalEntry>
    serverStremioCredentialedAccounts: string[] | null
}

/**
 * Read the server-readable canonical addon lists this sync user owns, keyed by account,
 * plus which accounts the server can read via a stored Stremio credential. Used by the
 * inbound reconcile to detect external (e.g. AIOStreams) writes before a push.
 * Best-effort: returns empty values on any failure so it never blocks a sync.
 */
export async function fetchCanonical(): Promise<CanonicalFetchResult> {
    const base = getSyncApiPath(useSyncStore.getState().serverUrl)
    const headers = await getAuthHeaders()
    if (canonicalCache?.etag) headers['If-None-Match'] = canonicalCache.etag
    const res = await resilientFetch(`${base}/providers/canonical`, {
        headers,
        timeout: 10000,
    })
    if (res.status === 304 && canonicalCache) {
        return { canonical: canonicalCache.canonical, serverStremioCredentialedAccounts: canonicalCache.serverStremioCredentialedAccounts }
    }
    if (!res.ok) return { canonical: {}, serverStremioCredentialedAccounts: null }
    const body = await res.json().catch(() => ({}))
    const canonical = (body.canonical || {}) as Record<string, CanonicalEntry>
    const serverStremioCredentialedAccounts = Array.isArray(body.serverStremioCredentialedAccounts) ? body.serverStremioCredentialedAccounts as string[] : null
    canonicalCache = { canonical, serverStremioCredentialedAccounts, etag: res.headers.get('etag') }
    return { canonical, serverStremioCredentialedAccounts }
}

export interface HydraSubscriber {
    name: string
    logo: string | null
    created_at: number
    last_seen_at: number
}

export async function fetchSubscribers(accountId: string): Promise<HydraSubscriber[]> {
    const base = getSyncApiPath(useSyncStore.getState().serverUrl)
    const res = await resilientFetch(`${base}/providers/subscribers/${accountId}`, {
        headers: await getAuthHeaders(),
        timeout: 10000,
    })
    if (!res.ok) return []
    const body = await res.json().catch(() => ({}))
    return Array.isArray(body.subscribers) ? body.subscribers : []
}

export async function deleteSubscriber(accountId: string, name: string): Promise<void> {
    const base = getSyncApiPath(useSyncStore.getState().serverUrl)
    const res = await resilientFetch(`${base}/providers/subscribers/${accountId}`, {
        method: 'DELETE',
        headers: await getAuthHeaders(),
        body: JSON.stringify({ name }),
        timeout: 10000,
    })
    if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'Unknown error' }))
        throw new Error(body.error || `Failed to remove subscriber (${res.status})`)
    }
}

export async function deleteConnectionCredential(
    _accountId: string,
    connectionId: string,
): Promise<void> {
    const base = getSyncApiPath(useSyncStore.getState().serverUrl)
    const res = await resilientFetch(`${base}/providers/connections/${connectionId}/credentials`, {
        method: 'DELETE',
        headers: await getAuthHeaders({ jsonBody: false }),
        timeout: 10000,
    })
    if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'Unknown error' }))
        throw new Error(body.error || 'Failed to delete credentials')
    }
}

// The removal-time server cleanup for a connection: the Autopilot rules bound to it
// (stored addon_list and priority chain included), their stats and history, and its
// credential rows go in one owner-scoped operation. No in-call retries: a failure is
// queued by the caller and retried after the next certified pull. The generation is
// the removed incarnation's token; the server only claims rows of that generation.
export async function deleteConnectionServerState(accountId: string, connectionId: string, generation?: string): Promise<void> {
    if (!useSyncStore.getState().auth.isAuthenticated) return
    const base = getSyncApiPath(useSyncStore.getState().serverUrl)
    const query = generation ? `?generation=${encodeURIComponent(generation)}` : ''
    const res = await resilientFetch(`${base}/accounts/${encodeURIComponent(accountId)}/server-state/connection/${encodeURIComponent(connectionId)}${query}`, {
        method: 'DELETE',
        retries: 0,
        headers: await getAuthHeaders({ jsonBody: false }),
        timeout: 10000,
    })
    if (!res.ok) throw new Error(`Failed to delete connection server state (${res.status})`)
}

// Every Stremio credential row of the account written up to the removal, the account-level
// canonical row included. Rows registered after removedAt are kept. No in-call retries:
// a resent request would carry a stale sentAt, so the caller's queue retries instead.
export async function deleteStremioCredentials(accountId: string, removedAt: number): Promise<void> {
    if (!useSyncStore.getState().auth.isAuthenticated) return
    const base = getSyncApiPath(useSyncStore.getState().serverUrl)
    const res = await resilientFetch(`${base}/accounts/${encodeURIComponent(accountId)}/server-state/stremio-credentials?removedAt=${removedAt}&sentAt=${Date.now()}`, {
        method: 'DELETE',
        retries: 0,
        headers: await getAuthHeaders({ jsonBody: false }),
        timeout: 10000,
    })
    if (!res.ok) throw new Error(`Failed to delete Stremio credentials (${res.status})`)
}
