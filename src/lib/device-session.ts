import {
    deriveDeviceToken,
    unwrapBlob,
    wrapBlob,
    bytesToBase64,
    bytesToBase64Url,
    base64ToBytes,
    base64UrlToBytes,
    type DeviceSecretBundle,
} from '@/lib/device-credential'
import {
    classifyPrfUnlockFailure,
    createDeviceSecretEnrollment,
    unlockPrfDeviceSecret,
} from '@/lib/device-prf'
import {
    deleteRecord,
    getAnyRecord,
    isRecordExpired,
    isTerminalAuthReason,
    saveRecord,
    wipeDeviceRecords,
    type DeviceRecord,
} from '@/lib/device-store'
import {
    clearSessionKey,
    clearSyncKeyCache,
    deriveSyncToken,
    exportSyncKeyRaw,
    importSyncKey,
    loadSalt,
    saveSessionKey,
    saveSalt,
} from '@/lib/crypto'
import { apiFetch } from '@/lib/http-client'
import { getSyncPasswordHeader } from '@/lib/sync-auth'
import { chooseSessionAuthKey, getSessionGeneration, dropSessionAuthKey, getSessionAuthKey, getSessionSyncCredential, hasSessionSyncCredential, saveSessionAuthKey } from '@/lib/session-sync-token'
import { trace } from '@/lib/trace'
import { resolveBootReactivation, type BootReactivationOutcome } from '@/lib/device-session-boot'
import { resolveDeviceAuthFailureOutcome } from '@/lib/device-auth-failure'
import { useAuthStore } from '@/store/authStore'
import { getSyncApiPath, readIdentityProfile, useSyncStore } from '@/store/syncStore'

export interface RememberedDeviceRow {
    deviceId: string
    tier: 'idb' | 'prf'
    label: string
    createdAt: string
    expiresAt: string
    revoked: boolean
    lastUsedAt: string | null
}

interface DeviceAuthState {
    accountUUID: string
    deviceId: string
    deviceToken: string
    syncKey: CryptoKey
}

export interface RememberedGateInfo {
    accountUUID: string
    label: string
    deviceId: string
    expiresAt: string
}

export type DeviceUnlockResult =
    | { ok: true }
    | { ok: false; reason: 'no-record' | 'expired' | 'corrupt' | 'auth-failed' | 'prf-cancelled' | 'unavailable'; message: string }

const RENEWAL_WINDOW_MS = 30 * 86_400_000

interface DeviceSessionRuntime {
    activeDeviceAuth: DeviceAuthState | null
    suppressAutoWipe: boolean
    wipeRedirectInFlight: boolean
    interceptorInstalled: boolean
    renewalAttemptedThisSession: boolean
    originalFetch?: typeof window.fetch
}

// Keep the in-memory session and the existing fetch interceptor on the same object
// across development hot updates. Nothing is persisted to disk or browser storage.
const deviceSessionRuntime: DeviceSessionRuntime = import.meta.hot?.data.deviceSessionRuntime ?? {
    activeDeviceAuth: null,
    suppressAutoWipe: false,
    wipeRedirectInFlight: false,
    interceptorInstalled: false,
    renewalAttemptedThisSession: false,
}
if (import.meta.hot) import.meta.hot.data.deviceSessionRuntime = deviceSessionRuntime

export function isDeviceAuthActive(): boolean {
    return !!deviceSessionRuntime.activeDeviceAuth
}

export function getDeviceSyncKey(): CryptoKey | null {
    return deviceSessionRuntime.activeDeviceAuth?.syncKey ?? null
}

export function getActiveDeviceId(): string | null {
    return deviceSessionRuntime.activeDeviceAuth?.deviceId ?? null
}

export function activateDeviceAuth(state: DeviceAuthState): void {
    deviceSessionRuntime.activeDeviceAuth = state
}

export function deactivateDeviceAuth(): void {
    deviceSessionRuntime.activeDeviceAuth = null
}

