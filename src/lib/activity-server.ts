import { useSyncStore, learnServerCredentialedAccounts } from '@/store/syncStore'
import { syncUploadTimeoutMs } from '@/lib/api-resilience'
import { getDeviceAwareAuthHeaders } from '@/lib/device-session'
import type { ServerActivityEvent } from '@/store/watchEventStore'
import { takePendingStremioRepoints, clearPendingStremioRepoint, convertPendingLoginsRemovedToRepoint } from '@/lib/stremio-repoint'
import { getActiveWorkspaceId } from '@/lib/workspace-persistence'
import { useAuthStore } from '@/store/authStore'
import { useAccountStore } from '@/store/accountStore'
import type { Account } from '@/types/account'

const DEFAULT_SERVER = '/api'
const STATUS_CACHE_MS = 60_000
const SERVER_EVENT_PAGE_LIMIT = 5000
const SERVER_EVENT_MAX_PAGES = 50
const SERVER_EVENT_MAX_TIME_MS = 30_000
const SERVER_REQUEST_TIMEOUT_MS = 10_000

interface ActivityServerStatus {
    engineEnabled?: boolean
    totalEvents?: number
    totalSnapshots?: number
}

let statusCache: { key: string; ts: number; value: ActivityServerStatus | null; etag: string | null } | null = null

function getApiBase(serverUrl: string | undefined): string {
    const base = (serverUrl || DEFAULT_SERVER).replace(/\/+$/, '')
    if (!base) return '/api'
    return base.startsWith('http') ? (base.endsWith('/api') ? base : `${base}/api`) : base
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = SERVER_REQUEST_TIMEOUT_MS): Promise<Response> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
        return await fetch(url, { ...init, signal: controller.signal })
    } finally {
        clearTimeout(timeout)
    }
}

async function getActivityServerStatus(apiPath: string, authHeaders: Record<string, string>): Promise<ActivityServerStatus | null> {
    const cacheKey = `${apiPath}:${authHeaders['x-sync-user']}`
    if (statusCache && statusCache.key === cacheKey && Date.now() - statusCache.ts < STATUS_CACHE_MS) {
        return statusCache.value
    }

    try {
        const headers: Record<string, string> = { ...authHeaders }
        if (statusCache && statusCache.key === cacheKey && statusCache.etag) headers['If-None-Match'] = statusCache.etag
        const status = await fetchWithTimeout(`${apiPath}/activity/status`, { headers })
        if (status.status === 304 && statusCache && statusCache.key === cacheKey && statusCache.value) {
            statusCache = { ...statusCache, ts: Date.now() }
            return statusCache.value
        }
        if (!status.ok) {
            statusCache = { key: cacheKey, ts: Date.now(), value: null, etag: null }
            return null
        }
        const value = await status.json()
        statusCache = { key: cacheKey, ts: Date.now(), value, etag: status.headers.get('etag') }
        return value
    } catch {
        statusCache = { key: cacheKey, ts: Date.now(), value: null, etag: null }
        return null
    }
}

const ACTIVITY_CURSOR_KEY = 'aio-activity-cursor-v1'
const ACTIVITY_CURSOR_MAX_AGE_MS = 24 * 60 * 60 * 1000
const MERGE_FLUSH_LIMIT = 25_000

function readActivityCursor(): number {
    try {
        const raw = localStorage.getItem(ACTIVITY_CURSOR_KEY)
        if (!raw) return 0
        const c = JSON.parse(raw) as { ts: number; at: number }
        if (!c.ts || Date.now() - c.at > ACTIVITY_CURSOR_MAX_AGE_MS) return 0
        return c.ts
    } catch { return 0 }
}

function writeActivityCursor(ts: number) {
    try { localStorage.setItem(ACTIVITY_CURSOR_KEY, JSON.stringify({ ts, at: Date.now() })) } catch {}
}

// The watch-event store is only needed once server events actually merge; load it
// lazily so it stays out of the boot chunk graph.
async function mergeServerEvents(batch: ServerActivityEvent[]): Promise<void> {
    const { useWatchEventStore } = await import('@/store/watchEventStore')
    useWatchEventStore.getState().mergeServerEvents(batch)
}

