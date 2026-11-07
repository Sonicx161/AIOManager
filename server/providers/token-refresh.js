import { createHash } from 'node:crypto'
import db from '../db.js'
import { decrypt, encrypt } from '../crypto.js'
import { FALLBACK_KEYS, PRIMARY_KEY } from '../keys.js'
import { trace } from '../utils/trace.js'
import { assertAccountActive, gateCode } from '../admin/account-state.js'

export const REFRESH_BUFFER_MS = 5 * 60 * 1000
export const FORCE_COOLDOWN_MS = 60 * 1000
const FORCE_COOLDOWN_MAX_ENTRIES = 5000

const refreshInFlight = new Map()
function singleFlight(key, fn) {
    const existing = refreshInFlight.get(key)
    if (existing) return existing
    const p = Promise.resolve().then(fn).finally(() => refreshInFlight.delete(key))
    refreshInFlight.set(key, p)
    return p
}

// A forced call must not join a plain in-flight call, which may return the rejected token.
async function singleFlightAfter(key, fn, forced) {
    if (!forced) return singleFlight(key, fn)
    let existing
    while ((existing = refreshInFlight.get(key))) await existing.catch(() => null)
    return singleFlight(key, fn)
}

export function hashRejectedToken(token) {
    return createHash('sha256').update(String(token)).digest('hex')
}

export function normalizeRejectedTokenHash(value) {
    return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : null
}

const forcedAt = new Map()
function claimForce(key, now = Date.now()) {
    const last = forcedAt.get(key)
    if (last !== undefined && now - last < FORCE_COOLDOWN_MS) return false
    if (forcedAt.size >= FORCE_COOLDOWN_MAX_ENTRIES) {
        for (const [k, at] of forcedAt) if (now - at >= FORCE_COOLDOWN_MS) forcedAt.delete(k)
        if (forcedAt.size >= FORCE_COOLDOWN_MAX_ENTRIES) forcedAt.delete(forcedAt.keys().next().value)
    }
    forcedAt.delete(key)
    forcedAt.set(key, now)
    return true
}

// A stored token whose forced renewal failed stays rejected until the stored token changes.
const failedRenewals = new Map()
const FAILED_RENEWALS_MAX_ENTRIES = 20000
function markRenewalFailed(key, bundle) {
    if (!bundle?.accessToken) return
    failedRenewals.delete(key)
    if (failedRenewals.size >= FAILED_RENEWALS_MAX_ENTRIES) failedRenewals.delete(failedRenewals.keys().next().value)
    failedRenewals.set(key, hashRejectedToken(bundle.accessToken))
}

// Only the stored token the caller saw rejected may be force-renewed, at most once per
// cooldown. A rejected token is never re-vended: inside the cooldown, and to plain callers
// after a failed renewal, the route answers re-authenticate instead of reading as a guest.
function forcedRefreshPlan(key, bundle, rejectedTokenHash) {
    if (!bundle?.accessToken) return 'plain'
    const tokenHash = hashRejectedToken(bundle.accessToken)
    const failed = failedRenewals.get(key)
    if (failed !== undefined && failed !== tokenHash) failedRenewals.delete(key)
    if (rejectedTokenHash === tokenHash) {
        // Inside the cooldown the caller gets re-authenticate, but the token is not marked failed.
        return claimForce(key) ? 'force' : 'reject'
    }
    return failed === tokenHash ? 'reject' : 'plain'
}

export function resetForceCooldownsForTest() {
    forcedAt.clear()
    failedRenewals.clear()
}