export function installDeviceAuthInterceptor(): void {
    if (deviceSessionRuntime.interceptorInstalled || typeof window === 'undefined' || typeof window.fetch !== 'function') return
    deviceSessionRuntime.interceptorInstalled = true
    const originalFetch = window.fetch.bind(window)
    deviceSessionRuntime.originalFetch = originalFetch
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const session = deviceSessionRuntime.activeDeviceAuth
        if (!session) return fetchWithSessionAuthKey(originalFetch, input, init)
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
        if (!headers.has('x-sync-user') && !headers.has('x-sync-password')) {
            return originalFetch(input, init)
        }
        headers.set('x-sync-user', session.accountUUID)
        headers.set('x-sync-password', session.deviceToken)
        headers.set('x-sync-device', session.deviceId)
        const [nextInput, nextInit] = input instanceof Request
            ? [new Request(new Request(input, init), { headers }), undefined]
            : [input, { ...init, headers }]
        const responsePromise = originalFetch(nextInput, nextInit)
        void responsePromise.then(
            (res) => { if (res?.status === 401) void maybeWipeOnDeviceAuthFailure(res) },
            () => {}
        )
        return responsePromise
    }) as typeof window.fetch
}

// A password session's requests carry its session key when it has one. If the server no longer accepts the key,
// the same request goes out again with the password token it was built with, so the caller never sees the difference.
async function fetchWithSessionAuthKey(originalFetch: typeof window.fetch, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const effective = input instanceof Request ? new Request(input, init) : null
    const headers = new Headers(effective?.headers ?? init?.headers)
    if (!headers.has('x-sync-password')) return effective ? originalFetch(effective) : originalFetch(input, init)
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const choice = chooseSessionAuthKey({ url, user: headers.get('x-sync-user'), password: headers.get('x-sync-password') }, window.location.href, Date.now())
    if (!choice) return effective ? originalFetch(effective) : originalFetch(input, init)
    if ('expired' in choice) {
        dropSessionAuthKey(choice.expired.deviceId)
        renewSessionAuthKey()
        return effective ? originalFetch(effective) : originalFetch(input, init)
    }
    const key = choice.use
    const generation = getSessionGeneration()
    const wireToken = headers.get('x-sync-password')
    const isCurrent = () => {
        const current = useSyncStore.getState()
        return generation === getSessionGeneration() && current.auth.isAuthenticated && current.auth.id === key.accountId && getSyncApiPath(current.serverUrl) === key.base && getSessionSyncCredential(key.accountId)?.token === wireToken
    }
    headers.set('x-sync-user', key.accountId)
    headers.set('x-sync-password', key.token)
    headers.set('x-sync-device', key.deviceId)
    const res = input instanceof Request
        ? await originalFetch(new Request(effective!.clone(), { headers }))
        : await originalFetch(input, { ...init, headers })
    if (res.status === 403) {
        try {
            const body = await res.clone().json() as { code?: unknown }
            if (body?.code === 'PASSWORD_AUTH_REQUIRED') return isCurrent() ? (effective ? originalFetch(effective) : originalFetch(input, init)) : res
        } catch {}
    }
    if (res.status !== 401) return res
    let rejected = false
    try {
        const body = await res.clone().json() as { error?: unknown }
        rejected = body?.error === 'Device credential rejected'
    } catch {}
    if (!rejected || !isCurrent()) return res
    dropSessionAuthKey(key.deviceId)
    const retried = effective ? await originalFetch(effective) : await originalFetch(input, init)
    if (retried.status !== 401) renewSessionAuthKey()
    return retried
}

let sessionAuthKeyRequest: Promise<boolean> | null = null
let sessionAuthKeyRequestGeneration = -1
let sessionAuthKeyRequestedAt = 0
const SESSION_AUTH_KEY_RETRY_MS = 60_000

