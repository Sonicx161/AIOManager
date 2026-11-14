/**
 * Session-scoped sync credential persistence (live bug #52).
 *
 * Since the raw password stopped being persisted, a page refresh leaves
 * `auth.password` empty, so every header builder derived
 * `x-sync-password: deriveSyncToken('')` — a constant garbage token that 401s
 * stremio-proxy, Nuvio QR, backup-export, connection refresh and re-auth
 * persistence, while the push gate silently skipped ("no in-session
 * credentials").
 *
 * At successful login we persist the DERIVED wire credential into sessionStorage:
 * the SHA-256 sync token (the exact x-sync-password value the server verifies)
 * plus the base64 raw sync-encryption key, so pushes after a refresh encrypt
 * with the correct key (same trust tier as the remembered-device blob's stored
 * syncKey — the vault AES key already lives raw in sessionStorage under
 * 'aioman:session-key'). The raw password itself is NEVER stored, in any form.
 *
 * Scope rules: sessionStorage only (survives a refresh in the same tab, dies
 * when the tab closes — a closed tab means sign in again, identical to the
 * pre-e4edd08 contract), account-id-scoped on read, cleared by logout,
 * deactivateDeviceAuth(), lock() and 401 session wipes. Read-at-use: the
 * storage IS the restore path, so there is no boot hydration race to lose.
 *
 * Alias-free (zero imports) so the resolution logic is unit-testable under
 * `node --test` (see session-sync-token.test.ts).
 */

const SESSION_SYNC_TOKEN_KEY = 'aiom-session-sync-token'

export interface SessionSyncCredential {
    /** SHA-256 wire token (deriveSyncToken output) — the x-sync-password header value. */
    token: string
    /** Base64 raw sync-encryption key (exportSyncKeyRaw output) for password-less pushes. */
    syncKey: string
}

/** A random key the server issued for this tab's password session; requests present it instead of the password token. */
export interface SessionAuthKey {
    deviceId: string
    token: string
    /** Server expiry, epoch milliseconds. */
    expiresAt: number
    /** API base the key was issued by; it is only ever sent back there. */
    base: string
}

interface StoredShape {
    id?: unknown
    token?: unknown
    syncKey?: unknown
    key?: unknown
}

// Tab memory copy, so the key also works where sessionStorage is blocked. Never written anywhere else.
let sessionGeneration = 0

export function getSessionGeneration(): number { return sessionGeneration }

let memoryKey: ({ id: string; wireToken: string } & SessionAuthKey) | null = null

function parseSessionAuthKey(value: unknown): SessionAuthKey | null {
    const key = value as Partial<SessionAuthKey> | null
    if (!key || typeof key !== 'object') return null
    if (typeof key.deviceId !== 'string' || !key.deviceId || typeof key.token !== 'string' || !key.token) return null
    if (typeof key.expiresAt !== 'number' || !Number.isFinite(key.expiresAt) || typeof key.base !== 'string' || !key.base) return null
    return { deviceId: key.deviceId, token: key.token, expiresAt: key.expiresAt, base: key.base }
}

function readStored(): ({ id: string; key: SessionAuthKey | null } & SessionSyncCredential) | null {
    try {
        const raw = sessionStorage.getItem(SESSION_SYNC_TOKEN_KEY)
        if (!raw) return null
        const parsed = JSON.parse(raw) as StoredShape
        // A token without its sync key would pass the push gate but produce
        // undecryptable payloads — shape validation is load-bearing.
        if (typeof parsed.id !== 'string' || !parsed.id) return null
        if (typeof parsed.token !== 'string' || !parsed.token) return null
        if (typeof parsed.syncKey !== 'string' || !parsed.syncKey) return null
        return { id: parsed.id, token: parsed.token, syncKey: parsed.syncKey, key: parseSessionAuthKey(parsed.key) }
    } catch {
        // Storage unavailable (SSR/node) or a corrupt payload: read as no credential.
        return null
    }
}

export function saveSessionSyncToken(id: string, token: string, syncKey: string): boolean {
    if (!id || !token || !syncKey) return false
    // The same account and wire token keep their session key; anything else starts without one.
    const previous = readStored()
    const key = previous && previous.id === id && previous.token === token ? previous.key : null
    if (memoryKey && (memoryKey.id !== id || memoryKey.wireToken !== token)) memoryKey = null
    try {
        sessionStorage.setItem(SESSION_SYNC_TOKEN_KEY, JSON.stringify(key ? { id, token, syncKey, key } : { id, token, syncKey }))
        return true
    } catch {
        // Storage blocked (private mode/quota): the session continues on the
        // in-memory password alone — same failure mode as the pre-fix world.
        return false
    }
}