async function persistRotatedToken(connectionId, credentialType, newBundle, accountId, syncUser, previousBundle) {
    if (!accountId || !syncUser) {
        throw new Error(`Refusing unscoped persist of rotated ${credentialType} token for ${connectionId}: account and owner are both required`)
    }
    let lastErr = null
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const row = await db.get(
                'SELECT auth_key FROM server_credentials WHERE connection_id = $1 AND credential_type = $2 AND account_id = $3 AND sync_user = $4 ORDER BY updated_at DESC LIMIT 1',
                [connectionId, credentialType, accountId, syncUser]
            )
            const latest = row?.auth_key ? JSON.parse(decrypt(row.auth_key, FALLBACK_KEYS)) : null
            const tokenField = credentialType === 'nuvio' ? 'refreshToken' : 'accessToken'
            if (!latest || latest[tokenField] !== previousBundle[tokenField] || latest.baseUrl !== previousBundle.baseUrl) {
                const err = new Error('Connection credentials changed during token refresh')
                err._credentialSuperseded = true
                throw err
            }
            // Preserve concurrent profile edits; replace only fields this operation changed.
            const updated = { ...latest, ...Object.fromEntries(Object.entries(newBundle).filter(([key, value]) => value !== previousBundle[key])) }
            const encrypted = encrypt(JSON.stringify(updated), PRIMARY_KEY)
            const result = await db.run(
                'UPDATE server_credentials SET auth_key = $1, updated_at = $2 WHERE connection_id = $3 AND credential_type = $4 AND account_id = $5 AND sync_user = $6 AND auth_key = $7',
                [encrypted, Date.now(), connectionId, credentialType, accountId, syncUser, row.auth_key]
            )
            if (result.changes === 0) throw new Error('Connection credential changed before persistence')
            const { invalidateConnectionCache } = await import('./reconciler.js')
            invalidateConnectionCache(syncUser)
            return updated
        } catch (err) {
            if (err._credentialSuperseded) throw err
            lastErr = err
            await new Promise(r => setTimeout(r, 150 * (attempt + 1)))
        }
    }
    console.error(`[TokenRefresh] CRITICAL: rotated ${credentialType} token for ${connectionId} could not be persisted; connection will brick. ${lastErr?.message || lastErr}`)
    const e = new Error(`Failed to persist rotated ${credentialType} token for ${connectionId}: ${lastErr?.message || lastErr}`)
    e._tokenPersistFailed = true
    throw e
}

export function refreshNuvioToken(connectionId, accountId, heal, syncUser, options = {}) {
    const key = JSON.stringify(['nuvio', connectionId, accountId ?? null, syncUser ?? null])
    const rejectedTokenHash = normalizeRejectedTokenHash(options.rejectedTokenHash)
    return singleFlightAfter(key, () => refreshNuvioTokenInner(connectionId, accountId, heal, syncUser, key, rejectedTokenHash), !!rejectedTokenHash)
}