export async function fetchAndMergeServerEvents(): Promise<number> {
    const { auth, serverUrl } = useSyncStore.getState()
    if (!auth.isAuthenticated) return 0
    let authHeaders: Record<string, string>
    try {
        authHeaders = await getDeviceAwareAuthHeaders()
    } catch { return 0 }

    const apiPath = getApiBase(serverUrl)
    const status = await getActivityServerStatus(apiPath, authHeaders)
    if (!status?.engineEnabled) return 0

    const since = readActivityCursor()
    let totalMerged = 0
    let maxTs = since
    let offset = 0
    let pullComplete = false
    const startTime = Date.now()
    const batch: ServerActivityEvent[] = []

    for (let page = 0; page < SERVER_EVENT_MAX_PAGES && Date.now() - startTime < SERVER_EVENT_MAX_TIME_MS; page++) {
        try {
            const sinceParam = since > 0 ? `&since=${since}` : ''
            const res = await fetchWithTimeout(
                `${apiPath}/activity/events?limit=${SERVER_EVENT_PAGE_LIMIT}&offset=${offset}${sinceParam}`,
                { headers: authHeaders }
            )
            if (!res.ok) break

            const data = await res.json()
            const events = (data.events || []) as ServerActivityEvent[]

            if (events.length === 0) { pullComplete = true; break }

            batch.push(...events)
            totalMerged += events.length
            for (const e of events) if (e.timestamp > maxTs) maxTs = e.timestamp

            if (batch.length >= MERGE_FLUSH_LIMIT) {
                await mergeServerEvents(batch)
                batch.length = 0
            }

            if (!data.hasMore) { pullComplete = true; break }
            offset += events.length
        } catch {
            break
        }
    }

    if (batch.length > 0) await mergeServerEvents(batch)
    if (pullComplete && maxTs > 0) writeActivityCursor(maxTs)

    return totalMerged
}

// Ownership fingerprint of everything the credential upload asserts about: the vault key
// OBJECT (rotation/lock swaps the reference), and every stremio-relevant account fact
// (canonical mirror, primary pointer, each native login's id/enabled/sealed key/userId).
// A byte change means the decrypts below are reasoning about a world that no longer
// exists, and the upload must not fire.
function stremioIdentityStamp(accounts: Account[]): string {
    return JSON.stringify(accounts.map(a => [
        a.id,
        a.primaryConnectionId ?? null,
        a.authKey ?? '',
        (a.connections || [])
            .filter(c => c.platform === 'stremio' && (c.connectionType == null || c.connectionType === 'native'))
            .map(c => [c.id, c.enabled !== false, c.credentials?.authKey ?? '', c.credentials?.userId ?? '']),
    ]))
}