// Asks the server for this tab's session key after a password sign-in. An older server answers 404 and the
// session simply stays on its password token.
export function requestSessionAuthKey(): Promise<boolean> {
    const generation = getSessionGeneration()
    if (sessionAuthKeyRequest && sessionAuthKeyRequestGeneration === generation) return sessionAuthKeyRequest
    const pending = (async () => {
        try {
            const { auth, serverUrl } = useSyncStore.getState()
            if (!auth.isAuthenticated || !auth.id || deviceSessionRuntime.activeDeviceAuth) return false
            const credential = getSessionSyncCredential(auth.id)
            if (!credential || getSessionAuthKey(auth.id)) return false
            sessionAuthKeyRequestedAt = Date.now()
            const base = getSyncApiPath(serverUrl)
            const res = await fetch(`${base}/devices/session`, {
                method: 'POST',
                headers: { 'x-sync-user': auth.id, 'x-sync-password': credential.token },
            })
            if (!res.ok) return false
            const body = await res.json() as { success?: unknown; session?: { deviceId?: unknown; token?: unknown; expiresAt?: unknown } }
            const issued = body?.session
            if (body?.success !== true || typeof issued?.deviceId !== 'string' || typeof issued.token !== 'string' || typeof issued.expiresAt !== 'number') return false
            const current = useSyncStore.getState()
            const stillCurrent = generation === getSessionGeneration() && current.auth.isAuthenticated && current.auth.id === auth.id && getSyncApiPath(current.serverUrl) === base && !deviceSessionRuntime.activeDeviceAuth && getSessionSyncCredential(auth.id)?.token === credential.token
            const saved = stillCurrent && saveSessionAuthKey(auth.id, credential.token, { deviceId: issued.deviceId, token: issued.token, expiresAt: issued.expiresAt, base })
            if (!saved) {
                void (deviceSessionRuntime.originalFetch ?? fetch)(`${base}/devices/revoke`, {
                    method: 'POST', keepalive: true,
                    headers: { 'Content-Type': 'application/json', 'x-sync-user': auth.id, 'x-sync-password': issued.token, 'x-sync-device': issued.deviceId },
                    body: JSON.stringify({ deviceId: issued.deviceId }),
                }).catch(() => {})
                return false
            }
            return true
        } catch {
            return false
        }
    })()
    sessionAuthKeyRequest = pending
    sessionAuthKeyRequestGeneration = generation
    void pending.finally(() => { if (sessionAuthKeyRequest === pending) sessionAuthKeyRequest = null })
    return pending
}

let sessionAuthKeyRetry: ReturnType<typeof setTimeout> | null = null

// At most one request a minute: a key refused right after it was issued is asked for again when the minute is up.
function renewSessionAuthKey(): void {
    const wait = SESSION_AUTH_KEY_RETRY_MS - (Date.now() - sessionAuthKeyRequestedAt)
    if (wait <= 0) {
        void requestSessionAuthKey()
        return
    }
    if (sessionAuthKeyRetry) return
    sessionAuthKeyRetry = setTimeout(() => {
        sessionAuthKeyRetry = null
        void requestSessionAuthKey()
    }, wait)
}

async function maybeWipeOnDeviceAuthFailure(res: Response): Promise<void> {
    if (!deviceSessionRuntime.activeDeviceAuth || deviceSessionRuntime.suppressAutoWipe || deviceSessionRuntime.wipeRedirectInFlight) return
    let reason = ''
    try {
        const body = await res.clone().json() as { reason?: unknown }
        reason = typeof body?.reason === 'string' ? body.reason : ''
    } catch {
        return
    }
    if (!isTerminalAuthReason(reason)) return
    const { auth } = useSyncStore.getState()
    const passwordBacked = !!auth.password || hasSessionSyncCredential(auth.id)
    const outcome = resolveDeviceAuthFailureOutcome({ hasPasswordCredential: passwordBacked, reason })
    if (outcome === 'ignore') return
    deviceSessionRuntime.wipeRedirectInFlight = true
    try {
        if (outcome === 'discard-record') {
            const deviceId = deviceSessionRuntime.activeDeviceAuth?.deviceId ?? ''
            deactivateDeviceAuth()
            await wipeDeviceRecords()
            clearSyncKeyCache()
            trace('auth', 'deviceSession.staleDiscard', { account: auth.id, deviceId })
        } else {
            await forgetRememberedDevice()
            const profile = readIdentityProfile()
            useSyncStore.setState({
                auth: { id: '', password: '', name: profile.name, avatar: profile.avatar, isAuthenticated: false },
                isInitialSyncCompleted: false,
            })
        }
    } catch {}
    if (outcome === 'wipe-session') window.location.reload()
}