async function refreshNuvioTokenInner(connectionId, accountId, heal, syncUser, key, rejectedTokenHash) {
    const start = Date.now()
    trace('tokenRefresh', 'nuvio.start', { connectionId, accountId })
    // Connection IDs alone do not authorize credential access.
    if (!syncUser || !accountId) {
        trace('tokenRefresh', 'nuvio.skip', { connectionId, accountId, reason: syncUser ? 'no-account' : 'no-owner' })
        return null
    }
    // Account state gate beside the scope guard: a blocked owner vends nothing, is not
    // healed and is not refreshed; the one exception is persistRotatedToken, which only
    // runs after the platform already rotated a token this call completed.
    try {
        await assertAccountActive(syncUser)
    } catch (stateErr) {
        if (gateCode(stateErr)) {
            trace('tokenRefresh', 'nuvio.skip', { connectionId, accountId, reason: gateCode(stateErr) })
            return null
        }
        throw stateErr
    }
    const cred = await db.get(
        "SELECT auth_key FROM server_credentials WHERE connection_id = $1 AND credential_type = 'nuvio' AND sync_user = $2 AND account_id = $3 ORDER BY updated_at DESC LIMIT 1",
        [connectionId, syncUser, accountId]
    )
    if (!cred?.auth_key) {
        trace('tokenRefresh', 'nuvio.skip', { connectionId, accountId, reason: 'no-credential' })
        return null
    }

    let bundle
    try {
        bundle = JSON.parse(decrypt(cred.auth_key, FALLBACK_KEYS))
    } catch {
        trace('tokenRefresh', 'nuvio.skip', { connectionId, accountId, reason: 'decrypt-failed' })
        return null
    }
    if (!bundle || typeof bundle !== 'object') {
        trace('tokenRefresh', 'nuvio.skip', { connectionId, accountId, reason: 'unreadable-bundle' })
        return null
    }

    // A bundle without baseUrl pushes to the public api.nuvio.tv; persist the heal before
    // refreshing so the refresh itself targets the client's real backend. The owner is
    // re-asserted immediately before this UPDATE: a block that lands while the credential
    // is being read performs no heal write (addendum A3).
    if (heal?.baseUrl && !bundle.baseUrl) {
        try {
            await assertAccountActive(syncUser)
        } catch (stateErr) {
            if (gateCode(stateErr)) {
                trace('tokenRefresh', 'nuvio.skip', { connectionId, accountId, reason: gateCode(stateErr) })
                return null
            }
            throw stateErr
        }
        const healed = { ...bundle, baseUrl: heal.baseUrl }
        if (heal.publishableKey && !bundle.publishableKey) healed.publishableKey = heal.publishableKey
        bundle = await persistRotatedToken(connectionId, 'nuvio', healed, accountId, syncUser, bundle)
        trace('tokenRefresh', 'nuvio.baseUrlHealed', { connectionId, accountId })
    }

    if (!bundle.refreshToken) {
        trace('tokenRefresh', 'nuvio.skip', { connectionId, accountId, reason: 'no-refresh-token' })
        return null
    }

    const plan = forcedRefreshPlan(key, bundle, rejectedTokenHash)
    const expiring = !!bundle.expiresAt && bundle.expiresAt - Date.now() <= REFRESH_BUFFER_MS
    // Near or past a known expiry a rejected token still gets a normal refresh, so it can rotate.
    if (plan === 'reject' && !expiring) {
        trace('tokenRefresh', 'nuvio.reject', { connectionId, accountId, reason: 'rejected-token-cooldown' })
        return null
    }
    if (bundle.expiresAt && bundle.expiresAt - Date.now() > REFRESH_BUFFER_MS && plan !== 'force') {
        trace('tokenRefresh', 'nuvio.skip', { connectionId, accountId, reason: 'not-expiring' })
        return bundle
    }

    const { createNuvioDriver } = await import('./nuvio-driver.js')
    const driver = createNuvioDriver({
        baseUrl: bundle.baseUrl || undefined,
        publishableKey: bundle.publishableKey || undefined,
    })

    try {
        const refreshed = await driver.refreshAccessToken(bundle.refreshToken)
        const newBundle = {
            ...bundle,
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken || bundle.refreshToken,
            expiresAt: refreshed.expiresAt,
        }

        const persisted = await persistRotatedToken(connectionId, 'nuvio', newBundle, accountId, syncUser, bundle)
        trace('tokenRefresh', 'nuvio.success', { connectionId, accountId, timing: Date.now() - start })
        return persisted
    } catch (err) {
        if (plan === 'force' && err.isAuthError) markRenewalFailed(key, bundle)
        if (err.isAuthError) {
            err._authExpired = true
        }
        trace('tokenRefresh', 'nuvio.error', { connectionId, accountId, isAuthError: !!err.isAuthError, error: err.message, timing: Date.now() - start })
        throw err
    }
}

export function refreshRealStreamToken(connectionId, accountId, syncUser, options = {}) {
    const key = JSON.stringify(['realstream', connectionId, accountId ?? null, syncUser ?? null])
    const rejectedTokenHash = normalizeRejectedTokenHash(options.rejectedTokenHash)
    return singleFlightAfter(key, () => refreshRealStreamTokenInner(connectionId, accountId, syncUser, key, rejectedTokenHash), !!rejectedTokenHash)
}