// Credential-upload core, deliberately NOT gated on the activity engine: server-side
// Stremio credentials are what external Hydra writes use to reach the Stremio collection
// directly, so persisting them is an identity concern, not activity telemetry. Gating
// this on the engine left engine-off defaults (the self-hosted default) with no writer.
//
// Multiplicity: the canonical login keeps the legacy account-level row (the shape every
// existing server reader pins), and every enabled SECONDARY login registers its own
// per-connection row so the server can poll its history under an isolated scope. The
// reported live connection set lets the server prune exactly the logins that were
// unlinked — never a sibling's, never the canonical row.
export async function syncCredentialsToServer(): Promise<number> {
    // ---- Synchronous ownership capture, BEFORE any await: auth headers, workspace,
    // vault key reference and the stremio identity stamp must all describe the same
    // instant, or a mid-await switch could upload one owner's data under another's
    // session (root's paused-decrypt repro). ----
    const startSyncState = useSyncStore.getState()
    const startAuth = startSyncState.auth
    const startServerUrl = startSyncState.serverUrl
    if (!startAuth.isAuthenticated) return 0
    const startEncryptionKey = useAuthStore.getState().encryptionKey
    if (!startEncryptionKey) return 0
    const startAccounts = useAccountStore.getState().accounts
    if (startAccounts.length === 0) return 0
    const startStamp = stremioIdentityStamp(startAccounts)
    const sessionStamp = () =>
        `${getActiveWorkspaceId()}|${useSyncStore.getState().auth.id}|${useSyncStore.getState().auth.isAuthenticated}|${useSyncStore.getState().serverUrl}`
    const startSession = sessionStamp()
    const ownershipValid = () =>
        sessionStamp() === startSession
        && useAuthStore.getState().encryptionKey === startEncryptionKey
        && stremioIdentityStamp(useAccountStore.getState().accounts) === startStamp

    let authHeaders: Record<string, string>
    try {
        authHeaders = await getDeviceAwareAuthHeaders()
    } catch { return 0 }
    if (!ownershipValid()) return 0

    const encryptionKey = startEncryptionKey
    const apiPath = getApiBase(startServerUrl)
    const accounts = startAccounts

    const { getCachedAuthKey, getStremioAuthKey, getStremioConnection, getStremioConnections } = await import('@/store/accountStore')

    const authKeyResults = await Promise.all(accounts.map(async (a): Promise<{ accountId: string; accountName?: string; authKey?: string; connectionId?: string; disabled?: true } | null> => {
        const nativeLogins = getStremioConnections(a)
        const canonicalConn = nativeLogins.find(c => c.id === a.primaryConnectionId) ?? nativeLogins[0]
        // A DISABLED canonical login must not keep the legacy account-level key
        // actionable server-side: report it disabled (the server drops the credential row
        // and keeps the history). A legacy authKey-only account has no enabled notion and
        // stays registered exactly as before.
        if (canonicalConn && canonicalConn.enabled === false) {
            return { accountId: a.id, disabled: true, connectionId: canonicalConn.id }
        }
        const stremioKey = getStremioAuthKey(a)
        if (!stremioKey) return null
        try {
            const plainKey = await getCachedAuthKey(stremioKey, encryptionKey)
            if (plainKey) {
                return {
                    accountId: a.id,
                    accountName: a.name,
                    authKey: plainKey,
                    // The canonical's real connection id: promoted-login scope adoption on
                    // re-points, and the account-level/secondary row handover.
                    ...(canonicalConn ? { connectionId: canonicalConn.id } : {}),
                }
            }
        } catch { return null }
        return null
    }))
    interface CanonicalAccountEntry {
        accountId: string
        accountName?: string
        authKey?: string
        connectionId?: string
        disabled?: true
        supersededConnectionId?: string
    }
    const authKeys = authKeyResults.filter((r): r is CanonicalAccountEntry => r !== null)

    // Live membership by EXISTENCE with enabled state: a paused or vault-unreadable login
    // still exists (never pruned as unlinked); a deliberately disabled login keeps its
    // history but loses its server credential row until re-enabled.
    const liveConnectionIds = accounts.flatMap(a => {
        const canonicalId = getStremioConnection(a)?.id
        return getStremioConnections(a)
            .filter(c => c.id !== canonicalId)
            .map(c => ({ accountId: a.id, connectionId: c.id, enabled: c.enabled !== false }))
    })

    const connectionResults = await Promise.all(accounts.map(async a => {
        const canonicalId = getStremioConnection(a)?.id
        const secondaries = getStremioConnections(a).filter(c => c.id !== canonicalId && c.enabled !== false && !!c.credentials?.authKey)
        return Promise.all(secondaries.map(async c => {
            try {
                const plainKey = await getCachedAuthKey(c.credentials.authKey, encryptionKey)
                if (plainKey) return { accountId: a.id, connectionId: c.id, authKey: plainKey, ...(c.generation ? { generation: c.generation } : {}) }
            } catch { /* unreadable secondary key: not registered this round, still live */ }
            return null
        }))
    }))
    const connectionKeys = connectionResults.flat().filter((r): r is { accountId: string; connectionId: string; authKey: string; generation?: string } => r !== null)

    // Deliberate canonical transitions recorded by connectionStore (re-point migration,
    // last-login removal). Attached to this one sync; a failed post leaves them armed,
    // and they are only cleared when still equal to what this post captured.
    if (!ownershipValid()) return 0
    const beforePending = takePendingStremioRepoints()
    for (const account of accounts) {
        if (beforePending[account.id]?.loginsRemoved
            && (getStremioConnections(account).length > 0 || getStremioAuthKey(account))) {
            convertPendingLoginsRemovedToRepoint(account.id)
        }
    }
    const pending = takePendingStremioRepoints()
    const removedStremioLogins = Object.entries(pending)
        .filter(([, note]) => note.loginsRemoved)
        .map(([accountId]) => accountId)
    for (const acc of authKeys) {
        const note = pending[acc.accountId]
        if (note?.supersededConnectionId) acc.supersededConnectionId = note.supersededConnectionId
    }

    try {
        // Ownership guard: abort before the upload if the workspace, sync owner, target
        // server, vault key or any stremio identity fact changed during the decrypts —
        // posting stale keys under a moved context could clobber fresher state.
        if (!ownershipValid()) return 0
        const credentialBody = JSON.stringify({
            accounts: authKeys,
            connections: connectionKeys,
            liveConnectionIds,
            removedStremioLogins,
            allAccountIds: accounts.map(a => a.id),
        })
        const res = await fetchWithTimeout(`${apiPath}/credentials/sync`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...authHeaders,
            },
            body: credentialBody,
        }, syncUploadTimeoutMs(credentialBody.length))
        if (!res.ok) return 0
        const data = await res.json()
        // Publish side effects (learned accounts, consumed transition notes) only while
        // STILL on the exact ownership that captured them.
        if (!ownershipValid()) return data.synced || 0
        learnServerCredentialedAccounts(data.serverStremioCredentialedAccounts)
        for (const [accountId, note] of Object.entries(pending)) {
            clearPendingStremioRepoint(accountId, note)
        }
        return data.synced || 0
    } catch {
        return 0
    }
}