export async function forgetRememberedDevice(): Promise<void> {
    deviceSessionRuntime.activeDeviceAuth = null
    await wipeDeviceRecords()
    clearSessionKey()
    clearSyncKeyCache()
}

export function guessDeviceLabel(): string {
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
    const browser = /Edg\//.test(ua) ? 'Edge'
        : /OPR\//.test(ua) ? 'Opera'
        : /Chrome\//.test(ua) ? 'Chrome'
        : /Firefox\//.test(ua) ? 'Firefox'
        : /Safari\//.test(ua) ? 'Safari'
        : 'Browser'
    const os = /Windows/.test(ua) ? 'Windows'
        : /Android/.test(ua) ? 'Android'
        : /iPhone/.test(ua) ? 'iPhone'
        : /iPad/.test(ua) ? 'iPad'
        : /Mac OS X/.test(ua) ? 'macOS'
        : /Linux/.test(ua) ? 'Linux'
        : 'this device'
    return `${browser} on ${os}`.slice(0, 100)
}

interface EnrollResponse {
    success?: unknown
    device?: { deviceId?: unknown; expiresAt?: unknown }
}

async function postEnroll(body: { deviceId: string; deviceToken: string; tier: string; label: string }): Promise<string | null> {
    const syncState = useSyncStore.getState()
    const { auth } = syncState
    let headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'x-sync-user': auth.id,
        'x-sync-password': await deriveSyncToken(auth.password),
    }
    const session = deviceSessionRuntime.activeDeviceAuth
    if (session) {
        headers = {
            'Content-Type': 'application/json',
            'x-sync-user': session.accountUUID,
            'x-sync-password': session.deviceToken,
            'x-sync-device': session.deviceId,
        }
    }
    const res = await fetch(`${getSyncApiPath(syncState.serverUrl)}/devices/enroll`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    })
    if (!res.ok) return null
    const parsed = await res.json() as EnrollResponse
    if (parsed?.success !== true) return null
    const expiresAt = parsed.device?.expiresAt
    if (typeof expiresAt === 'number' && Number.isFinite(expiresAt)) return new Date(expiresAt).toISOString()
    return typeof expiresAt === 'string' && expiresAt ? expiresAt : null
}

type DeviceNameRequest = { defaultLabel: string; resolve: (label: string | null) => void }
const nameRequestListeners = new Set<(req: DeviceNameRequest | null) => void>()
let nameRequest: DeviceNameRequest | null = null

export function subscribeDeviceNameRequest(cb: (req: DeviceNameRequest | null) => void): () => void {
    nameRequestListeners.add(cb)
    cb(nameRequest)
    return () => { nameRequestListeners.delete(cb) }
}

export function resolveDeviceName(label: string | null): void {
    const req = nameRequest
    nameRequest = null
    nameRequestListeners.forEach(cb => cb(null))
    req?.resolve(label)
}

function requestDeviceName(defaultLabel: string): Promise<string | null> {
    return new Promise(resolve => {
        nameRequest = { defaultLabel, resolve }
        nameRequestListeners.forEach(cb => cb(nameRequest))
    })
}