/** Id-validated read: a stored credential only ever answers for its own account. */
export function getSessionSyncCredential(accountId: string): SessionSyncCredential | null {
    const stored = readStored()
    if (!stored || stored.id !== accountId) return null
    return { token: stored.token, syncKey: stored.syncKey }
}

export function hasSessionSyncCredential(accountId: string): boolean {
    return getSessionSyncCredential(accountId) !== null
}

/**
 * Single resolution rule for every x-sync-password builder: the stored session
 * token IS the valid wire credential and wins (it equals the token the current
 * password would derive); without one, derive from the in-memory password as
 * before. `deriveSyncToken` is injected so this module stays import-free.
 */
export async function resolveSessionWireToken(
    accountId: string,
    password: string,
    deriveSyncToken: (password: string) => Promise<string>
): Promise<string> {
    const credential = getSessionSyncCredential(accountId)
    if (credential) return credential.token
    return deriveSyncToken(password)
}

export function saveSessionAuthKey(accountId: string, wireToken: string, key: SessionAuthKey): boolean {
    if (!parseSessionAuthKey(key)) return false
    const stored = readStored()
    if (stored && (stored.id !== accountId || stored.token !== wireToken)) return false
    memoryKey = { id: accountId, wireToken, ...key }
    if (!stored) return true
    try {
        sessionStorage.setItem(SESSION_SYNC_TOKEN_KEY, JSON.stringify({ id: stored.id, token: stored.token, syncKey: stored.syncKey, key }))
    } catch {
        // Storage blocked: the key stays in tab memory until the next reload.
    }
    return true
}

export function getSessionAuthKey(accountId: string): SessionAuthKey | null {
    if (memoryKey && memoryKey.id === accountId) return parseSessionAuthKey(memoryKey)
    const stored = readStored()
    return stored && stored.id === accountId ? stored.key : null
}

export function dropSessionAuthKey(deviceId?: string): void {
    if (memoryKey && (!deviceId || memoryKey.deviceId === deviceId)) memoryKey = null
    const stored = readStored()
    if (!stored?.key || (deviceId && stored.key.deviceId !== deviceId)) return
    try {
        sessionStorage.setItem(SESSION_SYNC_TOKEN_KEY, JSON.stringify({ id: stored.id, token: stored.token, syncKey: stored.syncKey }))
    } catch {
        // Storage already unavailable: nothing to rewrite.
    }
}

export type SessionAuthKeyChoice = { use: SessionAuthKey & { accountId: string } } | { expired: SessionAuthKey } | null

/**
 * Decides whether one outgoing request may carry the session key: only a request that presents exactly this
 * session's own wire token, for this account, to the API that issued the key. A typed or different password is
 * never replaced, so password checks still reach the server as they were sent.
 */
export function chooseSessionAuthKey(request: { url: string; user: string | null; password: string | null }, pageUrl: string, now: number): SessionAuthKeyChoice {
    if (!request.password) return null
    const stored = readStored()
    const id = memoryKey?.id ?? stored?.id
    const wireToken = memoryKey?.wireToken ?? stored?.token
    const key = memoryKey ? parseSessionAuthKey(memoryKey) : stored?.key ?? null
    if (!id || !wireToken || !key) return null
    if (request.password !== wireToken || (request.user !== null && request.user !== id)) return null
    try {
        const target = new URL(request.url, pageUrl)
        const base = new URL(key.base.replace(/\/$/, '') + '/', pageUrl)
        if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname)) return null
        if (target.pathname === base.pathname + 'devices/session' || target.pathname === base.pathname + 'devices/enroll') return null
    } catch {
        return null
    }
    if (key.expiresAt - 30_000 <= now) return { expired: key }
    return { use: { ...key, accountId: id } }
}

/**
 * Sign-out, and the start of every explicit password sign-in: forget the key and tell the server to remove it.
 * Best effort; an unreachable server lets it expire.
 */
export function endSessionAuthKey(): void {
    sessionGeneration++
    const accountId = memoryKey?.id ?? readStored()?.id
    const key = accountId ? getSessionAuthKey(accountId) : null
    dropSessionAuthKey()
    if (!key || !accountId) return
    try {
        void fetch(`${key.base.replace(/\/$/, '')}/devices/revoke`, {
            method: 'POST',
            keepalive: true,
            headers: { 'Content-Type': 'application/json', 'x-sync-user': accountId, 'x-sync-password': key.token, 'x-sync-device': key.deviceId },
            body: JSON.stringify({ deviceId: key.deviceId }),
        }).catch(() => {})
    } catch {
        // No fetch available: the key expires on the server by itself.
    }
}

export function clearSessionSyncToken(): void {
    sessionGeneration++
    memoryKey = null
    try {
        sessionStorage.removeItem(SESSION_SYNC_TOKEN_KEY)
    } catch {
        // Storage already unavailable: nothing to clear.
    }
}