// Kept for the login-time (pull-path) invocation sites; now engine-free like the core.
export async function pushCredentialsToServer(): Promise<number> {
    return syncCredentialsToServer()
}

const BULK_DELETE_CHUNK = 500
const MAX_RATE_LIMIT_RETRIES = 6

function retryDelayMs(res: Response, attempt: number): number {
    const header = Number(res.headers.get('retry-after'))
    const seconds = Number.isFinite(header) && header > 0 ? header : Math.min(2 ** attempt, 30)
    return Math.min(seconds, 65) * 1000
}

type DeleteOutcome = 'ok' | 'unsupported' | 'failed'

// A 429 waits out Retry-After and retries; 404/405 means the server predates the bulk route.
async function sendDelete(url: string, init: RequestInit): Promise<{ outcome: DeleteOutcome; res?: Response }> {
    for (let attempt = 0; ; attempt++) {
        let res: Response
        try {
            res = await fetchWithTimeout(url, init)
        } catch {
            return { outcome: 'failed' }
        }
        if (res.ok) return { outcome: 'ok', res }
        if (res.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
            await new Promise(resolve => setTimeout(resolve, retryDelayMs(res, attempt)))
            continue
        }
        return { outcome: res.status === 404 || res.status === 405 ? 'unsupported' : 'failed', res }
    }
}

// Server deletes for removed events, in chunks to the bulk route (per-id fallback on older
// servers), fired fire-and-forget from watchEventStore.removeEvents after the
// local drop. Each id is the server's own event id (evt_…, preserved on locally merged server
// events), so the route stays owner-scoped and idempotent — ids that never reached the server
// (locally-generated events) simply delete nothing. Not engine-gated, like the credential core:
// removing rows is data management, not telemetry.
export async function deleteServerActivityEvents(eventIds: string[]): Promise<number> {
    const { auth, serverUrl } = useSyncStore.getState()
    if (!auth.isAuthenticated || eventIds.length === 0) return 0
    let authHeaders: Record<string, string>
    try {
        authHeaders = await getDeviceAwareAuthHeaders()
    } catch { return 0 }

    const apiPath = getApiBase(serverUrl)
    const unique = [...new Set(eventIds)]
    let deleted = 0
    let failed = 0
    let bulkSupported = true
    for (let i = 0; i < unique.length; i += BULK_DELETE_CHUNK) {
        const chunk = unique.slice(i, i + BULK_DELETE_CHUNK)
        if (bulkSupported) {
            const { outcome, res } = await sendDelete(`${apiPath}/activity/events/delete`, {
                method: 'POST',
                headers: authHeaders,
                body: JSON.stringify({ ids: chunk }),
            })
            if (outcome === 'ok') {
                try { deleted += Number((await res!.json()).deleted) || 0 } catch { /* acknowledged, count unknown */ }
                continue
            }
            if (outcome === 'failed') { failed += chunk.length; continue }
            bulkSupported = false
        }
        // No body, so no JSON content type: Fastify answers 400 to an empty JSON body.
        const { 'Content-Type': _contentType, ...headers } = authHeaders
        for (const eventId of chunk) {
            const { outcome } = await sendDelete(`${apiPath}/activity/events/${encodeURIComponent(eventId)}`, { method: 'DELETE', headers })
            if (outcome === 'ok') deleted++
            else failed++
        }
    }
    // A missed row re-merges on the next pull; it stays hidden by the local tombstone until then.
    if (failed > 0) console.warn(`[ActivityServer] ${failed} of ${unique.length} event deletes were not acknowledged by the server`)
    return deleted
}