export async function enrollRememberedDevice(options?: { label?: string }): Promise<boolean> {
    const syncState = useSyncStore.getState()
    const { auth } = syncState
    const encryptionKey = useAuthStore.getState().encryptionKey
    if (!auth.isAuthenticated || !auth.id || !auth.password || !encryptionKey) return false
    const salt = loadSalt()
    if (!salt) return false

    const vaultKeyRaw = new Uint8Array(await crypto.subtle.exportKey('raw', encryptionKey))
    const syncSalt = syncState.syncSaltB64 ? Uint8Array.from(atob(syncState.syncSaltB64), (c) => c.charCodeAt(0)) : undefined
    const syncKeyRaw = await exportSyncKeyRaw(auth.password, syncSalt)

    const enrollment = await createDeviceSecretEnrollment(auth.id)
    const deviceToken = deriveDeviceToken()
    const chosenName = options?.label ? null : await requestDeviceName(guessDeviceLabel())
    const deviceLabel = options?.label?.trim() || chosenName?.trim() || guessDeviceLabel()
    const previous = await getAnyRecord().catch(() => null)
    const deviceId = (previous && previous.accountUUID === auth.id ? previous.deviceId : undefined) ?? crypto.randomUUID()

    const previousAuth = deviceSessionRuntime.activeDeviceAuth
    deviceSessionRuntime.activeDeviceAuth = null
    let expiresAt: string | null
    try {
        expiresAt = await postEnroll({ deviceId, deviceToken, tier: enrollment.tier, label: deviceLabel })
    } catch {
        return false
    } finally {
        deviceSessionRuntime.activeDeviceAuth = previousAuth
    }
    if (!expiresAt) return false

    const createdAt = new Date().toISOString()
    const blob = await wrapBlob(
        enrollment.deviceSecret,
        { deviceToken, vaultKey: vaultKeyRaw, userSalt: bytesToBase64(salt), syncKey: syncKeyRaw },
        { v: 1, alg: 'A256GCM', accountUUID: auth.id, deviceId, createdAt }
    )
    await saveRecord({
        accountUUID: auth.id,
        deviceId,
        deviceSecret: enrollment.tier === 'idb' ? enrollment.deviceSecret : undefined,
        credentialId: enrollment.credentialId ? bytesToBase64Url(enrollment.credentialId) : undefined,
        blob,
        createdAt,
        expiresAt,
        label: deviceLabel,
    })
    deviceSessionRuntime.renewalAttemptedThisSession = true
    try { await navigator.storage?.persist?.() } catch {}
    return true
}

function recordTier(record: DeviceRecord): 'idb' | 'prf' {
    return !record.deviceSecret && record.credentialId ? 'prf' : 'idb'
}

async function renewRememberedRecord(record: DeviceRecord, secret: Uint8Array, bundle: DeviceSecretBundle): Promise<void> {
    if (deviceSessionRuntime.renewalAttemptedThisSession) return
    deviceSessionRuntime.renewalAttemptedThisSession = true
    try {
        const expiry = Date.parse(record.expiresAt)
        if (Number.isFinite(expiry) && expiry - Date.now() > RENEWAL_WINDOW_MS) return
        const expiresAt = await postEnroll({
            deviceId: record.deviceId,
            deviceToken: bundle.deviceToken,
            tier: recordTier(record),
            label: record.label,
        })
        if (!expiresAt || expiresAt === record.expiresAt) return
        const blob = await wrapBlob(secret, bundle, {
            v: 1,
            alg: 'A256GCM',
            accountUUID: record.accountUUID,
            deviceId: record.deviceId,
            createdAt: record.createdAt,
        })
        await saveRecord({ ...record, blob, expiresAt })
    } catch {
        // Renewal is opportunistic; local expiry is UX-only and the server enforces its own.
    }
}

function normalizeDeviceTimestamp(value: unknown): string | null {
    if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString()
    if (typeof value === 'string' && value) return value
    return null
}

export async function listRememberedDevices(): Promise<RememberedDeviceRow[] | null> {
    const result = await apiFetch<{ devices?: unknown[] }>('/devices')
    if (!result.ok) return null
    const data = result.data
    const rows = Array.isArray(data) ? data : Array.isArray(data?.devices) ? data.devices : null
    if (!rows) return null
    return (rows as Record<string, unknown>[]).map((row) => ({
        deviceId: String(row.deviceId ?? ''),
        tier: row.tier === 'prf' ? 'prf' as const : 'idb' as const,
        label: typeof row.label === 'string' ? row.label : '',
        createdAt: normalizeDeviceTimestamp(row.createdAt) ?? '',
        expiresAt: normalizeDeviceTimestamp(row.expiresAt) ?? '',
        revoked: row.revoked === true,
        lastUsedAt: normalizeDeviceTimestamp(row.lastUsedAt),
    }))
}

export async function hasRememberedDeviceRecord(): Promise<boolean> {
    try {
        return !!(await getAnyRecord())
    } catch {
        return false
    }
}

export async function revokeRememberedDevice(deviceId: string): Promise<boolean> {
    const result = await apiFetch('/devices/revoke', { method: 'POST', body: { deviceId } })
    return result.ok
}