async function refreshRealStreamTokenInner(connectionId, accountId, syncUser, key, rejectedTokenHash) {
    const start = Date.now()
    trace('tokenRefresh', 'realstream.start', { connectionId, accountId })
    // Fail closed exactly like the nuvio path: no owner+account scope, no credential access.
    if (!syncUser || !accountId) {
        trace('tokenRefresh', 'realstream.skip', { connectionId, accountId, reason: syncUser ? 'no-account' : 'no-owner' })
        return null
    }
    // Account state gate beside the scope guard, identical to the nuvio path.
    try {
        await assertAccountActive(syncUser)
    } catch (stateErr) {
        if (gateCode(stateErr)) {
            trace('tokenRefresh', 'realstream.skip', { connectionId, accountId, reason: gateCode(stateErr) })
            return null
        }
        throw stateErr
    }
    const cred = await db.get(
        "SELECT auth_key FROM server_credentials WHERE connection_id = $1 AND credential_type = 'realstream' AND sync_user = $2 AND account_id = $3 ORDER BY updated_at DESC LIMIT 1",
        [connectionId, syncUser, accountId]
    )
    if (!cred?.auth_key) {
        trace('tokenRefresh', 'realstream.skip', { connectionId, accountId, reason: 'no-credential' })
        return null
    }

    let bundle
    try {
        bundle = JSON.parse(decrypt(cred.auth_key, FALLBACK_KEYS))
    } catch {
        trace('tokenRefresh', 'realstream.skip', { connectionId, reason: 'decrypt-failed' })
        return null
    }
    if (!bundle || typeof bundle !== 'object') {
        trace('tokenRefresh', 'realstream.skip', { connectionId, accountId, reason: 'unreadable-bundle' })
        return null
    }

    if (!bundle.accessToken) {
        trace('tokenRefresh', 'realstream.skip', { connectionId, reason: 'no-access-token' })
        return null
    }

    // PocketBase reads a revoked token as a guest, so only a forced auth-refresh can detect it.
    const plan = forcedRefreshPlan(key, bundle, rejectedTokenHash)
    const expiring = !!bundle.expiresAt && bundle.expiresAt - Date.now() <= REFRESH_BUFFER_MS
    // Near or past a known expiry a rejected token still gets a normal refresh, so it can rotate.
    if (plan === 'reject' && !expiring) {
        trace('tokenRefresh', 'realstream.reject', { connectionId, reason: 'rejected-token-cooldown' })
        return null
    }
    if (bundle.expiresAt && bundle.expiresAt - Date.now() > REFRESH_BUFFER_MS && plan !== 'force') {
        trace('tokenRefresh', 'realstream.skip', { connectionId, reason: 'not-expiring' })
        return bundle
    }

    const { createRealStreamDriver } = await import('./realstream-driver.js')
    const driver = createRealStreamDriver(bundle.baseUrl ? { baseUrl: bundle.baseUrl } : {})

    try {
        const refreshed = await driver.refreshAccessToken(bundle.accessToken)
        const newBundle = {
            ...bundle,
            accessToken: refreshed.accessToken,
            userId: refreshed.userId || bundle.userId,
            expiresAt: refreshed.expiresAt,
        }
        const persisted = await persistRotatedToken(connectionId, 'realstream', newBundle, accountId, syncUser, bundle)
        trace('tokenRefresh', 'realstream.success', { connectionId, path: 'refresh', timing: Date.now() - start })
        return persisted
    } catch (err) {
        if (plan === 'force' && err.isAuthError && !(bundle.email && bundle.password)) markRenewalFailed(key, bundle)
        if (!err.isAuthError) {
            trace('tokenRefresh', 'realstream.error', { connectionId, isAuthError: false, error: err.message, timing: Date.now() - start })
            throw err
        }

        if (bundle.email && bundle.password) {
            try {
                const reauthed = await driver.authenticate(bundle.email, bundle.password)
                const newBundle = {
                    ...bundle,
                    accessToken: reauthed.accessToken,
                    userId: reauthed.userId || bundle.userId,
                    expiresAt: reauthed.expiresAt,
                }
                const persisted = await persistRotatedToken(connectionId, 'realstream', newBundle, accountId, syncUser, bundle)
                trace('tokenRefresh', 'realstream.success', { connectionId, path: 'reauth', timing: Date.now() - start })
                return persisted
            } catch (reauthErr) {
                if (plan === 'force' && reauthErr.isAuthError) markRenewalFailed(key, bundle)
                reauthErr._authExpired = true
                trace('tokenRefresh', 'realstream.error', { connectionId, path: 'reauth', error: reauthErr.message, timing: Date.now() - start })
                throw reauthErr
            }
        }

        err._authExpired = true
        trace('tokenRefresh', 'realstream.error', { connectionId, isAuthError: true, error: err.message, timing: Date.now() - start })
        throw err
    }
}