export async function renameRememberedDevice(deviceId: string, label: string): Promise<boolean> {
    const result = await apiFetch('/devices/rename', { method: 'POST', body: { deviceId, label } })
    if (!result.ok) return false
    // Mirror the new label onto this browser's local record so the sign-in strip stays in sync.
    const record = await getAnyRecord().catch(() => null)
    if (record && record.deviceId === deviceId) {
        try { await saveRecord({ ...record, label }) } catch {}
    }
    return true
}

// Auth headers for platform/API calls that work in both session kinds: the device trio when a
// remembered session is active, the password-derived token otherwise. Throws only when neither
// credential exists.
export async function getDeviceAwareAuthHeaders(): Promise<Record<string, string>> {
    const session = deviceSessionRuntime.activeDeviceAuth
    const { auth } = useSyncStore.getState()
    if (session) {
        return {
            'Content-Type': 'application/json',
            'x-sync-user': session.accountUUID,
            'x-sync-password': session.deviceToken,
            'x-sync-device': session.deviceId,
        }
    }
    if (!auth.id || (!auth.password && !hasSessionSyncCredential(auth.id))) throw new Error('Not authenticated')
    return {
        'Content-Type': 'application/json',
        'x-sync-user': auth.id,
        'x-sync-password': await getSyncPasswordHeader(auth),
    }
}

export async function revokeRememberedDevicesEverywhere(): Promise<boolean> {
    const result = await apiFetch('/devices/revoke-everywhere', { method: 'POST' })
    return result.ok
}

export async function endLocalRememberedSession(): Promise<void> {
    await forgetRememberedDevice()
    const profile = readIdentityProfile()
    useSyncStore.setState({
        auth: { id: '', password: '', name: profile.name, avatar: profile.avatar, isAuthenticated: false },
        isInitialSyncCompleted: false,
    })
    window.location.reload()
}

export async function getRememberedGateInfo(): Promise<RememberedGateInfo | null> {
    try {
        const record = await getAnyRecord()
        if (!record) return null
        if (isRecordExpired(record)) {
            await deleteRecord(record.accountUUID)
            return null
        }
        // The user's display name leads; the device label only covers users who never
        // set one (their name would otherwise be the bare UUID, duplicated on the form).
        const displayName = useSyncStore.getState().auth.name?.trim()
        return {
            accountUUID: record.accountUUID,
            label: displayName && displayName !== record.accountUUID ? displayName : record.label,
            deviceId: record.deviceId,
            expiresAt: record.expiresAt,
        }
    } catch {
        return null
    }
}

interface OpenedRecord {
    record: DeviceRecord
    secret: Uint8Array
    bundle: DeviceSecretBundle
    vaultKey: CryptoKey
    syncKey: CryptoKey
}

async function openRecord(record: DeviceRecord, secret: Uint8Array): Promise<OpenedRecord> {
    const bundle = await unwrapBlob(secret, record.blob, {
        accountUUID: record.accountUUID,
        deviceId: record.deviceId,
    })
    if (!bundle.syncKey) throw new Error('missing sync key')
    const vaultKey = await crypto.subtle.importKey('raw', bundle.vaultKey as BufferSource, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
    const syncKey = await importSyncKey(bundle.syncKey)
    return { record, secret, bundle, vaultKey, syncKey }
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

async function deriveRecordSecret(record: DeviceRecord): Promise<Uint8Array | 'prf-cancelled' | 'credential-gone' | 'corrupt'> {
    if (record.deviceSecret) return record.deviceSecret
    if (!record.credentialId) return 'corrupt'
    try {
        return await unlockPrfDeviceSecret(record.accountUUID, base64UrlToBytes(record.credentialId))
    } catch (e) {
        return classifyPrfUnlockFailure(e) === 'credential-gone' ? 'credential-gone' : 'prf-cancelled'
    }
}

export async function unlockWithDevice(): Promise<DeviceUnlockResult> {
    installDeviceAuthInterceptor()
    let record: DeviceRecord | null
    try {
        record = await loadCurrentRecord()
    } catch {
        return { ok: false, reason: 'corrupt', message: 'Your remembered sign-in could not be opened on this device. Sign in to continue.' }
    }
    if (!record) {
        return { ok: false, reason: 'no-record', message: 'Your remembered sign-in ended. Sign in to continue.' }
    }

    const secret = await deriveRecordSecret(record)
    if (secret === 'prf-cancelled') {
        return { ok: false, reason: 'prf-cancelled', message: 'Passkey unlock was cancelled. Try again, or use a different sign-in.' }
    }
    if (secret === 'credential-gone') {
        await deleteRecord(record.accountUUID)
        return { ok: false, reason: 'corrupt', message: "This device's saved sign-in is no longer available. Sign in with your UUID and password." }
    }
    if (secret === 'corrupt') {
        await deleteRecord(record.accountUUID)
        return { ok: false, reason: 'corrupt', message: 'Your remembered sign-in could not be opened on this device. Sign in to continue.' }
    }

    let opened: OpenedRecord
    try {
        opened = await openRecord(record, secret)
    } catch {
        await deleteRecord(record.accountUUID)
        return { ok: false, reason: 'corrupt', message: 'Your remembered sign-in could not be opened on this device. Sign in to continue.' }
    }
    const { bundle, vaultKey, syncKey } = opened

    if (bundle.userSalt) {
        try { saveSalt(base64ToBytes(bundle.userSalt)) } catch {}
    }
    useAuthStore.setState({ encryptionKey: vaultKey, isLocked: false })
    try { await saveSessionKey(vaultKey) } catch {}

    activateDeviceAuth({ accountUUID: record.accountUUID, deviceId: record.deviceId, deviceToken: bundle.deviceToken, syncKey })
    useSyncStore.setState((s) => ({
        auth: { ...s.auth, id: record.accountUUID, password: '', name: s.auth.name, isAuthenticated: true },
        needsReauth: false,
    }))

    deviceSessionRuntime.suppressAutoWipe = true
    try {
        await useSyncStore.getState().login(record.accountUUID, '', true, true, { syncKey })
    } catch (e) {
        deactivateDeviceAuth()
        const profile = readIdentityProfile()
        useSyncStore.setState((s) => ({
            auth: { ...s.auth, id: '', password: '', name: profile.name, avatar: profile.avatar, isAuthenticated: false },
            isInitialSyncCompleted: false,
        }))
        const reason = (e as { reason?: string })?.reason
        if (typeof reason === 'string' && isTerminalAuthReason(reason)) {
            await wipeDeviceRecords()
            return { ok: false, reason: 'auth-failed', message: (e as Error).message }
        }
        if (reason === 'unknown') {
            return { ok: false, reason: 'auth-failed', message: (e as Error).message }
        }
        return { ok: false, reason: 'unavailable', message: 'Could not reach the server. Check your connection and try again, or use a different sign-in.' }
    } finally {
        deviceSessionRuntime.suppressAutoWipe = false
    }

    renewRememberedRecord(record, secret, bundle)
    return { ok: true }
}

export async function reactivateDeviceSessionIfNeeded(): Promise<void> {
    if (deviceSessionRuntime.activeDeviceAuth) return
    // Guard + unwrap logic lives in device-session-boot.ts (alias-free, store-injected) so
    // the boot race is unit-tested; this wrapper owns module state and the follow-up pull.
    let outcome: BootReactivationOutcome
    try {
        outcome = await resolveBootReactivation(useSyncStore, useAuthStore, {
            hasSessionCredential: (accountId) => hasSessionSyncCredential(accountId),
        })
    } catch {
        return
    }
    if (!outcome.activated) {
        trace('auth', 'deviceSession.reactivate.skip', { reason: outcome.reason })
        return
    }
    const { record, secret, bundle } = outcome
    const syncKeyRaw = bundle.syncKey
    if (!syncKeyRaw) return
    trace('auth', 'deviceSession.reactivate.activated', { account: record.accountUUID, deviceId: record.deviceId })
    const syncKey = await importSyncKey(syncKeyRaw)
    activateDeviceAuth({ accountUUID: record.accountUUID, deviceId: record.deviceId, deviceToken: bundle.deviceToken, syncKey })
    useSyncStore.setState((s) => (s.needsReauth ? { needsReauth: false } : {}))
    useSyncStore.getState().refreshFromCloud().catch(() => {})
    renewRememberedRecord(record, secret, bundle)
}

installDeviceAuthInterceptor()
